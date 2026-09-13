"""**测试专用**参考客户端（S2 client 角色；不进生产包）。

按 `docs/lan-sync-protocol.md` §2/§3 实现 iOS 侧的最小流程，用于回环端到端测试：

    connect → 发 client hello（role/deviceID/peerDeviceID/ephemeral/签名）
            → 收 host hello（用信任根公钥验签：扫码候选 = QR 公钥；重连 = pinning 公钥）
            → 发 pair_request（对 QR sessionNonce 的 Ed25519 签名）
            → 收 pair_response → 派生会话密钥 → ready → 收发加密业务帧

只实现测试需要的部分（无 UI、无重试、无文件传输）；连接/读取超时缺省 5s，
失败一律抛 `RefClientError`，让测试快速失败而不是挂住。
"""

from __future__ import annotations

import asyncio
import base64
import json

from app.lansync import crypto as lc
from app.lansync.frame import FLAG_ENCRYPTED, Frame, FrameStreamDecoder, FrameType, build_header
from app.lansync.session import decode_hello, encode_hello, make_hello

__all__ = ["RefClient", "RefClientError"]

#: 缺省读取/连接超时（秒）
DEFAULT_TIMEOUT = 5.0


class RefClientError(Exception):
    """参考客户端错误（连接/协议/预期不符）。"""


