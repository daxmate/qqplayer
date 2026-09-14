"""局域网同步（S2）Host 侧「推送到设备」编排（帧 10/11 → 14 → 4/5/6）。

帧序以**现役 iOS 被动端（Swift）为事实标准**（`QQPlayer/Sync/SyncLibraryPushController.swift`）：

    Host（发起方）                                   设备（被动端）
      |-- manifest_request(10) {collection} ------------->|
      |<-- manifest_response(11) {entries, rootName} -----|  对端曲库快照
      |  推送方向对账（以本端选择集为准）：
      |    对端缺该路径 / 内容不同 / 任一侧无指纹 → 推
      |    同路径 content_hash 相同 → 跳过
      |    对端多出来的条目 → 什么都不做（**不传播删除**）
      |  无可推条目 → 不发声明，直接 done
      |-- library_push_announce(14) {entries:[…]} ------->|  建认领表（声明全部落点）
      |                                                       **对端不回任何帧**
      |-- file_meta(4) / file_chunk(5) ------------------>|  接收 → 认领 → 落位 → 入库
      |<-- file_ack(6) {done=true} -----------------------|  ← 逐文件的**唯一送达凭据**
      |   按声明序**串行**推送下一个文件（停等，一次一个）……
      |  队列清空 → done（summary：planned / skipped / completed / failed）

**推送路径没有结束帧**：发送端**不等**对端发帧 12、也**不发**帧 13；送达凭据是每个文件的
`file_ack` `done=true`（Swift `SyncLibraryPushController.swift:19-22`、`:452-474` 的
`handleSendOutcome` → `completed.append`，`pump()` 队列清空 → `.done`，`:399-449`）。
帧 12 只存在于**拉取**方向（`SyncLibraryPullController.swift:331`），其应答器是
:mod:`app.lansync.fetch_responder`——它与本模块互不相干，仍按原样保留。

职责边界：

- **只做编排**：选择集 → 本地 manifest 条目 → 与对端快照对账 → 声明 → 本端串行推文件
  （帧 4/5/6 交给 :class:`~app.lansync.filetransfer.FileSender`）→ 汇总统计；
- **进度 / 账目**：全程产出事件（`on_event` 回调，service 层转 `EventType.PUSH`），
  同时维护可查询的状态对象（:meth:`LibraryPushRun.status`）；
- **不碰字节、不碰路径安全**：文件帧收发在 `filetransfer`，路径闸在 `locallib`，
  线上契约与纯逻辑在 :mod:`app.lansync.push_models`。

硬约束（§12b 决策 6/7）：

- **发起方恒为 Host**（web/Qt 桌面端）；设备只被动收；
- **不传播删除**：对端多出来的条目什么都不做，协议里不存在删除指令；
- **对端已有（同路径同内容）不重发**：对账用 `content_hash`（任一侧无指纹 = 保守推送）——
  这是**发送端**的判定（Swift `SyncLibraryPushPlanner.plan(local:remote:)`，
  `SyncLibraryPushController.swift:136-165`，调用点 `:292`），不是设备端回执；
- **歌单同步 = 缺歌自动补齐**：选择集（歌单 / 收藏 / `@smart:*` / 显式单曲集）的成员
  即「目标端应有」的集合，成员在目标端缺失 → 推送。

ack 超时：本层不持时钟（与 `filetransfer` 同一分层口径），由持有事件循环的 service 层按
:data:`~app.lansync.filetransfer.DEFAULT_ACK_TIMEOUT`（对位 Swift
`SyncFileSender.defaultAckTimeout = 30`，`SyncFileSender.swift:79`）挂定时器后调
:meth:`LibraryPushRun.handle_ack_timeout`——对端不回 ack → 该文件落失败、**自动推进下一个**、
:meth:`LibraryPushRun.is_awaiting_ack` 供调用方重挂定时器。
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from .fetch_responder import FetchProgress
from .filetransfer import (
    DEFAULT_ACK_TIMEOUT,
    FileSender,
    FileTransferError,
    FileTransferResult,
    decode_file_ack,
)
from .frame import FrameType
from .locallib import (
    REASON_INVALID_PATH,
    resolve_library_file,
)
from .manifest import Collection, ManifestEntry, manifest_entries
from .push_models import (
    REASON_CANCELLED,
    REASON_LOCAL_FILE_UNAVAILABLE,
    REASON_SESSION_CLOSED,
    LibraryPushSummary,
    PushEntry,
    PushError,
    PushFailure,
    as_collection,
    build_push_entry,
    decode_manifest_response,
    encode_manifest_request,
    encode_push_announce,
    normalize_announce_entries,
    push_plan,
)

logger = logging.getLogger(__name__)

__all__ = [
    "LibraryPushRun",
    "LibraryPushSummary",
    "PushEntry",
    "PushError",
    "PushFailure",
    "PushState",
    "can_transition",
    "REASON_CANCELLED",
    "REASON_INVALID_PATH",
    "REASON_LOCAL_FILE_UNAVAILABLE",
    "REASON_SESSION_CLOSED",
    "REASON_SEND_FAILED",
]

#: 推送侧传输失败原因（线上字符串契约与 Swift `SyncPushFailureReason.sendFailed` 同值）
REASON_SEND_FAILED = "send_failed"


class PushState(str, Enum):
    """推送状态机（线上字符串与 Swift `SyncLibraryPushState` 同名）。"""

    IDLE = "idle"
    REQUESTING_MANIFEST = "requestingManifest"
    PUSHING = "pushing"
    DONE = "done"
    FAILED = "failed"


def can_transition(current: PushState, new: PushState) -> bool:
    """状态迁移合法性（纯逻辑；与 Swift `SyncLibraryPushStateMachine.canTransition` 同判据）。

    - `idle → requestingManifest`；
    - `requestingManifest → done`（全部已一致 / 无可发送内容）；`requestingManifest → pushing`；
    - `pushing → done`（队列清空 = 本轮收尾）；
    - 任意非终态 → `failed`；终态不再迁移。
    """
    if new is PushState.FAILED:
        return current not in (PushState.DONE, PushState.FAILED)
    if new is PushState.DONE:
        return current in (PushState.REQUESTING_MANIFEST, PushState.PUSHING)
    if new is PushState.PUSHING:
        return current is PushState.REQUESTING_MANIFEST
    if new is PushState.REQUESTING_MANIFEST:
        return current is PushState.IDLE
    return False


class ApplicationSender(Protocol):
    """业务帧发送 / 就绪查询接口（生产 = `HostSession`；测试 = 桩）。"""

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发一帧加密业务帧。"""
        ...

    @property
    def is_ready(self) -> bool:
        """会话是否已就绪。"""
        ...


