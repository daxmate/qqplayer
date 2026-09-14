"""局域网同步（S2）S4「播放数据同步」（帧 8/9）测试：真 asyncio TCP 回环 + 参考对端。

帧序与语义以 Swift（`SyncChangeLogPeer` / `SyncLWWReconcile` / `SyncChangeLogMapping` /
`SyncChangeLogDeletionPolicy` / `SyncPlaybackCarryPlan`）与 `docs/lan-sync-protocol.md`
§14 为事实标准；对端 = `tests/lansync_data_peer.py` 的**独立实现**（两套实现互相对账）。

覆盖验收点（与任务包逐条对应）：

① LWW：两端同键冲突 `updated_at` 大者胜（含相等的确定性 + 平局规则）；
② 游标推进与增量（不重不漏；推送游标 / 拉取游标**分表**）；
③ 仅同步两端共有的歌（对端独有歌的播放数据不传）；
④ 不传播删除（本端取消收藏 / 删歌单 → 对端不变；对端删除 → 本端不变）；
⑤ 跟歌走（推送 / 拉取一首歌时其播放数据随行）；
⑦ 迁移幂等 + 老库数据不变。

播放数据以 **web 本端身份 = 曲库相对路径** 表达（见 `app/lansync/changelog.py` 文件头），
跨端身份 = 歌曲 `content_hash`。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path

from lansync_data_peer import DataSyncPeer, now_ms
from lansync_ref_client import RefClient

from app import db, state
from app.lansync import changelog as CL
from app.lansync import crypto as lc
from app.lansync.frame import FrameType
from app.lansync.models import EventType
from app.lansync.service import SyncService

HOST = "127.0.0.1"
SONG_A = "Album/01 A.flac"
SONG_B = "Album/02 B.flac"
SONG_BYTES = {"A": b"a" * 4096, "B": b"b" * 8192}


def _run(coro):
    """跑一个异步场景（本仓库未装 pytest-asyncio）。"""
    return asyncio.run(coro)


async def _wait_for(predicate, timeout: float = 6.0, interval: float = 0.01):
    """轮询等待条件成立（返回其值），超时抛 AssertionError。"""
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = predicate()
        if last:
            return last
        await asyncio.sleep(interval)
    raise AssertionError(f"等待条件超时（最后值 {last!r}）")


def _make_library(root: Path, entries: dict[str, bytes]) -> dict[str, str]:
    """建 tmp 曲库文件；返回 `相对路径 → 字节 sha256`。"""
    digests: dict[str, str] = {}
    for relative, data in entries.items():
        path = root / Path(relative)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        digests[relative] = hashlib.sha256(data).hexdigest()
    return digests


def _use_library(monkeypatch, root: Path) -> None:
    """把服务端曲库根指向 tmp 曲库（并清扫描缓存，兼容既有测试同款做法）。"""
    monkeypatch.setattr(state, "LIBRARY", root)
    monkeypatch.setattr(state, "_scan_cache", None)


def _abs(root: Path, relative: str) -> str:
    """曲库内相对路径 → 绝对路径字符串。"""
    return str(root / Path(relative))


def _register_fingerprint(relative: str) -> str:
    """把本端曲目指纹落库（真实链路里由 manifest / 取文件惰性计算）。

    这就是「本端已有这首歌」的事实；没有它，远端行会（正确地）被判为缺歌挂起。
    """
    from app.lansync.locallib import ensure_content_hash

    digest = ensure_content_hash(relative)
    assert digest
    return digest


def _outbox() -> list[dict]:
    """本端 outbox 全部行（outbox id 升序）。"""
    return db.sync_outbox_load()


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


# ============================================================================ 纯逻辑
def test_reconcile_rules_table():
    """① LWW 平局 / 大小规则（§14.7 四种情形，与 Swift `SyncLWWReconcile` 逐条对齐）。"""
    local = CL.ChangeLogRow(entity="favorite", row_key="a", op="upsert", updated_at_ms=100, id=1)
    newer = CL.ChangeLogRow(entity="favorite", row_key="a", op="upsert", updated_at_ms=200, id=2)
    older = CL.ChangeLogRow(entity="favorite", row_key="a", op="upsert", updated_at_ms=50, id=3)
    tie_delete = CL.ChangeLogRow(
        entity="favorite", row_key="a", op="delete", updated_at_ms=100, id=4
    )
    tie_upsert = CL.ChangeLogRow(
        entity="favorite", row_key="a", op="upsert", updated_at_ms=100, id=5
    )
    fresh = CL.ChangeLogRow(entity="favorite", row_key="b", op="upsert", updated_at_ms=1, id=6)

    # 远端更新 → 应用远端
    result = CL.reconcile([local], [newer])
    assert [row.updated_at_ms for row in result.apply_remote] == [200]
    # 远端更旧 → 本端胜（不应用）
    result = CL.reconcile([local], [older])
    assert result.apply_remote == ()
    assert [row.updated_at_ms for row in result.local_wins] == [100]
    # 平局：upsert vs upsert → 本端胜（不乒乓）
    result = CL.reconcile([local], [tie_upsert])
    assert result.apply_remote == ()
    # 平局：远端 delete vs 本端 upsert → delete 胜（显式删除意图优先）
    result = CL.reconcile([local], [tie_delete])
    assert [row.op for row in result.apply_remote] == ["delete"]
    # 远端独有的键 → 直接应用
    result = CL.reconcile([local], [fresh])
    assert [(row.entity, row.row_key) for row in result.apply_remote] == [("favorite", "b")]


def test_representative_row_picks_latest_then_highest_id():
    """同键多行的代表行 = `updated_at` 最大、平局取 id 最大（= 最新落库）。"""
    rows = [
        CL.ChangeLogRow(entity="favorite", row_key="a", op="upsert", updated_at_ms=5, id=7),
        CL.ChangeLogRow(entity="favorite", row_key="a", op="upsert", updated_at_ms=9, id=2),
        CL.ChangeLogRow(entity="favorite", row_key="a", op="upsert", updated_at_ms=9, id=3),
    ]
    assert CL.representative_of(rows).id == 3


def test_deletion_policy_suppresses_earlier_upsert_in_batch():
    """④ 发送侧批次抑制：同键末行是 delete → 该键更早的 upsert 也不上线（§14.9）。"""
    rows = [
        {"entity": "favorite", "row_key": "a", "op": "upsert"},
        {"entity": "favorite", "row_key": "a", "op": "delete"},
        {"entity": "favorite", "row_key": "b", "op": "upsert"},
    ]
    assert CL.transmittable_indexes(rows) == [2]
    # delete 本身永不上线；未知 op 不误伤
    assert CL.transmittable_indexes([{"entity": "favorite", "row_key": "a", "op": "delete"}]) == []
    assert CL.transmittable_indexes([{"entity": "favorite", "row_key": "a", "op": "weird"}]) == [0]


def test_row_key_roundtrip_and_track_reference():
    """行键形态（§14.5）：复合键按**最后一个** `|` 切；歌曲引用提取走单一事实源。"""
    assert CL.play_history_row_key("a|b.flac", 1234) == "a|b.flac|1234"
    assert CL.parse_composite_row_key("a|b.flac|1234") == ("a|b.flac", 1234)
    assert CL.parse_composite_row_key("a|b.flac") is None
    assert CL.split_row_key("pl|a.flac") == ("pl", "a.flac")
    assert CL.track_reference("playlist", "pl", None) is None
    assert CL.track_reference("favorite", "a.flac", None) == "a.flac"
    assert CL.track_reference("play_history", "a.flac|12", None) == "a.flac"
    assert CL.track_reference("playlist_item", "pl|a.flac", None) == "a.flac"
    assert (
        CL.track_reference("play_history", "|bad", json.dumps({"track_stable_id": "x.flac"}))
        == "x.flac"
    )


def test_carry_plan_only_shared_songs_and_prunes_deletes(tmp_path, monkeypatch):
    """③④ 计划器：只带两端共有的歌；delete 不进携带批（含批次抑制）。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"], SONG_B: SONG_BYTES["B"]})
    _use_library(monkeypatch, library)
    store = CL.ChangeLogStore()
    facts = CL.DatabaseFacts(store)

    db.playback_append(
        {"ts": "2026-09-14T00:00:00+00:00", "path": _abs(library, SONG_A), "duration": 3}
    )
    db.playback_append(
        {"ts": "2026-09-14T00:01:00+00:00", "path": _abs(library, SONG_B), "duration": 4}
    )
    # B 的播放数据随后被本地「删掉」（delete 留痕但不上线）
    db.sync_outbox_append(
        [
            {
                "entity": "play_history",
                "row_key": CL.play_history_row_key(SONG_B, 1),
                "op": "delete",
                "updated_at": now_ms(),
                "payload_json": None,
            }
        ]
    )

    plan = CL.carry_plan(
        direction=CL.DIRECTION_PUSH,
        transferred_paths=[SONG_A, SONG_B],
        peer_hashes={digests[SONG_A]},  # 对端只有 A
        facts=facts,
    )
    assert plan.songs and [song.relative_path for song in plan.songs] == [SONG_A]
    assert plan.skipped_not_paired == [SONG_B]
    assert {entry.content_hash for entry in plan.entries} == {digests[SONG_A]}
    assert all(entry.op == "upsert" for entry in plan.entries)
    assert all(entry.row_key.startswith(SONG_A) for entry in plan.entries)  # B 的行一律不带


