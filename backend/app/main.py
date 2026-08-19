"""FastAPI app 组装：lifespan、路由注册、静态 dist 挂载、__main__ 入口。

运行时歌曲库路径（LIBRARY）的 argv 覆盖逻辑在本模块模块级：
`LIBRARY = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_LIBRARY`
（等价于原 backend.py 模块级行为：import 时无 argv 则默认库）。
"""

import asyncio
import sys
import threading
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import state
from app.routers import include_routers
from app.services import settings as settings_service
from app.services.library_scan import _lyric_cleanup_loop, init_library


@asynccontextmanager
async def _lifespan(app: FastAPI):
    """启动时挂后台任务：每周一 03:00 清理孤儿手动歌词（不阻塞启动）"""
    if state.LYRIC_CLEANUP_ENABLED:
        asyncio.get_running_loop().create_task(_lyric_cleanup_loop())
    yield


app = FastAPI(title="music-player", lifespan=_lifespan)

# 运行时歌曲库路径（可通过命令行参数修改；等价原 backend.py 模块级逻辑）
if len(sys.argv) > 1:
    state.LIBRARY = Path(sys.argv[1])

include_routers(app)

# 静态前端（构建产物 dist/，vite outDir 为仓库根 dist）
if (state.ROOT / "dist").is_dir():
    app.mount(
        "/",
        StaticFiles(directory=str(state.ROOT / "dist"), html=True),
        name="frontend",
    )


def _apply_persisted_library_path() -> None:
    """启动时应用用户持久化的歌曲库路径（settings.json → library.path）

    用户在前端设置过歌曲库（POST /api/library）→ 重启后仍用该路径，不回默认；
    未设置（空）或目录已不存在（外接盘未挂/被删）→ 保持当前值（默认库/argv），绝不崩。
    """
    saved = settings_service.load_settings().get("path") or ""
    if saved and Path(saved).is_dir():
        state.LIBRARY = Path(saved)


def main():
    """启动入口：初始化歌曲库 + 打印启动信息 + 自动开浏览器 + uvicorn 服务"""
    if len(sys.argv) > 1:
        state.LIBRARY = Path(sys.argv[1])
    else:
        # 未显式传 argv → 用户设置过歌曲库则用持久化值（argv 显式指定优先）
        _apply_persisted_library_path()
    # 默认曲库目录不存在时自动创建（默认库 / argv / 持久化路径已定，最后统一建）
    state.LIBRARY.mkdir(parents=True, exist_ok=True)
    init_library()
    url = f"http://localhost:{state.DEFAULT_PORT}"
    print(f"🎵 music-player 已启动: {url}")
    print(f"   歌曲库: {state.LIBRARY}")
    if settings_service.load_settings()["autoRefresh"]:
        print(f"   📁 监听歌曲库变动（去抖 {state.WATCH_DEBOUNCE_SECONDS}s，自动刷新列表）")
    else:
        print("   📁 自动刷新已关闭（设置里可开启）")
    threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host="0.0.0.0", port=state.DEFAULT_PORT, log_level="warning")


if __name__ == "__main__":
    main()
