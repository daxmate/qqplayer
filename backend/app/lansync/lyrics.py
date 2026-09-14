"""局域网同步（S2）S4 —— **aligned 歌词随歌通道**（§15：类型标记 / 线上命名空间 / 随歌复制）。

对位 Swift（只读参考）：`SyncAlignedLyrics.swift`（命名空间与 manifest 条目）、
`SyncLyricsReceiver.swift`（接收安装编排）、`Services/AlignedLyricsStore.swift`（歌词库唯一入口）。
线协议契约：`docs/lan-sync-protocol.md` §15。

════════════════════════════════════════════════════════════════════════════
web 端歌词存储形态（开工前取证结论，**本模块的映射口径**）
════════════════════════════════════════════════════════════════════════════
本仓库现有两处歌词存储（`backend/lyric_fetch.py`），**都没有「类型标记」字段**：

1. `manual`：`~/.cache/qqplayer/lyric/manual/{sha1(歌曲绝对路径)}.json`
   （`routers/lyrics.py` 的 `PUT /api/lyric/manual` 写入；含 `{format, text, source, tlyric}`）；
2. `network`：`~/.cache/qqplayer/lyric/{sha1(标题|歌手)}.json`（网易云 / lrclib 在线缓存）；
3. 此外还有「跟歌曲同目录的 .lrc/.srt 本地文件」——两者都不是，天然不同步。

web **没有**独立的「对齐歌词库」：`POST /api/lyric/align` 只返回 LRC 文本，
回填后由前端当作普通歌词（paste / upload）保存 → 落进 `manual`。

因此本模块新增**第三个命名空间** `aligned`（`state.ALIGNED_LYRIC_DIR`，与 Swift 的
`Documents/lyrics-aligned/` 对位），作为随歌通道的**唯一落点**；`manual` / `network`
一律不参与同步（判定收敛在 :class:`LyricsKind.synchronizes_with_library`，不写字面量）。

**文件名口径（与 Swift 的差异，如实记录）**：Swift 的 aligned 库文件名 = 本端 `stableId`，
线上路径 `@lyrics/{歌曲 content_hash}.json` 需要接收侧再映射一次；web 的本端身份是
**相对路径**（会随改名漂移），而 `content_hash` 才是稳定身份 → **web 的 aligned 文件直接
以歌曲 `content_hash` 命名**（`aligned/{content_hash}.json`），wire 路径与本地文件名一致，
映射恒等。副作用：歌曲改名不会丢歌词；代价是本地库文件名不直观（人读打开时需反查）。
"""

from __future__ import annotations

import hashlib
import logging
import os
import tempfile
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any

from app import db, state

from .filetransfer import (
    DEFAULT_ACK_TIMEOUT,
    FileSender,
    FileTransferError,
    decode_file_ack,
)
from .frame import FrameType
from .locallib import (
    REASON_INVALID_PATH,
    REASON_NOT_FOUND,
    REASON_NOT_REGULAR_FILE,
    REASON_OUT_OF_ROOT,
    FileResolution,
    normalize_relative_path,
)
from .manifest import ManifestEntry
from .push_models import make_push_entry, normalize_announce_entries

logger = logging.getLogger(__name__)


#: 歌词库种类 = **存储命名空间**（类型标记的唯一事实源，§15.1）
class LyricsKind(str, Enum):
    """歌词种类（与 Swift `LyricsStoreKind` 同构）。"""

    ALIGNED = "aligned"
    MANUAL = "manual"
    NETWORK = "network"

    @property
    def synchronizes_with_library(self) -> bool:
        """是否随歌曲对账同步（§15.1：**只有 aligned 为 true**）。"""
        return self is LyricsKind.ALIGNED


#: 参与同步的种类（同步侧要判「哪些歌词同步」时只经此处，不写字面量）
SYNCHRONIZED_KINDS: tuple[LyricsKind, ...] = tuple(
    kind for kind in LyricsKind if kind.synchronizes_with_library
)

#: 线上命名空间前缀（含结尾 `/`，§15.2）
LYRICS_PREFIX = "@lyrics/"
#: 线上扩展名
LYRICS_EXTENSION = "json"
#: `content_hash` 形态上限（长度上限，§15.2）
MAX_CONTENT_HASH_LENGTH = 128


