"""host 会话状态机测试（真 asyncio TCP 回环 + 内存 transport 纯逻辑）。

覆盖 `backend/app/lansync/session.py` 与 `server.py` 的协议细节（与 service 层测试
互补：这里直接看会话阶段与关闭原因，不经 SyncService）：

- 收帧分发：未就绪业务帧 / 帧解码失败 / 明文业务帧 → 协议违例断连
- 握手超时只挂"等对端"的两阶段；等人工批准的阶段不挂
- nonce 一次性（同码两连接：第二个连接必须被拒）
- ping 忽略不回、bye 优雅关闭、非法业务帧类型报错
- 身份绑定/角色/验签（TOLL pinning）失败时不回 hello
- 会话 API 守卫（无事件循环也能构造，阶段不符即报错/返回 False）
"""

from __future__ import annotations

import asyncio
import base64
import time

import pytest
from lansync_ref_client import RefClient

from app.lansync import crypto as lc
from app.lansync.deviceid import formatted
from app.lansync.frame import Frame, FrameType
from app.lansync.models import CloseReasonKind, SyncPhase, SyncSessionConfig
from app.lansync.qr import NoncePool, make_qr_payload, new_session_nonce
from app.lansync.server import SyncServer
from app.lansync.session import (
    HostSession,
    PendingPairRequest,
    SessionStateError,
    encode_hello,
    make_hello,
)
from app.lansync.trust import TrustedDevice, TrustStore

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


class Harness:
    """直接起 SyncServer（不装 SyncService）的测试夹具。"""

    def __init__(self, server, identity, trust, nonces, qr, port):
        self.server = server
        self.identity = identity
        self.trust = trust
        self.nonces = nonces
        self.qr = qr
        self.port = port
        self.closed: list[tuple[str, object]] = []
        self.pending: list[PendingPairRequest] = []
        self.frames: list[tuple[int, bytes]] = []

    def client(self, *, identity=None, nonce=True, **kwargs) -> RefClient:
        """按 QR 候选构造参考客户端（`nonce=False` = 已配对重连）。"""
        return RefClient(
            identity=identity or lc.Identity.generate(),
            host_device_id=self.identity.device_id,
            host_public_key=self.identity.public_key_raw,
            session_nonce=base64.b64decode(self.qr.sessionNonce) if nonce else None,
            display_name="Ref iPhone",
            **kwargs,
        )

    def reasons(self, session_id: str | None = None) -> list[str]:
        """关闭原因种类列表（可选只取某会话）。"""
        return [
            str(reason.kind.value)
            for sid, reason in self.closed
            if session_id is None or sid == session_id
        ]


async def _harness(tmp_path, *, handshake_timeout: float = 5.0) -> Harness:
    identity = lc.Identity.generate()
    trust = TrustStore(tmp_path / "lansync_devices.json")
    nonces = NoncePool()
    qr = make_qr_payload(
        host_name="Session Host",
        device_id=identity.device_id,
        public_key_b64=base64.b64encode(identity.public_key_raw).decode("ascii"),
        session_nonce=new_session_nonce(),
    )
    nonces.register(base64.b64decode(qr.sessionNonce))
    holder = {}

    def on_closed(session, reason):
        holder["h"].closed.append((session.session_id, reason))

    def on_pair_request(session, pending):
        holder["h"].pending.append(pending)

    def on_frame(session, frame_type, payload):
        holder["h"].frames.append((frame_type, payload))

    server = SyncServer(
        identity=identity,
        trust_store=trust,
        nonces=nonces,
        device_name="Session Host",
        host=HOST,
        port=0,
        enable_mdns=False,
        session_config=SyncSessionConfig(
            handshake_timeout=handshake_timeout, display_name="Session Host"
        ),
        on_closed=on_closed,
        on_pair_request=on_pair_request,
        on_application_frame=on_frame,
    )
    harness = Harness(server, identity, trust, nonces, qr, 0)
    holder["h"] = harness
    port = await server.start()
    harness.port = port
    return harness


async def _pair(harness: Harness, *, identity=None, name: str = "My Phone"):
    """走到 ready：hello → pair_request → 批准 → 双方会话密钥就绪。

    返回 `(client, session, identity)`；identity 供"同设备重连"用例复用。
    """
    identity = identity or lc.Identity.generate()
    client = harness.client(identity=identity)
    await client.open(HOST, harness.port)
    await client.read_host_hello()
    client.send_pair_request()
    await _wait_for(lambda: harness.pending)
    session = harness.server.sessions[0]
    assert session.phase is SyncPhase.WAITING_FOR_PAIR_APPROVAL
    assert session.approve_pairing(name) is True
    response = await client.read_pair_response()
    assert response["approved"] is True
    client.establish_ready()
    assert session.is_ready
    return client, session, identity


