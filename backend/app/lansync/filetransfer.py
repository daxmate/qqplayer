"""局域网同步（S2）文件传输层：帧 4/5/6（`file_meta` / `file_chunk` / `file_ack`）。

与 Swift 端 `QQPlayer/Sync/SyncFileSender.swift` / `SyncFileReceiver.swift` /
`SyncFileChecksum.swift` / `SyncFileTransferModels.swift` 对位，线协议契约见
`docs/lan-sync-protocol.md` §10（本模块即 §10 事实的 Python 侧实现）。

分层职责：

- **只做文件传输语义**：分块、断点续传、`.part` 落盘、整文件 SHA-256 校验、ack 判定；
  不碰帧头、不碰加密（flags bit0 由会话层置位）、不碰 socket。
- **字节通道解耦**：收发各注入一个 ``send(FrameType, bytes)`` 回调（生产 = 会话层
  `HostSession.send_application_frame`；测试 = 内存回环）。回调必须**不阻塞**；
  抛异常即视为发送失败（转为本轮终态，不向调用方二次抛出）。
- **停等驱动（stop-and-wait）**：由对端 ack 推进。``FileSender.begin()`` 发
  `file_meta`，之后每收一条本传输的 `file_ack` 就校验并决定「发下一块 / 收尾 /
  失败」。``FileReceiver.handle_frame()`` 是推入式入口，返回它刚回的 ack（便于测试）。
- **终态一次**：一轮传输的终态**恰一次**经 ``on_completion`` 通知；``begin()`` /
  构造只对「未开始的传输」抛 :class:`FileTransferError`（对齐 Swift `SyncFileSender`
  `:15-16`、`:29-33` 的回调契约）。
- **ack 超时**由调用方（会话/服务层，持有事件循环）按 :data:`DEFAULT_ACK_TIMEOUT`
  计时，到点调 :meth:`FileSender.handle_ack_timeout`；本层不含定时器（纯同步、无 loop）。

字段命名：线上 JSON 键 = Swift 属性名（`fileID` / `totalSize` / `sha256Hex` …），
Python 属性用 snake_case，与 `frame` / `session` 既有模块一致。
"""

from __future__ import annotations

import base64
import binascii
import contextlib
import errno
import hashlib
import json
import logging
import os
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import IO, Any, Protocol

from .frame import MAX_PAYLOAD_BYTES, FrameType

logger = logging.getLogger(__name__)

#: 分块大小（256 KiB，§10.4；发送端定，块 base64 后约 342 KB ≪ 16 MiB 帧上限）
CHUNK_SIZE = 262_144
#: 等待 `file_ack` 超时（秒，§10.4 `defaultAckTimeout`；0 = 禁用，仅测试）
DEFAULT_ACK_TIMEOUT = 30.0
#: 流式读窗口（1 MiB，§10.4；算 SHA-256 与落盘校验共用，大文件不整进内存）
CHECKSUM_READ_SIZE = 1_048_576
#: 空数据 SHA-256（§10.5 规则 6 的自洽校验基准）
EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
#: 断点文件后缀（§10.5：`{name}.part`，与最终文件同目录）
PART_SUFFIX = ".part"


class FrameSender(Protocol):
    """帧发送回调（生产 = 会话层业务帧发送；测试 = 内存回环）。"""

    def __call__(self, frame_type: int, payload: bytes) -> None:
        """发一帧业务帧（未加密 payload，加密由会话层置位）。"""
        ...


class FileTransferErrorKind(str, Enum):
    """本地错误种类（原始值 = Swift `SyncFileTransferError` 的 case 名）。

    仅 :data:`PROTOCOL_ERROR` / :data:`IO_ERROR` / :data:`DISK_FULL` /
    :data:`CHECKSUM_MISMATCH` / :data:`RESUME_MISMATCH` 会同时出现在线上
    `file_ack.error`；其余是本地判定（不上线）。
    """

    SESSION_NOT_READY = "sessionNotReady"
    FILE_UNAVAILABLE = "fileUnavailable"
    TRANSFER_IN_PROGRESS = "transferInProgress"
    INVALID_ARGUMENT = "invalidArgument"
    CANCELLED = "cancelled"
    SESSION_CLOSED = "sessionClosed"
    SEND_FAILED = "sendFailed"
    IO_ERROR = "ioError"
    DISK_FULL = "diskFull"
    CHECKSUM_MISMATCH = "checksumMismatch"
    RESUME_MISMATCH = "resumeMismatch"
    PROTOCOL_ERROR = "protocolError"


class FileAckError(str, Enum):
    """`file_ack.error` 线上取值（§10.3，原始值 = 枚举 case 名）。"""

    NONE = "none"
    IO_ERROR = "ioError"
    DISK_FULL = "diskFull"
    CHECKSUM_MISMATCH = "checksumMismatch"
    RESUME_MISMATCH = "resumeMismatch"
    CANCELLED = "cancelled"
    PROTOCOL_ERROR = "protocolError"


