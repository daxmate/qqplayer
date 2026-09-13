"""局域网同步（S2）web 端曲库映射测试：路径口径 / 内容指纹 / manifest / 对端清单 / 取文件。

覆盖 `docs/lan-sync-protocol.md` §11（manifest 10/11）、§13（对端内容清单 15/16）：

- 相对路径生成与越界拒绝（`..` / 绝对路径 / 软链逃逸）；
- content_hash = 文件字节 SHA-256（与 hashlib 对照）+ 惰性回填幂等（第二次不重算）；
- manifest 条目字段与顺序（`relativePath` 升序）、集合过滤（全库 / 歌单 / 勾选 / 空选择）；
- `@smart:*` 三种来源的顺序与 50 上限；
- 对端清单 `trackCount` 自洽、未知 id = 空集（绝不回落全库）、分页钳制、非法 scope；
- 空曲库 = 空清单；老库迁移幂等（新表自动补齐 + 原数据条数不变）。

测试全部使用 tmp 曲库 + 独立 DB（conftest 的 `_sqlite_isolate` autouse fixture），
绝不触碰用户真实数据。
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from pathlib import Path

from app import db, state
from app.lansync import library_sources as sources
from app.lansync import locallib as L
from app.lansync import manifest as M
from app.lansync import peer_library as P


# ============ 测试辅助 ============
def _write(path: Path, data: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _song(root: Path, rel: str, *, title: str | None = None, artist: str = "") -> dict:
    """曲库扫描结果的等价 dict（字段与 `library_scan._full_scan` 同形）。"""
    target = root / Path(rel)
    return {
        "id": rel,
        "path": str(target),
        "name": title or target.stem,
        "artist": artist,
        "size": target.stat().st_size,
        "mtime": 0,
    }


def _library(tmp_path: Path, entries: dict[str, bytes]) -> tuple[Path, list[dict]]:
    """建 tmp 曲库：相对路径 → 内容；返回 (曲库根, 扫描结果)。"""
    root = tmp_path / "library"
    for rel, data in entries.items():
        _write(root / rel, data)
    return root, [_song(root, rel) for rel in entries]


def _set_mtime(path: Path, seconds: float) -> None:
    os.utime(path, (seconds, seconds))


def _playback(path: str, ts: str, played: float = 10.0) -> None:
    db.playback_append({"path": path, "ts": ts, "played": played, "name": "x"})


# ============ 路径口径 ============
def test_normalize_relative_path_canonicalizes():
    """规范化：去 `./`、重复 `/`，反斜杠统一为 POSIX 分隔符，去首尾空白。"""
    assert L.normalize_relative_path("Album/01 Song.flac") == "Album/01 Song.flac"
    assert L.normalize_relative_path("./Album//01 Song.flac") == "Album/01 Song.flac"
    assert L.normalize_relative_path("Album\\Sub\\a.mp3") == "Album/Sub/a.mp3"
    assert L.normalize_relative_path("  a.mp3  ") == "a.mp3"


def test_normalize_relative_path_rejects_escapes():
    """拒空串 / 绝对路径 / `..` 逃逸 / 非字符串（调用方丢弃，绝不顺手修正）。"""
    for raw in ("", "   ", "/etc/passwd", "/", "..", "../x", "a/../../b", "a/..", None, 42):
        assert L.normalize_relative_path(raw) is None, raw


def test_relative_path_of_inside_outside_and_root():
    """绝对路径 → 相对路径：根内命中；根外 / 等于根 → None。"""
    root = Path("/tmp/qqplayer-root")
    assert L.relative_path_of("/tmp/qqplayer-root/A/b.mp3", root) == "A/b.mp3"
    assert L.relative_path_of("/tmp/other/b.mp3", root) is None
    assert L.relative_path_of("/tmp/qqplayer-root", root) is None
    assert L.relative_path_of("", root) is None


def test_is_valid_playlist_id_shape():
    """歌单标识形态校验：合法保留标识 / slug 通过，空 / 点段 / 分隔符 / 超长 / 控制字符拒绝。"""
    for ok in ("p1", "my-list", L.FAVORITES_ID, "@smart:recentAdded"):
        assert L.is_valid_playlist_id(ok), ok
    for bad in ("", "   ", ".", "..", "a/b", "a\\b", "x" * 129, "a\x00b", "a\nb", 42):
        assert not L.is_valid_playlist_id(bad), bad


# ============ 内容指纹（SHA-256，惰性 + 落库） ============
def test_sha256_file_matches_hashlib_lowercase(tmp_path):
    """content_hash = 文件字节 SHA-256 小写 hex（与 hashlib 逐字节一致）。"""
    path = _write(tmp_path / "a.mp3", b"QQPlayer-lansync")
    expected = hashlib.sha256(b"QQPlayer-lansync").hexdigest()
    assert L.sha256_file(path) == expected
    assert expected == expected.lower()
    # 内容不同 → 指纹不同（不是路径哈希：换目录同内容仍有同样指纹）
    other = _write(tmp_path / "sub" / "b.mp3", b"QQPlayer-lansync")
    assert L.sha256_file(other) == expected
    assert L.sha256_file(_write(tmp_path / "c.mp3", b"other")) != expected


def test_scan_persists_hash_and_second_call_recomputes_nothing(tmp_path, monkeypatch):
    """惰性回填：首次现算 + 落库；第二次全部命中缓存（计数断言 0 次重算）。"""
    root, songs = _library(tmp_path, {"Album/a.mp3": b"AAA", "Album/b.mp3": b"BBB"})
    calls: list[str] = []
    real = L.sha256_file

    def counting(path):
        calls.append(str(path))
        return real(path)

    monkeypatch.setattr(L, "sha256_file", counting)
    first = L.scan_library_files(root=root, songs=songs)
    assert len(calls) == 2
    assert all(f.content_hash for f in first)
    assert set(db.track_fingerprints_load()) == {"Album/a.mp3", "Album/b.mp3"}

    second = L.scan_library_files(root=root, songs=songs)
    assert len(calls) == 2, "第二次必须命中缓存（不重算）"
    assert [f.content_hash for f in second] == [f.content_hash for f in first]


def test_hash_recomputed_when_size_or_mtime_changes(tmp_path, monkeypatch):
    """文件 size / mtime 变了 → 重算并覆盖缓存（内容改了就换指纹）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"AAAA"})
    first = L.scan_library_files(root=root, songs=songs)[0]
    target = root / "a.mp3"
    _write(target, b"BBBB")  # 同长度不同内容
    _set_mtime(target, os.stat(target).st_mtime + 10)
    second = L.scan_library_files(root=root, songs=songs)[0]
    assert second.content_hash != first.content_hash
    assert second.content_hash == hashlib.sha256(b"BBBB").hexdigest()
    assert db.track_fingerprints_load()["a.mp3"]["content_hash"] == second.content_hash