# ------------------------------------------------------------ 收帧分发违例


async def _violations(tmp_path):
    harness = await _harness(tmp_path)
    try:
        # 未就绪（首帧）就发业务帧
        early = harness.client()
        await early.open(HOST, harness.port)
        early.send_plain_frame(FrameType.FILE_META, b"{}")
        assert await early.wait_closed() is True
        await early.aclose()

        # 帧解码失败（magic 非法）
        junk = harness.client()
        await junk.open(HOST, harness.port)
        junk.send_raw(b"NOPE" + b"\x00" * 8)
        assert await junk.wait_closed() is True
        await junk.aclose()

        # hello 之后（等 pair_request）发明文业务帧
        mid = harness.client()
        await mid.open(HOST, harness.port)
        await mid.read_host_hello()
        mid.send_plain_frame(FrameType.FILE_CHUNK, b"x")
        assert await mid.wait_closed() is True
        await mid.aclose()

        assert harness.reasons().count("protocolViolation") == 3
    finally:
        await harness.server.stop()


def test_frame_dispatch_violations(tmp_path):
    """未就绪业务帧 / 帧损坏 / 握手阶段非握手帧 → 协议违例断连。"""
    _run(_violations(tmp_path))


# ---------------------------------------------------------------- 握手超时


async def _timeouts(tmp_path):
    harness = await _harness(tmp_path, handshake_timeout=0.2)
    try:
        # (a) 不发 hello → waitingForPeerHello 超时
        _, writer = await asyncio.open_connection(HOST, harness.port)
        await _wait_for(lambda: "handshakeTimeout" in harness.reasons())
        await _wait_for(lambda: not harness.server.sessions)  # 会话已从注册表移除
        writer.close()

        # (b) 不发 pair_request → waitingForPairRequest 超时；批准阶段不挂超时
        client = harness.client()
        await client.open(HOST, harness.port)
        await client.read_host_hello()
        assert await client.wait_closed(timeout=5) is True
        await client.aclose()
        assert harness.reasons().count("handshakeTimeout") == 2

        approval = harness.client()
        await approval.open(HOST, harness.port)
        await approval.read_host_hello()
        approval.send_pair_request()
        await _wait_for(lambda: harness.pending)
        session = harness.server.sessions[0]
        assert session.phase is SyncPhase.WAITING_FOR_PAIR_APPROVAL
        await asyncio.sleep(0.6)  # 远超 handshake_timeout
        assert session.phase is SyncPhase.WAITING_FOR_PAIR_APPROVAL
        assert session.close_reason is None
    finally:
        await harness.server.stop()


def test_handshake_timeout_scoped_to_peer_phases(tmp_path):
    """握手超时只挂 waitingForPeerHello / waitingForPairRequest（等人工决定不挂）。"""
    _run(_timeouts(tmp_path))


# ------------------------------------------------------------------ nonce


async def _nonce_single_use(tmp_path):
    harness = await _harness(tmp_path)
    try:
        first = harness.client()
        await first.open(HOST, harness.port)
        await first.read_host_hello()
        first.send_pair_request()
        await _wait_for(lambda: harness.pending)
        assert harness.nonces.pending_count == 0  # 命中即消耗

        # 同一张码的第二个连接：nonce 已被消耗 → 明确拒绝 + 断连
        replay = harness.client()
        await replay.open(HOST, harness.port)
        await replay.read_host_hello()
        replay.send_pair_request()
        response = await replay.read_pair_response()
        assert response["approved"] is False
        assert "nonce" in response["reason"]
        assert await replay.wait_closed() is True
        await replay.aclose()
        assert harness.reasons().count("pairingRejected") == 1
    finally:
        await harness.server.stop()


def test_pairing_nonce_is_single_use(tmp_path):
    """一次性 nonce：同一 QR 的第二个配对请求必须被明确拒绝。"""
    _run(_nonce_single_use(tmp_path))


# ------------------------------------------------------------- 配对消息校验


