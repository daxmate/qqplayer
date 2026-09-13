"""局域网同步（S2）本端内容来源：收藏 / 真实歌单 / 自动歌单（`@smart:*`）。

对端清单（帧 15/16）与 manifest 歌单集合（帧 10 的 `collection.kind == "playlists"`）
都要「标识 → 有序成员」这份事实，所以**只有这里一处实现**（协议 §13.5/§13.6；
Swift 参考 `QQPlayer/Services/DatabaseSyncPeerLibraryFacts.swift` 的
`orderedMemberPaths` 与 `SyncBrowseSource.swift` 的标识命名空间）。

顺序口径（§13.6「来源内顺序 = 来源自身顺序」）：

| 来源 | 顺序 |
| --- | --- |
| 收藏 `@favorites` | 收藏表顺序（成员序） |
| 真实歌单 `<slug>` | 歌单成员序 |
| `@smart:recentAdded` | 文件 mtime 降序（最新在前） |
| `@smart:recentPlayed` | 最近播放时间降序（同曲只留最新一条） |
| `@smart:topPlayed` | 播放次数降序（并列按累计时长，再按最近播放 / 路径破平） |

自动歌单条数与播放列表页同一上限（:data:`~app.lansync.locallib.SMART_LIMIT` = 50）；
播放数据只读复用 `playback_events` 表，不改表结构。未知 / 非法标识天然收成空集
（查不到就是查不到），**绝不回落全库**。
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from app import db

from .locallib import (
    FAVORITES_ID,
    FAVORITES_NAME,
    SMART_KINDS,
    SMART_LIMIT,
    SMART_NAMES,
    SMART_PREFIX,
    LibraryFile,
    is_valid_playlist_id,
    library_root,
    ordered_unique,
    relative_path_of,
    scan_library_files,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class LocalSource:
    """一个内容来源：标识 + 显示名 + 有序成员相对路径（顺序 = 来源自身顺序）。"""

    id: str
    name: str
    members: tuple[str, ...]


def _ordered_unique(paths: Sequence[str]) -> list[str]:
    """:func:`~app.lansync.locallib.ordered_unique` 的本地别名（成员表口径统一）。"""
    return ordered_unique(list(paths))


def _parse_ts(raw: Any) -> float:
    """播放时间戳（ISO8601 字符串 / 数值）→ 可比较的秒数；无法解析 → 0。

    播放记录里的 `ts` 由前端 / 路由写入（ISO8601 UTC），字符串比较已可用；
    但为兼容历史数据（数值 / 缺时区）统一转数值比较，避免混用两种格式时排序错乱。
    """
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return float(raw)
    text = str(raw or "").strip()
    if not text:
        return 0.0
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _smart_members(
    kind: str, files: Sequence[LibraryFile], to_rel: Callable[[Any], str | None]
) -> list[str]:
    """自动歌单成员（有序，上限 :data:`SMART_LIMIT`）——口径与播放列表页同一数据层。"""
    known = {f.relative_path for f in files}
    if kind == "recentAdded":
        # 最近添加：按添加时间（扫描的 mtime 毫秒；新→旧），再按路径破平（确定性）
        ordered = sorted(files, key=lambda f: (-f.mtime_ms, f.relative_path))
        return [f.relative_path for f in ordered][:SMART_LIMIT]

    records = db.playback_all()
    stats: dict[str, dict[str, Any]] = {}
    for record in records:
        abs_path = str(record.get("path", "") or "")
        if not abs_path:
            continue
        entry = stats.setdefault(abs_path, {"plays": 0, "total_played": 0.0, "last": 0.0})
        entry["plays"] += 1
        entry["total_played"] += float(record.get("played", 0) or 0)
        entry["last"] = max(entry["last"], _parse_ts(record.get("ts")))

    if kind == "recentPlayed":
        # 最近播放：最近播放时间降序（同曲只留最新一条），映射不到曲库的（已删除 / 网络歌）跳过
        ordered = sorted(stats.items(), key=lambda kv: (-kv[1]["last"], kv[0]))
    else:
        # 常听排行：播放次数降序，并列按累计时长，再按最近播放、路径破平（确定性）
        ordered = sorted(
            stats.items(),
            key=lambda kv: (-kv[1]["plays"], -kv[1]["total_played"], -kv[1]["last"], kv[0]),
        )

    members: list[str] = []
    seen: set[str] = set()
    for abs_path, _ in ordered:
        rel = to_rel(abs_path)
        if not rel or rel not in known or rel in seen:
            continue
        seen.add(rel)
        members.append(rel)
        if len(members) >= SMART_LIMIT:
            break
    return members


def local_sources(
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
    files: Sequence[LibraryFile] | None = None,
) -> list[LocalSource]:
    """本端全部内容来源（收藏 → 真实歌单 → `@smart:*` 固定序）。

    - 成员顺序 = 来源自身顺序（收藏 / 歌单 = 成员序，自动歌单见 :func:`_smart_members`）；
    - 真实歌单标识形态非法 / 以 `@` 开头（保留命名空间）→ 跳过该歌单；
    - 同一 slug 撞名（历史数据）→ 追加未见过的成员（多算比漏算安全）。
    """
    root_path = library_root(root)
    items = list(files) if files is not None else scan_library_files(root=root_path, songs=songs)
    by_abs = {f.path: f.relative_path for f in items}

    def to_rel(raw: Any) -> str | None:
        key = str(raw or "")
        if not key:
            return None
        return by_abs.get(key) or relative_path_of(key, root_path)

    out: list[LocalSource] = []
    favorites = _ordered_unique([r for r in (to_rel(p) for p in db.favorites_load()) if r])
    out.append(LocalSource(id=FAVORITES_ID, name=FAVORITES_NAME, members=tuple(favorites)))
    merged: dict[str, list[str]] = {FAVORITES_ID: favorites}
    for playlist in db.playlists_load():
        pid = str(playlist.get("id", "") or "").strip()
        if not is_valid_playlist_id(pid) or pid.startswith("@"):
            continue
        members = [r for r in (to_rel(p) for p in (playlist.get("songPaths") or [])) if r]
        merged[pid] = _ordered_unique(list(merged.get(pid, [])) + members)
        out.append(
            LocalSource(
                id=pid,
                name=str(playlist.get("name", "") or "").strip() or pid,
                members=tuple(merged[pid]),
            )
        )
    for kind in SMART_KINDS:
        source_id = SMART_PREFIX + kind
        members = _smart_members(kind, items, to_rel)
        merged[source_id] = members
        out.append(
            LocalSource(id=source_id, name=SMART_NAMES.get(kind, source_id), members=tuple(members))
        )
    return out


def source_member_paths(
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
    files: Sequence[LibraryFile] | None = None,
) -> dict[str, list[str]]:
    """来源标识 → 有序成员相对路径（:func:`local_sources` 的字典视图）。"""
    return {
        source.id: list(source.members)
        for source in local_sources(root=root, songs=songs, files=files)
    }
