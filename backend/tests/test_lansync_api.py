"""局域网同步 API 测试（FastAPI 路由层 · /api/lansync/*）。

覆盖 `docs/lan-sync-web-host-plan.md` §3 冻结接口在 HTTP 层的形状与降级：

- 未启动/不可用时的降级：status 恒 200（`available`/`running`/`error`），配对类端点 503
- 身份：全量 Device ID / 分组 / 首末组 / Ed25519 公钥
- 配对：start（QR data URL + 载荷）/ stop / 换新码作废旧码 / pending
- approve / reject / cancel 走通（真 TCP 回环，客户端见 `tests/lansync_ref_client.py`）
- devices 列表 / 撤销配对 / events 游标推进

HTTP 走 `httpx.ASGITransport`（应用与测试**同一事件循环**，服务端会话与请求无跨线程）；
数据隔离：`state.DATA_DIR` → tmp_path，身份文件/信任表绝不落真实用户目录。
"""

from __future__ import annotations

import asyncio
import base64
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lansync_ref_client import RefClient  # noqa: E402

import backend  # noqa: E402
from app import state  # noqa: E402
from app.lansync import crypto as lc  # noqa: E402
from app.lansync.qr import decode_qr_payload  # noqa: E402
from app.lansync.service import SyncService  # noqa: E402
from app.services import lansync_host  # noqa: E402

HOST = "127.0.0.1"


def _run(coro):
    """跑一个异步场景（本仓库未装 pytest-asyncio）。"""
    return asyncio.run(coro)


async def _wait_for(predicate, timeout: float = 5.0, interval: float = 0.01):
    """轮询等待条件成立（返回其值），超时抛 AssertionError。"""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        await asyncio.sleep(interval)
    raise AssertionError(f"等待条件超时（最后值 {last!r}）")


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    """身份/信任表落临时目录；单例每测试重建（防跨测试串状态）。"""
    monkeypatch.setattr(state, "DATA_DIR", tmp_path / "data")
    lansync_host.reset_service()
    yield
    lansync_host.reset_service()


def _make_service() -> SyncService:
    """回环测试服务：不广播 mDNS、端口系统分配（与 test_lansync_service 同款隔离）。"""
    return SyncService(
        store_dir=state.DATA_DIR,
        device_name="Test Host",
        host=HOST,
        port=0,
        enable_mdns=False,
    )


def _http() -> AsyncClient:
    """ASGI 直连客户端（同事件循环；client host = 127.0.0.1）。"""
    return AsyncClient(
        transport=ASGITransport(app=backend.app, client=(HOST, 50000)),
        base_url="http://testserver",
    )


def _ref(
    started: dict,
    *,
    identity: lc.Identity | None = None,
    nonce: bytes | None = None,
    name: str = "Ref iPhone",
) -> RefClient:
    """按 `POST /pairing/start` 的返回构造参考客户端（identity 复用 = 已配对重连）。"""
    payload = decode_qr_payload(started["qr_payload"])
    return RefClient(
        identity=identity or lc.Identity.generate(),
        host_device_id=payload.deviceID,
        host_public_key=base64.b64decode(payload.publicKey),
        session_nonce=nonce if nonce is not None else base64.b64decode(payload.sessionNonce),
        display_name=name,
    )


async def _connect_pairing(started: dict, service: SyncService, **kwargs) -> RefClient:
    """起客户端 → 收 host hello → 发 pair_request（等到 host 侧出现待批准项）。"""
    client = _ref(started, **kwargs)
    await client.open(HOST, service.status["port"])
    await client.read_host_hello()
    client.send_pair_request()
    await _wait_for(lambda: service.pending_pairs)
    return client


# ------------------------------------------------------ ① 降级：未启动


