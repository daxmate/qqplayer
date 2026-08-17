"""视频 FFmpeg 服务测试：probe 结构/可播判断、ensure_playable 分级转码、extract_audio。

mock 策略：替换 vf.subprocess 为只含 run 的桩（记录调用参数、模拟 ffmpeg 产出输出文件），
不产生真实转码；ensure_playable 的探测结果用 monkeypatch 替换 vf.probe 注入。
运行：cd ~/codes/qqplayerC && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_video_ffmpeg.py -q
"""

import json
import subprocess
import sys
import types
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.services.video_ffmpeg as vf  # noqa: E402


def _fake_subprocess(monkeypatch, *, returncode=0, stdout="", stderr="", raise_timeout=False):
    """替换 vf.subprocess 为只含 run 的桩；ffmpeg 成功时模拟写出输出文件（最后一个参数）"""
    calls = []

    def fake_run(args, **kwargs):
        calls.append(args)
        if raise_timeout:
            raise subprocess.TimeoutExpired(cmd=args, timeout=kwargs.get("timeout"))
        if returncode == 0 and Path(args[0]).name == "ffmpeg":
            Path(args[-1]).write_bytes(b"fake-output")
        return subprocess.CompletedProcess(args, returncode, stdout, stderr)

    monkeypatch.setattr(vf, "subprocess", types.SimpleNamespace(run=fake_run))
    return calls


def _probe_json(format_name="mov,mp4,m4a,3gp,3g2,mj2", duration="12.5", streams=()):
    data = {
        "format": {"format_name": format_name, "duration": duration},
        "streams": list(streams),
    }
    return json.dumps(data)


def _video(codec="h264"):
    return {"codec_type": "video", "codec_name": codec}


def _audio(codec="aac"):
    return {"codec_type": "audio", "codec_name": codec}


@pytest.fixture
def src_file(tmp_path):
    f = tmp_path / "src.mkv"
    f.write_bytes(b"fake-video-bytes")
    return f


def _fake_probe(monkeypatch, **fields):
    """替换 vf.probe 返回固定探测结果（ensure_playable 分级测试用）"""
    defaults = {
        "playable": False,
        "container": "matroska",
        "video_codec": "h264",
        "audio_codec": "aac",
        "duration": 1.0,
    }
    defaults.update(fields)
    monkeypatch.setattr(vf, "probe", lambda path: dict(defaults))


# ---------- probe ----------


def test_probe_structure_and_playable(monkeypatch, src_file):
    calls = _fake_subprocess(
        monkeypatch, stdout=_probe_json(streams=[_video("h264"), _audio("aac")])
    )
    info = vf.probe(str(src_file))
    assert set(info) == {"playable", "container", "video_codec", "audio_codec", "duration"}
    assert info == {
        "playable": True,
        "container": "mp4",
        "video_codec": "h264",
        "audio_codec": "aac",
        "duration": 12.5,
    }
    args = calls[0]
    assert args[0] == vf.FFPROBE
    assert "-v" in args and "quiet" in args
    assert "-print_format" in args and "json" in args
    assert "-show_format" in args and "-show_streams" in args
    assert args[-1] == str(src_file)


