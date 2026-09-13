"""局域网同步（S2）Host 侧「从设备拉取」编排（浏览 15/16 + 对账 10/11 + 取回 12/13/4/5/6）。

对位 Swift `QQPlayer/Sync/SyncLibraryPullController.swift`（发起端「从设备下载」）+
`QQPlayer/Sync/SyncPeerLibraryClient.swift`（对端内容清单客户端）；线协议契约见
`docs/lan-sync-protocol.md` §13（15/16 浏览）、§11（10/11 对账 + 12/13 取文件）、
§10（4/5/6 文件帧）。

方向关系（与 S3a 对称）：S3a = Host 推（**收**设备帧 12 → `FileSender` 送 4/5/6），
S3b = Host 拉（**发**帧 12 → 收设备帧 13 + 4/5/6 → `FileReceiver` 落盘）——两边都是
「Host 发起、设备被动应答」，本模块与 :mod:`app.lansync.push` 同构（状态机 / 取消 /
进度事件 / 单个文件失败不阻塞后续）。

语义硬约束（§11.3 + §12b 决策 6/7，逐条对齐 Swift）：

- **不传播删除**：对端没有而本端已有的文件一律保留（本模块不存在删除执行路径）；
- **同内容跳过**：同路径 `content_hash` 一致 → 不进请求列表；内容不同 → 取回并覆盖；
- **保守取回**：任一侧无指纹 → 照样取（宁可多传一次，不可漏传）；
- **单个文件失败不阻塞**：设备报 `failed` / 本端认领或落位失败只记账，后续文件照常；
- **越界拒写**：目标相对路径走 `locallib` 既有口径（规范化 + 根内包含性 + 真实路径复核），
  文件名安全走 `filetransfer` 既有规则——本模块不造第二套路径数学。

账目字段命名与 Swift `SyncLibraryPullSummary` 对齐（`requested` / `unchanged` /
`completed` / `failed`）；与 S3a 推送账目的对应关系：`requested` ≈ `planned`、
`unchanged` ≈ `skipped`（推送方向「我该给对端送什么」/ 拉取方向「我该向对端要什么」）。

职责边界：本模块只做编排 + 纯逻辑（对账 / 认领 / 载荷解析）；字节收发在
`filetransfer`（`FileReceiver`），路径闸在 `locallib`，帧 12/13 载荷在 `fetch_responder`，
manifest 编解码与「内容是否一致」单点在 `push_models`。

v1 单飞：一次拉取一个运行实例；本层不持时钟（接收方向的 ack 由本端发出，没有等待对端 ack
的超时概念——会话关闭 / 取消经 :meth:`LibraryPullRun.handle_session_closed` /
:meth:`LibraryPullRun.cancel` 收口）。
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from .fetch_responder import (
    FetchPayloadError,
    FetchRequest,
    decode_fetch_result,
    encode_fetch_request,
)
from .filetransfer import FileReceiver, FileTransferResult, sha256_file
from .frame import FrameType
from .locallib import (
    REASON_INVALID_PATH,
    REASON_NOT_FOUND,
    REASON_SEND_FAILED,
    SCOPE_TRACKS,
    int_or,
    library_root,
    normalize_relative_path,
    optional_str,
)
from .manifest import Collection, ManifestEntry, manifest_entries
from .peer_library import PeerPlaylistItem, PeerTrackItem
from .push_models import (
    REASON_CANCELLED,
    REASON_SESSION_CLOSED,
    PushError,
    content_matches,
    decode_manifest_response,
    encode_manifest_request,
)

logger = logging.getLogger(__name__)

__all__ = [
    "DEFAULT_PAGE_LIMIT",
    "INCOMING_DIR_NAME",
    "LibraryPullRun",
    "LibraryPullSummary",
    "PeerLibraryBrowser",
    "PeerLibraryPage",
    "PullError",
    "PullFailure",
    "PullPlan",
    "PullState",
    "REASON_CANCELLED",
    "REASON_INVALID_PATH",
    "REASON_NOT_FOUND",
    "REASON_SEND_FAILED",
    "REASON_SESSION_CLOSED",
    "REASON_UNCLAIMED",
    "decode_peer_library_response",
    "encode_peer_library_request",
    "pull_plan",
]

#: 落地目录名（曲库根内隐藏目录，与 Swift `incomingDirectoryName` 同值；曲库扫描跳过隐藏）
INCOMING_DIR_NAME = ".sync-incoming"
#: 浏览对端清单的缺省页大小（§13.2 共识区间 `1...500`；本端缺省取屏幕友好值）
DEFAULT_PAGE_LIMIT = 50
#: 本端扩展失败原因（Swift 在认领失败时静默留在落地目录；本端如实记账，便于 UI 定位）
REASON_UNCLAIMED = "unclaimed"


class PullError(Exception):
    """拉取编排错误（会话未就绪 / 载荷非法 / 未知 run）。"""


class ApplicationSender(Protocol):
    """业务帧发送 / 就绪查询接口（生产 = `HostSession`；测试 = 桩）。"""

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发一帧加密业务帧。"""
        ...

    @property
    def is_ready(self) -> bool:
        """会话是否已就绪。"""
        ...