def test_ensure_content_hash_single_file_and_cache(tmp_path, monkeypatch):
    """单文件惰性指纹（§11.6 fileID 口径）：现算落库 → 二次命中；非法 / 不存在 → None。"""
    root, _ = _library(tmp_path, {"Album/x.mp3": b"XYZ"})
    calls: list[str] = []
    real = L.sha256_file
    monkeypatch.setattr(L, "sha256_file", lambda p: (calls.append(str(p)), real(p))[1])

    digest = L.ensure_content_hash("Album/x.mp3", root=root)
    assert digest == hashlib.sha256(b"XYZ").hexdigest()
    assert L.ensure_content_hash("Album/x.mp3", root=root) == digest
    assert len(calls) == 1, "第二次必须命中缓存"
    assert L.ensure_content_hash("../outside.mp3", root=root) is None
    assert L.ensure_content_hash("Album/missing.mp3", root=root) is None


def test_manifest_mtime_uses_file_mtime(tmp_path):
    """`mtimeMs` 取**文件 mtime**（与 Swift 的 contentModificationDate 同口径），
    不是扫描结果里的 `mtime` 字段（后者是 birthtime 口径，供「最近添加」用）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"AAAA"})
    songs[0]["mtime"] = 123
    _set_mtime(root / "a.mp3", 1_700_000_000)
    entry = M.manifest_entries(root=root, songs=songs)[0]
    assert entry.mtime_ms == 1_700_000_000_000


# ============ manifest（帧 10/11） ============
def test_manifest_entries_fields_and_sorted_order(tmp_path):
    """条目字段齐备 + 按 `relativePath` 升序（输入乱序、同路径重复时后者胜）。"""
    root, songs = _library(tmp_path, {"B/b.mp3": b"B", "A/a.mp3": b"A", "C/c.mp3": b"C"})
    entries = M.manifest_entries(root=root, songs=list(reversed(songs)))
    assert [e.relative_path for e in entries] == ["A/a.mp3", "B/b.mp3", "C/c.mp3"]
    first = entries[0]
    assert first.size == 1
    assert first.content_hash == hashlib.sha256(b"A").hexdigest()

    payload = M.manifest_response(root=root, songs=songs)
    assert payload["rootName"] == root.name
    assert [e["relativePath"] for e in payload["entries"]] == ["A/a.mp3", "B/b.mp3", "C/c.mp3"]
    assert payload["entries"][0]["size"] == 1
    assert "contentHash" in payload["entries"][0]


def test_manifest_collection_playlists_union_members(tmp_path):
    """歌单集合 = 各歌单成员并集（按相对路径升序；未知歌单贡献空集）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B", "c.mp3": b"C"})
    db.playlists_save(
        [
            {"id": "p1", "name": "P1", "songPaths": [str(root / "a.mp3")]},
            {"id": "p2", "name": "P2", "songPaths": [str(root / "c.mp3")]},
        ]
    )
    entries = M.manifest_entries(M.Collection.playlists(["p1", "p2"]), root=root, songs=songs)
    assert [e.relative_path for e in entries] == ["a.mp3", "c.mp3"]
    # 单个歌单
    assert [
        e.relative_path
        for e in M.manifest_entries(M.Collection.playlists(["p2"]), root=root, songs=songs)
    ] == ["c.mp3"]
    # 未知歌单 → 空集（绝不回落全库）
    assert M.manifest_entries(M.Collection.playlists(["nope"]), root=root, songs=songs) == []