#: 线上错误码 → 本地错误种类（`none` 不入表，表示无错）
_ACK_ERROR_KINDS: dict[FileAckError, FileTransferErrorKind] = {
    FileAckError.IO_ERROR: FileTransferErrorKind.IO_ERROR,
    FileAckError.DISK_FULL: FileTransferErrorKind.DISK_FULL,
    FileAckError.CHECKSUM_MISMATCH: FileTransferErrorKind.CHECKSUM_MISMATCH,
    FileAckError.RESUME_MISMATCH: FileTransferErrorKind.RESUME_MISMATCH,
    FileAckError.CANCELLED: FileTransferErrorKind.CANCELLED,
    FileAckError.PROTOCOL_ERROR: FileTransferErrorKind.PROTOCOL_ERROR,
}


class FileTransferError(Exception):
    """文件传输错误（种类 + 说明）。

    - **协议违例**（参数非法 / 块序错 / 载荷解码失败 / ack 不合法）→ `protocolError`；
    - **本地前置错误**（文件不存在 / 参数非法 / 已有传输在跑）→ 对应种类，由调用方先判；
    - 接收端对协议违例的响应是回 `file_ack(error=protocolError)` 并中止本轮，
      而不是抛给调用方（§10.6）。
    """

    def __init__(self, kind: FileTransferErrorKind, detail: str = "") -> None:
        super().__init__(f"{kind.value}: {detail}" if detail else kind.value)
        self.kind = kind
        self.detail = detail


def sha256_hex(data: bytes) -> str:
    """字节的 SHA-256 小写 hex。"""
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str | os.PathLike[str]) -> str:
    """流式算整文件 SHA-256 小写 hex（1 MiB 窗口，大文件不整进内存）。"""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            window = handle.read(CHECKSUM_READ_SIZE)
            if not window:
                break
            digest.update(window)
    return digest.hexdigest()


def align_down(value: int, unit: int) -> int:
    """向下对齐到 ``unit`` 的整数倍（§10.4 `alignDown(v, chunkSize)`）。"""
    if unit <= 0:
        raise FileTransferError(FileTransferErrorKind.INVALID_ARGUMENT, "对齐单位必须 > 0")
    return value - value % unit


def _encode_payload(payload: dict[str, Any]) -> bytes:
    """JSON 载荷编码（紧凑、UTF-8、不转义非 ASCII）；超 16 MiB → 拒绝。"""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise FileTransferError(
            FileTransferErrorKind.INVALID_ARGUMENT,
            f"载荷超过 16 MiB：{len(raw)} > {MAX_PAYLOAD_BYTES}",
        )
    return raw


def _decode_payload(raw: bytes, what: str) -> dict[str, Any]:
    """JSON 载荷解码（非对象 / 坏 JSON / 超限 → `protocolError`）。"""
    if len(raw) > MAX_PAYLOAD_BYTES:
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, f"{what} 载荷超过 16 MiB：{len(raw)}"
        )
    try:
        value = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, f"{what} 不是合法 JSON：{error}"
        ) from error
    if not isinstance(value, dict):
        raise FileTransferError(FileTransferErrorKind.PROTOCOL_ERROR, f"{what} 不是 JSON 对象")
    return value


def _as_str(raw: dict[str, Any], key: str, what: str) -> str:
    """取字符串字段；缺失 / 类型不符 → `protocolError`。"""
    value = raw.get(key)
    if not isinstance(value, str):
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, f"{what} 字段缺失或类型不符：{key}"
        )
    return value


def _as_int(raw: dict[str, Any], key: str, what: str) -> int:
    """取整数字段（显式排除 bool）；缺失 / 类型不符 → `protocolError`。"""
    value = raw.get(key)
    if isinstance(value, bool) or not isinstance(value, int):
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, f"{what} 字段缺失或类型不符：{key}"
        )
    return value


@dataclass(frozen=True, slots=True)
class FileMetaPayload:
    """`file_meta`(4) 载荷（§10.1；字段名 = Swift `FileMetaPayload`）。"""

    file_id: str
    name: str
    total_size: int
    chunk_size: int
    sha256_hex: str
    start_offset: int = 0

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（键序 = Swift 声明顺序）。"""
        return {
            "fileID": self.file_id,
            "name": self.name,
            "totalSize": self.total_size,
            "chunkSize": self.chunk_size,
            "sha256Hex": self.sha256_hex,
            "startOffset": self.start_offset,
        }


@dataclass(frozen=True, slots=True)
class FileChunkPayload:
    """`file_chunk`(5) 载荷（§10.2；`data` 线上为 base64 字符串，本地为 bytes）。"""

    file_id: str
    offset: int
    data: bytes

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（`data` 走标准 base64，与 Swift `Data` 默认编码一致）。"""
        return {
            "fileID": self.file_id,
            "offset": self.offset,
            "data": base64.b64encode(self.data).decode("ascii"),
        }


@dataclass(frozen=True, slots=True)
class FileAckPayload:
    """`file_ack`(6) 载荷（§10.3）。"""

    file_id: str
    received_bytes: int
    done: bool = False
    error: FileAckError = FileAckError.NONE

    def to_dict(self) -> dict[str, Any]:
        """JSON 字典（键序 = Swift 声明顺序）。"""
        return {
            "fileID": self.file_id,
            "receivedBytes": self.received_bytes,
            "done": self.done,
            "error": self.error.value,
        }


def encode_file_meta(meta: FileMetaPayload) -> bytes:
    """`file_meta` 载荷 → 帧 payload。"""
    return _encode_payload(meta.to_dict())


