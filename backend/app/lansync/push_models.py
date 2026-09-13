"""局域网同步（S2）推送线契约 + 纯逻辑（帧 10/11/14 载荷、声明条目形态、推送方向对账）。

本模块是「推送到设备」的**无会话、无帧**那一半（对位 Swift
`QQPlayer/Sync/SyncLibraryPushModels.swift` + `SyncLibraryPushPlanner`）：

- **声明帧载荷**（帧 14 `library_push_announce`，§12.1）：`PushEntry` 形态校验
  （`relativePath` 规范化后与自身相等、`transferName` = 路径末段且单段合法、
  `fileID` ≤128 且不含路径分隔符、`sha256Hex` 非空）+ 归一（升序 / 同路径去重 /
  丢结构非法）；
- **帧 10/11 载荷**（manifest 请求 / 响应）：`encode_manifest_request` /
  `decode_manifest_response` / `manifest_payload`；
- **推送方向对账**（§11.3 推送方向）：`push_plan` —— 以**本端选择集**为准，
  对端缺 → 推、同 `content_hash` → 跳过、任一侧无指纹 → 保守推、
  **对端多出来的条目什么都不做**（不传播删除）；
- **纯计算版声明装配**：`build_push_announce` / `push_announce_response`
  （路由 / UI 预览「这次会推哪些歌」复用），不起会话、不发帧。

为什么单独有声明帧（而不是把相对路径塞进 `file_meta.name`）：`name` 的既有语义是
「文件名（不含路径）+ 单段校验」，改语义会把目录安全责任压到传输层；声明帧把目标
相对路径放在**应用层**，与 manifest / 取文件请求共用同一套 `normalize_relative_path`
口径（Swift `SyncLibraryPushModels.swift:13-19`）。

帧驱动编排（运行实例、账目、状态机）在 :mod:`app.lansync.push`。
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

from .filetransfer import sha256_file
from .locallib import (
    REASON_INVALID_PATH,
    library_root,
    normalize_relative_path,
)
from .manifest import Collection, ManifestEntry, manifest_entries, manifest_response

#: 发送侧失败原因（Swift `SyncPushFailureReason` 取值，跨端字符串契约可加不可改）
REASON_LOCAL_FILE_UNAVAILABLE = "local_file_unavailable"
#: 会话已关闭（本端扩展：Swift 把取消折进 failed，此处用于停止原因）
REASON_SESSION_CLOSED = "session_closed"
#: 本端主动取消
REASON_CANCELLED = "cancelled"

#: 传输名长度上限（§12.1）
MAX_TRANSFER_NAME_LENGTH = 255
#: fileID 长度上限（§12.1）
MAX_FILE_ID_LENGTH = 128


class PushError(Exception):
    """推送编排错误（会话未就绪 / 载荷非法 / 未知 run）。"""


# ============ 声明条目（帧 14 载荷，§12.1） ============
@dataclass(frozen=True, slots=True)
class PushEntry:
    """一条推送声明（`SyncPushEntry`）：目标相对路径 + 传输身份。"""

    relative_path: str
    transfer_name: str
    file_id: str
    sha256_hex: str
    size: int

    def to_payload(self) -> dict[str, Any]:
        """线上载荷（camelCase 键，键序 = Swift 声明顺序）。"""
        return {
            "relativePath": self.relative_path,
            "transferName": self.transfer_name,
            "fileID": self.file_id,
            "sha256Hex": self.sha256_hex,
            "size": int(self.size),
        }

    @classmethod
    def from_payload(cls, payload: Mapping[str, Any]) -> PushEntry:
        """线上载荷 → 条目（字段缺失 / 类型不符 → `PushError`）。"""
        values: dict[str, Any] = {}
        for key in ("relativePath", "transferName", "fileID", "sha256Hex"):
            value = payload.get(key)
            if not isinstance(value, str):
                raise PushError(f"推送声明条目字段缺失或类型不符：{key}")
            values[key] = value
        size = payload.get("size")
        if isinstance(size, bool) or not isinstance(size, int):
            raise PushError("推送声明条目字段缺失或类型不符：size")
        return cls(
            relative_path=values["relativePath"],
            transfer_name=values["transferName"],
            file_id=values["fileID"],
            sha256_hex=values["sha256Hex"],
            size=size,
        )

    @property
    def is_structurally_valid(self) -> bool:
        """本条声明自洽（§12.1：相对路径规范化后与自身相等、传输名 = 末段且合法、
        fileID 形态合法、sha256Hex 非空）。"""
        normalized = normalize_relative_path(self.relative_path)
        if normalized is None or normalized != self.relative_path:
            return False
        if self.transfer_name != transfer_name_for(self.relative_path):
            return False
        return bool(is_valid_file_id(self.file_id) and self.sha256_hex)


def is_valid_transfer_name(name: str) -> bool:
    """传输名单段校验（非空、非 `.`/`..`、≤255、不含路径分隔符、不以 `.` 开头）。"""
    if not name or name in (".", ".."):
        return False
    if len(name) > MAX_TRANSFER_NAME_LENGTH:
        return False
    if "/" in name or "\\" in name:
        return False
    return not name.startswith(".")


def is_valid_file_id(file_id: str) -> bool:
    """fileID 形态校验（非空、≤128、非点段、不含路径分隔符）。"""
    if not file_id or len(file_id) > MAX_FILE_ID_LENGTH or file_id in (".", ".."):
        return False
    return "/" not in file_id and "\\" not in file_id


def transfer_name_for(relative_path: str) -> str | None:
    """相对路径 → 传输名（末段；单段校验不过 = None）。"""
    normalized = normalize_relative_path(relative_path)
    if normalized is None:
        return None
    name = normalized.rsplit("/", 1)[-1]
    return name if is_valid_transfer_name(name) else None


def make_push_entry(
    relative_path: str, *, file_id: str, sha256_hex: str, size: int
) -> PushEntry | None:
    """由相对路径构造声明条目；路径 / ID 非法 → None（与 Swift `SyncPushEntry.make` 同判据）。"""
    normalized = normalize_relative_path(relative_path)
    if normalized is None:
        return None
    name = transfer_name_for(normalized)
    if name is None or not is_valid_file_id(file_id):
        return None
    return PushEntry(
        relative_path=normalized,
        transfer_name=name,
        file_id=file_id,
        sha256_hex=sha256_hex,
        size=int(size),
    )


def normalize_announce_entries(entries: Iterable[PushEntry]) -> list[PushEntry]:
    """声明归一（§12.1）：按 `relativePath` 升序 + 同路径去重（首个生效）+ 丢弃结构非法。"""
    kept: list[PushEntry] = []
    seen: set[str] = set()
    for entry in sorted(entries, key=lambda item: item.relative_path):
        if not entry.is_structurally_valid:
            continue
        if entry.relative_path in seen:
            continue
        seen.add(entry.relative_path)
        kept.append(entry)
    return kept


def encode_push_announce(entries: Sequence[PushEntry]) -> bytes:
    """帧 14 载荷编码（`{"entries": [...]}`，已由 :func:`normalize_announce_entries` 归一）。"""
    payload = {"entries": [entry.to_payload() for entry in entries]}
    return _encode_json(payload)


def decode_push_announce(payload: bytes) -> list[PushEntry]:
    """帧 14 载荷解码（结构非法 → `PushError`）；返回**未归一**的原始条目列表。"""
    raw = _decode_json_object(payload, "library_push_announce")
    entries = raw.get("entries")
    if isinstance(entries, (str, bytes)) or not isinstance(entries, (list, tuple)):
        raise PushError("library_push_announce 缺 entries 数组")
    out: list[PushEntry] = []
    for item in entries:
        if not isinstance(item, dict):
            raise PushError("library_push_announce 的 entries 元素不是对象")
        out.append(PushEntry.from_payload(item))
    return out


# ============ manifest 帧（10/11） ============
def encode_manifest_request(collection: Collection | None = None) -> bytes:
    """帧 10 载荷编码（`{"collection": {"kind","ids"}}`，§11.1）。"""
    payload = {"collection": (collection or Collection.all()).to_payload()}
    return _encode_json(payload)


def decode_manifest_response(payload: bytes) -> tuple[list[ManifestEntry], str | None]:
    """帧 11 载荷解码 → `(条目列表, rootName)`；结构非法 → `PushError`。

    `contentHash` / `stableId` 可缺省（对端尚未指纹），其余字段缺失即结构非法。
    """
    raw = _decode_json_object(payload, "manifest_response")
    entries = raw.get("entries")
    if isinstance(entries, (str, bytes)) or not isinstance(entries, (list, tuple)):
        raise PushError("manifest_response 缺 entries 数组")
    out: list[ManifestEntry] = []
    for item in entries:
        if not isinstance(item, dict):
            raise PushError("manifest_response 的 entries 元素不是对象")
        relative_path = item.get("relativePath")
        size = item.get("size")
        mtime_ms = item.get("mtimeMs")
        if not isinstance(relative_path, str):
            raise PushError("manifest_response 条目缺 relativePath")
        if isinstance(size, bool) or not isinstance(size, int):
            raise PushError("manifest_response 条目缺 size")
        if isinstance(mtime_ms, bool) or not isinstance(mtime_ms, int):
            raise PushError("manifest_response 条目缺 mtimeMs")
        content_hash = item.get("contentHash")
        stable_id = item.get("stableId")
        if content_hash is not None and not isinstance(content_hash, str):
            raise PushError("manifest_response 条目的 contentHash 类型非法")
        if stable_id is not None and not isinstance(stable_id, str):
            raise PushError("manifest_response 条目的 stableId 类型非法")
        out.append(
            ManifestEntry(
                relative_path=relative_path,
                size=size,
                mtime_ms=mtime_ms,
                content_hash=content_hash,
                stable_id=stable_id,
            )
        )
    root_name = raw.get("rootName")
    if root_name is not None and not isinstance(root_name, str):
        raise PushError("manifest_response 的 rootName 类型非法")
    return out, root_name


def manifest_payload(collection: Collection | None = None, *, root: Any = None) -> bytes:
    """帧 11 载荷编码（Host 作为被动端应答 manifest 请求时用）。"""
    return _encode_json(manifest_response(collection, root=root))


def _encode_json(payload: dict[str, Any]) -> bytes:
    """载荷字典 → JSON 字节（紧凑、UTF-8、不转义非 ASCII）。"""
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _decode_json_object(payload: bytes, what: str) -> dict[str, Any]:
    """帧 payload → JSON 对象（坏 JSON / 非对象 → `PushError`）。"""
    try:
        value = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as error:
        raise PushError(f"{what} 不是合法 JSON：{error}") from error
    if not isinstance(value, dict):
        raise PushError(f"{what} 不是 JSON 对象")
    return value


# ============ 推送方向对账（纯逻辑） ============
def content_matches(local: ManifestEntry, remote: ManifestEntry) -> bool:
    """内容判定单点（与 Swift `SyncManifestReconciler.contentMatches` 逐字一致）：
    双侧 `content_hash` 均非空且相等 → 一致；任一侧缺失 → 保守判为「需推送」。"""
    local_hash = local.content_hash or ""
    remote_hash = remote.content_hash or ""
    if not local_hash or not remote_hash:
        return False
    return local_hash == remote_hash


@dataclass(frozen=True, slots=True)
class PushPlan:
    """推送计划（纯值）：需推送 + 已一致（各自按相对路径升序）。"""

    to_push: tuple[ManifestEntry, ...] = ()
    unchanged: tuple[ManifestEntry, ...] = ()


def push_plan(local: Sequence[ManifestEntry], remote: Sequence[ManifestEntry]) -> PushPlan:
    """推送方向对账（**以本端选择集为准**，§11.3）：

    - 对端缺该相对路径 → 推送；
    - 同路径内容一致（同 `content_hash`）→ 跳过；
    - 任一侧无指纹 → 保守推送（宁可多传一次，不可漏传）；
    - **对端多出来的条目 → 什么都不做**（不传播删除）。
    """
    remote_by_path: dict[str, ManifestEntry] = {}
    for entry in remote:
        remote_by_path[entry.relative_path] = entry  # later wins（对端给最终快照）
    to_push: list[ManifestEntry] = []
    unchanged: list[ManifestEntry] = []
    for entry in local:
        remote_entry = remote_by_path.get(entry.relative_path)
        if remote_entry is None:
            to_push.append(entry)
        elif content_matches(entry, remote_entry):
            unchanged.append(entry)
        else:
            to_push.append(entry)
    return PushPlan(
        to_push=tuple(sorted(to_push, key=lambda item: item.relative_path)),
        unchanged=tuple(sorted(unchanged, key=lambda item: item.relative_path)),
    )


# ============ 账目 ============
@dataclass(frozen=True, slots=True)
class PushFailure:
    """一条推送失败记录（诊断 / UI 用；本地账目，无线上载荷）。"""

    relative_path: str
    reason: str
    detail: str | None = None

    def to_dict(self) -> dict[str, Any]:
        """事件 / 状态字典。"""
        payload: dict[str, Any] = {"relativePath": self.relative_path, "reason": self.reason}
        if self.detail:
            payload["detail"] = self.detail
        return payload


@dataclass(slots=True)
class LibraryPushSummary:
    """一次推送的结果账目（planned / skipped / completed / failed）。"""

    planned: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    completed: list[str] = field(default_factory=list)
    failed: list[PushFailure] = field(default_factory=list)

    @property
    def is_full_success(self) -> bool:
        """每个计划条目都确认送达（无失败且送达数 = 计划数）。"""
        return not self.failed and len(self.completed) == len(self.planned)

    def to_dict(self) -> dict[str, Any]:
        """状态字典（含计数字段，UI 直接可用）。"""
        return {
            "planned": list(self.planned),
            "skipped": list(self.skipped),
            "completed": list(self.completed),
            "failed": [item.to_dict() for item in self.failed],
            "plannedCount": len(self.planned),
            "skippedCount": len(self.skipped),
            "completedCount": len(self.completed),
            "failedCount": len(self.failed),
        }


# ============ 纯计算版装配（路由 / 预览复用） ============
def as_collection(selection: Collection | Mapping[str, Any] | None) -> Collection:
    """选择集归一：`Collection` 原样、线上字典解析、None = 全库。"""
    if selection is None:
        return Collection.all()
    if isinstance(selection, Collection):
        return selection
    if isinstance(selection, Mapping):
        try:
            return Collection.from_payload(selection)
        except ValueError as error:
            raise PushError(f"选择集非法：{error}") from error
    raise PushError(f"选择集类型非法：{type(selection).__name__}")


def build_push_announce(
    selection: Collection | Mapping[str, Any] | None = None,
    *,
    root: Any = None,
    remote_entries: Sequence[ManifestEntry] = (),
) -> tuple[list[PushEntry], LibraryPushSummary]:
    """纯计算版编排：选择集 + 对端快照 → `(声明条目, 账目)`（不起会话、不发帧）。

    供路由 / 预览链路复用（UI「这次会推哪些歌」），也便于单测对账规则。
    """
    collection = as_collection(selection)
    local_entries = manifest_entries(collection, root=root)
    plan = push_plan(local_entries, remote_entries)
    root_path = library_root(root)
    entries: list[PushEntry] = []
    failures: list[PushFailure] = []
    for entry in plan.to_push:
        built = _build_entry(root_path, entry)
        if built is None:
            failures.append(PushFailure(entry.relative_path, REASON_LOCAL_FILE_UNAVAILABLE))
            continue
        entries.append(built)
    announce = normalize_announce_entries(entries)
    announced = {entry.relative_path for entry in announce}
    for entry in entries:
        if entry.relative_path not in announced:
            failures.append(
                PushFailure(entry.relative_path, REASON_INVALID_PATH, "声明结构校验未通过")
            )
    summary = LibraryPushSummary(
        planned=[entry.relative_path for entry in announce],
        skipped=[entry.relative_path for entry in plan.unchanged],
        failed=failures,
    )
    return announce, summary


def push_announce_response(
    selection: Collection | Mapping[str, Any] | None = None,
    *,
    root: Any = None,
    remote_manifest_payload: bytes | None = None,
) -> dict[str, Any]:
    """声明帧 14 的载荷字典（路由 / 预览用）：选择集 + 对端 manifest 响应载荷 → dict。"""
    remote_entries: list[ManifestEntry] = []
    if remote_manifest_payload:
        remote_entries, _ = decode_manifest_response(remote_manifest_payload)
    announce, summary = build_push_announce(selection, root=root, remote_entries=remote_entries)
    return {
        "entries": [entry.to_payload() for entry in announce],
        "summary": summary.to_dict(),
    }


def build_push_entry(root: Any, entry: ManifestEntry) -> PushEntry | None:
    """一条本端 manifest 条目 → 声明条目（文件不存在 / 不可读 / 形态非法 → None）。"""
    return _build_entry(library_root(root), entry)


def _build_entry(root_path: Any, entry: ManifestEntry) -> PushEntry | None:
    """`build_push_entry` / `build_push_announce` 共用实现（文件系统事实 + 形态）。"""
    path = root_path.joinpath(*entry.relative_path.split("/"))
    if not path.is_file():
        return None
    sha256_hex = entry.content_hash or ""
    if not sha256_hex:
        try:
            sha256_hex = sha256_file(path)
        except OSError:
            return None
    try:
        size = path.stat().st_size
    except OSError:
        return None
    return make_push_entry(
        entry.relative_path,
        file_id=entry.content_hash or sha256_hex,
        sha256_hex=sha256_hex,
        size=size,
    )
