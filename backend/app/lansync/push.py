"""局域网同步（S2）Host 侧「推送到设备」编排（帧 10/11 → 14 → 12 → 4/5/6 → 13）。

语义依据（`docs/lan-sync-protocol.md` §12 推送声明 + §11 按路径拉取；Swift 参考
`QQPlayer/Sync/SyncLibraryPushController.swift`）：

    Host（发起方）                                   设备（被动端）
      |-- manifest_request(10) {collection} ------------->|
      |<-- manifest_response(11) {entries, rootName} -----|  对端曲库快照
      |  推送方向对账（以本端选择集为准）：
      |    对端缺该路径 / 内容不同 / 任一侧无指纹 → 推
      |    同路径 content_hash 相同 → 跳过
      |    对端多出来的条目 → 什么都不做（**不传播删除**）
      |  无可推条目 → 不发声明，直接 done
      |-- library_push_announce(14) {entries:[…]} ------->|  建认领表（声明全部落点）
      |<-- sync_fetch_request(12) {collection,paths} -----|  按声明点名要文件
      |   逐条串行推送（帧 4/5/6 停等）……
      |-- sync_fetch_result(13) {completed, failed} ----->|
      |  done（summary：planned / skipped / completed / failed）

职责边界：

- **只做编排**：选择集 → 本地 manifest 条目 → 与对端快照对账 → 声明 → 等对端点名 →
  交给 :mod:`app.lansync.fetch_responder` 应答 → 汇总统计；
- **进度 / 账目**：全程产出事件（`on_event` 回调，service 层转 `EventType.PUSH`），
  同时维护可查询的状态对象（:meth:`LibraryPushRun.status`）；
- **不碰字节、不碰路径安全**：文件帧收发在 `filetransfer`，路径闸在 `locallib`，
  线上契约与纯逻辑在 :mod:`app.lansync.push_models`。

硬约束（§12b 决策 6/7）：

- **发起方恒为 Host**（web/Qt 桌面端）；设备只被动收；
- **不传播删除**：对端多出来的条目什么都不做，协议里不存在删除指令；
- **对端已有（同路径同内容）不重发**：对账用 `content_hash`（任一侧无指纹 = 保守推送）；
- **歌单同步 = 缺歌自动补齐**：选择集（歌单 / 收藏 / `@smart:*` / 显式单曲集）的成员
  即「目标端应有」的集合，成员在目标端缺失 → 推送。

v1 单飞：一次推送一个运行实例；ack 超时不在本层（调用方可按
:data:`~app.lansync.filetransfer.DEFAULT_ACK_TIMEOUT` 计时后调
:meth:`LibraryPushRun.handle_ack_timeout`）。
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable, Mapping
from enum import Enum
from typing import Any, Protocol

from .fetch_responder import FetchProgress, FetchResult, SyncFetchResponder
from .frame import FrameType
from .manifest import Collection, manifest_entries
from .push_models import (
    REASON_CANCELLED,
    REASON_INVALID_PATH,
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
    "REASON_CANCELLED",
    "REASON_INVALID_PATH",
    "REASON_LOCAL_FILE_UNAVAILABLE",
    "REASON_SESSION_CLOSED",
]


class PushState(str, Enum):
    """推送状态机（线上字符串与 Swift `SyncLibraryPushState` 同名）。"""

    IDLE = "idle"
    REQUESTING_MANIFEST = "requestingManifest"
    PUSHING = "pushing"
    DONE = "done"
    FAILED = "failed"


class ApplicationSender(Protocol):
    """业务帧发送 / 就绪查询接口（生产 = `HostSession`；测试 = 桩）。"""

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发一帧加密业务帧。"""
        ...

    @property
    def is_ready(self) -> bool:
        """会话是否已就绪。"""
        ...