def test_manifest_collection_tracks_accepts_relative_and_absolute(tmp_path):
    """勾选集合：id 支持相对路径与本端绝对路径（web 端歌曲标识即相对路径）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B"})
    collection = M.Collection.tracks(["b.mp3", str(root / "a.mp3"), "../escape"])
    entries = M.manifest_entries(collection, root=root, songs=songs)
    assert [e.relative_path for e in entries] == ["a.mp3", "b.mp3"]


def test_manifest_empty_selection_and_invalid_collection():
    """空选择集 = 不选任何文件（与 all 相反）；未知 kind → ValueError（§11 解码失败不回帧）。"""
    assert M.Collection.playlists([]).is_empty_selection
    assert not M.Collection.all().is_empty_selection
    assert M.Collection.from_payload(None) == M.Collection.all()
    assert M.Collection.from_payload({"kind": "tracks", "ids": ["a.mp3"]}).ids == ("a.mp3",)
    assert M.Collection.from_payload({"kind": "tracks", "ids": "not-a-list"}).ids == ()
    try:
        M.Collection.from_payload({"kind": "wat"})
    except ValueError as exc:
        assert "wat" in str(exc)
    else:  # pragma: no cover - 失败路径
        raise AssertionError("未知集合类型必须抛 ValueError")


def test_manifest_empty_library(tmp_path):
    """空曲库 → 空清单（不是错误）。"""
    root = tmp_path / "empty"
    root.mkdir()
    assert M.manifest_entries(root=root, songs=[]) == []
    payload = M.manifest_response(root=root, songs=[])
    assert payload == {"entries": [], "rootName": "empty"}


def test_manifest_uses_library_scan_when_no_songs_injected(tmp_path, monkeypatch):
    """不注入 songs 时走真实扫描链路（`state.LIBRARY` + `library_scan.scan_library()`）。"""
    root, _ = _library(tmp_path, {"Album/real.mp3": b"REAL"})
    monkeypatch.setattr(state, "LIBRARY", root)
    monkeypatch.setattr(state, "_scan_cache", None)
    entries = M.manifest_entries()
    assert [e.relative_path for e in entries] == ["Album/real.mp3"]
    assert entries[0].content_hash == hashlib.sha256(b"REAL").hexdigest()


# ============ 来源与自动歌单（§13.5 / §13.6） ============
def test_smart_limit_matches_playlist_page():
    """自动歌单上限与播放列表页同一常量（前端 SMART_VIEW_LIMIT = 50）。"""
    assert L.SMART_LIMIT == 50
    assert L.SMART_KINDS == ("recentAdded", "recentPlayed", "topPlayed")


def test_smart_recent_added_newest_first_and_capped(tmp_path):
    """最近添加：按文件 mtime 降序（最新在前），上限 50。"""
    entries = {f"t{i:02d}.mp3": bytes([i]) for i in range(55)}
    root, songs = _library(tmp_path, entries)
    for index in range(55):
        _set_mtime(root / f"t{index:02d}.mp3", 1_600_000_000 + index)
    members = sources.source_member_paths(root=root, songs=songs)["@smart:recentAdded"]
    assert len(members) == 50
    assert members[0] == "t54.mp3"
    assert members[-1] == "t05.mp3"


def test_smart_recent_played_dedupes_and_orders_by_latest(tmp_path):
    """最近播放：最近播放时间降序；同一首歌只留最新一条。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B", "c.mp3": b"C"})
    _playback(str(root / "a.mp3"), "2026-09-01T00:00:00+00:00")
    _playback(str(root / "a.mp3"), "2026-09-03T00:00:00+00:00")  # a 的最新记录
    _playback(str(root / "b.mp3"), "2026-09-02T00:00:00+00:00")
    _playback(str(root / "c.mp3"), "2026-09-04T00:00:00+00:00")
    members = sources.source_member_paths(root=root, songs=songs)["@smart:recentPlayed"]
    assert members == ["c.mp3", "a.mp3", "b.mp3"]