# ============ 线上命名空间（§15.2） ============
def is_valid_content_hash(value: Any) -> bool:
    """`content_hash` 形态校验（**收到的哈希来自对端，按不可信输入处理**）。

    非空、限长、非点段、无路径分隔符、字符集限字母 / 数字 / `-` / `_` / `.`
    —— 绝不拿它拼路径。
    """
    if not isinstance(value, str):
        return False
    if not value or len(value) > MAX_CONTENT_HASH_LENGTH or value in (".", ".."):
        return False
    if "/" in value or "\\" in value:
        return False
    return all(ch.isalnum() or ch in "-_." for ch in value)


def is_lyrics_path(relative_path: Any) -> bool:
    """是否属于歌词命名空间（先规范化，`./@lyrics/...` 也算，§15.2）。"""
    normalized = normalize_relative_path(relative_path)
    if normalized is None:
        return False
    return normalized.startswith(LYRICS_PREFIX)


def wire_path(song_content_hash: Any) -> str | None:
    """歌曲 `content_hash` → wire 路径 `@lyrics/{hash}.json`；hash 非法 = None。"""
    if not is_valid_content_hash(song_content_hash):
        return None
    return f"{LYRICS_PREFIX}{song_content_hash}.{LYRICS_EXTENSION}"


def song_content_hash(from_wire_path: Any) -> str | None:
    """wire 路径 → 歌曲 `content_hash`（非本命名空间 / 形态非法 = None）。

    只接受**单层**文件名：`@lyrics/a/b.json` 与 `@lyrics/../x.json` 一律 None。
    """
    normalized = normalize_relative_path(from_wire_path)
    if normalized is None or not normalized.startswith(LYRICS_PREFIX):
        return None
    remainder = normalized[len(LYRICS_PREFIX) :]
    if not remainder or "/" in remainder:
        return None
    stem, dot, extension = remainder.rpartition(".")
    if not dot or extension != LYRICS_EXTENSION or not is_valid_content_hash(stem):
        return None
    return stem


def file_name(song_content_hash: Any) -> str | None:
    """歌曲 `content_hash` → 本地库文件名（`{hash}.json`；hash 非法 = None）。"""
    if not is_valid_content_hash(song_content_hash):
        return None
    return f"{song_content_hash}.{LYRICS_EXTENSION}"


# ============ 歌词库（唯一入口；只有 aligned 参与同步） ============
@dataclass(frozen=True, slots=True)
class AlignedLyricsEntry:
    """aligned 歌词库中的一条记录（manifest 生成输入，纯值）。"""

    content_hash: str
    path: Path
    size: int
    mtime_ms: int
    file_hash: str | None = None
    song_relative_path: str | None = None

    @property
    def wire_path(self) -> str:
        """线上相对路径（`@lyrics/{hash}.json`）。"""
        return f"{LYRICS_PREFIX}{self.content_hash}.{LYRICS_EXTENSION}"


def aligned_root(root: Any = None) -> Path:
    """aligned 歌词库根（显式注入优先；缺省 `state.ALIGNED_LYRIC_DIR`——测试可注入）。"""
    if root is not None:
        return Path(root)
    return Path(state.ALIGNED_LYRIC_DIR)


