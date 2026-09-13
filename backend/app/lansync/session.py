"""局域网同步（S2）单连接会话状态机（host 角色）。

对位 Swift `QQPlayer/Sync/SyncPeerSession.swift` + `SyncPeerSession+Frames.swift`
（线协议契约 `docs/lan-sync-protocol.md` §2/§3/§5/§6）。本模块只管**一条连接**的
状态迁移与帧分发；监听/发现/持久化在 `server.py` / `service.py`。

状态机（host 侧）：

    idle → waitingForPeerHello ─（已配对：pinning 验签通过）→ ready
                              └（未配对）→ waitingForPairRequest
                                 → waitingForPairApproval →（用户批准）→ ready
    任意阶段 → closed(reason)

收帧分发（协议 §5）：

- 握手阶段（waitingForPeerHello）只接受**明文** `handshake`（type 0）；
  waitingForPairRequest 只接受明文 `pair_request`（type 1）；
  ready 后业务帧**必须加密**，解密后按类型转交回调。
- 未就绪收到业务帧 / 加密位不符 / 帧解码失败 → 协议违例断连（明确失败，不静默）。
- ready 后收到握手/配对帧 → 协议违例；`ping` 忽略不回（v1 无心跳，防 ping-pong）；
  `bye` 优雅关闭。
- 超时只挂在 `waitingForPeerHello` / `waitingForPairRequest`（协议 §2 第 4 条）；
  等人工决定的 `waitingForPairApproval` 不挂超时。

解耦：一切外部交互经构造注入——`transport`（帧字节通道）与四个回调（状态变化 /
关闭 / 待批准 / 业务帧）。本模块**零 Web 框架依赖**，纯 asyncio 或测试内存回环均可跑。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import contextlib
import json
import logging
import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Protocol

from .crypto import (
    AEAD_OVERHEAD,
    ROLE_CLIENT,
    ROLE_HOST,
    AuthenticationError,
    CryptoError,
    EphemeralKeypair,
    Identity,
    NonceMismatchError,
    SessionCipher,
    derive_session_keys,
    sign_hello,
    verify_hello,
    verify_signature,
)
from .deviceid import fingerprint_matches, formatted, is_valid
from .frame import FLAG_ENCRYPTED, Frame, FrameError, FrameStreamDecoder, FrameType, build_header
from .models import CloseReason, CloseReasonKind, SyncPhase, SyncSessionConfig
from .qr import NoncePool
from .trust import TrustedDevice, TrustStoreError

logger = logging.getLogger(__name__)

#: 业务帧类型白名单（ready 后可收发；**新增业务帧必须同时登记此处**，否则发送报错）
APPLICATION_FRAME_TYPES: frozenset[int] = frozenset(
    {
        FrameType.FILE_META,
        FrameType.FILE_CHUNK,
        FrameType.FILE_ACK,
        FrameType.CHANGE_LOG_PULL,
        FrameType.CHANGE_LOG_PUSH,
        FrameType.MANIFEST_REQUEST,
        FrameType.MANIFEST_RESPONSE,
        FrameType.SYNC_FETCH_REQUEST,
        FrameType.SYNC_FETCH_RESULT,
        FrameType.LIBRARY_PUSH_ANNOUNCE,
        FrameType.PEER_LIBRARY_REQUEST,
        FrameType.PEER_LIBRARY_RESPONSE,
    }
)
#: 握手/配对帧（恒明文；ready 后收到即协议违例）
NEGOTIATION_FRAME_TYPES: frozenset[int] = frozenset(
    {FrameType.HANDSHAKE, FrameType.PAIR_REQUEST, FrameType.PAIR_RESPONSE}
)
#: 需要握手超时兜底的阶段（等人工决定的阶段**不含**，协议 §2 第 4 条）
DEADLINE_PHASES: frozenset[SyncPhase] = frozenset(
    {SyncPhase.WAITING_FOR_PEER_HELLO, SyncPhase.WAITING_FOR_PAIR_REQUEST}
)

#: 公钥/签名长度（Ed25519）
PUBLIC_KEY_BYTE_COUNT = 32
SIGNATURE_BYTE_COUNT = 64


class SessionError(Exception):
    """会话层错误基类。"""


class SessionStateError(SessionError):
    """当前阶段不允许该操作（或参数非法）。"""


class HelloDecodeError(SessionError):
    """hello 载荷不可解析 / 字段非法。"""


class PairRequestError(SessionError):
    """pair_request 结构校验失败。"""


def _decode_b64(value: object, *, expected: int | None = None) -> bytes | None:
    """standard base64 → bytes；非字符串 / 非法 base64 / 长度不符一律 None。"""
    if not isinstance(value, str) or not value:
        return None
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None
    if expected is not None and len(raw) != expected:
        return None
    return raw


def _encode_b64(raw: bytes) -> str:
    """bytes → standard base64（与 Swift `Data.base64EncodedString()` 一致）。"""
    return base64.b64encode(raw).decode("ascii")


class SessionTransport(Protocol):
    """帧字节通道（生产 = asyncio StreamWriter 适配；测试 = 内存回环）。

    两个方法都可在任意协程 / 回调里调用，且必须**幂等**与**不阻塞**
    （`close_transport` 可重复调用；`send_frame_bytes` 在已关闭后静默丢弃）。
    """

    def send_frame_bytes(self, data: bytes) -> None:
        """发送一帧完整线上字节（10B 头 + payload）。"""
        ...

    def close_transport(self) -> None:
        """关闭底层通道（幂等）。"""
        ...


@dataclass(frozen=True, slots=True)
class SyncHello:
    """握手 hello（type 0 明文帧的 JSON 载荷；字段名与 Swift `SyncHello` 逐字一致）。"""

    role: str
    deviceID: str
    peerDeviceID: str
    ephemeralPublicKey: str
    signature: str
    name: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（键序 = Swift 声明顺序；`name` 为空时不落键，对齐 Swift 编码）。"""
        payload: dict[str, Any] = {
            "role": self.role,
            "deviceID": self.deviceID,
            "peerDeviceID": self.peerDeviceID,
            "ephemeralPublicKey": self.ephemeralPublicKey,
            "signature": self.signature,
        }
        if self.name is not None:
            payload["name"] = self.name
        return payload

    @property
    def ephemeral_public_key_raw(self) -> bytes | None:
        """ephemeral 公钥 raw 32B；非法 base64 / 长度不符 → None。"""
        return _decode_b64(self.ephemeralPublicKey, expected=PUBLIC_KEY_BYTE_COUNT)


