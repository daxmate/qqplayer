"""局域网同步（S2）「推送到设备」（S3a）端到端测试：真 asyncio TCP 回环 + 真读真写文件。

覆盖 `docs/lan-sync-protocol.md` §12（推送声明 14）+ §11（按路径拉取 12/13 + 传输 4/5/6）：

① 配对成功后推送单曲集 → 设备端收到字节完全一致的文件（sha256 比对，300 KB 真文件）；
② 对端已有同 `content_hash` 的歌 → 不重发（不发声明、不发任何 `file_meta`）；
③ 歌单选择 → 成员全部在推送集内（缺歌自动补齐语义）+ 非成员不推；
④ 路径越界 / 文件缺失的取文件请求 → 明确失败（`invalid_path` / `not_found`），
   且不影响同批后续文件；
⑤ 进度事件与统计数字自洽（计划 / 已发 / 跳过 / 失败）+ 事件经 `events_since` 可查；
⑥ 既有语义不变：未被推送运行消费的业务帧仍转交 `on_application_frame` 接入口；
⑦ 取消：`cancel_push` 生效、二次取消 False、未知 run 状态为空。

传输层**不 mock**：TCP 是 `SyncService` 的真监听端口，设备侧用
`tests/lansync_ref_client.py` 的 `RefClient` 收发真帧，落盘用生产 `FileReceiver`
（写 `tmp_path` 真文件，`.part` → 原子改名）。
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
#: 端到端文件（验证标准要求 ≥ 300 KB 真文件）
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


class DevicePeer:
    """设备侧参考实现（被动端）：应答 manifest → 收声明 → 点名要文件 → 落盘收尾。"""

    def __init__(
        self,
        client: RefClient,
        *,
        target_dir: Path,
        remote_manifest: list[dict] | None = None,
    ) -> None:
        self.client = client
        self.target_dir = Path(target_dir)
        self.target_dir.mkdir(parents=True, exist_ok=True)  # 落盘目录由应用层准备（协议外）
        self.remote_manifest = list(remote_manifest or [])
        self.manifest_requests: list[bytes] = []
        self.announced: list[PM.PushEntry] = []
        self.announce_payloads: list[bytes] = []
        self.file_frames: list[tuple[int, bytes]] = []
        self.received: list[FileTransferResult] = []
        self.requested: list[str] = []
        self.result: FR.FetchResult | None = None
        self.landed: dict[str, str] = {}
        self._receiver = FileReceiver(
            self.target_dir, send=self._send_ack, on_completion=self._on_received
        )

    # ---- 帧发送 ----
    def _send_ack(self, frame_type: int, payload: bytes) -> None:
        self.client.send_application_frame(frame_type, payload)

    def send_fetch_request(self, paths: list[str]) -> None:
        self.requested = list(paths)
        request = FR.FetchRequest(Collection.all(), tuple(paths))
        self.client.send_application_frame(
            FrameType.SYNC_FETCH_REQUEST, FR.encode_fetch_request(request)
        )

    # ---- 落盘 ----
    def _on_received(self, result: FileTransferResult) -> None:
        self.received.append(result)

    # ---- 主循环 ----
    async def serve(
        self,
        *,
        timeout: float = 8.0,
        request_paths: list[str] | None = None,
        request_all_announced: bool = True,
        stop_after_announce: bool = False,
        allow_timeout: bool = False,
    ) -> FR.FetchResult | None:
        """驱动设备侧直到收到 `sync_fetch_result`（或超时 / 指定提前返回）。

        `request_paths` 显式覆盖要请求的路径（越界 / 缺失用例用）；
        `stop_after_announce=True` = 收到声明即返回（不点名要文件）；
        `allow_timeout=True` = 等不到后续帧时返回 None（「本来就没有下一帧」的用例）。
        """
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                frame_type, payload = await self.client.recv_application_frame(timeout=remaining)
            except RefClientError as error:
                if self.result is not None:
                    return self.result
                if allow_timeout:
                    return None
                raise AssertionError(f"设备侧等待帧失败：{error}") from error
            if frame_type == FrameType.MANIFEST_REQUEST:
                self.manifest_requests.append(payload)
                self.client.send_application_frame(
                    FrameType.MANIFEST_RESPONSE, _manifest_payload(self.remote_manifest)
                )
            elif frame_type == FrameType.LIBRARY_PUSH_ANNOUNCE:
                self.announce_payloads.append(payload)
                self.announced = PM.decode_push_announce(payload)
                if stop_after_announce:
                    return None
                if request_all_announced:
                    paths = (
                        list(request_paths)
                        if request_paths is not None
                        else [entry.relative_path for entry in self.announced]
                    )
                    self.send_fetch_request(paths)
            elif frame_type in (FrameType.FILE_META, FrameType.FILE_CHUNK):
                self.file_frames.append((frame_type, payload))
                self._receiver.handle_frame(frame_type, payload)
            elif frame_type == FrameType.SYNC_FETCH_RESULT:
                self.result = FR.decode_fetch_result(payload)
                self._claim_landed()
                return self.result
            else:  # pragma: no cover - 协议外帧：交给上层定位
                raise AssertionError(f"设备侧收到意外帧：{frame_type}")

    def meta_file_ids(self) -> list[str]:
        """收到的 `file_meta` 帧里的 fileID（断言「没重发」用）。"""
        return [
            _file_id_of(payload)
            for frame_type, payload in self.file_frames
            if frame_type == FrameType.FILE_META
        ]

    def _claim_landed(self) -> None:
        """按传输身份（fileID / sha256）把落盘文件认领回声明的相对路径（协议 §12.2）。"""
        by_id = {entry.file_id: entry.relative_path for entry in self.announced}
        for result in self.received:
            rel = by_id.get(result.file_id)
            if rel is None or result.target_path is None:
                continue
            self.landed[rel] = hashlib.sha256(Path(result.target_path).read_bytes()).hexdigest()


def _file_id_of(payload: bytes) -> str:
    """从 `file_meta` 帧 payload 里取 fileID（断言语料）。"""
    raw = json.loads(payload.decode("utf-8"))
    return str(raw.get("fileID", ""))


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


# ============ ① 单曲集推送：字节完全一致 ============
async def _push_single_track(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": ["Album/01 Song.flac"]})
        result = await peer.serve()
        assert result is not None
        assert result.is_full_success, result.to_payload()
        assert result.completed == ("Album/01 Song.flac",)

        # 声明先于第一个 file_meta 发出（§12.2），且声明里逐条带传输身份
        assert len(peer.announce_payloads) == 1
        assert [e.relative_path for e in peer.announced] == ["Album/01 Song.flac"]
        assert peer.announced[0].transfer_name == "01 Song.flac"
        assert peer.announced[0].file_id == digests["Album/01 Song.flac"]
        assert peer.announced[0].sha256_hex == digests["Album/01 Song.flac"]

        # 落盘字节 == 源文件字节（sha256 比对）
        assert peer.landed == digests
        landed = tmp_path / "device" / "01 Song.flac"
        assert landed.read_bytes() == BIG_BYTES
        assert hashlib.sha256(landed.read_bytes()).hexdigest() == digests["Album/01 Song.flac"]

        # 端到端统计自洽
        status = service.push_status(run_id)
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
    """① 配对成功后推送单曲集 → 设备端收到字节完全一致的文件（300 KB 真文件）。"""
    _run(_push_single_track(tmp_path / "store", tmp_path, monkeypatch))


# ============ ② 对端已有同内容 → 不重发 ============
async def _push_skips_existing(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    digest = digests["Album/01 Song.flac"]
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        # 对端清单：同路径 + 同 content_hash（含同指纹的「已有一致」条目）
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

        status = service.push_status(run_id)
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
    """② 对端已有同 content_hash 的歌 → 跳过（无声明、无 file_meta）。"""
    _run(_push_skips_existing(tmp_path / "store", tmp_path, monkeypatch))


# ============ ③ 歌单选择：成员全部在推送集内（缺歌自动补齐） ============
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
        result = await peer.serve()
        assert result is not None and result.is_full_success, result

        # 计划 = 歌单全部成员（缺歌自动补齐语义：目标端没有的都推）
        assert set(peer.landed) == {"Road/a.flac", "Road/sub/b.mp3"}
        assert peer.landed == {
            "Road/a.flac": digests["Road/a.flac"],
            "Road/sub/b.mp3": digests["Road/sub/b.mp3"],
        }
        status = service.push_status(run_id)
        assert status["planned"] == ["Road/a.flac", "Road/sub/b.mp3"]
        assert status["completed"] == ["Road/a.flac", "Road/sub/b.mp3"]
        # 非成员不推
        assert "Other/c.flac" not in status["planned"]
        assert "Other/c.flac" not in peer.landed
    finally:
        await client.aclose()
        await service.stop()


def test_push_playlist_members_complete(tmp_path, monkeypatch):
    """③ 歌单选择 → 成员全部在推送集内（含缺歌自动补齐语义），非成员不推。"""
    _run(_push_playlist(tmp_path / "store", tmp_path, monkeypatch))


# ============ ④ 越界 / 缺失路径：明确失败且不影响后续 ============
async def _push_rejects_bad_paths(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    digests = _make_library(library, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": ["Album/01 Song.flac"]})
        # 设备侧先点名两个非法 / 不存在的路径，再要真正存在的文件（顺序证明互不影响）
        result = await peer.serve(
            request_paths=["../escape.flac", "Missing/x.flac", "Album/01 Song.flac", "/etc/passwd"]
        )
        assert result is not None
        assert result.completed == ("Album/01 Song.flac",)
        reasons = {item.relative_path: item.reason for item in result.failed}
        assert reasons == {
            "../escape.flac": "invalid_path",
            "Missing/x.flac": "not_found",
            "/etc/passwd": "invalid_path",
        }
        # 失败不影响后续文件：合法文件照样送达且字节一致
        assert peer.landed == digests
        assert (
            hashlib.sha256((tmp_path / "device" / "01 Song.flac").read_bytes()).hexdigest()
            == (digests["Album/01 Song.flac"])
        )
        status = service.push_status(run_id)
        assert status["state"] == "done"
        assert status["completedCount"] == 1
        assert status["failedCount"] == 3
        assert {item["reason"] for item in status["failed"]} == {"invalid_path", "not_found"}
    finally:
        await client.aclose()
        await service.stop()


def test_push_fetch_failures_do_not_block_following_files(tmp_path, monkeypatch):
    """④ 越界 / 缺失路径 → 明确失败，且不影响同批后续文件。"""
    _run(_push_rejects_bad_paths(tmp_path / "store", tmp_path, monkeypatch))


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
        result = await peer.serve()
        assert result is not None and result.is_full_success

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

        status = service.push_status(run_id)
        assert status["planned"] == ["A/one.flac", "B/two.mp3"]
        assert status["completed"] == ["A/one.flac", "B/two.mp3"]
        assert status["plannedCount"] == status["completedCount"] == 2
        assert status["failedCount"] == status["skippedCount"] == 0
        assert status["sentBytes"] == status["totalBytes"] == len(big) + 5000
        assert status["selection"] == {"kind": "all", "ids": []}
        assert peer.landed == digests
    finally:
        await client.aclose()
        await service.stop()


def test_push_progress_events_and_counts_consistent(tmp_path, monkeypatch):
    """⑤ 进度事件（已发 / 总字节）与统计数字（计划 / 已发 / 跳过 / 失败）自洽。"""
    _run(_push_progress_events(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑥ 既有语义不变：未消费帧仍转交接入口 ============
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
        assert service.push_status(run_id)["state"] == "done"
    finally:
        await client.aclose()
        await service.stop()


def test_unconsumed_frames_still_reach_application_handler(tmp_path, monkeypatch):
    """⑥ 未被推送运行消费的业务帧仍转交 `on_application_frame`（既有语义不变）。"""
    _run(_push_keeps_handler(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑦ 取消与未知 run ============
async def _cancel_push(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    library = tmp_path / "library"
    _make_library(library, {"A/one.flac": b"x" * 4000})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DevicePeer(client, target_dir=tmp_path / "device")
        run_id = service.push_selection(peer_id, None)
        await peer.serve(stop_after_announce=True)
        assert peer.announced  # 已发声明，正处于 pushing
        assert service.cancel_push(run_id) is True
        status = service.push_status(run_id)
        assert status["state"] == "failed"
        assert status["error"] == PM.REASON_CANCELLED
        assert service.cancel_push(run_id) is False  # 已终态
        assert service.push_status("no-such-run") == {}
        with pytest.raises(P.PushError):
            service.push_selection("unknown-peer", None)
    finally:
        await client.aclose()
        await service.stop()


def test_cancel_push_and_unknown_run(tmp_path, monkeypatch):
    """⑦ `cancel_push` 生效、二次取消 False、未知 run 状态为空、未知设备报错。"""
    _run(_cancel_push(tmp_path / "store", tmp_path, monkeypatch))


# ============ 纯逻辑：对账 / 声明形态 / 载荷编解码 ============
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
    assert [state.value for state in P.PushState] == [
        "idle",
        "requestingManifest",
        "pushing",
        "done",
        "failed",
    ]
    assert PM.REASON_LOCAL_FILE_UNAVAILABLE == "local_file_unavailable"
    assert PM.REASON_INVALID_PATH == "invalid_path"
    assert FR.REASON_SEND_FAILED == "send_failed"
    assert FR.REASON_SESSION_CLOSED == "session_closed"
    assert PM.REASON_SESSION_CLOSED == "session_closed"
    assert FR.REASON_CANCELLED == "cancelled"
