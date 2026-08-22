"""收藏路由：/api/favorites、/api/favorites/toggle（持久化 SQLite favorites 表）。

对外 API 契约不变：GET 返回 {"paths": [...]}（收藏顺序）；toggle 返回
{"path", "favorited"}。旧 favorites.json 由首次启动自动迁移（见 app/db.py）。
"""

from fastapi import APIRouter, HTTPException

from app import db

router = APIRouter()


@router.get("/api/favorites")
def api_favorites():
    return {"paths": db.favorites_load()}


@router.post("/api/favorites/toggle")
def api_favorites_toggle(body: dict):
    """切换收藏：path 在列表中则移除，否则添加"""
    path = str(body.get("path", ""))
    if not path:
        raise HTTPException(400, "缺少 path")
    return {"path": path, "favorited": db.favorites_toggle(path)}
