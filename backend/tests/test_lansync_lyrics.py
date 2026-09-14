"""局域网同步（S2）S4「aligned 歌词随歌通道」测试（协议 §15）。

覆盖验收点 ⑥：`aligned` 同步、`manual` / `network` **不同步**、随歌可达；另覆盖
命名空间形态校验（不可信输入）、歌词库唯一入口（**无删除路径**）、接收安装编排
（暂存 / 收尾丢弃 / 不留孤儿）、取文件四道闸。

web 端歌词存储形态（开工前取证，见 `app/lansync/lyrics.py` 文件头）：
`manual` 在 `~/.cache/qqplayer/lyric/manual/`、`network` 在 `~/.cache/qqplayer/lyric/`；
本实现新增第三个命名空间 `aligned`（`state.ALIGNED_LYRIC_DIR`）作为随歌通道唯一落点，
**文件名 = 歌曲 content_hash**（web 本端身份是相对路径、会随改名漂移，指纹才是稳定身份）。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import time
from pathlib import Path

from lansync_data_peer import DataSyncPeer
from lansync_ref_client import RefClient

from app import db, state
from app.lansync import crypto as lc
from app.lansync import lyrics as LY
from app.lansync.frame import FrameType
from app.lansync.service import SyncService

HOST = "127.0.0.1"
SONG_A = "Album/01 A.flac"
SONG_B = "Album/02 B.flac"
SONG_BYTES = {"A": b"a" * 2048, "B": b"b" * 3072}
LYRIC_BYTES = {
    "A": json.dumps({"lines": [{"s": 0.0, "e": 1.5, "text": ["A 的一句"]}]}).encode("utf-8"),
    "B": json.dumps({"lines": [{"s": 0.0, "e": 2.0, "text": ["B 的一句"]}]}).encode("utf-8"),
}


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
    """把服务端曲库根指向 tmp 曲库。"""
    monkeypatch.setattr(state, "LIBRARY", root)
    monkeypatch.setattr(state, "_scan_cache", None)


def _seed_aligned(content_hash: str, data: bytes) -> Path:
    """在本端 aligned 歌词库写一条（真实链路里来自桌面 AI 对齐产物）。"""
    entry = LY.AlignedLyricsStore().save(content_hash, data)
    assert entry is not None
    return entry.path


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
    qr = json.loads(service.start_pairing()["qr_payload"])
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


# ============================================================ 命名空间（§15.2）
def test_wire_namespace_roundtrip():
    """命名空间往返：`content_hash` ↔ `@lyrics/{hash}.json`。"""
    digest = "a" * 64
    assert LY.wire_path(digest) == f"@lyrics/{digest}.json"
    assert LY.song_content_hash(f"@lyrics/{digest}.json") == digest
    assert LY.song_content_hash("./@lyrics/x-1_2.3.json") == "x-1_2.3"
    assert LY.is_lyrics_path("@lyrics/x.json") is True
    assert LY.is_lyrics_path("./@lyrics/x.json") is True
    assert LY.is_lyrics_path("Album/01 A.flac") is False
    assert LY.file_name(digest) == f"{digest}.json"


def test_wire_namespace_rejects_untrusted_forms():
    """收到的哈希是**不可信输入**：越界 / 多层 / 点段 / 非法字符一律拒绝。"""
    assert LY.song_content_hash("@lyrics/a/b.json") is None  # 只接受单层文件名
    assert LY.song_content_hash("@lyrics/../x.json") is None
    assert LY.song_content_hash("@lyrics/.json") is None
    assert LY.song_content_hash("@lyrics/x") is None  # 无扩展名
    assert LY.song_content_hash("Album/01 A.flac") is None
    assert LY.song_content_hash("/@lyrics/x.json") is None  # 绝对路径
    assert LY.is_valid_content_hash("a b") is False
    assert LY.is_valid_content_hash("../x") is False
    assert LY.is_valid_content_hash("a" * 200) is False
    assert LY.is_valid_content_hash("a" * 129) is False
    assert LY.wire_path("../x") is None


def test_only_aligned_kind_synchronizes():
    """类型标记：目录即类型；**只有 aligned 参与随歌同步**（§15.1）。"""
    assert LY.LyricsKind.ALIGNED.synchronizes_with_library is True
    assert LY.LyricsKind.MANUAL.synchronizes_with_library is False
    assert LY.LyricsKind.NETWORK.synchronizes_with_library is False
    assert [kind.value for kind in LY.SYNCHRONIZED_KINDS] == ["aligned"]


# ============================================================ 歌词库（唯一入口）
def test_store_save_entries_and_no_delete_path():
    """库是唯一入口：写入 / 枚举 / 安装都在这里；**不存在删除本端歌词的方法**。"""
    store = LY.AlignedLyricsStore()
    digest = "b" * 64
    entry = store.save(digest, LYRIC_BYTES["A"])
    assert entry is not None and store.has(digest)
    entries = store.entries()
    assert [item.content_hash for item in entries] == [digest]
    assert item_hash(entries[0].path) == hashlib.sha256(LYRIC_BYTES["A"]).hexdigest()
    # 不传播删除（§15.4）：本类型没有删除路径
    public = [name for name in dir(store) if not name.startswith("_")]
    assert not [name for name in public if "delete" in name or "remove" in name or "unlink" in name]


def test_store_ignores_foreign_names_and_is_deterministic(tmp_path, monkeypatch):
    """库里非 `{hash}.json` 命名的文件不参与同步（不猜、不误判成孤儿）。"""
    root = Path(state.ALIGNED_LYRIC_DIR)
    root.mkdir(parents=True, exist_ok=True)
    (root / "notahash!.json").write_bytes(b"junk")
    (root / "readme.txt").write_bytes(b"junk")
    store = LY.AlignedLyricsStore()
    assert store.entries() == []
    store.save("c" * 64, LYRIC_BYTES["B"])
    assert [item.content_hash for item in store.entries()] == ["c" * 64]


def item_hash(path: Path) -> str:
    """文件字节 SHA-256（断言歌词文件自身哈希）。"""
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ============================================================ manifest 条目（§15.3）
def test_manifest_entries_carry_file_hash_and_song_stable_id(tmp_path, monkeypatch):
    """条目：路径 = `@lyrics/{歌曲 hash}.json`；`contentHash` = **歌词文件自身**哈希。"""
    library = tmp_path / "library"
    digests = _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    song_hash = _fingerprint(SONG_A)
    _seed_aligned(song_hash, LYRIC_BYTES["A"])

    entries = LY.manifest_entries()
    assert [entry.relative_path for entry in entries] == [f"@lyrics/{song_hash}.json"]
    assert entries[0].content_hash == hashlib.sha256(LYRIC_BYTES["A"]).hexdigest()
    assert entries[0].stable_id == SONG_A  # 单端引用信息（反查指纹表）
    assert entries[0].size == len(LYRIC_BYTES["A"])
    assert digests[SONG_A] == song_hash


def test_entries_for_songs_only_covers_transferred_songs(tmp_path, monkeypatch):
    """跟歌走：只带**本轮传输的歌**的歌词；本端拿不到指纹的歌跳过（无身份键）。"""
    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"], SONG_B: SONG_BYTES["B"]})
    _use_library(monkeypatch, library)
    hash_a, hash_b = _fingerprint(SONG_A), _fingerprint(SONG_B)
    _seed_aligned(hash_a, LYRIC_BYTES["A"])
    _seed_aligned(hash_b, LYRIC_BYTES["B"])
    # 一首没指纹的歌（不在本端曲库）→ 其歌词不会被列出
    _seed_aligned("d" * 64, LYRIC_BYTES["A"])

    only_a = LY.entries_for_songs([SONG_A])
    assert [entry.relative_path for entry in only_a] == [f"@lyrics/{hash_a}.json"]
    both = LY.entries_for_songs([SONG_A, SONG_B])
    assert sorted(entry.relative_path for entry in both) == sorted(
        [f"@lyrics/{hash_a}.json", f"@lyrics/{hash_b}.json"]
    )
    assert all(entry.relative_path != f"@lyrics/{'d' * 64}.json" for entry in both)


def _fingerprint(relative: str) -> str:
    """落库本端曲目指纹（真实链路里由 manifest / 取文件惰性计算）。"""
    from app.lansync.locallib import ensure_content_hash

    digest = ensure_content_hash(relative)
    assert digest
    return digest


# ============================================================ 取文件四道闸
def test_resolve_lyrics_file_four_gates(tmp_path, monkeypatch):
    """应答侧解析：越界 / 多层 / 不存在 / 非常规文件一律拒绝（绝不读出歌词根）。"""
    song_hash = "e" * 64
    store = LY.AlignedLyricsStore()
    saved = store.save(song_hash, LYRIC_BYTES["A"])
    assert saved is not None
    assert LY.resolve_lyrics_file(f"@lyrics/{song_hash}.json").ok is True
    assert LY.resolve_lyrics_file(f"@lyrics/{song_hash}.json").path == saved.path
    # 越界 / 非法形态
    assert LY.resolve_lyrics_file("@lyrics/../../etc/passwd").reason == "invalid_path"
    assert LY.resolve_lyrics_file("/@lyrics/x.json").reason == "invalid_path"
    assert LY.resolve_lyrics_file("Album/01 A.flac").reason == "invalid_path"
    assert LY.resolve_lyrics_file("@lyrics/a/b.json").reason == "invalid_path"
    # 命名空间内但不存在
    assert LY.resolve_lyrics_file(f"@lyrics/{'f' * 64}.json").reason == "not_found"
    # 软链逃逸：歌词根内的软链指向外部 → 拒读
    outside = tmp_path / "outside.json"
    outside.write_bytes(b"secret")
    link = store.root / f"{'9' * 64}.json"
    os.symlink(outside, link)
    assert LY.resolve_lyrics_file(link.name if False else f"@lyrics/{'9' * 64}.json").reason in (
        "out_of_root",
        "not_regular_file",
    )


# ============================================================ 接收安装编排（§15.4）
def test_receiver_installs_pending_then_discards_without_orphans(tmp_path, monkeypatch):
    """收到歌词：本端有歌 → 装；本端没歌 → 暂存；收尾仍没有 → 丢弃（不留孤儿）。"""
    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    song_hash = _fingerprint(SONG_A)

    receiver = LY.LyricsReceiver()
    # 本端有歌 → 直接安装
    outcome = receiver.receive_bytes(LYRIC_BYTES["A"], f"@lyrics/{song_hash}.json")
    assert outcome.kind == "installed"
    assert (LY.AlignedLyricsStore().root / f"{song_hash}.json").read_bytes() == LYRIC_BYTES["A"]

    # 本端没这首歌 → 暂存；收尾时仍映射不到 → 丢弃（临时文件清理，不留孤儿）
    ghost_hash = "7" * 64
    pending = receiver.receive_bytes(LYRIC_BYTES["B"], f"@lyrics/{ghost_hash}.json")
    assert pending.kind == "pending" and receiver.pending_count == 1
    outcomes = receiver.flush_pending()
    assert [item.kind for item in outcomes] == ["discarded"]
    assert receiver.pending_count == 0
    assert not (LY.AlignedLyricsStore().root / f"{ghost_hash}.json").exists()
    assert not list(LY.AlignedLyricsStore().root.glob(".incoming-*.tmp"))

    # 收尾后到达的歌词：映射不到直接丢弃；映射得到照装（不暂存）
    assert (
        receiver.receive_bytes(LYRIC_BYTES["B"], f"@lyrics/{ghost_hash}.json").kind == "discarded"
    )
    assert receiver.receive_bytes(LYRIC_BYTES["A"], f"@lyrics/{song_hash}.json").kind == "installed"


def test_receiver_flush_installs_when_song_arrives_late(tmp_path, monkeypatch):
    """歌比歌词后到：收尾再试一次映射 → 装进去（自愈，不引入第二套挂起队列）。"""
    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    song_hash = hashlib.sha256(SONG_BYTES["A"]).hexdigest()

    receiver = LY.LyricsReceiver()
    assert receiver.receive_bytes(LYRIC_BYTES["A"], f"@lyrics/{song_hash}.json").kind == "pending"
    _fingerprint(SONG_A)  # 歌到位
    outcomes = receiver.flush_pending()
    assert [item.kind for item in outcomes] == ["installed"]
    assert (LY.AlignedLyricsStore().root / f"{song_hash}.json").read_bytes() == LYRIC_BYTES["A"]


# ============================================================ 端到端：随歌推送
async def _lyrics_push_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """⑥ 随歌推送：推歌时把该歌的 aligned 歌词一并送过去；manual / network 不同步。"""
    from lyric_fetch import MANUAL_DIR, save_manual_lyric

    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    song_hash = _fingerprint(SONG_A)
    aligned_path = _seed_aligned(song_hash, LYRIC_BYTES["A"])
    # manual 歌词（同目录另一命名空间）+ network 缓存：都**不该**被同步
    manual_dir = tmp_path / "manual"
    monkeypatch.setattr("lyric_fetch.MANUAL_DIR", manual_dir)
    save_manual_lyric(str(library / SONG_A), "lrc", "[00:01.00]手动的一句")
    assert MANUAL_DIR  # 模块常量存在（避免未使用告警语义漂移）

    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        peer = DataSyncPeer(client, root=tmp_path / "device")
        run_id = service.push_selection(peer_id, {"kind": "tracks", "ids": [SONG_A]})
        await peer.serve(
            until=lambda: (
                peer.landed_lyrics and peer.landed_files and _lyrics_run_state(service) == "done"
            ),
            timeout=8.0,
        )
        await _wait_for(
            lambda: (
                service.push_status(run_id).get("state") in ("done", "failed")
                and service.push_status(run_id)
            ),
        )
        # 歌与歌词都送达（歌词路径 = `@lyrics/{歌曲 content_hash}.json`）
        wire = f"@lyrics/{song_hash}.json"
        assert peer.landed_files[SONG_A] == SONG_BYTES["A"]
        assert peer.landed_lyrics[wire] == LYRIC_BYTES["A"]
        assert aligned_path.read_bytes() == LYRIC_BYTES["A"]
        # 声明里：`fileID` = **歌词所属歌曲的** content_hash（§15.3）
        assert [entry.relative_path for entry in peer.announced] == [wire]
        assert peer.announced[0].file_id == song_hash
        assert peer.announced[0].sha256_hex == hashlib.sha256(LYRIC_BYTES["A"]).hexdigest()
        # manual / network 一个字节都没进声明
        assert all(
            "@lyrics/" not in entry.relative_path or entry.relative_path == wire
            for entry in peer.announced
        )
        assert manual_dir.is_dir() and list(manual_dir.glob("*.json"))  # manual 确实存在
        # 事件账目：歌词推送跑完
        lyrics_events = [
            event
            for event in service.events_since(0)[1]
            if event["type"] == "lyrics" and event.get("kind") == "lyrics_push"
        ]
        assert lyrics_events and lyrics_events[-1]["state"] == "done"
        assert lyrics_events[-1]["completed"] == [wire]
        await client.aclose()
    finally:
        await service.stop()


def _lyrics_run_state(service: SyncService) -> str:
    """最近一条歌词推送事件的状态（未发生时 = 空串）。"""
    events = [
        event
        for event in service.events_since(0)[1]
        if event["type"] == "lyrics" and event.get("kind") == "lyrics_push"
    ]
    return str(events[-1].get("state") or "") if events else ""


def test_push_lyrics_follow_song_aligned_only(tmp_path, monkeypatch):
    """⑥ 随歌推送：aligned 同步、manual 不同步。"""
    _run(_lyrics_push_case(tmp_path / "store", tmp_path, monkeypatch))


# ============================================================ 端到端：随歌拉取
async def _lyrics_pull_case(store_dir: Path, tmp_path: Path, monkeypatch) -> None:
    """⑥ 随歌拉取：拉歌时把对端该歌的 aligned 歌词一并取回并装进歌词库。"""
    library = tmp_path / "library"
    library.mkdir(parents=True, exist_ok=True)
    _use_library(monkeypatch, library)
    song_hash = hashlib.sha256(SONG_BYTES["B"]).hexdigest()

    service = await _start_service(store_dir)
    try:
        client, peer_id = await _pair(service)
        # 对端：这首歌 + 它的 aligned 歌词（歌词条目出现在它的 manifest 里）
        peer = DataSyncPeer(
            client,
            root=tmp_path / "device",
            library={SONG_B: SONG_BYTES["B"]},
            lyrics={song_hash: LYRIC_BYTES["B"]},
        )
        peer.register_track(SONG_B, song_hash)

        run_id = service.pull_selection(peer_id, [SONG_B])
        await peer.serve(
            until=lambda: (LY.AlignedLyricsStore().root / f"{song_hash}.json").exists(),
            timeout=8.0,
        )
        await _wait_for(
            lambda: (
                service.pull_status(run_id).get("state") in ("done", "failed")
                and service.pull_status(run_id)
            ),
        )
        # 歌到位 + 歌词装进 aligned 库（不是落曲库根、也不写进 manual/network）
        assert (library / SONG_B).read_bytes() == SONG_BYTES["B"]
        installed = LY.AlignedLyricsStore().root / f"{song_hash}.json"
        assert installed.read_bytes() == LYRIC_BYTES["B"]
        assert not (library / "@lyrics").exists()
        # 对端只在被点名时送歌词（本端清单里没有的路径才请求）
        requested = [path for request in peer.fetch_requests for path in request.relative_paths]
        assert f"@lyrics/{song_hash}.json" in requested
        await client.aclose()
    finally:
        await service.stop()


def test_pull_lyrics_follows_pulled_song(tmp_path, monkeypatch):
    """⑥ 随歌拉取：拉歌时对齐歌词随行可达。"""
    _run(_lyrics_pull_case(tmp_path / "store", tmp_path, monkeypatch))


def test_lyrics_root_is_isolated_in_tests(tmp_path):
    """验证 #5 自证：歌词库落在 tmp（本套测试不碰真实用户歌词缓存）。"""
    assert str(state.ALIGNED_LYRIC_DIR).startswith(str(tmp_path))
    assert str(LY.AlignedLyricsStore().root) == str(state.ALIGNED_LYRIC_DIR)
    assert str(Path.home() / ".cache" / "qqplayer" / "lyric") != str(state.ALIGNED_LYRIC_DIR)
    # 采集一次（不写）：真实目录即使存在也不会被本套测试写入——见 conftest 隔离
    assert db.db_path() == state.DB_PATH


