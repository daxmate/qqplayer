"""本地视频路由：列表 / Range 流 / 同名字幕（视频模块 · 本地部分）。

- GET /api/videos：扫描 videoDirs 下视频文件（扩展名白名单，不刮削不读元数据）
- GET /api/videos/stream?path=...：视频流，支持 HTTP Range（206 + Content-Range，<video> seek 依赖）
- GET /api/videos/subtitle?path=...：同名字幕（<视频名>.srt / .vtt → 时间戳 JSON）

path 参数一律经 _resolve_in_dirs 校验：解析后必须在 videoDirs 任一目录内（防路径穿越）。
"""

import re
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from app import state
from app.services import settings as settings_service
from app.services import video_subtitle

router = APIRouter()

# 常见视频容器 MIME（不认识的扩展名回落 application/octet-stream）
_VIDEO_MIME = {
    ".mp4": "video/mp4",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".m4v": "video/x-m4v",
    ".avi": "video/x-msvideo",
    ".ts": "video/mp2t",
}
_CHUNK = 256 * 1024  # 流式读取分片大小


def _video_dirs() -> list[Path]:
    """设置 videoDirs → 解析后的绝对路径列表（空目录字符串忽略）"""
    raw_dirs = settings_service.load_all_settings()["video"]["videoDirs"]
    out = []
    for d in raw_dirs:
        if not isinstance(d, str) or not d.strip():
            continue
        p = Path(d).expanduser()
        try:
            out.append(p.resolve())
        except OSError:
            out.append(p.absolute())
    return out


def _resolve_in_dirs(raw: str) -> Path:
    """校验 path 参数：必须解析后位于 videoDirs 任一目录内（防路径穿越）"""
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(400, "缺少 path 参数")
    dirs = _video_dirs()
    if not dirs:
        raise HTTPException(400, "未配置视频目录（设置里添加 videoDirs 后可用）")
    p = Path(raw).expanduser()
    try:
        resolved = p.resolve()
    except OSError:
        resolved = p.absolute()
    if not any(resolved == d or d in resolved.parents for d in dirs):
        raise HTTPException(403, "path 必须在视频目录内")
    if not resolved.is_file():
        raise HTTPException(404, "文件不存在")
    return resolved


# ============ 列表 ============
@router.get("/api/videos")
def api_videos():
    """本地视频列表：扫描 videoDirs 下所有视频文件（扩展名白名单，不刮削）"""
    items = []
    exts = {e.lower() for e in state.VIDEO_EXTS}
    for d in _video_dirs():
        if not d.is_dir():
            continue
        for f in sorted(d.rglob("*")):
            if not f.is_file() or f.suffix.lower() not in exts:
                continue
            st = f.stat()
            items.append(
                {
                    "path": str(f),
                    "name": f.stem,
                    "size": st.st_size,
                    "mtime": int(st.st_mtime * 1000),  # 毫秒时间戳（对齐歌曲列表 mtime）
                }
            )
    return {"items": items}


# ============ Range 视频流 ============
@router.get("/api/videos/stream")
def api_videos_stream(request: Request, path: str = ""):
    """视频流服务：支持 HTTP Range（206 Partial Content + Content-Range 头）

    参考 app/routers/stream.py 同源代理的 Range 透传语义；本地文件直接按区间
    分片读取，浏览器 <video> seek 依赖本端点。非法/不可满足 Range → 416。
    """
    p = _resolve_in_dirs(path)
    size = p.stat().st_size
    media_type = _VIDEO_MIME.get(p.suffix.lower(), "application/octet-stream")
    start, end = 0, size - 1
    status_code = 200
    headers = {"Accept-Ranges": "bytes", "Content-Type": media_type}

    range_h = (request.headers.get("range") or "").strip()
    m = re.match(r"^bytes=(\d*)-(\d*)$", range_h) if range_h else None
    if m:
        s, e = m.group(1), m.group(2)
        if s == "" and e == "":
            raise HTTPException(416, "Range 不可满足", headers={"Content-Range": f"bytes */{size}"})
        if s == "":
            # 后缀区间：bytes=-N → 末尾 N 字节
            n = int(e)
            if n <= 0:
                raise HTTPException(
                    416, "Range 不可满足", headers={"Content-Range": f"bytes */{size}"}
                )
            start = max(0, size - n)
            end = size - 1
        else:
            start = int(s)
            end = int(e) if e else size - 1
        if start >= size or end < start:
            raise HTTPException(416, "Range 不可满足", headers={"Content-Range": f"bytes */{size}"})
        end = min(end, size - 1)
        status_code = 206
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"

    headers["Content-Length"] = str(end - start + 1)
    return StreamingResponse(
        _file_chunks(p, start, end),
        status_code=status_code,
        headers=headers,
    )


def _file_chunks(p: Path, start: int, end: int, chunk_size: int = _CHUNK):
    """按 [start, end] 闭区间分片读取文件（生成器内打开，流完自动关闭）"""
    remaining = end - start + 1
    if remaining <= 0:
        return
    with p.open("rb") as f:
        f.seek(start)
        while remaining > 0:
            data = f.read(min(chunk_size, remaining))
            if not data:
                break
            remaining -= len(data)
            yield data


# ============ 同名字幕 ============
@router.get("/api/videos/subtitle")
def api_videos_subtitle(path: str = ""):
    """同名字幕：<视频名>.srt / .vtt（同级目录，srt 优先）→ {items: [{start, end, text, translation}]}

    无字幕文件返回 {items: []}；translation 本轮恒为 None（双语字幕解析留待后续）。
    """
    p = _resolve_in_dirs(path)
    for ext in (".srt", ".vtt"):
        sub = p.with_suffix(ext)
        if sub.is_file():
            return {"items": video_subtitle.parse_subtitle_file(sub)}
    return {"items": []}