def encode_hello(hello: SyncHello) -> bytes:
    """hello → 帧 payload（紧凑 JSON、UTF-8、不转义非 ASCII）。"""
    return json.dumps(hello.to_dict(), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def decode_hello(payload: bytes) -> SyncHello:
    """帧 payload → hello；坏 JSON / 非对象 / 字段缺失或类型不符 → `HelloDecodeError`。

    额外键忽略（前向兼容：新版 Swift 加字段不破坏本端解析）；`name` 可缺失。
    """
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise HelloDecodeError(f"hello 不是合法 JSON：{error}") from error
    if not isinstance(raw, dict):
        raise HelloDecodeError("hello 不是 JSON 对象")
    values: dict[str, Any] = {}
    for key in ("role", "deviceID", "peerDeviceID", "ephemeralPublicKey", "signature"):
        value = raw.get(key)
        if not isinstance(value, str):
            raise HelloDecodeError(f"hello 字段缺失或类型不符：{key}")
        values[key] = value
    name = raw.get("name")
    if name is not None and not isinstance(name, str):
        raise HelloDecodeError("hello 字段类型不符：name")
    return SyncHello(**values, name=name)


def make_hello(
    *,
    role: str,
    identity: Identity,
    peer_device_id: str,
    ephemeral_public_key: bytes,
    name: str | None = None,
) -> SyncHello:
    """组装本方 hello（签名输入 = ephemeralPub ‖ peerDeviceID(utf8) ‖ role(utf8)）。"""
    signature = sign_hello(identity, ephemeral_public_key, peer_device_id, role)
    return SyncHello(
        role=role,
        deviceID=identity.device_id,
        peerDeviceID=peer_device_id,
        ephemeralPublicKey=_encode_b64(ephemeral_public_key),
        signature=_encode_b64(signature),
        name=name,
    )


@dataclass(frozen=True, slots=True)
class PairRequest:
    """配对请求（type 1 明文帧的 JSON 载荷；字段名同 Swift `PairRequest`）。"""

    client_device_id: str
    client_public_key: str
    nonce_signature: str
    client_name: str | None = None

    @classmethod
    def from_payload(cls, payload: bytes) -> PairRequest:
        """帧 payload → 请求（**含结构校验**，协议 §3.3 步骤 1）。

        校验：deviceID 合法；clientPublicKey = 32B base64 且 == SHA256 指纹；
        nonceSignature = 64B base64。任一失败 → `PairRequestError`。
        """
        try:
            raw = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as error:
            raise PairRequestError(f"pair_request 不是合法 JSON：{error}") from error
        if not isinstance(raw, dict):
            raise PairRequestError("pair_request 不是 JSON 对象")
        device_id = raw.get("clientDeviceID")
        public_key = raw.get("clientPublicKey")
        signature = raw.get("nonceSignature")
        client_name = raw.get("clientName")
        if not isinstance(device_id, str) or not is_valid(device_id):
            raise PairRequestError("clientDeviceID 非法")
        public_key_raw = _decode_b64(public_key, expected=PUBLIC_KEY_BYTE_COUNT)
        if public_key_raw is None:
            raise PairRequestError("clientPublicKey 不是 32B base64 公钥")
        if not fingerprint_matches(device_id, public_key_raw):
            raise PairRequestError("clientDeviceID 与公钥指纹不一致")
        if _decode_b64(signature, expected=SIGNATURE_BYTE_COUNT) is None:
            raise PairRequestError("nonceSignature 不是 64B base64 签名")
        if client_name is not None and not isinstance(client_name, str):
            raise PairRequestError("clientName 类型不符")
        return cls(device_id, public_key, signature, client_name)

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（键序 = Swift 声明顺序；`clientName` 为空时不落键）。"""
        payload: dict[str, Any] = {
            "clientDeviceID": self.client_device_id,
            "clientPublicKey": self.client_public_key,
            "nonceSignature": self.nonce_signature,
        }
        if self.client_name is not None:
            payload["clientName"] = self.client_name
        return payload

    @property
    def public_key_raw(self) -> bytes:
        """client 公钥 raw 32B（`from_payload` 已校验，解码不会失败）。"""
        raw = _decode_b64(self.client_public_key, expected=PUBLIC_KEY_BYTE_COUNT)
        if raw is None:  # pragma: no cover - 构造函数已校验
            raise PairRequestError("clientPublicKey 非法")
        return raw


@dataclass(frozen=True, slots=True)
class PendingPairRequest:
    """待批准的配对请求（`on_pair_request` 回调载荷，service 层转 UI 批准卡）。"""

    request_id: str
    device_id: str
    device_id_formatted: str
    client_public_key: str
    display_name: str | None
    suggested_display_name: str
    received_at: float

    def to_dict(self) -> dict[str, Any]:
        """UI 字典（键名对齐 plan §3 `pending_pairs` 元素）。"""
        return {
            "request_id": self.request_id,
            "device_id": self.device_id,
            "device_id_formatted": self.device_id_formatted,
            "display_name": self.display_name,
            "suggested_display_name": self.suggested_display_name,
            "received_at": self.received_at,
        }


class HostSession:
    """host 角色单连接会话（同步 API：内部无 await 点，由调用方在其事件循环里驱动）。

    调用时序（server 层）：

    1. 连接就绪 → `handle_transport_ready()`
    2. 收到字节 → `handle_inbound_data(data)`（任意分块，内部拼帧）
    3. 连接断开 → `handle_transport_closed()`（EOF/错误；幂等）
    4. 业务侧 → `approve_pairing()` / `reject_pairing()` / `send_application_frame()` / `cancel()`

    所有回调（`on_state_change` / `on_closed` / `on_pair_request` / `on_application_frame`）
    都是**同步**可调用对象；回调内抛异常只记日志，不影响状态机推进。
    """

    #: 本端角色（线上字符串）
    role: str = ROLE_HOST

    def __init__(
        self,
        *,
        identity: Identity,
        trust_store: Any,
        nonces: NoncePool | None = None,
        transport: SessionTransport | None = None,
        config: SyncSessionConfig | None = None,
        on_state_change: Callable[[HostSession, SyncPhase], None] | None = None,
        on_closed: Callable[[HostSession, CloseReason], None] | None = None,
        on_pair_request: Callable[[HostSession, PendingPairRequest], None] | None = None,
        on_application_frame: Callable[[HostSession, int, bytes], None] | None = None,
        session_id: str | None = None,
    ) -> None:
        self.session_id = session_id or uuid.uuid4().hex
        self.identity = identity
        self._trust_store = trust_store
        self._nonces = nonces
        self._transport = transport
        self._config = config or SyncSessionConfig()
        self._on_state_change = on_state_change
        self._on_closed = on_closed
        self._on_pair_request = on_pair_request
        self._on_application_frame = on_application_frame

        self._phase = SyncPhase.IDLE
        self._close_reason: CloseReason | None = None
        self._decoder = FrameStreamDecoder()
        self._my_ephemeral: EphemeralKeypair | None = None
        self._peer_hello: SyncHello | None = None
        self._peer_device_id: str | None = None
        self._pending_pair: PendingPairRequest | None = None
        self._cipher: SessionCipher | None = None
        self._deadline: asyncio.TimerHandle | None = None

    # ---------------------------------------------------------------- 查询

    @property
    def phase(self) -> SyncPhase:
        """当前阶段（公开状态机视图）。"""
        return self._phase

    @property
    def close_reason(self) -> CloseReason | None:
        """关闭原因（未关闭为 None）。"""
        return self._close_reason

    @property
    def is_ready(self) -> bool:
        """会话是否已就绪（可收发业务帧）。"""
        return self._phase is SyncPhase.READY

    @property
    def peer_device_id(self) -> str | None:
        """对端 Device ID（收到 client hello 后可知，之前为 None）。"""
        return self._peer_device_id

    @property
    def pending_pair_request(self) -> PendingPairRequest | None:
        """待批准配对请求（仅 `waitingForPairApproval` 阶段非 None）。"""
        if self._phase is SyncPhase.WAITING_FOR_PAIR_APPROVAL:
            return self._pending_pair
        return None

    # ------------------------------------------------------------ 传输入口

    def handle_transport_ready(self) -> None:
        """连接就绪：host 进入等 hello（幂等：非 idle 阶段忽略）。"""
        if self._phase is not SyncPhase.IDLE:
            return
        self._phase = SyncPhase.WAITING_FOR_PEER_HELLO
        self._notify_state()
        self._ensure_deadline()

    def handle_inbound_data(self, data: bytes) -> None:
        """收到原始字节（任意分块；内部拼帧后按阶段分发）。"""
        if self._phase in (SyncPhase.IDLE, SyncPhase.CLOSED):
            return
        try:
            frames = self._decoder.feed(data)
        except FrameError as error:
            self._close(_protocol_violation(f"帧解码失败：{error}"))
            return
        for frame in frames:
            if self._phase is SyncPhase.CLOSED:
                break
            self._process_frame(frame)
        self._ensure_deadline()

    def handle_transport_closed(self) -> None:
        """通道断开（EOF/失败/取消）：未关闭则按对端异常断开处理（幂等）。"""
        if self._phase is not SyncPhase.CLOSED:
            self._close(CloseReason(CloseReasonKind.REMOTE_CLOSED))

    def cancel(self, reason: CloseReason | None = None) -> None:
        """本端主动关闭（幂等）。"""
        self._close(reason or CloseReason(CloseReasonKind.USER_CANCELLED))

    # ---------------------------------------------------------- ready 发送

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发送业务帧（加密）；未 ready / 类型不在白名单 → `SessionStateError`。"""
        if self._phase is not SyncPhase.READY:
            raise SessionStateError(f"会话未就绪（当前阶段 {self._phase.value}）")
        if frame_type not in APPLICATION_FRAME_TYPES:
            raise SessionStateError(f"非法业务帧类型：{frame_type}")
        self._send(frame_type, payload, encrypted=True)

    def send_ping(self) -> None:
        """发送 ping（v1 无心跳语义，仅协议占位）；未 ready → `SessionStateError`。"""
        if self._phase is not SyncPhase.READY:
            raise SessionStateError(f"会话未就绪（当前阶段 {self._phase.value}）")
        self._send(FrameType.PING, b"", encrypted=True)

    def send_bye(self) -> None:
        """发送 bye 并优雅关闭（`bye` 送达后才断连）。"""
        if self._phase is not SyncPhase.READY:
            raise SessionStateError(f"会话未就绪（当前阶段 {self._phase.value}）")
        self._send(FrameType.BYE, b"", encrypted=True)
        self.cancel()

    # ------------------------------------------------------------ 配对决定

    def approve_pairing(self, display_name: str | None = None) -> bool:
        """批准待批准配对：落信任记录 → 回 approved → 派生密钥进 ready。

        阶段不符 / 无待批准请求 → False。信任表写入失败 → 回 approved=false 并
        以 `storageError` 关闭（协议 §3.3：明确失败，不静默）。
        """
        pending = self.pending_pair_request
        if pending is None or self._peer_hello is None:
            return False
        name = (display_name or "").strip() or pending.suggested_display_name
        stamp = int(time.time())
        device = TrustedDevice(
            peer_id=pending.device_id,
            peer_public_key=pending.client_public_key,
            display_name=name,
            role=ROLE_CLIENT,
            paired_at=stamp,
            last_seen_at=stamp,
            notes=None,
        )
        try:
            self._trust_store.save(device)
        except TrustStoreError as error:
            self._send_pair_response(False, "信任表写入失败")
            self._close(CloseReason(CloseReasonKind.STORAGE_ERROR, str(error)))
            return False
        self._send_pair_response(True, None)
        self._apply_ready_transition()
        return True

    def reject_pairing(self, reason: str | None = None) -> bool:
        """拒绝待批准配对：回 approved=false + reason 后断连。"""
        if self.pending_pair_request is None:
            return False
        self._send_pair_response(False, reason)
        self._close(CloseReason(CloseReasonKind.PAIRING_REJECTED, reason))
        return True

    # -------------------------------------------------------- 收帧分发表

    def _process_frame(self, frame: Frame) -> None:
        """按阶段路由一帧（协议 §5）。"""
        phase = self._phase
        if phase in (SyncPhase.IDLE, SyncPhase.CLOSED):
            self._close(_protocol_violation("阶段外收到帧"))
        elif phase is SyncPhase.WAITING_FOR_PEER_HELLO:
            if frame.encrypted or frame.frame_type != FrameType.HANDSHAKE:
                self._close(_protocol_violation("握手阶段收到非明文 handshake 帧"))
                return
            self._process_client_hello(frame.payload)
        elif phase is SyncPhase.WAITING_FOR_PAIR_REQUEST:
            self._process_pair_request(frame)
        elif phase is SyncPhase.WAITING_FOR_PAIR_APPROVAL:
            # 等用户决定期间忽略业务帧（bye/断开由传输层事件处理），与 Swift 一致
            return
        elif phase is SyncPhase.READY:
            self._process_ready_frame(frame)

    # ------------------------------------------------------------ host 握手

    def _process_client_hello(self, payload: bytes) -> None:
        """client hello → 校验 + 回 hello（+ 已配对则直进 ready）。"""
        try:
            hello = decode_hello(payload)
        except HelloDecodeError as error:
            self._close(_handshake_failed(str(error)))
            return
        if hello.role != ROLE_CLIENT:
            self._close(_handshake_failed(f"首帧角色应为 client，实际 {hello.role!r}"))
            return
        if not is_valid(hello.deviceID):
            self._close(_handshake_failed("client Device ID 非法"))
            return
        # 绑定校验：client hello 的 peerDeviceID 非空时必须 == 本端 ID（允许空绑定）
        if hello.peerDeviceID and hello.peerDeviceID != self.identity.device_id:
            self._close(_handshake_failed("client hello 的身份绑定与本端不符"))
            return
        peer_ephemeral = hello.ephemeral_public_key_raw
        if peer_ephemeral is None:
            self._close(_handshake_failed("client ephemeral 公钥非法"))
            return
        signature = _decode_b64(hello.signature, expected=SIGNATURE_BYTE_COUNT)
        if signature is None:
            self._close(_handshake_failed("client hello 签名非法"))
            return
        try:
            known_public_key = self._trust_store.peer_public_key(hello.deviceID)
        except TrustStoreError as error:
            self._close(CloseReason(CloseReasonKind.STORAGE_ERROR, str(error)))
            return
        if known_public_key is not None and not verify_hello(
            known_public_key, signature, peer_ephemeral, hello.peerDeviceID, ROLE_CLIENT
        ):
            # 已配对：pinning 验签不通过 → 不回 hello（TOFU 拒绝）
            self._close(_handshake_failed("已配对设备 hello 验签失败"))
            return
        self._peer_hello = hello
        self._peer_device_id = hello.deviceID
        ephemeral = EphemeralKeypair.generate()
        self._my_ephemeral = ephemeral
        try:
            my_hello = make_hello(
                role=ROLE_HOST,
                identity=self.identity,
                peer_device_id=hello.deviceID,
                ephemeral_public_key=ephemeral.public_key_raw,
                name=self._config.display_name,
            )
        except CryptoError as error:
            self._close(_handshake_failed(str(error)))
            return
        self._send_frame(FrameType.HANDSHAKE, encode_hello(my_hello))
        if known_public_key is not None:
            self._apply_ready_transition()
        else:
            self._phase = SyncPhase.WAITING_FOR_PAIR_REQUEST
            self._notify_state()
            self._ensure_deadline()

    # ------------------------------------------------------------ 配对请求

    def _process_pair_request(self, frame: Frame) -> None:
        """pair_request → 结构校验 + 身份一致 + nonce 验签 → 待批准。"""
        if frame.encrypted or frame.frame_type != FrameType.PAIR_REQUEST:
            self._close(_protocol_violation("等待配对阶段收到非法帧"))
            return
        try:
            request = PairRequest.from_payload(frame.payload)
        except PairRequestError as error:
            self._reject_pairing(f"配对请求校验失败：{error}")
            return
        if request.client_device_id != self._peer_device_id:
            # 防配流劫持：配对请求身份必须与握手 hello 一致
            self._reject_pairing("配对请求与握手身份不一致")
            return
        signature = _decode_b64(request.nonce_signature, expected=SIGNATURE_BYTE_COUNT)
        matched = None
        if self._nonces is not None and signature is not None:
            matched = self._nonces.match(request.public_key_raw, signature, verify_signature)
        if matched is None:
            self._reject_pairing("无效或过期的 nonce 签名")
            return
        self._pending_pair = PendingPairRequest(
            request_id=uuid.uuid4().hex,
            device_id=request.client_device_id,
            device_id_formatted=formatted(request.client_device_id),
            client_public_key=request.client_public_key,
            display_name=request.client_name,
            suggested_display_name=formatted(request.client_device_id),
            received_at=time.time(),
        )
        self._phase = SyncPhase.WAITING_FOR_PAIR_APPROVAL
        self._cancel_deadline()
        self._notify_state()
        self._notify_pair_request(self._pending_pair)

    def _reject_pairing(self, reason: str) -> None:
        """配对明确失败：回 approved=false + reason 后断连（协议 §3.3 步骤 4）。"""
        self._send_pair_response(False, reason)
        self._close(CloseReason(CloseReasonKind.PAIRING_REJECTED, reason))

    # --------------------------------------------------------- ready 收帧

    def _process_ready_frame(self, frame: Frame) -> None:
        """ready 后收帧：必须加密 → 解密 → 按类型分发。"""
        if not frame.encrypted:
            self._close(_protocol_violation("ready 后业务帧必须加密"))
            return
        if self._cipher is None:
            self._close(_protocol_violation("会话密钥未就绪"))
            return
        try:
            plaintext = self._cipher.open(frame.payload, aad=frame.header)
        except (NonceMismatchError, AuthenticationError, CryptoError) as error:
            self._close(_handshake_failed(f"会话解密失败：{error}"))
            return
        frame_type = frame.frame_type
        if frame_type == FrameType.PING:
            return  # v1 无心跳：忽略不回，避免 ping-pong
        if frame_type == FrameType.BYE:
            self._close(CloseReason(CloseReasonKind.RECEIVED_BYE))
            return
        if frame_type in APPLICATION_FRAME_TYPES:
            self._notify_application_frame(int(frame_type), plaintext)
            return
        self._close(_protocol_violation("ready 阶段收到握手/配对帧"))

    # ------------------------------------------------------------ 状态迁移

    def _apply_ready_transition(self) -> None:
        """就绪迁移：由双方 ephemeral 派生方向密钥并初始化接收/发送密钥。"""
        if self._my_ephemeral is None or self._peer_hello is None:
            self._close(_protocol_violation("密钥派生前置缺失"))
            return
        peer_ephemeral = self._peer_hello.ephemeral_public_key_raw
        if peer_ephemeral is None:  # pragma: no cover - hello 校验已保证
            self._close(_handshake_failed("对端 ephemeral 公钥非法"))
            return
        try:
            keys = derive_session_keys(self._my_ephemeral.private_key_raw, peer_ephemeral)
        except CryptoError as error:
            self._close(_handshake_failed(str(error)))
            return
        self._cipher = SessionCipher(keys.for_role(ROLE_HOST))
        self._phase = SyncPhase.READY
        self._cancel_deadline()
        self._notify_state()

    def _close(self, reason: CloseReason) -> None:
        """置 closed + 通知 + 关通道（幂等）。"""
        if self._phase is SyncPhase.CLOSED:
            return
        self._phase = SyncPhase.CLOSED
        self._close_reason = reason
        self._cancel_deadline()
        self._notify_state()
        self._notify_closed(reason)
        if self._transport is not None:
            with contextlib.suppress(Exception):  # 关通道失败不掩盖关闭原因
                self._transport.close_transport()

    # ---------------------------------------------------------------- 发送

    def _send(self, frame_type: int, payload: bytes, *, encrypted: bool = False) -> None:
        """组帧并交给 transport（加密帧：AAD = 含 encrypted 位的完整 10B 帧头）。"""
        if encrypted:
            if self._cipher is None:
                raise SessionStateError("会话密钥未就绪")
            header = build_header(frame_type, FLAG_ENCRYPTED, len(payload) + AEAD_OVERHEAD)
            data = header + self._cipher.seal(payload, aad=header)
        else:
            data = Frame(frame_type=frame_type, flags=0, payload=payload).encode()
        if self._transport is not None:
            self._transport.send_frame_bytes(data)

    def _send_frame(self, frame_type: int, payload: bytes) -> None:
        """发送明文帧（仅握手/配对阶段使用）。"""
        self._send(frame_type, payload, encrypted=False)

    def _send_pair_response(self, approved: bool, reason: str | None) -> None:
        """发送 PairResponse（nil reason 不落键，对齐 Swift 可选字段编码）。"""
        body: dict[str, Any] = {"approved": approved}
        if reason is not None:
            body["reason"] = reason
        payload = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._send_frame(FrameType.PAIR_RESPONSE, payload)

    # ---------------------------------------------------------------- 超时

    def _arm_deadline(self) -> None:
        """挂握手超时（无运行中的事件循环时静默跳过，便于纯逻辑构造）。"""
        self._cancel_deadline()
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._deadline = loop.call_later(self._config.handshake_timeout, self._on_deadline)

    def _ensure_deadline(self) -> None:
        """唯一收口：需要兜底的阶段必须始终挂着超时（漏挂的补上）。"""
        if self._phase in DEADLINE_PHASES and self._deadline is None:
            self._arm_deadline()

    def _cancel_deadline(self) -> None:
        if self._deadline is not None:
            self._deadline.cancel()
            self._deadline = None

    def _on_deadline(self) -> None:
        self._deadline = None
        if self._phase in DEADLINE_PHASES:
            self._close(CloseReason(CloseReasonKind.HANDSHAKE_TIMEOUT))

    # ------------------------------------------------------------ 回调分发

    def _notify_state(self) -> None:
        callback = self._on_state_change
        if callback is None:
            return
        try:
            callback(self, self._phase)
        except Exception:  # noqa: BLE001 - 回调异常不得中断状态机
            logger.exception("lansync 状态回调失败（session=%s）", self.session_id)

    def _notify_closed(self, reason: CloseReason) -> None:
        callback = self._on_closed
        if callback is None:
            return
        try:
            callback(self, reason)
        except Exception:  # noqa: BLE001
            logger.exception("lansync 关闭回调失败（session=%s）", self.session_id)

    def _notify_pair_request(self, pending: PendingPairRequest) -> None:
        callback = self._on_pair_request
        if callback is None:
            return
        try:
            callback(self, pending)
        except Exception:  # noqa: BLE001
            logger.exception("lansync 待批准回调失败（session=%s）", self.session_id)

    def _notify_application_frame(self, frame_type: int, payload: bytes) -> None:
        callback = self._on_application_frame
        if callback is None:
            return
        try:
            callback(self, frame_type, payload)
        except Exception:  # noqa: BLE001
            logger.exception("lansync 业务帧回调失败（session=%s）", self.session_id)


def _protocol_violation(detail: str) -> CloseReason:
    """协议违例关闭原因。"""
    return CloseReason(CloseReasonKind.PROTOCOL_VIOLATION, detail)


def _handshake_failed(detail: str) -> CloseReason:
    """握手失败关闭原因。"""
    return CloseReason(CloseReasonKind.HANDSHAKE_FAILED, detail)