def test_lyrics_push_run_skips_when_no_aligned_lyrics(tmp_path, monkeypatch):
    """随歌推送的边界：本端没有 aligned 歌词 → **不发帧**（不产生空批次噪音）。"""
    library = tmp_path / "library"
    _make_library(library, {SONG_A: SONG_BYTES["A"]})
    _use_library(monkeypatch, library)
    _fingerprint(SONG_A)

    sent: list[int] = []

    class _Session:
        session_id = "s1"
        is_ready = True

        def send_application_frame(self, frame_type: int, payload: bytes = b"") -> None:
            sent.append(int(frame_type))

    run = LY.LyricsPushRun(_Session(), ack_timeout=0)
    run.start([SONG_A])
    assert run.state is LY.LyricsPushState.DONE
    assert sent == []  # 无歌词 → 不声明、不传
    assert run.status()["planned"] == []

    # 有歌词 → 声明帧 14 发出，且状态进 sending（等 ack）
    _seed_aligned(_fingerprint(SONG_A), LYRIC_BYTES["A"])
    run2 = LY.LyricsPushRun(_Session(), ack_timeout=5)
    run2.start([SONG_A])
    assert sent[0] == int(FrameType.LIBRARY_PUSH_ANNOUNCE)  # 先声明
    assert int(FrameType.FILE_META) in sent  # 再立刻起传（停等等 ack）
    assert run2.state is LY.LyricsPushState.SENDING
    assert run2.is_awaiting_ack is True
    run2.handle_session_closed()
    assert run2.state is LY.LyricsPushState.FAILED
