"""路由汇总：按域注册所有 API 路由到 FastAPI app。"""

from fastapi import FastAPI

from . import (
    annotations,
    books,
    favorites,
    library,
    lyrics,
    media,
    playback,
    playlists,
    quark,
    settings,
    stream,
    tags,
    vocab,
)

_ROUTER_MODULES = (
    favorites,
    library,
    playlists,
    playback,
    settings,
    stream,
    quark,
    lyrics,
    tags,
    media,
    annotations,
    vocab,
    books,
)


def include_routers(app: FastAPI) -> None:
    """注册全部域路由（顺序无关：无路径前缀冲突）。"""
    for mod in _ROUTER_MODULES:
        app.include_router(mod.router)