def decode_file_meta(payload: bytes) -> FileMetaPayload:
    """帧 payload → `file_meta`（**仅结构校验**；§10.1 的 6 条语义校验在接收端）。"""
    raw = _decode_payload(payload, "file_meta")
    start = raw.get("startOffset", 0)
    if isinstance(start, bool) or not isinstance(start, int):
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, "file_meta 字段类型不符：startOffset"
        )
    return FileMetaPayload(
        file_id=_as_str(raw, "fileID", "file_meta"),
        name=_as_str(raw, "name", "file_meta"),
        total_size=_as_int(raw, "totalSize", "file_meta"),
        chunk_size=_as_int(raw, "chunkSize", "file_meta"),
        sha256_hex=_as_str(raw, "sha256Hex", "file_meta"),
        start_offset=start,
    )


def encode_file_chunk(chunk: FileChunkPayload) -> bytes:
    """`file_chunk` 载荷 → 帧 payload。"""
    return _encode_payload(chunk.to_dict())


def decode_file_chunk(payload: bytes) -> FileChunkPayload:
    """帧 payload → `file_chunk`（base64 非法 / 字段缺失 → `protocolError`）。"""
    raw = _decode_payload(payload, "file_chunk")
    encoded = _as_str(raw, "data", "file_chunk")
    try:
        data = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, f"file_chunk 的 data 不是合法 base64：{error}"
        ) from error
    return FileChunkPayload(
        file_id=_as_str(raw, "fileID", "file_chunk"),
        offset=_as_int(raw, "offset", "file_chunk"),
        data=data,
    )


def encode_file_ack(ack: FileAckPayload) -> bytes:
    """`file_ack` 载荷 → 帧 payload。"""
    return _encode_payload(ack.to_dict())


def decode_file_ack(payload: bytes) -> FileAckPayload:
    """帧 payload → `file_ack`（`error` 取值未知 → `protocolError`）。"""
    raw = _decode_payload(payload, "file_ack")
    done = raw.get("done")
    if not isinstance(done, bool):
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, "file_ack 字段缺失或类型不符：done"
        )
    error_value = _as_str(raw, "error", "file_ack")
    try:
        error = FileAckError(error_value)
    except ValueError as invalid:
        raise FileTransferError(
            FileTransferErrorKind.PROTOCOL_ERROR, f"file_ack 未知 error：{error_value}"
        ) from invalid
    return FileAckPayload(
        file_id=_as_str(raw, "fileID", "file_ack"),
        received_bytes=_as_int(raw, "receivedBytes", "file_ack"),
        done=done,
        error=error,
    )


@dataclass(frozen=True, slots=True)
class FileTransferResult:
    """一轮传输的终态（对齐 Swift `SyncFileSenderCompletion` 的 success/failure）。"""

    file_id: str
    error: FileTransferErrorKind | None = None
    detail: str | None = None
    received_bytes: int = 0
    total_size: int = 0
    sha256_hex: str | None = None
    target_path: Path | None = None

    @property
    def ok(self) -> bool:
        """是否成功（无错误）。"""
        return self.error is None

    def to_dict(self) -> dict[str, Any]:
        """事件/UI 字典（键名对齐线上命名，便于 service 层直接透出）。"""
        payload: dict[str, Any] = {
            "fileID": self.file_id,
            "ok": self.ok,
            "receivedBytes": self.received_bytes,
            "totalSize": self.total_size,
        }
        if self.error is not None:
            payload["error"] = self.error.value
        if self.detail is not None:
            payload["detail"] = self.detail
        if self.sha256_hex is not None:
            payload["sha256Hex"] = self.sha256_hex
        if self.target_path is not None:
            payload["path"] = str(self.target_path)
        return payload


def _extract_file_id(payload: bytes) -> str | None:
    """尽力从坏载荷里抠出 `fileID`（§10.6：能取到就回 protocolError 让对端干净失败）。"""
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    file_id = raw.get("fileID")
    return file_id if isinstance(file_id, str) and file_id else None


def _is_safe_name(name: str) -> bool:
    """落盘文件名安全（§10.1 规则 1：非空、非 `.`/`..`、不含 `/` 与 `\\`）。"""
    if not name or name in (".", ".."):
        return False
    return "/" not in name and "\\" not in name


def _is_hex64(value: str) -> bool:
    """64 位 hex（§10.1 规则 5，大小写不敏感）。"""
    if len(value) != 64:
        return False
    return all(character in "0123456789abcdefABCDEF" for character in value)


