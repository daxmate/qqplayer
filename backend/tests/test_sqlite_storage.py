"""SQLite 存储层测试：建表 / JSON→SQLite 自动迁移（含幂等）/ DAO 读写 / ops 游标 / 滚动截断。

运行：cd backend && ./venv/bin/python -m pytest tests/test_sqlite_storage.py -q
"""

import json
import sqlite3
import threading

from fastapi.testclient import TestClient

import backend  # noqa: F401
from app import db, state

client = TestClient(backend.app)

_TABLES = (
    "favorites",
    "playlists",
    "playlist_songs",
    "playback_events",
    "reading_progress",
    "ops",
    "kv_store",
)


def _table_names(tmp_path) -> set[str]:
    conn = sqlite3.connect(tmp_path / "qqplayer_test.db")
    try:
        return {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
            )
        }
    finally:
        conn.close()


# ============ 建表 ============
def test_schema_created_on_first_access(tmp_path):
    """首次访问自动建表：七张表齐备"""
    assert db.favorites_load() == []
    names = _table_names(tmp_path)
    for t in _TABLES:
        assert t in names, f"缺少表 {t}"


def test_wal_mode_enabled(tmp_path):
    """WAL 模式开启（持久化在库内）"""
    db.favorites_load()  # 触发初始化
    conn = sqlite3.connect(tmp_path / "qqplayer_test.db")
    try:
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    finally:
        conn.close()


# ============ JSON → SQLite 自动迁移 ============
def test_migrate_favorites(tmp_path, monkeypatch):
    """favorites.json → favorites 表；旧文件改名 .migrated.bak"""
    src = tmp_path / "favorites.json"
    src.write_text(json.dumps(["/a.mp3", "/b.mp3"]), encoding="utf-8")
    monkeypatch.setattr(state, "FAVORITES_FILE", src)
    assert db.favorites_load() == ["/a.mp3", "/b.mp3"]
    assert not src.exists()
    assert (tmp_path / "favorites.json.migrated.bak").exists()