def test_carry_plan_reports_unknown_and_unfingerprinted(tmp_path, monkeypatch):
    """③ 计划器跳过明细（不静默丢）：本端没有的路径 / 拿不到指纹 / 无播放数据。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    facts = CL.DatabaseFacts(CL.ChangeLogStore())
    plan = CL.carry_plan(
        direction=CL.DIRECTION_PUSH,
        transferred_paths=[SONG_A, "Album/ghost.flac", "@lyrics/x.json"],
        peer_hashes={digests[SONG_A]},
        facts=facts,
    )
    assert plan.skipped_unknown_path == ["Album/ghost.flac"]
    assert plan.lyrics_paths_ignored == ["@lyrics/x.json"]
    assert plan.skipped_no_playback_data == [SONG_A]
    assert plan.is_empty


# ============================================================== 端到端（真 TCP 回环）
async def _push_increment_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """② 推送增量：批末行 id = 游标；下一轮只发新增（不重不漏）。"""
    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device")
        db.playback_append(
            {"ts": "2026-09-14T00:00:00+00:00", "path": _abs(library, SONG_A), "duration": 1}
        )
        db.playback_append(
            {"ts": "2026-09-14T00:02:00+00:00", "path": _abs(library, SONG_A), "duration": 2}
        )
        run_id = service.data_sync_push(peer_id)
        status = await _wait_for(
            lambda: (
                service.data_sync_status(run_id)
                if service.data_sync_status(run_id)["state"] == "done"
                else None
            )
        )
        assert status["sent"]["batches"] == 1
        assert status["sent"]["rows"] == 2
        assert status["sent"]["entries"] == 2  # 都是 upsert，无 delete
        cursor_after_first = db.sync_push_cursor_get(peer_id)
        assert cursor_after_first == db.sync_outbox_max_id()
        await peer.serve(until=lambda: peer.push_payloads, timeout=5.0)
        first_batch = peer.push_payloads[0]
        assert first_batch["lastOutboxID"] == cursor_after_first
        assert {entry["entity"] for entry in first_batch["entries"]} == {"play_history"}

        # 新增一行后再推：只发新增（对端游标也是批末行 id）
        db.playback_append(
            {"ts": "2026-09-14T00:03:00+00:00", "path": _abs(library, SONG_A), "duration": 3}
        )
        run_id2 = service.data_sync_push(peer_id)
        await _wait_for(lambda: service.data_sync_status(run_id2)["state"] == "done")
        await peer.serve(until=lambda: len(peer.push_payloads) >= 2, timeout=5.0)
        second_batch = peer.push_payloads[1]
        assert len(second_batch["entries"]) == 1
        assert db.sync_push_cursor_get(peer_id) == db.sync_outbox_max_id()
        assert peer.cursor == db.sync_outbox_max_id()
        await client.aclose()
    finally:
        await service.stop()


def test_push_increment_advances_cursor_issue_by_issue(tmp_path, monkeypatch):
    """② 推送增量 + 游标推进（端到端）。"""
    _run(_push_increment_case(tmp_path / "store", tmp_path, monkeypatch))


async def _pull_applies_remote_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """①② 拉取：对端推 → 本端本地化 / LWW / 落库 → 拉取游标推进到批末行 id。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    _register_fingerprint(SONG_A)  # 本端已有这首歌（否则远端行会（正确地）被判缺歌挂起）
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device", library={SONG_A: SONG_BYTES["A"]})
        peer.register_track(SONG_A, digests[SONG_A])
        played_at = now_ms()
        peer.add_play_history(SONG_A, played_at, 7500)

        assert db.sync_cursor_get(peer_id) == 0
        run_id = service.data_sync_pull(peer_id)
        peer.send_push()  # 对端推来它的增量（帧 9）
        status = await _wait_for(
            lambda: (
                service.data_sync_status(run_id)
                if service.data_sync_status(run_id)["state"] == "done"
                else None
            )
        )
        assert status["received"]["applied"] == 1
        assert status["received"]["suspended"] == 0
        assert status["received"]["lastOutboxID"] == 1
        assert db.sync_cursor_get(peer_id) == 1
        rows = db.playback_all()
        assert len(rows) == 1 and rows[0]["path"] == _abs(library, SONG_A)
        assert rows[0]["source"] == "sync" and rows[0]["duration"] == 7.5

        # 再次拉取：对端没有新行 → 应答空批（回主循环再推一次不会重复落库）
        peer.send_push(entries=[])
        await peer.serve(until=lambda: False, timeout=0.2)
        db.sync_cursor_set(peer_id, 1)
        assert len(db.playback_all()) == 1
        events = service.events_since(0)[1]
        assert any(event["type"] == EventType.DATA.value for event in events)
        await client.aclose()
    finally:
        await service.stop()