def test_smart_top_played_orders_by_plays_then_total(tmp_path):
    """常听排行：播放次数降序，并列按累计时长。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B", "c.mp3": b"C"})
    _playback(str(root / "a.mp3"), "2026-09-01T00:00:00+00:00", 5)
    _playback(str(root / "a.mp3"), "2026-09-02T00:00:00+00:00", 5)
    _playback(str(root / "b.mp3"), "2026-09-01T00:00:00+00:00", 60)  # 1 次但累计时长更长
    _playback(str(root / "c.mp3"), "2026-09-01T00:00:00+00:00", 10)
    _playback(str(root / "c.mp3"), "2026-09-02T00:00:00+00:00", 10)
    members = sources.source_member_paths(root=root, songs=songs)["@smart:topPlayed"]
    # a 与 c 都是 2 次，按累计时长破平：c(20s) > a(10s)，最后是 1 次的 b
    assert members == ["c.mp3", "a.mp3", "b.mp3"]


def test_smart_members_skip_paths_missing_from_library(tmp_path):
    """播放数据里的路径不在曲库（已删除 / 网络歌）→ 不进成员（也不影响摘要自洽）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A"})
    _playback(str(root / "ghost.mp3"), "2026-09-05T00:00:00+00:00")
    _playback(str(root / "a.mp3"), "2026-09-01T00:00:00+00:00")
    paths = sources.source_member_paths(root=root, songs=songs)
    assert paths["@smart:recentPlayed"] == ["a.mp3"]
    assert paths["@smart:topPlayed"] == ["a.mp3"]


def test_sources_include_favorites_and_real_playlists(tmp_path):
    """来源清单含收藏 + 真实歌单（成员序保留）；非法 slug / `@` 前缀歌单跳过。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B"})
    db.favorites_toggle(str(root / "b.mp3"))
    db.playlists_save(
        [
            {"id": "p1", "name": "歌单一", "songPaths": [str(root / "b.mp3"), str(root / "a.mp3")]},
            {"id": "bad/slug", "name": "非法", "songPaths": [str(root / "a.mp3")]},
        ]
    )
    paths = sources.source_member_paths(root=root, songs=songs)
    assert paths[L.FAVORITES_ID] == ["b.mp3"]
    assert paths["p1"] == ["b.mp3", "a.mp3"]  # 成员序（不是相对路径序）
    assert "bad/slug" not in paths


# ============ 对端内容清单（帧 15/16） ============
def test_catalog_track_count_self_consistent(tmp_path):
    """`trackCount` 恒等于按该 id 筛 tracks 的条数（成员失联不计入，§13.7）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B"})
    db.playlists_save(
        [
            {
                "id": "p1",
                "name": "P1",
                "songPaths": [str(root / "a.mp3"), str(root / "b.mp3"), str(root / "ghost.mp3")],
            }
        ]
    )
    catalog = P.build_peer_library_catalog(root=root, songs=songs)
    item = next(p for p in catalog.playlists if p.id == "p1")
    filtered = catalog.matched_tracks(P.PeerLibraryRequest(scope="tracks", playlist_id="p1"))
    assert item.track_count == len(filtered) == 2
    # 构造期强制：装配方给的数字无效
    forced = P.PeerLibraryCatalog(
        playlists=[P.PeerPlaylistItem(id="p1", name="P1", track_count=99)],
        tracks=[P.PeerTrackItem(relative_path="a.mp3")],
        member_paths={"p1": ["a.mp3"]},
    )
    assert forced.playlists[0].track_count == 1