# ============ 状态 / 账目 ============
class PullState(str, Enum):
    """拉取状态机（线上字符串与 Swift `SyncLibraryPullState` 同名）。"""

    IDLE = "idle"
    REQUESTING_MANIFEST = "requestingManifest"
    FETCHING = "fetching"
    DONE = "done"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class PullFailure:
    """一条拉取失败记录（诊断 / UI 用；本地账目，无线上载荷）。"""

    relative_path: str
    reason: str
    detail: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """事件 / 状态字典（camelCase，与其它 lansync 事件同风格）。"""
        payload: dict[str, Any] = {"relativePath": self.relative_path, "reason": self.reason}
        if self.detail:
            payload["detail"] = self.detail
        return payload


@dataclass(slots=True)
class LibraryPullSummary:
    """一次拉取的结果账目（requested / unchanged / completed / failed）。"""

    #: 点名向对端索取（进入帧 12 请求列表）的相对路径（升序）
    requested: list[str] = field(default_factory=list)
    #: 内容一致、无需取回的对端条目（升序）
    unchanged: list[str] = field(default_factory=list)
    #: 已落盘并导入本端曲库的相对路径（接收序）
    completed: list[str] = field(default_factory=list)
    #: 失败记录（本端解析 / 落位 + 对端结果帧回报）
    failed: list[PullFailure] = field(default_factory=list)
    #: 对端结果帧回报「已送达」的相对路径（诊断 / 账目用；§11.5）
    reported_completed: list[str] = field(default_factory=list)

    @property
    def is_full_success(self) -> bool:
        """每个点名条目都落盘入库（无失败且完成数 = 请求数）。"""
        return not self.failed and len(self.completed) == len(self.requested)

    def to_dict(self) -> dict[str, Any]:
        """状态字典（含计数字段，UI 直接可用）。"""
        return {
            "requested": list(self.requested),
            "unchanged": list(self.unchanged),
            "completed": list(self.completed),
            "failed": [item.to_dict() for item in self.failed],
            "reportedCompleted": list(self.reported_completed),
            "requestedCount": len(self.requested),
            "unchangedCount": len(self.unchanged),
            "completedCount": len(self.completed),
            "failedCount": len(self.failed),
        }


# ============ 拉取方向对账（纯逻辑） ============
@dataclass(frozen=True, slots=True)
class PullPlan:
    """拉取计划（纯值）：需取回 + 已一致（各自按相对路径升序）。"""

    to_fetch: tuple[ManifestEntry, ...] = ()
    unchanged: tuple[ManifestEntry, ...] = ()


def pull_plan(
    remote: Sequence[ManifestEntry],
    local: Sequence[ManifestEntry],
    selection: Iterable[str] | None = None,
) -> PullPlan:
    """拉取方向对账（**以对端清单为准**，§11.3）：

    - 对端有、本端**没有该相对路径** → 取回（补齐缺失）；
    - 同路径双侧 `content_hash` 非空且相等 → 跳过（`:func:`~app.lansync.push_models.content_matches``）；
    - hash 不同，或任一侧为 nil（尚未指纹）→ 取回（保守：宁可多传一次，不可漏传）；
    - **本端有而对端没有** → 什么都不做（不传播删除；本端原样保留）；
    - 对端清单里路径非法（空 / 绝对路径 / `..` 逃逸 / 未规范化）→ **丢弃**（不信任对端，
      绝不把它拼成目标路径）；同一路径重复出现以最后一个为准（对端给最终快照）。

    `selection` = 本端点名集合（规范化后的相对路径）；None = 不过滤（全库）。
    """
    wanted = None if selection is None else set(selection)
    remote_by_path: dict[str, ManifestEntry] = {}
    for entry in remote:
        normalized = normalize_relative_path(entry.relative_path)
        if normalized is None or normalized != entry.relative_path:
            continue
        if wanted is not None and normalized not in wanted:
            continue
        remote_by_path[normalized] = entry  # later wins
    local_by_path = {entry.relative_path: entry for entry in local}
    to_fetch: list[ManifestEntry] = []
    unchanged: list[ManifestEntry] = []
    for path in sorted(remote_by_path):
        entry = remote_by_path[path]
        local_entry = local_by_path.get(path)
        if local_entry is None or not content_matches(local_entry, entry):
            to_fetch.append(entry)
        else:
            unchanged.append(entry)
    return PullPlan(to_fetch=tuple(to_fetch), unchanged=tuple(unchanged))