def test_pull_applies_remote_and_advances_cursor(tmp_path, monkeypatch):
    """①② 拉取应用 + 游标推进（端到端）。"""
    _run(_pull_applies_remote_case(tmp_path / "store", tmp_path, monkeypatch))


async def _lww_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """① LWW：两端改同一实体 —— `updated_at` 大者胜；平局本端胜且确定（可重复投递）。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    _register_fingerprint(SONG_A)  # 本端已有这首歌（否则远端行会（正确地）被判缺歌挂起）
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device", library={SONG_A: SONG_BYTES["A"]})
        peer.register_track(SONG_A, digests[SONG_A])

        played_at = 1_700_000_000_000  # 同一「播放事件」（跨端行键一致）
        db.playback_append(
            {
                "ts": datetime.fromtimestamp(played_at / 1000, tz=timezone.utc).isoformat(
                    timespec="seconds"
                ),
                "path": _abs(library, SONG_A),
                "duration": 2,
            }
        )
        local_at = now_ms()
        override_outbox_timestamp(local_at)
        peer.add_play_history(SONG_A, played_at, 9_000)
        remote_row = peer.outbox[0]

        # 远端更旧 → 不应用（本端时长保持 2.0 = 本端胜）
        remote_row["updatedAtMs"] = local_at - 5_000
        service.data_sync_pull(peer_id)
        peer.send_push(entries=[remote_row])
        await peer.serve(until=lambda: peer.cursor >= 1, timeout=5.0)
        assert db.playback_all()[0]["duration"] == 2.0

        # 再投一次（同码重复配送）：结果确定（仍为本端胜，不乒乓）
        peer.send_push(entries=[remote_row])
        await peer.serve(until=lambda: peer.cursor >= 2, timeout=5.0)
        assert db.playback_all()[0]["duration"] == 2.0

        # 远端更新 → 应用远端（本端时长被远端快照覆盖）
        remote_row["updatedAtMs"] = local_at + 5_000
        service.data_sync_pull(peer_id)
        peer.send_push(entries=[remote_row])
        await peer.serve(until=lambda: peer.cursor >= 3, timeout=5.0)
        rows = await _wait_for(lambda: [row for row in db.playback_all() if row["duration"] == 9.0])
        assert rows and rows[0]["path"] == _abs(library, SONG_A)
        await client.aclose()
    finally:
        await service.stop()


def override_outbox_timestamp(at_ms: int) -> None:
    """把本端全部 outbox 行的时间戳固定为 `at_ms`（测试控制 LWW 时钟）。"""
    conn = sqlite3.connect(str(db.db_path()))
    try:
        conn.execute("UPDATE sync_outbox SET updated_at = ?", (at_ms,))
        conn.commit()
    finally:
        conn.close()


def test_lww_newer_wins_and_equal_deterministic(tmp_path, monkeypatch):
    """① LWW 大小规则 + 平局确定性（端到端）。"""
    _run(_lww_case(tmp_path / "store", tmp_path, monkeypatch))


async def _delete_not_propagated_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """④ 本端删除不传播：取消收藏只本地生效；对端删除也不影响本端。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device", library={SONG_A: SONG_BYTES["A"]})
        peer.register_track(SONG_A, digests[SONG_A])
        peer.add_favorite(SONG_A)  # 对端先收藏着 A（用于断言「本端删除不影响对端」）

        # 本端收藏再取消：outbox 留 upsert + delete 两行，但 delete 不上线，
        # 且同键末行是 delete → 更早的 upsert 也被批次抑制（§14.9 规则②）
        db.favorites_toggle(_abs(library, SONG_A))
        db.favorites_toggle(_abs(library, SONG_A))
        assert db.favorites_load() == []
        assert [row["op"] for row in _outbox()] == ["upsert", "delete"]

        service.data_sync_push(peer_id)
        await peer.serve(until=lambda: peer.push_payloads, timeout=5.0)
        assert peer.push_payloads[0]["entries"] == []  # 全被过滤：delete 不上线
        assert peer.favorites == {SONG_A}  # 对端不变（没被本端删除带走）
        assert db.favorites_load() == []  # 本端删除本地生效
        assert db.sync_push_cursor_get(peer_id) == db.sync_outbox_max_id()  # 游标照常越过

        # 对端删除 → 本端不变
        db.favorites_toggle(_abs(library, SONG_A))  # 本端重新收藏
        assert db.favorites_load() == [_abs(library, SONG_A)]
        peer.remove_favorite(SONG_A)
        peer.send_push()  # 对端把它的 delete 推来（老 peer 可能这么干）
        await peer.serve(until=lambda: peer.cursor >= 1, timeout=5.0)
        assert db.favorites_load() == [_abs(library, SONG_A)]  # 本端行没被删
        await client.aclose()
    finally:
        await service.stop()


