"""曲库路由：歌曲列表/库路径/版本/设置/切库/删除/导入。

- GET /api/songs、GET /api/library、GET /api/library/version
- GET/PUT /api/library/settings、POST /api/library
- DELETE /api/library/songs、POST /api/import
"""

from datetime import datetime
from pathlib import Path
from typing import Annotated

import send2trash
from fastapi import APIRouter, File, HTTPException, UploadFile

from app import db, state
from app.services import download, library_scan
from app.services import settings as settings_service

router = APIRouter()


def _network_song_entry(e: dict) -> dict:
    """网络曲库条目 → /api/songs 里的流媒体歌曲结构（path=null/type=stream 供前端判断）"""
    # 添加时刻转毫秒（与本地歌曲 mtime 同字段，前端"最近添加"统一按 mtime 降序）
    added_ms = 0
    added_at = e.get("addedAt")
    if added_at:
        try:
            added_ms = int(datetime.fromisoformat(added_at).timestamp() * 1000)
        except (ValueError, TypeError):
            added_ms = 0
    return {
        "type": "stream",
        "streamId": str(e.get("id") or ""),
        "provider": e.get("provider") or "netease",
        "path": None,
        "name": e.get("title") or "未知歌曲",
        "artist": e.get("artist") or "",
        "album": e.get("album") or "",
        "duration": e.get("duration"),
        "coverUrl": e.get("coverUrl"),
        "mtime": added_ms,
    }


@router.get("/api/songs")
def api_songs():
    """本地扫描歌曲 + 网络曲库条目（本地歌在前保持原结构，网络歌 type=stream 追加在末尾）"""
    return library_scan.scan_library() + [_network_song_entry(e) for e in db.network_songs_load()]


@router.get("/api/library")
def api_library():
    """返回当前歌曲库路径"""
    return {"path": str(state.LIBRARY)}


@router.get("/api/library/version")
def api_library_version():
    """返回歌曲库变动版本号（前端轮询此值判断是否需要刷新列表）"""
    return {"version": state._scan_version}


@router.get("/api/library/settings")
def api_library_settings():
    """返回音乐库设置（文件类型多选 / 忽略隐藏 / 自动刷新 / 启动自动扫描）"""
    return {"settings": settings_service.load_settings()}


@router.put("/api/library/settings")
def api_update_library_settings(body: dict):
    """保存音乐库设置；扫描相关项变化时清缓存重扫，自动刷新开关变化时启停 watchdog"""
    old = settings_service.load_settings()
    new = settings_service.save_settings(body)
    if new["audioExts"] != old["audioExts"] or new["ignoreHidden"] != old["ignoreHidden"]:
        with state._scan_lock:
            state._scan_cache = None
            state._scan_version += 1
    if new["autoRefresh"] != old["autoRefresh"]:
        if new["autoRefresh"]:
            library_scan.start_watcher()
        else:
            library_scan.stop_watcher()
    return {"settings": new, "count": len(library_scan.scan_library())}


@router.post("/api/library")
async def api_set_library(body: dict):
    """设置歌曲库文件夹（切换后清缓存并重启监听；路径持久化到 settings.json，重启不丢）"""
    p = Path(body.get("path", ""))
    if not p.is_dir():
        raise HTTPException(400, f"目录不存在: {p}")
    library_scan.stop_watcher()
    state.LIBRARY = p
    with state._scan_lock:
        state._scan_cache = None
        state._scan_version += 1
    library_scan.start_watcher()
    # 持久化歌曲库路径（settings.json → library.path）：重启后按用户设定恢复，不回默认
    settings_service.save_settings({"path": str(p)})
    return {"path": str(state.LIBRARY), "count": len(library_scan.scan_library())}


# ============ 曲库删除（移废纸篓 + 引用清理）============
def _remove_paths_from_favorites(paths: list[str]):
    """从收藏中移除给定路径（SQLite；无匹配则不动）"""
    db.favorites_remove(paths)


def _remove_paths_from_playlists(paths: list[str]):
    """从所有歌单的 songPaths 中移除给定路径（SQLite；无匹配则不动）"""
    db.playlists_remove_paths(paths)