def test_status_degraded_when_not_started(monkeypatch):
    """服务可用但未启动：status 200 + running=false；配对类端点 503；只读端点仍可用。"""
    monkeypatch.setattr(lansync_host, "_service", _make_service())
    client = TestClient(backend.app)

    body = client.get("/api/lansync/status").json()
    assert (body["available"], body["running"], body["port"]) == (True, False, 0)
    # 展示名经 safe_device_name 清洗（空格 → '-'，mDNS 实例名/TXT 非法字符）
    assert body["device_name"] == "Test-Host"
    assert body["protocol_version"] == 1
    assert body["error"] is None

    assert client.post("/api/lansync/pairing/start").status_code == 503
    assert client.post("/api/lansync/pairing/stop").status_code == 503
    assert client.get("/api/lansync/pairing/pending").status_code == 503
    assert client.post("/api/lansync/pairing/x/approve").status_code == 503
    assert client.post("/api/lansync/pairing/x/reject").status_code == 503
    assert client.post("/api/lansync/pairing/x/cancel").status_code == 503

    assert client.get("/api/lansync/identity").status_code == 200
    assert client.get("/api/lansync/devices").json() == {"devices": []}
    assert client.get("/api/lansync/events").json() == {"cursor": 0, "events": []}


def test_status_unavailable_when_init_fails(monkeypatch):
    """服务初始化失败（身份文件损坏等）：status 200 + available=false + error；其余 503。"""

    def boom() -> SyncService:
        raise RuntimeError("身份文件损坏：private_key 不是合法 base64")

    monkeypatch.setattr(lansync_host, "_new_service", boom)
    client = TestClient(backend.app)

    body = client.get("/api/lansync/status").json()
    assert body["available"] is False
    assert body["running"] is False
    assert body["port"] == 0
    assert body["protocol_version"] == 1
    assert "身份文件损坏" in body["error"]

    assert client.get("/api/lansync/identity").status_code == 503
    assert client.get("/api/lansync/devices").status_code == 503
    assert client.get("/api/lansync/events").status_code == 503


# ------------------------------------------------------ ② 身份 + 全流程


async def _pairing_flow(monkeypatch) -> None:
    service = _make_service()
    await service.start()
    monkeypatch.setattr(lansync_host, "_service", service)
    try:
        async with _http() as http:
            # 身份：全量 ID / 分组 / 首末组 / 公钥
            identity = (await http.get("/api/lansync/identity")).json()
            assert identity["device_id"] == service.identity_info["device_id"]
            assert "".join(identity["device_id_groups"]) == identity["device_id"]
            assert len(identity["device_id_groups"]) == 8
            assert identity["short_parts"] == [
                identity["device_id_groups"][0],
                identity["device_id_groups"][-1],
            ]
            assert len(base64.b64decode(identity["public_key"])) == 32

            status = (await http.get("/api/lansync/status")).json()
            assert status["running"] is True
            assert status["port"] == service.status["port"] > 0

            # 配对 start：QR data URL + 载荷 + nonce 一致
            started = (await http.post("/api/lansync/pairing/start")).json()
            assert started["qr_image"].startswith("data:image/png;base64,")
            payload = decode_qr_payload(started["qr_payload"])
            assert payload.deviceID == identity["device_id"]
            assert payload.publicKey == identity["public_key"]
            assert base64.b64decode(started["nonce"]) == base64.b64decode(payload.sessionNonce)

            # 客户端发起配对 → pending 可见
            client = await _connect_pairing(started, service)
            pending = (await http.get("/api/lansync/pairing/pending")).json()["requests"]
            assert len(pending) == 1
            assert pending[0]["display_name"] == "Ref iPhone"
            request_id = pending[0]["request_id"]

            # approve（带 display_name）→ 客户端 approved + 进 ready
            approved = await http.post(
                f"/api/lansync/pairing/{request_id}/approve", json={"display_name": "我的 iPhone"}
            )
            assert approved.status_code == 200
            assert approved.json() == {"ok": True, "approved": True}
            response = await client.read_pair_response()
            assert response["approved"] is True
            client.establish_ready()

            # devices：已配对 + 在线 + ready
            devices = (await http.get("/api/lansync/devices")).json()["devices"]
            assert len(devices) == 1
            assert devices[0]["display_name"] == "我的 iPhone"
            assert (devices[0]["online"], devices[0]["phase"]) == (True, "ready")

            # events：游标推进 + 事件类型齐全；重复查询同一游标返回空
            first = (await http.get("/api/lansync/events")).json()
            assert first["cursor"] > 0
            types = {event["type"] for event in first["events"]}
            assert {"session", "pair_request", "pair_result", "device"} <= types
            again = (await http.get(f"/api/lansync/events?cursor={first['cursor']}")).json()
            assert again == {"cursor": first["cursor"], "events": []}
            assert (await http.get("/api/lansync/events?cursor=abc")).status_code == 422

            # 撤销配对：命中 200 + 列表清空；重放同 ID → 404
            peer_id = devices[0]["peer_id"]
            assert (await http.delete(f"/api/lansync/devices/{peer_id}")).json() == {"ok": True}
            assert (await http.get("/api/lansync/devices")).json()["devices"] == []
            assert (await http.delete(f"/api/lansync/devices/{peer_id}")).status_code == 404
            await client.aclose()
    finally:
        await service.stop()


