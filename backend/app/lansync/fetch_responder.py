"""局域网同步（S2）Host 侧「按路径拉取」应答器（帧 12/13 + 4/5/6）。

对位 Swift `QQPlayer/Sync/SyncLibraryFetchResponder.swift`，线协议契约见
`docs/lan-sync-protocol.md` §11.4/§11.5/§11.6（帧 12 `sync_fetch_request` →
逐条推送 → 帧 13 `sync_fetch_result`）。

职责（本模块 = 帧 12/13 的应用层应答侧）：

1. 收 `sync_fetch_request`（12）→ 逐条解析请求路径（路径数学 + 磁盘三道校验）；
2. **串行**用 :class:`~app.lansync.filetransfer.FileSender` 推送能发的文件
   （帧 4/5/6 停等，由对端 `file_ack` 驱动；本层**不建定时器**，ack 超时由调用方
   按 :data:`~app.lansync.filetransfer.DEFAULT_ACK_TIMEOUT` 计时后调
   :meth:`SyncFetchResponder.handle_ack_timeout`）；
3. 全部走完回 `sync_fetch_result`（13）——**结果帧必发**（含空请求 / 全失败）；
   唯一例外是会话已断（结果帧发不出去，直接收尾，不推进）。

安全口径（§11.6 硬要求，本模块是执行点）：

- **越界一律拒读**：每条路径过 :func:`~app.lansync.locallib.resolve_library_file`
  四道闸（规范化拒空 / 绝对路径 / `..` → 根内包含性 → 存在且常规文件 → 解析软链后
  仍在根内），任一不过计入 `failed`，**绝不读曲库之外的文件**；
- **不静默跳过**：不存在 → `not_found`、非常规文件 → `not_regular_file`、
  越界 → `out_of_root`、路径非法 → `invalid_path`，全部如实计入结果帧；
- 请求方的**原始字符串**原样回填 `failed.relativePath`（便于对端定位）。

v1 单飞（与 Swift 一致）：一个应答器同时只服务一个请求，服务中收到新请求**忽略**。
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from .filetransfer import (
    FileSender,
    FileTransferError,
    FileTransferResult,
    decode_file_ack,
    sha256_file,
)
from .frame import FrameType
from .locallib import (
    REASON_INVALID_PATH,
    REASON_SEND_FAILED,
    ensure_content_hash,
    library_root,
    normalize_relative_path,
    resolve_library_file,
)
from .manifest import Collection

logger = logging.getLogger(__name__)

#: 会话在推送过程中关闭（结果帧发不出去；§11.5 取值，跨端字符串契约）
REASON_SESSION_CLOSED = "session_closed"
#: 本端主动取消（§11.5 取值；由调用方记账，应答器自身不发结果帧）
REASON_CANCELLED = "cancelled"


class FetchPayloadError(Exception):
    """帧 12/13 载荷结构非法（解码失败 = 协议违例；应答器记账后忽略该请求）。"""


class ApplicationSender(Protocol):
    """业务帧发送接口（生产 = :class:`~app.lansync.session.HostSession`；测试 = 桩）。"""

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发一帧加密业务帧（未 ready / 类型非法时抛错）。"""
        ...


