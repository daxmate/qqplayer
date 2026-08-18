"""在线视频源路由（yt-dlp 统一引擎）：粘贴链接解析 / 防盗链流代理 / 字幕。

与本地视频 /api/videos（books 域）区分，命名空间 /api/video-online。

- ``POST /api/video-online/resolve``：body {url, source?} → {title, url, provider, duration, subtitles}
  （B站额外返回 audioUrl 音频轨直链，供双轨合成播放）
- ``GET  /api/video-online/stream``：防盗链代理（透传 Range/206/Content-Range；
  直链 403/过期自动重新 resolve 一次再试，仍失败 502）；B站走 ffmpeg 双轨合成流
  （DASH 分离音视频轨 -c copy 零重编码合并成 fMP4 分片，t 参数支持 seek）
- ``GET  /api/video-online/subtitles``：字幕内容 → {items: [{start, end, text, translation}]}

前端契约（供后续在线 UI 任务，写死）：
- resolve 响应 {title, url, provider, duration, subtitles:[{lang, name}], audioUrl?}
- stream 直接当 <video> src（url 参数传原始视频页链接，后端实时解析直链）
- subtitles 响应 {items: [{start, end, text, translation}]}（translation 本轮恒 None）
"""

import re
import shutil
import subprocess
import time
from contextlib import suppress
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app.services import download, video_ytdlp
from app.services import video_providers as vp

router = APIRouter()

_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)
PROXY_TIMEOUT = 60.0
_UA = download.DOWNLOAD_UA
# 上游返回这些状态码视为"直链过期/失效"，自动重新 resolve 一次再试
_RETRYABLE_UPSTREAM_CODES = (403, 410)
# ffmpeg 启动探测窗口：Popen 后窗口内非零退出视为启动失败（直链 403 等会让 ffmpeg 秒退）
FFMPEG_STARTUP_GRACE = 2.0

# 流媒体 MIME 白名单（上游 CDN 可能返回 application/octet-stream 或不带类型）
# B站 DASH 分片 .m4s 就是典型：CDN 返回 octet-stream，浏览器 <video> 不认 → 黑屏
# 按直链扩展名推断正确类型（fMP4 分片浏览器可直接播放）
_EXT_MEDIA_TYPES = {
    ".m4s": "video/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".m3u8": "application/vnd.apple.mpegurl",
    ".ts": "video/mp2t",
    ".ogg": "video/ogg",
}


def _fix_stream_media_type(direct_url: str, upstream_type: str | None) -> str | None:
    """流 MIME 修正：上游类型缺失或为 octet-stream 时，按直链扩展名推断。

    上游已给出明确视频类型（video/* 等）则原样透传；其余情况查扩展名表。
    """
    raw = (upstream_type or "").strip().lower()
    if raw and raw != "application/octet-stream":
        return upstream_type
    path = urlparse(direct_url).path.lower()
    for ext, media_type in _EXT_MEDIA_TYPES.items():
        if path.endswith(ext):
            return media_type
    return upstream_type


def _require_http_url(url: str | None) -> str:
    """url 校验：必须 http(s)，防任意文件读取/非 http 协议注入"""
    url = (url or "").strip()
    if not _HTTP_URL_RE.match(url):
        raise HTTPException(400, "url 必须为 http(s) 链接")
    return url


def _pick_provider(url: str, source: str | None) -> vp.VideoProvider:
    """按显式 source 取 provider（未知 → 400）；缺省按 url host 自动推断"""
    if source:
        provider = vp.get_provider(source)
        if provider is None:
            raise HTTPException(400, f"不支持的 source: {source}")
        return provider
    provider = vp.get_provider(vp.auto_provider_for_url(url))
    assert provider is not None  # auto_provider_for_url 只返回已注册 name
    return provider


# ============ POST /api/video-online/resolve ============


@router.post("/api/video-online/resolve")
def api_video_online_resolve(body: dict):
    """粘贴链接通用解析：{url, source?} → {title, url(直链), provider, duration, subtitles}

    B站额外返回 audioUrl（DASH 分离流音频轨直链，供双轨合成播放）；
    音频轨获取失败/无音频轨 → 省略 audioUrl（前端降级静音播放）。
    解析失败 400（带 yt-dlp stderr 摘要）。url 为原始视频页链接；
    返回的 url 是直链（有时效，播放请走 /stream 代理）。
    """
    url = _require_http_url(body.get("url"))
    source = str(body.get("source") or "").strip() or None
    provider = _pick_provider(url, source)
    try:
        info = provider.resolve(url)
        stream_url = provider.get_stream(url)
        subs = provider.get_subtitles(url) or []
    except RuntimeError as e:
        raise HTTPException(400, f"解析失败: {e}") from None
    result = {
        "title": info.get("title"),
        "url": stream_url,
        "provider": provider.name,
        "duration": info.get("duration"),
        "subtitles": [{"lang": s["lang"], "name": s["name"]} for s in subs],
    }
    if provider.name == "bilibili":
        with suppress(RuntimeError):
            # 音频轨直链获取失败/无音频轨 → 省略 audioUrl
            result["audioUrl"] = provider.get_dual_streams(url)["audio"]
    return result


