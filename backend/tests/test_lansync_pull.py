"""局域网同步（S2）「从设备拉取」（S3b）端到端测试：真 asyncio TCP 回环 + 真读真写文件。

覆盖 `docs/lan-sync-protocol.md` §13（对端清单 15/16）+ §11（manifest 10/11、取文件
12/13）+ §10（文件帧 4/5/6）：

① 浏览分页正确（页码 / 条数 / 摘要自洽）：`total` / `hasMore` / 库摘要 / 歌单
   `trackCount` 与成员筛选一致（§13.7）；
② 拉取单曲 → 目标文件**字节一致**（sha256 比对，300 KB 真文件端到端）+ 导入本端曲库
   （指纹落库 + 重新扫描即可见）；
③ 同内容跳过（不点名、不取回）、内容不同则更新（覆盖）；
④ 对端缺文件 / 目录 / 点名越界 → 明确失败且不影响后续文件；
⑤ 进度事件与统计数字自洽（请求 / 跳过 / 完成 / 失败 + 逐块字节）；
⑥ 取消：`cancel_pull` 生效、二次取消 False、未知 run 状态为空、取消后不落位；
⑦ **不传播删除**：拉取前后本端既有文件集合只增不减。

传输层**不 mock**：TCP 是 `SyncService` 的真监听端口；设备侧用
`tests/lansync_device_peer.py` 的 `DevicePeer`（复用生产清单 / manifest / 取文件应答
实现，事实行注入 tmp 曲库），发送侧走真 `RefClient` + 生产 `SyncFetchResponder`
（真分块停等），接收侧走生产 `FileReceiver`（`.part` → 原子改名）。
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
from lansync_device_peer import DevicePeer
from lansync_ref_client import RefClient

from app import db, state
from app.lansync import crypto as lc
from app.lansync import pull as PL
from app.lansync.frame import FrameType
from app.lansync.manifest import ManifestEntry
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


# ============ 曲库 / 会话辅助 ============
def _make_library(root: Path, entries: dict[str, bytes]) -> dict[str, str]:
    """建 tmp 曲库文件；返回 `相对路径 → 文件字节 sha256`。"""
    digests: dict[str, str] = {}
    for relative, data in entries.items():
        path = root / Path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        digests[relative] = hashlib.sha256(data).hexdigest()
    return digests


def _use_library(monkeypatch, root: Path) -> None:
    """把本端曲库根指向 tmp 曲库（重扫：`_scan_cache` 按根路径缓存）。"""
    root.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(state, "LIBRARY", root)
    monkeypatch.setattr(state, "_scan_cache", None)


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


def _pull_events(service: SyncService) -> list[dict]:
    """全部 `EventType.PULL` 事件（UI 走 `events_since` 同一条通道）。"""
    _cursor, events = service.events_since(0)
    return [event for event in events if event["type"] == EventType.PULL.value]


def _preview_page(service: SyncService, request_id: int) -> dict | None:
    """指定 `request_id` 已到达的清单页事件（未到 = None）。"""
    for event in _pull_events(service):
        if event.get("action") == "preview" and event.get("requestID") == request_id:
            return event
    return None


# ============ ① 浏览分页正确 ============
async def _browse_pages(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    entries = {
        "Album/01 Song.flac": b"a" * 1000,
        "Album/02 Song.flac": b"b" * 2000,
        "Other/03 Song.mp3": b"c" * 3000,
    }
    _make_library(device, entries)
    _use_library(monkeypatch, tmp_path / "library")  # 浏览对端清单与本端曲库无关
    db.playlists_save(
        [
            {
                "id": "pl-road",
                "name": "路上听",
                "songPaths": [str(device / "Album" / "01 Song.flac")],
            }
        ]
    )
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(client, root=device)
    task = asyncio.create_task(
        peer.serve(
            timeout=3.0,
            allow_timeout=True,
            stop=lambda: len(peer.peer_library_requests) >= 4,
        )
    )
    try:
        # 第一页：2 条 / 总数 3 / 还有下一页 / 摘要恒返回
        first = service.pull_preview(peer_id, "tracks", limit=2)
        page1 = await _wait_for(lambda: _preview_page(service, first["request_id"]))
        assert page1["scope"] == "tracks"
        assert page1["total"] == 3
        assert page1["trackCount"] == 2
        assert page1["hasMore"] is True
        assert page1["libraryTrackCount"] == 3
        assert page1["librarySizeBytes"] == sum(len(data) for data in entries.values())
        assert page1["truncated"] is False
        assert page1["offset"] == 0 and page1["limit"] == 2
        assert [item["track"]["relativePath"] for item in page1["items"]] == [
            "Album/01 Song.flac",
            "Album/02 Song.flac",
        ]
        assert [item["kind"] for item in page1["items"]] == ["track", "track"]

        # 第二页：末页 hasMore=False（页码 / 条数自洽）
        second = service.pull_preview(peer_id, "tracks", offset=2, limit=2)
        page2 = await _wait_for(lambda: _preview_page(service, second["request_id"]))
        assert page2["total"] == 3 and page2["trackCount"] == 1 and page2["hasMore"] is False
        assert [item["track"]["relativePath"] for item in page2["items"]] == ["Other/03 Song.mp3"]

        # 搜索词：对端 contains 过滤、只过滤不重排
        third = service.pull_preview(peer_id, "tracks", query="02")
        page3 = await _wait_for(lambda: _preview_page(service, third["request_id"]))
        assert page3["total"] == 1
        assert [item["track"]["title"] for item in page3["items"]] == ["02 Song"]

        # 歌单 scope：条目 trackCount 与「按该 id 筛曲目」一致（§13.7 自洽纪律）
        fourth = service.pull_preview(peer_id, "playlists")
        page4 = await _wait_for(lambda: _preview_page(service, fourth["request_id"]))
        playlists = {item["playlist"]["id"]: item["playlist"] for item in page4["items"]}
        assert page4["trackCount"] == 0
        assert page4["playlistCount"] == page4["total"] == len(page4["items"])
        assert playlists["pl-road"]["name"] == "路上听"
        assert playlists["pl-road"]["trackCount"] == 1
        assert playlists["@favorites"]["trackCount"] == 0
        assert "@library" not in playlists  # 合成项不出现在对端清单里（§13.5）

        # 请求侧载荷严格按 §13.2（scope / offset / limit / query / requestID 递增）
        assert peer.peer_library_requests[0]["scope"] == "tracks"
        assert peer.peer_library_requests[0]["limit"] == 2
        assert peer.peer_library_requests[0]["offset"] == 0
        assert peer.peer_library_requests[1]["offset"] == 2
        assert peer.peer_library_requests[2]["query"] == "02"
        assert peer.peer_library_requests[3]["scope"] == "playlists"
        assert [request["requestID"] for request in peer.peer_library_requests] == [1, 2, 3, 4]
        await task
    finally:
        await client.aclose()
        await service.stop()


def test_pull_preview_pagination_and_summary_consistent(tmp_path, monkeypatch):
    """① 浏览分页：页码 / 条数 / 摘要 / 歌单 trackCount 自洽。"""
    _run(_browse_pages(tmp_path / "store", tmp_path, monkeypatch))


# ============ ② 拉取单曲：字节一致 + 入库 ============
async def _pull_single_track(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    library = tmp_path / "library"
    digests = _make_library(device, {"Album/01 Song.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(client, root=device)
    task = asyncio.create_task(peer.serve(timeout=8.0))
    try:
        run_id = service.pull_selection(peer_id, ["Album/01 Song.flac"])
        result = await task
        assert result is not None and result.is_full_success, result
        assert result.completed == ("Album/01 Song.flac",)
        await _wait_for(lambda: service.pull_status(run_id)["state"] == "done")  # 帧 13 收尾

        # 目标端字节完全一致（sha256 比对）
        landed = library / "Album" / "01 Song.flac"
        assert landed.is_file()
        assert landed.read_bytes() == BIG_BYTES
        assert hashlib.sha256(landed.read_bytes()).hexdigest() == digests["Album/01 Song.flac"]

        status = service.pull_status(run_id)
        assert status["state"] == "done"
        assert status["selection"] == {"kind": "tracks", "ids": ["Album/01 Song.flac"]}
        assert status["requested"] == ["Album/01 Song.flac"]
        assert status["completed"] == ["Album/01 Song.flac"]
        assert status["requestedCount"] == status["completedCount"] == 1
        assert status["unchangedCount"] == status["failedCount"] == 0
        assert status["receivedBytes"] == status["totalBytes"] == len(BIG_BYTES)
        assert status["rootName"] == device.name

        # 导入本端曲库事实：指纹落库 + 扫描缓存失效（下一次扫描即可见）
        fingerprint = db.track_fingerprint_get("Album/01 Song.flac")
        assert fingerprint is not None
        assert fingerprint["content_hash"] == digests["Album/01 Song.flac"]
        assert state._scan_cache is None
        from app.services import library_scan

        assert any(song["id"] == "Album/01 Song.flac" for song in library_scan.scan_library())
        # 落地目录已清空（无残留 .part）
        assert list((library / PL.INCOMING_DIR_NAME).iterdir()) == []
    finally:
        await client.aclose()
        await service.stop()


def test_pull_single_track_transfers_identical_bytes(tmp_path, monkeypatch):
    """② 拉取单曲 → 目标文件字节一致（sha256）+ 指纹落库 + 扫描可见（300 KB 真文件）。"""
    _run(_pull_single_track(tmp_path / "store", tmp_path, monkeypatch))


# ============ ③ 同内容跳过 / 内容不同更新 ============
async def _skip_and_update(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    library = tmp_path / "library"
    updated = b"u" * 4096
    _make_library(device, {"Album/01 Song.flac": BIG_BYTES, "Album/02 Song.flac": updated})
    _use_library(
        monkeypatch,
        library,
    )
    _make_library(
        library,
        {
            "Album/01 Song.flac": BIG_BYTES,  # 与本端完全一致 → 跳过
            "Album/02 Song.flac": b"old" * 100,  # 内容不同 → 更新覆盖
        },
    )
    monkeypatch.setattr(state, "_scan_cache", None)
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(client, root=device)
    task = asyncio.create_task(peer.serve(timeout=8.0))
    try:
        run_id = service.pull_selection(peer_id, ["Album/01 Song.flac", "Album/02 Song.flac"])
        result = await task
        assert result is not None and result.is_full_success, result
        # 只点名内容不同的那首（同内容不取回：帧 12 的列表里没有 01）
        assert len(peer.fetch_requests) == 1
        assert peer.fetch_requests[0].relative_paths == ("Album/02 Song.flac",)

        status = service.pull_status(run_id)
        assert status["requested"] == ["Album/02 Song.flac"]
        assert status["unchanged"] == ["Album/01 Song.flac"]
        assert status["completed"] == ["Album/02 Song.flac"]
        assert status["requestedCount"] == status["completedCount"] == status["unchangedCount"] == 1
        assert status["failedCount"] == 0
        # 更新 = 覆盖；跳过 = 原样不动
        assert (library / "Album" / "02 Song.flac").read_bytes() == updated
        assert (library / "Album" / "01 Song.flac").read_bytes() == BIG_BYTES
    finally:
        await client.aclose()
        await service.stop()


def test_pull_skips_identical_and_updates_changed(tmp_path, monkeypatch):
    """③ 同 `content_hash` 跳过（不点名）；内容不同 → 取回并覆盖更新。"""
    _run(_skip_and_update(tmp_path / "store", tmp_path, monkeypatch))


# ============ ④ 对端缺文件 / 越界 → 明确失败且不影响后续 ============
async def _failures_do_not_block(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    library = tmp_path / "library"
    _make_library(
        device,
        {"A/one.flac": BIG_BYTES, "Ghost/gone.flac": b"g" * 64, "Z/last.flac": b"z" * 512},
    )
    (device / "C" / "Dir").mkdir(parents=True, exist_ok=True)
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(
        client,
        root=device,
        extra_manifest_entries=[
            # 清单说有、实际是目录 → not_regular_file
            {"relativePath": "C/Dir", "size": 0, "mtimeMs": 0},
            # 恶意路径：主机绝不可以它为目标路径（不进请求列表、更不落盘）
            {"relativePath": "../escape.flac", "size": 10, "mtimeMs": 0},
        ],
        drop_after_manifest=["Ghost/gone.flac"],  # 应答 manifest 后消失 → not_found
    )
    task = asyncio.create_task(peer.serve(timeout=8.0))
    try:
        run_id = service.pull_selection(
            peer_id, ["A/one.flac", "Ghost/gone.flac", "C/Dir", "../escape.flac", "Z/last.flac"]
        )
        result = await task
        assert result is not None
        # 对端视角：两条失败 + 两个成功（越界路径根本没被点名）
        assert result.completed == ("A/one.flac", "Z/last.flac")
        assert {item.relative_path: item.reason for item in result.failed} == {
            "C/Dir": "not_regular_file",
            "Ghost/gone.flac": "not_found",
        }
        assert peer.fetch_requests[0].relative_paths == (
            "A/one.flac",
            "C/Dir",
            "Ghost/gone.flac",
            "Z/last.flac",
        )
        await _wait_for(lambda: service.pull_status(run_id)["state"] == "done")  # 帧 13 收尾

        # 本端视角：点名越界路径如实记账（invalid_path），失败不影响其余文件
        status = service.pull_status(run_id)
        assert status["state"] == "done"
        assert status["completed"] == ["A/one.flac", "Z/last.flac"]
        assert status["failedCount"] == 3
        assert {item["relativePath"]: item["reason"] for item in status["failed"]} == {
            "../escape.flac": "invalid_path",
            "C/Dir": "not_regular_file",
            "Ghost/gone.flac": "not_found",
        }
        assert (library / "A" / "one.flac").read_bytes() == BIG_BYTES
        assert (library / "Z" / "last.flac").read_bytes() == b"z" * 512
        assert not (tmp_path / "escape.flac").exists()  # 越界路径绝不写出根外
        assert not (library.parent / "escape.flac").exists()
    finally:
        await client.aclose()
        await service.stop()


def test_pull_failures_do_not_block_following_files(tmp_path, monkeypatch):
    """④ 对端缺文件 / 目录 / 点名越界 → 明确失败，后续文件照常送达。"""
    _run(_failures_do_not_block(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑤ 进度与统计自洽 ============
async def _progress_consistent(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    library = tmp_path / "library"
    small = b"x" * 5000
    _make_library(
        device,
        {"A/one.flac": BIG_BYTES, "B/two.mp3": small, "C/three.flac": b"c" * 700},
    )
    _use_library(monkeypatch, library)
    _make_library(library, {"C/three.flac": b"c" * 700})  # 本端已有同内容 → 跳过
    monkeypatch.setattr(state, "_scan_cache", None)
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(client, root=device)
    task = asyncio.create_task(peer.serve(timeout=8.0))
    try:
        run_id = service.pull_selection(peer_id, None)  # 全库
        result = await task
        assert result is not None and result.is_full_success, result
        await _wait_for(lambda: service.pull_status(run_id)["state"] == "done")  # 帧 13 收尾

        events = _pull_events(service)
        states = [event["state"] for event in events]
        assert states[0] == "requestingManifest"
        assert "fetching" in states
        assert states[-1] == "done"
        for event in events:  # 每条事件都带自洽账目
            assert event["run_id"] == run_id
            assert event["requestedCount"] == len(event["requested"])
            assert event["completedCount"] == len(event["completed"])
            assert event["unchangedCount"] == len(event["unchanged"])
            assert event["failedCount"] == len(event["failed"])

        # 逐块进度（停等：同一次传输内 ack 字节单调不减，且出现过「收到一部分」的中间态）
        progress = [event for event in events if event.get("action") == "progress"]
        assert progress
        by_file: dict[str, list[int]] = {}
        for event in progress:
            by_file.setdefault(event["fileID"], []).append(event["fileReceivedBytes"])
        assert len(by_file) == 2  # 两次传输各自的进度
        for values in by_file.values():
            assert values == sorted(values)
            assert values[-1] > 0
        assert any(0 < event["fileReceivedBytes"] < len(BIG_BYTES) for event in progress)
        assert all(event["error"] == "none" for event in progress)
        assert sum(1 for event in progress if event["done"]) == 2  # 每个文件一条收尾信号

        landed = [event for event in events if event.get("action") == "file"]
        assert [event["path"] for event in landed] == ["A/one.flac", "B/two.mp3"]

        status = service.pull_status(run_id)
        assert status["requested"] == ["A/one.flac", "B/two.mp3"]
        assert status["unchanged"] == ["C/three.flac"]
        assert status["completed"] == ["A/one.flac", "B/two.mp3"]
        assert status["reportedCompleted"] == ["A/one.flac", "B/two.mp3"]
        assert status["receivedBytes"] == status["totalBytes"] == len(BIG_BYTES) + len(small)
        assert status["failedCount"] == 0
        assert (library / "A" / "one.flac").read_bytes() == BIG_BYTES
        assert (library / "B" / "two.mp3").read_bytes() == small
    finally:
        await client.aclose()
        await service.stop()


def test_pull_progress_events_and_counts_consistent(tmp_path, monkeypatch):
    """⑤ 进度事件（逐块字节）与账目（请求 / 跳过 / 完成 / 失败）自洽。"""
    _run(_progress_consistent(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑥ 取消 ============
async def _cancel_pull(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    library = tmp_path / "library"
    _make_library(device, {"A/one.flac": BIG_BYTES})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(client, root=device)
    peer.pause_after_chunks = 1  # 收到第一块后扣住 ack：传输可控地停在途（取消用例）
    task = asyncio.create_task(peer.serve(timeout=2.0, allow_timeout=True))
    try:
        run_id = service.pull_selection(peer_id, None)
        # 等设备真的开始推（本端已收到一块）、且停在途
        await _wait_for(
            lambda: any(
                event.get("action") == "progress" and event.get("fileReceivedBytes", 0) > 0
                for event in _pull_events(service)
            ),
            timeout=3.0,
        )
        assert service.pull_status(run_id)["state"] == "fetching"
        assert service.cancel_pull(run_id) is True
        status = service.pull_status(run_id)
        assert status["state"] == "failed"
        assert status["error"] == PL.REASON_CANCELLED
        assert status["completed"] == []
        assert service.cancel_pull(run_id) is False  # 已终态
        assert service.pull_status("no-such-run") == {}
        with pytest.raises(PL.PullError):
            service.pull_selection("unknown-peer", None)
        with pytest.raises(PL.PullError):
            service.pull_preview("unknown-peer")
        peer.release()  # 放开 ack：设备继续推，本端已终态不再接（帧被丢弃）
        await task  # 设备侧在 ack 断流后超时退出
        assert peer.result is None
        assert not (library / "A" / "one.flac").exists()  # 取消后不落位
        staging = library / PL.INCOMING_DIR_NAME
        assert list(staging.glob("*.part")), "取消应保留 .part（可续传）"
    finally:
        await client.aclose()
        await service.stop()


def test_cancel_pull_and_unknown_run(tmp_path, monkeypatch):
    """⑥ 取消生效 / 二次取消 False / 未知 run 状态为空 / 取消后不落位。"""
    _run(_cancel_pull(tmp_path / "store", tmp_path, monkeypatch))


# ============ ⑦ 不传播删除 ============
async def _no_delete_propagation(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    device = tmp_path / "device"
    library = tmp_path / "library"
    _make_library(device, {"New/song.flac": b"n" * 2048})
    keep = {"Local/keep.flac": b"k" * 111, "Album/old.flac": b"o" * 222}
    _use_library(monkeypatch, library)
    _make_library(library, keep)
    service = await _start_service(store_dir)
    client, peer_id = await _pair(service)
    peer = DevicePeer(client, root=device)
    task = asyncio.create_task(peer.serve(timeout=8.0))
    try:
        before = {
            path.relative_to(library).as_posix(): path.read_bytes()
            for path in library.rglob("*")
            if path.is_file()
        }
        run_id = service.pull_selection(peer_id, None)  # 全库
        result = await task
        assert result is not None and result.is_full_success, result
        await _wait_for(lambda: service.pull_status(run_id)["state"] == "done")  # 帧 13 收尾

        after = {
            path.relative_to(library).as_posix(): path.read_bytes()
            for path in library.rglob("*")
            if path.is_file()
        }
        assert set(before) <= set(after)  # 只增不减（对端没有的文件绝不删）
        for relative, data in keep.items():
            assert after[relative] == data
        status = service.pull_status(run_id)
        assert status["completed"] == ["New/song.flac"]
        assert status["unchanged"] == []
        assert status["failed"] == []
        assert after["New/song.flac"] == b"n" * 2048
    finally:
        await client.aclose()
        await service.stop()


def test_pull_never_propagates_deletions(tmp_path, monkeypatch):
    """⑦ 拉取前后本端既有文件集合只增不减（不传播删除）。"""
    _run(_no_delete_propagation(tmp_path / "store", tmp_path, monkeypatch))


# ============ 纯逻辑：对账 / 载荷 / 状态字符串契约 ============
def _entry(relative: str, *, size: int = 10, content_hash: str | None = None) -> ManifestEntry:
    return ManifestEntry(relative_path=relative, size=size, mtime_ms=0, content_hash=content_hash)


def test_pull_plan_marks_missing_and_changed_only():
    """拉取方向对账：缺 → 取、同 hash → 跳过、任一侧无指纹 → 取、本端多的不动。"""
    remote = [
        _entry("a.flac", content_hash="h1"),
        _entry("b.flac", content_hash="h2"),
        _entry("c.flac"),
        _entry("d.flac", content_hash="h4"),
    ]
    local = [
        _entry("a.flac", content_hash="h1"),
        _entry("b.flac", content_hash="h9"),
        _entry("c.flac", content_hash="h3"),
        _entry("z.flac", content_hash="h1"),
    ]
    plan = PL.pull_plan(remote, local)
    assert [item.relative_path for item in plan.to_fetch] == ["b.flac", "c.flac", "d.flac"]
    assert [item.relative_path for item in plan.unchanged] == ["a.flac"]
    # 本端多出来的条目什么都不做（不传播删除）
    assert all(item.relative_path != "z.flac" for item in plan.to_fetch + plan.unchanged)
    # 点名集合过滤
    assert [item.relative_path for item in PL.pull_plan(remote, local, ["b.flac"]).to_fetch] == [
        "b.flac"
    ]
    assert [item.relative_path for item in PL.pull_plan(remote, local, ["a.flac"]).unchanged] == [
        "a.flac"
    ]
    # 对端清单里的非法路径一律丢弃（不信任对端）；同路径重复以最后一个为准
    hostile = remote + [_entry("../escape.flac", content_hash="h5"), _entry("/abs.flac")]
    assert all(
        item.relative_path not in ("../escape.flac", "/abs.flac")
        for item in PL.pull_plan(hostile, []).to_fetch
    )
    duplicated = [_entry("a.flac", content_hash="h1"), _entry("a.flac", content_hash="h2")]
    assert [item.content_hash for item in PL.pull_plan(duplicated, []).to_fetch] == ["h2"]


def test_peer_library_payload_roundtrip_and_tolerance():
    """帧 15 载荷编码（§13.2）+ 帧 16 解码（结构性错误报错、未知条目丢弃）。"""
    encoded = PL.encode_peer_library_request(
        scope="tracks", playlist_id="@favorites", query="周", offset=3, limit=20, request_id=7
    )
    assert json.loads(encoded.decode("utf-8")) == {
        "scope": "tracks",
        "playlistID": "@favorites",
        "query": "周",
        "offset": 3,
        "limit": 20,
        "requestID": 7,
    }
    assert json.loads(
        PL.encode_peer_library_request(scope="tracks", request_id=1).decode("utf-8")
    ) == {"scope": "tracks", "offset": 0, "limit": PL.DEFAULT_PAGE_LIMIT, "requestID": 1}

    payload = json.dumps(
        {
            "requestID": 7,
            "scope": "tracks",
            "total": 2,
            "hasMore": True,
            "libraryTrackCount": 9,
            "librarySizeBytes": 4096,
            "truncated": False,
            "items": [
                {
                    "kind": "track",
                    "track": {"relativePath": "A/a.flac", "title": "A", "sizeBytes": 8},
                },
                {"kind": "playlist", "playlist": {"id": "pl", "name": "歌单", "trackCount": 1}},
                {"kind": "video", "video": {"id": "v1"}},  # 未知 kind：前向兼容丢弃
                {"kind": "track", "track": {"sizeBytes": 1}},  # 缺 relativePath：丢弃
                {"kind": "playlist", "playlist": {"name": "无 id"}},  # 缺 id：丢弃
                "not-an-object",  # 非对象：丢弃
            ],
        },
        ensure_ascii=False,
    ).encode("utf-8")
    page = PL.decode_peer_library_response(payload)
    assert page.request_id == 7
    assert page.total == 2 and page.has_more is True
    assert page.library_track_count == 9 and page.library_size_bytes == 4096
    assert page.tracks[0].relative_path == "A/a.flac"
    assert page.tracks[0].title == "A"
    assert page.playlists[0].id == "pl" and page.playlists[0].track_count == 1
    assert page.item_count == 2
    items = {item["kind"]: item for item in page.to_payload()["items"]}
    assert items["track"] == {
        "kind": "track",
        "track": {"relativePath": "A/a.flac", "sizeBytes": 8, "title": "A"},
    }
    for bad in (b"[]", b'{"total": 1}', b"not json"):
        with pytest.raises(PL.PullError):
            PL.decode_peer_library_response(bad)


class _StubSession:
    """帧发送桩（浏览器纯逻辑用）。"""

    is_ready = True

    def __init__(self) -> None:
        self.sent: list[tuple[int, bytes]] = []

    def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
        self.sent.append((frame_type, payload))


def test_browser_request_ids_and_unmatched_responses():
    """浏览器：requestID 关联（不匹配丢弃）、解码失败记账、非本帧不消费。"""
    session = _StubSession()
    events: list[dict] = []
    browser = PL.PeerLibraryBrowser(session, on_event=events.append)
    first = browser.request(scope="tracks", limit=2)
    assert first == 1 and browser.pending_ids == (1,)
    assert session.sent[0][0] == FrameType.PEER_LIBRARY_REQUEST

    def _page(request_id: int) -> bytes:
        return json.dumps(
            {
                "requestID": request_id,
                "scope": "tracks",
                "total": 1,
                "items": [{"kind": "track", "track": {"relativePath": "a.flac", "sizeBytes": 1}}],
                "hasMore": False,
                "libraryTrackCount": 1,
                "librarySizeBytes": 1,
                "truncated": False,
            },
            ensure_ascii=False,
        ).encode("utf-8")

    assert browser.handle_application_frame(FrameType.PING, b"") is False
    # 无在途请求的响应（重复 / 过期）→ 丢弃 + 诊断事件
    assert browser.handle_application_frame(FrameType.PEER_LIBRARY_RESPONSE, _page(0)) is True
    assert events[-1]["action"] == "preview_unmatched"
    assert browser.latest is None and browser.pending_ids == (1,)
    # 匹配响应 → 事件带条目 / 摘要 + 在途清空
    assert browser.handle_application_frame(FrameType.PEER_LIBRARY_RESPONSE, _page(1)) is True
    assert browser.pending_ids == ()
    assert browser.latest is not None and browser.latest.request_id == 1
    assert events[-1]["action"] == "preview"
    assert events[-1]["items"][0]["track"]["relativePath"] == "a.flac"
    assert browser.page_for(1) is browser.latest
    # 解码失败：只记账、不断会话
    assert browser.handle_application_frame(FrameType.PEER_LIBRARY_RESPONSE, b"nope") is True
    assert browser.decode_failures and events[-1]["action"] == "preview_error"
    assert browser.request(scope="playlists") == 2  # requestID 自增
    browser.cancel()
    assert browser.pending_ids == ()


def test_pull_state_and_reason_strings_are_stable():
    """跨端字符串契约（Swift `SyncLibraryPullState` / `SyncFetchFailureReason` 取值）。"""
    assert [state_value.value for state_value in PL.PullState] == [
        "idle",
        "requestingManifest",
        "fetching",
        "done",
        "failed",
    ]
    assert PL.REASON_INVALID_PATH == "invalid_path"
    assert PL.REASON_NOT_FOUND == "not_found"
    assert PL.REASON_SEND_FAILED == "send_failed"
    assert PL.REASON_SESSION_CLOSED == "session_closed"
    assert PL.REASON_CANCELLED == "cancelled"
    assert PL.REASON_UNCLAIMED == "unclaimed"
    assert PL.INCOMING_DIR_NAME == ".sync-incoming"
