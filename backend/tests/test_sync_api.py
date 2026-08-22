"""iOS companion 同步 API 测试：manifest 内容 / ops 双向应用（LWW）/ 增量游标 / 鉴权 / 容错。

运行：cd backend && /Users/dax/codes/qqplayer/backend/venv/bin/python -m pytest tests/test_sync_api.py -q
"""

import asyncio
import hashlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend  # noqa: E402
from app import db, state  # noqa: E402

client = TestClient(backend.app)

REMOTE_HOST = "192.168.1.50"  # 模拟局域网 iOS 设备（非 localhost）


def make_mp3(path: Path, title: str = "本地歌", artist: str = "本地歌手"):
    """生成带 ID3 标签的假 mp3（与 test_backend / test_stream_backend 同款）"""
    from mutagen.id3 import ID3, TIT2, TPE1

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    tags.add(TIT2(encoding=3, text=title))
    tags.add(TPE1(encoding=3, text=artist))
    tags.save(path)


@pytest.fixture(autouse=True)
def _isolate_data(tmp_path, monkeypatch):
    """数据隔离：settings / books / dicts 都写临时目录；扫描缓存每测试重置"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    monkeypatch.setattr(state, "NETWORK_SONGS_FILE", tmp_path / "network_songs.json")
    monkeypatch.setattr(state, "DICTS_DIR", tmp_path / "dicts")
    monkeypatch.setattr(state, "LIBRARY", tmp_path / "lib")
    (tmp_path / "lib").mkdir()
    state._settings = None
    state._scan_cache = None
    yield
    state._settings = None
    state._scan_cache = None


@pytest.fixture()
def local_library(tmp_path):
    """临时歌曲库：1 首带 ID3 标签的本地歌"""
    make_mp3(tmp_path / "lib" / "local.mp3")
    return tmp_path / "lib" / "local.mp3"


def _remote(method: str, path: str, host: str = REMOTE_HOST, **kwargs) -> tuple[int, dict]:
    """以指定来源 IP 发起请求（ASGITransport 注入 client host；httpx 0.28 为 async-only）"""

    async def _run():
        transport = ASGITransport(app=backend.app, client=(host, 50000))
        async with AsyncClient(transport=transport, base_url="http://testserver") as c:
            r = await c.request(method, path, **kwargs)
            try:
                body = r.json()
            except ValueError:
                body = None
            return r.status_code, body

    return asyncio.run(_run())


def _push(ops: list[dict]) -> dict:
    r = client.post("/api/sync/ops", json={"ops": ops})
    assert r.status_code == 200, r.text
    return r.json()


# ============ GET /api/sync/manifest 内容正确性 ============
def test_manifest_songs_fields(local_library):
    """songs 条目：path/name/artist/album/duration/size/mtime；size/mtime 来自文件系统"""
    m = client.get("/api/sync/manifest").json()
    assert m["version"] and m["generated_at"]
    assert m["media_url_template"] == "/api/audio?path={path}"
    assert len(m["songs"]) == 1
    s = m["songs"][0]
    assert s["path"] == str(local_library)
    assert s["name"] == "本地歌"
    assert s["artist"] == "本地歌手"
    assert s["size"] == local_library.stat().st_size
    assert s["mtime"] == int(local_library.stat().st_mtime * 1000)
    # 网络歌（path=None）不进 manifest（客户端无法离线下载）
    assert all(x.get("path") for x in m["songs"])


def test_manifest_playlists():
    """playlists：{id, name, songs}（songPaths 映射为 songs）"""
    db.playlists_save(
        [
            {
                "id": "pl1",
                "name": "练唱",
                "songPaths": ["/a.mp3", "/b.mp3"],
                "createdAt": "2026-08-22T00:00:00+00:00",
                "updatedAt": "2026-08-22T00:00:00+00:00",
            }
        ]
    )
    m = client.get("/api/sync/manifest").json()
    assert m["playlists"] == [{"id": "pl1", "name": "练唱", "songs": ["/a.mp3", "/b.mp3"]}]


def test_manifest_favorites_enriched(local_library):
    """favorites：含 path/name/artist/album/ts；表内元数据为空时用曲库扫描补齐"""
    db.favorites_toggle(str(local_library))
    m = client.get("/api/sync/manifest").json()
    assert m["favorites"] == [
        {
            "path": str(local_library),
            "name": "本地歌",
            "artist": "本地歌手",
            "album": "",
            "ts": "",
        }
    ]


def test_manifest_books_merge_progress():
    """books：books.json 书架 + reading_progress 表进度合并"""
    state.books_store.save([{"id": "b1", "title": "测试书", "author": "某作者", "addedAt": 123}])
    db.progress_set("b1", {"cfi": "epubcfi(/6/2)", "updatedAt": 100})
    db.progress_set("b2", {"cfi": "epubcfi(/6/3)", "updatedAt": 200, "location": 3})  # 无书架元数据
    m = client.get("/api/sync/manifest").json()
    assert {
        "id": "b1",
        "title": "测试书",
        "progress": {"cfi": "epubcfi(/6/2)", "updatedAt": 100},
    } in m["books"]
    # 只列出书架里的书（b2 不在书架 → 不出现）
    assert all(b["id"] != "b2" for b in m["books"])


def test_manifest_dicts_scan(tmp_path):
    """dicts：DICTS_DIR 下 MDX/MDD（含子目录），name/size/mtime/path"""
    (tmp_path / "dicts").mkdir()
    f1 = tmp_path / "dicts" / "oxford.mdx"
    f1.write_bytes(b"mdx-content")
    sub = tmp_path / "dicts" / "abc123"
    sub.mkdir()
    f2 = sub / "coca.mdd"
    f2.write_bytes(b"mdd-content")
    m = client.get("/api/sync/manifest").json()
    by_name = {d["name"]: d for d in m["dicts"]}
    assert by_name["oxford.mdx"]["size"] == 11
    assert by_name["oxford.mdx"]["path"] == "oxford.mdx"
    assert by_name["coca.mdd"]["path"] == "abc123/coca.mdd"
    assert by_name["coca.mdd"]["mtime"] == int(f2.stat().st_mtime * 1000)
    assert m["dicts_url_template"] == "/api/sync/dicts/file?path={path}"


def test_manifest_version_changes_on_data_change(local_library):
    """version：数据有变 → 版本串变化（客户端据此刷新）"""
    v1 = client.get("/api/sync/manifest").json()["version"]
    # 收藏变化（走同步写入）→ ops 游标推进 → version 变化
    _push(
        [
            {
                "entity": "favorites",
                "entity_id": str(local_library),
                "op": "add",
                "payload": {"path": str(local_library)},
                "ts": 1000,
            }
        ]
    )
    v2 = client.get("/api/sync/manifest").json()["version"]
    assert v2 != v1


# ============ POST /api/sync/ops 应用（last-write-wins） ============
def test_push_favorites_lww(local_library):
    """favorites add/remove：以 ts 大者胜"""
    p = str(local_library)
    r = _push(
        [{"entity": "favorites", "entity_id": p, "op": "add", "payload": {"path": p}, "ts": 1000}]
    )
    assert r["applied"] == 1 and r["cursor"] >= 1
    assert p in client.get("/api/favorites").json()["paths"]
    # 更旧的 add → 跳过（表内 ts=1000）
    _push([{"entity": "favorites", "entity_id": p, "op": "add", "payload": {"path": p}, "ts": 500}])
    assert p in client.get("/api/favorites").json()["paths"]
    # 更旧的 remove → 跳过（现有 1000 > 500）
    _push(
        [{"entity": "favorites", "entity_id": p, "op": "remove", "payload": {"path": p}, "ts": 900}]
    )
    assert p in client.get("/api/favorites").json()["paths"]
    # 更新的 remove → 删除
    _push(
        [
            {
                "entity": "favorites",
                "entity_id": p,
                "op": "remove",
                "payload": {"path": p},
                "ts": 1500,
            }
        ]
    )
    assert p not in client.get("/api/favorites").json()["paths"]


def test_push_favorites_toggle(local_library):
    """favorites toggle：在收藏则移除、不在则添加（对齐现有语义）"""
    p = str(local_library)
    _push(
        [
            {
                "entity": "favorites",
                "entity_id": p,
                "op": "toggle",
                "payload": {"path": p},
                "ts": 1000,
            }
        ]
    )
    assert p in client.get("/api/favorites").json()["paths"]
    _push(
        [
            {
                "entity": "favorites",
                "entity_id": p,
                "op": "toggle",
                "payload": {"path": p},
                "ts": 2000,
            }
        ]
    )
    assert p not in client.get("/api/favorites").json()["paths"]


def test_push_playlists_save_delete_lww():
    """playlists save/delete：整单 upsert，updatedAt（无则 op ts）大者胜"""
    save1 = {
        "entity": "playlists",
        "entity_id": "pl1",
        "op": "save",
        "payload": {"id": "pl1", "name": "A", "songs": ["/a.mp3"]},
        "ts": 1000,
    }
    _push([save1])
    pls = client.get("/api/playlists").json()["playlists"]
    assert any(p["id"] == "pl1" and p["name"] == "A" and p["songPaths"] == ["/a.mp3"] for p in pls)
    # 更旧 save → 跳过
    _push(
        [
            {
                "entity": "playlists",
                "entity_id": "pl1",
                "op": "save",
                "payload": {"id": "pl1", "name": "OLD", "songs": []},
                "ts": 500,
            }
        ]
    )
    pls = client.get("/api/playlists").json()["playlists"]
    assert next(p for p in pls if p["id"] == "pl1")["name"] == "A"
    # 更新 save → 覆盖整单
    _push(
        [
            {
                "entity": "playlists",
                "entity_id": "pl1",
                "op": "save",
                "payload": {"id": "pl1", "name": "B", "songs": ["/a.mp3", "/b.mp3"]},
                "ts": 2000,
            }
        ]
    )
    pls = client.get("/api/playlists").json()["playlists"]
    assert next(p for p in pls if p["id"] == "pl1")["name"] == "B"
    assert next(p for p in pls if p["id"] == "pl1")["songPaths"] == ["/a.mp3", "/b.mp3"]
    # 更旧 delete → 保留
    _push(
        [
            {
                "entity": "playlists",
                "entity_id": "pl1",
                "op": "delete",
                "payload": {"id": "pl1"},
                "ts": 1500,
            }
        ]
    )
    assert any(p["id"] == "pl1" for p in client.get("/api/playlists").json()["playlists"])
    # 更新 delete → 删除
    _push(
        [
            {
                "entity": "playlists",
                "entity_id": "pl1",
                "op": "delete",
                "payload": {"id": "pl1"},
                "ts": 2500,
            }
        ]
    )
    assert not any(p["id"] == "pl1" for p in client.get("/api/playlists").json()["playlists"])


def test_push_reading_progress_lww():
    """reading_progress save：updatedAt 大者胜"""
    _push(
        [
            {
                "entity": "reading_progress",
                "entity_id": "b1",
                "op": "save",
                "payload": {"book_id": "b1", "cfi": "epubcfi(/6/1)", "updatedAt": 100},
            }
        ]
    )
    assert db.progress_get("b1")["cfi"] == "epubcfi(/6/1)"
    _push(
        [
            {
                "entity": "reading_progress",
                "entity_id": "b1",
                "op": "save",
                "payload": {"book_id": "b1", "cfi": "epubcfi(/6/0)", "updatedAt": 50},
            }
        ]
    )
    assert db.progress_get("b1")["cfi"] == "epubcfi(/6/1)"  # 旧的被跳过
    _push(
        [
            {
                "entity": "reading_progress",
                "entity_id": "b1",
                "op": "save",
                "payload": {
                    "book_id": "b1",
                    "cfi": "epubcfi(/6/2)",
                    "location": 42,
                    "updatedAt": 200,
                },
            }
        ]
    )
    assert db.progress_get("b1") == {"cfi": "epubcfi(/6/2)", "location": 42, "updatedAt": 200}


def test_push_playback_events_append():
    """playback_events append：追加不合并；字段规整"""
    _push(
        [
            {
                "entity": "playback_events",
                "entity_id": "",
                "op": "append",
                "payload": {
                    "path": "/a.mp3",
                    "name": "A",
                    "played": 12.5,
                    "duration": 100,
                    "ratio": 0.125,
                    "completed": True,
                },
                "ts": "2026-08-22T00:00:00+00:00",
            }
        ]
    )
    records = client.get("/api/playback").json()["records"]
    assert len(records) == 1
    r = records[0]
    assert r["path"] == "/a.mp3" and r["name"] == "A"
    assert r["played"] == 12.5 and r["completed"] is True
    # 再 append 一条不合并
    _push(
        [
            {
                "entity": "playback_events",
                "entity_id": "",
                "op": "append",
                "payload": {"path": "/b.mp3", "played": 3.0},
                "ts": 1,
            }
        ]
    )
    assert len(client.get("/api/playback").json()["records"]) == 2


def test_push_empty_ops():
    """空 ops 数组 → applied 0，cursor 0"""
    r = _push([])
    assert r == {"applied": 0, "cursor": 0}


def test_push_multiple_ops_batch():
    """一批多实体 ops：逐条应用 + 全部进 ops 日志"""
    p = "/x.mp3"
    _push(
        [
            {"entity": "favorites", "entity_id": p, "op": "add", "payload": {"path": p}, "ts": 1},
            {
                "entity": "reading_progress",
                "entity_id": "bk",
                "op": "save",
                "payload": {"book_id": "bk", "cfi": "c", "updatedAt": 1},
            },
            {
                "entity": "playback_events",
                "entity_id": "",
                "op": "append",
                "payload": {"path": p, "played": 5},
            },
        ]
    )
    assert p in client.get("/api/favorites").json()["paths"]
    assert db.progress_get("bk")["cfi"] == "c"
    assert len(client.get("/api/playback").json()["records"]) == 1
    ops = client.get("/api/sync/ops", params={"since": 0}).json()["ops"]
    assert len(ops) == 3


# ============ GET /api/sync/ops 增量游标 ============
def test_ops_pull_incremental_cursor():
    """拉增量：id > since 升序；cursor = 最新 id；重放后记 cursor 可续拉"""
    p = "/a.mp3"
    c1 = _push(
        [{"entity": "favorites", "entity_id": p, "op": "add", "payload": {"path": p}, "ts": 1}]
    )["cursor"]
    c2 = _push(
        [{"entity": "favorites", "entity_id": p, "op": "remove", "payload": {"path": p}, "ts": 2}]
    )["cursor"]
    assert c2 > c1
    first = client.get("/api/sync/ops", params={"since": 0}).json()
    assert len(first["ops"]) == 2 and first["cursor"] == c2
    assert [o["id"] for o in first["ops"]] == [c1, c2]  # 升序
    inc = client.get("/api/sync/ops", params={"since": c1}).json()
    assert len(inc["ops"]) == 1 and inc["ops"][0]["id"] == c2
    assert inc["cursor"] == c2
    # 已消费完 → 空增量，cursor 保持
    empty = client.get("/api/sync/ops", params={"since": c2}).json()
    assert empty == {"ops": [], "cursor": c2}


def test_ops_pull_echoes_pushed_op_fields():
    """拉回的 op 字段与 push 一致（entity/entity_id/op/payload/ts/id）"""
    ts = "2026-08-22T08:00:00+00:00"
    _push(
        [
            {
                "entity": "favorites",
                "entity_id": "/a.mp3",
                "op": "add",
                "payload": {"path": "/a.mp3", "name": "A"},
                "ts": ts,
            }
        ]
    )
    op = client.get("/api/sync/ops", params={"since": 0}).json()["ops"][0]
    assert op["entity"] == "favorites"
    assert op["entity_id"] == "/a.mp3"
    assert op["op"] == "add"
    assert op["payload"] == {"path": "/a.mp3", "name": "A"}
    assert op["ts"] == ts
    assert isinstance(op["id"], int)


# ============ 鉴权（中间件覆盖，测试 401 场景） ============
def _pair_token(device_id="iphone-01"):
    """直接落盘一个已配对设备（token 只存哈希）→ 返回明文 token"""
    token = "test-sync-token-abc"
    data = state.pairing_store.load()
    data.setdefault("devices", []).append(
        {
            "device_id": device_id,
            "device_name": "iPhone 15",
            "device_type": "ios",
            "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "paired_at": "2026-08-22T00:00:00+00:00",
        }
    )
    state.pairing_store.save(data)
    return token


def test_sync_requires_token(monkeypatch):
    """鉴权开启 + 非 localhost：manifest / ops push / ops pull 无 token → 401"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    for method, path in (
        ("GET", "/api/sync/manifest"),
        ("GET", "/api/sync/ops?since=0"),
        ("POST", "/api/sync/ops"),
    ):
        code, body = _remote(method, path, json={"ops": []} if method == "POST" else None)
        assert code == 401, (method, path, code)
        assert body == {"detail": "未授权：缺少或无效的配对 token"}


