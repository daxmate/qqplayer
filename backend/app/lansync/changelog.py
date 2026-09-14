"""局域网同步（S2）S4 —— 播放数据变更日志（帧 8/9）：outbox / 游标 / LWW / 引用映射。

对位 Swift（只读参考）：`SyncChangeLogStore` / `SyncChangeLogPeer` / `SyncLWWReconcile` /
`SyncChangeLogApplier` / `SyncChangeLogMapping` / `SyncChangeLogPendingStore` /
`SyncChangeLogDeletionPolicy` / `SyncPlaybackCarryPlan` / `SyncPlaybackCarryPeer`。
线协议契约：`docs/lan-sync-protocol.md` §14（§14.9 的三条语义由用户拍板）。

════════════════════════════════════════════════════════════════════════════
web 侧身份口径（与 Swift 的关键差异，**本模块的映射基准**）
════════════════════════════════════════════════════════════════════════════
- Swift 本端歌曲身份 = `track.stable_id`（绝对路径哈希，单端私有）；
  web 曲库是**文件系统扫描**结果、没有 songs 表，故 **web 的本端身份 = 曲库相对路径**
  （`locallib.normalize_relative_path` 口径，POSIX）。
- 跨端身份键两端一致：**歌曲 `content_hash`**（音频字节 SHA-256，`track_fingerprints` 缓存；
  Swift 侧是 `track.content_hash`）。行键与载荷里的歌曲引用在**线上仍是发送端本端形态**
  （§14.8 v1 格式不变，老 peer 可互通），接收端一律按 `content_hash` 本地化改写。

§14.9 三条语义（本模块是唯一实现点）：
1. **仅同步两端共有的歌** —— 跟歌走的计划器按 `content_hash` 配对（一端独有的歌不带）；
2. **跟歌走** —— 推送 / 拉取一首歌时，该歌的播放数据随行（帧 9 / 帧 8）；
3. **不传播删除** —— delete 本地照常留痕，**永不上线**；收到 delete 一律忽略。

本模块纯逻辑 + 存储调用（SQL 在 `app/db.py`）；帧收发经注入的会话对象（测试可替身）。
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Protocol

from app import db

from .frame import FrameType
from .locallib import (
    ensure_content_hash,
    library_root,
    normalize_relative_path,
    resolve_library_file,
)
from .lyrics import is_lyrics_path

logger = logging.getLogger(__name__)

# ============ 实体 / 操作（线上字符串契约，改动即破坏兼容） ============
ENTITY_FAVORITE = "favorite"
ENTITY_PLAY_HISTORY = "play_history"
ENTITY_PLAYLIST = "playlist"
ENTITY_PLAYLIST_ITEM = "playlist_item"
#: 播放位置上下文：v1 **不参与**同步（Swift `v1Synced` 不含；本地载体非 DB 行）
ENTITY_PLAYBACK_POSITION = "playback_position"

#: v1 参与同步的实体（§14.4）
V1_SYNCED_ENTITIES: tuple[str, ...] = (
    ENTITY_FAVORITE,
    ENTITY_PLAY_HISTORY,
    ENTITY_PLAYLIST,
    ENTITY_PLAYLIST_ITEM,
)
#: 歌维度实体（「跟歌走」的取数范围；歌单结构非歌维度，走选择集同步）
TRACK_SCOPED_ENTITIES: tuple[str, ...] = (
    ENTITY_FAVORITE,
    ENTITY_PLAY_HISTORY,
    ENTITY_PLAYLIST_ITEM,
)

OP_UPSERT = "upsert"
OP_DELETE = "delete"

#: 一批的默认大小（§14.6：`page` / `sendIncrement` 默认 500）
DEFAULT_BATCH_SIZE = 500


# ============ 删除不传播（§14.9 决策 7 的单一事实源） ============
def is_delete(op: Any) -> bool:
    """该 op 是否为删除（线上删除 op 常量 = `"delete"`）。"""
    return str(op) == OP_DELETE


def is_transmittable(op: Any) -> bool:
    """发送侧：该变更是否允许上线。**delete 不上线**；未知 op 不误伤。"""
    return not is_delete(op)


def transmittable_indexes(rows: Sequence[Mapping[str, Any]]) -> list[int]:
    """发送侧：一批 outbox 行（**按 outbox id 升序**）里允许上线的下标。

    两条规则（§14.9/§12b-7）：
    ① 自身是 delete 的行不上线；
    ② 同一 `(entity, row_key)` 在**本批最后一行是 delete** 时，其更早的 upsert 也不上线——
       否则会在对端复活一个本端已删除的状态，而 delete 永不上线 → 无法纠正。
    """
    last_index: dict[str, int] = {}
    for index, row in enumerate(rows):
        last_index[_policy_key(row)] = index
    out: list[int] = []
    for index, row in enumerate(rows):
        if not is_transmittable(row.get("op")):
            continue
        tail = rows[last_index[_policy_key(row)]]
        if is_transmittable(tail.get("op")):
            out.append(index)
    return out


def _policy_key(row: Mapping[str, Any]) -> str:
    """策略键：与业务侧 `(entity, row_key)` 同口径（分隔符不可出现在两段里）。"""
    return f"{row.get('entity')}\u001f{row.get('row_key')}"


# ============ 行键形态（§14.5）与快照载荷 ============
def favorite_row_key(relative_path: str) -> str:
    """收藏行键 = 本端曲目身份（web = 曲库相对路径）。"""
    return relative_path


def play_history_row_key(relative_path: str, played_at_ms: int) -> str:
    """播放历史行键 = `"{路径}|{播放时刻毫秒}"`（复合；从**最后一个** `|` 切）。"""
    return f"{relative_path}|{int(played_at_ms)}"


def playlist_row_key(playlist_id: str) -> str:
    """歌单行键 = 歌单标识（web 歌单 id = Swift 的 slug 等价物）。"""
    return playlist_id


def playlist_item_row_key(playlist_id: str, relative_path: str) -> str:
    """歌单项行键 = `"{歌单标识}|{曲目身份}"`（位置不入键，重排不漂移）。"""
    return f"{playlist_id}|{relative_path}"


def parse_composite_row_key(row_key: str) -> tuple[str, int] | None:
    """按**最后一个** `|` 切分，右段必须是整数（播放历史用；左段可含 `|`）。"""
    index = str(row_key).rfind("|")
    if index < 0:
        return None
    left, right = str(row_key)[:index], str(row_key)[index + 1 :]
    try:
        return (left, int(right))
    except ValueError:
        return None


def split_row_key(row_key: str) -> tuple[str, str] | None:
    """按**最后一个** `|` 切分为两段字符串（歌单项用；两侧都不能为空）。"""
    index = str(row_key).rfind("|")
    if index < 0:
        return None
    left, right = str(row_key)[:index], str(row_key)[index + 1 :]
    if not left or not right:
        return None
    return (left, right)


#: 引用的歌曲键在快照里的字段名（与 Swift `SyncDataSnapshots` 逐字一致）
TRACK_ID_FIELD = "track_stable_id"


def favorite_snapshot(relative_path: str) -> dict[str, Any]:
    """收藏行快照（Swift `SyncFavoriteSnapshot` 同形）。"""
    return {TRACK_ID_FIELD: relative_path}


def play_history_snapshot(
    relative_path: str, played_at_ms: int, play_duration_ms: int
) -> dict[str, Any]:
    """播放历史行快照（Swift `SyncPlayHistorySnapshot` 同形）。"""
    return {
        TRACK_ID_FIELD: relative_path,
        "played_at": int(played_at_ms),
        "play_duration_ms": int(max(0, play_duration_ms)),
    }


def playlist_snapshot(
    playlist_id: str,
    title: str,
    created_at_ms: int,
    updated_at_ms: int,
) -> dict[str, Any]:
    """歌单结构快照（Swift `SyncPlaylistSnapshot` 同形；web 没有的字段给确定默认值）。

    web 歌单只有 `id / name / createdAt / updatedAt`：标题取 name、slug 取 id；
    `last_played_at` = 0、`folder_path` = None、`is_folder_synced` = False
    （web 无「文件夹同步歌单」概念）；`custom_cover_image_path` = None
    （web 歌单封面按内容派生，不落库）。
    """
    return {
        "slug": playlist_id,
        "title": title,
        "created_at": int(created_at_ms),
        "updated_at": int(updated_at_ms),
        "last_played_at": 0,
        "folder_path": None,
        "is_folder_synced": False,
        "last_folder_sync": None,
        "custom_cover_image_path": None,
    }


def playlist_item_snapshot(playlist_id: str, position: int, relative_path: str) -> dict[str, Any]:
    """歌单项快照（Swift `SyncPlaylistItemSnapshot` 同形）。"""
    return {
        "playlist_slug": playlist_id,
        "position": int(position),
        TRACK_ID_FIELD: relative_path,
    }


def encode_payload(snapshot: Mapping[str, Any] | None) -> str | None:
    """快照 → `payload_json` 文本（紧凑 JSON；None = 无快照）。"""
    if snapshot is None:
        return None
    return json.dumps(dict(snapshot), ensure_ascii=False, separators=(",", ":"))


def decode_payload(payload_json: Any) -> dict[str, Any] | None:
    """`payload_json` → 快照字典（非对象 / 非法 JSON → None）。"""
    if not payload_json:
        return None
    try:
        raw = json.loads(payload_json)
    except (ValueError, TypeError):
        return None
    return raw if isinstance(raw, dict) else None


def track_reference(entity: Any, row_key: str, payload_json: Any) -> str | None:
    """行内歌曲引用（单一事实源，§14.5）：取 row_key，形态不符回落读快照。

    `playlist` 只是结构、**不引用歌曲**（返回 None）。
    """
    name = str(entity)
    if name == ENTITY_PLAYLIST:
        return None
    if name in (ENTITY_FAVORITE, ENTITY_PLAYBACK_POSITION):
        return row_key or None
    if name == ENTITY_PLAY_HISTORY:
        parsed = parse_composite_row_key(row_key)
        if parsed is not None:
            return parsed[0] or None
        snapshot = decode_payload(payload_json)
        return _optional_str((snapshot or {}).get(TRACK_ID_FIELD))
    if name == ENTITY_PLAYLIST_ITEM:
        split = split_row_key(row_key)
        if split is not None:
            return split[1]
        snapshot = decode_payload(payload_json)
        return _optional_str((snapshot or {}).get(TRACK_ID_FIELD))
    return None


def _optional_str(raw: Any) -> str | None:
    """非字符串 / 去空白后为空 → None（线上 nil 口径）。"""
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    return trimmed or None


def now_ms() -> int:
    """当前时刻（毫秒 since 1970）——v1 统一用 outbox 时间戳当 LWW 时钟（§14.7）。"""
    return int(time.time() * 1000)


# ============ 行模型 / 线载荷 ============
@dataclass(frozen=True, slots=True)
class ChangeLogRow:
    """一行 outbox（本端或远端）；`row_key` 为**对应端**的本地形态。

    `content_hash` = 跨端歌曲身份键（线上 entry 的 `contentHash`）：收侧本地化必须靠它
    （row_key 是发送端形态），故行模型也带着它同行（Swift 侧是 entry 与 row 两个值一并传递）。
    """

    entity: str
    row_key: str
    op: str
    updated_at_ms: int
    payload_json: str | None = None
    id: int = 0
    content_hash: str | None = None

    @property
    def is_delete(self) -> bool:
        """是否删除行（delete 永不上线；收到一律忽略）。"""
        return is_delete(self.op)

    def to_wire_entry(self, content_hash: str | None = None) -> dict[str, Any]:
        """→ 帧 9 的 entry（camelCase 键；nil 字段省略，与 Swift Codable 同形）。

        `content_hash` 缺省取行自身带的（发送侧一律显式传：按行内歌曲引用查指纹）。
        """
        digest = content_hash if content_hash is not None else self.content_hash
        entry: dict[str, Any] = {
            "id": int(self.id),
            "entity": self.entity,
            "rowKey": self.row_key,
            "op": self.op,
            "updatedAtMs": int(self.updated_at_ms),
        }
        if digest:
            entry["contentHash"] = digest
        if self.payload_json is not None:
            entry["payloadJSON"] = self.payload_json
        return entry

    @classmethod
    def from_db(cls, row: Mapping[str, Any]) -> ChangeLogRow:
        """db 行字典 → 行模型。"""
        return cls(
            entity=str(row.get("entity", "")),
            row_key=str(row.get("row_key", "")),
            op=str(row.get("op", "")),
            updated_at_ms=int(row.get("updated_at") or 0),
            payload_json=row.get("payload_json"),
            id=int(row.get("id") or 0),
        )

    @classmethod
    def from_wire_entry(cls, entry: Mapping[str, Any]) -> ChangeLogRow:
        """帧 9 entry → 行模型（保留远端 outbox id：对账排序键 `(updatedAtMs, id)`）。"""
        raw_id = entry.get("id")
        try:
            outbox_id = int(raw_id or 0)
        except (TypeError, ValueError):
            outbox_id = 0
        try:
            updated_at = int(entry.get("updatedAtMs") or 0)
        except (TypeError, ValueError):
            updated_at = 0
        payload = entry.get("payloadJSON")
        return cls(
            entity=str(entry.get("entity", "")),
            row_key=str(entry.get("rowKey", "")),
            op=str(entry.get("op", "")),
            updated_at_ms=max(0, updated_at),
            payload_json=payload if isinstance(payload, str) else None,
            id=max(0, outbox_id),
            content_hash=_optional_str(entry.get("contentHash")),
        )


@dataclass(frozen=True, slots=True)
class ChangeLogPage:
    """一页增量 + 本批实际末行 id（§14.6 S1 口径：空批不推进）。"""

    rows: tuple[ChangeLogRow, ...]
    last_outbox_id: int


def decode_pull_request(payload: bytes) -> int:
    """帧 8 载荷 → 游标（非对象 / 字段非法 → 0 = 全量拉）。"""
    raw = _decode_json_object(payload)
    if raw is None:
        return 0
    try:
        return max(0, int(raw.get("cursor") or 0))
    except (TypeError, ValueError):
        return 0


def encode_pull_request(cursor: int) -> bytes:
    """游标 → 帧 8 载荷。"""
    return _encode_json({"cursor": max(0, int(cursor))})


def decode_push_payload(payload: bytes) -> tuple[list[ChangeLogRow], int]:
    """帧 9 载荷 → `(远端行列表, lastOutboxID)`；结构非法抛 `ValueError`。"""
    raw = _decode_json_object(payload)
    if raw is None:
        raise ValueError("change_log_push 载荷不是 JSON 对象")
    entries = raw.get("entries")
    if entries is None:
        entries = []
    if not isinstance(entries, list):
        raise ValueError("change_log_push.entries 不是数组")
    rows = [ChangeLogRow.from_wire_entry(item) for item in entries if isinstance(item, Mapping)]
    try:
        last_id = max(0, int(raw.get("lastOutboxID") or 0))
    except (TypeError, ValueError):
        last_id = 0
    return rows, last_id


def encode_push_payload(entries: Sequence[Mapping[str, Any]], last_outbox_id: int) -> bytes:
    """帧 9 载荷（条目 + 本批末行 id）。"""
    return _encode_json({"entries": list(entries), "lastOutboxID": max(0, int(last_outbox_id))})


def _encode_json(payload: Mapping[str, Any]) -> bytes:
    """载荷字典 → JSON 字节（紧凑 + 不转义非 ASCII，与生产其它帧同形）。"""
    return json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _decode_json_object(payload: bytes) -> dict[str, Any] | None:
    """帧载荷 → 字典（空载荷 / 非法 JSON / 非对象 → None）。"""
    if not payload:
        return None
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    return raw if isinstance(raw, dict) else None


# ============ LWW 对账（纯逻辑，§14.7） ============
@dataclass(frozen=True, slots=True)
class ReconcileResult:
    """对账结果：应应用的远端行 + 本端胜出的行（本端胜出无需动作，仅供记账）。"""

    apply_remote: tuple[ChangeLogRow, ...] = ()
    local_wins: tuple[ChangeLogRow, ...] = ()


def representative_of(rows: Sequence[ChangeLogRow]) -> ChangeLogRow | None:
    """同键多行的代表行：`updated_at` 最大；平局取 `id` 最大（= 最新落库）。"""
    if not rows:
        return None
    return max(rows, key=lambda row: (row.updated_at_ms, row.id))


def reconcile(
    local_rows: Sequence[ChangeLogRow], remote_rows: Sequence[ChangeLogRow]
) -> ReconcileResult:
    """按 `(entity, row_key)` 分组合并，返回远端胜出的行（升序，逐条应用即幂等收敛）。

    同键比较（§14.7，与 Swift `SyncLWWReconcile.merge` 逐条对齐）：

    | 情形 | 裁定 |
    | --- | --- |
    | 远端 `updated_at` > 本地 | 应用远端 |
    | 相等，远端 delete 且本地 upsert | **delete 胜**（但接收侧 delete 已在更早处被拦掉） |
    | 其余平局 | **本端胜**（不应用远端，避免乒乓） |
    | 远端独有的键 | 直接应用（本端无对象可删时应用层幂等跳过） |
    """
    local_latest: dict[str, ChangeLogRow] = {}
    for row in local_rows:
        key = _row_key(row)
        current = local_latest.get(key)
        if current is None or (row.updated_at_ms, row.id) > (current.updated_at_ms, current.id):
            local_latest[key] = row
    remote_latest: dict[str, ChangeLogRow] = {}
    for row in remote_rows:
        key = _row_key(row)
        current = remote_latest.get(key)
        if current is None or (row.updated_at_ms, row.id) > (current.updated_at_ms, current.id):
            remote_latest[key] = row

    apply_remote: list[ChangeLogRow] = []
    local_wins: list[ChangeLogRow] = []
    for key, remote in remote_latest.items():
        local = local_latest.get(key)
        if local is None:
            apply_remote.append(remote)
            continue
        if remote.updated_at_ms > local.updated_at_ms:
            apply_remote.append(remote)
        elif remote.updated_at_ms == local.updated_at_ms:
            if remote.is_delete and not local.is_delete:
                apply_remote.append(remote)
            else:
                local_wins.append(local)
        else:
            local_wins.append(local)
    order = lambda row: (row.updated_at_ms, row.id)  # noqa: E731 - 排序键（同 Swift）
    return ReconcileResult(
        apply_remote=tuple(sorted(apply_remote, key=order)),
        local_wins=tuple(sorted(local_wins, key=order)),
    )


def _row_key(row: ChangeLogRow) -> str:
    """对账键 `(entity, row_key)` 的字符串形态。"""
    return f"{row.entity}\u001f{row.row_key}"


# ============ 存储门面（SQL 在 app/db.py；本层只做语义） ============
class ChangeLogStore:
    """outbox / 两张游标 / 挂起表的读写门面（`root` = 本端曲库根，缺省 `state.LIBRARY`）。

    与 Swift `SyncChangeLogStore` 对位：`record`（业务写点由 db 层在同事务内调用）、
    `page`（增量 + 本批末行 id）、两张方向相反的游标、挂起存储。
    """

    def __init__(self, *, root: Any = None) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        """本端曲库根（显式注入优先，缺省 `state.LIBRARY`）。"""
        return library_root(self._root)

    # ---- outbox ----
    def record(self, rows: Sequence[Mapping[str, Any]]) -> int:
        """追加 outbox 行（**独立事务**；业务写点请走 db 层同事务钩子）。"""
        return db.sync_outbox_append(list(rows))

    def page(self, after: int = 0, limit: int = DEFAULT_BATCH_SIZE) -> ChangeLogPage:
        """取一页增量 + 本批末行 id（同一读事务；空批不推进）。"""
        raw = db.sync_outbox_page(after, limit)
        return ChangeLogPage(
            rows=tuple(ChangeLogRow.from_db(row) for row in raw["rows"]),
            last_outbox_id=int(raw["last_outbox_id"]),
        )

    def max_id(self) -> int:
        """本端 outbox 当前最大 id。"""
        return db.sync_outbox_max_id()

    def latest(self, refs: Sequence[tuple[str, str]]) -> dict[tuple[str, str], ChangeLogRow]:
        """批量取这些 `(entity, row_key)` 的本端最新行（对账代表本端事实）。"""
        raw = db.sync_outbox_latest(list(refs))
        return {key: ChangeLogRow.from_db(row) for key, row in raw.items()}

    def rows_for_entities(self, entities: Sequence[str] | None = None) -> list[ChangeLogRow]:
        """按实体取全部 outbox 行（outbox id 升序）。"""
        return [
            ChangeLogRow.from_db(row) for row in db.sync_outbox_load(list(entities or ()) or None)
        ]

    def track_rows(self, stable_id: str) -> list[ChangeLogRow]:
        """某首歌的全部播放数据变更行（未过滤 delete；计划器自己按 §14.9 过滤）。"""
        if not stable_id:
            return []
        return [
            row
            for row in self.rows_for_entities(TRACK_SCOPED_ENTITIES)
            if track_reference(row.entity, row.row_key, row.payload_json) == stable_id
        ]

    # ---- 游标（两张表，方向相反） ----
    def cursor(self, peer_id: str) -> int:
        """本端已消费的**对端** outbox 位置（拉取游标）。"""
        return db.sync_cursor_get(peer_id)

    def set_cursor(self, peer_id: str, last_outbox_id: int) -> None:
        """推进拉取游标（收到帧 9 并落库后调用：数据不丢才推进）。"""
        db.sync_cursor_set(peer_id, last_outbox_id)

    def push_cursor(self, peer_id: str) -> int:
        """本端**已推给该 peer** 的本端 outbox 位置（推送游标）。"""
        return db.sync_push_cursor_get(peer_id)

    def set_push_cursor(self, peer_id: str, last_outbox_id: int) -> None:
        """推进推送游标（**全部批次发送成功**后才调用）。"""
        db.sync_push_cursor_set(peer_id, last_outbox_id)

    # ---- 本地缺歌挂起 ----
    def suspend(self, rows: Sequence[Mapping[str, Any]]) -> int:
        """挂起远端行（键 `(entity, content_hash, remote_row_key)`）。"""
        return db.sync_pending_add(list(rows))

    def pending(self) -> list[dict[str, Any]]:
        """全部挂起行（id 升序）。"""
        return db.sync_pending_load()

    def drop_pending(self, ids: Sequence[int]) -> int:
        """删除已重放 / 已作废的挂起行。"""
        return db.sync_pending_delete(list(ids))


# ============ content_hash 双向映射（§14.8） ============
def content_hash_for_stable_id(stable_id: str, *, root: Any = None) -> str | None:
    """本端身份 → 歌曲 `content_hash`（指纹缺失时现算并落库，与 manifest 同口径）。

    取不到（路径非法 / 文件不在曲库内 / 读失败）→ None = 该行不带跨端身份键
    （§14.8 降级：接收端按原样透传，老 peer 互通）。
    """
    if not stable_id:
        return None
    return ensure_content_hash(stable_id, root=root)


def stable_id_for_content_hash(content_hash: str) -> str | None:
    """`content_hash` → 本端身份（同 hash 多行取**最早入库**，两端确定性）。"""
    if not content_hash:
        return None
    row = db.track_fingerprint_by_hash(content_hash)
    if not row:
        return None
    return _optional_str(row.get("relative_path"))


@dataclass(frozen=True, slots=True)
class Localization:
    """接收侧一条线上 entry 的本地化结果（与 Swift `SyncEntryLocalization` 同构）。"""

    kind: str  #: "mapped" / "passthrough" / "suspended"
    row: ChangeLogRow
    content_hash: str | None = None


def localize_entry(entry: Mapping[str, Any]) -> Localization:
    """线上 entry → 本地化结果（row_key 与载荷歌曲引用改写为本端身份）。"""
    return localize_row(ChangeLogRow.from_wire_entry(entry))


def localize_row(row: ChangeLogRow) -> Localization:
    """远端行 → 本地化结果（`row_key` 与载荷歌曲引用改写为本端身份）。

    - 不引用歌曲（歌单）/ 无 `contentHash`（老 peer、指纹缺失）→ **透传**；
    - 映射不到本端歌曲 → **挂起**（歌到位后重放，数据不丢）；
    - 命中 → mapped（改写后进 LWW 对账）。
    """
    content_hash = row.content_hash
    if row.entity not in V1_SYNCED_ENTITIES or row.entity == ENTITY_PLAYLIST:
        return Localization(kind="passthrough", row=row, content_hash=content_hash)
    if not content_hash:
        return Localization(kind="passthrough", row=row, content_hash=None)
    local_id = stable_id_for_content_hash(content_hash)
    if not local_id:
        return Localization(kind="suspended", row=row, content_hash=content_hash)
    return Localization(kind="mapped", row=rewrite_row(row, local_id), content_hash=content_hash)


def rewrite_row(row: ChangeLogRow, local_id: str) -> ChangeLogRow:
    """把远端行的歌曲引用改写成本端身份（`playlist` 无歌曲键，不改）。

    复合行键的构造段（`playedAt` / 歌单标识）优先取 row_key，取不到回落读快照；
    两者都取不到则保持原样（应用层会因解析不出本端键而幂等跳过，不猜）。
    """
    payload = decode_payload(row.payload_json)
    if row.entity == ENTITY_FAVORITE:
        return _with_row(
            row,
            row_key=local_id,
            payload_json=_rewrite_snapshot(payload, {TRACK_ID_FIELD: local_id}, row.payload_json),
        )
    if row.entity == ENTITY_PLAY_HISTORY:
        parsed = parse_composite_row_key(row.row_key)
        played_at = parsed[1] if parsed else _int_or((payload or {}).get("played_at"), None)
        if played_at is None:
            return row
        return _with_row(
            row,
            row_key=play_history_row_key(local_id, played_at),
            payload_json=_rewrite_snapshot(payload, {TRACK_ID_FIELD: local_id}, row.payload_json),
        )
    if row.entity == ENTITY_PLAYLIST_ITEM:
        split = split_row_key(row.row_key)
        playlist_id = split[0] if split else _optional_str((payload or {}).get("playlist_slug"))
        if not playlist_id:
            return row
        return _with_row(
            row,
            row_key=playlist_item_row_key(playlist_id, local_id),
            payload_json=_rewrite_snapshot(payload, {TRACK_ID_FIELD: local_id}, row.payload_json),
        )
    return row


def _with_row(row: ChangeLogRow, *, row_key: str, payload_json: str | None) -> ChangeLogRow:
    """替换行键 / 载荷，其余字段原样（远端 id 与身份键必须保留）。"""
    return ChangeLogRow(
        entity=row.entity,
        row_key=row_key,
        op=row.op,
        updated_at_ms=row.updated_at_ms,
        payload_json=payload_json,
        id=row.id,
        content_hash=row.content_hash,
    )


def _rewrite_snapshot(
    snapshot: Mapping[str, Any] | None, updates: Mapping[str, Any], original: str | None
) -> str | None:
    """快照里替换歌曲引用后重编码；快照缺失 / 非法 → 原值返回（不吞掉语义）。"""
    if snapshot is None:
        return original
    merged = dict(snapshot)
    merged.update(updates)
    return encode_payload(merged)


def _int_or(raw: Any, default: int | None) -> int | None:
    """宽容取整（bool / 非数字 / None → default）。"""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return default
    return int(raw)


# ============ 应用（远端胜出行 → 本端业务表；绝不删本地行） ============
def apply_row(row: ChangeLogRow, *, root: Any = None) -> bool:
    """把一条远端胜出行落到本端业务表；返回是否成功应用。

    - `delete` 行**一律丢弃**（§14.9 拦截的兜底，绝不删本地业务行）；
    - 未知实体 / 路径解析不出（不在曲库根内）→ False（幂等跳过，不算失败）；
    - `playlist_item` 依赖 `playlist` 先落库：本端没有该歌单则跳过（结构收敛由
      playlist upsert 先行保证，同 Swift `applyPlaylistItem`）。
    """
    if row.is_delete:
        return False
    root_path = library_root(root)
    if row.entity == ENTITY_FAVORITE:
        path = _absolute_path(row.row_key, root_path)
        if path is None:
            return False
        db.sync_apply_favorite(str(path))
        return True
    if row.entity == ENTITY_PLAY_HISTORY:
        parsed = parse_composite_row_key(row.row_key)
        snapshot = decode_payload(row.payload_json) or {}
        played_at = parsed[1] if parsed else _int_or(snapshot.get("played_at"), 0)
        try:
            path = _absolute_path(parsed[0], root_path) if parsed else None
        except (TypeError, ValueError):
            path = None
        if path is None or not played_at:
            return False
        db.sync_apply_play_history(
            str(path), int(played_at), int(_int_or(snapshot.get("play_duration_ms"), 0) or 0)
        )
        return True
    if row.entity == ENTITY_PLAYLIST:
        snapshot = decode_payload(row.payload_json) or {}
        playlist_id = _optional_str(snapshot.get("slug")) or _optional_str(row.row_key)
        if not playlist_id:
            return False
        db.sync_apply_playlist(
            playlist_id,
            str(snapshot.get("title") or ""),
            _iso_from_ms(_int_or(snapshot.get("created_at"), 0) or 0),
            _iso_from_ms(_int_or(snapshot.get("updated_at"), 0) or 0),
        )
        return True
    if row.entity == ENTITY_PLAYLIST_ITEM:
        split = split_row_key(row.row_key)
        snapshot = decode_payload(row.payload_json) or {}
        playlist_id = split[0] if split else _optional_str(snapshot.get("playlist_slug"))
        track_id = split[1] if split else _optional_str(snapshot.get(TRACK_ID_FIELD))
        if not playlist_id or not track_id:
            return False
        path = _absolute_path(track_id, root_path)
        if path is None:
            return False
        db.sync_apply_playlist_item(
            playlist_id, str(path), int(_int_or(snapshot.get("position"), 0) or 0)
        )
        return True
    return False


def _absolute_path(relative_path: Any, root: Path) -> Path | None:
    """相对路径 → 曲库内绝对路径（**必须拦住越界**，§11.5 同一套闸）。

    与取文件/推送不同：应用播放数据要求文件**真实存在**（不然收藏/歌单项指向幽灵路径）。
    """
    resolution = resolve_library_file(relative_path, root=root)
    return resolution.path if resolution.ok else None


def _iso_from_ms(value: int) -> str:
    """毫秒 → ISO 文本（web 歌单列存 ISO 文本；与 web 侧写入口径一致）。"""
    if not value:
        return ""
    from datetime import datetime, timezone

    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat(timespec="seconds")


# ============ 跟歌走计划器（§14.9 决策 8，纯逻辑） ============
#: 携带方向（推送：本端这批歌的播放数据带给对端；拉取：请求对端把这批歌的数据带回来）
DIRECTION_PUSH = "push"
DIRECTION_PULL = "pull"


@dataclass(frozen=True, slots=True)
class TrackFact:
    """本端曲目事实（跨端配对用的最小视图）。"""

    relative_path: str
    content_hash: str | None


class LibraryFacts(Protocol):
    """携带所需的**本端曲库事实**（注入；与 Swift `SyncPlaybackCarryFactsProviding` 对位）。

    实现方必须**不抛**：查询失败按「查不到」返回，单条跳过而不是炸整车。
    """

    def track_fact(self, relative_path: str) -> TrackFact | None:
        """相对路径 → 曲目事实（不在本端曲库 → None）。"""

    def playback_rows(self, stable_id: str) -> list[ChangeLogRow]:
        """某首歌的全部播放数据变更行（**未过滤 delete**；计划器自己按 §14.9 过滤）。"""


class DatabaseFacts:
    """生产实现：曲库存在性 + 惰性指纹（`locallib`）+ outbox 行（`ChangeLogStore`）。"""

    def __init__(self, store: ChangeLogStore, *, root: Any = None) -> None:
        self._store = store
        self._root = root

    def track_fact(self, relative_path: str) -> TrackFact | None:
        """相对路径 → `(路径, 指纹)`；不在曲库根内 / 不存在 → None。"""
        resolution = resolve_library_file(relative_path, root=self._store.root)
        if not resolution.ok:
            return None
        try:
            content_hash = content_hash_for_stable_id(relative_path, root=self._store.root)
        except Exception:  # noqa: BLE001 - 取数失败按「查不到」（协议约定不抛）
            logger.debug("lansync 取指纹失败：%s", relative_path, exc_info=True)
            return None
        return TrackFact(relative_path=relative_path, content_hash=content_hash)

    def playback_rows(self, stable_id: str) -> list[ChangeLogRow]:
        """该歌的全部播放数据变更行（outbox id 升序）。"""
        return self._store.track_rows(stable_id)


@dataclass(frozen=True, slots=True)
class CarryEntry:
    """一条待携带的播放数据（对账键 + 跨端身份键齐备；发送侧直接映射成 wire entry）。"""

    outbox_id: int
    entity: str
    row_key: str
    op: str
    updated_at_ms: int
    content_hash: str
    payload_json: str | None = None

    def to_wire_entry(self) -> dict[str, Any]:
        """→ 帧 9 的 entry（`contentHash` 恒非空：这是它的配对身份键）。"""
        entry: dict[str, Any] = {
            "id": int(self.outbox_id),
            "entity": self.entity,
            "rowKey": self.row_key,
            "op": self.op,
            "updatedAtMs": int(self.updated_at_ms),
            "contentHash": self.content_hash,
        }
        if self.payload_json is not None:
            entry["payloadJSON"] = self.payload_json
        return entry


@dataclass(frozen=True, slots=True)
class CarrySong:
    """一首被携带的歌（判定依据；诊断 / 账目 / 测试用）。"""

    relative_path: str
    stable_id: str
    content_hash: str
    entry_count: int = 0


@dataclass
class CarryPlan:
    """一次携带的完整计划（空 `entries` = 本次无可携带数据）。"""

    direction: str
    scope_paths: list[str] = field(default_factory=list)
    entries: list[CarryEntry] = field(default_factory=list)
    songs: list[CarrySong] = field(default_factory=list)
    # ── 跳过明细（一律记账，不静默丢） ──
    lyrics_paths_ignored: list[str] = field(default_factory=list)
    skipped_unknown_path: list[str] = field(default_factory=list)
    skipped_unfingerprinted: list[str] = field(default_factory=list)
    skipped_not_paired: list[str] = field(default_factory=list)
    skipped_no_playback_data: list[str] = field(default_factory=list)

    @property
    def is_empty(self) -> bool:
        """是否无可携带内容。"""
        return not self.entries

    @property
    def entry_count(self) -> int:
        """携带条目数。"""
        return len(self.entries)

    @property
    def song_count(self) -> int:
        """携带歌曲数。"""
        return len(self.songs)

    def to_dict(self) -> dict[str, Any]:
        """账目字典（事件载荷 / `data_sync_status` 用）。"""
        return {
            "direction": self.direction,
            "scopePaths": list(self.scope_paths),
            "songs": [song.relative_path for song in self.songs],
            "entries": self.entry_count,
            "lyricsPathsIgnored": list(self.lyrics_paths_ignored),
            "skippedUnknownPath": list(self.skipped_unknown_path),
            "skippedUnfingerprinted": list(self.skipped_unfingerprinted),
            "skippedNotPaired": list(self.skipped_not_paired),
            "skippedNoPlaybackData": list(self.skipped_no_playback_data),
        }


def normalize_scope_paths(paths: Iterable[Any]) -> list[str]:
    """本轮传输路径规范化（升序去重；非法路径丢弃）——确定性输出的前提。"""
    seen: set[str] = set()
    out: list[str] = []
    for raw in paths or ():
        normalized = normalize_relative_path(raw)
        if normalized is None or normalized in seen:
            continue
        seen.add(normalized)
        out.append(normalized)
    return sorted(out)


def after_transfer_hashes(
    transferred_paths: Sequence[str],
    peer_hashes: Iterable[str],
    facts: LibraryFacts,
) -> set[str]:
    """传输完成后对端持有的身份集合 = 对端清单的 `content_hash` ∪ 本轮成功传输歌曲的指纹。

    只看对端清单会把「刚同步过去的歌」误判成未配对（清单是传输**前**的快照），
    故必须并上本轮传输歌曲的本地指纹（与 Swift `SyncPlaybackCarryScope.afterTransfer` 同口径）。
    """
    hashes = {h for h in (peer_hashes or ()) if h}
    for path in normalize_scope_paths(transferred_paths):
        fact = facts.track_fact(path)
        if fact is not None and fact.content_hash:
            hashes.add(fact.content_hash)
    return hashes


def pairing_plan(
    *,
    direction: str,
    transferred_paths: Sequence[Any],
    peer_hashes: Iterable[str],
    facts: LibraryFacts,
) -> CarryPlan:
    """只做**配对范围**（不取本端播放数据）：拉取方向用它确定「哪几首歌值得让对端带数据」。

    判定顺序（每条跳过都记账）：
    ① 路径规范化；② 歌词 wire 路径不承载播放数据（播放数据以歌为单位）；
    ③ 本端曲目事实（查不到 / 无指纹）；④ 两端共有（§14.9 决策 8）；
    ⑤ 同 `content_hash` 去重（一首歌多个路径只算一次）。
    """
    plan = CarryPlan(direction=direction)
    plan.scope_paths = normalize_scope_paths(transferred_paths)
    available = {h for h in (peer_hashes or ()) if h}
    seen_hashes: set[str] = set()
    for path in plan.scope_paths:
        if is_lyrics_path(path):
            plan.lyrics_paths_ignored.append(path)
            continue
        fact = facts.track_fact(path)
        if fact is None:
            plan.skipped_unknown_path.append(path)
            continue
        if not fact.content_hash:
            plan.skipped_unfingerprinted.append(path)
            continue
        seen_hashes.add(fact.content_hash)
    paired = seen_hashes & available
    for path in plan.scope_paths:
        if is_lyrics_path(path):
            continue
        fact = facts.track_fact(path)
        if fact is None or not fact.content_hash:
            continue
        if fact.content_hash not in paired:
            plan.skipped_not_paired.append(path)
            continue
        plan.songs.append(
            CarrySong(relative_path=path, stable_id=path, content_hash=fact.content_hash)
        )
    plan.songs.sort(key=lambda song: song.relative_path)
    return plan


def carry_plan(
    *,
    direction: str,
    transferred_paths: Sequence[Any],
    peer_hashes: Iterable[str],
    facts: LibraryFacts,
) -> CarryPlan:
    """制定一次**推送方向**的携带计划（§14.9 三条硬规则；纯函数，可单测）。

    规则：只覆盖这次传输的歌（不传的路径一律不带，不做全库对账）；只带两端共有的歌；
    delete 不上线（含批次抑制，复用 `transmittable_indexes` 单一事实源）。
    """
    plan = pairing_plan(
        direction=direction,
        transferred_paths=transferred_paths,
        peer_hashes=peer_hashes,
        facts=facts,
    )
    if not plan.songs:
        return plan
    carried_songs: list[CarrySong] = []
    entries: list[CarryEntry] = []
    for song in plan.songs:
        carried = _carry_entries(facts.playback_rows(song.stable_id), song.content_hash)
        if not carried:
            plan.skipped_no_playback_data.append(song.relative_path)
            continue
        carried_songs.append(
            CarrySong(
                relative_path=song.relative_path,
                stable_id=song.stable_id,
                content_hash=song.content_hash,
                entry_count=len(carried),
            )
        )
        entries.extend(carried)
    plan.songs = sorted(carried_songs, key=lambda song: song.relative_path)
    plan.skipped_no_playback_data.sort()
    plan.entries = sorted(entries, key=lambda entry: entry.outbox_id)
    return plan


def _carry_entries(rows: Sequence[ChangeLogRow], content_hash: str) -> list[CarryEntry]:
    """一批本端行 → 可携带条目（delete 不上线；身份键统一为歌曲 `content_hash`）。"""
    ordered = sorted(rows, key=lambda row: row.id)
    policy_rows = [{"entity": row.entity, "row_key": row.row_key, "op": row.op} for row in ordered]
    transmittable = [ordered[index] for index in transmittable_indexes(policy_rows)]
    return [
        CarryEntry(
            outbox_id=row.id,
            entity=row.entity,
            row_key=row.row_key,
            op=row.op,
            updated_at_ms=row.updated_at_ms,
            content_hash=content_hash,
            payload_json=row.payload_json,
        )
        for row in transmittable
    ]


# ============ 会话级处理器（帧 8/9） ============
class ApplicationSender(Protocol):
    """会话最小视图（生产 = `session.HostSession`；测试可注入替身）。"""

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        """发加密业务帧。"""

    @property
    def is_ready(self) -> bool:
        """会话是否已就绪。"""


class ChangeLogPeer:
    """帧 8/9 的会话级处理器（对位 Swift `SyncChangeLogPeer`）。

    - 收帧 8 → 取本端增量（**本批末行 id** 口径）→ 过滤 delete → 填 `contentHash` → 回帧 9；
    - 收帧 9 → 拦截 delete → 按 `content_hash` 本地化（缺歌挂起）→ LWW → 落库 → 推进拉取游标；
    - 主动推增量（帧 9 批）供 `data_sync_push` 与「跟歌走」共用，**不另立第二套**。
    """

    def __init__(
        self,
        session: ApplicationSender,
        *,
        peer_id: str,
        store: ChangeLogStore | None = None,
        root: Any = None,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._session = session
        self._peer_id = str(peer_id)
        self._store = store if store is not None else ChangeLogStore(root=root)
        self._root = root
        self._on_event = on_event
        self._run: Any = None  # 当前活动的 DataSyncRun（帧 9 是它的应答时）

    @property
    def peer_id(self) -> str:
        """本端视角的对端 Device ID（游标键）。"""
        return self._peer_id

    @property
    def store(self) -> ChangeLogStore:
        """outbox / 游标门面（「跟歌走」与状态查询共用）。"""
        return self._store

    # ---- 帧入口 ----
    def handle_application_frame(self, frame_type: int, payload: bytes) -> bool:
        """帧 8/9 → 处理；其它帧返回 False（交回上层分发链）。"""
        if frame_type == FrameType.CHANGE_LOG_PULL:
            self._handle_pull(payload)
            return True
        if frame_type == FrameType.CHANGE_LOG_PUSH:
            self._handle_push(payload)
            return True
        return False

    # ---- 发送 ----
    def send_pull(self) -> int:
        """发帧 8（带本端已消费的对端游标），返回该游标。"""
        cursor = self._store.cursor(self._peer_id)
        self._session.send_application_frame(FrameType.CHANGE_LOG_PULL, encode_pull_request(cursor))
        return cursor

    def send_increment(
        self,
        max_per_batch: int = DEFAULT_BATCH_SIZE,
        *,
        on_batch: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        """把「id > 本端已推给该 peer」的本端增量分批推给对端（帧 9）。

        口径与帧 8 应答**逐字相同**（同一 `page` + 同一 `transmittable_indexes` + 同一
        `contentHash` 填充）；**空增量不发帧、不动游标**；批内有行但全被过滤（整批 delete）
        照发该批（否则推送游标永远推不动，每轮重读同一批）；**全部批次成功才推进游标**。
        """
        batch_size = max(1, int(max_per_batch or 1))
        cursor = self._store.push_cursor(self._peer_id)
        consumed = 0
        entries_sent = 0
        batches = 0
        last_cursor: int | None = None
        while True:
            page = self._store.page(cursor, batch_size)
            if not page.rows:
                break
            transmittable = self._transmittable(page.rows)
            entries = self._wire_entries(transmittable)
            self._session.send_application_frame(
                FrameType.CHANGE_LOG_PUSH, encode_push_payload(entries, page.last_outbox_id)
            )
            consumed += len(page.rows)
            entries_sent += len(entries)
            batches += 1
            cursor = page.last_outbox_id
            last_cursor = cursor
            if on_batch is not None:
                on_batch(
                    {
                        "batches": batches,
                        "rows": consumed,
                        "entries": entries_sent,
                        "deletesFiltered": consumed - entries_sent,
                        "lastOutboxID": int(cursor),
                    }
                )
            if len(page.rows) < batch_size:
                break
        if last_cursor is None:
            return {
                "batches": 0,
                "rows": 0,
                "entries": 0,
                "deletesFiltered": 0,
                "cursor": cursor,
                "sent": False,
            }
        self._store.set_push_cursor(self._peer_id, last_cursor)
        return {
            "batches": batches,
            "rows": consumed,
            "entries": entries_sent,
            "deletesFiltered": consumed - entries_sent,
            "cursor": last_cursor,
            "sent": True,
        }

    def send_carry_entries(self, entries: Sequence[CarryEntry]) -> int:
        """「跟歌走」推送：把携带条目发成一帧 9（批内末行 id = 本批实际末行），返回条目数。

        空批**不发帧**（不产生空批次噪音）。⚠️ 已知边界（§14.9）：批内末行可能小于
        对端已记下的位置 → 对端游标可能回退；v1 该游标在被推方是惰性的（被动端不主动
        pull），与 Swift `SyncPlaybackCarryPeer` 记录的行为一致。
        """
        if not entries:
            return 0
        last_id = max(int(entry.outbox_id) for entry in entries)
        self._session.send_application_frame(
            FrameType.CHANGE_LOG_PUSH,
            encode_push_payload([entry.to_wire_entry() for entry in entries], last_id),
        )
        return len(entries)

    # ---- 收帧：帧 8（对端要增量） ----
    def _handle_pull(self, payload: bytes) -> None:
        cursor = decode_pull_request(payload)
        page = self._store.page(cursor)
        transmittable = self._transmittable(page.rows)
        entries = self._wire_entries(transmittable)
        try:
            self._session.send_application_frame(
                FrameType.CHANGE_LOG_PUSH, encode_push_payload(entries, page.last_outbox_id)
            )
        except Exception as error:  # noqa: BLE001 - 发送失败只记账（会话层自行断连）
            self._notify({"kind": "decode_failure", "detail": f"change_log_pull 应答失败：{error}"})
            return
        self._notify(
            {
                "kind": "pull_answered",
                "rows": len(page.rows),
                "entries": len(entries),
                "deletesFiltered": len(page.rows) - len(entries),
                "lastOutboxID": int(page.last_outbox_id),
            }
        )

    # ---- 收帧：帧 9（对端推来一批） ----
    def _handle_push(self, payload: bytes) -> None:
        try:
            rows, last_outbox_id = decode_push_payload(payload)
        except ValueError as error:
            self._notify({"kind": "decode_failure", "detail": f"change_log_push 解码失败：{error}"})
            return
        # 歌到位后先重放挂起行（本地缺歌挂起 → 数据不丢，§14.8）。
        self.replay_pending()
        remote_rows: list[ChangeLogRow] = []
        suspended = 0
        ignored_deletes = 0
        for entry_row in rows:
            # §14.9：收到 delete **一律忽略**，且必须在本地化**之前**拦截
            # （delete 行没有歌曲载荷，先进本地化会被误判成「本地缺歌」永久挂起）。
            if entry_row.is_delete:
                ignored_deletes += 1
                continue
            outcome = localize_row(entry_row)
            if outcome.kind == "suspended":
                try:
                    self._store.suspend(
                        [
                            {
                                "entity": outcome.row.entity,
                                "content_hash": outcome.content_hash,
                                "remote_row_key": outcome.row.row_key,
                                "op": outcome.row.op,
                                "updated_at": outcome.row.updated_at_ms,
                                "payload_json": outcome.row.payload_json,
                            }
                        ]
                    )
                except Exception:  # noqa: BLE001 - 挂起失败不炸整车（该行丢弃但记账）
                    logger.warning("lansync 挂起远端变更失败", exc_info=True)
                suspended += 1
                continue
            remote_rows.append(outcome.row)

        refs = [
            (row.entity, row.row_key) for row in remote_rows if row.entity in V1_SYNCED_ENTITIES
        ]
        local_latest = self._store.latest(refs)
        local_rows = [
            local_latest[(row.entity, row.row_key)]
            for row in remote_rows
            if (row.entity, row.row_key) in local_latest
        ]
        outcome = reconcile(local_rows, remote_rows)
        applied = 0
        for row in outcome.apply_remote:
            try:
                if apply_row(row, root=self._root):
                    applied += 1
            except Exception:  # noqa: BLE001 - 单行失败不影响其余行（与 Swift 每行独立事务同口径）
                logger.warning(
                    "lansync 应用远端变更失败：%s %s", row.entity, row.row_key, exc_info=True
                )
        self._store.set_cursor(self._peer_id, last_outbox_id)
        stats = {
            "entries": len(rows),
            "applied": applied,
            "suspended": suspended,
            "ignoredDeletes": ignored_deletes,
            "localWins": len(outcome.local_wins),
            "lastOutboxID": int(last_outbox_id),
            "cursor": self._store.cursor(self._peer_id),
        }
        run = self._run
        if run is not None:
            run.on_remote_batch(stats)
        else:
            self._notify({"kind": "push_applied", **stats})

    # ---- 挂起重放 ----
    def replay_pending(self) -> dict[str, int]:
        """重放挂起行（本端歌曲已到位）：逐条重新本地化 → LWW → 应用 → 出队。

        仍映射不到本端曲目的行**保留**（下次再试）；delete 行直接丢弃（§14.9）。
        """
        replayed = 0
        applied = 0
        dropped: list[int] = []
        for item in self._store.pending():
            entry = {
                "entity": item["entity"],
                "rowKey": item["remote_row_key"],
                "op": item["op"],
                "updatedAtMs": item["updated_at"],
                "contentHash": item["content_hash"],
                "payloadJSON": item["payload_json"],
            }
            if is_delete(item.get("op")):
                dropped.append(int(item["id"]))
                continue
            outcome = localize_entry(entry)
            if outcome.kind == "suspended":
                continue
            local = self._store.latest([(outcome.row.entity, outcome.row.row_key)])
            local_row = local.get((outcome.row.entity, outcome.row.row_key))
            result = reconcile([local_row] if local_row else [], [outcome.row])
            for row in result.apply_remote:
                if apply_row(row, root=self._root):
                    applied += 1
            dropped.append(int(item["id"]))
            replayed += 1
        if dropped:
            self._store.drop_pending(dropped)
        return {"replayed": replayed, "applied": applied, "kept": len(self._store.pending())}

    # ---- 内部 ----
    def _transmittable(self, rows: Sequence[ChangeLogRow]) -> list[ChangeLogRow]:
        """发送侧过滤（delete 不上线 + 批次抑制；复用单一事实源）。"""
        policy_rows = [{"entity": row.entity, "row_key": row.row_key, "op": row.op} for row in rows]
        return [rows[index] for index in transmittable_indexes(policy_rows)]

    def _wire_entries(self, rows: Sequence[ChangeLogRow]) -> list[dict[str, Any]]:
        """outbox 行 → 线上 entry（按行内歌曲引用查指纹填 `contentHash`，查不到 = 省略）。"""
        entries: list[dict[str, Any]] = []
        for row in rows:
            reference = track_reference(row.entity, row.row_key, row.payload_json)
            content_hash = (
                content_hash_for_stable_id(reference, root=self._root) if reference else None
            )
            entries.append(row.to_wire_entry(content_hash))
        return entries

    @staticmethod
    def _entry_of(row: ChangeLogRow) -> dict[str, Any]:
        """行模型 → 线上 entry 形态（重放路径构造 entry 用；`contentHash` 由调用方补）。"""
        entry: dict[str, Any] = {
            "entity": row.entity,
            "rowKey": row.row_key,
            "op": row.op,
            "updatedAtMs": row.updated_at_ms,
        }
        if row.payload_json is not None:
            entry["payloadJSON"] = row.payload_json
        return entry

    def bind_run(self, run: Any) -> None:
        """绑定当前活动运行（帧 9 作为它的应答时把统计交给它）。"""
        self._run = run

    def unbind_run(self, run: Any) -> None:
        """解绑（仅当仍是本运行时）。"""
        if self._run is run:
            self._run = None

    def _notify(self, event: dict[str, Any]) -> None:
        """事件回调（异常不得中断会话处理）。"""
        if self._on_event is None:
            return
        try:
            self._on_event(dict(event))
        except Exception:  # noqa: BLE001
            logger.exception("lansync change log 事件回调失败")


# ============ 一次「同步播放数据」运行（推 / 拉半边：状态机 + 账目 + 事件） ============
class DataSyncError(Exception):
    """播放数据同步编排错误（会话未就绪 / 未知运行）。"""


class DataSyncState(str, Enum):
    """运行状态（`data_sync_status` 的 `state` 取值）。"""

    IDLE = "idle"
    SENDING = "sending"
    AWAITING = "awaiting"
    DONE = "done"
    FAILED = "failed"


class DataSyncRun:
    """一次播放数据同步运行（`direction` = push / pull）。

    - push：把本端 outbox 增量（含 delete 过滤 + `contentHash` 填充）分批推给对端（帧 9），
      全部批次成功才推进推送游标；对端无应答（与 Swift `sendIncrement` 同语义）；
    - pull：发帧 8 带本端拉取游标，等对端帧 9 → 本地化 / LWW / 落库 → 推进拉取游标。
    """

    def __init__(
        self,
        peer: ChangeLogPeer,
        direction: str,
        *,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._peer = peer
        self._direction = direction
        self._on_event = on_event
        self.run_id = uuid.uuid4().hex
        self._state = DataSyncState.IDLE
        self._error: str | None = None
        self._sent: dict[str, Any] = {}
        self._received: dict[str, Any] = {}
        self._carry: CarryPlan | None = None

    # ---- 只读视图 ----
    @property
    def state(self) -> DataSyncState:
        """当前状态。"""
        return self._state

    @property
    def direction(self) -> str:
        """方向（push / pull）。"""
        return self._direction

    @property
    def peer_id(self) -> str:
        """对端 Device ID。"""
        return self._peer.peer_id

    @property
    def is_terminal(self) -> bool:
        """是否终态。"""
        return self._state in (DataSyncState.DONE, DataSyncState.FAILED)

    @property
    def is_awaiting_response(self) -> bool:
        """是否在等对端应答（帧 8 → 帧 9）。"""
        return self._state is DataSyncState.AWAITING

    def status(self) -> dict[str, Any]:
        """状态 / 账目字典（事件与 `data_sync_status` 共用）。"""
        payload: dict[str, Any] = {
            "run_id": self.run_id,
            "peer_id": self.peer_id,
            "direction": self._direction,
            "state": self._state.value,
            "sent": dict(self._sent),
            "received": dict(self._received),
        }
        if self._carry is not None:
            payload["carry"] = self._carry.to_dict()
        if self._error:
            payload["error"] = self._error
        return payload

    # ---- 推送 ----
    def start_push(self, max_per_batch: int = DEFAULT_BATCH_SIZE) -> None:
        """推本端增量（帧 9 批）；空增量 = 不动游标、不进终态（`idle` 保持）。"""
        if self._state is not DataSyncState.IDLE:
            return
        self._state = DataSyncState.SENDING
        self._emit()
        try:
            result = self._peer.send_increment(max_per_batch, on_batch=lambda _info: self._emit())
        except Exception as error:  # noqa: BLE001 - 发送失败 = 本次运行失败（游标不动）
            self._fail(f"推送本端增量失败：{error}")
            return
        self._sent = dict(result)
        if not result.get("sent"):
            self._state = DataSyncState.IDLE  # 空增量：不发帧、不动游标（§14.6）
            self._emit()
            return
        self._state = DataSyncState.DONE
        self._emit()

    # ---- 拉取 ----
    def start_pull(self) -> None:
        """发帧 8（带本端拉取游标），进入 `awaiting` 等对端帧 9。"""
        if self._state is not DataSyncState.IDLE:
            return
        try:
            cursor = self._peer.send_pull()
        except Exception as error:  # noqa: BLE001
            self._fail(f"发送 change_log_pull 失败：{error}")
            return
        self._receive_started = True
        self._sent = {"cursor": int(cursor)}
        self._state = DataSyncState.AWAITING
        self._emit()

    # ---- 对端应答 / 事件 ----
    def on_remote_batch(self, stats: Mapping[str, Any]) -> None:
        """收到对端帧 9（本地化 / LWW / 落库已完成）。"""
        self._received = dict(stats)
        if self._state is DataSyncState.AWAITING:
            self._state = DataSyncState.DONE
        self._emit()

    def handle_session_closed(self) -> None:
        """会话关闭：未完成的运行落失败（账目保留）。"""
        if self.is_terminal:
            return
        self._fail("会话已关闭")

    def cancel(self) -> bool:
        """取消运行（已终态 → False）。"""
        if self.is_terminal:
            return False
        self._fail("已取消")
        return True

    def set_carry(self, plan: CarryPlan) -> None:
        """记录本次跟歌走的计划（账目 / 诊断用）。"""
        self._carry = plan
        self._emit()

    # ---- 内部 ----
    def _fail(self, error: str) -> None:
        """落失败态并广播（终态后调用 = 无操作）。"""
        if self.is_terminal:
            return
        self._error = error
        self._state = DataSyncState.FAILED
        self._emit()

    def _emit(self) -> None:
        """广播一条事件（回调异常不影响状态机）；进终态时与帧处理器解绑。"""
        if self.is_terminal:
            self._peer.unbind_run(self)
        if self._on_event is None:
            return
        try:
            self._on_event(self.status())
        except Exception:  # noqa: BLE001
            logger.exception("lansync 数据同步事件回调失败（run=%s）", self.run_id)


# ============ 跟歌走驱动（会话级；对位 Swift `SyncPlaybackCarryPeer`） ============
class CarryDriver:
    """把「跟歌走」接进推送 / 拉取链路：帧 9 推携带批 / 帧 8 请求对端携带。

    - 计划 = :func:`carry_plan` / :func:`pairing_plan`（纯逻辑，唯一实现点）；
    - 收发复用 :class:`ChangeLogPeer`（不新造落库路径）；
    - 空批**不发帧**（不产生空批次噪音）。
    """

    def __init__(
        self,
        peer: ChangeLogPeer,
        *,
        root: Any = None,
        facts: LibraryFacts | None = None,
    ) -> None:
        self._peer = peer
        self._facts = facts if facts is not None else DatabaseFacts(peer.store, root=root)

    @property
    def facts(self) -> LibraryFacts:
        """本端曲库事实（测试可注入替身）。"""
        return self._facts

    def carry_push(
        self, transferred_paths: Sequence[Any], peer_hashes: Iterable[str] = ()
    ) -> CarryPlan:
        """推送阶段结束：本端这批歌的播放数据带给对端（帧 9）。返回计划（记账。"""
        hashes = after_transfer_hashes(transferred_paths, peer_hashes, self._facts)
        plan = carry_plan(
            direction=DIRECTION_PUSH,
            transferred_paths=transferred_paths,
            peer_hashes=hashes,
            facts=self._facts,
        )
        if plan.entries:
            self._peer.send_carry_entries(plan.entries)
        return plan

    def carry_pull(
        self, transferred_paths: Sequence[Any], peer_hashes: Iterable[str] = ()
    ) -> CarryPlan:
        """拉取阶段结束：请求对端把这批歌的播放数据带过来（帧 8）。返回配对范围。"""
        hashes = after_transfer_hashes(transferred_paths, peer_hashes, self._facts)
        plan = pairing_plan(
            direction=DIRECTION_PULL,
            transferred_paths=transferred_paths,
            peer_hashes=hashes,
            facts=self._facts,
        )
        self._peer.send_pull()
        return plan


# ============ 供 db.py 业务写入点使用的纯构造函数 ============
# 业务写入点（favorites / playlists / playback_events）在**同一事务**内调用这些构造器，
# 把变更落进 outbox（真实来源 = db 层，构造 = 本层，判定 = 上面各节的单一事实源）。
# 约定：返回**列表**（空列表 = 该变更不可同步，例如曲目不在曲库根内），调用方直接展开。
def for_favorite(
    absolute_path: Any, op: Any, *, updated_at_ms: int | None = None, root: Any = None
) -> list[dict[str, Any]]:
    """收藏变更 → outbox 行（`row_key` = 曲库相对路径）。"""
    relative = _library_relative(absolute_path, root)
    if relative is None:
        return []
    payload = None if is_delete(op) else encode_payload(favorite_snapshot(relative))
    return [
        _outbox_row_dict(ENTITY_FAVORITE, favorite_row_key(relative), op, payload, updated_at_ms)
    ]


def for_play_history(
    record: Mapping[str, Any], *, updated_at_ms: int | None = None, root: Any = None
) -> list[dict[str, Any]]:
    """播放记录 → outbox 行（`played_at` 取记录 `ts` 的毫秒；解析不出则用当前时刻）。"""
    relative = _library_relative(record.get("path"), root)
    if relative is None:
        return []
    played_at = db.iso_to_ms(record.get("ts")) or now_ms()
    duration_ms = int(max(0.0, float(record.get("duration", 0) or 0)) * 1000)
    payload = encode_payload(play_history_snapshot(relative, played_at, duration_ms))
    return [
        _outbox_row_dict(
            ENTITY_PLAY_HISTORY,
            play_history_row_key(relative, played_at),
            OP_UPSERT,
            payload,
            updated_at_ms,
        )
    ]


def for_playlist_item(
    playlist_id: Any,
    absolute_path: Any,
    op: Any,
    position: int = 0,
    *,
    updated_at_ms: int | None = None,
    root: Any = None,
) -> list[dict[str, Any]]:
    """歌单项变更 → outbox 行（`row_key` = `"{歌单标识}|{曲目身份}"`）。"""
    identifier = _optional_str(playlist_id)
    relative = _library_relative(absolute_path, root)
    if identifier is None or relative is None:
        return []
    payload = (
        None
        if is_delete(op)
        else encode_payload(playlist_item_snapshot(identifier, position, relative))
    )
    return [
        _outbox_row_dict(
            ENTITY_PLAYLIST_ITEM,
            playlist_item_row_key(identifier, relative),
            op,
            payload,
            updated_at_ms,
        )
    ]


def for_playlists(
    before: Sequence[Mapping[str, Any]],
    after: Sequence[Mapping[str, Any]],
    *,
    updated_at_ms: int | None = None,
    root: Any = None,
) -> list[dict[str, Any]]:
    """歌单全量重写 → 差异 outbox 行（歌单结构 + 歌单项；无变化不产生行）。"""
    rows: list[dict[str, Any]] = []
    before_by_id = {str(item.get("id", "")): item for item in before or () if item.get("id")}
    after_by_id = {str(item.get("id", "")): item for item in after or () if item.get("id")}
    for identifier, playlist in after_by_id.items():
        old = before_by_id.get(identifier)
        if old is None or _playlist_signature(old) != _playlist_signature(playlist):
            payload = encode_payload(
                playlist_snapshot(
                    identifier,
                    str(playlist.get("name", "") or ""),
                    db.iso_to_ms(playlist.get("createdAt")) or now_ms(),
                    db.iso_to_ms(playlist.get("updatedAt")) or now_ms(),
                )
            )
            rows.append(
                _outbox_row_dict(
                    ENTITY_PLAYLIST, playlist_row_key(identifier), OP_UPSERT, payload, updated_at_ms
                )
            )
    for identifier in before_by_id:
        if identifier not in after_by_id:
            rows.append(
                _outbox_row_dict(
                    ENTITY_PLAYLIST, playlist_row_key(identifier), OP_DELETE, None, updated_at_ms
                )
            )
    before_items = {
        (identifier, str(path))
        for identifier, playlist in before_by_id.items()
        for path in (playlist.get("songPaths") or [])
    }
    after_items: dict[tuple[str, str], int] = {}
    for identifier, playlist in after_by_id.items():
        for position, path in enumerate(playlist.get("songPaths") or []):
            after_items[(identifier, str(path))] = position
    for (identifier, path), position in after_items.items():
        if (identifier, path) in before_items:
            continue
        rows.extend(
            for_playlist_item(
                identifier, path, OP_UPSERT, position, updated_at_ms=updated_at_ms, root=root
            )
        )
    for identifier, path in sorted(before_items - set(after_items)):
        rows.extend(
            for_playlist_item(
                identifier, path, OP_DELETE, 0, updated_at_ms=updated_at_ms, root=root
            )
        )
    return rows


def _outbox_row_dict(
    entity: str, row_key: str, op: Any, payload_json: str | None, updated_at_ms: int | None
) -> dict[str, Any]:
    """outbox 行字典（`updated_at` 缺省 = 当前毫秒 = v1 的 LWW 时钟，§14.7）。"""
    return {
        "entity": entity,
        "row_key": row_key,
        "op": str(op),
        "updated_at": int(updated_at_ms) if updated_at_ms else now_ms(),
        "payload_json": payload_json,
    }


def _library_relative(absolute_path: Any, root: Any) -> str | None:
    """绝对路径 → 曲库相对路径（不在曲库根内 → None = 该变更不同步）。

    web 的跨端身份是 `content_hash`，而指纹只对曲库内文件可算 —— 曲库外的收藏 /
    播放记录没有跨端身份，记 outbox 只会在对端造出无法映射的幽灵行，故**不记录**。
    """
    from .locallib import relative_path_of

    if not absolute_path:
        return None
    try:
        return relative_path_of(absolute_path, library_root(root))
    except (OSError, ValueError):
        return None


def _playlist_signature(playlist: Mapping[str, Any]) -> tuple[str, str]:
    """歌单结构签名（标题 + 更新时间）：两者都没变 = 无需产生 outbox 行。"""
    return (str(playlist.get("name", "") or ""), str(playlist.get("updatedAt", "") or ""))
