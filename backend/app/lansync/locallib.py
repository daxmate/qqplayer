"""局域网同步（S2）本端曲库映射基座：路径口径 / 内容指纹 / 曲库扫描 / 按路径取文件。

web 版 QQPlayer（FastAPI + Vue）作为 S2 的 **Host** 时，「内容同步」的第一步是把本端
曲库表述成对端能对账的清单，并按相对路径提供文件。本模块是该能力的**公共基座**
（协议 `docs/lan-sync-protocol.md` §11 / §13；Swift 参考 `QQPlayer/Sync/SyncManifest.swift`、
`SyncManifestGenerator.swift`、`SyncLocalLibraryScanner.swift`）：

- :mod:`app.lansync.library_sources` —— 本端内容来源（收藏 / 歌单 / `@smart:*`）
- :mod:`app.lansync.manifest` —— manifest（帧 10/11，集合过滤 + 有序条目）
- :mod:`app.lansync.peer_library` —— 对端内容清单（帧 15/16，分页 + 摘要）

本模块提供三件事（其余模块只依赖这里，依赖方向单一）：

1. **路径口径**（对账键的单一事实源）：相对**曲库根**的 POSIX 路径；
   :func:`normalize_relative_path` 拒绝空串 / 绝对路径 / `..` 逃逸。
2. **内容指纹**：音频文件字节 SHA-256（小写 hex，跨端歌曲身份键，**不是**路径哈希）；
   惰性计算 + 落库（`track_fingerprints` 表），size / mtime 变了才重算。
3. **曲库扫描 + 取文件解析**：扫描结果 → :class:`LibraryFile`；相对路径 → 曲库内绝对
   路径（必须拦住 `..` / 绝对路径 / 软链逃逸，§11.5 明确 reason）。

不含传输与 UI：帧收发（10/11/15/16）在 server/service 层，等待后续接线。
"""

from __future__ import annotations

import hashlib
import logging
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app import db, state
from app.services import library_scan

logger = logging.getLogger(__name__)

# ============ 跨端常量（线上字符串契约，改动即破坏兼容） ============
#: 自动歌单保留前缀（§13.5）
SMART_PREFIX = "@smart:"
#: 自动歌单种类（固定序 = 同步页展示序；§13.6）
SMART_KINDS: tuple[str, ...] = ("recentAdded", "recentPlayed", "topPlayed")
#: 自动歌单显示名（默认语言 zh-CN，与播放列表页文案同值；对端仅展示用）
SMART_NAMES: dict[str, str] = {
    "recentAdded": "最近添加",
    "recentPlayed": "最近播放",
    "topPlayed": "常听排行",
}
#: 收藏保留标识 / 显示名（§13.5）
FAVORITES_ID = "@favorites"
FAVORITES_NAME = "收藏"
#: 「全部曲库」保留标识（**仅本端 UI 合成项**，不出现在对端清单里，§13.5）
LIBRARY_ID = "@library"
#: 自动歌单条数上限（与播放列表页 SMART_VIEW_LIMIT 同值，§13.6）
SMART_LIMIT = 50
#: 对端清单条目上限（§13.4.1：超出按已排序前缀截断）
MAX_CATALOG_ENTRIES = 50_000
#: 歌单标识长度上限（§13.5）
MAX_PLAYLIST_ID_LENGTH = 128
#: 页大小共识（§13.2）
MIN_PAGE_LIMIT = 1
MAX_PAGE_LIMIT = 500
#: 搜索词长度上限（§13.2）
MAX_QUERY_LENGTH = 128
#: 集合类型（§11.1）
COLLECTION_KINDS: tuple[str, ...] = ("all", "playlists", "tracks")
#: 请求范围（§13.2）
SCOPE_PLAYLISTS = "playlists"
SCOPE_TRACKS = "tracks"

#: 取文件失败原因（跨端字符串契约，§11.5；可加不可改）
REASON_INVALID_PATH = "invalid_path"
REASON_OUT_OF_ROOT = "out_of_root"
REASON_NOT_FOUND = "not_found"
REASON_NOT_REGULAR_FILE = "not_regular_file"
REASON_SEND_FAILED = "send_failed"

#: 指纹分块读大小（1 MiB；大文件不整份读入内存）
HASH_CHUNK_BYTES = 1024 * 1024


# ============ 路径（对账键的单一事实源） ============
def normalize_relative_path(raw: Any) -> str | None:
    """相对路径规范化：拒空串 / 绝对路径 / `..` 逃逸，统一分隔符与 `./`、重复 `/`。

    Args:
        raw: 原始路径（不可信输入，可能非字符串）。

    Returns:
        规范化后的 POSIX 相对路径；非法返回 None（调用方**丢弃**，绝不「顺手修正」）。
    """
    if not isinstance(raw, str):
        return None
    path = raw.strip()
    if not path or path.startswith("/"):
        return None
    path = path.replace("\\", "/")
    parts: list[str] = []
    for part in path.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            return None
        parts.append(part)
    if not parts:
        return None
    return "/".join(parts)


