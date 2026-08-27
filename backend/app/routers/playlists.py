"""歌单 + 播放队列顺序路由（持久化 SQLite：playlists 表 / kv_store[queue_order]）。"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException

from app import db

router = APIRouter()


def _find_playlist(playlists: list[dict], pid: str) -> dict | None:
    for p in playlists:
        if p.get("id") == pid:
            return p
    return None


# ============ 歌单 ============
@router.get("/api/playlists")
def api_playlists():
    """全部歌单（按创建顺序）"""
    return {"playlists": db.playlists_load()}


@router.post("/api/playlists")
def api_playlists_create(body: dict):
    """新建歌单"""
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "歌单名称不能为空")
    now = datetime.now(timezone.utc).isoformat()
    playlist = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "songPaths": [],
        "createdAt": now,
        "updatedAt": now,
    }
    playlists = db.playlists_load()
    playlists.append(playlist)
    db.playlists_save(playlists)
    return playlist


@router.patch("/api/playlists/{pid}")
def api_playlists_rename(pid: str, body: dict):
    """歌单改名"""
    name = str(body.get("name", "")).strip()
    if not name:
        raise HTTPException(400, "歌单名称不能为空")
    playlists = db.playlists_load()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    p["name"] = name
    p["updatedAt"] = datetime.now(timezone.utc).isoformat()
    db.playlists_save(playlists)
    return p


@router.delete("/api/playlists/{pid}")
def api_playlists_delete(pid: str):
    """删除歌单"""
    playlists = db.playlists_load()
    before = len(playlists)
    playlists = [p for p in playlists if p.get("id") != pid]
    if len(playlists) == before:
        raise HTTPException(404, "歌单不存在")
    db.playlists_save(playlists)
    return {"ok": True}


@router.post("/api/playlists/{pid}/songs")
def api_playlists_add_song(pid: str, body: dict):
    """往歌单加一首歌（自动去重）"""
    path = str(body.get("path", "")).strip()
    if not path:
        raise HTTPException(400, "缺少 path")
    playlists = db.playlists_load()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    paths = p.setdefault("songPaths", [])
    if path not in paths:
        paths.append(path)
        p["updatedAt"] = datetime.now(timezone.utc).isoformat()
        db.playlists_save(playlists)
    return p


@router.delete("/api/playlists/{pid}/songs/{path:path}")
def api_playlists_remove_song(pid: str, path: str):
    """从歌单移除一首歌"""
    playlists = db.playlists_load()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    paths = p.setdefault("songPaths", [])
    if path in paths:
        paths.remove(path)
        p["updatedAt"] = datetime.now(timezone.utc).isoformat()
        db.playlists_save(playlists)
    return p


@router.put("/api/playlists/{pid}/order")
def api_playlists_order(pid: str, body: dict):
    """拖拽排序：按 paths 数组重排歌单内歌曲（只重排已存在的，防止丢歌）"""
    paths = body.get("paths")
    if not isinstance(paths, list):
        raise HTTPException(400, "缺少 paths 数组")
    playlists = db.playlists_load()
    p = _find_playlist(playlists, pid)
    if p is None:
        raise HTTPException(404, "歌单不存在")
    existing = p.get("songPaths", [])
    ordered = [x for x in paths if x in existing]
    for x in existing:  # 不在新顺序里的原歌曲补在末尾，不丢失
        if x not in ordered:
            ordered.append(x)
    p["songPaths"] = ordered
    p["updatedAt"] = datetime.now(timezone.utc).isoformat()
    db.playlists_save(playlists)
    return p


# ============ 播放队列顺序（持久化 queue_order.json，前端拖拽排序后保存）============
# 队列 = 全部歌曲视图的 state.songs 顺序；本地歌键 = 文件路径，网络歌键 = 'stream:<streamId>'
# （path 为 null 无法区分）。只存顺序键数组，不存歌曲元数据（避免与曲库扫描结果漂移）；
# 恢复时按键匹配，未匹配的新歌补在末尾。
@router.get("/api/queue/order")
def api_queue_order_get():
    """播放队列顺序（前端启动时恢复；空列表 = 未自定义顺序，按曲库默认顺序）"""
    return {"paths": db.queue_order_load()}


@router.put("/api/queue/order")
def api_queue_order_put(body: dict):
    """保存播放队列顺序（paths 必须为字符串数组）"""
    paths = body.get("paths")
    if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
        raise HTTPException(400, "paths 必须是字符串数组")
    db.queue_order_save(paths)
    return {"paths": paths}