def test_migrate_playlists(tmp_path, monkeypatch):
    """playlists.json → playlists + playlist_songs 表（重复路径保留）；旧文件改名"""
    src = tmp_path / "playlists.json"
    src.write_text(
        json.dumps(
            [
                {"id": "p1", "name": "歌单", "songPaths": ["/a.mp3", "/a.mp3", "/b.mp3"]},
                {"id": "p2", "name": "空", "songPaths": []},
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(state, "PLAYLISTS_FILE", src)
    pls = db.playlists_load()
    assert [p["id"] for p in pls] == ["p1", "p2"]
    assert pls[0]["songPaths"] == ["/a.mp3", "/a.mp3", "/b.mp3"]
    assert pls[1]["songPaths"] == []
    assert (tmp_path / "playlists.json.migrated.bak").exists()


def test_migrate_playback(tmp_path, monkeypatch):
    """playback.json → playback_events 表；字段对齐；旧文件改名"""
    src = tmp_path / "playback.json"
    src.write_text(
        json.dumps(
            [
                {
                    "ts": "2026-01-01T00:00:00+00:00",
                    "path": "/a.mp3",
                    "name": "A",
                    "artist": "X",
                    "album": "Y",
                    "played": 180.5,
                    "duration": 200.0,
                    "ratio": 0.9,
                    "completed": True,
                    "source": "manual",
                    "mode": "continuous",
                    "device": "mac",
                }
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(state, "PLAYBACK_FILE", src)
    records = db.playback_all()
    assert len(records) == 1
    r = records[0]
    assert r["path"] == "/a.mp3" and r["completed"] is True and r["played"] == 180.5
    assert r["ratio"] == 0.9 and r["device"] == "mac"
    assert (tmp_path / "playback.json.migrated.bak").exists()


def test_migrate_reading_progress(tmp_path, monkeypatch):
    """books.json：progress 字段先迁 reading_progress 表，整份再迁 kv_store[books] 并改名。

    顺序保证（P2-B）：进度迁移必须赶在 books.json 被改名之前，否则进度丢失。
    """
    src = tmp_path / "books.json"
    src.write_text(
        json.dumps(
            [
                {
                    "id": "b1",
                    "title": "书一",
                    "progress": {"cfi": "epubcfi(/6/2)", "updatedAt": 123},
                },
                {
                    "id": "b2",
                    "title": "书二",
                    "progress": {"cfi": "epubcfi(/6/8!/4)", "location": 0.42, "updatedAt": 456},
                },
                {"id": "b3", "title": "未读", "progress": None},
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(state, "BOOKS_FILE", src)
    assert db.progress_get("b1") == {"cfi": "epubcfi(/6/2)", "updatedAt": 123}
    assert db.progress_get("b2") == {"cfi": "epubcfi(/6/8!/4)", "location": 0.42, "updatedAt": 456}
    assert db.progress_get("b3") is None
    # 书架元数据整份进 kv_store[books]（原字段原样保留），旧文件改名 .migrated.bak
    books = db.books_load()
    assert [b["id"] for b in books] == ["b1", "b2", "b3"]
    assert books[0]["progress"] == {"cfi": "epubcfi(/6/2)", "updatedAt": 123}
    assert not src.exists()
    assert (tmp_path / "books.json.migrated.bak").exists()


def test_migrate_all_via_first_api_touch(tmp_path, monkeypatch):
    """API 首次访问触发全量迁移：三文件导入 + 改名"""
    for name, data in (
        ("favorites.json", ["/a.mp3"]),
        ("playlists.json", [{"id": "p1", "name": "歌单", "songPaths": ["/a.mp3"]}]),
        (
            "playback.json",
            [{"ts": "2026-01-01T00:00:00+00:00", "path": "/a.mp3", "played": 10}],
        ),
    ):
        p = tmp_path / name
        p.write_text(json.dumps(data), encoding="utf-8")
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    monkeypatch.setattr(state, "PLAYLISTS_FILE", tmp_path / "playlists.json")
    monkeypatch.setattr(state, "PLAYBACK_FILE", tmp_path / "playback.json")
    assert client.get("/api/favorites").json() == {"paths": ["/a.mp3"]}
    assert client.get("/api/playlists").json()["playlists"][0]["songPaths"] == ["/a.mp3"]
    assert client.get("/api/playback").json()["count"] == 1
    for name in ("favorites.json", "playlists.json", "playback.json"):
        assert (tmp_path / f"{name}.migrated.bak").exists()
        assert not (tmp_path / name).exists()


def test_migrate_idempotent_table_not_empty(tmp_path, monkeypatch):
    """幂等：表已有数据 → 跳过导入，旧文件不动（不重复导入不重复改名）"""
    src = tmp_path / "favorites.json"
    monkeypatch.setattr(state, "FAVORITES_FILE", src)
    db.favorites_save(["/already.mp3"])  # 先有数据（此时 JSON 还不存在，不会触发导入）
    src.write_text(json.dumps(["/z.mp3"]), encoding="utf-8")
    db.reset()  # 模拟重启：表非空 → 跳过导入
    assert db.favorites_load() == ["/already.mp3"]  # 不被 JSON 覆盖
    assert src.exists()  # 文件未被改名


def test_migrate_invalid_json_does_not_block(tmp_path, monkeypatch, caplog):
    """迁移失败不阻断：损坏 JSON → 空结果 + warning 日志 + 文件保留（下次再试）"""
    src = tmp_path / "favorites.json"
    src.write_text("{not valid json", encoding="utf-8")
    monkeypatch.setattr(state, "FAVORITES_FILE", src)
    with caplog.at_level("WARNING"):
        assert db.favorites_load() == []
    assert src.exists()  # 未改名，下次启动可重试
    assert any("favorites.json" in r.message for r in caplog.records)


# ============ favorites DAO ============
def test_favorites_toggle_and_save(tmp_path):
    db.favorites_toggle("/a.mp3")
    db.favorites_toggle("/b.mp3")
    assert db.favorites_load() == ["/a.mp3", "/b.mp3"]
    # 再点取消
    assert db.favorites_toggle("/a.mp3") is False
    assert db.favorites_load() == ["/b.mp3"]
    # 全量重写（等价原 JSON save）
    db.favorites_save(["/x.mp3", "/y.mp3"])
    assert db.favorites_load() == ["/x.mp3", "/y.mp3"]


def test_favorites_remove_and_replace(tmp_path):
    db.favorites_save(["/a.mp3", "/b.mp3"])
    db.favorites_remove(["/a.mp3", "/nope.mp3"])
    assert db.favorites_load() == ["/b.mp3"]
    db.favorites_replace_path("/b.mp3", "/b-new.mp3")
    assert db.favorites_load() == ["/b-new.mp3"]
    # 无命中不写（不报错）
    db.favorites_replace_path("/ghost.mp3", "/x.mp3")
    assert db.favorites_load() == ["/b-new.mp3"]
    # new 已存在时合并去重，不违反 UNIQUE
    db.favorites_save(["/a.mp3", "/b-new.mp3"])
    db.favorites_replace_path("/a.mp3", "/b-new.mp3")
    assert db.favorites_load() == ["/b-new.mp3"]


# ============ playlists DAO ============
def test_playlists_save_load_roundtrip(tmp_path):
    db.playlists_save(
        [
            {
                "id": "p1",
                "name": "A",
                "songPaths": ["/1.mp3", "/1.mp3", "/2.mp3"],
                "createdAt": "t1",
                "updatedAt": "t2",
            },
            {"id": "p2", "name": "B", "songPaths": [], "createdAt": "t3", "updatedAt": "t4"},
        ]
    )
    pls = db.playlists_load()
    assert len(pls) == 2
    assert pls[0]["name"] == "A" and pls[0]["songPaths"] == ["/1.mp3", "/1.mp3", "/2.mp3"]
    assert pls[0]["createdAt"] == "t1" and pls[0]["updatedAt"] == "t2"
    assert pls[1]["songPaths"] == []
    # 重写后旧数据被替换
    db.playlists_save([{"id": "p1", "name": "A2", "songPaths": ["/3.mp3"]}])
    assert db.playlists_load()[0] == {
        "id": "p1",
        "name": "A2",
        "songPaths": ["/3.mp3"],
        "createdAt": "",
        "updatedAt": "",
    }


def test_playlists_remove_and_replace_path(tmp_path):
    db.playlists_save(
        [
            {"id": "p1", "name": "A", "songPaths": ["/a.mp3", "/b.mp3"]},
            {"id": "p2", "name": "B", "songPaths": ["/a.mp3"]},
        ]
    )
    db.playlists_remove_paths(["/a.mp3", "/ghost.mp3"])
    assert db.playlists_load()[0]["songPaths"] == ["/b.mp3"]
    assert db.playlists_load()[1]["songPaths"] == []
    db.playlists_replace_path("/b.mp3", "/b-new.mp3")
    assert db.playlists_load()[0]["songPaths"] == ["/b-new.mp3"]
    db.playlists_replace_path("/ghost.mp3", "/x.mp3")  # 无命中不写
    assert db.playlists_load()[0]["songPaths"] == ["/b-new.mp3"]


# ============ playback DAO ============
def _rec(**overrides):
    r = {
        "ts": "2026-08-12T12:00:00+00:00",
        "path": "/songs/a.mp3",
        "name": "A",
        "artist": "X",
        "album": "Y",
        "played": 180.5,
        "duration": 200.0,
        "ratio": 0.9,
        "completed": False,
        "source": "manual",
        "mode": "continuous",
        "device": "mac",
    }
    r.update(overrides)
    return r


def test_playback_append_all(tmp_path, monkeypatch):
    db.playback_append(_rec())
    db.playback_append(_rec(path="/songs/b.mp3", completed=True))
    records = db.playback_all()
    assert len(records) == 2
    assert records[0]["path"] == "/songs/a.mp3" and records[0]["completed"] is False
    assert records[1]["path"] == "/songs/b.mp3" and records[1]["completed"] is True
    # 改名迁移
    db.playback_replace_path("/songs/a.mp3", "/songs/a-new.mp3")
    assert db.playback_all()[0]["path"] == "/songs/a-new.mp3"
    db.playback_replace_path("/ghost.mp3", "/x.mp3")  # 无命中不写


def test_playback_rollover_limit(tmp_path, monkeypatch):
    """滚动截断：超过 PLAYBACK_LIMIT 删最旧（保留最近 N 条）"""
    monkeypatch.setattr(state, "PLAYBACK_LIMIT", 3)
    for i in range(5):
        db.playback_append(_rec(path=f"/songs/{i}.mp3"))
    records = db.playback_all()
    assert [r["path"] for r in records] == ["/songs/2.mp3", "/songs/3.mp3", "/songs/4.mp3"]


def test_playback_thread_safety(tmp_path):
    """多线程并发追加：无丢失（全局写锁 + 短连接）"""
    errors = []

    def worker(base):
        try:
            for i in range(25):
                db.playback_append(_rec(path=f"/t/{base}/{i}.mp3"))
        except Exception as e:  # pragma: no cover
            errors.append(e)

    threads = [threading.Thread(target=worker, args=(n,)) for n in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not errors
    assert len(db.playback_all()) == 50


# ============ reading_progress DAO ============
def test_progress_set_get_delete(tmp_path):
    assert db.progress_get("b1") is None
    db.progress_set("b1", {"cfi": "epubcfi(/6/2)", "updatedAt": 123})
    db.progress_set("b2", {"cfi": "epubcfi(/6/8!/4)", "location": 0.5, "updatedAt": 456})
    assert db.progress_get("b1") == {"cfi": "epubcfi(/6/2)", "updatedAt": 123}
    assert db.progress_get("b2") == {"cfi": "epubcfi(/6/8!/4)", "location": 0.5, "updatedAt": 456}
    assert db.progress_all() == {
        "b1": {"cfi": "epubcfi(/6/2)", "updatedAt": 123},
        "b2": {"cfi": "epubcfi(/6/8!/4)", "location": 0.5, "updatedAt": 456},
    }
    # upsert 覆盖
    db.progress_set("b1", {"cfi": "epubcfi(/6/9)", "updatedAt": 999})
    assert db.progress_get("b1") == {"cfi": "epubcfi(/6/9)", "updatedAt": 999}
    db.progress_delete("b1")
    assert db.progress_get("b1") is None


# ============ ops（同步基础表） ============
def test_ops_append_and_list_since(tmp_path):
    assert db.ops_list_since() == []
    id1 = db.ops_append(
        "favorites", "/a.mp3", "add", {"path": "/a.mp3"}, ts="2026-01-01T00:00:00+00:00"
    )
    id2 = db.ops_append("playback", "r1", "upsert", {"played": 10})
    id3 = db.ops_append("favorites", "/b.mp3", "add", {"path": "/b.mp3"})
    assert id1 < id2 < id3  # 自增游标
    since0 = db.ops_list_since(0)
    assert [o["id"] for o in since0] == [id1, id2, id3]
    assert since0[0]["entity"] == "favorites" and since0[0]["entity_id"] == "/a.mp3"
    assert since0[0]["op"] == "add" and since0[0]["payload"] == {"path": "/a.mp3"}
    assert since0[0]["ts"] == "2026-01-01T00:00:00+00:00"
    # 游标语义：只拉 id > cursor
    since2 = db.ops_list_since(id2)
    assert [o["id"] for o in since2] == [id3]
    # limit 防单次过大
    assert len(db.ops_list_since(0, limit=2)) == 2
    # 未传 ts 自动补（第二条记录）
    assert db.ops_list_since(0)[1]["ts"]


# ============ API 集成 ============
def test_api_progress_merged_in_books_list(tmp_path, monkeypatch):
    """GET /api/books 合并 SQLite 进度；PUT 只写 SQLite"""
    books_file = tmp_path / "books.json"
    books_file.write_text(
        json.dumps(
            [
                {"id": "b1", "title": "书一", "addedAt": 1, "progress": None},
                {"id": "b2", "title": "书二", "addedAt": 2, "progress": None},
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(state, "BOOKS_FILE", books_file)
    monkeypatch.setattr(state, "BOOKS_DIR", tmp_path / "books")
    assert (
        client.put(
            "/api/books/b1/progress", json={"cfi": "epubcfi(/6/2)", "updatedAt": 123}
        ).status_code
        == 200
    )
    books = {b["id"]: b for b in client.get("/api/books").json()}
    assert books["b1"]["progress"] == {"cfi": "epubcfi(/6/2)", "updatedAt": 123}
    assert books["b2"]["progress"] is None
    # 未读返回 null
    assert client.get("/api/books/b2/progress").json() is None
    # P2-B：书架元数据已迁 kv_store[books]（books_store 退役，旧 JSON 自动迁移）
    assert [b["id"] for b in db.books_load()] == ["b1", "b2"]
    assert not (tmp_path / "books.json").exists()  # 旧文件已改名 .migrated.bak
    assert (tmp_path / "books.json.migrated.bak").exists()


def test_api_favorites_backed_by_sqlite(tmp_path, monkeypatch):
    """API 写收藏后，数据在 SQLite 而非 JSON 文件"""
    src = tmp_path / "favorites.json"
    monkeypatch.setattr(state, "FAVORITES_FILE", src)
    assert client.post("/api/favorites/toggle", json={"path": "/a.mp3"}).json() == {
        "path": "/a.mp3",
        "favorited": True,
    }
    assert not src.exists()  # 不写 JSON
    assert db.favorites_load() == ["/a.mp3"]


# ============ 统一 KV 存储（P2-B：queue_order/network_songs/books/annotations/vocab/pairing） ============
def test_kv_defaults_and_roundtrip(tmp_path):
    """六域默认值 + load/save 往返（默认值照 state.py 旧 store 定义）"""
    assert db.queue_order_load() == []
    assert db.network_songs_load() == []
    assert db.books_load() == []
    assert db.annotations_load() == {}
    assert db.vocab_load() == []
    assert db.pairing_load() == {"devices": [], "pending": []}
    # 往返：queue_order（列表）
    db.queue_order_save(["/a.mp3", "stream:1"])
    assert db.queue_order_load() == ["/a.mp3", "stream:1"]
    # 往返：annotations（按书 dict）
    db.annotations_save(
        {"b1": {"highlights": [{"id": "hl_1", "cfi": "c"}], "bookmarks": [], "notes": []}}
    )
    assert db.annotations_load()["b1"]["highlights"][0]["id"] == "hl_1"
    # 往返：pairing（dict + 嵌套列表）
    db.pairing_save({"devices": [{"device_id": "d1"}], "pending": [], "server_id": "s1"})
    got = db.pairing_load()
    assert got["devices"] == [{"device_id": "d1"}] and got["server_id"] == "s1"
    # 覆盖写入：整份替换（等价原 JSON save 语义）
    db.pairing_save({"devices": [], "pending": []})
    assert db.pairing_load() == {"devices": [], "pending": []}


def test_kv_default_deepcopy_not_shared(tmp_path):
    """默认值深拷贝：调用方改动 load 结果不污染默认值（等价 JsonStore 语义）"""
    items = db.vocab_load()
    items.append({"id": "vw_x", "word": "x", "addedAt": 1})
    assert db.vocab_load() == []  # 默认值未被污染
    pairing = db.pairing_load()
    pairing["devices"].append({"device_id": "d1"})
    assert db.pairing_load() == {"devices": [], "pending": []}


def test_kv_corrupt_value_falls_back_default(tmp_path, caplog):
    """KV 值损坏（非法 JSON）→ 回默认值 + warning，原值保留（下次 save 覆盖）"""
    db.queue_order_save(["/a.mp3"])
    conn = sqlite3.connect(tmp_path / "qqplayer_test.db")
    try:
        conn.execute("UPDATE kv_store SET value='{bad json' WHERE key='queue_order'")
        conn.commit()
    finally:
        conn.close()
    with caplog.at_level("WARNING"):
        assert db.queue_order_load() == []
    assert any("queue_order" in r.message for r in caplog.records)
    # 原值仍保留在库里（保守不删），save 后可恢复
    db.queue_order_save(["/b.mp3"])
    assert db.queue_order_load() == ["/b.mp3"]


def test_migrate_kv_queue_order_network_songs(tmp_path, monkeypatch):
    """queue_order.json / network_songs.json → kv_store；旧文件改名"""
    q = tmp_path / "queue_order.json"
    q.write_text(json.dumps(["/a.mp3", "stream:1"]), encoding="utf-8")
    n = tmp_path / "network_songs.json"
    n.write_text(
        json.dumps([{"id": "1", "provider": "netease", "title": "T", "addedAt": "2026-01-01"}]),
        encoding="utf-8",
    )
    monkeypatch.setattr(state, "QUEUE_ORDER_FILE", q)
    monkeypatch.setattr(state, "NETWORK_SONGS_FILE", n)
    assert db.queue_order_load() == ["/a.mp3", "stream:1"]
    assert db.network_songs_load()[0]["title"] == "T"
    assert not q.exists() and (tmp_path / "queue_order.json.migrated.bak").exists()
    assert not n.exists() and (tmp_path / "network_songs.json.migrated.bak").exists()


def test_migrate_kv_annotations_vocab_pairing(tmp_path, monkeypatch):
    """annotations.json / vocab.json / pairing.json → kv_store；旧文件改名"""
    a = tmp_path / "annotations.json"
    a.write_text(
        json.dumps(
            {"b1": {"highlights": [{"id": "hl_1", "createdAt": 1}], "bookmarks": [], "notes": []}}
        ),
        encoding="utf-8",
    )
    v = tmp_path / "vocab.json"
    v.write_text(json.dumps([{"id": "vw_1", "word": "hello", "addedAt": 2}]), encoding="utf-8")
    p = tmp_path / "pairing.json"
    p.write_text(json.dumps({"devices": [{"device_id": "d1"}], "pending": []}), encoding="utf-8")
    monkeypatch.setattr(state, "ANNOTATIONS_FILE", a)
    monkeypatch.setattr(state, "VOCAB_FILE", v)
    monkeypatch.setattr(state, "PAIRING_FILE", p)
    assert db.annotations_load()["b1"]["highlights"][0]["id"] == "hl_1"
    assert db.vocab_load()[0]["word"] == "hello"
    assert db.pairing_load()["devices"][0]["device_id"] == "d1"
    for name in ("annotations.json", "vocab.json", "pairing.json"):
        assert not (tmp_path / name).exists()
        assert (tmp_path / f"{name}.migrated.bak").exists()


def test_migrate_kv_idempotent_key_not_empty(tmp_path, monkeypatch):
    """幂等：key 已有数据 → 跳过导入，旧文件不动"""
    src = tmp_path / "queue_order.json"
    monkeypatch.setattr(state, "QUEUE_ORDER_FILE", src)
    db.queue_order_save(["/already.mp3"])  # 先有数据（JSON 尚不存在，不会触发导入）
    src.write_text(json.dumps(["/z.mp3"]), encoding="utf-8")
    db.reset()  # 模拟重启：key 非空 → 跳过导入
    assert db.queue_order_load() == ["/already.mp3"]  # 不被 JSON 覆盖
    assert src.exists()  # 文件未被改名


def test_migrate_kv_invalid_json_does_not_block(tmp_path, monkeypatch, caplog):
    """迁移失败不阻断：损坏 JSON → 回默认 + warning + 文件保留（下次再试）"""
    src = tmp_path / "pairing.json"
    src.write_text("{not valid json", encoding="utf-8")
    monkeypatch.setattr(state, "PAIRING_FILE", src)
    with caplog.at_level("WARNING"):
        assert db.pairing_load() == {"devices": [], "pending": []}
    assert src.exists()  # 未改名，下次启动可重试
    assert any("pairing.json" in r.message for r in caplog.records)


def test_migrate_kv_wrong_shape_skipped(tmp_path, monkeypatch, caplog):
    """结构异常（JSON 合法但与默认值类型不符）→ 跳过导入，文件保留"""
    src = tmp_path / "vocab.json"
    src.write_text(json.dumps({"not": "a list"}), encoding="utf-8")  # vocab 应为数组
    monkeypatch.setattr(state, "VOCAB_FILE", src)
    with caplog.at_level("WARNING"):
        assert db.vocab_load() == []
    assert src.exists()
    assert not (tmp_path / "vocab.json.migrated.bak").exists()
