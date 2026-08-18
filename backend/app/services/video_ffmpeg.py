"""视频 FFmpeg 服务：视频探测 + 分级转码兜底 + 音频抽取（给 ASR 转写管线用）。

纯服务模块，不挂路由（路由由其他任务接入）。基于系统 ffmpeg/ffprobe（PATH 查找，
/opt/homebrew/bin 兜底），转码/抽取产物缓存到 ~/.cache/qqplayer/video/。
测试通过 patch 本模块的 subprocess / probe / CACHE_DIR 注入，不产生真实转码。
"""

import hashlib
import json
import logging
import os
import shutil
import subprocess
from pathlib import Path
from subprocess import TimeoutExpired

logger = logging.getLogger(__name__)

# 浏览器可直接播放的容器/编解码集合（h265/hevc 浏览器支持差，判不可播）
_PLAYABLE_CONTAINERS = {"mp4", "webm"}
_PLAYABLE_VIDEO_CODECS = {"h264", "vp9", "av1"}
_PLAYABLE_AUDIO_CODECS = {"aac", "mp3", "opus", "vorbis"}

# 探测超时 30s；转码/抽音轨超时 600s
PROBE_TIMEOUT = 30
TRANSCODE_TIMEOUT = 600

# 缓存目录：~/.cache/qqplayer/video/
CACHE_DIR = Path.home() / ".cache" / "qqplayer" / "video"


class VideoFFmpegError(RuntimeError):
    """ffmpeg/ffprobe 调用失败（消息含 stderr 摘要）"""


class NoAudioTrackError(ValueError):
    """视频无音轨，无法抽取音频"""


def _find_binary(name: str) -> str:
    """PATH 查找可执行文件，找不到回退到 /opt/homebrew/bin（macOS Homebrew 默认位置）"""
    found = shutil.which(name)
    return found or f"/opt/homebrew/bin/{name}"


FFMPEG = _find_binary("ffmpeg")
FFPROBE = _find_binary("ffprobe")


def _stderr_summary(stderr: str, limit: int = 1500) -> str:
    """stderr 摘要：去空白，超长保留末尾（ffmpeg 错误信息集中在尾部）"""
    err = (stderr or "").strip()
    if not err:
        return "(无 stderr 输出)"
    if len(err) <= limit:
        return err
    return "…" + err[-limit:]


def _run_cmd(args: list[str], timeout: float, desc: str) -> subprocess.CompletedProcess:
    """执行子进程命令；超时/非零退出抛 VideoFFmpegError（消息带 stderr 摘要）"""
    try:
        proc = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except TimeoutExpired as e:
        raise VideoFFmpegError(f"{desc}超时（>{timeout:.0f}s）: {' '.join(args)}") from e
    if proc.returncode != 0:
        raise VideoFFmpegError(
            f"{desc}失败（exit {proc.returncode}）: {_stderr_summary(proc.stderr)}"
        )
    return proc


def _normalize_container(format_name: str, path: Path) -> str:
    """ffprobe format_name 归一化：webm/mp4 家族映射到标准名，其余取第一个。

    "mov,mp4,m4a,3gp,3g2,mj2" → mp4。
    ffmpeg≥7 把 mkv/webm 统一报成 "matroska,webm"，demuxer 名无法区分两者，
    用文件扩展名兜底：.webm → webm，其余（.mkv 等）→ matroska。
    """
    parts = [p.strip().lower() for p in (format_name or "").split(",") if p.strip()]
    if not parts:
        return ""
    if "mp4" in parts:
        return "mp4"
    if "webm" in parts or "matroska" in parts:
        return "webm" if path.suffix.lower() == ".webm" else "matroska"
    return parts[0]


