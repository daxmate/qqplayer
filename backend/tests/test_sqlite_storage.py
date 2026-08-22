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
    """首次访问自动建表：六张表齐备"""
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
    """books.json 的 progress 字段 → reading_progress 表；books.json 不重命名"""
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
    assert src.exists()  # 书架元数据源仍在，绝不改名
    assert not (tmp_path / "books.json.migrated.bak").exists()


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
    import app.routers.books as books_router

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
    assert books_router.state.books_store  # books_store 仍存在（书架元数据未迁走）


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