def validate_meta(meta: FileMetaPayload) -> str | None:
    """§10.1 接收端参数校验集（6 条）；返回 None = 通过，否则返回违例说明。

    1. `fileID`/`name` 非空、`name` 安全（防目录穿越）；
    2. `totalSize >= 0`、`startOffset >= 0`、`startOffset <= totalSize`；
    3. `0 < chunkSize <= 16 MiB`；
    4. `startOffset == 0 || startOffset % chunkSize == 0`；
    5. `sha256Hex` 为 64 位 hex；
    6. `totalSize == 0` 时 `sha256Hex` == 空数据 SHA-256。
    """
    if not meta.file_id:
        return "fileID 为空"
    if not _is_safe_name(meta.name):
        return f"name 非法（非空、非 . / ..、不含路径分隔符）：{meta.name!r}"
    if meta.total_size < 0:
        return f"totalSize 为负：{meta.total_size}"
    if meta.start_offset < 0:
        return f"startOffset 为负：{meta.start_offset}"
    if meta.start_offset > meta.total_size:
        return f"startOffset 超过 totalSize：{meta.start_offset} > {meta.total_size}"
    if meta.chunk_size <= 0:
        return f"chunkSize 非正：{meta.chunk_size}"
    if meta.chunk_size > MAX_PAYLOAD_BYTES:
        return f"chunkSize 超过 16 MiB：{meta.chunk_size}"
    if meta.start_offset != 0 and meta.start_offset % meta.chunk_size != 0:
        return f"startOffset 未对齐块边界：{meta.start_offset} % {meta.chunk_size}"
    if not _is_hex64(meta.sha256_hex):
        return "sha256Hex 不是 64 位 hex"
    if meta.total_size == 0 and meta.sha256_hex.lower() != EMPTY_SHA256_HEX:
        return "空文件（totalSize=0）的 sha256Hex 与空数据 SHA-256 不符"
    return None


