"""帧编解码 + 流式拼帧解码器（与 Swift `SyncFrame.swift` 逐行为对位）。

线上格式（帧头恒明文）：

    magic(4B "QQP1") | length(4B big-endian = payload 字节数) | type(1B) | flags(1B) | payload(N)

- `flags` bit0(`0x01`) = encrypted：握手/配对帧（type 0/1/2）在会话密钥建立前以
  明文发送；建立后业务帧一律置位并加密 payload。
- 加密帧 payload = `nonce(12) ‖ ciphertext ‖ tag(16)`，长度 = 明文长度 + 28；
  **AAD = 完整 10B 帧头**（用加密后的 payload 长度、含 encrypted flag）——
  收发两端必须用 :func:`build_header` 生成，不得手拼。
- payload 上限 16 MiB（编解码双侧校验）；magic 错 / type 非法 / 超限 = 流损坏。

帧类型表见 :class:`FrameType`（v1~v5 增量追加，值不可改）。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from enum import IntEnum

#: 帧 magic（ASCII 4B）
MAGIC = b"QQP1"
#: 帧头长度（magic 4 + length 4 + type 1 + flags 1）
HEADER_LENGTH = 10
#: payload 上限 16 MiB（解码越界保护 / 编码拒绝共用）
MAX_PAYLOAD_SIZE = 16 * 1024 * 1024
#: flags bit0：payload 已用会话密钥加密
FLAG_ENCRYPTED = 0x01
#: flags 允许的位（其余位保留，本端拒绝未知位置位）
KNOWN_FLAGS = FLAG_ENCRYPTED


class FrameError(Exception):
    """帧层错误基类。"""


class InvalidMagicError(FrameError):
    """前 4B 不是 "QQP1"。"""


class TruncatedHeaderError(FrameError):
    """数据不足 10B 帧头。"""


class TruncatedPayloadError(FrameError):
    """payload 未收全（length 前缀声明了 N 字节）。"""

    def __init__(self, declared: int, available: int) -> None:
        super().__init__(f"payload 未收全：声明 {declared}，可用 {available}")
        self.declared = declared
        self.available = available


class PayloadTooLargeError(FrameError):
    """声明的 payload 超过 16 MiB 上限。"""

    def __init__(self, declared: int) -> None:
        super().__init__(f"payload 超过上限：{declared} > {MAX_PAYLOAD_SIZE}")
        self.declared = declared


class InvalidTypeError(FrameError):
    """type 不在 :class:`FrameType` 枚举内。"""

    def __init__(self, value: int) -> None:
        super().__init__(f"非法帧类型：{value}")
        self.value = value


class EncodePayloadTooLargeError(FrameError):
    """待编码 payload 超过 16 MiB 上限。"""

    def __init__(self, actual: int) -> None:
        super().__init__(f"待编码 payload 超过上限：{actual} > {MAX_PAYLOAD_SIZE}")
        self.actual = actual


class FrameType(IntEnum):
    """帧类型（线上 1B 值；值一经发布不可改，新增从最大号 +1 起）。"""

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

    @classmethod
    def from_wire(cls, value: int) -> FrameType:
        """线上字节 → 类型；未知值抛 :class:`InvalidTypeError`（流损坏，不可恢复）。"""
        try:
            return cls(value)
        except ValueError as error:
            raise InvalidTypeError(value) from error


def build_header(frame_type: FrameType, flags: int, payload_count: int) -> bytes:
    """组装 10B 帧头（**AAD 与收端重组必须逐字节一致**）。

    ``payload_count`` 传该帧 payload 的**实际字节数**：加密帧传密文长度
    （明文 + 28），与 :meth:`Frame.header` 结果一致。
    """
    return MAGIC + struct.pack(">I", payload_count) + bytes((int(frame_type), flags & 0xFF))


@dataclass(frozen=True, slots=True)
class Frame:
    """一帧（不可变值对象，编解码纯函数）。"""

    type: FrameType
    flags: int = 0
    payload: bytes = b""

    @property
    def is_encrypted(self) -> bool:
        """payload 是否已加密（flags bit0）。"""
        return bool(self.flags & FLAG_ENCRYPTED)

    def header(self) -> bytes:
        """本帧的 10B 帧头（AAD）。"""
        return build_header(self.type, self.flags, len(self.payload))

    def encode(self) -> bytes:
        """编码为线上字节（magic|len|type|flags|payload）。"""
        if len(self.payload) > MAX_PAYLOAD_SIZE:
            raise EncodePayloadTooLargeError(len(self.payload))
        return self.header() + self.payload

    @classmethod
    def decode(cls, data: bytes) -> tuple[Frame, int]:
        """从字节流前缀解码单帧，返回 ``(帧, 消耗字节数)``（多余字节忽略）。

        校验顺序与 Swift 一致：帧头长度 → magic → 长度上限 → 收全 → type。
        数据不足一帧抛 :class:`TruncatedHeaderError` / :class:`TruncatedPayloadError`。
        """
        if len(data) < HEADER_LENGTH:
            raise TruncatedHeaderError(f"不足帧头：{len(data)} < {HEADER_LENGTH}")
        if data[:4] != MAGIC:
            raise InvalidMagicError("帧 magic 不是 QQP1")
        declared = struct.unpack(">I", data[4:8])[0]
        if declared > MAX_PAYLOAD_SIZE:
            raise PayloadTooLargeError(declared)
        total = HEADER_LENGTH + declared
        if len(data) < total:
            raise TruncatedPayloadError(declared=declared, available=len(data) - HEADER_LENGTH)
        frame_type = FrameType.from_wire(data[8])
        flags = data[9]
        payload = bytes(data[HEADER_LENGTH:total])
        return cls(type=frame_type, flags=flags, payload=payload), total


class FrameStreamDecoder:
    """流式拼帧解码器：喂任意分块的字节，输出其中的完整帧。

    残缺帧留在缓冲等下一块；帧头/长度校验失败（magic 错 / 超 16 MiB / type 非法）
    抛错——流的损坏不可恢复，由调用方终结连接。
    """

    __slots__ = ("_buffer",)

    def __init__(self) -> None:
        self._buffer = bytearray()

    def feed(self, chunk: bytes) -> list[Frame]:
        """追加一块字节，解出其中所有完整帧。"""
        self._buffer.extend(chunk)
        frames: list[Frame] = []
        while True:
            if len(self._buffer) < HEADER_LENGTH:
                break
            # magic 校验放在整帧收齐前先做一次，尽早识别错流
            if bytes(self._buffer[:4]) != MAGIC:
                raise InvalidMagicError("帧 magic 不是 QQP1")
            try:
                frame, consumed = Frame.decode(bytes(self._buffer))
            except TruncatedPayloadError:
                break  # 帧体未收全，等下一块
            frames.append(frame)
            del self._buffer[:consumed]
        return frames

    @property
    def buffered_count(self) -> int:
        """剩余缓冲字节数（诊断/测试用）。"""
        return len(self._buffer)


def encode_frame(frame_type: FrameType, payload: bytes = b"", *, encrypted: bool = False) -> bytes:
    """便捷编码单帧（会话层组装帧时用）。"""
    flags = FLAG_ENCRYPTED if encrypted else 0
    return Frame(type=frame_type, flags=flags, payload=payload).encode()