def test_delete_not_propagated_both_directions(tmp_path, monkeypatch):
    """④ 不传播删除（端到端，双向）。"""
    _run(_delete_not_propagated_case(tmp_path / "store", tmp_path, monkeypatch))


async def _pending_replay_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """③ §14.8 本地缺歌挂起：映射不到 → 挂起不丢；歌到位后重放落库。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device", library={SONG_A: SONG_BYTES["A"]})
        peer.register_track(SONG_A, digests[SONG_A])
        peer.add_play_history(SONG_A, now_ms(), 4_000)

        # 本端还没有这首歌（无指纹行）→ 远端行挂起
        run_id = service.data_sync_pull(peer_id)
        peer.send_push()
        status = await _wait_for(
            lambda: (
                service.data_sync_status(run_id)
                if service.data_sync_status(run_id)["state"] == "done"
                else None
            )
        )
        assert status["received"]["suspended"] == 1
        assert status["received"]["applied"] == 0
        assert len(db.sync_pending_load()) == 1
        assert db.playback_all() == []

        # 歌到位（落指纹）→ 重放挂起行 → 本端业务表落库、挂起队列清空
        db.track_fingerprints_upsert(
            [
                {
                    "relative_path": SONG_A,
                    "content_hash": digests[SONG_A],
                    "size": len(SONG_BYTES["A"]),
                    "mtime_ms": int(time.time() * 1000),
                }
            ]
        )
        peer = peer  # 复用同一对端
        replay = service._changelog_peer_for(service.sessions[0]).replay_pending()
        assert replay["replayed"] == 1 and replay["applied"] == 1
        assert db.sync_pending_load() == []
        rows = db.playback_all()
        assert len(rows) == 1 and rows[0]["source"] == "sync"
        await client.aclose()
    finally:
        await service.stop()


def test_suspended_until_song_arrives_then_replay(tmp_path, monkeypatch):
    """③ 本地缺歌挂起 + 歌到位重放（§14.8，数据不丢）。"""
    _run(_pending_replay_case(tmp_path / "store", tmp_path, monkeypatch))


async def _carry_push_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """⑤③ 跟歌走（推送方向）：推一首歌时该歌的播放数据随行（帧 9）。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device")  # 对端还没有这首歌
        played_at = now_ms()
        db.playback_append(
            {
                "ts": "2026-09-14T00:00:00+00:00",
                "path": _abs(library, SONG_A),
                "duration": 12.5,
            }
        )
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": [SONG_A]})
        # 对端边驱动边收：manifest 应答 → 声明 → 文件 ack → 跟歌走的帧 9
        await peer.serve(until=lambda: peer.push_payloads and peer.landed_files, timeout=8.0)
        await _wait_for(
            lambda: (
                service.push_status(run_id).get("state") in ("done", "failed")
                and service.push_status(run_id)
            ),
        )
        # 歌字节送达（推送链本身不变）
        assert peer.landed_files[SONG_A] == SONG_BYTES["A"]
        # 播放数据随行：contentHash = 歌曲指纹（跨端身份键）
        entries = peer.push_payloads[0]["entries"]
        assert [entry["entity"] for entry in entries] == ["play_history"]
        assert entries[0]["contentHash"] == digests[SONG_A]
        assert peer.play_history  # 对端已落到它的播放历史
        assert next(iter(peer.play_history.values())) == 12_500
        assert now_ms() - played_at < 60_000
        # 事件账目可查（跟歌走计划）
        carries = [
            event
            for event in service.events_since(0)[1]
            if event["type"] == EventType.DATA.value and event.get("action") == "carry_push"
        ]
        assert carries and carries[0]["songs"] == [SONG_A]
        await client.aclose()
    finally:
        await service.stop()