class FileSender:
    """单文件发送端（§10.5/§10.6 发送侧；停等，ack 驱动）。

    用法：``begin()``（发 `file_meta`）→ 会话层把收到的 `file_ack` 交给
    :meth:`handle_frame` → 本类按需发下一块；终态经 ``on_completion`` 通知一次。

    本层不持时钟：ack 超时由调用方按 :data:`DEFAULT_ACK_TIMEOUT` 计时后调
    :meth:`handle_ack_timeout`（到点 = `protocolError("等待 file_ack 超时")` + 清状态）。
    """

    def __init__(
        self,
        source: str | os.PathLike[str],
        *,
        file_id: str,
        send: FrameSender,
        start_offset: int = 0,
        chunk_size: int = CHUNK_SIZE,
        display_name: str | None = None,
        on_completion: Callable[[FileTransferResult], None] | None = None,
    ) -> None:
        self._source = Path(source)
        self._file_id = file_id
        self._send = send
        self._start_offset = start_offset
        self._chunk_size = chunk_size
        self._display_name = display_name
        self._on_completion = on_completion
        self._meta: FileMetaPayload | None = None
        self._total_size = 0
        self._sha256_hex = ""
        self._awaiting_ack = False
        self._last_ack_bytes: int | None = None

    @property
    def file_id(self) -> str:
        """本次传输 ID。"""
        return self._file_id

    @property
    def is_active(self) -> bool:
        """是否有一轮传输在跑（`begin()` 之后、终态之前）。"""
        return self._meta is not None

    @property
    def is_awaiting_ack(self) -> bool:
        """是否正在等 `file_ack`（调用方按此挂/摘超时定时器）。"""
        return self._awaiting_ack

    @property
    def meta(self) -> FileMetaPayload | None:
        """本轮发过的 `file_meta`（未开始 = None）。"""
        return self._meta

    def begin(self) -> FileMetaPayload:
        """校验前置条件 → 流式算整文件 SHA-256 → 发 `file_meta`（§10.5）。

        只对**未开始的传输**抛 :class:`FileTransferError`（文件不可用 / 参数非法 /
        已有传输在跑）；一旦开始，终态一律走 ``on_completion``。
        """
        if self._meta is not None:
            raise FileTransferError(
                FileTransferErrorKind.TRANSFER_IN_PROGRESS, f"传输已在跑：{self._file_id}"
            )
        if not self._file_id:
            raise FileTransferError(FileTransferErrorKind.INVALID_ARGUMENT, "fileID 为空")
        if self._chunk_size <= 0 or self._chunk_size > MAX_PAYLOAD_BYTES:
            raise FileTransferError(
                FileTransferErrorKind.INVALID_ARGUMENT, f"chunkSize 非法：{self._chunk_size}"
            )
        if self._start_offset < 0:
            raise FileTransferError(
                FileTransferErrorKind.INVALID_ARGUMENT, f"startOffset 为负：{self._start_offset}"
            )
        if not self._source.is_file():
            raise FileTransferError(
                FileTransferErrorKind.FILE_UNAVAILABLE, f"源文件不可用：{self._source}"
            )
        try:
            self._total_size = self._source.stat().st_size
            self._sha256_hex = sha256_file(self._source)
        except OSError as error:
            raise FileTransferError(
                FileTransferErrorKind.FILE_UNAVAILABLE, f"读取源文件失败：{error}"
            ) from error
        if self._start_offset > self._total_size:
            raise FileTransferError(
                FileTransferErrorKind.INVALID_ARGUMENT,
                f"startOffset 超过文件大小：{self._start_offset} > {self._total_size}",
            )
        if self._start_offset != 0 and self._start_offset % self._chunk_size != 0:
            raise FileTransferError(
                FileTransferErrorKind.INVALID_ARGUMENT,
                f"startOffset 未对齐块边界：{self._start_offset} % {self._chunk_size}",
            )
        meta = FileMetaPayload(
            file_id=self._file_id,
            name=self._display_name or self._source.name,
            total_size=self._total_size,
            chunk_size=self._chunk_size,
            sha256_hex=self._sha256_hex,
            start_offset=self._start_offset,
        )
        self._meta = meta
        self._last_ack_bytes = None
        self._awaiting_ack = True
        self._emit(FrameType.FILE_META, encode_file_meta(meta))
        return meta

    def handle_frame(self, frame_type: int, payload: bytes) -> bool:
        """推入一帧；返回 True = 本轮已到终态（成功或失败）。"""
        if self._meta is None or frame_type != FrameType.FILE_ACK:
            return False  # 空闲期 / 非 ack 帧一律忽略（§10.6）
        try:
            ack = decode_file_ack(payload)
        except FileTransferError as error:
            return self._fail(FileTransferErrorKind.PROTOCOL_ERROR, f"file_ack 解码失败：{error}")
        return self.handle_ack(ack)

    def handle_ack(self, ack: FileAckPayload) -> bool:
        """处理一条 `file_ack`（§10.6 发送端判定表）；返回 True = 本轮终态。"""
        meta = self._meta
        if meta is None:
            return False
        if ack.file_id != self._file_id:
            return False  # 别的 fileID 的 ack → 静默忽略
        if ack.error is not FileAckError.NONE:
            kind = _ACK_ERROR_KINDS[ack.error]
            return self._fail(kind, f"对端回 {ack.error.value}", ack.received_bytes)
        if ack.done:
            if ack.received_bytes != meta.total_size:
                return self._fail(
                    FileTransferErrorKind.PROTOCOL_ERROR,
                    f"done ack 字节数与 totalSize 不符：{ack.received_bytes} != {meta.total_size}",
                    ack.received_bytes,
                )
            return self._finish(
                FileTransferResult(
                    file_id=self._file_id,
                    received_bytes=meta.total_size,
                    total_size=meta.total_size,
                    sha256_hex=self._sha256_hex,
                )
            )
        if not 0 <= ack.received_bytes <= meta.total_size:
            return self._fail(
                FileTransferErrorKind.PROTOCOL_ERROR,
                f"ack 字节数越界：{ack.received_bytes}",
                ack.received_bytes,
            )
        if self._last_ack_bytes is not None and ack.received_bytes <= self._last_ack_bytes:
            return self._fail(
                FileTransferErrorKind.PROTOCOL_ERROR,
                f"ack 字节数未前进：{ack.received_bytes} <= {self._last_ack_bytes}",
                ack.received_bytes,
            )
        if ack.received_bytes == meta.total_size:
            return self._fail(
                FileTransferErrorKind.PROTOCOL_ERROR,
                "ack 未 done 但字节已收齐",
                ack.received_bytes,
            )
        self._last_ack_bytes = ack.received_bytes
        return self._send_next_chunk(align_down(ack.received_bytes, meta.chunk_size))

    def handle_ack_timeout(self) -> bool:
        """ack 超时（调用方按 :data:`DEFAULT_ACK_TIMEOUT` 计时）；真值 = 本轮已终结。"""
        return self._fail(FileTransferErrorKind.PROTOCOL_ERROR, "等待 file_ack 超时")

    def cancel(self) -> None:
        """本端取消（`.part` 留在接收端可续传）；空闲时无操作。"""
        self._fail(FileTransferErrorKind.CANCELLED, "本端取消")

    def handle_session_closed(self) -> None:
        """会话断连（Swift `.sessionClosed`）。"""
        self._fail(FileTransferErrorKind.SESSION_CLOSED, "会话已关闭")

    def _send_next_chunk(self, offset: int) -> bool:
        """按 ack 位置读下一块并发出（流式：每块独立读，不整文件进内存）。"""
        meta = self._meta
        if meta is None:  # pragma: no cover - 调用点已判空
            return False
        length = min(meta.chunk_size, meta.total_size - offset)
        try:
            with open(self._source, "rb") as handle:
                handle.seek(offset)
                data = handle.read(length)
        except OSError as error:
            return self._fail(FileTransferErrorKind.IO_ERROR, f"读取源文件失败：{error}")
        if len(data) != length:
            return self._fail(
                FileTransferErrorKind.IO_ERROR,
                f"源文件在 {offset} 处提前结束：读到 {len(data)}，期望 {length}",
            )
        self._awaiting_ack = True
        self._emit(
            FrameType.FILE_CHUNK,
            encode_file_chunk(FileChunkPayload(self._file_id, offset, data)),
        )
        return False

    def _emit(self, frame_type: int, payload: bytes) -> None:
        """发一帧；发送回调抛异常 = 本轮失败（sendFailed），不向调用方二次抛出。"""
        try:
            self._send(frame_type, payload)
        except Exception as error:  # noqa: BLE001 - 传输层异常一律转终态
            logger.warning("lansync 文件帧发送失败（fileID=%s）：%s", self._file_id, error)
            self._fail(FileTransferErrorKind.SEND_FAILED, f"发送失败：{error}")

    def _fail(self, kind: FileTransferErrorKind, detail: str, received_bytes: int = 0) -> bool:
        """本轮失败（空闲 = 无操作，返回 False）。"""
        if self._meta is None:
            return False
        meta = self._meta
        return self._finish(
            FileTransferResult(
                file_id=self._file_id,
                error=kind,
                detail=detail,
                received_bytes=received_bytes,
                total_size=meta.total_size,
                sha256_hex=self._sha256_hex or None,
            )
        )

    def _finish(self, result: FileTransferResult) -> bool:
        """清状态 + 终态通知（每轮恰一次），返回 True。"""
        self._meta = None
        self._awaiting_ack = False
        self._last_ack_bytes = None
        callback = self._on_completion
        if callback is not None:
            try:
                callback(result)
            except Exception:  # noqa: BLE001 - 回调异常不影响本层状态机
                logger.exception("lansync 发送完成回调失败（fileID=%s）", result.file_id)
        return True


