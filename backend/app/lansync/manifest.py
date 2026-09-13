"""局域网同步（S2）manifest（帧 10/11）：集合过滤 + 有序条目。

协议 `docs/lan-sync-protocol.md` §11；Swift 参考 `QQPlayer/Sync/SyncManifest.swift`、
`SyncManifestGenerator.swift`、`SyncCollection.swift`。

- 条目 = :class:`ManifestEntry`（`relativePath` / `size` / `mtimeMs` / `contentHash`），
  **按 `relativePath` 升序**（确定性，跨端可比对）；
- 集合三种形态（§11.1）：`all` 全库、`playlists` 指定歌单、`tracks` 手动勾选；
  **选择性集合但 `ids` 为空 = 不选任何文件**（与 `all` 相反），未知 / 非法歌单标识
  → 空集（绝不回落全库）；
- `manifest_response` 是**单帧全量**（无分页 / 无游标），唯一上限是帧 payload 16 MiB；
- 本地 manifest 提供者未接线时不回帧（**绝不回空表**——空表会被对端读成「对端曲库为空」），
  该判断属调用方（server/service 层），本模块只负责事实。
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .library_sources import source_member_paths
from .locallib import (
    COLLECTION_KINDS,
    LibraryFile,
    library_root,
    normalize_relative_path,
    relative_path_of,
    scan_library_files,
)


@dataclass(frozen=True, slots=True)
class ManifestEntry:
    """一条 manifest 记录（线上载荷元素，§11.2）。"""

    relative_path: str
    size: int
    mtime_ms: int
    content_hash: str | None = None
    stable_id: str | None = None

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（camelCase 键；nil 字段省略，与 Swift Codable 同形）。"""
        payload: dict[str, Any] = {
            "relativePath": self.relative_path,
            "size": int(self.size),
            "mtimeMs": int(self.mtime_ms),
        }
        if self.content_hash:
            payload["contentHash"] = self.content_hash
        if self.stable_id:
            payload["stableId"] = self.stable_id
        return payload


@dataclass(frozen=True, slots=True)
class Collection:
    """同步集合（§11.1；`all` / `playlists` / `tracks`）。"""

    kind: str = "all"
    ids: tuple[str, ...] = ()

    @classmethod
    def all(cls) -> Collection:
        """全库。"""
        return cls()

    @classmethod
    def playlists(cls, ids: Iterable[Any]) -> Collection:
        """指定歌单（标识列表）。"""
        return cls(kind="playlists", ids=tuple(str(i) for i in ids or () if str(i).strip()))

    @classmethod
    def tracks(cls, ids: Iterable[Any]) -> Collection:
        """手动勾选歌曲（id = 本端相对路径或绝对路径；web 端歌曲标识即相对路径）。"""
        return cls(kind="tracks", ids=tuple(str(i) for i in ids or () if str(i).strip()))

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any] | None) -> Collection:
        """线上载荷 → 集合；未知 `kind` 抛 `ValueError`（§11：解码失败不回帧）。"""
        if payload is None:
            return cls()
        kind = str(payload.get("kind", "") or "")
        if kind not in COLLECTION_KINDS:
            raise ValueError(f"未知集合类型：{kind!r}")
        raw_ids = payload.get("ids")
        if isinstance(raw_ids, (str, bytes)) or not isinstance(raw_ids, Iterable):
            raw_ids = []
        return cls(kind=kind, ids=tuple(str(i) for i in raw_ids if str(i).strip()))

    @property
    def is_empty_selection(self) -> bool:
        """选择性集合但一个 id 都没给 = 不选任何文件（与 `all` 语义相反，§11.1）。"""
        return self.kind != "all" and not self.ids

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（`{"kind", "ids"}`）。"""
        return {"kind": self.kind, "ids": list(self.ids)}


def _selected_relative_paths(
    collection: Collection, *, root: Path, files: Sequence[LibraryFile]
) -> set[str]:
    """集合 → 成员相对路径集合（歌单并集 / 勾选歌曲；未知标识天然贡献空集）。"""
    if collection.kind == "tracks":
        selected: set[str] = set()
        for raw in collection.ids:
            rel = normalize_relative_path(raw) or relative_path_of(raw, root)
            if rel:
                selected.add(rel)
        return selected
    members = source_member_paths(root=root, files=files)
    union: set[str] = set()
    for raw in collection.ids:
        pid = str(raw).strip()
        union.update(members.get(pid, ()))
    return union


def manifest_entries(
    collection: Collection | None = None,
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
) -> list[ManifestEntry]:
    """集合过滤后的 manifest 条目（按 `relativePath` 升序，确定性，§11.2）。

    选择性集合但 `ids` 为空 → 空表（不选任何文件）；未知 / 非法歌单标识 → 空集。
    """
    collection = collection or Collection.all()
    root_path = library_root(root)
    files = scan_library_files(root=root_path, songs=songs)
    entries = [
        ManifestEntry(
            relative_path=f.relative_path,
            size=f.size,
            mtime_ms=f.mtime_ms,
            content_hash=f.content_hash,
        )
        for f in files
    ]
    if collection.kind == "all":
        return entries
    selected = _selected_relative_paths(collection, root=root_path, files=files)
    return [e for e in entries if e.relative_path in selected]


def manifest_response(
    collection: Collection | None = None,
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """`manifest_response`（帧 11）载荷：条目 + 曲库根显示名（§11.2，单帧全量无分页）。"""
    entries = manifest_entries(collection, root=root, songs=songs)
    return {
        "entries": [e.to_payload() for e in entries],
        "rootName": library_root(root).name,
    }
