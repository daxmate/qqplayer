"""局域网同步（S2）对端内容清单（帧 15/16）：请求归一 + 分页 + 摘要。

协议 `docs/lan-sync-protocol.md` §13；Swift 参考 `QQPlayer/Sync/SyncPeerLibraryModels.swift`、
`SyncPeerLibraryCatalog.swift`，生产事实装配 `QQPlayer/Services/DatabaseSyncPeerLibraryFacts.swift`。

用途：manifest（帧 10/11）只有相对路径 + 大小 + 指纹，拿不到对端的**歌单结构与曲目
元数据**；本对帧补这个能力（UI「内容面板随同步方向切换数据源」靠它）。

安全口径（不可信输入只在应答侧收口，§13.4.2）：

- 非法 / 未知 `scope` → **空清单 + `total: 0`**，摘要照常返回（断会话代价远大于空页）；
- `offset` / `limit` 越界 → 应答侧钳制（`>= 0` / `1...500`）；
- `playlistID` 未知 / 形态非法 → **空集**（绝不回落全库——那是把整个曲库甩给非法请求）；
- `query` 超长 → 截断到 128（只过滤，不重排）；
- 构造期归一（排序 / 去重 / `trackCount` 自洽），同一份事实编出同样的字节。
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .library_sources import local_sources
from .locallib import (
    MAX_CATALOG_ENTRIES,
    MAX_PAGE_LIMIT,
    MAX_QUERY_LENGTH,
    MIN_PAGE_LIMIT,
    SCOPE_PLAYLISTS,
    SCOPE_TRACKS,
    int_or,
    is_valid_playlist_id,
    library_root,
    optional_str,
    ordered_unique,
    scan_library_files,
)


@dataclass(frozen=True, slots=True)
class PeerPlaylistItem:
    """歌单条目（§13.3）。"""

    id: str
    name: str
    track_count: int = 0

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（`{"id", "name", "trackCount"}`）。"""
        return {"id": self.id, "name": self.name, "trackCount": int(self.track_count)}