# ============ 载荷（帧 12/13） ============
@dataclass(frozen=True, slots=True)
class FetchRequest:
    """`sync_fetch_request`（12）载荷（§11.4）：集合 + 显式点名的相对路径列表。"""

    collection: Collection
    relative_paths: tuple[str, ...]

    @classmethod
    def from_payload(cls, payload: bytes) -> FetchRequest:
        """帧 payload → 请求；坏 JSON / 字段缺失 / 未知集合类型 → `FetchPayloadError`。"""
        raw = _decode_json_object(payload, "sync_fetch_request")
        paths = raw.get("relativePaths")
        if isinstance(paths, (str, bytes)) or not isinstance(paths, (list, tuple)):
            raise FetchPayloadError("sync_fetch_request 缺 relativePaths 数组")
        raw_paths: list[str] = []
        for item in paths:
            if not isinstance(item, str):
                raise FetchPayloadError("sync_fetch_request 的 relativePaths 元素不是字符串")
            raw_paths.append(item)
        raw_collection = raw.get("collection")
        if raw_collection is not None and not isinstance(raw_collection, dict):
            raise FetchPayloadError("sync_fetch_request 的 collection 不是对象")
        try:
            collection = Collection.from_payload(raw_collection)
        except ValueError as error:
            raise FetchPayloadError(f"sync_fetch_request 的 collection 非法：{error}") from error
        return cls(collection=collection, relative_paths=tuple(raw_paths))

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（`{"collection", "relativePaths"}`）。"""
        return {
            "collection": self.collection.to_payload(),
            "relativePaths": list(self.relative_paths),
        }


@dataclass(frozen=True, slots=True)
class FetchFailure:
    """一条取文件失败记录（§11.5：`relativePath` 为请求方原始字符串）。"""

    relative_path: str
    reason: str

    def to_payload(self) -> dict[str, str]:
        """线上载荷（`{"relativePath", "reason"}`）。"""
        return {"relativePath": self.relative_path, "reason": self.reason}


@dataclass(frozen=True, slots=True)
class FetchResult:
    """`sync_fetch_result`（13）载荷（§11.5）：已送达 + 失败账目。"""

    completed: tuple[str, ...] = ()
    failed: tuple[FetchFailure, ...] = ()

    @classmethod
    def make(cls, completed: Iterable[str], failed: Iterable[FetchFailure]) -> FetchResult:
        """构造期归一：`completed` 排序去重；`failed` 按 `(relativePath, reason)` 升序。"""
        return cls(
            completed=tuple(sorted({str(item) for item in completed})),
            failed=tuple(sorted(failed, key=lambda item: (item.relative_path, item.reason))),
        )

    @property
    def is_full_success(self) -> bool:
        """全部成功（无失败记录）。"""
        return not self.failed

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（`{"completed", "failed"}`）。"""
        return {
            "completed": list(self.completed),
            "failed": [item.to_payload() for item in self.failed],
        }


def encode_fetch_request(request: FetchRequest) -> bytes:
    """帧 12 载荷编码（测试参考客户端与 Web 侧共用）。"""
    return _encode_json(request.to_payload())


def decode_fetch_request(payload: bytes) -> FetchRequest:
    """帧 12 载荷解码（= :meth:`FetchRequest.from_payload`）。"""
    return FetchRequest.from_payload(payload)


def encode_fetch_result(result: FetchResult) -> bytes:
    """帧 13 载荷编码。"""
    return _encode_json(result.to_payload())


def decode_fetch_result(payload: bytes) -> FetchResult:
    """帧 13 载荷解码（结构非法 → `FetchPayloadError`）。"""
    raw = _decode_json_object(payload, "sync_fetch_result")
    completed = raw.get("completed")
    failed = raw.get("failed")
    if isinstance(completed, (str, bytes)) or not isinstance(completed, (list, tuple)):
        raise FetchPayloadError("sync_fetch_result 缺 completed 数组")
    if isinstance(failed, (str, bytes)) or not isinstance(failed, (list, tuple)):
        raise FetchPayloadError("sync_fetch_result 缺 failed 数组")
    if any(not isinstance(item, str) for item in completed):
        raise FetchPayloadError("sync_fetch_result 的 completed 元素不是字符串")
    items: list[FetchFailure] = []
    for item in failed:
        if not isinstance(item, dict):
            raise FetchPayloadError("sync_fetch_result 的 failed 元素不是对象")
        path = item.get("relativePath")
        reason = item.get("reason")
        if not isinstance(path, str) or not isinstance(reason, str):
            raise FetchPayloadError("sync_fetch_result 的 failed 元素字段非法")
        items.append(FetchFailure(path, reason))
    return FetchResult.make(completed=completed, failed=items)