def test_carry_push_sends_playback_data_with_song(tmp_path, monkeypatch):
    """⑤ 跟歌走（推送）：推歌时其播放数据随行。"""
    _run(_carry_push_case(tmp_path / "store", tmp_path, monkeypatch))


async def _carry_pull_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """⑤ 跟歌走（拉取方向）：拉一首歌时请求对端把该歌的播放数据带回来（帧 8）。"""
    library = tmp_path / "library"
    library.mkdir(parents=True, exist_ok=True)
    _use_library(monkeypatch, library)
    device = tmp_path / "device"
    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        digest = hashlib.sha256(SONG_BYTES["B"]).hexdigest()
        peer = DataSyncPeer(client, root=device, library={SONG_B: SONG_BYTES["B"]})
        peer.register_track(SONG_B, digest)
        played_at = now_ms()
        peer.add_play_history(SONG_B, played_at, 3_000)

        run_id = service.pull_selection(peer_id, [SONG_B])
        # 对端边驱动边服务：manifest → 取文件（12/13 + 4/5/6）→ 跟歌走的帧 8 → 帧 9
        await peer.serve(
            until=lambda: int(FrameType.CHANGE_LOG_PULL) in peer.frames and db.playback_all(),
            timeout=8.0,
        )
        await _wait_for(
            lambda: (
                service.pull_status(run_id).get("state") in ("done", "failed")
                and service.pull_status(run_id)
            ),
        )
        assert service.pull_status(run_id)["completed"] == [SONG_B]
        assert (library / SONG_B).read_bytes() == SONG_BYTES["B"]
        # 跟歌走：本端发帧 8 → 对端回它的播放数据 → 本端本地化后落库
        rows = await _wait_for(lambda: db.playback_all())
        assert len(rows) == 1 and rows[0]["path"] == _abs(library, SONG_B)
        assert rows[0]["duration"] == 3.0
        assert db.sync_cursor_get(peer_id) == 1
        await client.aclose()
    finally:
        await service.stop()


