"""局域网同步（S2）应用级单例：生命周期 / 身份 / 配对 / 设备 / 事件。

接口按 `docs/lan-sync-web-host-plan.md` §3（**冻结接口**，UI 与路由按此对接）：

    start/stop · status · identity_info · start_pairing/stop_pairing
    pending_pairs · approve_pair/reject_pair/cancel_pair · devices/remove_device
    events_since(cursor)

职责边界：

- **身份持久化**：Ed25519 私钥（seed）与 Device ID 落 `store_dir/lansync_identity.json`
  （权限 0600、原子写、重启复用同一身份）。
- **信任表**：`store_dir/lansync_devices.json`（`trust.py` 的 `TrustStore`）。
- **事件**：内存环形缓冲，UI 用 `events_since(cursor)` 游标轮询（无 WebSocket）。
- **会话**：本层不碰字节，只做回调转事件 + 配对决定（状态机在 `session.py`）。

并发：单事件循环内同步调用（无锁）；文件 IO 都是小 JSON（毫秒级）。
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import json
import logging
import os
import socket
import tempfile
import threading
import time
from collections import deque
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from .crypto import CryptoError, Identity
from .deviceid import formatted
from .filetransfer import DEFAULT_ACK_TIMEOUT
from .models import (
    PROTOCOL_VERSION,
    CloseReason,
    CloseReasonKind,
    EventType,
    SyncEvent,
    SyncPhase,
    SyncSessionConfig,
)
from .push import LibraryPushRun, PushError
from .qr import NoncePool, encode_qr_payload, make_qr_payload, new_session_nonce
from .server import SyncServer, safe_device_name
from .session import HostSession, PendingPairRequest
from .trust import TrustStore, TrustStoreError

logger = logging.getLogger(__name__)

#: 身份文件（含私钥；权限 0600）
IDENTITY_FILE = "lansync_identity.json"
#: 信任表文件（配对记录）
TRUST_FILE = "lansync_devices.json"
#: 身份文件权限（属主可读写）
IDENTITY_FILE_MODE = 0o600
#: 事件环形缓冲容量（UI 轮询游标滞后时的可回溯条数）
EVENT_BUFFER_SIZE = 512
#: 保留的推送运行实例上限（终态运行可继续用 `push_status` 查询，超出按最早终态淘汰）
MAX_PUSH_RUNS = 32


class IdentityStoreError(Exception):
    """身份文件读写/结构错误。"""


def default_store_dir() -> Path:
    """默认数据目录 = web 后端现有约定（`app.state.DATA_DIR`；延迟 import 保持本包纯净）。"""
    from app import state

    return Path(state.DATA_DIR)


def load_or_create_identity(path: Path) -> Identity:
    """读身份文件；不存在则生成新身份并落盘（0600、原子写）。"""
    if path.exists():
        return _load_identity(path)
    identity = Identity.generate()
    _save_identity(path, identity)
    return identity


def _load_identity(path: Path) -> Identity:
    """解析身份文件；损坏/字段缺失/指纹不一致一律抛 `IdentityStoreError`（不静默重建）。"""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as error:
        raise IdentityStoreError(f"身份文件读取失败：{path}（{error}）") from error
    try:
        raw = json.loads(text)
    except ValueError as error:
        raise IdentityStoreError(f"身份文件不是合法 JSON：{path}（{error}）") from error
    if not isinstance(raw, dict):
        raise IdentityStoreError(f"身份文件结构非法（不是对象）：{path}")
    seed_text = raw.get("private_key")
    if not isinstance(seed_text, str) or not seed_text:
        raise IdentityStoreError(f"身份文件缺 private_key：{path}")
    try:
        seed = base64.b64decode(seed_text, validate=True)
    except Exception as error:  # noqa: BLE001 - binascii.Error / ValueError
        raise IdentityStoreError(f"身份文件 private_key 不是合法 base64：{path}") from error
    try:
        identity = Identity.from_private_key(seed)
    except CryptoError as error:
        raise IdentityStoreError(f"身份文件私钥不可用：{path}（{error}）") from error
    stored_id = raw.get("device_id")
    if isinstance(stored_id, str) and stored_id and stored_id != identity.device_id:
        raise IdentityStoreError(f"身份文件 device_id 与私钥指纹不一致：{path}")
    return identity


def _save_identity(path: Path, identity: Identity) -> None:
    """原子写身份文件（tmp + fsync + rename，权限恒 0600）。"""
    if identity.private_key_raw is None:
        raise IdentityStoreError("身份无私钥，无法持久化")
    payload = {
        "version": 1,
        "device_id": identity.device_id,
        "public_key": base64.b64encode(identity.public_key_raw).decode("ascii"),
        "private_key": base64.b64encode(identity.private_key_raw).decode("ascii"),
        "created_at": int(time.time()),
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    directory = path.parent
    try:
        directory.mkdir(parents=True, exist_ok=True)
        handle_fd, tmp_name = tempfile.mkstemp(
            dir=str(directory), prefix=f".{path.name}.", suffix=".tmp"
        )
    except OSError as error:
        raise IdentityStoreError(f"身份文件临时文件创建失败：{directory}（{error}）") from error
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp_name, IDENTITY_FILE_MODE)
        os.replace(tmp_name, path)
    except OSError as error:
        with contextlib.suppress(OSError):  # 清理失败不掩盖原始错误
            os.unlink(tmp_name)
        raise IdentityStoreError(f"身份文件写入失败：{path}（{error}）") from error


class SyncService:
    """局域网同步服务（web/Qt 主机侧单例）。"""

    def __init__(
        self,
        *,
        store_dir: Path | str | None = None,
        device_name: str | None = None,
        port: int = 0,
        host: str = "0.0.0.0",
        session_config: SyncSessionConfig | None = None,
        enable_mdns: bool = True,
        on_application_frame: Callable[[HostSession, int, bytes], None] | None = None,
        push_ack_timeout: float = DEFAULT_ACK_TIMEOUT,
    ) -> None:
        """构造即加载/生成身份（`store_dir` 缺省 = `app.state.DATA_DIR`）。

        `port=0` = 系统分配；`host`/`session_config`/`enable_mdns` 供测试与多实例注入；
        `on_application_frame` = ready 后业务帧的应用层接入口（M2b 文件传输用）；
        `push_ack_timeout` = 推送等单条 `file_ack` 的超时秒数（对位 Swift
        `SyncFileSender.defaultAckTimeout`）；0 = 不挂定时器。
        """
        self._store_dir = Path(store_dir) if store_dir is not None else default_store_dir()
        raw_name = device_name if device_name is not None else (socket.gethostname() or "qqplayer")
        self._device_name = safe_device_name(raw_name)
        self._identity = load_or_create_identity(self._store_dir / IDENTITY_FILE)
        self._trust = TrustStore(self._store_dir / TRUST_FILE)
        self._nonces = NoncePool()
        self._events: deque[SyncEvent] = deque(maxlen=EVENT_BUFFER_SIZE)
        self._seq = 0
        self._request_sessions: dict[str, HostSession] = {}
        self._push_runs: dict[str, LibraryPushRun] = {}
        #: 推送 ack 超时定时器（run_id → 句柄；每轮等待重挂一次）
        self._push_timers: dict[str, Any] = {}
        self._push_ack_timeout = float(push_ack_timeout)
        self._application_frame_handler = on_application_frame
        config = session_config if session_config is not None else SyncSessionConfig()
        if config.display_name is None:
            config = replace(config, display_name=self._device_name)
        self._server = SyncServer(
            identity=self._identity,
            trust_store=self._trust,
            nonces=self._nonces,
            device_name=self._device_name,
            port=port,
            host=host,
            session_config=config,
            enable_mdns=enable_mdns,
            on_state_change=self._handle_state_change,
            on_closed=self._handle_closed,
            on_pair_request=self._handle_pair_request,
            on_application_frame=self._handle_application_frame,
        )

    # ------------------------------------------------------------ 生命周期

    async def start(self) -> None:
        """起 TCP 监听 + mDNS 广播（幂等）。"""
        if self._server.running:
            return
        await self._server.start()

    async def stop(self) -> None:
        """停止监听、注销广播、作废配对 nonce（幂等）。"""
        await self._server.stop()
        self._nonces.clear()
        self._request_sessions.clear()
        for run_id in list(self._push_timers):
            self._cancel_push_ack_timer(run_id)
        for run in list(self._push_runs.values()):
            run.handle_session_closed()

    # ---------------------------------------------------------------- 状态

    @property
    def status(self) -> dict[str, Any]:
        """运行状态：`{"running", "port", "device_name", "protocol_version"}`。"""
        return {
            "running": self._server.running,
            "port": self._server.port,
            "device_name": self._device_name,
            "protocol_version": PROTOCOL_VERSION,
        }

    @property
    def identity_info(self) -> dict[str, str]:
        """本机身份：全量 Device ID / 分组展示 / Ed25519 公钥（standard base64）。"""
        return {
            "device_id": self._identity.device_id,
            "device_id_formatted": formatted(self._identity.device_id),
            "public_key": base64.b64encode(self._identity.public_key_raw).decode("ascii"),
        }

    @property
    def sessions(self) -> tuple[HostSession, ...]:
        """当前活动会话（只读视图；UI 一般用 `devices()`，此接口供诊断/测试）。"""
        return self._server.sessions

    # ---------------------------------------------------------------- 配对

    def start_pairing(self) -> dict[str, str]:
        """生成并登记配对 QR（重复调用 = 换新码并作废旧码）。

        返回 `{"qr_payload": <QR JSON 文本>, "nonce": <b64 一次性 nonce>}`。
        """
        nonce = new_session_nonce()
        self._nonces.clear()
        self._nonces.register(nonce)
        payload = make_qr_payload(
            host_name=self._device_name,
            device_id=self._identity.device_id,
            public_key_b64=base64.b64encode(self._identity.public_key_raw).decode("ascii"),
            session_nonce=nonce,
        )
        return {
            "qr_payload": encode_qr_payload(payload),
            "nonce": base64.b64encode(nonce).decode("ascii"),
        }

    def stop_pairing(self) -> None:
        """作废当前配对 nonce（停止展示 QR / 配对完成 / 关闭面板）。"""
        self._nonces.clear()

    @property
    def pending_pairs(self) -> list[dict[str, Any]]:
        """待批准配对请求（按收到时间排序；`reason` 展示与批准都走 request_id）。"""
        items = [
            session.pending_pair_request
            for session in self._server.sessions
            if session.pending_pair_request is not None
        ]
        return [item.to_dict() for item in sorted(items, key=lambda item: item.received_at)]

    def approve_pair(self, request_id: str, display_name: str | None = None) -> bool:
        """批准配对：落信任记录 + 回 approved + 进 ready（成功返回 True）。"""
        session = self._request_sessions.get(request_id)
        pending = session.pending_pair_request if session is not None else None
        if session is None or pending is None:
            return False
        approved = session.approve_pairing(display_name)
        name = (display_name or "").strip() or pending.suggested_display_name
        self._emit(
            EventType.PAIR_RESULT,
            {
                "request_id": request_id,
                "approved": approved,
                "peer_id": pending.device_id,
                "display_name": name if approved else pending.display_name,
            },
        )
        if approved:
            self._emit(EventType.DEVICE, {"peer_id": pending.device_id, "action": "paired"})
            self._nonces.clear()  # 配对完成 → 作废当前 QR nonce（协议 §3.1）
        return approved

    def reject_pair(self, request_id: str, reason: str | None = None) -> bool:
        """拒绝配对：回 approved=false + reason 后断连（成功返回 True）。"""
        session = self._request_sessions.get(request_id)
        pending = session.pending_pair_request if session is not None else None
        if session is None or pending is None:
            return False
        rejected = session.reject_pairing(reason)
        self._emit(
            EventType.PAIR_RESULT,
            {
                "request_id": request_id,
                "approved": False,
                "peer_id": pending.device_id,
                "reason": reason,
            },
        )
        return rejected

    def cancel_pair(self, request_id: str) -> bool:
        """直接断开发起中的配对会话（成功返回 True）。"""
        session = self._request_sessions.get(request_id)
        if session is None:
            return False
        session.cancel(CloseReason(CloseReasonKind.USER_CANCELLED))
        return True

    # ---------------------------------------------------------------- 设备

    def devices(self) -> list[dict[str, Any]]:
        """已配对设备列表（含在线状态与当前会话阶段）。"""
        live = self._server.sessions
        result: list[dict[str, Any]] = []
        for device in self._trust.list_devices():
            matched = [item for item in live if item.peer_device_id == device.peer_id]
            ready = next((item for item in matched if item.phase is SyncPhase.READY), None)
            current = ready or (matched[0] if matched else None)
            result.append(
                {
                    "peer_id": device.peer_id,
                    "display_name": device.display_name,
                    "role": device.role,
                    "paired_at": device.paired_at,
                    "last_seen_at": device.last_seen_at,
                    "online": ready is not None,
                    "phase": current.phase.value if current is not None else None,
                }
            )
        return result

    def remove_device(self, peer_id: str) -> bool:
        """撤销配对：断开该设备会话 + 删信任记录（命中返回 True）。"""
        for session in self._server.sessions:
            if session.peer_device_id == peer_id:
                session.cancel(CloseReason(CloseReasonKind.USER_CANCELLED))
        removed = self._trust.remove(peer_id)
        if removed:
            self._emit(EventType.DEVICE, {"peer_id": peer_id, "action": "removed"})
        return removed

    # ---------------------------------------------------------------- 推送

    def push_selection(self, peer_id: str, selection: Any = None) -> str:
        """发起一次「推送到设备」（S3a），返回 `run_id`。

        选择集 = `Collection` 或线上字典 `{"kind": "all"|"playlists"|"tracks", "ids": [...]}`；
        歌单标识含保留命名空间 `@favorites` / `@smart:*`（语义见 `library_sources`）。
        流程：请求对端 manifest（帧 10/11）→ 推送方向对账 → 发推送声明（帧 14）→
        **本端串行推 4/5/6**（逐文件停等 `file_ack`，它是唯一送达凭据；推送链无 12/13）
        → 队列清空收尾。

        该设备无就绪会话 / 选择集非法 → :class:`~app.lansync.push.PushError`。
        """
        session = self._ready_session(peer_id)
        if session is None:
            raise PushError(f"该设备无就绪会话，无法推送：{peer_id}")
        run = LibraryPushRun(
            session,
            selection=selection,
            on_event=self._handle_push_event,
            ack_timeout=self._push_ack_timeout,
        )
        self._register_push_run(run)
        try:
            run.start()
        except PushError:
            self._prune_push_runs()
            raise
        self._arm_push_ack_timer(run)
        return run.run_id

    def push_status(self, run_id: str) -> dict[str, Any]:
        """推送状态 / 账目（未知 `run_id` → 空字典）。

        键：`state` / `selection` / `planned` / `skipped` / `completed` / `failed` +
        各计数 + `sentBytes` / `totalBytes`（见 `LibraryPushRun.status`）。
        """
        run = self._push_runs.get(run_id)
        return run.status() if run is not None else {}

    def cancel_push(self, run_id: str) -> bool:
        """取消一次推送（已终态 / 未知 `run_id` → False）。"""
        run = self._push_runs.get(run_id)
        if run is None:
            return False
        cancelled = run.cancel()
        self._cancel_push_ack_timer(run_id)
        return cancelled

    # ------------------------------------------------------------ ack 超时

    def _arm_push_ack_timer(self, run: LibraryPushRun) -> None:
        """按本端 ack 超时重挂定时器（对端不回 ack → 该文件失败，不悬挂）。

        调用点：推送起手 / 每条推送事件（状态迁移与逐块进度）/ 定时器触发后的收尾兜底。
        无在途等待（未开推 / 已终结 / 正在本地准备）→ 只摘不挂。
        """
        self._cancel_push_ack_timer(run.run_id)
        if run.is_terminal or not run.is_awaiting_ack or run.ack_timeout <= 0:
            return
        self._push_timers[run.run_id] = self._schedule_timer(
            run.ack_timeout, lambda: self._fire_push_ack_timeout(run.run_id)
        )

    def _cancel_push_ack_timer(self, run_id: str) -> None:
        """摘掉该运行的 ack 超时定时器（幂等）。"""
        handle = self._push_timers.pop(run_id, None)
        if handle is not None:
            handle.cancel()

    def _fire_push_ack_timeout(self, run_id: str) -> None:
        """ack 超时到点：该文件落失败 + 自动推进下一个（不再有事件时兜底重挂）。"""
        self._push_timers.pop(run_id, None)
        run = self._push_runs.get(run_id)
        if run is None or run.is_terminal:
            return
        try:
            run.handle_ack_timeout()
        except Exception:  # noqa: BLE001 - 定时器回调不得抛出（无事件循环入口）
            logger.exception("lansync 推送 ack 超时处理失败（run=%s）", run_id)
        self._arm_push_ack_timer(run)

    def _schedule_timer(self, delay: float, callback: Callable[[], None]) -> Any:
        """挂一次性定时器：优先用当前事件循环；无循环（同步调用方）退回线程定时器。"""
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            timer = threading.Timer(delay, callback)
            timer.daemon = True
            timer.start()
            return timer
        return loop.call_later(delay, callback)

    def _ready_session(self, peer_id: str) -> HostSession | None:
        """该设备当前就绪的会话（未就绪 / 未连接 → None）。"""
        for session in self._server.sessions:
            if session.peer_device_id == peer_id and session.is_ready:
                return session
        return None

    def _register_push_run(self, run: LibraryPushRun) -> None:
        """登记推送运行（超上限时优先淘汰最早终态的运行）。"""
        self._push_runs[run.run_id] = run
        self._prune_push_runs()

    def _prune_push_runs(self) -> None:
        """把推送运行表收敛到上限：先淘汰终态（最早在前），仍超则淘汰最早登记者。"""
        while len(self._push_runs) > MAX_PUSH_RUNS:
            obsolete = next((key for key, run in self._push_runs.items() if run.is_terminal), None)
            if obsolete is None:
                obsolete = next(iter(self._push_runs))
            self._push_runs.pop(obsolete, None)
            self._cancel_push_ack_timer(obsolete)

    def _route_push_frame(self, session: HostSession, frame_type: int, payload: bytes) -> bool:
        """把业务帧交给该会话上未终态的推送运行；已被消费 → True。"""
        for run in list(self._push_runs.values()):
            if run.session_id != session.session_id or run.is_terminal:
                continue
            if run.handle_application_frame(frame_type, payload):
                return True
        return False

    def _handle_push_event(self, event: dict[str, Any]) -> None:
        """推送运行的事件 → 应用级事件（`EventType.PUSH`，UI 按游标轮询）。

        顺带按本次事件重挂 ack 超时定时器：状态迁移 / 逐块进度都经此出口，
        保证「每次新的等待都有一枚定时器」（Swift `SyncFileSender` 每块重挂，
        `SyncFileSender.swift:258-263`）。
        """
        run = self._push_runs.get(str(event.get("run_id") or ""))
        if run is not None:
            self._arm_push_ack_timer(run)
        self._emit(EventType.PUSH, dict(event))

    # ---------------------------------------------------------------- 事件

    def events_since(self, cursor: int) -> tuple[int, list[dict[str, Any]]]:
        """取 `seq > cursor` 的事件，返回 `(新游标, 事件列表)`（游标单调递增）。

        事件缓冲为环形（容量 `EVENT_BUFFER_SIZE`）：游标滞后超过容量时只能拿到
        尚在缓冲里的事件（新游标仍指向最后一条，UI 据此继续轮询）。
        """
        start = cursor if isinstance(cursor, int) and not isinstance(cursor, bool) else 0
        start = max(0, start)
        events = [event.to_dict() for event in self._events if event.seq > start]
        return (events[-1]["seq"] if events else start), events

    # ---------------------------------------------------------- 会话回调

    def _handle_state_change(self, session: HostSession, phase: SyncPhase) -> None:
        """阶段变化 → 事件（ready 时顺手刷新 last_seen_at）。"""
        if phase is SyncPhase.CLOSED:
            return  # 关闭统一由 _handle_closed 出一条（带原因）
        if phase is SyncPhase.READY and session.peer_device_id:
            with contextlib.suppress(TrustStoreError):
                self._trust.touch_last_seen(session.peer_device_id, int(time.time()))
        self._emit(
            EventType.SESSION,
            {
                "session_id": session.session_id,
                "peer_id": session.peer_device_id,
                "phase": phase.value,
            },
        )

    def _handle_closed(self, session: HostSession, reason: CloseReason) -> None:
        """会话关闭 → 事件（含原因）+ 清理该会话的配对请求与推送运行。"""
        self._request_sessions = {
            key: value for key, value in self._request_sessions.items() if value is not session
        }
        for run_id, run in list(self._push_runs.items()):
            if run.session_id == session.session_id:
                run.handle_session_closed()
                self._cancel_push_ack_timer(run_id)
        self._emit(
            EventType.SESSION,
            {
                "session_id": session.session_id,
                "peer_id": session.peer_device_id,
                "phase": SyncPhase.CLOSED.value,
                "reason": reason.to_dict(),
            },
        )
        if reason.kind in (CloseReasonKind.STORAGE_ERROR, CloseReasonKind.TRANSPORT_ERROR):
            self._emit(EventType.ERROR, {"message": f"{reason.kind.value}:{reason.detail or ''}"})

    def _handle_pair_request(self, session: HostSession, pending: PendingPairRequest) -> None:
        """待批准配对 → 事件 + 登记 request_id（批准/拒绝按 request_id 定位会话）。"""
        self._request_sessions[pending.request_id] = session
        self._emit(EventType.PAIR_REQUEST, pending.to_dict())

    def _handle_application_frame(
        self, session: HostSession, frame_type: int, payload: bytes
    ) -> None:
        """ready 后业务帧 → 先给本会话在跑的推送运行（消费即止），否则转交应用层接入口。

        未注入接入口时本层只做内部路由（既有语义不变）。
        """
        if self._route_push_frame(session, frame_type, payload):
            return
        if self._application_frame_handler is None:
            return
        try:
            self._application_frame_handler(session, frame_type, payload)
        except Exception:  # noqa: BLE001 - 业务回调异常不得中断会话
            logger.exception("lansync 业务帧处理失败（session=%s）", session.session_id)

    def _emit(self, event_type: EventType, data: dict[str, Any]) -> SyncEvent:
        """追加一条事件（seq 单调递增）并返回。"""
        self._seq += 1
        event = SyncEvent(seq=self._seq, at=time.time(), type=event_type, data=data)
        self._events.append(event)
        return event