class RefClient:
    """client 角色参考实现（长期身份 + ephemeral 会话密钥）。"""

    def __init__(
        self,
        *,
        identity: lc.Identity,
        host_public_key: bytes,
        host_device_id: str = "",
        session_nonce: bytes | None = None,
        display_name: str | None = None,
        peer_binding: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        """`host_public_key` = 验 host hello 的信任根（QR publicKey 或 pinning 公钥）。

        `session_nonce` 非 None = 走扫码配对路径（发 pair_request）；
        `peer_binding` 缺省 = `host_device_id`（首连未知时显式传空串）。
        """
        self._identity = identity
        self._host_public_key = host_public_key
        self._host_device_id = host_device_id
        self._session_nonce = session_nonce
        self._display_name = display_name
        self._peer_binding = peer_binding if peer_binding is not None else host_device_id
        self._timeout = timeout

        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._decoder = FrameStreamDecoder()
        self._pending: list[Frame] = []
        self._ephemeral: lc.EphemeralKeypair | None = None
        self._host_hello: object | None = None
        self._cipher: lc.SessionCipher | None = None

    # ---------------------------------------------------------------- 连接

    async def open(self, host: str, port: int) -> None:
        """建立 TCP 连接并发送 client hello（协议 §2 第 1 条：client 先发）。"""
        self._reader, self._writer = await asyncio.wait_for(
            asyncio.open_connection(host, port), timeout=self._timeout
        )
        self._ephemeral = lc.EphemeralKeypair.generate()
        hello = make_hello(
            role=lc.ROLE_CLIENT,
            identity=self._identity,
            peer_device_id=self._peer_binding,
            ephemeral_public_key=self._ephemeral.public_key_raw,
            name=self._display_name,
        )
        self._raw_send(
            Frame(frame_type=FrameType.HANDSHAKE, flags=0, payload=encode_hello(hello)).encode()
        )

    async def read_host_hello(self):
        """收 host hello 并验签（角色/身份绑定/pinning 公钥）。"""
        frame = await self.next_frame()
        if frame.encrypted or frame.frame_type != FrameType.HANDSHAKE:
            raise RefClientError(f"期望明文 handshake，实际 type={frame.frame_type}")
        hello = decode_hello(frame.payload)
        if hello.role != lc.ROLE_HOST:
            raise RefClientError(f"host hello 角色错误：{hello.role!r}")
        if self._host_device_id and hello.deviceID != self._host_device_id:
            raise RefClientError(f"host Device ID 不符：{hello.deviceID}")
        if hello.peerDeviceID != self._identity.device_id:
            raise RefClientError("host hello 未绑定本 client ID（协议 §2 第 2 条）")
        ephemeral = hello.ephemeral_public_key_raw
        if ephemeral is None:
            raise RefClientError("host hello ephemeral 公钥非法")
        signature = base64.b64decode(hello.signature, validate=True)
        if not lc.verify_hello(
            self._host_public_key, signature, ephemeral, hello.peerDeviceID, lc.ROLE_HOST
        ):
            raise RefClientError("host hello 验签失败（信任根不符）")
        self._host_hello = hello
        return hello

    # ---------------------------------------------------------------- 配对

    def send_pair_request(self) -> bytes:
        """发 PairRequest（对 QR sessionNonce 原始字节签名）；返回 nonce 原始字节。"""
        if self._writer is None:
            raise RefClientError("连接未建立")
        if self._session_nonce is None:
            raise RefClientError("未提供 sessionNonce（扫码配对路径才发 pair_request）")
        request: dict[str, str] = {
            "clientDeviceID": self._identity.device_id,
            "clientPublicKey": base64.b64encode(self._identity.public_key_raw).decode("ascii"),
            "nonceSignature": base64.b64encode(self._identity.sign(self._session_nonce)).decode(
                "ascii"
            ),
        }
        if self._display_name:
            request["clientName"] = self._display_name
        payload = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self._raw_send(Frame(frame_type=FrameType.PAIR_REQUEST, flags=0, payload=payload).encode())
        return self._session_nonce

    async def read_pair_response(self) -> dict:
        """收 PairResponse（`{"approved": bool, "reason"?: str}`）。"""
        frame = await self.next_frame()
        if frame.encrypted or frame.frame_type != FrameType.PAIR_RESPONSE:
            raise RefClientError(f"期望明文 pair_response，实际 type={frame.frame_type}")
        payload = json.loads(frame.payload.decode("utf-8"))
        if not isinstance(payload, dict) or not isinstance(payload.get("approved"), bool):
            raise RefClientError(f"pair_response 结构非法：{payload!r}")
        return payload

    def establish_ready(self) -> None:
        """派生会话密钥（approved 后调用；失败 = 对端 ephemeral 不可用）。"""
        if self._ephemeral is None or self._host_hello is None:
            raise RefClientError("握手前置缺失（未收 host hello）")
        peer_ephemeral = self._host_hello.ephemeral_public_key_raw
        if peer_ephemeral is None:
            raise RefClientError("host hello ephemeral 公钥非法")
        keys = lc.derive_session_keys(self._ephemeral.private_key_raw, peer_ephemeral)
        self._cipher = lc.SessionCipher(keys.for_role(lc.ROLE_CLIENT))

    # ---------------------------------------------------------------- 收发

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发加密业务帧（ready 后）。"""
        if self._cipher is None:
            raise RefClientError("会话密钥未就绪")
        header = build_header(frame_type, FLAG_ENCRYPTED, len(payload) + lc.AEAD_OVERHEAD)
        self._raw_send(header + self._cipher.seal(payload, aad=header))

    def send_plain_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发明文帧（协议违例用例：ready 前业务帧 / ready 后未加密帧）。"""
        self._raw_send(Frame(frame_type=frame_type, flags=0, payload=payload).encode())

    def send_raw(self, data: bytes) -> None:
        """直接发原始字节（帧解码失败用例）。"""
        self._raw_send(data)

    async def next_frame(self, timeout: float | None = None) -> Frame:
        """取下一帧（已解密前的原始帧；内部按需从 socket 读并拼帧）。"""
        limit = self._timeout if timeout is None else timeout
        while True:
            if self._pending:
                return self._pending.pop(0)
            if self._reader is None:
                raise RefClientError("连接未建立")
            try:
                data = await asyncio.wait_for(self._reader.read(65536), limit)
            except TimeoutError as error:  # noqa: UP041 - asyncio 超时
                raise RefClientError(f"等待帧超时（{limit}s）") from error
            if not data:
                raise RefClientError("连接已被对端关闭")
            self._pending.extend(self._decoder.feed(data))

    async def recv_application_frame(self, timeout: float | None = None) -> tuple[int, bytes]:
        """收一帧并解密，返回 `(frame_type, plaintext)`。"""
        frame = await self.next_frame(timeout)
        if not frame.encrypted:
            raise RefClientError("期望加密业务帧，收到明文帧")
        if self._cipher is None:
            raise RefClientError("会话密钥未就绪")
        return int(frame.frame_type), self._cipher.open(frame.payload, aad=frame.header)

    async def wait_closed(self, timeout: float | None = None) -> bool:
        """等对端关闭连接（丢弃残留字节；超时返回 False）。"""
        limit = self._timeout if timeout is None else timeout
        self._pending.clear()
        if self._reader is None:
            return True
        try:
            while True:
                data = await asyncio.wait_for(self._reader.read(65536), limit)
                if not data:
                    return True
        except TimeoutError:
            return False
        except (ConnectionError, OSError):
            return True

    # ---------------------------------------------------------------- 收尾

    async def aclose(self) -> None:
        """关闭本地连接（幂等）。"""
        writer, self._writer = self._writer, None
        if writer is not None:
            try:
                writer.close()
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    # ------------------------------------------------------------ 内部辅助

    def _raw_send(self, data: bytes) -> None:
        if self._writer is None:
            raise RefClientError("连接未建立")
        self._writer.write(data)