class FileReceiver:
    """单文件接收端（§10.1/§10.5/§10.6 接收侧；v1 单飞，不支持交叠传输）。

    用法：会话层把 4/5 帧原样交给 :meth:`handle_frame`；本类负责校验、写
    `<target_dir>/<name>.part`、收齐后校验整文件 SHA-256 并原子改名为正式文件。
    回给对端的 `file_ack` 经注入的 ``send`` 回调发出（同时作为返回值便于测试）。

    `file_ack` 帧本身**静默忽略**（§10.3：接收端不收 ack）；其它帧类型也忽略
    （路由是会话/服务层职责）。定时器同发送端：本层不含超时逻辑。
    """

    def __init__(
        self,
        target_dir: str | os.PathLike[str],
        *,
        send: FrameSender,
        on_completion: Callable[[FileTransferResult], None] | None = None,
    ) -> None:
        self._target_dir = Path(target_dir)
        self._send = send
        self._on_completion = on_completion
        self._meta: FileMetaPayload | None = None
        self._part_path: Path | None = None
        self._final_path: Path | None = None
        self._received = 0
        self._handle: IO[bytes] | None = None
        #: `.part` 句柄的 ExitStack（生命周期 = 一轮传输；`_reset` 统一关闭）
        self._stack: contextlib.ExitStack | None = None

    @property
    def file_id(self) -> str | None:
        """当前活动传输 ID（空闲 = None）。"""
        return self._meta.file_id if self._meta is not None else None

    @property
    def received_bytes(self) -> int:
        """当前 `.part` 已收完整字节数（块边界对齐）。"""
        return self._received

    @property
    def is_active(self) -> bool:
        """是否有传输在收（meta 已接受、未到终态）。"""
        return self._meta is not None

    @property
    def part_path(self) -> Path | None:
        """当前 `.part` 路径。"""
        return self._part_path

    @property
    def target_path(self) -> Path | None:
        """当前正式文件路径。"""
        return self._final_path

    def handle_frame(self, frame_type: int, payload: bytes) -> FileAckPayload | None:
        """推入一帧；返回刚回的 `file_ack`（未回 ack / 忽略 = None）。"""
        if frame_type == FrameType.FILE_META:
            return self._handle_meta(payload)
        if frame_type == FrameType.FILE_CHUNK:
            return self._handle_chunk(payload)
        return None  # file_ack 静默忽略；其它类型由调用方路由

    def cancel(self) -> None:
        """本端取消：清内存状态、保留 `.part`（可续传）。"""
        self._reset()

    def handle_session_closed(self) -> None:
        """会话断连：清内存状态、保留 `.part`（可续传）。"""
        self._reset()

    # ---- meta ----

    def _handle_meta(self, payload: bytes) -> FileAckPayload | None:
        """`file_meta`：解码 → 6 条校验 → 幂等/空文件/断点对齐 → 回初始 ack。"""
        try:
            meta = decode_file_meta(payload)
        except FileTransferError as error:
            file_id = _extract_file_id(payload)
            if file_id is None:
                return None  # 抠不出 fileID → 靠发送端 ack 超时兜底（§10.6）
            logger.debug("lansync file_meta 解码失败：%s", error)
            return self._send_ack(file_id, 0, False, FileAckError.PROTOCOL_ERROR)
        if self._meta is not None and meta.file_id != self._meta.file_id:
            # 交叠传输（v1 单飞）：不动在跑的这轮，只把新请求顶回去
            return self._send_ack(meta.file_id, 0, False, FileAckError.PROTOCOL_ERROR)
        detail = validate_meta(meta)
        if detail is not None:
            logger.debug("lansync file_meta 参数违例：%s", detail)
            return self._send_ack(
                meta.file_id,
                self._committed_for(meta.file_id),
                False,
                FileAckError.PROTOCOL_ERROR,
            )
        if self._meta is not None:  # 同 fileID 重复 meta → 按新轮重建（.part 对齐兜底）
            self._reset()
        self._meta = meta
        self._final_path = self._target_dir / meta.name
        self._part_path = Path(str(self._final_path) + PART_SUFFIX)

        if self._final_path.is_file():
            try:
                same_size = self._final_path.stat().st_size == meta.total_size
                if same_size and sha256_file(self._final_path) == meta.sha256_hex.lower():
                    return self._complete_ready()
            except OSError as error:
                return self._fail_ack(FileAckError.IO_ERROR, f"读取目标文件失败：{error}")
        if meta.total_size == 0:
            try:
                self._final_path.write_bytes(b"")
            except OSError as error:
                return self._fail_ack(_os_kind(error), f"创建空文件失败：{error}")
            return self._complete_ready()
        return self._align_resume()

    def _align_resume(self) -> FileAckPayload | None:
        """断点对齐（§10.5 续传语义第 2 步）→ 打开 `.part` → 回初始 ack。"""
        meta = self._meta
        part = self._part_path
        if meta is None or part is None:  # pragma: no cover - 调用点已赋值
            return None
        stack = contextlib.ExitStack()
        self._stack = stack
        if meta.start_offset == 0:
            try:
                if part.is_file():
                    part.unlink()  # 需求 startOffset=0 → 丢弃任何残留 .part，从头收
                # 句柄由 ExitStack 管理（生命周期 = 本轮传输），ruff 只认 `with open`
                self._handle = stack.enter_context(open(part, "w+b"))  # noqa: SIM115
            except OSError as error:
                return self._fail_ack(_os_kind(error), f"创建 .part 失败：{error}")
            self._received = 0
        else:
            try:
                size = part.stat().st_size
            except OSError as error:
                self._received = 0
                kind = FileAckError.RESUME_MISMATCH if not part.exists() else _os_kind(error)
                return self._fail_ack(kind, f"断点文件不可读：{error}")
            aligned = align_down(size, meta.chunk_size)
            if aligned != meta.start_offset:
                self._received = aligned
                return self._fail_ack(
                    FileAckError.RESUME_MISMATCH,
                    f"断点 {aligned} 与请求 startOffset {meta.start_offset} 不符",
                )
            if size != aligned:
                # 尾部半块残留（写块中途异常）→ 截到块边界；截断失败绝不静默继续
                try:
                    with open(part, "r+b") as truncating:
                        truncating.truncate(aligned)
                except OSError as error:
                    self._received = aligned
                    return self._fail_ack(FileAckError.IO_ERROR, f"截断 .part 失败：{error}")
            self._received = aligned
            if aligned == meta.total_size:
                # 上轮收齐但未及改名 → 直接走整文件校验收尾
                try:
                    self._handle = stack.enter_context(open(part, "r+b"))  # noqa: SIM115
                    self._handle.seek(aligned)
                except OSError as error:
                    return self._fail_ack(_os_kind(error), f"打开 .part 失败：{error}")
                return self._finalize()
            try:
                self._handle = stack.enter_context(open(part, "r+b"))  # noqa: SIM115
                self._handle.seek(aligned)
            except OSError as error:
                return self._fail_ack(_os_kind(error), f"打开 .part 失败：{error}")
        return self._send_ack(meta.file_id, self._received, False, FileAckError.NONE)

    # ---- chunk ----

    def _handle_chunk(self, payload: bytes) -> FileAckPayload | None:
        """`file_chunk`：解帧 → 顺序/对齐/大小校验 → 落盘 → 收齐则校验收尾。"""
        meta = self._meta
        if meta is None:
            file_id = _extract_file_id(payload)
            if file_id is None:
                return None
            return self._send_ack(file_id, 0, False, FileAckError.PROTOCOL_ERROR)
        try:
            chunk = decode_file_chunk(payload)
        except FileTransferError as error:
            logger.debug("lansync file_chunk 解码失败：%s", error)
            return self._fail_ack(FileAckError.PROTOCOL_ERROR, str(error))
        if chunk.file_id != meta.file_id:
            return self._fail_ack(
                FileAckError.PROTOCOL_ERROR, f"块 fileID 不符：{chunk.file_id} != {meta.file_id}"
            )
        if chunk.offset != self._received:
            return self._fail_ack(
                FileAckError.PROTOCOL_ERROR, f"块 offset 不符：{chunk.offset} != {self._received}"
            )
        if chunk.offset % meta.chunk_size != 0:
            return self._fail_ack(FileAckError.PROTOCOL_ERROR, f"块 offset 未对齐：{chunk.offset}")
        size = len(chunk.data)
        if size == 0 or size > meta.chunk_size or size > meta.total_size - self._received:
            return self._fail_ack(
                FileAckError.PROTOCOL_ERROR,
                f"块长度非法：{size}（chunkSize={meta.chunk_size}，剩余={meta.total_size - self._received}）",
            )
        try:
            handle = self._handle
            if handle is None:  # pragma: no cover - 有 meta 必有句柄
                return self._fail_ack(FileAckError.IO_ERROR, ".part 未打开")
            handle.seek(self._received)
            handle.write(chunk.data)
            handle.flush()  # 落盘到 OS：断点续传依赖 .part 实际字节数
        except OSError as error:
            return self._fail_ack(_os_kind(error), f"写入 .part 失败：{error}")
        self._received += size
        if self._received == meta.total_size:
            return self._finalize()
        return self._send_ack(meta.file_id, self._received, False, FileAckError.NONE)

    # ---- 收尾 ----

    def _finalize(self) -> FileAckPayload | None:
        """整文件 SHA-256 → 相符则原子改名；不符则删 `.part` 并回 checksumMismatch。"""
        meta = self._meta
        part = self._part_path
        final = self._final_path
        if meta is None or part is None or final is None:  # pragma: no cover
            return None
        try:
            actual = sha256_file(part)
        except OSError as error:
            return self._fail_ack(_os_kind(error), f"读取 .part 失败：{error}")
        if actual != meta.sha256_hex.lower():
            self._close_handle()
            try:
                part.unlink(missing_ok=True)
            except OSError as error:  # pragma: no cover - 删除失败属异常路径
                logger.warning("lansync 删除坏 .part 失败：%s", error)
            fail = self._send_ack(meta.file_id, 0, False, FileAckError.CHECKSUM_MISMATCH)
            self._complete(
                FileTransferResult(
                    file_id=meta.file_id,
                    error=FileTransferErrorKind.CHECKSUM_MISMATCH,
                    detail=f"整文件 SHA-256 不符：{actual} != {meta.sha256_hex.lower()}",
                    received_bytes=0,
                    total_size=meta.total_size,
                )
            )
            self._reset()
            return fail
        try:
            self._close_handle()
            os.replace(part, final)  # 原子改名（目标已存在则替换）
        except OSError as error:
            fail = self._send_ack(meta.file_id, self._received, False, _os_kind(error))
            self._complete(
                FileTransferResult(
                    file_id=meta.file_id,
                    error=_os_kind(error),
                    detail=f"改名失败：{error}",
                    received_bytes=self._received,
                    total_size=meta.total_size,
                )
            )
            self._reset()  # `.part` 保留，可续传
            return fail
        ack = self._send_ack(meta.file_id, meta.total_size, True, FileAckError.NONE)
        self._complete(
            FileTransferResult(
                file_id=meta.file_id,
                received_bytes=meta.total_size,
                total_size=meta.total_size,
                sha256_hex=actual,
                target_path=final,
            )
        )
        self._reset()
        return ack

    def _complete_ready(self) -> FileAckPayload:
        """幂等命中 / 0 字节文件：直接 `done=true`（不发块、不重写）。"""
        meta = self._meta
        if meta is None:  # pragma: no cover
            raise FileTransferError(FileTransferErrorKind.IO_ERROR, "无活动传输")
        ack = self._send_ack(meta.file_id, meta.total_size, True, FileAckError.NONE)
        self._complete(
            FileTransferResult(
                file_id=meta.file_id,
                received_bytes=meta.total_size,
                total_size=meta.total_size,
                sha256_hex=meta.sha256_hex.lower(),
                target_path=self._final_path,
            )
        )
        self._reset()
        return ack

    # ---- 内部工具 ----

    def _committed_for(self, file_id: str) -> int:
        """坏/违例 meta 回 ack 时带的已收字节数（非本传输 = 0）。"""
        if self._meta is not None and self._meta.file_id == file_id:
            return self._received
        return 0

    def _fail_ack(self, error: FileAckError, detail: str) -> FileAckPayload:
        """协议违例 / IO 失败：回带错误的 ack 并中止本轮（`.part` 按 §10.5 处理）。"""
        meta = self._meta
        if meta is None:  # pragma: no cover
            raise FileTransferError(FileTransferErrorKind.IO_ERROR, "无活动传输")
        logger.debug("lansync 文件接收中止（fileID=%s）：%s", meta.file_id, detail)
        received = self._received
        if error is FileAckError.CHECKSUM_MISMATCH:
            received = 0
        ack = self._send_ack(meta.file_id, received, False, error)
        self._complete(
            FileTransferResult(
                file_id=meta.file_id,
                error=_ACK_ERROR_KINDS[error],
                detail=detail,
                received_bytes=received,
                total_size=meta.total_size,
            )
        )
        self._reset()
        return ack

    def _send_ack(
        self, file_id: str, received_bytes: int, done: bool, error: FileAckError
    ) -> FileAckPayload:
        """组装并发送 `file_ack`（发送回调异常仅记日志，不影响本层状态）。"""
        ack = FileAckPayload(file_id=file_id, received_bytes=received_bytes, done=done, error=error)
        try:
            self._send(FrameType.FILE_ACK, encode_file_ack(ack))
        except Exception as error_:  # noqa: BLE001 - 传输层异常不改变接收状态机
            logger.warning("lansync file_ack 发送失败（fileID=%s）：%s", file_id, error_)
        return ack

    def _complete(self, result: FileTransferResult) -> None:
        """终态通知（每轮恰一次）。"""
        callback = self._on_completion
        if callback is None:
            return
        try:
            callback(result)
        except Exception:  # noqa: BLE001 - 回调异常不影响本层状态机
            logger.exception("lansync 接收完成回调失败（fileID=%s）", result.file_id)

    def _close_handle(self) -> None:
        """关闭 `.part` 句柄（幂等；ExitStack 同时摘掉句柄引用）。"""
        stack = self._stack
        self._stack = None
        self._handle = None
        if stack is None:
            return
        try:
            stack.close()
        except OSError as error:  # pragma: no cover - 关闭失败无补救
            logger.warning("lansync 关闭 .part 失败：%s", error)

    def _reset(self) -> None:
        """清内存状态（**不删 `.part`**：断点续传依赖它）。"""
        self._close_handle()
        self._meta = None
        self._part_path = None
        self._final_path = None
        self._received = 0


def _os_kind(error: OSError) -> FileAckError:
    """OSError → 线上错误码（`ENOSPC` = 磁盘满，§10.3）。"""
    return FileAckError.DISK_FULL if error.errno == errno.ENOSPC else FileAckError.IO_ERROR