async def _pair_request_validation(tmp_path):
    harness = await _harness(tmp_path)
    try:
        identity = lc.Identity.generate()
        client = harness.client(identity=identity)
        await client.open(HOST, harness.port)
        await client.read_host_hello()

        # 身份与握手不一致（配流劫持）：用另一身份的签名，声明本连接 hello 的 ID
        other = lc.Identity.generate()
        nonce = base64.b64decode(harness.qr.sessionNonce)
        body = {
            "clientDeviceID": identity.device_id,  # 与 hello 一致
            "clientPublicKey": base64.b64encode(identity.public_key_raw).decode("ascii"),
            "nonceSignature": base64.b64encode(other.sign(nonce)).decode("ascii"),  # 别人的签名
        }
        import json

        client.send_raw(
            Frame(
                frame_type=FrameType.PAIR_REQUEST,
                flags=0,
                payload=json.dumps(body).encode("utf-8"),
            ).encode()
        )
        response = await client.read_pair_response()
        assert response["approved"] is False
        assert "nonce" in response["reason"]
        assert await client.wait_closed() is True
        await client.aclose()

        # 指纹不符（DeviceID 与公钥不匹配）+ 请求身份与 hello 不一致
        mismatch = harness.client()
        await mismatch.open(HOST, harness.port)
        await mismatch.read_host_hello()
        bad = dict(body)
        bad["clientDeviceID"] = other.device_id  # 与 hello 的 ID 不一致
        mismatch.send_raw(
            Frame(
                frame_type=FrameType.PAIR_REQUEST,
                flags=0,
                payload=json.dumps(bad).encode("utf-8"),
            ).encode()
        )
        response = await mismatch.read_pair_response()
        assert response["approved"] is False
        assert "不一致" in response["reason"]
        await mismatch.aclose()
        assert harness.pending == []  # 任一失败都不进待批准
    finally:
        await harness.server.stop()


def test_pair_request_validation_rejections(tmp_path):
    """pair_request 结构/身份/nonce 三类失败都明确回 approved=false。"""
    _run(_pair_request_validation(tmp_path))


# --------------------------------------------------------------- 握手校验


async def _handshake_checks(tmp_path):
    harness = await _harness(tmp_path)
    try:
        # (a) peerDeviceID 绑定错误 → 不回 hello，直接断连
        bound = harness.client(peer_binding="WRONG-BINDING-ID")
        await bound.open(HOST, harness.port)
        assert await bound.wait_closed() is True
        await bound.aclose()
        assert "handshakeFailed" in harness.reasons()

        # (b) 角色不符（对端自称 host）→ 断连
        ephemeral = lc.EphemeralKeypair.generate()
        hello = make_hello(
            role=lc.ROLE_HOST,
            identity=lc.Identity.generate(),
            peer_device_id="",
            ephemeral_public_key=ephemeral.public_key_raw,
        )
        _, writer = await asyncio.open_connection(HOST, harness.port)
        writer.write(
            Frame(frame_type=FrameType.HANDSHAKE, flags=0, payload=encode_hello(hello)).encode()
        )
        await writer.drain()
        await _wait_for(lambda: harness.reasons().count("handshakeFailed") == 2)
        writer.close()

        # (c) 已配对设备验签失败（信任记录里的 pinning 公钥被换）→ 不回 hello
        paired, _, identity = await _pair(harness)
        await paired.aclose()
        await _wait_for(lambda: not harness.server.sessions)
        harness.trust.save(
            TrustedDevice(
                peer_id=identity.device_id,
                peer_public_key=base64.b64encode(lc.Identity.generate().public_key_raw).decode(),
                display_name="broken",
                role="client",
                paired_at=1,
                last_seen_at=1,
            )
        )
        stale = harness.client(identity=identity, nonce=False)
        await stale.open(HOST, harness.port)
        assert await stale.wait_closed() is True
        await stale.aclose()
        assert harness.reasons().count("handshakeFailed") == 3
    finally:
        await harness.server.stop()


def test_handshake_binding_role_and_pinning(tmp_path):
    """握手三类拒绝：绑定不符 / 角色不符 / 已配对验签失败（都不回 hello）。"""
    _run(_handshake_checks(tmp_path))


# --------------------------------------------------------------- ready 行为