# ============ 对端内容清单（帧 15/16，§13） ============
@dataclass(frozen=True, slots=True)
class PeerLibraryPage:
    """一页对端内容清单（帧 16 载荷的解析结果，§13.3）。"""

    request_id: int
    scope: str
    total: int
    has_more: bool
    library_track_count: int
    library_size_bytes: int
    truncated: bool
    playlists: tuple[PeerPlaylistItem, ...] = ()
    tracks: tuple[PeerTrackItem, ...] = ()

    @property
    def item_count(self) -> int:
        """本页条目数（歌单 + 曲目）。"""
        return len(self.playlists) + len(self.tracks)

    def to_payload(self) -> dict[str, Any]:
        """事件 / UI 字典：线上形状（`items` = 判别式联合）+ 计数字段。"""
        items: list[dict[str, Any]] = [
            {"kind": "playlist", "playlist": item.to_payload()} for item in self.playlists
        ]
        items += [{"kind": "track", "track": item.to_payload()} for item in self.tracks]
        return {
            "requestID": self.request_id,
            "scope": self.scope,
            "total": self.total,
            "items": items,
            "hasMore": self.has_more,
            "libraryTrackCount": self.library_track_count,
            "librarySizeBytes": self.library_size_bytes,
            "truncated": self.truncated,
            "playlistCount": len(self.playlists),
            "trackCount": len(self.tracks),
        }


def encode_peer_library_request(
    *,
    scope: str,
    playlist_id: str | None = None,
    query: str | None = None,
    offset: int = 0,
    limit: int = DEFAULT_PAGE_LIMIT,
    request_id: int = 0,
) -> bytes:
    """帧 15 载荷编码（§13.2；nil 字段省略，与 Swift Codable 同形）。"""
    payload: dict[str, Any] = {
        "scope": scope,
        "offset": int(offset),
        "limit": int(limit),
        "requestID": int(request_id),
    }
    if playlist_id:
        payload["playlistID"] = playlist_id
    if query:
        payload["query"] = query
    return _encode_json(payload)


def decode_peer_library_response(payload: bytes) -> PeerLibraryPage:
    """帧 16 载荷解码（§13.3）。

    结构性错误（坏 JSON / 非对象 / `items` 不是数组）→ :class:`PullError`；
    **条目级容错**：未知 `kind` / 字段形态不符的条目**静默丢弃**（前向兼容——
    协议明确「加新 case 不破坏旧端解码」，`:132-165` Swift `SyncPeerLibraryCodec`）。
    """
    raw = _decode_json_object(payload, "peer_library_response")
    items = raw.get("items")
    if isinstance(items, (str, bytes)) or not isinstance(items, (list, tuple)):
        raise PullError("peer_library_response 缺 items 数组")
    playlists: list[PeerPlaylistItem] = []
    tracks: list[PeerTrackItem] = []
    for item in items:
        if not isinstance(item, Mapping):
            continue
        kind = item.get("kind")
        if kind == "playlist":
            parsed_playlist = _playlist_item(item.get("playlist"))
            if parsed_playlist is not None:
                playlists.append(parsed_playlist)
        elif kind == "track":
            parsed_track = _track_item(item.get("track"))
            if parsed_track is not None:
                tracks.append(parsed_track)
    return PeerLibraryPage(
        request_id=int_or(raw.get("requestID"), 0),
        scope=str(raw.get("scope") or ""),
        total=int_or(raw.get("total"), 0),
        has_more=bool(raw.get("hasMore")),
        library_track_count=int_or(raw.get("libraryTrackCount"), 0),
        library_size_bytes=int_or(raw.get("librarySizeBytes"), 0),
        truncated=bool(raw.get("truncated")),
        playlists=tuple(playlists),
        tracks=tuple(tracks),
    )


def _playlist_item(raw: Any) -> PeerPlaylistItem | None:
    """一条歌单条目（形态不符 → None，调用方丢弃）。"""
    if not isinstance(raw, Mapping):
        return None
    playlist_id = raw.get("id")
    if not isinstance(playlist_id, str) or not playlist_id:
        return None
    return PeerPlaylistItem(
        id=playlist_id,
        name=str(raw.get("name") or ""),
        track_count=int_or(raw.get("trackCount"), 0),
    )


