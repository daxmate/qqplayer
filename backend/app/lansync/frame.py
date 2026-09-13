"""帧编解码 + 流式拼帧解码器（对位 Swift `QQPlayer/Sync/SyncFrame.swift`）。

线上格式（帧头恒明文）：

    magic(4B "QQP1") | length(4B big-endian = payload 字节数) | type(1B) | flags(1B) | payload(N)

- ``length`` 只算 payload，**不含 10B 帧头**；上限 16 MiB，编解码双侧校验。
- ``flags`` bit0(``0x01``) = encrypted：握手/配对帧（type 0/1/2）在会话密钥建立前
  明文发送，ready 后业务帧一律置位并加密 payload。加密帧 payload =
  ``nonce(12) ‖ ciphertext ‖ tag(16)``（明文长度 + 28）。
- **AAD = 完整 10B 帧头**（用加密后的 payload 长度、含 encrypted flag）：收发两端
  必须用 :func:`build_header` 生成，不得手拼。
- 流损坏（magic 错 / 未知 type / 超限 / 长度异常）抛 :class:`FrameError`，
  不可恢复，由调用方终结连接（协议 §1）。

本模块纯字节处理，零第三方依赖、不 import crypto（加密载荷由 crypto 层组装）。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum

#: 帧 magic（ASCII 4B）
MAGIC = b"QQP1"
#: 帧头长度（magic 4 + length 4 + type 1 + flags 1）
HEADER_LENGTH = 10
#: payload 上限 16 MiB（解码越界保护 / 编码拒绝共用，协议 §1）
MAX_PAYLOAD_BYTES = 16 * 1024 * 1024
#: flags bit0：payload 已用会话密钥加密
FLAG_ENCRYPTED = 0x01

#: 帧类型表（协议 §5，线上 1B 值；值一经发布不可改，新增从最大号 +1 起）
FRAME_TYPE_NAMES: dict[int, str] = {
    0: "handshake",
    1: "pair_request",
    2: "pair_response",
    3: "ping",
    4: "file_meta",
    5: "file_chunk",
    6: "file_ack",
    7: "bye",
    8: "change_log_pull",
    9: "change_log_push",
    10: "manifest_request",
    11: "manifest_response",
    12: "sync_fetch_request",
    13: "sync_fetch_result",
    14: "library_push_announce",
    15: "peer_library_request",
    16: "peer_library_response",
}
#: 合法 type 区间（闭区间）
MIN_FRAME_TYPE = min(FRAME_TYPE_NAMES)
MAX_FRAME_TYPE = max(FRAME_TYPE_NAMES)


class FrameType(IntEnum):
    """帧类型枚举（值同 :data:`FRAME_TYPE_NAMES`；帧内一律按 int 存放）。"""

    HANDSHAKE = 0
    PAIR_REQUEST = 1
    PAIR_RESPONSE = 2
    PING = 3
    FILE_META = 4
    FILE_CHUNK = 5
    FILE_ACK = 6
    BYE = 7
    CHANGE_LOG_PULL = 8
    CHANGE_LOG_PUSH = 9
    MANIFEST_REQUEST = 10
    MANIFEST_RESPONSE = 11
    SYNC_FETCH_REQUEST = 12
    SYNC_FETCH_RESULT = 13
    LIBRARY_PUSH_ANNOUNCE = 14
    PEER_LIBRARY_REQUEST = 15
    PEER_LIBRARY_RESPONSE = 16


class FrameError(Exception):
    """帧层错误基类：一切流损坏都是它的子类。"""


class InvalidMagicError(FrameError):
    """前 4B 不是 ``QQP1``。"""


class PayloadTooLargeError(FrameError):
    """声明的 payload 长度超过 16 MiB（读到长度即刻拒绝，不尝试读取）。"""

    def __init__(self, declared: int) -> None:
        super().__init__(f"payload 超过上限：{declared} > {MAX_PAYLOAD_BYTES}")
        self.declared = declared


class InvalidFrameTypeError(FrameError):
    """type 不在 :data:`FRAME_TYPE_NAMES` 内。"""

    def __init__(self, value: int) -> None:
        super().__init__(f"未知帧类型：{value}")
        self.value = value


def is_known_frame_type(frame_type: int) -> bool:
    """type 是否为协议 v1 已知值（未知值 = 流损坏）。"""
    return frame_type in FRAME_TYPE_NAMES


def frame_type_name(frame_type: int) -> str:
    """type → 协议名；未知值抛 :class:`InvalidFrameTypeError`。"""
    try:
        return FRAME_TYPE_NAMES[frame_type]
    except KeyError as error:
        raise InvalidFrameTypeError(frame_type) from error


def build_header(frame_type: int, flags: int, payload_len: int) -> bytes:
    """组装 10B 帧头（**AAD 与对端重组必须逐字节一致**）。

    ``payload_len`` 传该帧 payload 的实际字节数：加密帧传**密文**长度
    （明文 + 28），与 :attr:`Frame.header` 结果一致。
    """
    if not 0 <= payload_len <= 0xFFFFFFFF:
        raise ValueError(f"payload 长度越界：{payload_len}")
    if not is_known_frame_type(frame_type):
        raise InvalidFrameTypeError(frame_type)
    return MAGIC + struct.pack(">I", payload_len) + bytes((int(frame_type), flags & 0xFF))


@dataclass(frozen=True, slots=True)
class Frame:
    """一帧（不可变值对象；编解码均为纯函数）。"""

    frame_type: int
    flags: int = 0
    payload: bytes = b""

    @property
    def encrypted(self) -> bool:
        """payload 是否已加密（flags bit0）。"""
        return bool(self.flags & FLAG_ENCRYPTED)

    @property
    def header(self) -> bytes:
        """本帧 10B 帧头（AAD；加密帧即加密后长度）。"""
        return build_header(self.frame_type, self.flags, len(self.payload))

    def encode(self) -> bytes:
        """编码为线上字节（10B 头 + payload）。"""
        if len(self.payload) > MAX_PAYLOAD_BYTES:
            raise PayloadTooLargeError(len(self.payload))
        return self.header + self.payload


def encode_frame(frame_type: int, payload: bytes = b"", *, flags: int = 0) -> bytes:
    """便捷编码单帧；``flags`` 置 :data:`FLAG_ENCRYPTED` 即加密帧。"""
    return Frame(frame_type=frame_type, flags=flags, payload=payload).encode()


def _decode_one(buffer: bytes) -> Frame:
    """解一个**完整**帧（长度已保证恰好等于 10B + declared）。"""
    declared = struct.unpack(">I", buffer[4:8])[0]
    frame_type = buffer[8]
    if not is_known_frame_type(frame_type):
        raise InvalidFrameTypeError(frame_type)
    return Frame(
        frame_type=frame_type,
        flags=buffer[9],
        payload=buffer[HEADER_LENGTH : HEADER_LENGTH + declared],
    )


class FrameStreamDecoder:
    """流式拼帧：喂任意切分的字节块，吐其中完整的帧，残缺帧留缓冲。

    校验时机（协议 §1「magic 校验在整帧收齐前先做」）：

    1. 缓冲 ≥ 4B 且前 4B 非 ``QQP1`` → :class:`InvalidMagicError`（不等整帧）；
    2. 帧头齐（≥ 10B）→ 立即校验 ``length`` 上限与 ``type`` 合法性
       （**伪造超大 length 的头部在读到长度时就被拒，不会尝试吃掉 16 MiB**）；
    3. payload 未收全 → 留在缓冲等下一块，不吐半帧。

    任一 :class:`FrameError` 都表示流已损坏，调用方应断连；解码器自身不做收敛
    （错误后行为未定义，需要时用 :meth:`reset` 显式清空）。
    """

    __slots__ = ("_buffer",)

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, data: bytes) -> list[Frame]:
        """追加一块字节，返回其中新解出的全部完整帧（可能为空列表）。"""
        if data:
            self._buffer.extend(data)
        frames: list[Frame] = []
        while True:
            if len(self._buffer) < 4:
                break
            if bytes(self._buffer[:4]) != MAGIC:
                raise InvalidMagicError(f"帧 magic 不是 {MAGIC!r}")
            if len(self._buffer) < HEADER_LENGTH:
                break  # 帧头未齐，等下一块
            declared = struct.unpack(">I", bytes(self._buffer[4:8]))[0]
            if declared > MAX_PAYLOAD_BYTES:
                raise PayloadTooLargeError(declared)
            if not is_known_frame_type(self._buffer[8]):
                raise InvalidFrameTypeError(self._buffer[8])
            total = HEADER_LENGTH + declared
            if len(self._buffer) < total:
                break  # payload 未收全，留缓冲
            frames.append(_decode_one(bytes(self._buffer[:total])))
            del self._buffer[:total]
        return frames

    @property
    def buffered_bytes(self) -> int:
        """当前缓冲的字节数（残缺帧 / 半个帧头，诊断与测试用）。"""
        return len(self._buffer)

    def reset(self) -> None:
        """清空缓冲（复用解码器换连接时调用）。"""
        self._buffer.clear()
