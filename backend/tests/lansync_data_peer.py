"""**测试专用**设备侧参考实现（S4 播放数据同步 8/9 + 歌词随歌；不进生产包）。

对位 Swift（iOS 侧）：`SyncChangeLogPeer`（帧 8/9 处理）/ `SyncLWWReconcile`（LWW）/
`SyncChangeLogMapping`（content_hash 双向本地化）/ `SyncChangeLogDeletionPolicy`
（删除不传播）/ `SyncAlignedLyrics` + `SyncLyricsReceiver`（歌词随歌）/ 被动端的
文件接收与 manifest / 取文件应答（复用生产 `manifest` 与 `SyncFetchResponder`）。

设计取向：**独立实现**对端的语义（不复用被测的 `app.lansync.changelog`），因此
测试是「两套实现互相对账」——被测实现自说自话不会被掩盖。对端只实现测试需要的部分：

- 自有 outbox（本地形态行键 = 它的 stableId）/ 自有曲目表（stableId ↔ content_hash）；
- 帧 8 → 取增量回帧 9（过滤 delete + 填 contentHash）；帧 9 → 拦截 delete → 本地化
  （缺歌挂起）→ LWW → 落「业务状态」→ 推进自己的拉取游标；
- 帧 10/11 → 曲库 + 歌词 manifest（用它自己的 root）；帧 12/13 + 4/5/6 → 复用生产
  `SyncFetchResponder`（越界拒读等安全口径由生产代码保证）；
- 帧 14 + 4/5 → 认领落位（复用生产 `decode_push_announce` + `FileReceiver`），
  `@lyrics/...` 条目装进它的歌词库。

用法与 `tests/lansync_device_peer.py` / `tests/test_lansync_push.py` 同形：
配对后 `serve()` 驱动，`timeout` / `allow_timeout` / `stop` 控制收工。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import Callable, Sequence
from pathlib import Path
from typing import Any

from app.lansync import fetch_responder as FR
from app.lansync import manifest as MF
from app.lansync import push_models as PM
from app.lansync.filetransfer import FileReceiver, FileTransferResult
from app.lansync.frame import FrameType
from app.lansync.locallib import normalize_relative_path

#: 认可的音频扩展名（决定设备曲库里有几个「曲目」）
AUDIO_EXTENSIONS = (".flac", ".mp3", ".m4a", ".wav", ".aac", ".ogg", ".opus")
#: 歌词命名空间（对端侧独立实现，不 import 被测模块）
LYRICS_PREFIX = "@lyrics/"


def now_ms() -> int:
    """当前毫秒（测试造时间戳用）。"""
    return int(time.time() * 1000)


class DataSyncPeer:
    """设备侧参考实现（帧 8/9 + 歌词随歌；一个会话一个实例）。"""

    def __init__(
        self,
        client: Any,
        *,
        root: Path,
        lyrics: dict[str, bytes] | None = None,
        library: dict[str, bytes] | None = None,
        incoming_dir: Path | None = None,
    ) -> None:
        """`root` = 设备曲库根；`lyrics` = `歌曲 content_hash → 歌词字节`（它的 aligned 库）。

        `library` = 设备曲库文件（相对路径 → 字节），写入 `root`（取文件 / manifest 用）。
        """
        self.client = client
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        for relative, data in (library or {}).items():
            target = self.root / Path(relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        self.lyrics: dict[str, bytes] = dict(lyrics or {})
        for digest, data in self.lyrics.items():
            # 对端的 aligned 歌词也**物理落在它自己的歌词根**（`<root>/@lyrics/<hash>.json`）
            # —— 这样生产 `SyncFetchResponder` 的路径数学能直接服务它们（与 Swift 的
            # 「根表：`@lyrics/` → 歌词根」同语义，但测试桩不必再写一套应答）。
            self._write_lyric(digest, data)
        self.incoming = Path(incoming_dir) if incoming_dir is not None else self.root / ".incoming"
        self.incoming.mkdir(parents=True, exist_ok=True)

        # ---- 自有事实（对端本地形态） ----
        #: stableId → content_hash（它的曲目表）
        self.tracks: dict[str, str] = {}
        #: 自有 outbox（id 升序）
        self.outbox: list[dict[str, Any]] = []
        #: 已应用的远端变更（(entity, rowKey) → 快照）
        self.applied: dict[tuple[str, str], dict[str, Any]] = {}
        #: 他的收藏集合（stableId；断言「本端删除不跨端传播」用）
        self.favorites: set[str] = set()
        #: 他的播放历史（stableId, playedAt）→ 时长
        self.play_history: dict[tuple[str, int], int] = {}
        #: 本地缺歌挂起
        self.suspended: list[dict[str, Any]] = []
        #: 本端已消费的对端 outbox 位置（拉取游标）
        self.cursor = 0
        #: 收到的帧（到达序：断言帧序用）
        self.frames: list[int] = []
        #: 发出的帧（类型 + 载荷）
        self.sent_frames: list[tuple[int, bytes]] = []
        #: 收到的帧 9 载荷（断言 on-wire 字段用）
        self.push_payloads: list[dict[str, Any]] = []
        #: 收到的帧 14 载荷（歌词随歌声明）
        self.announce_payloads: list[bytes] = []
        self.announced: list[PM.PushEntry] = []
        self.announce_claims: list[PM.PushEntry] = []
        #: 落位的歌词（wire 路径 → 字节）
        self.landed_lyrics: dict[str, bytes] = {}
        #: 落位的曲库文件（相对路径 → 字节）
        self.landed_files: dict[str, bytes] = {}
        self._next_id = 1
        self._receiver: FileReceiver | None = None
        self._responder = FR.SyncFetchResponder(
            _ResponderSession(self), root=self.root, on_result=self._on_fetch_result
        )
        self.fetch_result: FR.FetchResult | None = None
        self.fetch_requests: list[FR.FetchRequest] = []

    # ================= 自有事实的构造（测试注入「对端状态」） =================
    def register_track(
        self, stable_id: str, content_hash: str, *, relative_path: str | None = None
    ) -> None:
        """登记一条对端曲目（stableId ↔ content_hash）。"""
        self.tracks[stable_id] = content_hash
        if relative_path is not None:
            target = self.root / Path(relative_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists() and relative_path not in self.landed_files:
                target.write_bytes(f"peer-{stable_id}".encode())

    def _write_lyric(self, digest: str, data: bytes) -> None:
        """把歌词写进对端歌词根（`<root>/@lyrics/<hash>.json`）。"""
        target = self.root / LYRICS_PREFIX / f"{digest}.json"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def content_hash_of(self, stable_id: str) -> str | None:
        """stableId → content_hash。"""
        return self.tracks.get(stable_id)

    def stable_id_of(self, content_hash: str) -> str | None:
        """content_hash → stableId（同 hash 多行取先登记者）。"""
        for stable_id, digest in self.tracks.items():
            if digest == content_hash:
                return stable_id
        return None

    def add_favorite(self, stable_id: str, *, at_ms: int | None = None) -> int:
        """对端「收藏」一次（落它的 outbox + 业务状态），返回 outbox id。"""
        self.favorites.add(stable_id)
        return self._record("favorite", stable_id, "upsert", at_ms, {"track_stable_id": stable_id})

    def remove_favorite(self, stable_id: str, *, at_ms: int | None = None) -> int:
        """对端「取消收藏」（本端 delete 只本地生效，**不上线**）。"""
        self.favorites.discard(stable_id)
        return self._record("favorite", stable_id, "delete", at_ms, None)

    def add_play_history(self, stable_id: str, played_at: int, duration_ms: int) -> int:
        """对端播放历史一行。"""
        self.play_history[(stable_id, played_at)] = duration_ms
        return self._record(
            "play_history",
            f"{stable_id}|{played_at}",
            "upsert",
            played_at,
            {
                "track_stable_id": stable_id,
                "played_at": played_at,
                "play_duration_ms": duration_ms,
            },
        )

    def _record(
        self,
        entity: str,
        row_key: str,
        op: str,
        at_ms: int | None,
        payload: dict[str, Any] | None,
    ) -> int:
        """落一行它自己的 outbox（id 自增；内容形态与线上一致）。"""
        row_id = self._next_id
        self._next_id += 1
        self.outbox.append(
            {
                "id": row_id,
                "entity": entity,
                "rowKey": row_key,
                "op": op,
                "updatedAtMs": int(at_ms if at_ms is not None else now_ms()),
                "contentHash": self._reference_content_hash(entity, row_key, payload),
                "payloadJSON": (
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
                    if payload is not None
                    else None
                ),
            }
        )
        return row_id

    def _reference_content_hash(
        self, entity: str, row_key: str, payload: dict[str, Any] | None
    ) -> str | None:
        """行内歌曲引用 → content_hash（favorite 取行键；播放历史取复合键左段）。"""
        if entity == "playlist":
            return None
        if entity == "favorite":
            return self.content_hash_of(row_key)
        if entity == "play_history":
            stable_id = row_key.rsplit("|", 1)[0]
            return self.content_hash_of(stable_id)
        if entity == "playlist_item":
            stable_id = row_key.rsplit("|", 1)[1]
            return self.content_hash_of(stable_id)
        return None

    # ================= 线上交互（测试驱动用） =================
    def send_push(
        self, entries: Sequence[dict[str, Any]] | None = None, *, batch: int = 500
    ) -> int:
        """对端主动把自有增量推过来（帧 9）。返回发出的条目数。

        `entries=None` = 推全部 outbox（过滤 delete）；否则只推给定条目。
        """
        rows = self._transmittable(self.outbox) if entries is None else list(entries)
        last_id = max((int(row.get("id") or 0) for row in rows), default=self.cursor)
        self._send(
            FrameType.CHANGE_LOG_PUSH,
            json.dumps(
                {"entries": rows, "lastOutboxID": last_id},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
        )
        return len(rows)

    def send_pull_response(self, cursor: int) -> int:
        """应答一次帧 8（取 `id > cursor` 的批 + 过滤 delete）。返回条目数。"""
        rows = [row for row in self._transmittable(self.outbox) if int(row["id"]) > cursor]
        last_id = int(rows[-1]["id"]) if rows else cursor
        self._send(
            FrameType.CHANGE_LOG_PUSH,
            json.dumps(
                {"entries": rows, "lastOutboxID": last_id},
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8"),
        )
        return len(rows)

    @staticmethod
    def _transmittable(rows: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
        """发送侧过滤：delete 不上线 + 同键末行是 delete 时其更早 upsert 也不上线。"""
        ordered = sorted(rows, key=lambda row: int(row["id"]))
        last_index: dict[str, int] = {}
        for index, row in enumerate(ordered):
            last_index[f"{row['entity']}\u001f{row['rowKey']}"] = index
        out: list[dict[str, Any]] = []
        for row in ordered:
            if row["op"] == "delete":
                continue
            tail = ordered[last_index[f"{row['entity']}\u001f{row['rowKey']}"]]
            if tail["op"] == "delete":
                continue
            out.append(row)
        return out

    # ================= 帧分发 =================
    def _send(self, frame_type: int, payload: bytes = b"") -> None:
        self.sent_frames.append((int(frame_type), payload))
        self.client.send_application_frame(frame_type, payload)

    def _dispatch(self, frame_type: int, payload: bytes) -> None:
        self.frames.append(int(frame_type))
        if frame_type == FrameType.CHANGE_LOG_PULL:
            cursor = json.loads(payload.decode("utf-8")).get("cursor") if payload else 0
            self.send_pull_response(int(cursor or 0))
            return
        if frame_type == FrameType.CHANGE_LOG_PUSH:
            self._handle_push(payload)
            return
        if frame_type == FrameType.MANIFEST_REQUEST:
            self._send(FrameType.MANIFEST_RESPONSE, self.manifest_bytes())
            return
        if frame_type == FrameType.SYNC_FETCH_REQUEST:
            self.fetch_requests.append(FR.decode_fetch_request(payload))
            self._responder.handle_application_frame(frame_type, payload)
            return
        if frame_type == FrameType.FILE_ACK:
            self._responder.handle_application_frame(frame_type, payload)
            return
        if frame_type == FrameType.LIBRARY_PUSH_ANNOUNCE:
            self.announce_payloads.append(payload)
            self.announced = PM.decode_push_announce(payload)
            self.announce_claims = list(self.announced)
            return
        if frame_type in (FrameType.FILE_META, FrameType.FILE_CHUNK):
            self._file_receiver().handle_frame(frame_type, payload)
            return
        raise AssertionError(f"设备侧收到意外帧：{frame_type}")

    def _handle_push(self, payload: bytes) -> None:
        """收帧 9：拦截 delete → 本地化 → LWW → 落业务状态 → 推进游标。"""
        data = json.loads(payload.decode("utf-8"))
        self.push_payloads.append(data)
        for entry in data.get("entries") or []:
            if entry.get("op") == "delete":
                continue  # 删除不跨端传播：收到一律忽略
            localized = self._localize(entry)
            if localized is None:
                self.suspended.append(entry)
                continue
            entity, row_key, payload_json = localized
            local = self.applied.get((entity, row_key))
            local_at = int(local["updatedAtMs"]) if local else -1
            remote_at = int(entry.get("updatedAtMs") or 0)
            if (
                local is None
                or remote_at > local_at
                or (
                    remote_at == local_at
                    and entry.get("op") == "delete"
                    and (local or {}).get("op") == "upsert"
                )
            ):
                snapshot = json.loads(payload_json) if payload_json else {}
                self.applied[(entity, row_key)] = {
                    "updatedAtMs": remote_at,
                    "op": entry.get("op"),
                    "snapshot": snapshot,
                }
                self._apply_business(entity, row_key, snapshot)
        self.cursor = int(data.get("lastOutboxID") or self.cursor)

    def _apply_business(self, entity: str, row_key: str, snapshot: dict[str, Any]) -> None:
        """落到对端「业务状态」（测试断言的可见结果）。"""
        if entity == "favorite":
            self.favorites.add(row_key)
        elif entity == "play_history":
            parsed = row_key.rsplit("|", 1)
            if len(parsed) == 2:
                self.play_history[(parsed[0], int(parsed[1]))] = int(
                    snapshot.get("play_duration_ms") or 0
                )
        elif entity == "playlist":
            self.applied[("playlist_title", row_key)] = snapshot

    def _localize(self, entry: dict[str, Any]) -> tuple[str, str, str | None] | None:
        """线上 entry → 对端本端形态（`contentHash` → 它的 stableId）；缺歌 → None。"""
        entity = str(entry.get("entity") or "")
        row_key = str(entry.get("rowKey") or "")
        digest = entry.get("contentHash")
        payload_json = entry.get("payloadJSON")
        if not digest or entity == "playlist":
            return (entity, row_key, payload_json)
        stable_id = self.stable_id_of(str(digest))
        if stable_id is None:
            return None
        if entity == "favorite":
            return (entity, stable_id, payload_json)
        if entity == "play_history":
            parsed = row_key.rsplit("|", 1)
            if len(parsed) != 2:
                return (entity, row_key, payload_json)
            return (entity, f"{stable_id}|{parsed[1]}", self._rewrite(payload_json, stable_id))
        if entity == "playlist_item":
            parsed = row_key.rsplit("|", 1)
            if len(parsed) != 2:
                return (entity, row_key, payload_json)
            return (entity, f"{parsed[0]}|{stable_id}", self._rewrite(payload_json, stable_id))
        return (entity, row_key, payload_json)

    @staticmethod
    def _rewrite(payload_json: str | None, stable_id: str) -> str | None:
        """载荷里的歌曲引用改写为对端 stableId。"""
        if not payload_json:
            return payload_json
        try:
            snapshot = json.loads(payload_json)
        except ValueError:
            return payload_json
        if isinstance(snapshot, dict):
            snapshot["track_stable_id"] = stable_id
        return json.dumps(snapshot, ensure_ascii=False, separators=(",", ":"))

    # ================= manifest / 取文件 =================
    def manifest_bytes(self) -> bytes:
        """对端 manifest（帧 11）：曲库文件 + aligned 歌词条目（`@lyrics/{hash}.json`）。"""
        entries: list[dict[str, Any]] = []
        for path in sorted(self.root.rglob("*")):
            if not path.is_file() or path.name.startswith("."):
                continue
            if path.suffix.lower() not in AUDIO_EXTENSIONS:
                continue
            relative = path.relative_to(self.root).as_posix()
            data = path.read_bytes()
            entries.append(
                MF.ManifestEntry(
                    relative_path=relative,
                    size=len(data),
                    mtime_ms=int(path.stat().st_mtime * 1000),
                    content_hash=hashlib.sha256(data).hexdigest(),
                    stable_id=self.stable_id_of(hashlib.sha256(data).hexdigest()),
                ).to_payload()
            )
        for digest, data in sorted(self.lyrics.items()):
            entries.append(
                MF.ManifestEntry(
                    relative_path=f"{LYRICS_PREFIX}{digest}.json",
                    size=len(data),
                    mtime_ms=now_ms(),
                    content_hash=hashlib.sha256(data).hexdigest(),
                    stable_id=self.stable_id_of(digest),
                ).to_payload()
            )
        return json.dumps(
            {"entries": entries, "rootName": self.root.name},
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")

    def _on_fetch_result(self, result: FR.FetchResult) -> None:
        self.fetch_result = result

    def _file_receiver(self) -> FileReceiver:
        """收文件（帧 4/5/6）：落 `.incoming/`，完成后按声明认领落位。"""
        if self._receiver is None:
            self._receiver = FileReceiver(
                self.incoming, send=self._send, on_completion=self._on_received
            )
        return self._receiver

    def _on_received(self, result: FileTransferResult) -> None:
        """一轮接收终态：认领到目标相对路径（按 fileID / sha256 / 传输名），随后落位。"""
        if not result.ok or result.target_path is None:
            return
        data = Path(result.target_path).read_bytes()
        claimed = self._claim(result, data)
        if claimed is None:
            return
        if claimed.startswith(LYRICS_PREFIX):
            digest = claimed[len(LYRICS_PREFIX) :].removesuffix(".json")
            self.landed_lyrics[claimed] = data
            self.lyrics[digest] = data
            self._write_lyric(digest, data)
            return
        self.landed_files[claimed] = data
        # 落位即入库：对端此后能用 `content_hash` 本地化跟歌走来的播放数据
        self.tracks.setdefault(claimed, hashlib.sha256(data).hexdigest())

    def _claim(self, result: FileTransferResult, data: bytes) -> str | None:
        """在声明表里认领（身份优先：fileID / sha256；其余按传输名唯一匹配）。"""
        digest = hashlib.sha256(data).hexdigest()
        name = Path(result.target_path).name if result.target_path else ""
        for entry in list(self.announce_claims):
            if entry.file_id == result.file_id or entry.sha256_hex == digest:
                self.announce_claims.remove(entry)
                return entry.relative_path
        for entry in list(self.announce_claims):
            if entry.transfer_name == name:
                self.announce_claims.remove(entry)
                return entry.relative_path
        return None

    # ================= 主循环 =================
    async def serve(
        self,
        *,
        timeout: float = 8.0,
        allow_timeout: bool = False,
        stop: Callable[[], bool] | None = None,
        until: Callable[[], bool] | None = None,
    ) -> None:
        """驱动设备侧：`until` 谓词为真即收工；`stop` / 超时同样收工。"""
        deadline = time.monotonic() + timeout
        while True:
            if until is not None and until():
                return
            remaining = deadline - time.monotonic()
            if remaining <= 0 or (stop is not None and stop()):
                if allow_timeout:
                    return
                if until is not None:
                    return
                return
            try:
                frame_type, payload = await self.client.recv_application_frame(timeout=remaining)
            except Exception as error:  # noqa: BLE001 - 超时 / 对端关闭都按收工处理
                if allow_timeout or until is not None:
                    return
                raise AssertionError(f"设备侧等待幀失败：{error}") from error
            self._dispatch(frame_type, payload)


class _ResponderSession:
    """`SyncFetchResponder` 需要的会话接口适配（生产 = `HostSession`）。"""

    is_ready = True

    def __init__(self, peer: DataSyncPeer) -> None:
        self._peer = peer

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        self._peer._send(frame_type, payload)  # noqa: SLF001 - 同模块测试桩转发


def content_hash_of_bytes(data: bytes) -> str:
    """字节 SHA-256（测试造曲目指纹用）。"""
    return hashlib.sha256(data).hexdigest()


def normalize(path: str) -> str:
    """相对路径规范化（断言用）。"""
    return normalize_relative_path(path) or ""


def run(coro: Any) -> Any:
    """跑一个异步场景（本仓库未装 pytest-asyncio）。"""
    return asyncio.run(coro)