def test_carry_pull_brings_playback_data_for_pulled_song(tmp_path, monkeypatch):
    """⑤ 跟歌走（拉取）：拉歌时其播放数据随行带回。"""
    _run(_carry_pull_case(tmp_path / "store", tmp_path, monkeypatch))


# ================================================================== ⑦ 迁移
def test_migration_adds_tables_idempotently_and_keeps_rows(tmp_path, monkeypatch):
    """⑦ 老库（无 S4 表）跑迁移：新表就位、既有行数不变、二次跑幂等（无数据丢失）。"""
    legacy_db = tmp_path / "legacy.db"
    conn = sqlite3.connect(str(legacy_db))
    conn.executescript(
        """
        CREATE TABLE favorites (id INTEGER PRIMARY KEY AUTOINCREMENT, path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '',
            album TEXT NOT NULL DEFAULT '', ts TEXT NOT NULL DEFAULT '');
        CREATE TABLE playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL,
            createdAt TEXT NOT NULL DEFAULT '', updatedAt TEXT NOT NULL DEFAULT '');
        CREATE TABLE playlist_songs (id INTEGER PRIMARY KEY AUTOINCREMENT, playlist_id TEXT NOT NULL,
            path TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE playback_events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL,
            path TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', artist TEXT NOT NULL DEFAULT '',
            album TEXT NOT NULL DEFAULT '', played REAL NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0, ratio REAL NOT NULL DEFAULT 0,
            completed INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual',
            mode TEXT NOT NULL DEFAULT 'continuous', device TEXT NOT NULL DEFAULT '');
        CREATE TABLE track_fingerprints (relative_path TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
            size INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT '');
        """
    )
    conn.execute("INSERT INTO favorites (path) VALUES ('/legacy/a.mp3')")
    conn.execute("INSERT INTO playlists (id, name) VALUES ('pl-1', '老歌单')")
    conn.execute(
        "INSERT INTO playlist_songs (playlist_id, path, position) VALUES ('pl-1','/legacy/a.mp3',0)"
    )
    conn.execute(
        "INSERT INTO playback_events (ts, path) VALUES ('2026-09-13T00:00:00+00:00','/legacy/a.mp3')"
    )
    conn.execute(
        "INSERT INTO track_fingerprints (relative_path, content_hash) VALUES ('a.mp3','deadbeef')"
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(state, "DB_PATH", legacy_db)
    db.reset()
    db.init_and_migrate()

    def counts() -> dict[str, int]:
        probe = sqlite3.connect(str(legacy_db))
        try:
            return {
                table: probe.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in (
                    "favorites",
                    "playlists",
                    "playlist_songs",
                    "playback_events",
                    "track_fingerprints",
                    "sync_outbox",
                    "sync_cursor",
                    "sync_push_cursor",
                    "sync_pending_change",
                )
            }
        finally:
            probe.close()

    after = counts()
    assert after["favorites"] == 1
    assert after["playlists"] == 1
    assert after["playlist_songs"] == 1
    assert after["playback_events"] == 1
    assert after["track_fingerprints"] == 1
    assert after["sync_outbox"] == 0 and after["sync_cursor"] == 0

    # 二次跑幂等：行数不变、不重复建表、不丢数据
    db.reset()
    db.init_and_migrate()
    assert counts() == after
    assert db.favorites_load() == ["/legacy/a.mp3"]
    assert db.track_fingerprint_by_hash("deadbeef")["relative_path"] == "a.mp3"


def test_outbox_write_points_record_in_same_transaction(tmp_path, monkeypatch):
    """⑦（配套）业务写点同事务落 outbox：收藏/歌单/播放记录都有变更留痕。"""
    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)

    assert db.favorites_toggle(_abs(library, SONG_A)) is True
    db.favorites_toggle(_abs(library, SONG_A))
    db.playback_append(
        {"ts": "2026-09-14T00:00:00+00:00", "path": _abs(library, SONG_A), "duration": 2}
    )
    db.playlists_save([{"id": "pl-1", "name": "通勤", "songPaths": [_abs(library, SONG_A)]}])

    rows = _outbox()
    by_entity: dict[str, list[str]] = {}
    for row in rows:
        by_entity.setdefault(row["entity"], []).append(row["op"])
    assert by_entity["favorite"] == ["upsert", "delete"]  # delete 本地留痕（不上线由发送侧过滤）
    assert by_entity["play_history"] == ["upsert"]
    assert by_entity["playlist"] == ["upsert"]
    assert by_entity["playlist_item"] == ["upsert"]
    # 曲库外的路径不记（没有跨端身份，记了只会在对端造幽灵行）
    before = len(_outbox())
    db.favorites_toggle(str(tmp_path / "outside.mp3"))
    assert len(_outbox()) == before


