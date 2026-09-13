"""配对 QR 载荷编解码 + 一次性 nonce 池（协议 §3.1，零 crypto 依赖）。

QR 码文本 = :class:`PairQRPayload` 的 JSON（字段名与 Swift `PairQRPayload` 逐字对位）：

    {"protoVersion":1,"hostName":"...","deviceID":"...","publicKey":"<b64>","sessionNonce":"<b64>"}

- ``publicKey`` = Host Ed25519 公钥 raw 32B 的 **standard** base64；
- ``sessionNonce`` = 一次性 16B 随机 nonce 的 standard base64，展示 QR 时注册进
  :class:`NoncePool`，配对完成 / 停止监听 / 换新码时 :meth:`NoncePool.revoke`；
- nonce 生命周期 TTL = ∞（Swift `SyncPairingNonceRegistry`，2026-09-13 起），
  **只靠显式作废**，不设过期。

本模块不 import crypto（保持纯净）：验签经 :meth:`NoncePool.match` 的 ``verify`` 回调注入，
签名算法由 crypto 层提供（Ed25519 `verify(public_key_raw, message, signature)`）。
"""

from __future__ import annotations

import base64
import json
import secrets
from collections.abc import Callable
from dataclasses import dataclass, fields
from typing import Any

#: 线协议版本（QR 载荷 protoVersion 当前值）
PROTOCOL_VERSION = 1
#: 一次性会话 nonce 字节数
SESSION_NONCE_BYTE_COUNT = 16


class QRPayloadError(Exception):
    """QR 载荷错误：JSON 不可解析、缺字段、字段类型不符。"""


@dataclass(frozen=True, slots=True)
class PairQRPayload:
    """Host 展示的配对 QR 载荷（字段名与 JSON 键逐字相同）。"""

    protoVersion: int
    hostName: str
    deviceID: str
    publicKey: str
    sessionNonce: str

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（键序与 Swift 编码一致：声明顺序）。"""
        return {item.name: getattr(self, item.name) for item in fields(self)}


def encode_qr_payload(payload: PairQRPayload) -> str:
    """载荷 → QR 码文本（紧凑 JSON，UTF-8 不转义，键名逐字保持）。"""
    return json.dumps(payload.to_dict(), ensure_ascii=False, separators=(",", ":"))


def decode_qr_payload(text: str) -> PairQRPayload:
    """QR 码文本 → 载荷；坏 JSON / 缺字段 / 类型不符 → :class:`QRPayloadError`。

    额外字段忽略（前向兼容：新版 Swift 加字段不破坏本端解析）。
    """
    try:
        raw = json.loads(text)
    except (ValueError, TypeError) as error:
        raise QRPayloadError(f"QR 载荷不是合法 JSON：{error}") from error
    if not isinstance(raw, dict):
        raise QRPayloadError("QR 载荷不是 JSON 对象")
    values: dict[str, Any] = {}
    for name, expected in (
        ("protoVersion", int),
        ("hostName", str),
        ("deviceID", str),
        ("publicKey", str),
        ("sessionNonce", str),
    ):
        if name not in raw:
            raise QRPayloadError(f"QR 载荷缺字段：{name}")
        value = raw[name]
        if expected is int and (isinstance(value, bool) or not isinstance(value, int)):
            raise QRPayloadError(f"字段类型不符：{name} 应为 int")
        if expected is str and not isinstance(value, str):
            raise QRPayloadError(f"字段类型不符：{name} 应为 str")
        values[name] = value
    return PairQRPayload(**values)


def new_session_nonce() -> bytes:
    """生成一次性会话 nonce（16B 密码学随机）。"""
    return secrets.token_bytes(SESSION_NONCE_BYTE_COUNT)


def make_qr_payload(
    *,
    host_name: str,
    device_id: str,
    public_key_b64: str,
    session_nonce: bytes | None = None,
) -> PairQRPayload:
    """组装 Host 侧 QR 载荷；``session_nonce`` 缺省时新生成 16B（原生字节自动 base64）。"""
    nonce = new_session_nonce() if session_nonce is None else session_nonce
    if len(nonce) != SESSION_NONCE_BYTE_COUNT:
        raise QRPayloadError(f"session nonce 必须 {SESSION_NONCE_BYTE_COUNT}B，实际 {len(nonce)}B")
    return PairQRPayload(
        protoVersion=PROTOCOL_VERSION,
        hostName=host_name,
        deviceID=device_id,
        publicKey=public_key_b64,
        sessionNonce=_b64(nonce),
    )


def _b64(raw: bytes) -> str:
    """standard base64 编码（带填充，与 Swift `Data.base64EncodedString()` 一致）。"""
    return base64.b64encode(raw).decode("ascii")


class NoncePool:
    """一次性配对 nonce 池（TTL = ∞；重复注册 = 覆盖，保持唯一）。

    典型用法：展示 QR 时 :meth:`register`；收到 `PairRequest` 时
    :meth:`match`（验签命中即消耗）；配对完成 / 停监听 / 换码时 :meth:`revoke`。
    """

    __slots__ = ("_pending",)

    def __init__(self) -> None:
        self._pending: dict[bytes, None] = {}

    def register(self, nonce: bytes) -> None:
        """登记待用 nonce（已存在则覆盖，不产生重复项，顺序保持首次登记位置）。

        空 nonce 忽略（与 Swift `SyncPairingNonceRegistry.register` 的
        `guard !nonce.isEmpty` 一致：空值永远不该成为可验签的待用项）。
        """
        if not nonce:
            return
        self._pending[nonce] = None

    def consume(self, nonce: bytes) -> bool:
        """按值消耗 nonce：命中返回 True 并移除，未登记返回 False。"""
        if nonce in self._pending:
            del self._pending[nonce]
            return True
        return False

    def revoke(self, nonce: bytes) -> None:
        """显式作废（幂等：不存在也不报错）。"""
        self._pending.pop(nonce, None)

    def clear(self) -> None:
        """清空全部（停止监听 / 关闭服务时用）。"""
        self._pending.clear()

    @property
    def pending_count(self) -> int:
        """当前待用 nonce 数量。"""
        return len(self._pending)

    def pending(self) -> tuple[bytes, ...]:
        """当前待用 nonce（登记顺序；测试与诊断用）。"""
        return tuple(self._pending)

    def match(
        self,
        public_key_raw: bytes,
        signature: bytes,
        verify: Callable[[bytes, bytes, bytes], bool],
    ) -> bytes | None:
        """用 ``verify(public_key_raw, nonce, signature)`` 逐个试未作废 nonce。

        首个验签通过者即**消耗**并返回该 nonce；都不通过返回 ``None``
        （调用方据此回 `approved=false` 并断连，协议 §3.3 步骤 3）。
        """
        for nonce in self.pending():
            if verify(public_key_raw, nonce, signature):
                self.consume(nonce)
                return nonce
        return None