def _track_item(raw: Any) -> PeerTrackItem | None:
    """一条曲目条目（形态不符 → None，调用方丢弃）。"""
    if not isinstance(raw, Mapping):
        return None
    relative_path = raw.get("relativePath")
    if not isinstance(relative_path, str) or not relative_path:
        return None
    return PeerTrackItem(
        relative_path=relative_path,
        title=optional_str(raw.get("title")),
        artist_name=optional_str(raw.get("artistName")),
        size_bytes=int_or(raw.get("sizeBytes"), 0),
        content_hash=optional_str(raw.get("contentHash")),
    )


class PeerLibraryBrowser:
    """对端内容清单浏览器（帧 15/16；一连接一实例，与 Swift `SyncPeerLibraryClient` 同构）。

    帧驱动（本层不阻塞、不含定时器）：``request()`` 发一页请求并返回 `request_id`，
    响应到达经 :meth:`handle_application_frame` 消费 → 回调事件（`on_event`）；不匹配
    `requestID` 的响应（重复 / 过期）丢弃，载荷解码失败只记账（不影响会话）。
    """

    def __init__(
        self,
        session: ApplicationSender,
        *,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        default_limit: int = DEFAULT_PAGE_LIMIT,
    ) -> None:
        self._session = session
        self._on_event = on_event
        self._default_limit = default_limit
        self._next_request_id = 1
        self._pending: dict[int, dict[str, Any]] = {}
        self._pages: dict[int, PeerLibraryPage] = {}
        self._latest: PeerLibraryPage | None = None
        self._decode_failures: list[str] = []

    # ---------------------------------------------------------------- 查询

    @property
    def pending_ids(self) -> tuple[int, ...]:
        """在途请求的 `requestID`（升序）。"""
        return tuple(sorted(self._pending))

    @property
    def latest(self) -> PeerLibraryPage | None:
        """最近一次成功解析的一页（无 = None）。"""
        return self._latest

    @property
    def decode_failures(self) -> tuple[str, ...]:
        """响应载荷解码失败记录（诊断）。"""
        return tuple(self._decode_failures)

    def page_for(self, request_id: int) -> PeerLibraryPage | None:
        """指定 `requestID` 已到达的一页（未到达 / 已丢弃 = None）。"""
        return self._pages.get(request_id)

    # ---------------------------------------------------------------- 驱动

    def request(
        self,
        *,
        scope: str = SCOPE_TRACKS,
        playlist_id: str | None = None,
        query: str | None = None,
        offset: int = 0,
        limit: int | None = None,
    ) -> int:
        """发一页 `peer_library_request`(15)，返回本端分配的 `requestID`。

        会话未就绪 / 发送失败 → :class:`PullError`（不留悬挂在途记录）。
        """
        if not getattr(self._session, "is_ready", False):
            raise PullError("会话未就绪，无法浏览对端清单")
        page_limit = self._default_limit if limit is None else limit
        request_id = self._next_request_id
        self._next_request_id += 1
        self._pending[request_id] = {
            "scope": scope,
            "offset": int(offset),
            "limit": int(page_limit),
            "playlist_id": playlist_id,
        }
        try:
            self._session.send_application_frame(
                FrameType.PEER_LIBRARY_REQUEST,
                encode_peer_library_request(
                    scope=scope,
                    playlist_id=playlist_id,
                    query=query,
                    offset=offset,
                    limit=page_limit,
                    request_id=request_id,
                ),
            )
        except Exception as error:  # noqa: BLE001 - 发送失败 = 本页失败
            self._pending.pop(request_id, None)
            raise PullError(f"发送对端清单请求失败：{error}") from error
        return request_id

    def handle_application_frame(self, frame_type: int, payload: bytes) -> bool:
        """推入一帧；返回 True = 本模块已消费（总是消费帧 16）。"""
        if frame_type != FrameType.PEER_LIBRARY_RESPONSE:
            return False
        try:
            page = decode_peer_library_response(payload)
        except PullError as error:
            self._decode_failures.append(str(error))
            logger.debug("lansync peer_library_response 解码失败：%s", error)
            self._emit({"action": "preview_error", "error": str(error)})
            return True
        request = self._pending.pop(page.request_id, None)
        if request is None:
            # 重复 / 过期响应：丢弃（仅诊断，不影响其它在途请求，§13.4.2）
            self._emit({"action": "preview_unmatched", "requestID": page.request_id})
            return True
        self._pages[page.request_id] = page
        self._latest = page
        self._emit(
            {
                "action": "preview",
                "offset": int(request["offset"]),
                "limit": int(request["limit"]),
                **page.to_payload(),
            }
        )
        return True

    def cancel(self) -> None:
        """作废全部在途请求（不改变会话状态）。"""
        self._pending.clear()

    # ------------------------------------------------------------ 内部辅助

    def _emit(self, extra: Mapping[str, Any]) -> None:
        """产出事件（回调异常不影响本层状态）。"""
        callback = self._on_event
        if callback is None:
            return
        payload: dict[str, Any] = dict(extra)
        try:
            callback(payload)
        except Exception:  # noqa: BLE001 - 事件回调异常不得中断编排
            logger.exception("lansync 对端清单事件回调失败")