@router.delete("/api/library/songs")
def api_library_songs_delete(body: dict):
    """批量删除曲库歌曲：移废纸篓（send2trash）+ 清理歌单/收藏引用 + 触发重扫

    body: {"paths": ["/abs/path/a.mp3", ...]}（去重，仅处理当前曲库内路径）
    返回: {"deleted": n, "missing": [...], "errors": [{"path", "reason"}]}
    语义：不在库内 → missing 绝不碰磁盘；库内 → send2trash 移废纸篓；
    磁盘已丢（库内但文件不在）→ 照常清理引用、计入 deleted；
    send2trash 抛错且文件还在 → errors；网络歌（path 为 null）不参与。
    """
    raw = body.get("paths")
    if not isinstance(raw, list) or not raw:
        raise HTTPException(400, "paths 必须是非空数组")
    # 去重保序；网络歌 path 为 null 不参与
    paths = list(dict.fromkeys(str(p) for p in raw if p is not None and str(p).strip()))
    if not paths:
        return {"deleted": 0, "missing": [], "errors": []}
    in_library = {s["path"] for s in library_scan.scan_library()}
    missing: list[str] = []
    errors: list[dict] = []
    deleted_paths: list[str] = []
    for p in paths:
        if p not in in_library:
            missing.append(p)  # 不在当前曲库内：绝不碰磁盘
            continue
        f = Path(p)
        try:
            if not f.exists():
                deleted_paths.append(p)  # 磁盘已丢：照常清理引用，计入 deleted
                continue
            send2trash.send2trash(str(f))
            deleted_paths.append(p)
        except Exception as e:
            if f.exists():
                errors.append({"path": p, "reason": str(e)})  # 移废纸篓失败且文件还在
            else:
                deleted_paths.append(p)  # 抛错但文件已不在磁盘
    if deleted_paths:
        _remove_paths_from_favorites(deleted_paths)
        _remove_paths_from_playlists(deleted_paths)
        library_scan._schedule_rescan()  # 复用现有去抖重扫：版本号 +1，前端轮询自动刷新
    return {"deleted": len(deleted_paths), "missing": missing, "errors": errors}


# ============ 曲库导入（拖拽/上传 → 复制进库，不动源文件）============
class _ImportTooLargeError(Exception):
    pass


@router.post("/api/import")
async def api_import(files: Annotated[list[UploadFile], File()]):
    """拖拽导入曲库：multipart 字段 files（可多个，files=@a.mp3 重复传）

    复制进库不覆盖源文件；同名自动加后缀；非音频跳过；成功 version+1（前端轮询自动刷新）。
    响应 200: {"imported": n, "skipped": [...], "errors": [{"name", "detail"}]}
    """
    imported = 0
    skipped: list[str] = []
    errors: list[dict] = []
    try:
        state.LIBRARY.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise HTTPException(500, f"曲库目录不可用: {e}") from None
    for uf in files:
        raw = (uf.filename or "").strip()
        ext = Path(raw).suffix.lower()
        if ext not in state.AUDIO_EXTS:
            skipped.append(raw or "(无文件名)")
            continue
        # 文件名清洗：只取 basename 再去非法字符，防目录穿越；resolve 后校验仍在 LIBRARY 下
        name = download._sanitize_filename(Path(raw).name)
        if not name or name in {".", ".."}:
            errors.append({"name": raw, "detail": "非法文件名"})
            continue
        dest = download._unique_path(state.LIBRARY / name)
        try:
            if dest.resolve().parent != state.LIBRARY.resolve():
                errors.append({"name": raw, "detail": "非法文件名"})
                continue
            # 大文件流式写入：分块读，不一次性进内存；超限报 error 不崩
            with dest.open("wb") as out:
                written = 0
                while True:
                    chunk = await uf.read(1024 * 1024)
                    if not chunk:
                        break
                    written += len(chunk)
                    if written > state.IMPORT_MAX_BYTES:
                        raise _ImportTooLargeError(f"超过单文件 {state.IMPORT_MAX_BYTES} 字节上限")
                    out.write(chunk)
            imported += 1
        except _ImportTooLargeError as e:
            dest.unlink(missing_ok=True)
            errors.append({"name": raw, "detail": str(e)})
        except OSError as e:
            dest.unlink(missing_ok=True)
            errors.append({"name": raw, "detail": f"写入失败: {e}"})
    if imported:
        with state._scan_lock:
            state._scan_cache = None  # 强制下次扫描重扫，新文件才能被扫到
            state._scan_version += 1  # 前端 3s 轮询 /api/library/version 自动刷新曲库
    return {"imported": imported, "skipped": skipped, "errors": errors}