class AlignedLyricsStore:
    """aligned 歌词库的**唯一入口**（枚举 / 读 / 写 / 安装都走这里）。

    ⚠️ **不存在删除路径**（§15.4：本类型没有「删除本端歌词」的操作）——同步通道
    收到什么都不会删本端已有歌词；本地产物（AI 对齐）由 :meth:`save` 落库。
    """

    def __init__(self, root: Any = None) -> None:
        self._root = root

    @property
    def root(self) -> Path:
        """歌词库目录（不存在时返回约定路径，读取侧自行判存在）。"""
        return aligned_root(self._root)

    def path_for(self, content_hash: Any) -> Path | None:
        """歌曲 `content_hash` → 库内文件路径（hash 非法 = None）。"""
        name = file_name(content_hash)
        return None if name is None else self.root / name

    def has(self, content_hash: Any) -> bool:
        """库内是否有该歌的 aligned 歌词。"""
        path = self.path_for(content_hash)
        return bool(path is not None and path.is_file())

    def entries(self) -> list[AlignedLyricsEntry]:
        """库内全部条目（文件名即 `content_hash`；非法命名一律跳过，按 hash 升序）。

        `file_hash` = 歌词文件自身 SHA-256（**只用于内容比对**，§15.2）；
        `song_relative_path` = 由指纹表反查的本端曲目（单端引用信息，不参与对账）。
        """
        directory = self.root
        if not directory.is_dir():
            return []
        out: list[AlignedLyricsEntry] = []
        for path in sorted(directory.glob(f"*.{LYRICS_EXTENSION}")):
            if not path.is_file() or path.name.startswith("."):
                continue
            stem = path.name[: -(len(LYRICS_EXTENSION) + 1)]
            if not is_valid_content_hash(stem):
                continue
            try:
                stat_info = os.stat(path)
            except OSError:
                continue
            row = db.track_fingerprint_by_hash(stem)
            out.append(
                AlignedLyricsEntry(
                    content_hash=stem,
                    path=path,
                    size=int(stat_info.st_size),
                    mtime_ms=int(stat_info.st_mtime * 1000),
                    file_hash=_sha256_file(path),
                    song_relative_path=(row or {}).get("relative_path"),
                )
            )
        return out

    def save(self, content_hash: Any, data: bytes) -> AlignedLyricsEntry | None:
        """本地产物落库（桌面 AI 对齐等**本地生成**路径用；同步通道不调用它）。

        原子写（tmp + rename）：中途失败不会留下半个文件；hash 非法 → None。
        """
        target = self.path_for(content_hash)
        if target is None:
            return None
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=str(target.parent), prefix=f".{target.name}.", suffix=".tmp", delete=False
            ) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
                temp_name = handle.name
            os.replace(temp_name, target)
            stat_info = os.stat(target)
        except OSError:
            logger.warning("lansync aligned 歌词写入失败：%s", target, exc_info=True)
            return None
        return AlignedLyricsEntry(
            content_hash=str(content_hash),
            path=target,
            size=int(stat_info.st_size),
            mtime_ms=int(stat_info.st_mtime * 1000),
            file_hash=hashlib.sha256(data).hexdigest(),
        )

    def install(self, source: Any, content_hash: Any) -> AlignedLyricsEntry | None:
        """接收侧安装：把收到的临时文件装进歌词库（原子替换；失败 = None）。

        **不删本端文件、不写孤儿**：只有拿到合法 hash 才落盘（§15.4 同一取向）。
        """
        target = self.path_for(content_hash)
        if target is None or not Path(source).is_file():
            return None
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(str(source), target)
            stat_info = os.stat(target)
        except OSError:
            logger.warning("lansync aligned 歌词安装失败：%s", target, exc_info=True)
            return None
        return AlignedLyricsEntry(
            content_hash=str(content_hash),
            path=target,
            size=int(stat_info.st_size),
            mtime_ms=int(stat_info.st_mtime * 1000),
            file_hash=_sha256_file(target),
        )


def _sha256_file(path: Path) -> str | None:
    """文件字节 SHA-256（读失败 = None = 「内容未知」，对账侧按保守处理）。"""
    try:
        digest = hashlib.sha256()
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


# ============ manifest 条目（§15.3） ============
def manifest_entries(
    *,
    store: AlignedLyricsStore | None = None,
    song_paths: Sequence[Any] | None = None,
    root: Any = None,
) -> list[ManifestEntry]:
    """aligned 歌词 → manifest 条目（按 `relativePath` 升序，确定性）。

    - 路径 = `@lyrics/{歌曲 content_hash}.json`；条目 `contentHash` = **歌词文件自身**
      的 SHA-256（内容比对用；算不出留 nil = 「内容未知」）；
    - `stableId` = 本端歌曲相对路径（单端引用信息，不参与对账；反查不到则省略）；
    - `song_paths` 非 None 时只取这些**本轮传输的歌**的歌词（「跟歌走」用）；
      这些歌拿不到指纹 → 跳过（没有跨端身份键就没法对账，宁可不同步）。
    """
    lyrics_store = store if store is not None else AlignedLyricsStore(root)
    entries = lyrics_store.entries()
    if song_paths is not None:
        wanted: set[str] = set()
        for raw in song_paths:
            normalized = normalize_relative_path(raw)
            if normalized is None:
                continue
            digest = _content_hash_of_song(normalized, root=root)
            if digest:
                wanted.add(digest)  # 拿不到指纹 → 该歌的歌词跳过（没有跨端身份键）
        entries = [entry for entry in entries if entry.content_hash in wanted]
    return [
        ManifestEntry(
            relative_path=entry.wire_path,
            size=entry.size,
            mtime_ms=entry.mtime_ms,
            content_hash=entry.file_hash,
            stable_id=entry.song_relative_path,
        )
        for entry in sorted(entries, key=lambda item: item.wire_path)
    ]