def probe(path: str) -> dict:
    """ffprobe 探测视频并判断浏览器可直接播放性。

    返回 {playable, container, video_codec, audio_codec, duration}。
    容器 mp4/webm 且视频编码 h264/vp9/av1 且音频编码 aac/mp3/opus/vorbis（或无音轨）
    → 可播；否则不可播。
    """
    p = Path(path)
    if not p.is_file():
        raise VideoFFmpegError(f"文件不存在: {path}")
    proc = _run_cmd(
        [FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(p)],
        timeout=PROBE_TIMEOUT,
        desc="视频探测",
    )
    if not proc.stdout.strip():
        raise VideoFFmpegError(f"ffprobe 无输出: {path}")
    try:
        data = json.loads(proc.stdout)
    except json.JSONDecodeError as e:
        raise VideoFFmpegError(f"ffprobe 输出解析失败: {path}") from e

    fmt = data.get("format") or {}
    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)

    container = _normalize_container(fmt.get("format_name", ""), p)
    video_codec = (video or {}).get("codec_name")
    audio_codec = (audio or {}).get("codec_name")

    duration = 0.0
    raw_duration = fmt.get("duration") or (video or {}).get("duration")
    if raw_duration:
        try:
            duration = float(raw_duration)
        except (TypeError, ValueError):
            duration = 0.0

    container_ok = container in _PLAYABLE_CONTAINERS
    video_ok = video_codec in _PLAYABLE_VIDEO_CODECS
    # 无音轨视为音频兼容（浏览器可播无声视频）
    audio_ok = audio_codec is None or audio_codec in _PLAYABLE_AUDIO_CODECS
    playable = container_ok and video_ok and audio_ok

    return {
        "playable": playable,
        "container": container,
        "video_codec": video_codec,
        "audio_codec": audio_codec,
        "duration": duration,
    }


def _cache_key(path: Path) -> str:
    """缓存键：sha1(realpath)[:16]（realpath 归一化，同一文件不同写法命中同一缓存）"""
    return hashlib.sha1(os.path.realpath(str(path)).encode("utf-8")).hexdigest()[:16]


def _cache_path(path: Path, suffix: str) -> Path:
    return CACHE_DIR / f"{_cache_key(path)}{suffix}"


def ensure_playable(path: str) -> str:
    """保证视频浏览器可直接播放：可播直接返回原路径，否则分级转码到缓存 mp4。

    分级（输出统一 mp4 + faststart，h264/aac）：
      一级：容器不支持但编码 OK → -c:v copy -c:a aac 换容器
      二级：音轨不兼容 → -c:v copy -c:a aac
      三级：视频编码也不支持（h265 等）→ 全重编码 -c:v libx264 -preset veryfast -c:a aac
    缓存命中（~/.cache/qqplayer/video/<sha1[:16]>.mp4）直接返回；转码失败抛异常。
    """
    p = Path(path)
    info = probe(str(p))
    if info["playable"]:
        return str(p)

    out = _cache_path(p, ".mp4")
    if out.exists():
        logger.info("命中转码缓存: %s", out)
        return str(out)

    video_ok = info["video_codec"] in _PLAYABLE_VIDEO_CODECS
    audio_ok = info["audio_codec"] is None or info["audio_codec"] in _PLAYABLE_AUDIO_CODECS

    if not video_ok:
        level = "三"
        codec_args = ["-c:v", "libx264", "-preset", "veryfast", "-c:a", "aac"]
    elif not audio_ok:
        level = "二"
        codec_args = ["-c:v", "copy", "-c:a", "aac"]
    else:
        level = "一"
        codec_args = ["-c:v", "copy", "-c:a", "aac"]

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    try:
        _run_cmd(
            [
                FFMPEG,
                "-y",
                "-i",
                str(p),
                *codec_args,
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
                str(tmp),
            ],
            timeout=TRANSCODE_TIMEOUT,
            desc=f"视频转码（{level}级）",
        )
        os.replace(tmp, out)
    finally:
        if tmp.exists():
            tmp.unlink()
    logger.info("转码完成（%s级）: %s → %s", level, path, out)
    return str(out)


def extract_audio(path: str) -> str:
    """抽取音轨为 16k 单声道 wav（给 ASR 转写用），输出 ~/.cache/qqplayer/video/<sha1[:16]>.wav。

    无音轨抛 NoAudioTrackError；缓存命中直接返回；失败抛异常（带 stderr 摘要）。
    注：-f wav 显式指定输出格式（临时文件带 .tmp 后缀，ffmpeg 无法从扩展名推断）。
    """
    p = Path(path)
    if not p.is_file():
        raise VideoFFmpegError(f"文件不存在: {path}")

    out = _cache_path(p, ".wav")
    if out.exists():
        logger.info("命中音频缓存: %s", out)
        return str(out)

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    try:
        _run_cmd(
            [
                FFMPEG,
                "-y",
                "-i",
                str(p),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-ar",
                "16000",
                "-ac",
                "1",
                "-f",
                "wav",
                str(tmp),
            ],
            timeout=TRANSCODE_TIMEOUT,
            desc="音频抽取",
        )
        os.replace(tmp, out)
    except VideoFFmpegError as e:
        if "does not contain any stream" in str(e):
            raise NoAudioTrackError(f"视频无音轨，无法抽取音频: {path}") from e
        raise
    finally:
        if tmp.exists():
            tmp.unlink()
    logger.info("音频抽取完成: %s → %s", path, out)
    return str(out)