# ============ 认领表（传输级身份 → 目标相对路径） ============
class _ClaimIndex:
    """收到的文件 → 目标相对路径（**传输级身份优先，文件名仅兜底且要求唯一**）。

    身份口径（§11.6）：应答端 `fileID` = 该文件的 `content_hash`，因此对端清单里的
    `contentHash` 就是认领键；同一身份对应多个路径 = 歧义 → 不可认领（退回文件名），
    文件名同样冲突 = 认领失败（如实记 `unclaimed`，绝不按名字猜目标路径）。
    """

    __slots__ = ("_by_hash", "_by_name")

    def __init__(self, entries: Sequence[ManifestEntry] = ()) -> None:
        by_hash: dict[str, str | None] = {}
        by_name: dict[str, str | None] = {}
        for entry in entries:
            normalized = normalize_relative_path(entry.relative_path)
            if normalized is None:
                continue
            if entry.content_hash:
                by_hash[entry.content_hash] = (
                    normalized if entry.content_hash not in by_hash else None
                )
            name = normalized.rsplit("/", 1)[-1]
            by_name[name] = normalized if name not in by_name else None
        self._by_hash = by_hash
        self._by_name = by_name

    def claim(self, file_id: str | None, sha256_hex: str | None = None) -> str | None:
        """按传输级身份认领（`fileID` 优先，其次整文件 sha256）；认不到 = None。"""
        for key in (file_id, sha256_hex):
            if key and self._by_hash.get(key):
                return self._by_hash[key]
        return None

    def claim_by_name(self, name: str | None) -> str | None:
        """按传输名兜底认领（仅当该名字在请求集合里唯一）；认不到 = None。"""
        if not name:
            return None
        return self._by_name.get(name)

    def path_for_file_id(self, file_id: str | None) -> str | None:
        """`fileID` → 目标相对路径（进度事件用；认不到 = None）。"""
        return self._by_hash.get(file_id) if file_id else None


