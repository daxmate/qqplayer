"""收藏路由：/api/favorites、/api/favorites/toggle（持久化 favorites.json）。"""

from fastapi import APIRouter, HTTPException

from app import state

router = APIRouter()


@router.get("/api/favorites")
def api_favorites():
    return {"paths": state.favorites_store.load()}


@router.post("/api/favorites/toggle")
async def api_favorites_toggle(body: dict):
    """切换收藏：path 在列表中则移除，否则添加"""
    path = str(body.get("path", ""))
    if not path:
        raise HTTPException(400, "缺少 path")
    paths = state.favorites_store.load()
    if path in paths:
        paths.remove(path)
        favorited = False
    else:
        paths.append(path)
        favorited = True
    state.favorites_store.save(paths)
    return {"path": path, "favorited": favorited}