def test_sync_with_valid_token(monkeypatch):
    """带有效 Bearer token → 200；manifest 内容正常"""
    monkeypatch.setattr(state, "AUTH_ENABLED", True)
    token = _pair_token()
    code, body = _remote("GET", "/api/sync/manifest", headers={"Authorization": f"Bearer {token}"})
    assert code == 200
    assert body["version"] and body["songs"] == []
    code, body = _remote(
        "POST", "/api/sync/ops", json={"ops": []}, headers={"Authorization": f"Bearer {token}"}
    )
    assert code == 200 and body == {"applied": 0, "cursor": 0}
    # 无效 token → 401
    code, _ = _remote("GET", "/api/sync/manifest", headers={"Authorization": "Bearer wrong-token"})
    assert code == 401


def test_sync_localhost_no_auth():
    """localhost（本机）免鉴权（与现有鉴权中间件规则一致）"""
    code, body = _remote("GET", "/api/sync/manifest", host="127.0.0.1")
    assert code == 200 and body["version"]


# ============ payload 非法容错（400） ============
def test_invalid_payload_400():
    """非法 payload 整批拒绝 400：缺 ops / 非数组 / 未知实体 / 缺字段 / 类型错"""
    cases = [
        {},  # 缺 ops
        {"ops": "not-a-list"},
        {"ops": [{"entity": "unknown", "op": "x", "payload": {}}]},
        {"ops": [{"entity": "favorites", "op": "add", "payload": {}}]},  # 缺 path
        {"ops": [{"entity": "favorites", "op": "flip", "payload": {"path": "/a.mp3"}}]},  # 非法 op
        {"ops": [{"entity": "playlists", "op": "save", "payload": {"id": "p1", "songs": "abc"}}]},
        {
            "ops": [
                {"entity": "playlists", "op": "save", "payload": {"name": "x", "songs": [1, 2]}}
            ]
        },  # 缺 id
        {
            "ops": [
                {
                    "entity": "reading_progress",
                    "op": "save",
                    "payload": {"book_id": "b1", "cfi": "", "updatedAt": 1},
                }
            ]
        },  # cfi 空
        {
            "ops": [
                {
                    "entity": "reading_progress",
                    "op": "save",
                    "payload": {"book_id": "b1", "cfi": "c", "updatedAt": "now"},
                }
            ]
        },  # updatedAt 非数字
        {"ops": [{"entity": "playback_events", "op": "append", "payload": {}}]},  # 缺 path
    ]
    for body in cases:
        r = client.post("/api/sync/ops", json=body)
        assert r.status_code == 400, (body, r.status_code)
        assert r.json()["detail"]