def _content_hash_of_song(relative_path: str, *, root: Any = None) -> str | None:
    """本端曲目相对路径 → `content_hash`（指纹缺失时现算并落库）。"""
    from .locallib import ensure_content_hash

    return ensure_content_hash(relative_path, root=root)


def entries_for_songs(
    song_paths: Sequence[Any], *, store: AlignedLyricsStore | None = None, root: Any = None
) -> list[ManifestEntry]:
    """只取这些歌的 aligned 歌词条目（「跟歌走」入口；等价 `manifest_entries(song_paths=…)`）"""
    return manifest_entries(store=store, song_paths=song_paths, root=root)


# ============ 取文件解析（应答侧：`@lyrics/` 只解析到歌词根，§15.3 根表） ============
def resolve_lyrics_file(
    relative_path: Any, *, store: AlignedLyricsStore | None = None, root: Any = None
) -> FileResolution:
    """歌词 wire 路径 → 歌词库内绝对路径（**四道闸与曲库取文件同口径**）。

    ① 路径规范化（拒空 / 绝对路径 / `..`）；② 必须是 `@lyrics/{hash}.json` 单层形态；
    ③ 根内包含性 + 软链消解后仍在根内；④ 存在且是常规文件。
    """
    lyrics_store = store if store is not None else AlignedLyricsStore(root)
    normalized = normalize_relative_path(relative_path)
    if normalized is None or not is_lyrics_path(normalized):
        return FileResolution(None, REASON_INVALID_PATH)
    digest = song_content_hash(normalized)
    if digest is None:
        return FileResolution(None, REASON_INVALID_PATH)
    target = lyrics_store.path_for(digest)
    if target is None:
        return FileResolution(None, REASON_INVALID_PATH)
    base = lyrics_store.root
    if not _within(target, base):
        return FileResolution(None, REASON_OUT_OF_ROOT)
    if not target.exists():
        return FileResolution(None, REASON_NOT_FOUND)
    if not target.is_file():
        return FileResolution(None, REASON_NOT_REGULAR_FILE)
    if not _within(Path(os.path.realpath(target)), Path(os.path.realpath(base))):
        return FileResolution(None, REASON_OUT_OF_ROOT)
    return FileResolution(target)


def _within(path: Path, base: Path) -> bool:
    """`path` 是否等于 `base` 或在 `base` 之下（纯路径数学，不解析软链）。"""
    target = os.path.abspath(str(path))
    root = os.path.abspath(str(base))
    return target == root or target.startswith(root.rstrip(os.sep) + os.sep)


# ============ 接收安装编排（§15.4；与 Swift `SyncLyricsReceiver` 同构） ============
@dataclass(frozen=True, slots=True)
class ReceiveOutcome:
    """一次接收 / 重试的结论。"""

    kind: str  #: installed / pending / discarded / failed
    wire_path: str