# ============ 拉取编排 ============
class LibraryPullRun:
    """一次「从设备拉取」的运行实例（帧驱动；一连接一实例）。

    生命周期：``start()`` 发 manifest 请求 → 收帧 11 → 拉取方向对账 → 发帧 12
    （点名集合为空则直接收尾）→ 收帧 4/5/6（`FileReceiver` 落盘 + 校验 + 认领 + 落位 + 入库）
    → 收帧 13 收尾。终态后 ``status()`` 仍可查询（账目保留）。
    """

    def __init__(
        self,
        session: ApplicationSender,
        *,
        relative_paths: Iterable[Any] | None = None,
        root: Any = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
        run_id: str | None = None,
        incoming_dir_name: str = INCOMING_DIR_NAME,
    ) -> None:
        """`relative_paths` = 本端点名集合（缺省 None = 对端全库）。

        `on_event` = 进度 / 状态事件回调（service 层转 `EventType.PULL`）。
        """
        self.run_id = run_id or uuid.uuid4().hex
        self._session = session
        self._root = root
        self._on_event = on_event
        self._incoming_dir_name = incoming_dir_name
        self._collection = (
            Collection.all() if relative_paths is None else Collection.tracks(relative_paths)
        )
        self._selection_raw: tuple[str, ...] | None = (
            None if relative_paths is None else tuple(self._collection.ids)
        )
        self._selection: frozenset[str] | None = (
            None
            if relative_paths is None
            else frozenset(
                path
                for path in (normalize_relative_path(raw) for raw in self._collection.ids)
                if path is not None
            )
        )

        self._state = PullState.IDLE
        self._error: str | None = None
        self._summary = LibraryPullSummary()
        self._received_bytes = 0
        self._total_bytes = 0
        self._root_name: str | None = None
        self._claims = _ClaimIndex()
        self._receiver: FileReceiver | None = None
        self._staging_dir: Path | None = None

    # ---------------------------------------------------------------- 查询

    @property
    def state(self) -> PullState:
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
        """本次点名集合（`all` = 全库）。"""
        return self._collection

    @property
    def is_terminal(self) -> bool:
        """是否已到终态（done / failed）。"""
        return self._state in (PullState.DONE, PullState.FAILED)

    @property
    def summary(self) -> LibraryPullSummary:
        """结果账目（实时值）。"""
        return self._summary

    def status(self) -> dict[str, Any]:
        """可查询状态对象（`pull_status` 返回值；键名 camelCase）。"""
        payload: dict[str, Any] = {
            "run_id": self.run_id,
            "peer_id": self.peer_id,
            "session_id": self.session_id,
            "state": self._state.value,
            "selection": self._collection.to_payload(),
            "rootName": self._root_name,
            "receivedBytes": self._received_bytes,
            "totalBytes": self._total_bytes,
            **self._summary.to_dict(),
        }
        if self._error:
            payload["error"] = self._error
        return payload

    # ---------------------------------------------------------------- 驱动

    def start(self) -> None:
        """开始一次拉取：置 `requestingManifest` 并发 `manifest_request`(10)。

        会话未 ready / 发送失败 → :class:`PullError`（状态落 `failed`）。
        """
        if not getattr(self._session, "is_ready", False):
            raise PullError("会话未就绪，无法拉取")
        self._transition(PullState.REQUESTING_MANIFEST)
        try:
            self._session.send_application_frame(
                FrameType.MANIFEST_REQUEST, encode_manifest_request(Collection.all())
            )
        except Exception as error:  # noqa: BLE001 - 发送失败 = 本次拉取失败
            self._fail(f"请求对端 manifest 失败：{error}")
            raise PullError(f"请求对端 manifest 失败：{error}") from error

    def handle_application_frame(self, frame_type: int, payload: bytes) -> bool:
        """推入一帧；返回 True = 本次拉取已消费（service 不再转交其它 handler）。"""
        if frame_type == FrameType.MANIFEST_RESPONSE:
            self._handle_manifest_response(payload)
            return True
        if frame_type in (FrameType.FILE_META, FrameType.FILE_CHUNK):
            if self._state is not PullState.FETCHING:
                return False  # 未在取文件：留给独立的接收方
            self._handle_file_frame(frame_type, payload)
            return True
        if frame_type == FrameType.SYNC_FETCH_RESULT and self._state is PullState.FETCHING:
            self._handle_fetch_result(payload)
            return True
        return False

    def cancel(self) -> bool:
        """本端取消（终态后 = False）：中止在途接收、账目保留。"""
        if self.is_terminal:
            return False
        self._close_receiver()
        self._fail(REASON_CANCELLED)
        return True

    def handle_session_closed(self) -> None:
        """会话关闭：中止在途接收；未终态 → 落 `failed`（原因 `session_closed`）。"""
        self._close_receiver()
        if not self.is_terminal:
            self._fail(REASON_SESSION_CLOSED)

    # ------------------------------------------------------------ 内部推进

    def _handle_manifest_response(self, payload: bytes) -> None:
        """对端曲库快照 → 拉取方向对账 → 发取文件请求（无待取条目 = 直接收尾）。"""
        if self._state is not PullState.REQUESTING_MANIFEST:
            return  # 迟到的 / 重复的响应：忽略（不改状态）
        try:
            remote_entries, root_name = decode_manifest_response(payload)
        except PushError as error:
            self._fail(f"manifest_response 载荷非法：{error}")
            return
        self._root_name = root_name
        try:
            local_entries = manifest_entries(Collection.all(), root=self._root)
        except Exception as error:  # noqa: BLE001 - 本端曲库事实不可用 = 本次拉取失败
            self._fail(f"生成本端清单失败：{error}")
            return
        plan = pull_plan(remote_entries, local_entries, self._selection)
        self._summary.unchanged = [entry.relative_path for entry in plan.unchanged]
        self._summary.requested = [entry.relative_path for entry in plan.to_fetch]
        # 点名集合里「对端没有 / 路径非法」的条目：本端如实记账（不静默丢，便于 UI 定位）
        self._summary.failed = self._selection_failures(remote_entries)
        self._claims = _ClaimIndex(plan.to_fetch)
        self._total_bytes = sum(max(0, entry.size) for entry in plan.to_fetch)
        if not plan.to_fetch:
            self._transition(PullState.DONE)
            return
        self._transition(PullState.FETCHING)
        request = FetchRequest(Collection.all(), tuple(self._summary.requested))
        try:
            self._session.send_application_frame(
                FrameType.SYNC_FETCH_REQUEST, encode_fetch_request(request)
            )
        except Exception as error:  # noqa: BLE001
            self._fail(f"发送取文件请求失败：{error}")

    def _selection_failures(self, remote_entries: Sequence[ManifestEntry]) -> list[PullFailure]:
        """点名集合 → 无法履行的条目（路径非法 / 对端清单里没有）。

        仅当调用方**显式点名**时生效（全库拉取没有「点名缺失」这个概念）；本端扩展：
        Swift 把这类路径静默丢弃，本端如实记账（`invalid_path` / `not_found`）。
        """
        raw_selection = self._selection_raw
        if raw_selection is None:
            return []
        remote_paths = {
            entry.relative_path
            for entry in remote_entries
            if normalize_relative_path(entry.relative_path) == entry.relative_path
        }
        failures: list[PullFailure] = []
        for raw in raw_selection:
            normalized = normalize_relative_path(raw)
            if normalized is None:
                failures.append(
                    PullFailure(raw, REASON_INVALID_PATH, "点名路径非法（空 / 绝对路径 / .. 逃逸）")
                )
            elif normalized not in remote_paths:
                failures.append(PullFailure(normalized, REASON_NOT_FOUND, "对端清单里没有该路径"))
        return failures

    def _handle_file_frame(self, frame_type: int, payload: bytes) -> None:
        """帧 4/5 → `FileReceiver`（落盘 + 校验）；有回 ack 则报一条进度。"""
        receiver = self._ensure_receiver()
        if receiver is None:
            return
        ack = receiver.handle_frame(frame_type, payload)
        if ack is None:
            return
        self._emit(
            {
                "action": "progress",
                "path": self._claims.path_for_file_id(ack.file_id),
                "fileID": ack.file_id,
                "fileReceivedBytes": int(ack.received_bytes),
                "done": bool(ack.done),
                "error": ack.error.value,
            }
        )

    def _ensure_receiver(self) -> FileReceiver | None:
        """惰性建落地目录 + 接收端（曲库根内隐藏目录；起不来 → 落失败态）。"""
        if self._receiver is not None:
            return self._receiver
        staging = library_root(self._root) / self._incoming_dir_name
        try:
            staging.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            self._fail(f"落地目录创建失败：{error}")
            return None
        self._staging_dir = staging
        self._receiver = FileReceiver(
            staging, send=self._send_frame, on_completion=self._handle_received
        )
        return self._receiver

    def _send_frame(self, frame_type: int, payload: bytes) -> None:
        """业务帧发送回调（交给会话层加密发送）。"""
        self._session.send_application_frame(frame_type, payload)

    def _handle_received(self, result: FileTransferResult) -> None:
        """一轮接收终态：校验/认领失败只记账；成功则落位 + 导入本端曲库。"""
        if self.is_terminal:
            return
        relative_path = self._claims.claim(result.file_id, result.sha256_hex)
        if relative_path is None:
            relative_path = self._claims.claim_by_name(_received_name(result))
        if not result.ok:
            self._record_failure(
                relative_path or _received_name(result),
                REASON_SEND_FAILED,
                result.detail or (result.error.value if result.error else ""),
            )
            return
        if relative_path is None:
            self._record_failure(
                _received_name(result),
                REASON_UNCLAIMED,
                "收到的文件与点名集合对不上（身份与文件名都无匹配）",
            )
            return
        target = self._target_path(relative_path)
        if target is None:
            self._record_failure(relative_path, REASON_INVALID_PATH, "目标路径非法 / 越出曲库根")
            return
        if not self._land(result, target, relative_path):
            return
        self._summary.completed.append(relative_path)
        self._received_bytes += max(0, result.total_size)
        self._total_bytes = max(self._total_bytes, self._received_bytes)
        self._import_landed(target, relative_path, result)
        self._emit(
            {
                "action": "file",
                "path": relative_path,
                "sha256Hex": result.sha256_hex,
                "size": int(result.total_size),
            }
        )

    def _land(self, result: FileTransferResult, target: Path, relative_path: str) -> bool:
        """把接收端落好的文件移入目标相对路径（目录不存在则创建；目标已存在则覆盖）。"""
        source = result.target_path
        if source is None:
            self._record_failure(relative_path, REASON_SEND_FAILED, "接收端未给出落地文件路径")
            return False
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)  # 原子替换：目标已存在即「更新」语义（不先删）
        except OSError as error:
            self._record_failure(relative_path, REASON_SEND_FAILED, f"落位失败：{error}")
            return False
        return True

    def _target_path(self, relative_path: str) -> Path | None:
        """相对路径 → 曲库根内绝对路径（越界/非法 → None，绝不写出根外）。"""
        normalized = normalize_relative_path(relative_path)
        if normalized is None:
            return None
        root_path = library_root(self._root)
        target = root_path.joinpath(*normalized.split("/"))
        root_real = os.path.realpath(root_path)
        target_real = os.path.realpath(target)
        if target_real != root_real and not target_real.startswith(
            root_real.rstrip(os.sep) + os.sep
        ):
            return None
        return target

    def _import_landed(self, target: Path, relative_path: str, result: FileTransferResult) -> None:
        """落盘文件 → 本端曲库事实：指纹落库 + 扫描缓存失效（下次扫描即可见）。

        失败只记日志：文件已落位（用户可见），指纹与扫描缓存都是可再生的派生态。
        """
        from app import db, state  # 延迟 import：保持本模块导入链干净（与 locallib 同源）

        try:
            stat_info = os.stat(target)
        except OSError:
            logger.warning("lansync 落地文件不可 stat：%s", target, exc_info=True)
            return
        digest = result.sha256_hex or ""
        if not digest:
            try:
                digest = sha256_file(target)
            except OSError:
                digest = ""
        if digest:
            try:
                db.track_fingerprints_upsert(
                    [
                        {
                            "relative_path": relative_path,
                            "content_hash": digest,
                            "size": int(stat_info.st_size),
                            "mtime_ms": int(stat_info.st_mtime * 1000),
                        }
                    ]
                )
            except Exception:  # noqa: BLE001 - 指纹落库失败不影响落位事实
                logger.warning("lansync 指纹落库失败：%s", relative_path, exc_info=True)
        state._scan_cache = None  # 下次扫描（惰性）即可见新文件，无需重启

    def _handle_fetch_result(self, payload: bytes) -> None:
        """取文件结果帧（13）：并入对端回报的失败 → `done`。"""
        if self._state is not PullState.FETCHING:
            return
        try:
            result = decode_fetch_result(payload)
        except FetchPayloadError as error:
            self._fail(f"sync_fetch_result 载荷非法：{error}")
            return
        self._summary.reported_completed = list(result.completed)
        known = {failure.relative_path for failure in self._summary.failed}
        for failure in result.failed:
            if failure.relative_path in known:
                continue
            known.add(failure.relative_path)
            self._summary.failed.append(PullFailure(failure.relative_path, failure.reason))
        self._receiver = None  # 本轮结束：不再接文件帧
        self._transition(PullState.DONE)

    def _record_failure(self, relative_path: str, reason: str, detail: str = "") -> None:
        """记一条失败（本端解析 / 落位 + 传输终态共用）。"""
        self._summary.failed.append(PullFailure(relative_path, reason, detail or None))
        if detail:
            logger.debug("lansync 拉取失败（%s）：%s", relative_path, detail)
        self._emit({"action": "failure", "path": relative_path, "reason": reason})

    def _close_receiver(self) -> None:
        """中止在途接收（`.part` 保留：可续传）。"""
        receiver, self._receiver = self._receiver, None
        if receiver is not None:
            receiver.cancel()

    def _transition(self, state: PullState) -> None:
        """状态迁移 + 事件（终态含完整账目）。"""
        self._state = state
        self._emit({})

    def _fail(self, error: str, *, state: PullState = PullState.FAILED) -> None:
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
            "receivedBytes": self._received_bytes,
            "totalBytes": self._total_bytes,
            **self._summary.to_dict(),
        }
        payload.update(extra)
        try:
            callback(payload)
        except Exception:  # noqa: BLE001 - 事件回调异常不得中断编排
            logger.exception("lansync 拉取事件回调失败（run=%s）", self.run_id)


# ============ 小工具 ============
def _received_name(result: FileTransferResult) -> str:
    """接收终态的展示名（诊断 / 失败记录用）。"""
    if result.target_path is not None:
        return Path(result.target_path).name
    return result.file_id


def _encode_json(payload: dict[str, Any]) -> bytes:
    """载荷字典 → JSON 字节（紧凑、UTF-8、不转义非 ASCII）。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _decode_json_object(payload: bytes, what: str) -> dict[str, Any]:
    """帧 payload → JSON 对象（坏 JSON / 非对象 → :class:`PullError`）。"""
    try:
        value = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise PullError(f"{what} 不是合法 JSON：{error}") from error
    if not isinstance(value, dict):
        raise PullError(f"{what} 不是 JSON 对象")
    return value
