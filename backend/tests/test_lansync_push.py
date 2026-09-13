"""局域网同步（S2）「推送到设备」（S3a）端到端测试：真 asyncio TCP 回环 + 真读真写文件。

帧序以**现役 iOS 被动端（Swift）为事实标准**（`docs/lan-sync-protocol.md` §12.2、
`QQPlayer/Sync/SyncLibraryPushController.swift`）：

    10 manifest_request → 11 manifest_response → 14 library_push_announce
    → 逐文件 4/5/6 停等（`file_ack done=true` 是唯一送达凭据）→ 队列清空收尾

**推送路径没有 12/13**（帧 12 只属拉取路径；其应答器 `fetch_responder` 由本文件最后一个
端到端用例单独验证，确保拉取链路不被破坏）。

覆盖验收点：

① 真文件字节一致（sha256 比对，300 KB 真文件）；
② 声明先于第一个 `file_meta`（且对端收到帧 14 不回任何帧 / 从不发 12）；
③ 跳过语义 = **发送端对账**（同路径同 `content_hash` → 跳过；内容不同 → 推）；
④ 取消 / ack 超时不自愈（超时后该文件失败、后续文件照常）；
⑤ 进度与统计自洽（计划 / 已发 / 跳过 / 失败 + 事件经 `events_since` 可查）；
⑥ 越界（软链逃逸）/ 缺失路径明确记账且不阻塞；另有歌单选择语义与既有转发语义。

传输层**不 mock**：TCP 是 `SyncService` 的真监听端口，设备侧用
`tests/lansync_ref_client.py` 的 `RefClient` 收发真帧，落盘用生产 `FileReceiver`。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
from pathlib import Path

import pytest
from lansync_ref_client import RefClient, RefClientError

from app import db, state
from app.lansync import crypto as lc
from app.lansync import fetch_responder as FR
from app.lansync import push as P
from app.lansync import push_models as PM
from app.lansync.filetransfer import FileReceiver, FileTransferResult
from app.lansync.frame import FrameType
from app.lansync.manifest import Collection, ManifestEntry
from app.lansync.models import EventType
from app.lansync.service import SyncService

HOST = "127.0.0.1"
#: 端到端文件（验收标准要求 ≥ 300 KB 真文件）
BIG_BYTES = os.urandom(300 * 1024)


def _run(coro):
    """跑一个异步场景（本仓库未装 pytest-asyncio）。"""
    return asyncio.run(coro)


async def _wait_for(predicate, timeout: float = 5.0, interval: float = 0.01):
    """轮询等待条件成立（返回其值），超时抛 AssertionError。"""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        await asyncio.sleep(interval)
    raise AssertionError(f"等待条件超时（最后值 {last!r}）")


# ============ 曲库 / 设备侧参考实现（测试专用，不进生产包） ============
def _make_library(root: Path, entries: dict[str, bytes]) -> dict[str, str]:
    """建 tmp 曲库文件；返回 `相对路径 → 文件字节 sha256`。"""
    digests: dict[str, str] = {}
    for rel, data in entries.items():
        path = root / Path(rel)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        digests[rel] = hashlib.sha256(data).hexdigest()
    return digests


def _manifest_payload(entries: list[dict], root_name: str = "Ref Device") -> bytes:
    """设备侧 `manifest_response`(11) 载荷（对端曲库快照）。"""
    return json.dumps(
        {"entries": entries, "rootName": root_name}, ensure_ascii=False, separators=(",", ":")
    ).encode("utf-8")


def _file_id_of(payload: bytes) -> str:
    """从 `file_meta` / `file_chunk` 帧 payload 里取 fileID（断言语料 / 静默判定）。"""
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return ""
    return str(raw.get("fileID", "")) if isinstance(raw, dict) else ""


class ClaimTable:
    """设备端认领表（对位 Swift `SyncPushClaimTable`）：传输身份 → 声明的目标相对路径。

    认领键是**传输级身份**（`fileID` 或 `sha256` 命中；同身份多条时优先传输名一致者）；
    身份认不到但该传输名在剩余条目里唯一时才按名兜底；否则不认领（不猜、不落位）。
    """

    def __init__(self, entries: list[PM.PushEntry]) -> None:
        self._remaining = list(entries)

    def claim(self, *, file_id: str, sha256_hex: str, transfer_name: str) -> str | None:
        same_identity = [
            item
            for item in self._remaining
            if (file_id and item.file_id == file_id)
            or (sha256_hex and item.sha256_hex == sha256_hex)
        ]
        if same_identity:
            chosen = next(
                (item for item in same_identity if item.transfer_name == transfer_name),
                same_identity[0],
            )
            self._remaining.remove(chosen)
            return chosen.relative_path
        same_name = [item for item in self._remaining if item.transfer_name == transfer_name]
        if len(same_name) == 1:
            self._remaining.remove(same_name[0])
            return same_name[0].relative_path
        return None

    @property
    def remaining(self) -> list[str]:
        """尚未认领的声明条目相对路径。"""
        return [item.relative_path for item in self._remaining]


class PassiveBatch:
    """设备侧一批推送的账目快照（对位 Swift `SyncLibraryPassiveSummary`）。"""

    def __init__(
        self, announced: list[str], landed: dict[str, str], failed: dict[str, str]
    ) -> None:
        self.announced = tuple(announced)
        self.landed = dict(landed)
        self.failed = dict(failed)

    @property
    def is_full_success(self) -> bool:
        """全部声明条目都已落位、无失败、无未认领条目。"""
        return not self.failed and set(self.landed) == set(self.announced)


class DevicePeer:
    """设备侧参考实现（**Swift 被动端行为**，对位 `SyncLibraryPassiveHost`）。

    - 收帧 10 → 回帧 11（本端曲库快照）；
    - 收帧 14 → 建认领表（**不回任何帧**，`SyncLibraryPassiveHost.swift:219-243`）；
    - 收帧 4/5 → 校验落盘 + 回 `file_ack`（唯一送达凭据，`SyncFileReceiver`）；
    - **从不发帧 12 / 13**（那是拉取路径的帧）。
    """

    def __init__(
        self,
        client: RefClient,
        *,
        target_dir: Path,
        remote_manifest: list[dict] | None = None,
        silent_file_ids: set[str] | None = None,
    ) -> None:
        self.client = client
        self.target_dir = Path(target_dir)
        self.target_dir.mkdir(parents=True, exist_ok=True)  # 落盘目录由应用层准备（协议外）
        self.remote_manifest = list(remote_manifest or [])
        self.manifest_requests: list[bytes] = []
        self.announce_payloads: list[bytes] = []
        self.announced: list[PM.PushEntry] = []
        self.file_frames: list[tuple[int, bytes]] = []
        self.received: list[FileTransferResult] = []
        #: 收到的帧类型（到达序，断言「声明先于 file_meta」用）
        self.frames: list[int] = []
        #: 发回的帧类型（断言「只回 ack，绝不发 12/13」用）
        self.sent_types: list[int] = []
        self.landed: dict[str, str] = {}
        self.failed: dict[str, str] = {}
        self.claims: ClaimTable | None = None
        #: 这些 fileID 的传输一律不回 ack（模拟对端卡死：验证 Host 侧 ack 超时）
        self.silent_file_ids = {str(item) for item in (silent_file_ids or set())}
        self._receiver = FileReceiver(
            self.target_dir, send=self._send, on_completion=self._on_received
        )

    # ---- 帧发送 ----
    def _send(self, frame_type: int, payload: bytes) -> None:
        self.sent_types.append(int(frame_type))
        self.client.send_application_frame(frame_type, payload)

    def batch(self) -> PassiveBatch:
        """当前账目快照。"""
        return PassiveBatch(
            [entry.relative_path for entry in self.announced], self.landed, self.failed
        )

    # ---- 落盘 / 认领 ----
    def _on_received(self, result: FileTransferResult) -> None:
        self.received.append(result)
        name = Path(result.target_path).name if result.target_path is not None else ""
        claimed = (
            self.claims.claim(
                file_id=result.file_id, sha256_hex=result.sha256_hex or "", transfer_name=name
            )
            if self.claims is not None
            else None
        )
        if claimed is None:
            return
        if result.ok and result.target_path is not None:
            self.landed[claimed] = hashlib.sha256(Path(result.target_path).read_bytes()).hexdigest()
        else:
            self.failed[claimed] = result.error.value if result.error is not None else "unknown"

    def _accounted(self) -> int:
        return len(set(self.landed) | set(self.failed))

    def _batch_complete(self) -> bool:
        return bool(self.announced) and self._accounted() >= len(self.announced)

    # ---- 主循环 ----
    async def serve(
        self,
        *,
        timeout: float = 8.0,
        idle_timeout: float | None = None,
        allow_timeout: bool = False,
    ) -> PassiveBatch | None:
        """驱动设备侧直到本批声明全部进终态（或超时 / 空闲收工）。

        `idle_timeout` = 连续无帧这么久即返回快照（推送链没有结束帧，对端无从得知
        发送端已收尾，用它给「等不到后续帧」的用例收工）；
        `allow_timeout=True` = 全程等不到任何帧时返回 None（「本来就不该有下一帧」的用例）。
        """
        deadline = time.monotonic() + timeout
        while True:
            if self._batch_complete():
                return self.batch()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None if allow_timeout else self.batch()
            window = remaining if idle_timeout is None else min(remaining, idle_timeout)
            try:
                frame_type, payload = await self.client.recv_application_frame(timeout=window)
            except RefClientError as error:
                if self._batch_complete():
                    return self.batch()
                if idle_timeout is not None:
                    return self.batch()
                if allow_timeout:
                    return None
                raise AssertionError(f"设备侧等待帧失败：{error}") from error
            self._handle(frame_type, payload)

    def _handle(self, frame_type: int, payload: bytes) -> None:
        """收一帧（Swift 被动端的帧分发：只挑 14 与 4/5）。"""
        self.frames.append(int(frame_type))
        if frame_type == FrameType.MANIFEST_REQUEST:
            self.manifest_requests.append(payload)
            self._send(FrameType.MANIFEST_RESPONSE, _manifest_payload(self.remote_manifest))
        elif frame_type == FrameType.LIBRARY_PUSH_ANNOUNCE:
            self.announce_payloads.append(payload)
            self.announced = PM.decode_push_announce(payload)
            self.claims = ClaimTable(self.announced)
            self.landed = {}
            self.failed = {}
        elif frame_type in (FrameType.FILE_META, FrameType.FILE_CHUNK):
            self.file_frames.append((frame_type, payload))
            if _file_id_of(payload) in self.silent_file_ids:
                return  # 模拟对端卡死：不回 ack（Host 侧应按 ack 超时收尾）
            self._receiver.handle_frame(frame_type, payload)
        else:  # pragma: no cover - 协议外帧：交给上层定位
            raise AssertionError(f"设备侧收到意外帧：{frame_type}")

    def meta_file_ids(self) -> list[str]:
        """收到的 `file_meta` 帧里的 fileID（断言「没重发」用）。"""
        return [
            _file_id_of(payload)
            for frame_type, payload in self.file_frames
            if frame_type == FrameType.FILE_META
        ]

    def first_file_frame_index(self) -> int:
        """第一帧文件帧（4/5）在到达序里的下标（无文件帧 → 超大值）。"""
        for index, frame_type in enumerate(self.frames):
            if frame_type in (FrameType.FILE_META, FrameType.FILE_CHUNK):
                return index
        return 10**9


# ============ 会话辅助（回环真 TCP） ============
async def _start_service(store_dir: Path, **kwargs) -> SyncService:
    """起一个只监听回环、不广播 mDNS 的服务。"""
    service = SyncService(
        store_dir=store_dir,
        device_name="Test Host",
        host=HOST,
        port=0,
        enable_mdns=False,
        **kwargs,
    )
    await service.start()
    return service


async def _pair(service: SyncService, *, name: str = "我的 iPhone") -> tuple[RefClient, str]:
    """配对一次，返回 `(客户端, peer_id)`。"""
    qr_raw = service.start_pairing()
    qr = json.loads(qr_raw["qr_payload"])
    identity = lc.Identity.generate()
    client = RefClient(
        identity=identity,
        host_device_id=service.identity_info["device_id"],
        host_public_key=base64.b64decode(qr["publicKey"]),
        session_nonce=base64.b64decode(qr["sessionNonce"]),
        display_name=name,
    )
    await client.open(HOST, service.status["port"])
    await client.read_host_hello()
    client.send_pair_request()
    pending = await _wait_for(lambda: service.pending_pairs)
    assert service.approve_pair(pending[0]["request_id"], name) is True
    response = await client.read_pair_response()
    assert response["approved"] is True
    client.establish_ready()
    return client, identity.device_id


def _use_library(monkeypatch, root: Path) -> None:
    """把服务端曲库根指向 tmp 曲库（重扫：`_scan_cache` 按根路径缓存）。"""
    monkeypatch.setattr(state, "LIBRARY", root)
    monkeypatch.setattr(state, "_scan_cache", None)


async def _push_state(service: SyncService, run_id: str, timeout: float = 6.0) -> dict:
    """等一次推送进终态，返回 `push_status`（超时抛 AssertionError）。"""
    return await _wait_for(
        lambda: (
            service.push_status(run_id)
            if service.push_status(run_id).get("state") in ("done", "failed")
            else None
        ),
        timeout=timeout,
    )


# ============ ① 单曲集推送：字节完全一致 + ② 声明先于第一个 file_meta ============
async def _push_single_track(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": ["Album/01 Song.flac"]})
        batch = await peer.serve()
        assert batch is not None and batch.is_full_success, batch.landed if batch else None
        assert batch.announced == ("Album/01 Song.flac",)

        # ② 声明先于第一个 file_meta（§12.2）；声明里逐条带传输身份
        announce_index = peer.frames.index(FrameType.LIBRARY_PUSH_ANNOUNCE)
        assert announce_index < peer.first_file_frame_index()
        assert len(peer.announce_payloads) == 1
        assert [e.relative_path for e in peer.announced] == ["Album/01 Song.flac"]
        assert peer.announced[0].transfer_name == "01 Song.flac"
        assert peer.announced[0].file_id == digests["Album/01 Song.flac"]
        assert peer.announced[0].sha256_hex == digests["Album/01 Song.flac"]

        # 推送链没有 12/13：设备端从不发；Host 端不等 12 也不发 13（否则本用例会挂死）
        assert FrameType.SYNC_FETCH_REQUEST not in peer.sent_types
        assert FrameType.SYNC_FETCH_RESULT not in peer.sent_types
        assert set(peer.sent_types) <= {int(FrameType.FILE_ACK), int(FrameType.MANIFEST_RESPONSE)}

        # ① 落盘字节 == 源文件字节（sha256 比对）
        assert batch.landed == digests
        landed = tmp_path / "device" / "01 Song.flac"
        assert landed.read_bytes() == BIG_BYTES
        assert hashlib.sha256(landed.read_bytes()).hexdigest() == digests["Album/01 Song.flac"]

        # 端到端统计自洽
        status = await _push_state(service, run_id)
        assert status["state"] == "done"
        assert status["planned"] == ["Album/01 Song.flac"]
        assert status["completed"] == ["Album/01 Song.flac"]
        assert status["plannedCount"] == status["completedCount"] == 1
        assert status["skippedCount"] == 0
        assert status["failedCount"] == 0
        assert status["sentBytes"] == status["totalBytes"] == len(BIG_BYTES)
    finally:
        await client.aclose()
        await service.stop()


def test_push_single_track_transfers_identical_bytes(tmp_path, monkeypatch):
    """① 推送单曲集 → 设备端收到字节完全一致的文件（300 KB 真文件）；② 声明先于 4/5。"""
    _run(_push_single_track(tmp_path / "store", tmp_path, monkeypatch))


# ============ ③ 跳过语义：发送端对账（同 hash 跳过 / 内容不同则推） ============
async def _push_skips_existing(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    digest = digests["Album/01 Song.flac"]
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        # 对端清单：同路径 + 同 content_hash → 发送端对账判「已一致」（Swift SyncLibraryPushPlanner）
        peer = DevicePeer(
            client,
            target_dir=tmp_path / "device",
            remote_manifest=[
                {
                    "relativePath": "Album/01 Song.flac",
                    "size": len(BIG_BYTES),
                    "mtimeMs": 0,
                    "contentHash": digest,
                }
            ],
        )
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": ["Album/01 Song.flac"]})
        assert await peer.serve(timeout=2.0, allow_timeout=True) is None  # 无声明 → 等不到后续帧

        # **不重发**：不发声明、不发任何文件帧
        assert peer.announced == []
        assert peer.announce_payloads == []
        assert peer.file_frames == []
        assert peer.meta_file_ids() == []

        status = await _push_state(service, run_id)
        assert status["state"] == "done"
        assert status["skipped"] == ["Album/01 Song.flac"]
        assert status["planned"] == []
        assert status["completedCount"] == 0
        assert status["skippedCount"] == 1
        assert status["failedCount"] == 0
    finally:
        await client.aclose()
        await service.stop()


def test_push_skips_peer_existing_same_hash(tmp_path, monkeypatch):
    """③ 对端已有同 `content_hash` 的歌 → 跳过（无声明、无 file_meta）。"""
    _run(_push_skips_existing(tmp_path / "store", tmp_path, monkeypatch))


async def _push_when_hash_differs(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        # 对端同路径但内容不同（旧版本）→ 必须重推（内容不同则更新）
        peer = DevicePeer(
            client,
            target_dir=tmp_path / "device",
            remote_manifest=[
                {
                    "relativePath": "Album/01 Song.flac",
                    "size": 10,
                    "mtimeMs": 0,
                    "contentHash": "0" * 64,
                }
            ],
        )
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": ["Album/01 Song.flac"]})
        batch = await peer.serve()
        assert batch is not None and batch.is_full_success
        assert batch.announced == ("Album/01 Song.flac",)
        assert batch.landed == digests
        status = await _push_state(service, run_id)
        assert status["completed"] == ["Album/01 Song.flac"]
        assert status["skipped"] == []
        assert status["failedCount"] == 0
    finally:
        await client.aclose()
        await service.stop()


def test_push_resends_when_content_hash_differs(tmp_path, monkeypatch):
    """③ 同路径内容不同 → 重推（对端旧版本就地更新，不传播删除）。"""
    _run(_push_when_hash_differs(tmp_path / "store", tmp_path, monkeypatch))


# ============ ④ 歌单选择：成员全部在推送集内（缺歌自动补齐） ============
async def _push_playlist(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(
        library,
        {
            "Road/a.flac": b"aaa" * 4000,
            "Road/sub/b.mp3": b"bbb" * 2000,
            "Other/c.flac": b"ccc" * 1000,
        },
    )
    _use_library(monkeypatch, library)
    # 歌单：两个成员（其中一个在子目录）；第三个文件不在歌单里
    db.playlists_save(
        [
            {
                "id": "pl-road",
                "name": "路上听",
                "songPaths": [
                    str(library / "Road" / "a.flac"),
                    str(library / "Road" / "sub" / "b.mp3"),
                ],
            }
        ]
    )
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, {"kind": "playlists", "ids": ["pl-road"]})
        batch = await peer.serve()
        assert batch is not None and batch.is_full_success, batch.landed if batch else None

        # 计划 = 歌单全部成员（缺歌自动补齐语义：目标端没有的都推）
        assert set(batch.landed) == {"Road/a.flac", "Road/sub/b.mp3"}
        assert batch.landed == {
            "Road/a.flac": digests["Road/a.flac"],
            "Road/sub/b.mp3": digests["Road/sub/b.mp3"],
        }
        status = await _push_state(service, run_id)
        assert status["planned"] == ["Road/a.flac", "Road/sub/b.mp3"]
        assert status["completed"] == ["Road/a.flac", "Road/sub/b.mp3"]
        # 非成员不推
        assert "Other/c.flac" not in status["planned"]
        assert "Other/c.flac" not in batch.landed
    finally:
        await client.aclose()
        await service.stop()


def test_push_playlist_members_complete(tmp_path, monkeypatch):
    """④ 歌单选择 → 成员全部在推送集内（含缺歌自动补齐语义），非成员不推。"""
    _run(_push_playlist(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑤ 进度事件与统计自洽 ============
async def _push_progress_events(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    big = os.urandom(300 * 1024)
    digests = _make_library(library, {"A/one.flac": big, "B/two.mp3": b"x" * 5000})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(
            client,
            target_dir=tmp_path / "device",
            remote_manifest=[
                {"relativePath": "A/one.flac", "size": len(big), "mtimeMs": 0}
            ],  # 对端无指纹 → 保守推送
        )
        run_id = service.push_selection(peer_id, None)  # 全库
        batch = await peer.serve()
        assert batch is not None and batch.is_full_success
        await _push_state(service, run_id)  # 等最后一次 file_ack 被 Host 消费（收尾事件）

        _cursor, events = service.events_since(0)
        push_events = [event for event in events if event["type"] == EventType.PUSH.value]
        assert push_events, "推送事件缺失"
        states = [event["state"] for event in push_events]
        assert states[0] == "requestingManifest"
        assert "pushing" in states
        assert states[-1] == "done"
        # 每条事件都带完整账目（数字自洽）
        for event in push_events:
            assert event["run_id"] == run_id
            assert event["plannedCount"] == len(event["planned"])
            assert event["completedCount"] == len(event["completed"])
            assert event["skippedCount"] == len(event["skipped"])
            assert event["failedCount"] == len(event["failed"])
        # 进度事件：逐条发字节 / 总字节（末条 = 全量）
        progress = [event for event in push_events if "sentBytes" in event]
        assert progress
        assert progress[-1]["sentBytes"] == progress[-1]["totalBytes"] == len(big) + 5000
        assert any(event["sentBytes"] == 0 for event in progress)
        assert any(0 < event["sentBytes"] < event["totalBytes"] for event in progress)

        status = await _push_state(service, run_id)
        assert status["planned"] == ["A/one.flac", "B/two.mp3"]
        assert status["completed"] == ["A/one.flac", "B/two.mp3"]
        assert status["plannedCount"] == status["completedCount"] == 2
        assert status["failedCount"] == status["skippedCount"] == 0
        assert status["sentBytes"] == status["totalBytes"] == len(big) + 5000
        assert status["selection"] == {"kind": "all", "ids": []}
        assert batch.landed == digests
    finally:
        await client.aclose()
        await service.stop()


def test_push_progress_events_and_counts_consistent(tmp_path, monkeypatch):
    """⑤ 进度事件（已发 / 总字节）与统计数字（计划 / 已发 / 跳过 / 失败）自洽。"""
    _run(_push_progress_events(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑥ ack 超时：该文件失败、不悬挂、后续继续 ============
async def _push_ack_timeout(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"A/silent.flac": b"a" * 4096, "B/normal.flac": b"b" * 2048})
    _use_library(monkeypatch, library)
    silent_id = digests["A/silent.flac"]  # fileID = content_hash = sha256
    service = await _start_service(store_dir, push_ack_timeout=0.2)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device", silent_file_ids={silent_id})
        started = time.monotonic()
        run_id = service.push_selection(peer_id, None)
        serve_task = asyncio.create_task(peer.serve(timeout=6.0, idle_timeout=0.4))
        status = await _push_state(service, run_id)
        elapsed = time.monotonic() - started
        await serve_task

        # 超时的那条明确失败（原因 send_failed + 超时明细），不悬挂
        assert status["state"] == "done"
        assert status["completed"] == ["B/normal.flac"]
        assert [item["relativePath"] for item in status["failed"]] == ["A/silent.flac"]
        assert status["failed"][0]["reason"] == P.REASON_SEND_FAILED
        assert "超时" in (status["failed"][0]["detail"] or "")
        assert elapsed < 6.0, f"推送未在超时后自愈（耗时 {elapsed:.1f}s）"

        # 后续文件照常送达（一个文件失败不阻塞队列），字节一致
        assert peer.landed == {"B/normal.flac": digests["B/normal.flac"]}
        assert "A/silent.flac" not in peer.landed
    finally:
        await client.aclose()
        await service.stop()


def test_push_ack_timeout_fails_file_and_continues(tmp_path, monkeypatch):
    """⑥ 对端不回 ack → 该文件失败、不悬挂，后续文件照常推送。"""
    _run(_push_ack_timeout(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑦ 取消与未知 run ============
async def _cancel_push(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"A/one.flac": b"x" * 4000})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir, push_ack_timeout=0.2)
    try:
        client, peer_id = await _pair(service)
        # 对端不回 ack：Host 停在等 ack，正好验证「在途中取消」
        peer = DevicePeer(
            client, target_dir=tmp_path / "device", silent_file_ids={digests["A/one.flac"]}
        )
        run_id = service.push_selection(peer_id, None)
        serve_task = asyncio.create_task(peer.serve(timeout=4.0, idle_timeout=0.4))
        await _wait_for(lambda: peer.announced)  # 已发声明，正处于 pushing
        assert service.cancel_push(run_id) is True
        status = service.push_status(run_id)
        assert status["state"] == "failed"
        assert status["error"] == PM.REASON_CANCELLED
        assert peer.landed == {}
        assert service.cancel_push(run_id) is False  # 已终态
        assert service.push_status("no-such-run") == {}
        with pytest.raises(P.PushError):
            service.push_selection("unknown-peer", None)
        await serve_task
    finally:
        await client.aclose()
        await service.stop()


def test_cancel_push_midflight_and_unknown_run(tmp_path, monkeypatch):
    """⑦ 在途取消生效、二次取消 False、未知 run 状态为空、未知设备报错。"""
    _run(_cancel_push(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑧ 越界 / 缺失路径：明确记账且不阻塞 ============
async def _push_out_of_root(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Good/ok.flac": b"good" * 1000})
    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"SECRET-OUTSIDE")
    (library / "Escape").mkdir(parents=True, exist_ok=True)
    (library / "Escape" / "evil.flac").symlink_to(outside)  # 软链逃逸出曲库根
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, None)  # 全库
        batch = await peer.serve()
        assert batch is not None

        # 越界条目：明确失败（本端路径解析被拒），**不进声明、不外传**
        status = await _push_state(service, run_id)
        assert status["state"] == "done"
        assert status["planned"] == ["Good/ok.flac"]
        assert status["completed"] == ["Good/ok.flac"]
        assert [item["relativePath"] for item in status["failed"]] == ["Escape/evil.flac"]
        assert status["failed"][0]["reason"] == PM.REASON_LOCAL_FILE_UNAVAILABLE
        assert "out_of_root" in (status["failed"][0]["detail"] or "")
        assert "Escape/evil.flac" not in batch.landed
        assert all(b"evil.flac" not in payload for _ft, payload in peer.file_frames)

        # 不阻塞：合法文件照样送达且字节一致
        assert batch.landed == digests
    finally:
        await client.aclose()
        await service.stop()


def test_push_out_of_root_entry_fails_without_blocking(tmp_path, monkeypatch):
    """⑧ 软链逃逸出曲库根的条目 → 明确失败（本地不可用），合法文件照常推送。"""
    _run(_push_out_of_root(tmp_path / "store", tmp_path, monkeypatch))


async def _push_missing_paths(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Good/ok.flac": b"good" * 1000})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        # 选择集里混进「磁盘上不存在」与「越界（.. 逃逸）」的路径
        run_id = service.push_selection(
            peer_id,
            {"kind": "tracks", "ids": ["Good/ok.flac", "Ghost/missing.flac", "../escape.flac"]},
        )
        batch = await peer.serve()
        assert batch is not None

        # 不存在的路径天然不进本端清单（选择集过滤语义，与 Swift 一致）→ 不进计划、不外传；
        # 越界 id 被 normalize 拒掉，同样不外传；两者都不阻塞合法文件
        status = await _push_state(service, run_id)
        assert status["state"] == "done"
        assert status["planned"] == ["Good/ok.flac"]
        assert status["completed"] == ["Good/ok.flac"]
        assert status["failedCount"] == 0
        assert batch.landed == digests
        assert all(
            b"escape" not in payload and b"missing" not in payload
            for _ft, payload in peer.file_frames
        )
    finally:
        await client.aclose()
        await service.stop()


def test_push_missing_selection_paths_do_not_block(tmp_path, monkeypatch):
    """⑧ 缺失 / 越界的选择集路径 → 不进计划、不外传，合法文件照常推送。"""
    _run(_push_missing_paths(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑨ 既有语义不变：未消费帧仍转交接入口 ============
async def _push_keeps_handler(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    _make_library(library, {"A/one.flac": b"x" * 1000})
    _use_library(monkeypatch, library)
    forwarded: list[tuple[int, bytes]] = []
    service = await _start_service(
        store_dir,
        on_application_frame=lambda session, frame_type, payload: forwarded.append(
            (frame_type, payload)
        ),
    )
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, None)
        assert await peer.serve() is not None
        # 推送链路的帧被内部消费（接入口看不到），但其它业务帧照常转发
        assert all(frame_type != FrameType.MANIFEST_RESPONSE for frame_type, _ in forwarded)
        client.send_application_frame(FrameType.PEER_LIBRARY_REQUEST, b"{}")
        await _wait_for(lambda: any(ft == FrameType.PEER_LIBRARY_REQUEST for ft, _ in forwarded))
        assert await _push_state(service, run_id)
    finally:
        await client.aclose()
        await service.stop()


def test_unconsumed_frames_still_reach_application_handler(tmp_path, monkeypatch):
    """⑨ 未被推送运行消费的业务帧仍转交 `on_application_frame`（既有语义不变）。"""
    _run(_push_keeps_handler(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑩ 拉取路径（帧 12/13）不被推送改造破坏 ============
async def _fetch_responder_end_to_end(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    results: list[FR.FetchResult] = []
    holder: dict[str, FR.SyncFetchResponder] = {}

    def on_frame(session, frame_type, payload):
        responder = holder.get("responder")
        if responder is None:
            responder = FR.SyncFetchResponder(session, on_result=results.append)
            holder["responder"] = responder
        responder.handle_application_frame(frame_type, payload)

    service = await _start_service(store_dir, on_application_frame=on_frame)
    try:
        client, _peer_id = await _pair(service)
        (tmp_path / "device").mkdir(parents=True, exist_ok=True)  # 落盘目录由应用层准备（协议外）
        receiver = FileReceiver(
            tmp_path / "device",
            send=lambda frame_type, payload: client.send_application_frame(frame_type, payload),
        )
        request = FR.FetchRequest(
            Collection.all(), ("Album/01 Song.flac", "../escape.flac", "Missing/x.flac")
        )
        client.send_application_frame(
            FrameType.SYNC_FETCH_REQUEST, FR.encode_fetch_request(request)
        )
        deadline = time.monotonic() + 8.0
        result = None
        while result is None:
            frame_type, payload = await client.recv_application_frame(
                timeout=max(0.1, deadline - time.monotonic())
            )
            if frame_type in (FrameType.FILE_META, FrameType.FILE_CHUNK):
                receiver.handle_frame(frame_type, payload)
            elif frame_type == FrameType.SYNC_FETCH_RESULT:
                result = FR.decode_fetch_result(payload)
            else:  # pragma: no cover
                raise AssertionError(f"拉取路径收到意外帧：{frame_type}")

        assert result.completed == ("Album/01 Song.flac",)
        assert {item.relative_path: item.reason for item in result.failed} == {
            "../escape.flac": "invalid_path",
            "Missing/x.flac": "not_found",
        }
        landed = tmp_path / "device" / "01 Song.flac"
        assert landed.read_bytes() == BIG_BYTES
        assert hashlib.sha256(landed.read_bytes()).hexdigest() == digests["Album/01 Song.flac"]
        assert results and results[0].completed == ("Album/01 Song.flac",)
        assert results[0].is_full_success is False
    finally:
        await client.aclose()
        await service.stop()


def test_fetch_responder_still_answers_pull_request(tmp_path, monkeypatch):
    """⑩ 拉取路径：入站帧 12 → 逐条推 4/5/6 → 帧 13 结果（越界 / 缺失明确失败）。"""
    _run(_fetch_responder_end_to_end(tmp_path / "store", tmp_path, monkeypatch))


# ============ 纯逻辑：对账 / 状态机 / 声明形态 / 载荷编解码 ============
def _entry(rel: str, *, size: int = 10, content_hash: str | None = None) -> ManifestEntry:
    return ManifestEntry(relative_path=rel, size=size, mtime_ms=0, content_hash=content_hash)


def test_push_plan_only_marks_missing_or_changed():
    """推送方向对账：缺 → 推、同 hash → 跳过、任一侧无指纹 → 推、对端多的不动。"""
    local = [
        _entry("a.flac", content_hash="h1"),
        _entry("b.flac", content_hash="h2"),
        _entry("c.flac"),
    ]
    remote = [
        _entry("a.flac", content_hash="h1"),
        _entry("b.flac", content_hash="h9"),
        _entry("c.flac", content_hash="h3"),
        _entry("z.flac", content_hash="h1"),
    ]
    plan = PM.push_plan(local, remote)
    assert [item.relative_path for item in plan.unchanged] == ["a.flac"]
    assert [item.relative_path for item in plan.to_push] == ["b.flac", "c.flac"]
    assert all(item.relative_path != "z.flac" for item in plan.to_push)  # 不传播删除


def test_push_state_machine_transitions():
    """状态机（对位 Swift `SyncLibraryPushStateMachine`）：合法迁移放行、其它一律拒绝。"""
    S = P.PushState
    assert P.can_transition(S.IDLE, S.REQUESTING_MANIFEST)
    assert P.can_transition(S.REQUESTING_MANIFEST, S.PUSHING)
    assert P.can_transition(S.REQUESTING_MANIFEST, S.DONE)  # 全部已一致：不发声明直接收尾
    assert P.can_transition(S.PUSHING, S.DONE)  # 队列清空 = 本轮收尾
    assert P.can_transition(S.PUSHING, S.FAILED)
    assert not P.can_transition(S.DONE, S.FAILED)  # 终态不再迁移
    assert not P.can_transition(S.FAILED, S.DONE)
    assert not P.can_transition(S.IDLE, S.PUSHING)  # 必须经 requestingManifest
    assert not P.can_transition(S.PUSHING, S.REQUESTING_MANIFEST)


def test_push_run_does_not_consume_pull_frames():
    """推送链不消费帧 12/13（它们是**拉取**路径的帧，属取文件应答器）。"""

    class _StubSession:
        is_ready = True

        def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
            raise AssertionError("不应发送任何帧")

    run = P.LibraryPushRun(_StubSession(), selection=Collection.all())
    assert run.handle_application_frame(FrameType.SYNC_FETCH_REQUEST, b"{}") is False
    assert run.handle_application_frame(FrameType.SYNC_FETCH_RESULT, b"{}") is False
    assert run.handle_application_frame(FrameType.FILE_ACK, b"{}") is False
    assert run.is_awaiting_ack is False


def test_push_entry_shape_rules():
    """声明条目形态：传输名 = 末段且单段合法；fileID ≤128 且无路径分隔符。"""
    entry = PM.make_push_entry("Album/01 Song.flac", file_id="h", sha256_hex="h", size=3)
    assert entry is not None and entry.transfer_name == "01 Song.flac"
    assert PM.make_push_entry("../evil.flac", file_id="h", sha256_hex="h", size=1) is None
    assert PM.make_push_entry("Album/.hidden", file_id="h", sha256_hex="h", size=1) is None
    assert PM.make_push_entry("a.flac", file_id="a/b", sha256_hex="h", size=1) is None
    assert not PM.is_valid_transfer_name("")
    assert not PM.is_valid_file_id("x" * 129)
    # 归一：升序 + 同路径去重 + 丢结构非法
    good = PM.make_push_entry("b.flac", file_id="h2", sha256_hex="h2", size=1)
    other = PM.make_push_entry("a.flac", file_id="h1", sha256_hex="h1", size=1)
    assert good is not None and other is not None
    assert [item.relative_path for item in PM.normalize_announce_entries([good, other, good])] == [
        "a.flac",
        "b.flac",
    ]


def test_fetch_payload_roundtrip_and_rejections():
    """帧 12/13 载荷编解码往返 + 非法载荷明确报错。"""
    request = FR.FetchRequest(Collection.tracks(["a.flac"]), ("a.flac",))
    decoded = FR.decode_fetch_request(FR.encode_fetch_request(request))
    assert decoded.relative_paths == ("a.flac",)
    assert decoded.collection.kind == "tracks"
    result = FR.FetchResult.make(
        completed=["b.flac"], failed=[FR.FetchFailure("../x", "invalid_path")]
    )
    decoded_result = FR.decode_fetch_result(FR.encode_fetch_result(result))
    assert decoded_result.completed == ("b.flac",)
    assert decoded_result.failed[0].relative_path == "../x"
    assert decoded_result.is_full_success is False
    with pytest.raises(FR.FetchPayloadError):
        FR.decode_fetch_request(b"[]")
    with pytest.raises(FR.FetchPayloadError):
        FR.decode_fetch_request(b'{"collection": {"kind": "nope", "ids": []}}')
    with pytest.raises(FR.FetchPayloadError):
        FR.decode_fetch_request(b'{"relativePaths": "a.flac"}')


def test_build_plan_rejects_escapes_and_missing(tmp_path):
    """解析计划：越界一律拒（`..` / 绝对路径 / 软链逃逸），缺失 → `not_found`。"""
    library = tmp_path / "library"
    _make_library(library, {"Album/01 Song.flac": b"data"})
    outside = tmp_path / "outside.flac"
    outside.write_bytes(b"secret")
    (library / "link.flac").symlink_to(outside)
    plan = FR.build_plan(
        [
            "Album/01 Song.flac",
            "./Album/01 Song.flac",
            "../outside.flac",
            "/etc/passwd",
            "Missing.flac",
            "link.flac",
            "Album",
        ],
        root=library,
    )
    assert [item.relative_path for item in plan.files] == ["Album/01 Song.flac"]  # 重复只算一次
    reasons = {item.relative_path: item.reason for item in plan.failures}
    assert reasons == {
        "../outside.flac": "invalid_path",
        "/etc/passwd": "invalid_path",
        "Missing.flac": "not_found",
        "link.flac": "out_of_root",
        "Album": "not_regular_file",
    }


def test_responder_sends_result_for_empty_and_unknown_frames():
    """应答器：空请求也回结果帧；非本模块的帧不消费（交回调用方）。"""

    class _StubSession:
        def __init__(self) -> None:
            self.sent: list[tuple[int, bytes]] = []

        def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
            self.sent.append((frame_type, payload))

    session = _StubSession()
    results: list[FR.FetchResult] = []
    responder = FR.SyncFetchResponder(session, on_result=results.append)
    assert responder.handle_application_frame(FrameType.PING, b"") is False
    assert responder.handle_application_frame(FrameType.FILE_ACK, b"{}") is False
    request = FR.FetchRequest(Collection.all(), ())
    assert responder.handle_application_frame(
        FrameType.SYNC_FETCH_REQUEST, FR.encode_fetch_request(request)
    )
    assert session.sent[0][0] == FrameType.SYNC_FETCH_RESULT
    assert results and results[0].is_full_success and results[0].completed == ()
    assert responder.is_serving is False


def test_push_state_and_failure_reason_strings_are_stable():
    """跨端字符串契约（Swift `SyncLibraryPushState` / `SyncPushFailureReason` 取值）。"""
    assert [state_.value for state_ in P.PushState] == [
        "idle",
        "requestingManifest",
        "pushing",
        "done",
        "failed",
    ]
    assert PM.REASON_LOCAL_FILE_UNAVAILABLE == "local_file_unavailable"
    assert PM.REASON_INVALID_PATH == "invalid_path"
    assert P.REASON_SEND_FAILED == "send_failed"
    assert FR.REASON_SEND_FAILED == "send_failed"
    assert FR.REASON_SESSION_CLOSED == "session_closed"
    assert PM.REASON_SESSION_CLOSED == "session_closed"
    assert FR.REASON_CANCELLED == "cancelled"