def _encode_json(payload: dict[str, Any]) -> bytes:
    """载荷字典 → JSON 字节（紧凑、UTF-8、不转义非 ASCII）。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _decode_json_object(payload: bytes, what: str) -> dict[str, Any]:
    """帧 payload → JSON 对象（坏 JSON / 非对象 → `FetchPayloadError`）。"""
    try:
        value = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise FetchPayloadError(f"{what} 不是合法 JSON：{error}") from error
    if not isinstance(value, dict):
        raise FetchPayloadError(f"{what} 不是 JSON 对象")
    return value


# ============ 解析计划（纯逻辑 + 只读磁盘检查） ============
@dataclass(frozen=True, slots=True)
class PlannedFile:
    """一条可推送的文件（`relative_path` 已规范化 = 结果帧 `completed` 的取值）。"""

    relative_path: str
    path: Path
    size: int = 0


@dataclass(frozen=True, slots=True)
class FetchPlan:
    """请求路径 → 能推的文件 + 一开始就注定失败的记录。"""

    files: tuple[PlannedFile, ...] = ()
    failures: tuple[FetchFailure, ...] = ()

    @property
    def total_bytes(self) -> int:
        """可推送文件的总字节数（进度分母；取不到大小按 0 计）。"""
        return sum(max(0, item.size) for item in self.files)


def build_plan(relative_paths: Sequence[str], *, root: Any = None) -> FetchPlan:
    """请求路径列表 → :class:`FetchPlan`（**不读根外文件**，§11.6）。

    去重口径（与 Swift `makePlan` 一致）：能解析的按**规范化相对路径**判重
    （`song.flac` 与 `./song.flac` 视为同一文件），解析即被拒的按**原始字符串**判重；
    重复请求只处理一次，且不重复记账。
    """
    root_path = library_root(root)
    files: list[PlannedFile] = []
    failures: list[FetchFailure] = []
    seen_keys: set[str] = set()
    seen_rejected: set[str] = set()

    def reject(raw: str, reason: str) -> None:
        if raw in seen_rejected:
            return
        seen_rejected.add(raw)
        failures.append(FetchFailure(raw, reason))

    for raw in relative_paths or ():
        raw_str = raw if isinstance(raw, str) else str(raw)
        normalized = normalize_relative_path(raw_str)
        key = normalized if normalized is not None else raw_str
        if key in seen_keys:
            continue
        seen_keys.add(key)
        resolution = resolve_library_file(raw_str, root=root_path)
        if not resolution.ok or normalized is None or resolution.path is None:
            reject(raw_str, resolution.reason or REASON_INVALID_PATH)
            continue
        try:
            size = resolution.path.stat().st_size
        except OSError:
            size = 0
        files.append(PlannedFile(relative_path=normalized, path=resolution.path, size=size))
    return FetchPlan(files=tuple(files), failures=tuple(failures))


# ============ 进度 ============
@dataclass(frozen=True, slots=True)
class FetchProgress:
    """逐条发送进度（`on_progress` 回调载荷；字节单位）。"""

    relative_path: str
    sent_bytes: int
    total_bytes: int
    index: int
    file_count: int
    sent_total_bytes: int
    total_bytes_all: int

    @property
    def fraction(self) -> float:
        """本轮整体进度（0.0 ~ 1.0；分母为 0 时按 1.0）。"""
        if self.total_bytes_all <= 0:
            return 1.0
        return min(1.0, max(0.0, self.sent_total_bytes / self.total_bytes_all))

    def to_dict(self) -> dict[str, Any]:
        """事件 / UI 字典（camelCase，与其它 lansync 事件同风格）。"""
        return {
            "relativePath": self.relative_path,
            "sentBytes": int(self.sent_bytes),
            "totalBytes": int(self.total_bytes),
            "index": int(self.index),
            "fileCount": int(self.file_count),
            "sentTotalBytes": int(self.sent_total_bytes),
            "totalBytesAll": int(self.total_bytes_all),
            "fraction": self.fraction,
        }


@dataclass(slots=True)
class _Serving:
    """一轮服务中的状态（单飞：永远只服务一个请求）。"""

    remaining: list[PlannedFile]
    completed: list[str] = field(default_factory=list)
    failures: list[FetchFailure] = field(default_factory=list)
    current: PlannedFile | None = None
    dispatched: int = 0
    planned_bytes: int = 0
    finished_bytes: int = 0


# ============ 应答器 ============
class SyncFetchResponder:
    """Host 侧「按路径拉取」应答器（一连接一个实例；帧驱动、无内部定时器）。

    用法（会话应用帧回调里）::

        responder = SyncFetchResponder(session, on_progress=..., on_result=...)
        # 会话 ready 后每来一帧：
        if not responder.handle_application_frame(frame_type, payload):
            ...  # 不是本模块的帧，交给其它 handler
        # 会话关闭：
        responder.handle_session_closed()
    """

    def __init__(
        self,
        session: ApplicationSender,
        *,
        root: Any = None,
        content_hash_provider: Callable[[str], str | None] | None = None,
        on_progress: Callable[[FetchProgress], None] | None = None,
        on_result: Callable[[FetchResult], None] | None = None,
        on_decode_failure: Callable[[str], None] | None = None,
    ) -> None:
        """`root` = 曲库根（缺省 `state.LIBRARY`）；`content_hash_provider` = 相对路径 →
        内容指纹（缺省走 `ensure_content_hash`，取不到时回落现算文件 SHA-256）。"""
        self._session = session
        self._root = root
        self._content_hash_provider = content_hash_provider
        self._on_progress = on_progress
        self._on_result = on_result
        self._on_decode_failure = on_decode_failure

        self._serving: _Serving | None = None
        self._sender: FileSender | None = None
        self._pumping = False

    # ---------------------------------------------------------------- 查询

    @property
    def is_serving(self) -> bool:
        """是否正在服务一个请求（诊断 / 测试用）。"""
        return self._serving is not None

    @property
    def current_path(self) -> str | None:
        """当前正在推送的相对路径（空闲 = None）。"""
        serving = self._serving
        if serving is None or serving.current is None:
            return None
        return serving.current.relative_path

    @property
    def is_awaiting_ack(self) -> bool:
        """是否在等对端 `file_ack`（调用方可据此挂 ack 超时定时器）。"""
        return self._sender is not None and self._sender.is_awaiting_ack

    # ---------------------------------------------------------------- 帧入口

    def handle_application_frame(self, frame_type: int, payload: bytes) -> bool:
        """推入一帧；返回 True = 本模块已消费（调用方不再转交其它 handler）。"""
        if frame_type == FrameType.SYNC_FETCH_REQUEST:
            self._handle_request(payload)
            return True
        if frame_type == FrameType.FILE_ACK and self._serving is not None:
            return self._handle_ack(payload)
        return False

    def handle_ack_timeout(self) -> bool:
        """ack 超时（调用方计时后调用）；真值 = 当前文件本轮已终结。"""
        sender = self._sender
        if sender is None:
            return False
        return sender.handle_ack_timeout()

    def cancel(self) -> None:
        """中止当前服务（停止发帧，**不再回结果帧**）；空闲时无操作。"""
        sender, self._sender = self._sender, None
        self._serving = None
        if sender is not None:
            sender.cancel()

    def handle_session_closed(self) -> None:
        """会话关闭：清服务态、中止在途传输（结果帧发不出去，直接收尾）。"""
        sender, self._sender = self._sender, None
        self._serving = None
        if sender is not None:
            sender.handle_session_closed()

    # ------------------------------------------------------------ 请求处理

    def _handle_request(self, payload: bytes) -> None:
        """收 `sync_fetch_request`：解码失败记账并忽略；服务中（单飞）忽略新请求。"""
        try:
            request = FetchRequest.from_payload(payload)
        except FetchPayloadError as error:
            logger.debug("lansync sync_fetch_request 解码失败：%s", error)
            if self._on_decode_failure is not None:
                self._notify(self._on_decode_failure, str(error))
            return
        if self._serving is not None:
            logger.debug("lansync 应答器服务中，忽略新的 sync_fetch_request")
            return
        plan = build_plan(request.relative_paths, root=self._root)
        self._serving = _Serving(
            remaining=list(plan.files),
            failures=list(plan.failures),
            planned_bytes=plan.total_bytes,
        )
        self._pump()

    def _handle_ack(self, payload: bytes) -> bool:
        """`file_ack`：报进度 → 交给发送端判定；非本传输的 ack 不消费。"""
        sender = self._sender
        if sender is None:
            return False
        try:
            ack = decode_file_ack(payload)
        except FileTransferError as error:
            logger.debug("lansync file_ack 解码失败：%s", error)
            sender.handle_frame(FrameType.FILE_ACK, payload)
            return True
        if not sender.file_id or ack.file_id != sender.file_id:
            return False  # 别的传输的 ack：留给其它 handler
        self._report_progress(ack.received_bytes)
        sender.handle_frame(FrameType.FILE_ACK, payload)
        return True

    # ------------------------------------------------------------ 串行推进

    def _pump(self) -> None:
        """驱动队列：给空闲的传输喂下一个文件；没有剩余 → 回结果帧收尾。

        `_pumping` 防重入：内存回环下 `sender.begin()` 会同步跑完整轮传输，完成回调
        里的 `_pump()` 必须让位给本循环（否则递归推进 / 双发）。
        """
        if self._pumping:
            return
        self._pumping = True
        try:
            while True:
                serving = self._serving
                if serving is None:
                    return
                if not serving.remaining:
                    serving.current = None
                    self._serving = None  # 先摘服务态：终态回调不得再推进
                    self._finish_round(serving)
                    continue  # 重入的新请求（回环）由下一轮循环接管；无则退出
                planned = serving.remaining.pop(0)
                serving.current = planned
                serving.dispatched += 1
                if not self._start_transfer(planned):
                    continue  # 已记账，接着下一个
                sender = self._sender
                if sender is not None and sender.is_active:
                    return  # 等对端 ack
        finally:
            self._pumping = False

    def _start_transfer(self, planned: PlannedFile) -> bool:
        """为一条文件起一轮停等传输；起不来（无指纹 / 文件不可用）→ 记账 + False。"""
        file_id = self._file_id_for(planned)
        if not file_id:
            self._record_failure(planned.relative_path, REASON_SEND_FAILED, "无法确定 fileID")
            return False
        sender = FileSender(
            planned.path,
            file_id=file_id,
            send=self._send_frame,
            display_name=planned.path.name,
            on_completion=self._on_sender_completion,
        )
        self._sender = sender
        try:
            meta = sender.begin()
        except FileTransferError as error:
            self._sender = None
            self._record_failure(planned.relative_path, REASON_SEND_FAILED, str(error))
            return False
        self._report_progress(0, total=meta.total_size)
        return True

    def _file_id_for(self, planned: PlannedFile) -> str | None:
        """传输身份（§11.6）：content_hash（缺失则现算 SHA-256）。"""
        provider = self._content_hash_provider
        if provider is not None:
            try:
                provided = provider(planned.relative_path)
            except Exception:  # noqa: BLE001 - 指纹提供方异常不阻断取文件
                logger.warning("lansync 指纹提供方异常：%s", planned.relative_path, exc_info=True)
                provided = None
            if provided:
                return provided
        else:
            provided = ensure_content_hash(planned.relative_path, root=self._root)
            if provided:
                return provided
        try:
            return sha256_file(planned.path)
        except OSError:
            return None

    def _on_sender_completion(self, result: FileTransferResult) -> None:
        """一轮传输终态（FileSender 回调；可能在本层 `_pump` 内同步触发）。"""
        serving = self._serving
        if serving is None or serving.current is None:
            return
        current = serving.current
        serving.current = None
        if result.ok:
            serving.completed.append(current.relative_path)
            serving.finished_bytes += max(0, result.total_size)
            self._report_progress(result.total_size, total=result.total_size)
        else:
            serving.failures.append(FetchFailure(current.relative_path, REASON_SEND_FAILED))
            serving.finished_bytes += max(0, result.received_bytes)
            logger.debug(
                "lansync 取文件传输失败（%s）：%s",
                current.relative_path,
                result.detail or (result.error.value if result.error else ""),
            )
        self._pump()

    def _record_failure(self, relative_path: str, reason: str, detail: str = "") -> None:
        """记一条失败（路径已规范化；调度失败与传输失败共用）。"""
        serving = self._serving
        if serving is None:
            return
        serving.failures.append(FetchFailure(relative_path, reason))
        if detail:
            logger.debug("lansync 取文件失败（%s）：%s", relative_path, detail)

    def _finish_round(self, serving: _Serving) -> None:
        """回 `sync_fetch_result`（必发，含空请求 / 全失败）+ 通知调用方。"""
        result = FetchResult.make(completed=serving.completed, failed=serving.failures)
        try:
            self._session.send_application_frame(
                FrameType.SYNC_FETCH_RESULT, encode_fetch_result(result)
            )
        except Exception as error:  # noqa: BLE001 - 会话已断：结果帧发不出去，直接收尾
            logger.warning("lansync sync_fetch_result 发送失败：%s", error)
        if self._on_result is not None:
            self._notify(self._on_result, result)

    def _report_progress(self, current_received: int, *, total: int | None = None) -> None:
        """报一条进度事件（无回调 / 空闲 = 无操作）。"""
        serving = self._serving
        callback = self._on_progress
        if serving is None or serving.current is None or callback is None:
            return
        current = serving.current
        total_bytes = max(0, total if total is not None else current.size)
        received = max(0, current_received)
        sent = min(received, total_bytes) if total_bytes else received
        progress = FetchProgress(
            relative_path=current.relative_path,
            sent_bytes=sent,
            total_bytes=total_bytes,
            index=serving.dispatched,
            file_count=serving.dispatched + len(serving.remaining),
            sent_total_bytes=serving.finished_bytes + sent,
            total_bytes_all=serving.planned_bytes,
        )
        self._notify(callback, progress)

    def _send_frame(self, frame_type: int, payload: bytes) -> None:
        """业务帧发送回调（交给会话层加密发送）。"""
        self._session.send_application_frame(frame_type, payload)

    def _notify(self, callback: Callable[[Any], None], value: Any) -> None:
        """回调异常不得影响应答器状态机（与其它 lansync 回调契约一致）。"""
        try:
            callback(value)
        except Exception:  # noqa: BLE001
            logger.exception("lansync 应答器回调失败")
