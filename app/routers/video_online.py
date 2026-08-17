"""在线视频源路由（yt-dlp 统一引擎）：粘贴链接解析 / 防盗链流代理 / 字幕。

与本地视频 /api/videos（books 域）区分，命名空间 /api/video-online。

- ``POST /api/video-online/resolve``：body {url, source?} → {title, url, provider, duration, subtitles}
- ``GET  /api/video-online/stream``：防盗链代理（透传 Range/206/Content-Range；
  直链 403/过期自动重新 resolve 一次再试，仍失败 502）
- ``GET  /api/video-online/subtitles``：字幕内容 → {items: [{start, end, text, translation}]}

前端契约（供后续在线 UI 任务，写死）：
- resolve 响应 {title, url, provider, duration, subtitles:[{lang, name}]}
- stream 直接当 <video> src（url 参数传原始视频页链接，后端实时解析直链）
- subtitles 响应 {items: [{start, end, text, translation}]}（translation 本轮恒 None）
"""

import re
from contextlib import suppress

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
    return {
        "title": info.get("title"),
        "url": stream_url,
        "provider": provider.name,
        "duration": info.get("duration"),
        "subtitles": [{"lang": s["lang"], "name": s["name"]} for s in subs],
    }


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
def api_video_online_stream(url: str, request: Request, source: str = ""):
    """防盗链流代理：后端实时解析直链并转发，加 Referer/UA 头。

    - url 参数 = 原始视频页链接（与 resolve 同款）；source 可选，缺省按 host 推断
    - 透传 Range（206 + Content-Range，浏览器 <video> seek 依赖）
    - 直链有时效：上游 403/410 视为过期，自动重新 resolve 一次再试；仍失败 502
    """
    page_url = _require_http_url(url)
    provider = _pick_provider(page_url, str(source or "").strip() or None)
    range_h = request.headers.get("range")

    def attempt() -> tuple[object | None, object | None]:
        """解析直链并打开上游；返回 (upstream, resp) 或 (None, None)"""
        try:
            direct = provider.get_stream(page_url)
        except RuntimeError as e:
            raise HTTPException(502, f"直链获取失败: {e}") from None
        upstream, resp = _open_upstream(direct, range_h, provider.stream_headers(page_url))
        if upstream is None:
            return None, resp  # resp 此时是状态码
        return upstream, resp

    upstream, resp = attempt()
    if upstream is None and resp in _RETRYABLE_UPSTREAM_CODES:
        # 直链过期（403/410）：重新 resolve 一次再试
        upstream, resp = attempt()
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
    return StreamingResponse(
        gen(),
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
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
