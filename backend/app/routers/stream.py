"""在线流媒体路由：搜索/下载/直链/同源代理/歌曲海下载 + 网络曲库条目 CRUD。

- /api/online/search、/api/online/download、/api/stream/url、/api/stream/proxy
- /api/gequhai/download
- /api/network-songs(GET/POST/DELETE)
"""

import re
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse

import gequhai_provider
import netease_provider
import quark_provider
from app import state
from app.services import download
from app.services import settings as settings_service

router = APIRouter()


# ============ 在线搜索/下载（网易云 eapi，netease_provider）============
@router.get("/api/online/search")
def api_online_search(q: str = "", limit: int = 20, source: str = "netease"):
    """在线搜索歌曲；q 必填，limit 1-50 默认 20；source=netease（默认）/gequhai

    gequhai 源 items 结构与 netease 一致：{id, title, artist, album, cover, duration, level}
    （歌曲海无专辑/封面/时长字段，置 None；level 固定 "320"）
    """
    q = (q or "").strip()
    if not q:
        raise HTTPException(400, "缺少搜索关键词")
    limit = max(1, min(50, limit))
    if source == "gequhai":
        items = []
        for it in gequhai_provider.search(q, limit=limit):
            items.append(
                {
                    "id": it["id"],
                    "title": it["title"],
                    "artist": it["artist"],
                    "album": None,
                    "cover": None,
                    "duration": None,
                    "level": "320",
                }
            )
        return {"items": items}
    return {"items": netease_provider.search(q, limit=limit)}


@router.post("/api/online/download")
def api_online_download(body: dict):
    """在线下载歌曲到下载目录（后端落盘）；body {id, level?, title?, artist?}

    下载目录 = 设置 download.downloadDir（非空用该路径，空 = 当前歌曲库）。
    成功返回 {"ok": true, "path": ...}；无直链/下载失败返回 404 {"error": ...}。
    """
    song_id = str(body.get("id") or "").strip()
    if not song_id:
        raise HTTPException(400, "缺少 id")
    level = str(body.get("level") or "").strip() or "exhigh"
    try:
        info = netease_provider.get_play_info(song_id, level)
    except Exception:
        info = None
    if not info or not info.get("url"):
        return JSONResponse(status_code=404, content={"error": "无法获取下载链接"})
    url = info["url"]
    ext = str(info.get("ext") or "mp3").lstrip(".")
    # 文件名：{title}-{artist}.{ext}；title/artist 为空（或清洗后为空）用 id 兜底
    title = download._sanitize_filename(body.get("title")) or song_id
    artist = download._sanitize_filename(body.get("artist"))
    filename = f"{title}-{artist}.{ext}" if artist else f"{title}.{ext}"
    download_dir = Path(
        settings_service.load_all_settings()["download"]["downloadDir"] or state.LIBRARY
    )
    try:
        download_dir.mkdir(parents=True, exist_ok=True)
        dest = download_dir / filename
        # 按设置下载引擎下载（engine=aria2 时走本机 aria2 daemon，不可用自动降级 httpx）
        download._download_with_engine(url, dest, settings_service.load_all_settings())
    except Exception as e:
        return JSONResponse(status_code=404, content={"error": f"下载失败: {e}"})
    return {"ok": True, "path": str(dest)}


@router.get("/api/stream/url")
def api_stream_url(id: str, provider: str = "netease", level: str = "exhigh"):
    """获取流媒体播放直链（当前仅 netease 源）

    直链有时效（几十分钟），调用方每次播放前实时请求，后端不缓存。
    成功 200 {url, level, ext}；直链获取失败/id 无效 502；缺 id 参数 422。
    """
    if provider != "netease":
        raise HTTPException(400, f"不支持的 provider: {provider}")
    sid = str(id or "").strip()
    if not sid:
        raise HTTPException(422, "缺少 id 参数")
    level = str(level or "").strip().lower()
    if level not in netease_provider.VALID_LEVELS:
        level = netease_provider.DEFAULT_LEVEL  # 非法 level 回落默认 exhigh
    try:
        info = netease_provider.get_play_info(sid, level)
    except Exception as e:
        raise HTTPException(502, f"直链获取失败: {e}") from None
    if not isinstance(info, dict) or not info.get("url"):
        raise HTTPException(502, "直链获取失败")
    return {
        "url": info["url"],
        "level": level,
        "ext": str(info.get("ext") or "mp3").lstrip(".") or "mp3",
    }