def relative_path_of(path: Any, root: Any) -> str | None:
    """绝对路径 → 相对曲库根的 POSIX 路径（不在根内 / 等于根 / 空 → None）。"""
    if not path:
        return None
    base = Path(os.path.abspath(str(root))).parts
    target = Path(os.path.abspath(str(path))).parts
    if len(target) <= len(base) or target[: len(base)] != base:
        return None
    return normalize_relative_path("/".join(target[len(base) :]))


def is_valid_playlist_id(playlist_id: Any) -> bool:
    """歌单标识形态校验（§13.5）：非空、限长、非点段、无路径分隔符、无控制字符。"""
    if not isinstance(playlist_id, str):
        return False
    trimmed = playlist_id.strip()
    if not trimmed or len(trimmed) > MAX_PLAYLIST_ID_LENGTH:
        return False
    if trimmed in (".", ".."):
        return False
    if "/" in trimmed or "\\" in trimmed:
        return False
    return not any(ord(ch) < 32 or ord(ch) == 127 for ch in trimmed)


def _is_within(path: Any, root: Any) -> bool:
    """纯路径数学：`path` 是否等于 `root` 或在 `root` 之下（不解析软链）。"""
    target = os.path.abspath(str(path))
    base = os.path.abspath(str(root))
    return target == base or target.startswith(base.rstrip(os.sep) + os.sep)


def library_root(root: Any = None) -> Path:
    """曲库根（显式参数优先，缺省取 `state.LIBRARY`——测试可注入临时曲库）。"""
    return Path(root) if root is not None else Path(state.LIBRARY)