# ============ B站 DASH 双轨合成（ffmpeg）============


def _spawn_ffmpeg(cmd: list[str]) -> tuple[object | None, str | None]:
    """启动 ffmpeg 并探测启动失败：Popen 后窗口内非零退出视为启动失败（如直链 403 秒退），
    读 stderr 摘要返回 (None, 摘要)；进程存活（或已零退出）返回 (proc, None)，stdout 交给生成器。
    """
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    deadline = time.monotonic() + FFMPEG_STARTUP_GRACE
    while time.monotonic() < deadline:
        code = proc.poll()
        if code is not None:
            break
        time.sleep(0.05)
    if proc.poll() is not None and proc.returncode != 0:
        stderr = ""
        if proc.stderr:
            with suppress(Exception):
                stderr = proc.stderr.read().decode("utf-8", "replace")
        return None, video_ytdlp._stderr_summary(stderr) or f"ffmpeg 退出码 {proc.returncode}"
    return proc, None


def _bili_dual_stream(
    page_url: str, provider: vp.VideoProvider, seek_t: float | None
) -> StreamingResponse:
    """B站 DASH 双轨合成流：ffmpeg 双输入 -c copy 零重编码合并 → fMP4 分片 stdout → StreamingResponse。

    - 双轨直链来自 get_dual_streams（一次 resolve，不再二次调用 yt-dlp）
    - seek：-ss <t> 放在每个 -i 之前（输入 seek，秒级响应，从目标时间重建合成流）
    - 防盗链：两个输入都带 -headers "Referer: https://www.bilibili.com\r\nUser-Agent: <UA>\r\n"
    - 直链获取失败 / ffmpeg 启动失败（403 秒退等）→ 重新 resolve 一次再试，仍失败 502
    - content-type 固定 video/mp4（fMP4 分片浏览器可直接播放，不走 _fix_stream_media_type）
    """
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise HTTPException(502, "未找到 ffmpeg，无法合成 B站音视频双轨（请先安装 ffmpeg）")

    def build_cmd(dual: dict) -> list[str]:
        headers = f"Referer: {provider._REFERER}\r\nUser-Agent: {_UA}\r\n"
        cmd = [ffmpeg_bin, "-y"]
        if seek_t:
            cmd += ["-ss", str(seek_t)]
        cmd += ["-headers", headers, "-i", dual["video"]]
        if seek_t:
            cmd += ["-ss", str(seek_t)]
        cmd += ["-headers", headers, "-i", dual["audio"]]
        cmd += [
            "-c",
            "copy",
            "-movflags",
            "frag_keyframe+empty_moov+default_base_moof",
            "-f",
            "mp4",
            "pipe:1",
        ]
        return cmd

    def attempt() -> tuple[object | None, str | None]:
        """取双轨直链并启动 ffmpeg；返回 (proc, None) 或 (None, 错误摘要)"""
        try:
            dual = provider.get_dual_streams(page_url)
        except RuntimeError as e:
            return None, str(e)
        proc, err = _spawn_ffmpeg(build_cmd(dual))
        if proc is None:
            return None, err
        return proc, None

    proc, err = attempt()
    if proc is None:
        # 直链获取失败 / 启动失败（403 过期等）：重新 resolve 一次再试
        proc, err = attempt()
    if proc is None:
        raise HTTPException(502, f"B站双轨合成失败: {err}")

    def gen():
        try:
            while True:
                chunk = proc.stdout.read1(64 * 1024)
                if not chunk:
                    break
                yield chunk
        finally:
            with suppress(Exception):
                proc.stdout.close()
            with suppress(Exception):
                proc.stderr.close()
            if proc.poll() is None:
                with suppress(Exception):
                    proc.terminate()
            with suppress(Exception):
                proc.wait()

    return StreamingResponse(gen(), media_type="video/mp4")


# ============ GET /api/video-online/stream（防盗链代理）============