def test_catalog_unknown_playlist_id_is_empty_not_full_library(tmp_path):
    """未知 / 形态非法歌单标识 → 空集（绝不回落全库）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B"})
    catalog = P.build_peer_library_catalog(root=root, songs=songs)
    unknown = catalog.response(P.PeerLibraryRequest(scope="tracks", playlist_id="nope", limit=500))
    assert unknown["total"] == 0 and unknown["items"] == []
    malformed = catalog.response(
        P.PeerLibraryRequest(scope="tracks", playlist_id="../a", limit=500)
    )
    assert malformed["total"] == 0
    # 不带 playlistID → 全库（相对路径升序），不是空集
    everything = catalog.response(P.PeerLibraryRequest(scope="tracks", limit=500))
    assert [i["track"]["relativePath"] for i in everything["items"]] == ["a.mp3", "b.mp3"]


def test_catalog_invalid_scope_empty_with_summary(tmp_path):
    """非法 scope → 空清单 + `total: 0`，摘要照常返回（不报错、不断会话）。"""
    root, songs = _library(tmp_path, {"a.mp3": b"AAAA", "b.mp3": b"BB"})
    catalog = P.build_peer_library_catalog(root=root, songs=songs)
    payload = catalog.response(P.PeerLibraryRequest(scope="wat", request_id=9, limit=10))
    assert payload["items"] == [] and payload["total"] == 0 and payload["hasMore"] is False
    assert payload["requestID"] == 9 and payload["scope"] == "wat"
    assert payload["libraryTrackCount"] == 2 and payload["librarySizeBytes"] == 6


def test_catalog_pagination_clamps_and_has_more(tmp_path):
    """分页：offset / limit 应答侧钳制；total = 筛选后总数；hasMore 判定正确。"""
    entries = {f"track{i}.mp3": bytes([i]) for i in range(5)}
    root, songs = _library(tmp_path, entries)
    catalog = P.build_peer_library_catalog(root=root, songs=songs)

    page = catalog.response(P.PeerLibraryRequest(scope="tracks", offset=3, limit=2))
    assert page["total"] == 5 and page["hasMore"] is False
    assert [i["track"]["relativePath"] for i in page["items"]] == ["track3.mp3", "track4.mp3"]

    clamped = catalog.response(P.PeerLibraryRequest(scope="tracks", offset=-5, limit=0))
    assert clamped["total"] == 5 and clamped["hasMore"] is True and len(clamped["items"]) == 1
    assert clamped["items"][0]["track"]["relativePath"] == "track0.mp3"

    huge = catalog.response(P.PeerLibraryRequest(scope="tracks", offset=4, limit=99_999))
    assert len(huge["items"]) == 1 and huge["hasMore"] is False

    beyond = catalog.response(P.PeerLibraryRequest(scope="tracks", offset=99, limit=10))
    assert beyond["items"] == [] and beyond["hasMore"] is False and beyond["total"] == 5


def test_catalog_query_filters_without_reorder(tmp_path):
    """搜索词只过滤不重排（相对路径 / 标题 / 歌手 contains，大小写不敏感）。"""
    root, songs = _library(
        tmp_path,
        {
            "B.mp3": b"B",
            "a.mp3": b"A",
        },
    )
    # 标题 / 歌手来自扫描字段
    songs[0]["name"], songs[0]["artist"] = "Bravo", "Zed"
    songs[1]["name"], songs[1]["artist"] = "Alpha", "Sun"
    catalog = P.build_peer_library_catalog(root=root, songs=songs)
    by_artist = catalog.response(P.PeerLibraryRequest(scope="tracks", query="sun", limit=500))
    assert [i["track"]["relativePath"] for i in by_artist["items"]] == ["a.mp3"]
    by_name = catalog.response(P.PeerLibraryRequest(scope="tracks", query="BRavo", limit=500))
    assert [i["track"]["relativePath"] for i in by_name["items"]] == ["B.mp3"]
    # 无命中 → 空页但摘要照常
    none = catalog.response(P.PeerLibraryRequest(scope="tracks", query="zzz", limit=500))
    assert none["items"] == [] and none["total"] == 0 and none["libraryTrackCount"] == 2


def test_catalog_tracks_sorted_and_deduped(tmp_path):
    """曲目归一：按相对路径升序 + 同路径去重（保留排序后最靠前者）。"""
    catalog = P.PeerLibraryCatalog(
        tracks=[
            P.PeerTrackItem(relative_path="b.mp3", size_bytes=2),
            P.PeerTrackItem(relative_path="a.mp3", size_bytes=1),
            P.PeerTrackItem(relative_path="b.mp3", size_bytes=9),
        ]
    )
    assert [t.relative_path for t in catalog.tracks] == ["a.mp3", "b.mp3"]
    assert catalog.total_size_bytes == 3


def test_catalog_playlists_sorted_by_name_and_id(tmp_path):
    """歌单归一：按 (name, id) 升序 + 按 id 去重。"""
    catalog = P.PeerLibraryCatalog(
        playlists=[
            P.PeerPlaylistItem(id="b", name="B"),
            P.PeerPlaylistItem(id="a", name="A"),
            P.PeerPlaylistItem(id="a", name="A"),
        ]
    )
    assert [p.id for p in catalog.playlists] == ["a", "b"]


def test_catalog_truncation_flag(tmp_path, monkeypatch):
    """超上限按已排序前缀截断，`truncated` 透传到响应（诊断字段）。"""
    root, songs = _library(tmp_path, {f"t{i}.mp3": bytes([i]) for i in range(3)})
    monkeypatch.setattr(P, "MAX_CATALOG_ENTRIES", 2)
    catalog = P.build_peer_library_catalog(root=root, songs=songs)
    assert len(catalog.tracks) == 2
    assert catalog.truncated is True
    payload = catalog.response(P.PeerLibraryRequest(scope="tracks", limit=500))
    assert payload["truncated"] is True and payload["libraryTrackCount"] == 2


def test_catalog_smart_sources_listed_with_names(tmp_path):
    """对端清单含 `@smart:*` 三项（固定序 + 显示名 + 自洽 trackCount）；`@library` 不出现。"""
    root, songs = _library(tmp_path, {"a.mp3": b"A", "b.mp3": b"B"})
    catalog = P.build_peer_library_catalog(root=root, songs=songs)
    ids = {p.id for p in catalog.playlists}
    for kind in L.SMART_KINDS:
        assert f"@smart:{kind}" in ids
    assert L.LIBRARY_ID not in ids
    assert L.FAVORITES_ID in ids
    named = {p.id: p.name for p in catalog.playlists}
    assert named["@smart:recentAdded"] == "最近添加"
    assert named[L.FAVORITES_ID] == "收藏"
    recent = next(p for p in catalog.playlists if p.id == "@smart:recentAdded")
    assert recent.track_count == len(catalog.member_paths["@smart:recentAdded"]) == 2


def test_catalog_shape_and_kind_discriminator(tmp_path):
    """响应形状：摘要恒返回、条目带 `kind` 判别字段（跨语言扁平联合）。"""
    root, songs = _library(tmp_path, {"Album/a.mp3": b"A"})
    payload = P.peer_library_response(
        {"scope": "playlists", "requestID": 3, "limit": 500}, root=root, songs=songs
    )
    assert payload["requestID"] == 3 and payload["scope"] == "playlists"
    assert payload["libraryTrackCount"] == 1 and payload["librarySizeBytes"] == 1
    playlist_item = next(i for i in payload["items"] if i["playlist"]["id"] == L.FAVORITES_ID)
    assert playlist_item["kind"] == "playlist" and "track" not in playlist_item

    tracks = P.peer_library_response(
        {"scope": "tracks", "requestID": 4, "limit": 500}, root=root, songs=songs
    )
    track_item = tracks["items"][0]
    assert track_item["kind"] == "track"
    assert track_item["track"]["relativePath"] == "Album/a.mp3"
    assert track_item["track"]["sizeBytes"] == 1
    assert track_item["track"]["title"] == "a"  # 扫描结果的文件名回落
    assert "artist" not in str(track_item), "歌手为空按 nil 省略（线上缺字段 = 未知）"
    assert "artistName" not in track_item["track"]
    assert "contentHash" not in track_item["track"], "缺省不哈希整库（ensure_hashes=False）"

    hashed = P.peer_library_response(
        {"scope": "tracks", "requestID": 5, "limit": 500},
        root=root,
        songs=songs,
        ensure_hashes=True,
    )
    assert hashed["items"][0]["track"]["contentHash"] == hashlib.sha256(b"A").hexdigest()


def test_catalog_empty_library(tmp_path):
    """空曲库 → 空清单（摘要 0），来源仍在但都是空歌单。"""
    root = tmp_path / "empty"
    root.mkdir()
    payload = P.peer_library_response({"scope": "tracks", "limit": 500}, root=root, songs=[])
    assert payload["items"] == [] and payload["total"] == 0
    assert payload["libraryTrackCount"] == 0 and payload["librarySizeBytes"] == 0


def test_request_payload_tolerance_and_normalization():
    """请求归一：字段缺省 / 类型异常取缺省；limit / offset 钳制；query 截断；空白 id = 全库。"""
    request = P.PeerLibraryRequest.from_payload(
        {
            "scope": "tracks",
            "playlistID": "   ",
            "query": "x" * 200,
            "offset": -5,
            "limit": 10_000,
            "requestID": "7",
        }
    )
    assert request.scope_value == "tracks"
    assert request.normalized_playlist_id is None
    assert len(request.normalized_query) == L.MAX_QUERY_LENGTH
    assert request.clamped_offset == 0
    assert request.clamped_limit == L.MAX_PAGE_LIMIT
    assert request.request_id == 0, "非数字 requestID 取缺省（宁可丢响应也不崩）"

    empty = P.PeerLibraryRequest.from_payload(None)
    assert empty.scope_value is None
    assert empty.clamped_limit == 50 and empty.limit == 50
    assert P.PeerLibraryRequest.from_payload({"scope": "tracks", "limit": 0}).clamped_limit == 1


# ============ 取文件（§11.5 / §11.6） ============
def test_resolve_library_file_ok(tmp_path):
    """根内常规文件 → 绝对路径（相对路径带子目录 / 反斜杠也能解析）。"""
    root, _ = _library(tmp_path, {"Album/01 Song.mp3": b"X"})
    resolved = L.resolve_library_file("Album/01 Song.mp3", root=root)
    assert resolved.ok and resolved.path == root / "Album" / "01 Song.mp3"
    assert L.resolve_library_file("Album\\01 Song.mp3", root=root).ok


def test_resolve_library_file_rejects_escapes(tmp_path):
    """越界一律拒绝：`..` / 绝对路径 / 空 → `invalid_path`（绝不读根外文件）。"""
    root, _ = _library(tmp_path, {"a.mp3": b"A"})
    outside = _write(tmp_path / "outside.mp3", b"SECRET")
    for raw in ("../outside.mp3", "sub/../../outside.mp3", str(outside), "", "/etc/passwd"):
        resolved = L.resolve_library_file(raw, root=root)
        assert not resolved.ok, raw
        assert resolved.reason == L.REASON_INVALID_PATH, raw


def test_resolve_library_file_missing_and_directory(tmp_path):
    """不存在 → `not_found`；目录 → `not_regular_file`。"""
    root, _ = _library(tmp_path, {"Album/a.mp3": b"A"})
    missing = L.resolve_library_file("Album/nope.mp3", root=root)
    assert missing.reason == L.REASON_NOT_FOUND
    directory = L.resolve_library_file("Album", root=root)
    assert directory.reason == L.REASON_NOT_REGULAR_FILE


def test_resolve_library_file_blocks_symlink_escape(tmp_path):
    """软链逃逸：根内软链指向根外 → `out_of_root`（纵深防御第二道）。"""
    root, _ = _library(tmp_path, {"a.mp3": b"A"})
    outside = _write(tmp_path / "outside.mp3", b"SECRET")
    link = root / "link.mp3"
    link.symlink_to(outside)
    resolved = L.resolve_library_file("link.mp3", root=root)
    assert not resolved.ok and resolved.reason == L.REASON_OUT_OF_ROOT
    # 根内软链（指向根内文件）仍可读
    inner = root / "inner.mp3"
    inner.symlink_to(root / "a.mp3")
    assert L.resolve_library_file("inner.mp3", root=root).ok


def test_fetch_plan_reports_failures_with_original_string(tmp_path):
    """取文件计划：成功项给规范化路径 + 绝对路径；失败项原样回填请求串 + reason。"""
    root, _ = _library(tmp_path, {"a.mp3": b"A"})
    ok, failed = L.fetch_plan(["a.mp3", "../etc/passwd", "gone.mp3", ""], root=root)
    assert [rel for rel, _ in ok] == ["a.mp3"]
    assert ok[0][1] == root / "a.mp3"
    assert failed == [
        {"relativePath": "../etc/passwd", "reason": L.REASON_INVALID_PATH},
        {"relativePath": "gone.mp3", "reason": L.REASON_NOT_FOUND},
        {"relativePath": "", "reason": L.REASON_INVALID_PATH},
    ]


# ============ 迁移（老库自动补齐 + 幂等 + 不丢数据） ============
_LEGACY_SCHEMA = """
CREATE TABLE favorites (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    path   TEXT NOT NULL UNIQUE,
    name   TEXT NOT NULL DEFAULT '',
    artist TEXT NOT NULL DEFAULT '',
    album  TEXT NOT NULL DEFAULT '',
    ts     TEXT NOT NULL DEFAULT ''
);
CREATE TABLE playlists (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT '',
    updatedAt TEXT NOT NULL DEFAULT ''
);
"""


def test_fingerprint_schema_added_to_legacy_db_without_data_loss(tmp_path, monkeypatch):
    """老库（无 track_fingerprints 表）→ 首次访问自动建表 + 索引，原数据条数不变。"""
    legacy = tmp_path / "legacy.db"
    conn = sqlite3.connect(legacy)
    conn.executescript(_LEGACY_SCHEMA)
    conn.execute("INSERT INTO favorites (path, name) VALUES ('/old/song.mp3', '老歌')")
    conn.execute("INSERT INTO playlists (id, name) VALUES ('p1', '旧歌单')")
    conn.commit()
    conn.close()

    monkeypatch.setattr(state, "DB_PATH", legacy)
    db.reset()
    assert db.favorites_load() == ["/old/song.mp3"]  # 老库照常可读
    assert db.track_fingerprints_load() == {}  # 新表存在且为空（不是报错）

    assert (
        db.track_fingerprints_upsert(
            [{"relative_path": "a.mp3", "content_hash": "h" * 64, "size": 3, "mtime_ms": 9}]
        )
        == 1
    )
    db.init_and_migrate()  # 再次初始化（幂等）
    assert db.track_fingerprints_load()["a.mp3"]["content_hash"] == "h" * 64

    conn = sqlite3.connect(legacy)
    try:
        assert conn.execute("SELECT COUNT(*) FROM favorites").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM playlists").fetchone()[0] == 1
        assert conn.execute("SELECT COUNT(*) FROM track_fingerprints").fetchone()[0] == 1
        indexes = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
    finally:
        conn.close()
    assert "idx_track_fingerprints_hash" in indexes


def test_fingerprint_upsert_updates_row_without_duplicates(tmp_path):
    """同一相对路径重复 upsert = 覆盖（不产生重复行）；空指纹 / 空路径条目跳过。"""
    assert (
        db.track_fingerprints_upsert(
            [
                {"relative_path": "a.mp3", "content_hash": "one", "size": 1, "mtime_ms": 1},
                {"relative_path": "a.mp3", "content_hash": "two", "size": 2, "mtime_ms": 2},
                {"relative_path": "", "content_hash": "x"},
                {"relative_path": "b.mp3", "content_hash": ""},
            ]
        )
        == 2
    )
    rows = db.track_fingerprints_load()
    assert set(rows) == {"a.mp3"}
    assert rows["a.mp3"] == {"content_hash": "two", "size": 2, "mtime_ms": 2}