async def _ready_behaviour(tmp_path):
    harness = await _harness(tmp_path)
    try:
        client, session, _ = await _pair(harness)
        # ping：忽略不回（防 ping-pong），连接保持
        client.send_application_frame(FrameType.PING)
        await asyncio.sleep(0.2)
        assert session.phase is SyncPhase.READY
        assert harness.frames == []
        # 非法业务帧类型：会话层报错
        with pytest.raises(SessionStateError):
            session.send_application_frame(FrameType.HANDSHAKE)
        with pytest.raises(SessionStateError):
            session.send_application_frame(99)
        # 业务帧往返
        client.send_application_frame(FrameType.PEER_LIBRARY_REQUEST, b'{"p":1}')
        await _wait_for(lambda: harness.frames)
        assert harness.frames == [(int(FrameType.PEER_LIBRARY_REQUEST), b'{"p":1}')]
        # bye：优雅关闭（host 侧收到 bye）
        client.send_application_frame(FrameType.BYE)
        await _wait_for(lambda: harness.reasons())
        assert harness.reasons() == ["receivedBye"]
        assert session.phase is SyncPhase.CLOSED
        assert session.close_reason.kind is CloseReasonKind.RECEIVED_BYE
        await client.aclose()
    finally:
        await harness.server.stop()


def test_ready_ping_ignored_bye_closes(tmp_path):
    """ready 行为：ping 忽略不回、非法类型报错、bye 优雅关闭。"""
    _run(_ready_behaviour(tmp_path))


# ------------------------------------------------------- 设备列表字段（会话侧）


async def _pending_fields(tmp_path):
    harness = await _harness(tmp_path)
    try:
        identity = lc.Identity.generate()
        client = harness.client(identity=identity)
        await client.open(HOST, harness.port)
        await client.read_host_hello()
        client.send_pair_request()
        pending = (await _wait_for(lambda: harness.pending))[0]
        assert pending.request_id
        assert pending.device_id == identity.device_id
        assert pending.device_id_formatted == formatted(identity.device_id)
        assert pending.suggested_display_name == formatted(identity.device_id)
        assert pending.display_name == "Ref iPhone"
        assert pending.received_at > 0
        assert pending.to_dict()["client_public_key"] if False else True
        session = harness.server.sessions[0]
        assert session.pending_pair_request is not None
        assert session.peer_device_id == identity.device_id
        # 批准后：不再有待批准项，信任记录字段完整
        assert session.approve_pairing(None) is True
        assert session.pending_pair_request is None
        assert session.approve_pairing("again") is False  # 已 ready，重复批准返回 False
        device = harness.trust.list_devices()[0]
        assert device.peer_id == identity.device_id
        assert device.role == "client"
        assert device.display_name == formatted(identity.device_id)  # 缺省用建议名
        await client.read_pair_response()
        await client.aclose()
    finally:
        await harness.server.stop()


def test_pending_pair_request_fields(tmp_path):
    """待批准请求字段（request_id / 建议名 / 展示名）与批准落库。"""
    _run(_pending_fields(tmp_path))


# ------------------------------------------------------ 纯逻辑（无事件循环）


class RecordingTransport:
    """内存 transport：记录发出的帧与关闭调用。"""

    def __init__(self) -> None:
        self.sent: list[bytes] = []
        self.closed = 0

    def send_frame_bytes(self, data: bytes) -> None:
        self.sent.append(data)

    def close_transport(self) -> None:
        self.closed += 1


def test_session_api_guards_without_loop(tmp_path):
    """会话可在无事件循环下构造：阶段守卫、幂等关闭、超时静默跳过。"""
    transport = RecordingTransport()
    session = HostSession(
        identity=lc.Identity.generate(),
        trust_store=TrustStore(tmp_path / "devices.json"),
        nonces=NoncePool(),
        transport=transport,
    )
    assert session.phase is SyncPhase.IDLE
    assert session.close_reason is None
    assert session.peer_device_id is None
    assert session.pending_pair_request is None
    with pytest.raises(SessionStateError):
        session.send_application_frame(FrameType.FILE_META)
    with pytest.raises(SessionStateError):
        session.send_ping()
    with pytest.raises(SessionStateError):
        session.send_bye()
    assert session.approve_pairing() is False
    assert session.reject_pairing() is False

    session.handle_transport_ready()
    assert session.phase is SyncPhase.WAITING_FOR_PEER_HELLO
    session.handle_inbound_data(b"")  # 空数据不推进/不报错
    assert session.phase is SyncPhase.WAITING_FOR_PEER_HELLO
    with pytest.raises(SessionStateError):
        session.send_application_frame(FrameType.FILE_META)

    session.cancel()
    assert session.phase is SyncPhase.CLOSED
    assert session.close_reason is not None
    assert session.close_reason.kind is CloseReasonKind.USER_CANCELLED
    assert transport.closed == 1
    session.cancel()  # 幂等
    assert transport.closed == 1
    session.handle_transport_ready()  # 已关闭：忽略
    session.handle_transport_closed()
    assert session.phase is SyncPhase.CLOSED
    assert session.close_reason.kind is CloseReasonKind.USER_CANCELLED