def test_pairing_flow_over_http(monkeypatch):
    """② 全流程：身份 → status → start → pending → approve → devices → events → 撤销。"""
    _run(_pairing_flow(monkeypatch))


# ------------------------------------------- ③ 换码 / 拒绝 / 取消 / 停止


async def _rotations_and_decisions(monkeypatch) -> None:
    service = _make_service()
    await service.start()
    monkeypatch.setattr(lansync_host, "_service", service)
    try:
        async with _http() as http:
            # 换新码 = 作废旧码：旧 nonce 的客户端被明确拒绝
            first = (await http.post("/api/lansync/pairing/start")).json()
            second = (await http.post("/api/lansync/pairing/start")).json()
            assert first["nonce"] != second["nonce"]
            stale = _ref(first)
            await stale.open(HOST, service.status["port"])
            await stale.read_host_hello()
            stale.send_pair_request()
            stale_response = await stale.read_pair_response()
            assert stale_response["approved"] is False
            assert "nonce" in stale_response["reason"]
            assert await stale.wait_closed(2.0) is True
            await stale.aclose()

            # stop：作废当前码（同款拒绝路径）
            assert (await http.post("/api/lansync/pairing/stop")).json() == {"ok": True}
            third = (await http.post("/api/lansync/pairing/start")).json()
            assert (await http.post("/api/lansync/pairing/stop")).status_code == 200
            stopped = _ref(third)
            await stopped.open(HOST, service.status["port"])
            await stopped.read_host_hello()
            stopped.send_pair_request()
            assert (await stopped.read_pair_response())["approved"] is False
            assert await stopped.wait_closed(2.0) is True
            await stopped.aclose()

            # 拒绝：approved=false + reason + 断连 + 不落信任记录
            current = (await http.post("/api/lansync/pairing/start")).json()
            reject_client = await _connect_pairing(current, service, name="Ref iPad")
            pending = (await http.get("/api/lansync/pairing/pending")).json()["requests"]
            request_id = pending[0]["request_id"]
            rejected = await http.post(
                f"/api/lansync/pairing/{request_id}/reject", json={"reason": "用户拒绝"}
            )
            assert rejected.status_code == 200
            assert rejected.json() == {"ok": True, "approved": False}
            reject_response = await reject_client.read_pair_response()
            assert reject_response["approved"] is False
            assert reject_response["reason"] == "用户拒绝"
            assert await reject_client.wait_closed(2.0) is True
            await reject_client.aclose()
            await _wait_for(lambda: not service.pending_pairs)
            assert (await http.get("/api/lansync/devices")).json()["devices"] == []

            # 未知 request_id → 404（批准/拒绝/取消一致）
            assert (await http.post("/api/lansync/pairing/deadbeef/approve")).status_code == 404
            assert (await http.post("/api/lansync/pairing/deadbeef/reject")).status_code == 404
            assert (await http.post("/api/lansync/pairing/deadbeef/cancel")).status_code == 404

            # 取消：直接断连（不下发 pair_response）
            current2 = (await http.post("/api/lansync/pairing/start")).json()
            cancel_client = await _connect_pairing(current2, service, name="Ref Mac")
            pending2 = (await http.get("/api/lansync/pairing/pending")).json()["requests"]
            cancel_id = pending2[0]["request_id"]
            assert (await http.post(f"/api/lansync/pairing/{cancel_id}/cancel")).json() == {
                "ok": True
            }
            assert await cancel_client.wait_closed(2.0) is True
            await cancel_client.aclose()
            await _wait_for(lambda: not service.pending_pairs)
    finally:
        await service.stop()


def test_pairing_rotations_and_decisions(monkeypatch):
    """③ 换码作废旧码 / stop 作废 / 拒绝 / 取消 / 未知 request_id 404。"""
    _run(_rotations_and_decisions(monkeypatch))