def _open_upstream(direct_url: str, range_h: str | None, extra_headers: dict):
    """打开上游直连：成功返回 (upstream, resp)；失败返回 (None, 状态码|0 连接错误)"""
    upstream_headers = {"User-Agent": _UA, **extra_headers}
    if range_h:
        upstream_headers["Range"] = range_h
    upstream = None
    try:
        upstream = httpx.stream(
            "GET",
            direct_url,
            timeout=PROXY_TIMEOUT,
            follow_redirects=True,
            headers=upstream_headers,
            trust_env=False,  # 直链不被环境代理劫持（2026-08-16 教训）
        )
        resp = upstream.__enter__()
        resp.raise_for_status()
        return upstream, resp
    except httpx.HTTPStatusError as e:
        status = e.response.status_code if e.response is not None else 0
        if upstream is not None:
            with suppress(Exception):
                upstream.__exit__(None, None, None)
        return None, status
    except httpx.HTTPError:
        if upstream is not None:
            with suppress(Exception):
                upstream.__exit__(None, None, None)
        return None, 0


@router.get("/api/video-online/stream")
def api_video_online_stream(url: str, request: Request, source: str = "", t: float | None = None):
    """在线视频流：B站 → ffmpeg 双轨合成流；其余站点 → 防盗链单流代理。

    - url 参数 = 原始视频页链接（与 resolve 同款）；source 可选，缺省按 host 推断
    - t 可选（秒）：B站双轨合成的 seek 起点（缺省从头合成）；非 B站忽略
    - B站：DASH 分离音视频轨 ffmpeg -c copy 合并成 fMP4 分片（content-type 固定 video/mp4）
    - 非 B站：透传 Range（206 + Content-Range，浏览器 <video> seek 依赖）；
      直链有时效：上游 403/410 视为过期，自动重新 resolve 一次再试；仍失败 502
    """
    page_url = _require_http_url(url)
    provider = _pick_provider(page_url, str(source or "").strip() or None)
    if provider.name == "bilibili":
        return _bili_dual_stream(page_url, provider, t)
    range_h = request.headers.get("range")

    def attempt() -> tuple[object | None, object | None, str]:
        """解析直链并打开上游；返回 (upstream, resp, direct_url) 或 (None, 状态码, direct_url)"""
        try:
            direct = provider.get_stream(page_url)
        except RuntimeError as e:
            raise HTTPException(502, f"直链获取失败: {e}") from None
        upstream, resp = _open_upstream(direct, range_h, provider.stream_headers(page_url))
        if upstream is None:
            return None, resp, direct  # resp 此时是状态码
        return upstream, resp, direct

    upstream, resp, direct = attempt()
    if upstream is None and resp in _RETRYABLE_UPSTREAM_CODES:
        # 直链过期（403/410）：重新 resolve 一次再试
        upstream, resp, direct = attempt()
    if upstream is None:
        status = resp if isinstance(resp, int) and resp else "连接失败"
        raise HTTPException(502, f"直链转发失败: 上游 HTTP {status}")

    def gen():
        try:
            yield from resp.iter_bytes()  # resp 为 __enter__ 返回的 Response；upstream 是 context manager
        finally:
            upstream.__exit__(None, None, None)

    resp_headers = {}
    for h in ("content-length", "content-range", "accept-ranges"):
        if resp.headers.get(h):
            resp_headers[h] = resp.headers[h]
    media_type = _fix_stream_media_type(direct, resp.headers.get("content-type"))
    if media_type:
        resp_headers["content-type"] = media_type
    return StreamingResponse(
        gen(),
        status_code=resp.status_code,
        headers=resp_headers,
    )


# ============ GET /api/video-online/subtitles ============


@router.get("/api/video-online/subtitles")
def api_video_online_subtitles(url: str, lang: str = "", source: str = ""):
    """字幕内容：{items: [{start, end, text, translation}]}（translation 本轮恒 None）。

    url = 原始视频页链接；lang = resolve 返回的字幕 lang 值。
    yt-dlp 拿不到字幕 URL / 拉取失败 → 降级返回 {items: []}，不阻塞主链路。
    """
    page_url = _require_http_url(url)
    lang = (lang or "").strip()
    if not lang:
        raise HTTPException(400, "缺少 lang 参数")
    provider = _pick_provider(page_url, str(source or "").strip() or None)
    try:
        subs = provider.get_subtitles(page_url) or []
    except RuntimeError:
        return {"items": []}
    entry = next((s for s in subs if s.get("lang") == lang), None)
    if not entry:
        return {"items": []}
    if entry.get("url"):
        try:
            items = video_ytdlp.fetch_subtitle(entry["url"])
        except RuntimeError:
            return {"items": []}
    elif entry.get("data"):
        # 部分站点（B站 CC）字幕内容由 yt-dlp 内嵌为 data（SRT 文本），无独立 url
        items = video_ytdlp.parse_subtitle_content(entry["data"])
    else:
        return {"items": []}
    return {"items": items}