@dataclass(frozen=True, slots=True)
class PeerTrackItem:
    """曲目条目（§13.3）。"""

    relative_path: str
    title: str | None = None
    artist_name: str | None = None
    size_bytes: int = 0
    content_hash: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（camelCase 键；nil 字段省略，与 Swift Codable 同形）。"""
        payload: dict[str, Any] = {
            "relativePath": self.relative_path,
            "sizeBytes": int(self.size_bytes),
        }
        if self.title:
            payload["title"] = self.title
        if self.artist_name:
            payload["artistName"] = self.artist_name
        if self.content_hash:
            payload["contentHash"] = self.content_hash
        return payload


@dataclass(frozen=True, slots=True)
class PeerLibraryRequest:
    """`peer_library_request`（帧 15）载荷（不可信输入，归一见下）。"""

    scope: str = ""
    playlist_id: str | None = None
    query: str | None = None
    offset: int = 0
    limit: int = 50
    request_id: int = 0

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any] | None) -> PeerLibraryRequest:
        """线上载荷 → 请求（字段缺省 / 类型异常一律取缺省值，绝不抛）。"""
        data = payload or {}
        return cls(
            scope=str(data.get("scope", "") or ""),
            playlist_id=optional_str(data.get("playlistID")),
            query=optional_str(data.get("query")),
            offset=int_or(data.get("offset"), 0),
            limit=int_or(data.get("limit"), 50),
            request_id=int_or(data.get("requestID"), 0),
        )

    @property
    def scope_value(self) -> str | None:
        """合法范围；未知字符串 → None（应答侧回空清单 + `total: 0`）。"""
        return self.scope if self.scope in (SCOPE_PLAYLISTS, SCOPE_TRACKS) else None

    @property
    def clamped_limit(self) -> int:
        """钳制后的页大小（`<= 0 → 1`，`> 500 → 500`）。"""
        return min(max(self.limit, MIN_PAGE_LIMIT), MAX_PAGE_LIMIT)

    @property
    def clamped_offset(self) -> int:
        """钳制后的分页起点（负值 → 0）。"""
        return max(self.offset, 0)

    @property
    def normalized_query(self) -> str | None:
        """归一后的搜索词：去首尾空白 + 截断到 128；空 → None（= 不过滤）。"""
        trimmed = (self.query or "").strip()
        return trimmed[:MAX_QUERY_LENGTH] or None

    @property
    def normalized_playlist_id(self) -> str | None:
        """归一后的歌单标识：去空白；空 → None（= 全库）。形态非法仍原样返回。"""
        trimmed = (self.playlist_id or "").strip()
        return trimmed or None


@dataclass(slots=True)
class PeerLibraryCatalog:
    """对端内容清单全量事实（§13.3；构造期归一：排序 / 去重 / `trackCount` 自洽）。"""

    playlists: list[PeerPlaylistItem] = field(default_factory=list)
    tracks: list[PeerTrackItem] = field(default_factory=list)
    member_paths: dict[str, list[str]] = field(default_factory=dict)
    truncated: bool = False

    def __post_init__(self) -> None:
        # 歌单：按 (name, id) 升序 + 按 id 去重；曲目：按相对路径升序 + 去重 + 上限截断
        self.playlists = normalized_playlists(self.playlists)
        self.tracks = normalized_tracks(self.tracks)
        # trackCount 自洽（§13.7）：成员先与曲目清单求交再取条数——由构造期强制，
        # 杜绝「顶部摘要数字与筛选结果对不上」。
        catalog_paths = {t.relative_path for t in self.tracks}
        paths_by_playlist: dict[str, list[str]] = {}
        for item in self.playlists:
            paths_by_playlist[item.id] = ordered_unique(
                [p for p in self.member_paths.get(item.id, ()) if p in catalog_paths]
            )
        self.member_paths = paths_by_playlist
        self.playlists = [
            PeerPlaylistItem(
                id=item.id, name=item.name, track_count=len(paths_by_playlist.get(item.id, ()))
            )
            for item in self.playlists
        ]

    @property
    def total_size_bytes(self) -> int:
        """曲库总大小（摘要；负值 / 未知按 0 计）。"""
        return sum(max(0, t.size_bytes) for t in self.tracks)

    def ordered_member_paths(self, playlist_id: str | None) -> list[str] | None:
        """指定歌单的成员相对路径（来源顺序）：None = 不过滤；非法 / 未知 → 空列表。"""
        if playlist_id is None:
            return None
        if not is_valid_playlist_id(playlist_id):
            return []
        return list(self.member_paths.get(playlist_id, ()))

    def matched_tracks(self, request: PeerLibraryRequest) -> list[PeerTrackItem]:
        """按歌单 / 搜索词收窄的曲目（顺序 = 来源顺序或相对路径升序；query 只过滤不重排）。"""
        matched = list(self.tracks)
        members = self.ordered_member_paths(request.normalized_playlist_id)
        if members is not None:
            rank = {path: index for index, path in enumerate(members)}
            matched = sorted(
                (t for t in matched if t.relative_path in rank),
                key=lambda t: rank[t.relative_path],
            )
        query = request.normalized_query
        if query:
            needle = query.lower()
            matched = [t for t in matched if _track_matches(t, needle)]
        return matched

    def response(self, request: PeerLibraryRequest) -> dict[str, Any]:
        """一个请求 → 一页响应（**全函数，不抛**；摘要恒返回，§13.4.2）。"""
        payload: dict[str, Any] = {
            "requestID": request.request_id,
            "scope": request.scope,
            "total": 0,
            "items": [],
            "hasMore": False,
            "libraryTrackCount": len(self.tracks),
            "librarySizeBytes": self.total_size_bytes,
            "truncated": bool(self.truncated),
        }
        scope = request.scope_value
        if scope is None:
            return payload  # 非法 scope：空清单 + total 0，摘要照常（不报错、不断会话）
        if scope == SCOPE_PLAYLISTS:
            items: list[dict[str, Any]] = [
                {"kind": "playlist", "playlist": p.to_payload()} for p in self.playlists
            ]
        else:
            items = [
                {"kind": "track", "track": t.to_payload()} for t in self.matched_tracks(request)
            ]
        total = len(items)
        start = min(request.clamped_offset, total)
        end = min(start + request.clamped_limit, total)
        payload["total"] = total
        payload["items"] = items[start:end]
        payload["hasMore"] = end < total
        return payload


def normalized_playlists(raw: Sequence[PeerPlaylistItem]) -> list[PeerPlaylistItem]:
    """歌单归一：按 (name, id) 升序 + 按 id 去重（保留排序后最靠前者）。"""
    seen: set[str] = set()
    out: list[PeerPlaylistItem] = []
    for item in sorted(raw, key=lambda p: (p.name, p.id)):
        if item.id in seen:
            continue
        seen.add(item.id)
        out.append(item)
    return out


def normalized_tracks(raw: Sequence[PeerTrackItem]) -> list[PeerTrackItem]:
    """曲目归一：按 (相对路径, 其余字段破平) 升序 + 去重 + 上限截断。"""
    seen: set[str] = set()
    out: list[PeerTrackItem] = []
    for item in sorted(raw, key=_track_sort_key):
        if item.relative_path in seen:
            continue
        seen.add(item.relative_path)
        out.append(item)
    return out[:MAX_CATALOG_ENTRIES]


def _track_sort_key(item: PeerTrackItem) -> tuple[str, str, str, int, str]:
    """曲目全序（相对路径优先；同路径用其余字段确定性破平）。"""
    return (
        item.relative_path,
        item.title or "",
        item.artist_name or "",
        int(item.size_bytes),
        item.content_hash or "",
    )


def _track_matches(track: PeerTrackItem, needle: str) -> bool:
    """搜索词命中（contains，大小写不敏感；相对路径 / 标题 / 歌手任一命中）。"""
    if needle in track.relative_path.lower():
        return True
    if track.title and needle in track.title.lower():
        return True
    return bool(track.artist_name and needle in track.artist_name.lower())


def build_peer_library_catalog(
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
    ensure_hashes: bool = False,
) -> PeerLibraryCatalog:
    """本端曲库 → 对端内容清单事实（歌单 + 曲目 + 成员关系）。

    Args:
        ensure_hashes: 缺省 False——只读已落库指纹（对端清单链路不哈希整库）；
            置 True 与 manifest 链路同口径（会惰性补算指纹）。
    """
    root_path = library_root(root)
    files = scan_library_files(root=root_path, songs=songs, compute_missing_hashes=ensure_hashes)
    tracks = [
        PeerTrackItem(
            relative_path=f.relative_path,
            title=f.title,
            artist_name=f.artist,
            size_bytes=f.size,
            content_hash=f.content_hash,
        )
        for f in files
    ]
    sources = local_sources(root=root_path, files=files)
    return PeerLibraryCatalog(
        playlists=[PeerPlaylistItem(id=s.id, name=s.name, track_count=0) for s in sources],
        tracks=tracks,
        member_paths={s.id: list(s.members) for s in sources},
        truncated=len(tracks) > MAX_CATALOG_ENTRIES,
    )


def peer_library_response(
    payload: Mapping[str, Any] | None,
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
    ensure_hashes: bool = False,
) -> dict[str, Any]:
    """`peer_library_request`（帧 15）载荷 → `peer_library_response`（帧 16）载荷。"""
    catalog = build_peer_library_catalog(root=root, songs=songs, ensure_hashes=ensure_hashes)
    return catalog.response(PeerLibraryRequest.from_payload(payload))