@router.get("/api/stream/proxy")
def api_stream_proxy(url: str, request: Request):
    """同源流媒体代理：转发上游直链，绕开 Web Audio 播放跨域媒体的 CORS 限制

    背景：前端 EQ/频谱音频图用 createMediaElementSource(audio) 常驻接管 audio 元素，
    Web Audio 模式播放跨域媒体时服务器必须返回 CORS 头，否则浏览器静音输出
    （进度走但无声）。网易云直链 m701.music.126.net 实测不带 CORS 头 → 无声。
    本端点做同源代理：audio.src 指向 /api/stream/proxy?url=...，浏览器请求同源，
    不再受上游 CORS 限制。支持 Range（拖动进度条 206）。

    url 必填且必须 http(s)；透传 Range 头；上游超时/请求失败 → 502。
    """
    url = (url or "").strip()
    if not re.match(r"^https?://", url, re.IGNORECASE):
        raise HTTPException(400, "url 必须为 http(s) 链接")
    upstream_headers = {"User-Agent": download.DOWNLOAD_UA}
    range_h = request.headers.get("range")
    if range_h:
        upstream_headers["Range"] = range_h
    # trust_env=False：直链/本机回环都不应被环境代理（HTTP(S)_PROXY）劫持（2026-08-16 教训）
    try:
        upstream = httpx.stream(
            "GET",
            url,
            timeout=30.0,
            follow_redirects=True,
            headers=upstream_headers,
            trust_env=False,
        )
        resp = upstream.__enter__()
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(502, f"上游请求失败: {e}") from None

    def gen():
        try:
            yield from resp.iter_bytes()
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


# ============ 歌曲海下载（gequhai_provider + quark_provider + 下载引擎）============
@router.post("/api/gequhai/download")
def api_gequhai_download(body: dict):
    """歌曲海下载：夸克分享解析 → 按音质偏好选文件 → 登录换直链 → 下载引擎落盘

    body {id, title, artist}；成功 200 {"ok": true, "path"}；
    未登录 401 {"error": "quark_login_required", "message"}；无直链/下载失败 404。
    """
    song_id = str(body.get("id") or "").strip()
    if not song_id:
        raise HTTPException(400, "缺少 id")
    share = gequhai_provider.get_share_url(song_id)
    share_url = (share or {}).get("share_url")
    if not share_url:
        return JSONResponse(status_code=404, content={"error": "该歌曲没有夸克网盘分享链接"})
    files, stoken = quark_provider.resolve_share_verbose(share_url)
    if not files:
        return JSONResponse(status_code=404, content={"error": "夸克分享链接为空或已失效"})
    settings = settings_service.load_all_settings()
    quality = settings["download"].get("quarkQuality") or "mp3"
    chosen = quark_provider.pick_file(files, quality)
    if not chosen:
        return JSONResponse(status_code=404, content={"error": "分享中没有可下载的音频文件"})
    try:
        url, dl_headers = quark_provider.get_download_url(
            share_url, chosen["fid"], chosen["share_fid_token"], stoken
        )
    except RuntimeError:
        return JSONResponse(
            status_code=401,
            content={"error": "quark_login_required", "message": "需要登录夸克网盘"},
        )
    download_dir = Path(settings["download"]["downloadDir"] or state.LIBRARY)
    try:
        download_dir.mkdir(parents=True, exist_ok=True)
        dest = download_dir / download._unique_path(
            download_dir / download._sanitize_filename(chosen["file_name"])
        )
        download._download_with_engine(url, dest, settings, headers=dl_headers)
    except Exception as e:
        return JSONResponse(status_code=404, content={"error": f"下载失败: {e}"})
    return {"ok": True, "path": str(dest)}


# ============ 网络曲库条目（持久化 network_songs.json，播放时实时取直链）============
def _norm_network_duration(v):
    """duration 归一化：数字（秒）保留，非法/缺失置 None"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return round(float(v), 1)


def _find_network_song(entries: list[dict], provider: str, sid: str) -> bool:
    return any(e.get("provider") == provider and str(e.get("id")) == sid for e in entries)


@router.get("/api/network-songs")
def api_network_songs_list():
    """全部网络曲库条目（按添加顺序）"""
    return state.network_songs_store.load()


@router.post("/api/network-songs")
def api_network_songs_add(body: dict):
    """添加网络歌曲条目：按 provider+id 去重（已存在幂等返回现有列表）；成功 library version +1"""
    sid = str(body.get("id") or "").strip()
    title = str(body.get("title") or "").strip()
    artist = str(body.get("artist") or "").strip()
    if not sid or not title or not artist:
        raise HTTPException(400, "id/title/artist 必填")
    provider = str(body.get("provider") or "netease").strip() or "netease"
    entries = state.network_songs_store.load()
    if not _find_network_song(entries, provider, sid):
        entries.append(
            {
                "id": sid,
                "provider": provider,
                "title": title,
                "artist": artist,
                "album": body.get("album") or None,
                "coverUrl": body.get("coverUrl") or None,
                "duration": _norm_network_duration(body.get("duration")),
                "addedAt": datetime.now(timezone.utc).isoformat(),
            }
        )
        state.network_songs_store.save(entries)
        with state._scan_lock:
            state._scan_version += 1  # 前端 3s 轮询 /api/library/version 自动刷新曲库
    return entries


@router.delete("/api/network-songs")
def api_network_songs_delete(provider: str = "netease", id: str = ""):
    """删除网络歌曲条目（provider+id 定位）；返回新列表"""
    sid = str(id or "").strip()
    if not sid:
        raise HTTPException(400, "缺少 id")
    provider = str(provider or "netease").strip() or "netease"
    entries = state.network_songs_store.load()
    before = len(entries)
    entries = [
        e for e in entries if not (e.get("provider") == provider and str(e.get("id")) == sid)
    ]
    if len(entries) != before:
        state.network_songs_store.save(entries)
    return entries
