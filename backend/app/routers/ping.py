"""主机可达性探测路由：GET /api/ping → {"ok": true}。

供 iOS 壳启动探测（probeHost）与恢复探测使用：极轻量（无 DB/无扫描），
免鉴权（见 auth 中间件白名单）——探测时 token 可能无效/过期/未配对，
不因 401 误判主机离线；带 token 的请求同样接受。
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/api/ping")
def api_ping():
    """主机可达性探测：任何 HTTP 响应（含 401/404/500）都证明主机在线。"""
    return {"ok": True}