def test_database_isolation_no_user_data(tmp_path):
    """验证 #5 自证：真实用户 DB / 歌词库在读写下**零变化**（写入全落在 tmp）。"""
    real_db = Path.home() / "Library" / "Application Support" / "QQPlayer" / "qqplayer.db"
    real_lyrics = Path.home() / ".cache" / "qqplayer" / "lyric"

    def snapshot() -> tuple:
        db_stat = (
            (str(real_db), real_db.stat().st_size, real_db.stat().st_mtime)
            if real_db.exists()
            else None
        )
        files = (
            sorted(
                (str(path.relative_to(real_lyrics)), path.stat().st_mtime)
                for path in real_lyrics.rglob("*")
                if path.is_file()
            )
            if real_lyrics.is_dir()
            else []
        )
        return (db_stat, files)

    before = snapshot()
    # 真实写操作（收藏 / 播放记录 / 指纹 / outbox 表）
    assert db.favorites_toggle(str(tmp_path / "song.mp3")) is True
    db.playback_append(
        {"ts": "2026-09-14T00:00:00+00:00", "path": str(tmp_path / "song.mp3"), "duration": 1}
    )
    db.track_fingerprints_upsert(
        [{"relative_path": "song.mp3", "content_hash": "abc", "size": 1, "mtime_ms": 1}]
    )
    db.sync_outbox_append(
        [{"entity": "favorite", "row_key": "song.mp3", "op": "upsert", "updated_at": 1}]
    )
    db.sync_outbox_page(0)
    assert snapshot() == before  # 真实用户数据零变化
    # 测试上下文里的路径全部在 tmp
    assert str(state.DB_PATH).startswith(str(tmp_path))
    assert str(state.ALIGNED_LYRIC_DIR).startswith(str(tmp_path))
    assert db.db_path() == state.DB_PATH