class LyricsReceiver:
    """接收到的 aligned 歌词安装编排（**不传播删除**：本类没有删除本端歌词的路径）。

    - 本端歌曲还没入库（同一轮里歌比歌词先到 / 后到）→ 先**暂存**，收尾时再试一次映射；
      仍解析不出 → **丢弃**（歌词是依附歌曲的内容，不留孤儿），下次同步从对端 manifest
      重新拉到（自愈），不引入第二套挂起队列；
    - 收尾之后再到的歌词：不暂存，直接「映射得到就装、映射不到就丢」。
    """

    def __init__(self, store: AlignedLyricsStore | None = None, *, root: Any = None) -> None:
        self._store = store if store is not None else AlignedLyricsStore(root)
        self._pending: list[tuple[str, Path]] = []
        self._finalized = False

    @property
    def store(self) -> AlignedLyricsStore:
        """歌词库（唯一入口）。"""
        return self._store

    @property
    def is_finalized(self) -> bool:
        """是否已收尾（收尾后到的歌词不再暂存）。"""
        return self._finalized

    @property
    def pending_count(self) -> int:
        """当前暂存条数。"""
        return len(self._pending)

    def receive(self, temp_path: Any, wire_path_value: Any) -> ReceiveOutcome:
        """收到一个歌词文件（临时文件路径 + 它的 wire 路径）。"""
        normalized = normalize_relative_path(wire_path_value) or str(wire_path_value)
        return self._install(Path(temp_path), normalized)

    def receive_bytes(self, data: bytes, wire_path_value: Any) -> ReceiveOutcome:
        """收到歌词**字节**（落临时文件后安装；网络/文件两条路径共用同一编排）。"""
        normalized = normalize_relative_path(wire_path_value) or str(wire_path_value)
        directory = self._store.root
        temp_path: Path | None = None
        try:
            directory.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                dir=str(directory), prefix=".incoming-", suffix=".tmp", delete=False
            ) as handle:
                handle.write(data)
                temp_path = Path(handle.name)
        except OSError:
            return ReceiveOutcome("failed", normalized)
        return self._install(temp_path, normalized)

    def flush_pending(self) -> list[ReceiveOutcome]:
        """轮次收尾：暂存歌词再试一次映射，仍不行则丢弃（本类型进入终态）。"""
        self._finalized = True
        items, self._pending = self._pending, []
        outcomes: list[ReceiveOutcome] = []
        for wire_path_value, temp_path in items:
            outcome = self._install(temp_path, wire_path_value, finalizing=True)
            outcomes.append(outcome)
        return outcomes

    def cancel(self) -> None:
        """丢弃所有暂存临时文件（会话关闭 / 服务停止；已落库的歌词不受影响）。"""
        items, self._pending = self._pending, []
        for _wire_path_value, temp_path in items:
            try:
                temp_path.unlink(missing_ok=True)
            except OSError:
                logger.debug("lansync 清理暂存歌词失败：%s", temp_path, exc_info=True)

    # ---- 单次安装尝试 ----
    def _install(
        self, temp_path: Path, wire_path_value: str, *, finalizing: bool = False
    ) -> ReceiveOutcome:
        """安装一次：映射得到 → 装；映射不到 → 暂存（或收尾时丢弃）；失败 → 清理临时文件。"""
        digest = song_content_hash(wire_path_value)
        if digest is None:
            _unlink(temp_path)
            return ReceiveOutcome("discarded", wire_path_value)
        if not self._has_local_song(digest):
            if finalizing or self._finalized:
                _unlink(temp_path)  # 不留孤儿：下次同步从对端 manifest 重新拉到（自愈）
                return ReceiveOutcome("discarded", wire_path_value)
            self._pending.append((wire_path_value, temp_path))
            return ReceiveOutcome("pending", wire_path_value)
        installed = self._store.install(temp_path, digest)
        if installed is None:
            _unlink(temp_path)
            return ReceiveOutcome("failed", wire_path_value)
        return ReceiveOutcome("installed", wire_path_value)

    @staticmethod
    def _has_local_song(content_hash: str) -> bool:
        """本端是否已有这首歌（指纹表反查；歌词依附歌曲，没歌不落库）。"""
        return db.track_fingerprint_by_hash(content_hash) is not None


def _unlink(path: Path) -> None:
    """删临时文件（失败只记 debug：清理不影响主流程）。"""
    try:
        path.unlink(missing_ok=True)
    except OSError:  # pragma: no cover - 极少见
        logger.debug("lansync 临时歌词清理失败：%s", path, exc_info=True)


# ============ 推送（帧 14 声明 + 4/5/6 停等；§15.3 / §16.1 流程 A） ============
class LyricsPushState(str, Enum):
    """歌词推送状态。"""

    IDLE = "idle"
    SENDING = "sending"
    DONE = "done"
    FAILED = "failed"


@dataclass
class _PendingLyric:
    """一条待发歌词（声明条目 + 本地绝对路径）。"""

    entry: Any
    path: Path