# ============ 推送编排 ============
class LibraryPushRun:
    """一次「推送到设备」的运行实例（帧驱动；一连接一实例，与 Swift 控制器同构）。

    生命周期：``start()`` 发 manifest 请求 → 收帧 11 → 对账 + 发帧 14 → 等帧 12
    → 交 `SyncFetchResponder` 应答 → 帧 13 收尾。终态后 `status()` 仍可查询（账目保留）。
    """

    def __init__(
        self,
        session: ApplicationSender,
        *,
        selection: Collection | Mapping[str, Any] | None = None,
        root: Any = None,
        content_hash_provider: Callable[[str], str | None] | None = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        run_id: str | None = None,
    ) -> None:
        """`selection` = 选择集（`Collection` 或线上字典；缺省全库）。

        `on_event` = 进度 / 状态事件回调（service 层转 `EventType.PUSH`）。
        """
        self.run_id = run_id or uuid.uuid4().hex
        self._session = session
        self._root = root
        self._selection = as_collection(selection)
        self._on_event = on_event

        self._state = PushState.IDLE
        self._error: str | None = None
        self._summary = LibraryPushSummary()
        self._sent_bytes = 0
        self._total_bytes = 0
        self._responder = SyncFetchResponder(
            session,
            root=root,
            content_hash_provider=content_hash_provider,
            on_progress=self._handle_progress,
            on_result=self._handle_result,
        )

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
    def summary(self) -> LibraryPushSummary:
        """结果账目（实时值）。"""
        return self._summary

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
        """推入一帧；返回 True = 本次推送已消费（service 不再转交其它 handler）。"""
        if frame_type == FrameType.MANIFEST_RESPONSE:
            self._handle_manifest_response(payload)
            return True
        if frame_type == FrameType.SYNC_FETCH_REQUEST:
            if self._state is not PushState.PUSHING:
                return False  # 未在推送：留给独立的取文件应答器
            return self._responder.handle_application_frame(frame_type, payload)
        if frame_type == FrameType.FILE_ACK and self._state is PushState.PUSHING:
            return self._responder.handle_application_frame(frame_type, payload)
        return False

    def cancel(self) -> bool:
        """本端取消（终态后 = False）：停发文件、中止在途传输、账目保留。"""
        if self.is_terminal:
            return False
        self._responder.cancel()
        self._fail(REASON_CANCELLED)
        return True

    def handle_session_closed(self) -> None:
        """会话关闭：中止在途传输；未终态 → 落 `failed`（原因 `session_closed`）。"""
        self._responder.handle_session_closed()
        if not self.is_terminal:
            self._fail(REASON_SESSION_CLOSED)

    def handle_ack_timeout(self) -> bool:
        """ack 超时（调用方计时后调用）；真值 = 对端应答帧已终结。"""
        return self._responder.handle_ack_timeout()

    # ------------------------------------------------------------ 内部推进

    def _handle_manifest_response(self, payload: bytes) -> None:
        """对端曲库快照 → 推送方向对账 → 声明 → `pushing`。"""
        if self._state is not PushState.REQUESTING_MANIFEST:
            return  # 迟到的 / 重复的响应：忽略（不改状态）
        try:
            remote_entries, _root_name = decode_manifest_response(payload)
        except PushError as error:
            self._fail(f"manifest_response 载荷非法：{error}")
            return
        try:
            local_entries = manifest_entries(self._selection, root=self._root)
        except Exception as error:  # noqa: BLE001 - 本端曲库事实不可用 = 本次推送失败
            self._fail(f"生成本端清单失败：{error}")
            return
        plan = push_plan(local_entries, remote_entries)

        entries: list[PushEntry] = []
        failures: list[PushFailure] = []
        for entry in plan.to_push:
            built = build_push_entry(self._root, entry)
            if built is None:
                failures.append(PushFailure(entry.relative_path, REASON_LOCAL_FILE_UNAVAILABLE))
                continue
            entries.append(built)
        announce = normalize_announce_entries(entries)
        announced = {entry.relative_path for entry in announce}
        for entry in entries:
            if entry.relative_path not in announced:  # 结构非法被丢弃：如实记账
                failures.append(
                    PushFailure(entry.relative_path, REASON_INVALID_PATH, "声明结构校验未通过")
                )

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
        self._transition(PushState.PUSHING)

    def _handle_progress(self, progress: FetchProgress) -> None:
        """逐条发送进度 → 事件（含已发字节 / 总字节）。"""
        self._sent_bytes = max(self._sent_bytes, progress.sent_total_bytes)
        if progress.total_bytes_all:
            self._total_bytes = max(self._total_bytes, progress.total_bytes_all)
        self._emit({"path": progress.relative_path, **progress.to_dict()})

    def _handle_result(self, result: FetchResult) -> None:
        """取文件应答收尾：把结果并入账目 → `done`。"""
        if self.is_terminal:
            return
        for path in result.completed:
            if path not in self._summary.completed:
                self._summary.completed.append(path)
        for failure in result.failed:
            self._summary.failed.append(PushFailure(failure.relative_path, failure.reason))
        self._sent_bytes = self._total_bytes or self._sent_bytes
        self._transition(PushState.DONE)

    def _transition(self, state: PushState) -> None:
        """状态迁移 + 事件（终态含完整账目）。"""
        self._state = state
        self._emit({})

    def _fail(self, error: str, *, state: PushState = PushState.FAILED) -> None:
        """落失败态（原因如实记录，不静默）。"""
        self._error = error
        self._state = state
        self._emit({"error": error})

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
