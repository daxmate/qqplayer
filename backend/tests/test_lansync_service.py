"""SyncService 应用层端到端测试（回环真 asyncio TCP，绑 127.0.0.1）。

覆盖 `docs/lan-sync-web-host-plan.md` §3 冻结接口与协议主流程：

- 配对全流程（QR 载荷 → 扫 → pair_request → 批准 → 双方 ready → **收发加密业务帧**）
- 拒绝路径（approved=false + 连接断开）
- 已配对重连（不弹批准、跳过 pair_request 直进 ready）
- 无效/过期 nonce → 明确拒绝（不静默成功）
- 握手超时（注入小超时）
- 撤销配对后再连 → 不再直通 ready，业务帧被按协议违例断连
- 协议违例（ready 前业务帧 / 明文业务帧）
- 身份持久化（0600 / 重启复用）、设备列表、事件游标

参考客户端见 `tests/lansync_ref_client.py`（client 角色，测试专用）。
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import stat
import time
from pathlib import Path

import pytest
from lansync_ref_client import RefClient

from app.lansync import crypto as lc
from app.lansync.deviceid import formatted
from app.lansync.frame import FrameType
from app.lansync.models import SyncSessionConfig
from app.lansync.qr import decode_qr_payload
from app.lansync.service import IDENTITY_FILE, IdentityStoreError, SyncService

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


async def _start_service(store_dir: Path, *, frames: list | None = None, **kwargs) -> SyncService:
    """起一个只监听回环、不广播 mDNS 的服务（业务帧收集到 frames）。"""
    collected: list = [] if frames is None else frames
    service = SyncService(
        store_dir=store_dir,
        device_name="Test Host",
        host=HOST,
        port=0,
        enable_mdns=False,
        on_application_frame=lambda session, frame_type, payload: collected.append(
            (frame_type, payload)
        ),
        **kwargs,
    )
    await service.start()
    return service


def _qr_candidate(service: SyncService) -> tuple[dict, dict]:
    """`start_pairing()` → (QR 载荷字典, 原始 dict)。"""
    payload = service.start_pairing()
    return decode_qr_payload(payload["qr_payload"]).to_dict(), payload


def _new_client(service: SyncService, qr: dict, *, identity=None, nonce=None) -> RefClient:
    """按 QR 候选构造参考客户端（identity 复用 = 已配对设备重连）。"""
    return RefClient(
        identity=identity or lc.Identity.generate(),
        host_device_id=service.identity_info["device_id"],
        host_public_key=base64.b64decode(qr["publicKey"]),
        session_nonce=nonce if nonce is not None else base64.b64decode(qr["sessionNonce"]),
        display_name="Ref iPhone",
    )


async def _pair(service: SyncService, qr: dict, *, identity=None, name: str = "我的 iPhone"):
    """完成一次配对（QR → pair_request → 批准 → ready），返回客户端。"""
    client = _new_client(service, qr, identity=identity)
    await client.open(HOST, service.status["port"])
    await client.read_host_hello()
    client.send_pair_request()
    pending = await _wait_for(lambda: service.pending_pairs)
    assert service.approve_pair(pending[0]["request_id"], name) is True
    response = await client.read_pair_response()
    assert response["approved"] is True
    client.establish_ready()
    return client


# ------------------------------------------------------------------ ① 全流程


async def _pairing_full_flow(store_dir: Path) -> None:
    frames: list = []
    service = await _start_service(store_dir, frames=frames)
    try:
        host = service.identity_info
        port = service.status["port"]
        assert port > 0
        assert service.status["running"] is True
        assert service.status["protocol_version"] == 1
        assert host["device_id_formatted"] == formatted(host["device_id"])
        qr, raw = _qr_candidate(service)
        assert qr["deviceID"] == host["device_id"]
        assert qr["publicKey"] == host["public_key"]
        assert qr["hostName"] == service.status["device_name"]
        assert base64.b64decode(qr["sessionNonce"]) == base64.b64decode(raw["nonce"])
        assert len(base64.b64decode(raw["nonce"])) == 16

        identity = lc.Identity.generate()
        client = _new_client(service, qr, identity=identity)
        await client.open(HOST, port)
        hello = await client.read_host_hello()
        assert hello.name == service.status["device_name"]  # 展示名随 host hello 下发
        client.send_pair_request()
        pending = await _wait_for(lambda: service.pending_pairs)
        assert len(pending) == 1
        item = pending[0]
        assert item["device_id"] == identity.device_id
        assert item["display_name"] == "Ref iPhone"
        assert item["suggested_display_name"] == formatted(identity.device_id)
        assert item["device_id_formatted"] == formatted(identity.device_id)
        assert item["request_id"]
        assert service.approve_pair(item["request_id"], "我的 iPhone") is True
        response = await client.read_pair_response()
        assert response["approved"] is True
        client.establish_ready()

        # client → host 加密业务帧
        client.send_application_frame(FrameType.FILE_META, b'{"k":1}')
        await _wait_for(lambda: frames)
        assert frames == [(int(FrameType.FILE_META), b'{"k":1}')]

        # host → client 加密业务帧
        session = service.sessions[0]
        assert session.is_ready
        assert session.peer_device_id == identity.device_id
        session.send_application_frame(FrameType.MANIFEST_REQUEST, b'{"q":2}')
        frame_type, payload = await client.recv_application_frame()
        assert (frame_type, payload) == (int(FrameType.MANIFEST_REQUEST), b'{"q":2}')

        # 设备列表 / 事件
        devices = service.devices()
        assert len(devices) == 1
        assert devices[0]["peer_id"] == identity.device_id
        assert devices[0]["display_name"] == "我的 iPhone"
        assert devices[0]["online"] is True
        assert devices[0]["phase"] == "ready"
        assert devices[0]["paired_at"] > 0
        cursor, events = service.events_since(0)
        phases = [event["phase"] for event in events if event["type"] == "session"]
        assert "waitingForPeerHello" in phases
        assert "waitingForPairApproval" in phases
        assert "ready" in phases
        assert any(event["type"] == "pair_request" for event in events)
        assert any(event["type"] == "pair_result" and event["approved"] for event in events)
        assert any(event["type"] == "device" for event in events)
        assert [event["seq"] for event in events] == sorted(event["seq"] for event in events)
        # 游标推进 + 配对完成后 nonce 作废（pending 清空、无待批准项）
        assert service.events_since(cursor) == (cursor, [])
        assert service.pending_pairs == []

        # 断开 → 在线状态回落
        await client.aclose()
        await _wait_for(lambda: service.devices()[0]["online"] is False, timeout=5)
        assert service.devices()[0]["phase"] in (None, "closed")
    finally:
        await service.stop()


def test_pairing_full_flow(tmp_path):
    """① 配对成功全流程：QR → 扫 → pair_request → 批准 → 双方 ready → 加密帧往返。"""
    _run(_pairing_full_flow(tmp_path))


# ------------------------------------------------------------------ ② 拒绝


async def _rejection(store_dir: Path) -> None:
    service = await _start_service(store_dir)
    try:
        qr, _ = _qr_candidate(service)
        client = _new_client(service, qr)
        await client.open(HOST, service.status["port"])
        await client.read_host_hello()
        client.send_pair_request()
        pending = await _wait_for(lambda: service.pending_pairs)
        assert service.reject_pair(pending[0]["request_id"], "用户拒绝") is True
        response = await client.read_pair_response()
        assert response["approved"] is False
        assert response["reason"] == "用户拒绝"
        assert await client.wait_closed() is True  # 拒绝后断连
        await client.aclose()
        assert service.devices() == []  # 未落信任记录
        _, events = service.events_since(0)
        assert any(
            event["type"] == "pair_result" and event["approved"] is False for event in events
        )
        assert any(
            event["type"] == "session" and event.get("reason", {}).get("kind") == "pairingRejected"
            for event in events
        )
    finally:
        await service.stop()


def test_pair_rejection(tmp_path):
    """② 拒绝路径：approved=false + reason + 连接断开 + 不落信任记录。"""
    _run(_rejection(tmp_path))


# ------------------------------------------------------------------ ③ 重连


async def _paired_reconnect(store_dir: Path) -> None:
    frames: list = []
    service = await _start_service(store_dir, frames=frames)
    try:
        qr, _ = _qr_candidate(service)
        identity = lc.Identity.generate()
        client = await _pair(service, qr, identity=identity)
        await client.aclose()
        await _wait_for(lambda: not service.sessions)

        # 已配对重连：不带扫码候选（nonce=None），pinning 公钥 = QR 里的 host 公钥
        again = RefClient(
            identity=identity,
            host_device_id=service.identity_info["device_id"],
            host_public_key=base64.b64decode(qr["publicKey"]),
            session_nonce=None,
            display_name="Ref iPhone",
        )
        await again.open(HOST, service.status["port"])
        await again.read_host_hello()
        again.establish_ready()
        assert await _wait_for(lambda: [s for s in service.sessions if s.is_ready])
        assert service.pending_pairs == []  # 不弹批准
        # 业务帧通道抽样：用**未被内部实现消费**的帧型（S4 起帧 8/9 由变更日志处理器
        # 应答 / 落库，不再透传到应用层；帧 15 仍按“无内部消费者 → 交应用层”的语义走）
        again.send_application_frame(FrameType.PEER_LIBRARY_REQUEST, b'{"cursor":0}')
        await _wait_for(lambda: frames)
        assert frames == [(int(FrameType.PEER_LIBRARY_REQUEST), b'{"cursor":0}')]
        _, events = service.events_since(0)
        assert sum(1 for e in events if e["type"] == "pair_request") == 1  # 只第一次配对
        await again.aclose()
    finally:
        await service.stop()


def test_paired_device_reconnects_without_approval(tmp_path):
    """③ 已配对重连：跳过 pair_request / 不弹批准，直接 ready 并收发加密帧。"""
    _run(_paired_reconnect(tmp_path))


# ---------------------------------------------------------- ④ 无效/过期 nonce


async def _invalid_nonce(store_dir: Path) -> None:
    service = await _start_service(store_dir)
    try:
        first, _ = _qr_candidate(service)
        service.start_pairing()  # 换新码 → 旧码作废

        stale = _new_client(service, first)
        await stale.open(HOST, service.status["port"])
        await stale.read_host_hello()
        stale.send_pair_request()
        response = await stale.read_pair_response()
        assert response["approved"] is False
        assert "nonce" in response["reason"]
        assert await stale.wait_closed() is True
        await stale.aclose()
        assert service.pending_pairs == []  # 不静默成功
        assert service.devices() == []

        # 从未登记过的随机 nonce：同样明确拒绝
        unknown = _new_client(service, first, nonce=os.urandom(16))
        await unknown.open(HOST, service.status["port"])
        await unknown.read_host_hello()
        unknown.send_pair_request()
        response = await unknown.read_pair_response()
        assert response["approved"] is False
        assert await unknown.wait_closed() is True
        await unknown.aclose()
    finally:
        await service.stop()


def test_invalid_or_expired_nonce_rejected(tmp_path):
    """④ 无效/过期 nonce：明确回 approved=false + 断连，不静默成功。"""
    _run(_invalid_nonce(tmp_path))


# ------------------------------------------------------------------ ⑤ 超时


async def _handshake_timeout(store_dir: Path) -> None:
    service = await _start_service(
        store_dir, session_config=SyncSessionConfig(handshake_timeout=0.2)
    )
    try:
        port = service.status["port"]
        # (a) 连上不发 hello → waitingForPeerHello 超时
        reader, writer = await asyncio.open_connection(HOST, port)
        assert await asyncio.wait_for(reader.read(1024), timeout=5) == b""
        writer.close()
        await _wait_for(
            lambda: any(
                event["type"] == "session"
                and event.get("reason", {}).get("kind") == "handshakeTimeout"
                for event in service.events_since(0)[1]
            )
        )
        # (b) 发了 hello 但不发 pair_request → waitingForPairRequest 超时
        qr, _ = _qr_candidate(service)
        client = _new_client(service, qr)
        await client.open(HOST, port)
        await client.read_host_hello()
        assert await client.wait_closed(timeout=5) is True
        await client.aclose()
        assert service.sessions == ()
    finally:
        await service.stop()


def test_handshake_timeout_closes_session(tmp_path):
    """⑤ 握手超时：等 hello / 等 pair_request 两阶段都按 handshakeTimeout 关闭。"""
    _run(_handshake_timeout(tmp_path))


# ------------------------------------------------------------ ⑥ 撤销配对后重连


async def _revoked_pairing(store_dir: Path) -> None:
    frames: list = []
    service = await _start_service(store_dir, frames=frames)
    try:
        qr, _ = _qr_candidate(service)
        identity = lc.Identity.generate()
        client = await _pair(service, qr, identity=identity)
        await client.aclose()
        await _wait_for(lambda: not service.sessions)
        assert service.remove_device(identity.device_id) is True
        assert service.remove_device(identity.device_id) is False  # 幂等
        assert service.devices() == []

        # 撤销后重连：host 不再命中 pinning → 停在等 pair_request（不直通 ready）
        again = RefClient(
            identity=identity,
            host_device_id=service.identity_info["device_id"],
            host_public_key=base64.b64decode(qr["publicKey"]),
            session_nonce=None,
            display_name="Ref iPhone",
        )
        await again.open(HOST, service.status["port"])
        await again.read_host_hello()
        again.establish_ready()  # 客户端自以为已配对（本地仍持有 pinning 公钥）
        assert await _wait_for(lambda: service.sessions)
        assert service.sessions[0].phase.value == "waitingForPairRequest"
        # 客户端发业务帧 → host 阶段不符 → 协议违例断连（不静默接受）
        again.send_application_frame(FrameType.FILE_META, b'{"k":1}')
        assert await again.wait_closed() is True
        await again.aclose()
        assert frames == []
        _, events = service.events_since(0)
        assert sum(1 for e in events if e["type"] == "session" and e["phase"] == "ready") == 1
        assert any(
            e["type"] == "session" and e.get("reason", {}).get("kind") == "protocolViolation"
            for e in events
        )
    finally:
        await service.stop()


def test_revoked_device_does_not_reconnect(tmp_path):
    """⑥ 撤销配对后再连：pinning 不再命中 → 不直通 ready，业务帧按违例断连。"""
    _run(_revoked_pairing(tmp_path))


# ------------------------------------------------------------ ⑦ 协议违例


async def _protocol_violations(store_dir: Path) -> None:
    service = await _start_service(store_dir)
    try:
        port = service.status["port"]
        # (a) 首帧就是明文业务帧（waitingForPeerHello）
        early = RefClient(
            identity=lc.Identity.generate(),
            host_device_id=service.identity_info["device_id"],
            host_public_key=lc.Identity.generate().public_key_raw,
            peer_binding="",
        )
        await early.open(HOST, port)
        early.send_plain_frame(FrameType.FILE_META, b"{}")
        assert await early.wait_closed() is True
        await early.aclose()

        # (b) hello 之后（waitingForPairRequest）发明文业务帧
        qr, _ = _qr_candidate(service)
        mid = _new_client(service, qr)
        await mid.open(HOST, port)
        await mid.read_host_hello()
        mid.send_plain_frame(FrameType.FILE_CHUNK, b"x")
        assert await mid.wait_closed() is True
        await mid.aclose()

        # (c) 帧解码失败（magic 非法）
        junk = _new_client(service, qr)
        await junk.open(HOST, port)
        junk.send_raw(b"XXXX1234567890")
        assert await junk.wait_closed() is True
        await junk.aclose()

        # (d) 已配对 ready 后发明文业务帧
        identity = lc.Identity.generate()
        client = await _pair(service, qr, identity=identity)
        client.send_plain_frame(FrameType.FILE_META, b"{}")
        assert await client.wait_closed() is True
        await client.aclose()
        await _wait_for(lambda: not service.sessions)

        _, events = service.events_since(0)
        reasons = [e["reason"]["kind"] for e in events if e["type"] == "session" and "reason" in e]
        assert reasons.count("protocolViolation") >= 3
    finally:
        await service.stop()


def test_protocol_violations_close_connection(tmp_path):
    """⑦ 协议违例：ready 前业务帧 / 明文业务帧 / 帧解码失败一律断连。"""
    _run(_protocol_violations(tmp_path))


# ---------------------------------------------------------- 身份 / 生命周期


def test_identity_persists_across_restart(tmp_path):
    """身份持久化：0600、原子写、重启复用同一 Device ID。"""
    first = SyncService(store_dir=tmp_path, device_name="Host A", enable_mdns=False)
    identity_file = tmp_path / IDENTITY_FILE
    assert identity_file.exists()
    assert stat.S_IMODE(identity_file.stat().st_mode) == 0o600
    payload = json.loads(identity_file.read_text("utf-8"))
    assert payload["device_id"] == first.identity_info["device_id"]
    assert len(base64.b64decode(payload["private_key"])) == 32
    assert len(base64.b64decode(payload["public_key"])) == 32

    second = SyncService(store_dir=tmp_path, device_name="Host B", enable_mdns=False)
    assert second.identity_info["device_id"] == first.identity_info["device_id"]
    assert second.identity_info["public_key"] == first.identity_info["public_key"]

    # 损坏身份文件：明确报错（不静默重建身份）
    identity_file.write_text("{not json", encoding="utf-8")
    with pytest.raises(IdentityStoreError):
        SyncService(store_dir=tmp_path, device_name="Host C", enable_mdns=False)


def test_device_name_sanitized_for_mdns(tmp_path):
    """展示名清洗：mDNS 非法字符（空格/typographic 撇号）替换为 '-'。"""
    service = SyncService(store_dir=tmp_path, device_name="张超’s MacBook Pro", enable_mdns=False)
    assert service.status["device_name"] == "张超-s-MacBook-Pro"
    default = SyncService(store_dir=tmp_path / "default", enable_mdns=False)
    assert default.status["device_name"]  # 缺省取 hostname（清洗后非空）


def test_start_stop_idempotent(tmp_path):
    """启动/停止幂等：重复 start 同端口，重复 stop 不报错。"""

    async def scenario() -> None:
        service = SyncService(
            store_dir=tmp_path, device_name="Host", host=HOST, port=0, enable_mdns=False
        )
        assert service.status["running"] is False
        assert service.status["port"] == 0
        await service.start()
        port = service.status["port"]
        await service.start()
        assert service.status["port"] == port
        await service.stop()
        assert service.status["running"] is False
        await service.stop()
        await service.start()
        assert service.status["port"] > 0  # 重启换端口（port=0 重新分配）
        await service.stop()

    _run(scenario())


def test_empty_service_state(tmp_path):
    """空状态：无设备、无待批准、无事件、游标 0。"""
    service = SyncService(store_dir=tmp_path, device_name="Host", host=HOST, enable_mdns=False)
    assert service.devices() == []
    assert service.pending_pairs == []
    assert service.events_since(0) == (0, [])
    assert service.approve_pair("missing") is False
    assert service.reject_pair("missing") is False
    assert service.cancel_pair("missing") is False
    assert service.remove_device("NOPE") is False
    assert service.stop_pairing() is None