@pytest.mark.parametrize(
    ("format_name", "src_ext", "vcodec", "acodec", "expected"),
    [
        ("mov,mp4,m4a,3gp,3g2,mj2", ".mp4", "h264", "aac", True),  # mp4+h264+aac 可播
        ("matroska,webm", ".webm", "vp9", "opus", True),  # webm+vp9+opus 可播
        ("mov,mp4,m4a,3gp,3g2,mj2", ".mp4", "av1", "aac", True),  # mp4+av1+aac 可播
        ("mov,mp4,m4a,3gp,3g2,mj2", ".mp4", "h264", None, True),  # 无音轨可播
        ("mov,mp4,m4a,3gp,3g2,mj2", ".mp4", "hevc", "aac", False),  # h265 不可播
        (
            "matroska,webm",
            ".mkv",
            "h264",
            "aac",
            False,
        ),  # mkv 容器不可播（ffmpeg≥7 报 matroska,webm）
        ("matroska,webm", ".mkv", "vp9", "opus", False),  # 扩展名 .mkv 即使编码可播也判不可播
        ("mov,mp4,m4a,3gp,3g2,mj2", ".mp4", "h264", "ac3", False),  # ac3 音轨不可播
        ("avi", ".avi", "mpeg4", "mp3", False),  # 全不兼容
    ],
)
def test_probe_playable_matrix(
    monkeypatch, tmp_path, format_name, src_ext, vcodec, acodec, expected
):
    src = tmp_path / f"src{src_ext}"
    src.write_bytes(b"fake-video-bytes")
    streams = []
    if vcodec:
        streams.append(_video(vcodec))
    if acodec:
        streams.append(_audio(acodec))
    _fake_subprocess(monkeypatch, stdout=_probe_json(format_name=format_name, streams=streams))
    info = vf.probe(str(src))
    assert info["playable"] is expected, f"{format_name}/{src_ext}/{vcodec}/{acodec} 判断错误"


def test_probe_container_normalization(monkeypatch, tmp_path):
    cases = [
        ("mov,mp4,m4a,3gp,3g2,mj2", "a.mp4", "mp4"),
        ("matroska,webm", "a.webm", "webm"),
        ("matroska,webm", "a.mkv", "matroska"),  # ffmpeg≥7 统一报 matroska,webm，靠扩展名区分
        ("matroska", "a.mkv", "matroska"),
        ("avi", "a.avi", "avi"),
        ("flv", "a.flv", "flv"),
    ]
    for fmt_name, fname, expected in cases:
        src = tmp_path / fname
        src.write_bytes(b"fake-video-bytes")
        _fake_subprocess(
            monkeypatch, stdout=_probe_json(format_name=fmt_name, streams=[_video(), _audio()])
        )
        assert vf.probe(str(src))["container"] == expected


def test_probe_missing_file(monkeypatch, tmp_path):
    calls = _fake_subprocess(monkeypatch, stdout=_probe_json())
    with pytest.raises(vf.VideoFFmpegError, match="文件不存在"):
        vf.probe(str(tmp_path / "nope.mp4"))
    assert calls == []  # 文件不存在不调 ffprobe


def test_probe_ffprobe_failure(monkeypatch, src_file):
    _fake_subprocess(monkeypatch, returncode=1, stderr="Invalid data found when processing")
    with pytest.raises(vf.VideoFFmpegError, match="Invalid data found"):
        vf.probe(str(src_file))


def test_probe_bad_json(monkeypatch, src_file):
    _fake_subprocess(monkeypatch, stdout="not json at all")
    with pytest.raises(vf.VideoFFmpegError, match="解析失败"):
        vf.probe(str(src_file))


def test_probe_timeout(monkeypatch, src_file):
    _fake_subprocess(monkeypatch, raise_timeout=True)
    with pytest.raises(vf.VideoFFmpegError, match="超时"):
        vf.probe(str(src_file))


# ---------- ensure_playable ----------


def test_ensure_playable_returns_original_when_playable(monkeypatch, src_file):
    calls = _fake_subprocess(monkeypatch)
    _fake_probe(monkeypatch, playable=True)
    assert vf.ensure_playable(str(src_file)) == str(src_file)
    assert calls == []