class LyricsPushRun:
    """aligned 歌词随歌推送（**独立于曲库推送链**，不改变 S3a 既有语义）。

    流程：`song_paths` → 取这些歌的 aligned 歌词条目 → 帧 14 声明（`fileID` = 歌曲
    `content_hash`，§15.3）→ 逐文件停等 4/5/6（`file_ack` 是唯一送达凭据）。
    无歌词可发 = **不发帧**（不产生空批次噪音）。
    """

    def __init__(
        self,
        session: Any,
        *,
        store: AlignedLyricsStore | None = None,
        root: Any = None,
        ack_timeout: float = DEFAULT_ACK_TIMEOUT,
        on_event: Callable[[dict[str, Any]], None] | None = None,
    ) -> None:
        self._session = session
        self._store = store if store is not None else AlignedLyricsStore(root)
        self._root = root
        self._ack_timeout = float(ack_timeout)
        self._on_event = on_event
        self.run_id = uuid.uuid4().hex
        self._state = LyricsPushState.IDLE
        self._error: str | None = None
        self._queue: list[_PendingLyric] = []
        self._sender: FileSender | None = None
        self._current: _PendingLyric | None = None
        self._announced: list[str] = []
        self._completed: list[str] = []
        self._failed: list[dict[str, str]] = []
        self._sent_bytes = 0
        self._total_bytes = 0
        self._pumping = False

    # ---- 只读 ----
    @property
    def state(self) -> LyricsPushState:
        """当前状态。"""
        return self._state

    @property
    def is_terminal(self) -> bool:
        """是否终态。"""
        return self._state in (LyricsPushState.DONE, LyricsPushState.FAILED)

    @property
    def is_awaiting_ack(self) -> bool:
        """是否在等 `file_ack`（调用方按此挂 / 摘超时定时器）。"""
        sender = self._sender
        return bool(sender is not None and sender.is_active and sender.is_awaiting_ack)

    @property
    def ack_timeout(self) -> float:
        """本运行的 ack 超时秒数。"""
        return self._ack_timeout

    @property
    def session_id(self) -> str | None:
        """会话 ID（服务层路由帧用）。"""
        return getattr(self._session, "session_id", None)

    def status(self) -> dict[str, Any]:
        """状态 / 账目（事件与 `data_sync_status` 共用）。"""
        payload: dict[str, Any] = {
            "run_id": self.run_id,
            "kind": "lyrics_push",
            "state": self._state.value,
            "planned": list(self._announced),
            "completed": list(self._completed),
            "failed": [dict(item) for item in self._failed],
            "sentBytes": self._sent_bytes,
            "totalBytes": self._total_bytes,
        }
        if self._error:
            payload["error"] = self._error
        return payload

    # ---- 起手 ----
    def start(self, song_paths: Sequence[Any]) -> None:
        """取这些歌的 aligned 歌词并开始推送（无歌词 = 直接终态、不发帧）。"""
        if self._state is not LyricsPushState.IDLE:
            return
        entries = entries_for_songs(song_paths, store=self._store, root=self._root)
        pending: list[_PendingLyric] = []
        for entry in entries:
            resolution = resolve_lyrics_file(entry.relative_path, store=self._store)
            if not resolution.ok or resolution.path is None:
                self._failed.append(
                    {"path": entry.relative_path, "reason": "local_file_unavailable"}
                )
                continue
            built = make_push_entry(
                entry.relative_path,
                file_id=(song_content_hash(entry.relative_path) or ""),
                sha256_hex=entry.content_hash or "",
                size=entry.size,
            )
            if built is None:
                self._failed.append({"path": entry.relative_path, "reason": "invalid_entry"})
                continue
            pending.append(_PendingLyric(entry=built, path=resolution.path))
        if not pending:
            self._state = LyricsPushState.DONE
            self._emit()
            return
        announce = normalize_announce_entries([item.entry for item in pending])
        if not announce:
            self._state = LyricsPushState.DONE
            self._emit()
            return
        announced = {item.relative_path for item in announce}
        self._queue = [item for item in pending if item.entry.relative_path in announced]
        self._announced = [item.relative_path for item in announce]
        self._total_bytes = sum(max(0, item.size) for item in announce)
        try:
            from .push_models import encode_push_announce

            self._session.send_application_frame(
                FrameType.LIBRARY_PUSH_ANNOUNCE, encode_push_announce(announce)
            )
        except Exception as error:  # noqa: BLE001 - 声明发不出去 = 本次歌词推送失败
            self._fail(f"发送歌词推送声明失败：{error}")
            return
        self._state = LyricsPushState.SENDING
        self._emit()
        self._pump()

    # ---- 帧 6（file_ack） ----
    def handle_application_frame(self, frame_type: int, payload: bytes) -> bool:
        """把 `file_ack` 交给在途发送端；非本运行的 ack 不消费（返回 False）。"""
        if frame_type != FrameType.FILE_ACK:
            return False
        sender = self._sender
        if sender is None or not sender.is_active:
            return False
        try:
            ack = decode_file_ack(payload)
        except FileTransferError:
            sender.handle_frame(FrameType.FILE_ACK, payload)  # → 协议违例终态
            return True
        if ack.file_id != sender.file_id:
            return False
        sender.handle_frame(FrameType.FILE_ACK, payload)
        return True

    def handle_ack_timeout(self) -> bool:
        """ack 超时：该文件落失败，队列照常推进（返回是否有在途等待被终结）。"""
        sender = self._sender
        if sender is None or not sender.is_active:
            return False
        sender.handle_ack_timeout()
        return True

    def handle_session_closed(self) -> None:
        """会话关闭：未终态则落失败（账目保留）。"""
        if self.is_terminal:
            return
        self._fail("会话已关闭")

    # ---- 内部推进（与 S3a 推送同一套停等节奏） ----
    def _pump(self) -> None:
        """驱动队列：给空闲的发送端喂下一个歌词；队列清空 → `done`。"""
        if self._pumping:
            return
        self._pumping = True
        try:
            while True:
                if self._state is not LyricsPushState.SENDING:
                    return
                item = self._queue.pop(0) if self._queue else None
                if item is None:
                    self._sent_bytes = self._total_bytes
                    self._state = LyricsPushState.DONE
                    self._emit()
                    return
                if not self._start_transfer(item):
                    continue
                sender = self._sender
                if sender is not None and sender.is_active:
                    self._emit()
                    return
        finally:
            self._pumping = False

    def _start_transfer(self, item: _PendingLyric) -> bool:
        """起一轮停等传输；起不来 → 记账 + False。"""
        sender = FileSender(
            item.path,
            file_id=item.entry.file_id,
            send=self._send_frame,
            display_name=item.entry.transfer_name,
            on_completion=self._handle_transfer,
        )
        self._sender = sender
        self._current = item
        try:
            meta = sender.begin()
        except FileTransferError as error:
            self._sender = None
            self._current = None
            self._failed.append(
                {"path": item.entry.relative_path, "reason": f"send_failed:{error}"}
            )
            return False
        self._emit({"path": item.entry.relative_path, "totalBytes": int(meta.total_size)})
        return True

    def _handle_transfer(self, result: Any) -> None:
        """一轮传输终态（可能在本层 `_pump` 内同步触发）。"""
        if self.is_terminal:
            return
        item = self._current
        self._sender = None
        self._current = None
        if item is not None:
            if result.ok:
                self._completed.append(item.entry.relative_path)
                self._sent_bytes += max(0, result.total_size)
            else:
                self._failed.append(
                    {
                        "path": item.entry.relative_path,
                        "reason": result.detail
                        or (result.error.value if result.error is not None else "unknown"),
                    }
                )
        self._pump()

    def _send_frame(self, frame_type: int, payload: bytes) -> None:
        """业务帧发送回调（交给会话层加密发送）。"""
        self._session.send_application_frame(frame_type, payload)

    def _fail(self, error: str) -> None:
        """落失败态（终态后调用 = 无操作）。"""
        if self.is_terminal:
            return
        self._error = error
        self._state = LyricsPushState.FAILED
        self._emit()

    def _emit(self, extra: Mapping[str, Any] | None = None) -> None:
        """广播一条事件（回调异常不影响状态机）。"""
        if self._on_event is None:
            return
        payload = self.status()
        payload.update(dict(extra or {}))
        try:
            self._on_event(payload)
        except Exception:  # noqa: BLE001
            logger.exception("lansync 歌词推送事件回调失败（run=%s）", self.run_id)


__all__ = [
    "AlignedLyricsEntry",
    "AlignedLyricsStore",
    "LyricsKind",
    "LyricsPushRun",
    "LyricsPushState",
    "LyricsReceiver",
    "ReceiveOutcome",
    "SYNCHRONIZED_KINDS",
    "entries_for_songs",
    "file_name",
    "is_lyrics_path",
    "is_valid_content_hash",
    "manifest_entries",
    "resolve_lyrics_file",
    "song_content_hash",
    "wire_path",
]