# ============ 内容指纹（SHA-256，惰性 + 落库） ============
def sha256_file(path: Any) -> str:
    """文件字节 SHA-256（小写 hex），流式读取（不整份载入内存）。"""
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(HASH_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _stat_ms(path: str) -> tuple[int, int] | None:
    """`(size, mtime_ms)`；路径不存在 / 不可访问 → None。"""
    try:
        st = os.stat(path)
    except OSError:
        return None
    return int(st.st_size), int(st.st_mtime * 1000)


def _cached_hash(rel: str, size: int, mtime_ms: int) -> str | None:
    """缓存命中（size + mtime 一致）返回指纹，否则 None（= 需要重算）。"""
    row = db.track_fingerprint_get(rel)
    if not row:
        return None
    if int(row["size"]) != size or int(row["mtime_ms"]) != mtime_ms:
        return None
    return row["content_hash"] or None


def ensure_content_hash(relative_path: Any, *, root: Any = None) -> str | None:
    """单文件惰性指纹：缓存命中直接用，否则现算 + 落库（§11.6 fileID 口径）。

    路径非法 / 文件不在根内 / 不存在 → None（调用方按 §11.5 `not_found` 处理）。
    """
    rel = normalize_relative_path(relative_path)
    if rel is None:
        return None
    root_path = library_root(root)
    abs_path = str(root_path.joinpath(*rel.split("/")))
    if not _is_within(abs_path, root_path):
        return None
    stat_info = _stat_ms(abs_path)
    if stat_info is None:
        return None
    size, mtime_ms = stat_info
    cached = _cached_hash(rel, size, mtime_ms)
    if cached:
        return cached
    try:
        digest = sha256_file(abs_path)
    except OSError:
        logger.warning("lansync 内容指纹计算失败：%s", abs_path, exc_info=True)
        return None
    db.track_fingerprints_upsert(
        [{"relative_path": rel, "content_hash": digest, "size": size, "mtime_ms": mtime_ms}]
    )
    return digest


# ============ 曲库扫描（manifest 与对端清单共用的事实层） ============
@dataclass(frozen=True, slots=True)
class LibraryFile:
    """一次曲库扫描得到的单文件事实。"""

    relative_path: str
    path: str
    size: int
    mtime_ms: int
    content_hash: str | None = None
    title: str | None = None
    artist: str | None = None


def scan_library_files(
    *,
    root: Any = None,
    songs: Sequence[Mapping[str, Any]] | None = None,
    compute_missing_hashes: bool = True,
) -> list[LibraryFile]:
    """曲库 → 文件事实列表（按相对路径升序；口径与扫描服务同源）。

    Args:
        root: 曲库根（缺省 `state.LIBRARY`）。
        songs: 曲库扫描结果（缺省走 `library_scan.scan_library()` 缓存；测试可注入）。
        compute_missing_hashes: True = 未指纹的现算并落库（manifest 链路）；
            False = 只读缓存（对端清单链路，避免一次请求哈希整个曲库）。

    Returns:
        去重（同相对路径保留扫描序靠后者 = 更新）并按相对路径升序的条目。
    """
    root_path = library_root(root)
    rows = songs if songs is not None else library_scan.scan_library()
    by_path: dict[str, LibraryFile] = {}
    pending: list[dict[str, Any]] = []
    for song in rows or []:
        rel = normalize_relative_path(song.get("id"))
        if rel is None:
            rel = relative_path_of(song.get("path"), root_path)
        if rel is None:
            continue  # 不在根内 / 路径非法：丢弃，绝不入清单
        abs_path = str(song.get("path", "") or "")
        if not abs_path:
            continue
        stat_info = _stat_ms(abs_path)
        if stat_info is None:
            continue  # 扫描后被删除 / 移动：跳过
        size, mtime_ms = stat_info
        content_hash = _cached_hash(rel, size, mtime_ms)
        if content_hash is None and compute_missing_hashes:
            try:
                content_hash = sha256_file(abs_path)
            except OSError:
                logger.warning("lansync 内容指纹计算失败：%s", abs_path, exc_info=True)
            else:
                pending.append(
                    {
                        "relative_path": rel,
                        "content_hash": content_hash,
                        "size": size,
                        "mtime_ms": mtime_ms,
                    }
                )
        by_path[rel] = LibraryFile(
            relative_path=rel,
            path=abs_path,
            size=size,
            mtime_ms=mtime_ms,
            content_hash=content_hash,
            title=optional_str(song.get("name")),
            artist=optional_str(song.get("artist")),
        )
    if pending:
        db.track_fingerprints_upsert(pending)
    return [by_path[rel] for rel in sorted(by_path)]


# ============ 按相对路径取文件（帧 12/13 的本地解析） ============
@dataclass(frozen=True, slots=True)
class FileResolution:
    """相对路径解析结果：成功给本地绝对路径，失败给 reason（§11.5 取值）。"""

    path: Path | None
    reason: str | None = None

    @property
    def ok(self) -> bool:
        """是否解析成功（存在、是常规文件且未越界）。"""
        return self.path is not None


def resolve_library_file(relative_path: Any, *, root: Any = None) -> FileResolution:
    """相对路径 → 曲库内绝对路径（**必须拦住越界**，§11.5/§11.6）。

    四道闸：① 路径规范化（拒空 / 绝对路径 / `..`）② 根内包含性（纯路径数学）
    ③ 存在且是常规文件 ④ 解析软链后仍在根内（防符号链接逃逸）。
    """
    root_path = library_root(root)
    rel = normalize_relative_path(relative_path)
    if rel is None:
        return FileResolution(None, REASON_INVALID_PATH)
    candidate = root_path.joinpath(*rel.split("/"))
    if not _is_within(candidate, root_path):
        return FileResolution(None, REASON_OUT_OF_ROOT)
    if not candidate.exists():
        return FileResolution(None, REASON_NOT_FOUND)
    if not candidate.is_file():
        return FileResolution(None, REASON_NOT_REGULAR_FILE)
    if not _is_within(os.path.realpath(candidate), os.path.realpath(root_path)):
        return FileResolution(None, REASON_OUT_OF_ROOT)
    return FileResolution(candidate)


def fetch_plan(
    relative_paths: Sequence[Any], *, root: Any = None
) -> tuple[list[tuple[str, Path]], list[dict[str, str]]]:
    """请求路径列表 → `(可发送的 (规范化相对路径, 绝对路径), 失败记录)`。

    失败记录 = `{"relativePath": 请求方**原始字符串**, "reason": ...}`（§11.5：
    原始串原样回填，非法路径也如实计入，不静默丢弃；去重 / 排序由调用方按 §11.4 决定）。
    """
    ok: list[tuple[str, Path]] = []
    failed: list[dict[str, str]] = []
    for raw in relative_paths or ():
        raw_str = str(raw)
        resolution = resolve_library_file(raw_str, root=root)
        normalized = normalize_relative_path(raw_str)
        if resolution.ok and normalized:
            ok.append((normalized, resolution.path))
        else:
            failed.append(
                {"relativePath": raw_str, "reason": resolution.reason or REASON_INVALID_PATH}
            )
    return ok, failed


# ============ 小工具（本包内共用） ============
def optional_str(raw: Any) -> str | None:
    """可选字符串：非字符串 / 去空白后为空 → None（线上 nil 口径）。"""
    if not isinstance(raw, str):
        return None
    trimmed = raw.strip()
    return trimmed or None


def int_or(raw: Any, default: int) -> int:
    """宽容取整（bool / 非数字 / None → default）。"""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return default
    try:
        return int(raw)
    except (TypeError, ValueError, OverflowError):
        return default


def ordered_unique(paths: Sequence[str]) -> list[str]:
    """去重保序（同路径重复时留首个：成员表里同一首歌出现两次只算一次）。"""
    seen: set[str] = set()
    out: list[str] = []
    for path in paths:
        if path in seen:
            continue
        seen.add(path)
        out.append(path)
    return out