@dataclass(frozen=True, slots=True)
class _PendingPush:
    """发送队列里的一条：声明条目 + 本端可发送文件路径（对位 Swift `PendingPush`）。"""

    entry: PushEntry
    path: Path


# ============ 推送编排 ============
class LibraryPushRun:
    """一次「推送到设备」的运行实例（帧驱动；一连接一实例，与 Swift 控制器同构）。

    生命周期：``start()`` 发 manifest 请求 → 收帧 11 → 对账 + 发帧 14 → **本端串行推
    4/5/6**（逐文件停等 `file_ack`）→ 队列清空即 `done`。终态后 `status()` 仍可查询。
    """

    def __init__(
        self,
        session: ApplicationSender,
        *,
        selection: Collection | Mapping[str, Any] | None = None,
        root: Any = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        run_id: str | None = None,
        ack_timeout: float = DEFAULT_ACK_TIMEOUT,
    ) -> None:
        """`selection` = 选择集（`Collection` 或线上字典；缺省全库）。

        `on_event` = 进度 / 状态事件回调（service 层转 `EventType.PUSH`）。
        `ack_timeout` = 等单条 `file_ack` 的超时秒数（0 = 禁用；调用方据此挂定时器）。
        """
        self.run_id = run_id or uuid.uuid4().hex
        self.ack_timeout = float(ack_timeout)
        self._session = session
        self._root = root
        self._selection = as_collection(selection)
        self._on_event = on_event

        self._state = PushState.IDLE
        self._error: str | None = None
        self._summary = LibraryPushSummary()
        self._sent_bytes = 0
        self._total_bytes = 0
        self._finished_bytes = 0
        self._dispatched = 0
        #: 待推送队列（已按声明顺序排好）
        self._queue: list[_PendingPush] = []
        self._peer_entries: tuple[ManifestEntry, ...] = ()
        self._sender: FileSender | None = None
        self._current: PushEntry | None = None
        #: 在途文件总字节（进度分母；`_handle_ack` 报进度时用）
        self._current_total = 0
        #: 队列驱动中标志（防内存回环同步完成导致的递归 / 重入）
        self._pumping = False

    # ---------------------------------------------------------------- 查询

    @property
    def state(self) -> PushState:
        """当前状态。"""
        return self._state

    @property
    def peer_id(self) -> str | None:
        """对端 Device ID（会话侧事实）。"""
        return getattr(self._session, "peer_device_id", None)

    @property
    def session_id(self) -> str | None:
        """会话 ID（service 定位 / 诊断用）。"""
        return getattr(self._session, "session_id", None)

    @property
    def selection(self) -> Collection:
        """本次选择集。"""
        return self._selection

    @property
    def is_terminal(self) -> bool:
        """是否已到终态（done / failed）。"""
        return self._state in (PushState.DONE, PushState.FAILED)

    @property
    def is_awaiting_ack(self) -> bool:
        """是否在等对端 `file_ack`（service 层据此挂 / 摘 ack 超时定时器）。"""
        sender = self._sender
        return sender is not None and sender.is_awaiting_ack

    @property
    def summary(self) -> LibraryPushSummary:
        """结果账目（实时值）。"""
        return self._summary

    @property
    def peer_entries(self) -> tuple[ManifestEntry, ...]:
        """本轮拿到的**对端 manifest 条目**（未拿到 = 空）。

        给「跟歌走」的配对判据用（§14.9：对端持有的 `content_hash` 集合）——
        不为此重建一次 manifest 请求。
        """
        return self._peer_entries

    def status(self) -> dict[str, Any]:
        """可查询状态对象（`push_status` 返回值；键名 camelCase）。"""
        payload: dict[str, Any] = {
            "run_id": self.run_id,
            "peer_id": self.peer_id,
            "session_id": self.session_id,
            "state": self._state.value,
            "selection": self._selection.to_payload(),
            "sentBytes": self._sent_bytes,
            "totalBytes": self._total_bytes,
            **self._summary.to_dict(),
        }
        if self._error:
            payload["error"] = self._error
        return payload

    # ---------------------------------------------------------------- 驱动

    def start(self) -> None:
        """开始一次推送：置 `requestingManifest` 并发 `manifest_request`(10)。

        会话未 ready / 发送失败 → `PushError`（状态落 `failed`）。
        """
        if not getattr(self._session, "is_ready", False):
            raise PushError("会话未就绪，无法推送")
        self._transition(PushState.REQUESTING_MANIFEST)
        try:
            self._session.send_application_frame(
                FrameType.MANIFEST_REQUEST, encode_manifest_request(Collection.all())
            )
        except Exception as error:  # noqa: BLE001 - 发送失败 = 本次推送失败
            self._fail(f"请求对端 manifest 失败：{error}")
            raise PushError(f"请求对端 manifest 失败：{error}") from error

    def handle_application_frame(self, frame_type: int, payload: bytes) -> bool:
        """推入一帧；返回 True = 本次推送已消费（service 不再转交其它 handler）。

        - 帧 11（对端曲库快照）→ 对账 + 声明 + 开始推送；
        - 帧 6（`file_ack`）→ 驱动在途传输（无在途传输时**不消费**，交回调用方）；
        - 帧 12/13 **不在推送链上**：不消费（帧 12 属拉取路径，由取文件应答器应答）。
        """
        if frame_type == FrameType.MANIFEST_RESPONSE:
            self._handle_manifest_response(payload)
            return True
        if frame_type == FrameType.FILE_ACK:
            return self._handle_ack(payload)
        return False

    def cancel(self) -> bool:
        """本端取消（终态后 = False）：先落终态（不再推进队列），再中止在途传输。"""
        if self.is_terminal:
            return False
        self._fail(REASON_CANCELLED)
        sender, self._sender = self._sender, None
        self._current = None
        self._queue = []
        if sender is not None:
            sender.cancel()
        return True

    def handle_session_closed(self) -> None:
        """会话关闭：中止在途传输；未终态 → 落 `failed`（原因 `session_closed`）。"""
        if not self.is_terminal:
            self._fail(REASON_SESSION_CLOSED)
        sender, self._sender = self._sender, None
        self._current = None
        self._queue = []
        if sender is not None:
            sender.handle_session_closed()

    def handle_ack_timeout(self) -> bool:
        """ack 超时（调用方按 :data:`~app.lansync.filetransfer.DEFAULT_ACK_TIMEOUT` 计时后调用）。

        真值 = 当前文件的传输已终结（该文件落失败，队列**自动推进下一个**）——
        不留「停在等 ack 不自愈」的悬挂态（对齐 Swift ack 超时语义，
        `SyncFileSender.swift:258-277`）。
        """
        sender = self._sender
        if sender is None:
            return False
        return sender.handle_ack_timeout()

    # ------------------------------------------------------------ 内部推进

    def _handle_manifest_response(self, payload: bytes) -> None:
        """对端曲库快照 → 推送方向对账 → 声明 → 建队列 → `pushing`。"""
        if self._state is not PushState.REQUESTING_MANIFEST:
            return  # 迟到的 / 重复的响应：忽略（不改状态）
        try:
            remote_entries, _root_name = decode_manifest_response(payload)
        except PushError as error:
            self._fail(f"manifest_response 载荷非法：{error}")
            return
        self._peer_entries = tuple(remote_entries)
        try:
            local_entries = manifest_entries(self._selection, root=self._root)
        except Exception as error:  # noqa: BLE001 - 本端曲库事实不可用 = 本次推送失败
            self._fail(f"生成本端清单失败：{error}")
            return
        plan = push_plan(local_entries, remote_entries)

        entries: list[PushEntry] = []
        queue: list[_PendingPush] = []
        failures: list[PushFailure] = []
        for entry in plan.to_push:
            built = build_push_entry(self._root, entry)
            if built is None:
                failures.append(PushFailure(entry.relative_path, REASON_LOCAL_FILE_UNAVAILABLE))
                continue
            # 发送前的路径闸（纵深防御：越界 / 软链逃逸一律不传，§11.6 同一套闸）
            resolution = resolve_library_file(entry.relative_path, root=self._root)
            if not resolution.ok or resolution.path is None:
                failures.append(
                    PushFailure(
                        entry.relative_path,
                        REASON_LOCAL_FILE_UNAVAILABLE,
                        f"本端路径解析被拒：{resolution.reason}",
                    )
                )
                continue
            entries.append(built)
            queue.append(_PendingPush(entry=built, path=resolution.path))

        announce = normalize_announce_entries(entries)
        announced = {entry.relative_path for entry in announce}
        for entry in entries:
            if entry.relative_path not in announced:  # 结构非法被丢弃：如实记账
                failures.append(
                    PushFailure(entry.relative_path, REASON_INVALID_PATH, "声明结构校验未通过")
                )
        queue = [item for item in queue if item.entry.relative_path in announced]

        self._summary.planned = [entry.relative_path for entry in announce]
        self._summary.skipped = [entry.relative_path for entry in plan.unchanged]
        self._summary.failed = list(failures)

        if not announce:
            # 全部已一致 / 无可发送内容：**不发声明**，直接收尾（§12.2）
            self._transition(PushState.DONE)
            return
        try:
            self._session.send_application_frame(
                FrameType.LIBRARY_PUSH_ANNOUNCE, encode_push_announce(announce)
            )
        except Exception as error:  # noqa: BLE001
            self._fail(f"发送推送声明失败：{error}")
            return
        self._total_bytes = sum(max(0, entry.size) for entry in announce)
        self._queue = queue
        self._transition(PushState.PUSHING)
        self._pump()

    def _handle_ack(self, payload: bytes) -> bool:
        """`file_ack`：先报进度 → 交给发送端判定；非本传输的 ack 不消费。"""
        sender = self._sender
        if sender is None or not sender.is_active:
            return False  # 无在途传输：不是本运行的帧（交回调用方）
        try:
            ack = decode_file_ack(payload)
        except FileTransferError as error:
            logger.debug("lansync 推送 file_ack 解码失败：%s", error)
            sender.handle_frame(FrameType.FILE_ACK, payload)  # → 协议违例终态
            return True
        if ack.file_id != sender.file_id:
            return False  # 别的传输的 ack：留给其它 handler
        self._report_progress(sender.file_id, ack.received_bytes, total=self._current_total)
        sender.handle_frame(FrameType.FILE_ACK, payload)
        return True

    def _pump(self) -> None:
        """驱动队列：给空闲的发送端喂下一个文件；队列清空 → `done`。

        `_pumping` 防重入：内存回环下 `sender.begin()` 会同步跑完整轮传输，完成回调里的
        `_pump()` 必须让位给本循环（否则递归推进 / 双发）。
        """
        if self._pumping:
            return
        self._pumping = True
        try:
            while True:
                if self._state is not PushState.PUSHING:
                    return
                pending = self._queue.pop(0) if self._queue else None
                if pending is None:
                    self._sent_bytes = self._total_bytes
                    self._transition(PushState.DONE)
                    return
                if not self._start_transfer(pending):
                    continue  # 已记账，接着下一个
                sender = self._sender
                if sender is not None and sender.is_active:
                    return  # 等对端 ack
        finally:
            self._pumping = False

    def _start_transfer(self, pending: _PendingPush) -> bool:
        """为一条文件起一轮停等传输（帧 4/5/6，逐文件停等）；起不来 → 记账 + False。"""
        sender = FileSender(
            pending.path,
            file_id=pending.entry.file_id,
            send=self._send_frame,
            display_name=pending.entry.transfer_name,
            on_completion=self._handle_transfer,
        )
        self._sender = sender
        self._current = pending.entry
        self._dispatched += 1
        try:
            meta = sender.begin()
        except FileTransferError as error:
            self._sender = None
            self._current = None
            self._record_failure(pending.entry.relative_path, REASON_SEND_FAILED, str(error))
            return False
        self._current_total = meta.total_size
        self._report_progress(pending.entry.relative_path, 0, total=meta.total_size)
        return True

    def _handle_transfer(self, result: FileTransferResult) -> None:
        """一轮传输终态（`FileSender` 回调；可能在本层 `_pump` 内同步触发）。

        成功 = 对端 `file_ack` `done=true`（唯一送达凭据）；失败 = 该文件落失败账目，
        队列照常推进（一个文件失败不阻塞后续）。
        """
        if self.is_terminal:
            return  # 终态后的迟到结论：不再推进
        entry = self._current
        self._sender = None
        self._current = None
        self._current_total = 0
        if entry is not None:
            if result.ok:
                self._summary.completed.append(entry.relative_path)
                self._finished_bytes += max(0, result.total_size)
                self._report_progress(
                    entry.relative_path, result.total_size, total=result.total_size
                )
            else:
                self._record_failure(
                    entry.relative_path,
                    REASON_SEND_FAILED,
                    result.detail or (result.error.value if result.error is not None else None),
                )
        self._pump()

    def _record_failure(self, relative_path: str, reason: str, detail: str | None = None) -> None:
        """记一条失败并产出事件（不静默；一个文件失败不影响后续文件的推送）。"""
        self._summary.failed.append(PushFailure(relative_path, reason, detail))
        self._emit({})

    def _report_progress(
        self, relative_path: str, received: int, *, total: int | None = None
    ) -> None:
        """报一条进度事件（逐条发送字节 / 总字节 + 累计）。"""
        total_bytes = max(0, total if total is not None else 0)
        sent = min(max(0, received), total_bytes) if total_bytes else max(0, received)
        cumulative = self._finished_bytes + sent
        self._sent_bytes = max(self._sent_bytes, cumulative)
        progress = FetchProgress(
            relative_path=relative_path,
            sent_bytes=sent,
            total_bytes=total_bytes,
            index=self._dispatched,
            file_count=self._dispatched + len(self._queue),
            sent_total_bytes=cumulative,
            total_bytes_all=self._total_bytes,
        )
        self._emit({"path": relative_path, **progress.to_dict()})

    def _send_frame(self, frame_type: int, payload: bytes) -> None:
        """业务帧发送回调（交给会话层加密发送）。"""
        self._session.send_application_frame(frame_type, payload)

    def _transition(self, state: PushState) -> None:
        """状态迁移 + 事件（终态含完整账目；非法迁移一律忽略，不改状态）。"""
        if not can_transition(self._state, state):
            return
        self._state = state
        self._emit({})

    def _fail(self, error: str) -> None:
        """落失败态（原因如实记录，不静默；终态后调用 = 无操作）。"""
        if self.is_terminal:
            return
        self._error = error
        self._transition(PushState.FAILED)

    def _emit(self, extra: Mapping[str, Any]) -> None:
        """产出事件 / 进度（回调异常不影响状态机）。"""
        callback = self._on_event
        if callback is None:
            return
        payload: dict[str, Any] = {
            "run_id": self.run_id,
            "peer_id": self.peer_id,
            "state": self._state.value,
            "sentBytes": self._sent_bytes,
            "totalBytes": self._total_bytes,
            **self._summary.to_dict(),
        }
        payload.update(extra)
        try:
            callback(payload)
        except Exception:  # noqa: BLE001 - 事件回调异常不得中断编排
            logger.exception("lansync 推送事件回调失败（run=%s）", self.run_id)