def test_invalid_payload_atomic_no_partial_apply():
    """一批里混非法 op → 400 且整批不应用（不部分落盘）"""
    p = "/atomic.mp3"
    body = {
        "ops": [
            {"entity": "favorites", "entity_id": p, "op": "add", "payload": {"path": p}, "ts": 1},
            {"entity": "unknown_entity", "op": "x", "payload": {}},
        ]
    }
    r = client.post("/api/sync/ops", json=body)
    assert r.status_code == 400
    assert p not in client.get("/api/favorites").json()["paths"]
    assert client.get("/api/sync/ops", params={"since": 0}).json()["ops"] == []


def test_pull_invalid_since():
    """since 非数字 → 422（FastAPI 参数校验），负数 → 422"""
    assert client.get("/api/sync/ops", params={"since": "abc"}).status_code == 422
    assert client.get("/api/sync/ops", params={"since": -1}).status_code == 422


# ============ dicts 文件下载 ============
def test_dicts_file_download(tmp_path):
    """GET /api/sync/dicts/file：正常下载 / 目录穿越 400 / 不存在 404 / 非词典扩展名 400"""
    d = tmp_path / "dicts"
    d.mkdir()
    (d / "oxford.mdx").write_bytes(b"mdx-bytes")
    r = client.get("/api/sync/dicts/file", params={"path": "oxford.mdx"})
    assert r.status_code == 200 and r.content == b"mdx-bytes"
    # 目录穿越 / 绝对路径 / 非法扩展名 → 400
    for bad in ("../secret.mdx", "/etc/passwd", "sub/../../x.mdx", "notes.txt"):
        assert client.get("/api/sync/dicts/file", params={"path": bad}).status_code == 400, bad
    # 不存在 → 404
    assert client.get("/api/sync/dicts/file", params={"path": "nope.mdx"}).status_code == 404