def test_ensure_playable_level1_remux(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    calls = _fake_subprocess(monkeypatch)
    _fake_probe(monkeypatch, container="matroska", video_codec="h264", audio_codec="aac")
    out = vf.ensure_playable(str(src_file))
    assert len(calls) == 1
    args = calls[0]
    assert args[args.index("-c:v") + 1] == "copy"
    assert args[args.index("-c:a") + 1] == "aac"
    assert "-preset" not in args  # 一级不做全重编码
    assert args[args.index("-movflags") + 1] == "+faststart"
    assert args[0] == vf.FFMPEG and "-i" in args
    assert out == str(tmp_path / f"{vf._cache_key(src_file)}.mp4")
    assert Path(out).is_file()  # tmp 已原子改名落位


def test_ensure_playable_level2_audio(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    calls = _fake_subprocess(monkeypatch)
    _fake_probe(monkeypatch, container="mp4", video_codec="h264", audio_codec="ac3")
    vf.ensure_playable(str(src_file))
    args = calls[0]
    assert args[args.index("-c:v") + 1] == "copy"
    assert args[args.index("-c:a") + 1] == "aac"
    assert "-preset" not in args


def test_ensure_playable_level3_reencode(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    calls = _fake_subprocess(monkeypatch)
    _fake_probe(monkeypatch, container="mp4", video_codec="hevc", audio_codec="aac")
    vf.ensure_playable(str(src_file))
    args = calls[0]
    assert args[args.index("-c:v") + 1] == "libx264"
    assert args[args.index("-preset") + 1] == "veryfast"
    assert args[args.index("-c:a") + 1] == "aac"
    assert "copy" not in args  # 三级全重编码，无流拷贝


def test_ensure_playable_cache_hit(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    calls = _fake_subprocess(monkeypatch)
    _fake_probe(monkeypatch, container="matroska", video_codec="h264", audio_codec="aac")
    cached = tmp_path / f"{vf._cache_key(src_file)}.mp4"
    cached.write_bytes(b"cached")
    assert vf.ensure_playable(str(src_file)) == str(cached)
    assert calls == []  # 缓存命中不调 ffmpeg


def test_ensure_playable_transcode_failure(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    _fake_subprocess(monkeypatch, returncode=1, stderr="Unknown encoder 'libx264'")
    _fake_probe(monkeypatch, container="mp4", video_codec="hevc", audio_codec="aac")
    with pytest.raises(vf.VideoFFmpegError, match="Unknown encoder"):
        vf.ensure_playable(str(src_file))
    # 失败不留 tmp 残渣、不留产物
    key = vf._cache_key(src_file)
    assert not (tmp_path / f"{key}.mp4.tmp").exists()
    assert not (tmp_path / f"{key}.mp4").exists()


# ---------- extract_audio ----------


def test_extract_audio_args_and_output(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    calls = _fake_subprocess(monkeypatch)
    out = vf.extract_audio(str(src_file))
    args = calls[0]
    assert args[0] == vf.FFMPEG
    assert args[args.index("-vn")] == "-vn"
    assert args[args.index("-acodec") + 1] == "pcm_s16le"
    assert args[args.index("-ar") + 1] == "16000"
    assert args[args.index("-ac") + 1] == "1"
    assert out == str(tmp_path / f"{vf._cache_key(src_file)}.wav")
    assert Path(out).is_file()


def test_extract_audio_cache_hit(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    calls = _fake_subprocess(monkeypatch)
    cached = tmp_path / f"{vf._cache_key(src_file)}.wav"
    cached.write_bytes(b"wav")
    assert vf.extract_audio(str(src_file)) == str(cached)
    assert calls == []


def test_extract_audio_no_audio_track(monkeypatch, src_file, tmp_path):
    monkeypatch.setattr(vf, "CACHE_DIR", tmp_path)
    _fake_subprocess(monkeypatch, returncode=1, stderr="Output file #0 does not contain any stream")
    with pytest.raises(vf.NoAudioTrackError, match="无音轨"):
        vf.extract_audio(str(src_file))


def test_extract_audio_missing_file(monkeypatch, tmp_path):
    calls = _fake_subprocess(monkeypatch)
    with pytest.raises(vf.VideoFFmpegError, match="文件不存在"):
        vf.extract_audio(str(tmp_path / "nope.mp4"))
    assert calls == []
