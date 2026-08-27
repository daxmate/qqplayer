"""主机可达性探测端点测试：GET /api/ping → {"ok": true}；鉴权白名单（免鉴权）。

背景（契约 docs/host-reachability.md）：iOS 壳启动探测（probeHost）与恢复探测
都打 /api/ping——探测时 token 可能无效/过期/未配对，不因 401 误判主机离线；
带 token 的请求同样接受。本文件专项测「免鉴权」：显式开启鉴权
（conftest 默认关闭），以非 localhost 来源验证白名单。

运行：cd backend && venv/bin/python -m pytest tests/test_ping.py -q
"""

import asyncio

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

import backend
from app import state

client = TestClient(backend.app)

REMOTE_HOST = "192.168.1.50"  # 模拟局域网 iOS 设备（非 localhost）


def _remote_get(path: str) -> tuple[int, dict | None]:
    """以指定来源 IP 发起 GET（ASGITransport 可注入 client host）"""

    async def _run():
        transport = ASGITransport(app=backend.app, client=(REMOTE_HOST, 50000))
        async with AsyncClient(transport=transport, base_url="http://testserver") as c:
            r = await c.get(path)
            try:
                return r.status_code, r.json()
            except ValueError:
                return r.status_code, None

    return asyncio.run(_run())


@pytest.fixture(autouse=True)
def _enable_auth(monkeypatch):
    """本文件专项测「免鉴权」：显式开启鉴权（conftest 的 autouse fixture 默认关闭）"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)


def test_ping_ok():
    r = client.get("/api/ping")
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_ping_no_auth_remote():
    """远程（非 localhost）+ 无 token：ping 在鉴权白名单，仍 200（不因 401 误判离线）"""
    status, body = _remote_get("/api/ping")
    assert status == 200
    assert body == {"ok": True}


def test_ping_with_token():
    """带 token 的探测请求同样接受（探测层不依赖 token 有效性）"""
    r = client.get("/api/ping", headers={"Authorization": "Bearer some-token"})
    assert r.status_code == 200
    assert r.json() == {"ok": True}


def test_other_api_remote_requires_auth():
    """对照：非白名单 API 远程无 token 仍 401（证明 ping 免鉴权是特例而非整体放行）"""
    status, _ = _remote_get("/api/settings")
    assert status == 401
