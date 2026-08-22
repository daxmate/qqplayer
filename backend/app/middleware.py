"""鉴权中间件：保护除白名单外所有 /api/*。

规则（PLANNING.md 2026-08-22 定案）：
- 白名单：/api/pairing/*（全部配对端点免鉴权）
- 来源 127.0.0.1 → 免鉴权（本机即管理员）
- 其余请求校验 `Authorization: Bearer <token>`，SHA-256 后与 pairing.json 比对，无效返 401
- 测试开关：state.AUTH_ENABLED=False（QQPLAYER_ENABLE_AUTH=0）时整体放行
  （TestClient 来源 host=testclient 非 localhost，现有测试默认关闭鉴权）
"""

from fastapi import Request
from fastapi.responses import JSONResponse

from app import state
from app.services import pairing as pairing_service

# 本机来源（IPv4/IPv6/localhost）视为管理员免鉴权
_LOCALHOST_HOSTS = ("127.0.0.1", "::1", "localhost")


def register_auth_middleware(app) -> None:
    """向 FastAPI app 注册鉴权中间件（main.py 组装时调用）。"""

    @app.middleware("http")
    async def _auth_middleware(request: Request, call_next):
        if not state.AUTH_ENABLED:
            return await call_next(request)
        path = request.url.path
        # 只保护 API：静态前端与其他路径放行
        if not path.startswith("/api/"):
            return await call_next(request)
        # 白名单：配对端点全程免鉴权（iOS 发起配对时还没有 token）
        if path.startswith("/api/pairing"):
            return await call_next(request)
        # 本机来源免鉴权（桌面浏览器/壳直接访问）
        client_host = request.client.host if request.client else ""
        if client_host in _LOCALHOST_HOSTS:
            return await call_next(request)
        # Bearer token 校验（SHA-256 哈希比对 pairing.json）
        auth_header = request.headers.get("authorization", "")
        token = auth_header[7:] if auth_header.startswith("Bearer ") else ""
        if token and pairing_service.verify_token(token):
            return await call_next(request)
        return JSONResponse(status_code=401, content={"detail": "未授权：缺少或无效的配对 token"})
