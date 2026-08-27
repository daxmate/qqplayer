"""iOS companion 同步 API 测试：manifest 内容 / ops 双向应用（LWW）/ 增量游标 / 鉴权 / 容错。

运行：cd backend && /Users/dax/codes/qqplayer/backend/venv/bin/python -m pytest tests/test_sync_api.py -q
"""

import asyncio
import hashlib
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend  # noqa: E402
from app import db, state  # noqa: E402
from app.services import settings as settings_service  # noqa: E402
from app.services import sync as sync_service  # noqa: E402

client = TestClient(backend.app)

REMOTE_HOST = "192.168.1.50"  # 模拟局域网 iOS 设备（非 localhost）


def make_mp3(
    path: Path, title: str = "本地歌", artist: str = "本地歌手", cover: bytes | None = None
):
    """生成带 ID3 标签的假 mp3（与 test_backend / test_stream_backend 同款）；cover 非空时加 APIC"""
    from mutagen.id3 import APIC, ID3, TIT2, TPE1

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    tags.add(TIT2(encoding=3, text=title))
    tags.add(TPE1(encoding=3, text=artist))
    if cover:
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))
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
    sync_service._HASH_CACHE.clear()
    sync_service._COVER_CACHE.clear()
    yield
    state._settings = None
    state._scan_cache = None
    sync_service._HASH_CACHE.clear()
    sync_service._COVER_CACHE.clear()


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
    """songs 条目：path/name/artist/album/duration/size/mtime；增强字段 sha256/封面/歌词"""
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
    # 增强字段：sha256 与文件内容一致；无封面/歌词 → 空值约定
    assert s["sha256"] == hashlib.sha256(local_library.read_bytes()).hexdigest()
    assert isinstance(s["sha256"], str) and len(s["sha256"]) == 64
    assert s["cover_source"] in ("file", "embedded", "null")
    assert s["cover_path"] is None and s["cover_size"] == 0 and s["cover_mtime"] == 0
    assert s["lyric_path"] is None and s["lyric_mtime"] == 0
    # 网络歌（path=None）不进 manifest（客户端无法离线下载）
    assert all(x.get("path") for x in m["songs"])


# ============ manifest 增强：sha256 增量缓存 ============
def test_manifest_sha256_incremental_cache(local_library, monkeypatch):
    """sha256 增量缓存：mtime+size 未变 → 二次调用不重算（不重复读文件内容）"""
    real = hashlib.sha256
    calls = {"n": 0}

    def counting(data=b""):
        calls["n"] += 1
        return real(data)

    monkeypatch.setattr(sync_service.hashlib, "sha256", counting)
    sync_service._HASH_CACHE.clear()
    client.get("/api/sync/manifest")
    first = calls["n"]
    assert first >= 1  # 首轮确实算了哈希
    client.get("/api/sync/manifest")
    assert calls["n"] == first  # 缓存命中，零重算
    assert len(sync_service._HASH_CACHE) == 1
    ((mtime, size, digest),) = sync_service._HASH_CACHE.values()
    st = local_library.stat()
    assert (mtime, size) == (int(st.st_mtime * 1000), st.st_size)
    assert digest == real(local_library.read_bytes()).hexdigest()


def test_manifest_sha256_changes_on_content_change(local_library):
    """同 path 修改文件内容 → 缓存失效重算，sha256 变化"""
    m1 = client.get("/api/sync/manifest").json()["songs"][0]
    new_bytes = b"\xff\xfb\x90\x00" + b"\x11" * 1000
    local_library.write_bytes(new_bytes)
    # 显式推进 mtime（内容变了 mtime 通常也变；推进到不同毫秒保证缓存键必然失效）
    st = local_library.stat()
    os.utime(local_library, (st.st_atime + 5, st.st_mtime + 5))
    m2 = client.get("/api/sync/manifest").json()["songs"][0]
    assert m2["sha256"] == hashlib.sha256(new_bytes).hexdigest()
    assert m2["sha256"] != m1["sha256"]


# ============ manifest 增强：封面来源 ============
def test_manifest_cover_file(local_library):
    """文件夹 cover.jpg → cover_source=file + cover_path/size/mtime 正确"""
    cover = local_library.parent / "cover.jpg"
    cover.write_bytes(b"fake-jpeg-bytes")
    m = client.get("/api/sync/manifest").json()["songs"][0]
    st = cover.stat()
    assert m["cover_source"] == "file"
    assert m["cover_path"] == "cover.jpg"
    assert m["cover_size"] == st.st_size
    assert m["cover_mtime"] == int(st.st_mtime * 1000)


def test_manifest_cover_priority(local_library):
    """cover.jpg 优先于 folder.jpg（对齐 /api/cover 判定顺序，取第一个存在者）"""
    d = local_library.parent
    (d / "folder.jpg").write_bytes(b"folder")
    (d / "cover.jpg").write_bytes(b"cover")
    m = client.get("/api/sync/manifest").json()["songs"][0]
    assert m["cover_source"] == "file"
    assert m["cover_path"] == "cover.jpg"
    assert m["cover_size"] == (d / "cover.jpg").stat().st_size


def test_manifest_cover_embedded(tmp_path):
    """无文件夹封面但音频内嵌 APIC → cover_source=embedded；判定结果进 _COVER_CACHE"""
    path = tmp_path / "lib" / "embedded.mp3"
    make_mp3(path, cover=b"\xff\xd8\xff\xe0fake-jpeg")
    m = client.get("/api/sync/manifest").json()["songs"][0]
    assert m["cover_source"] == "embedded"
    assert m["cover_path"] is None
    assert m["cover_size"] == 0 and m["cover_mtime"] == 0
    assert str(path) in sync_service._COVER_CACHE  # 内嵌判定已缓存（audio mtime+size 键）


def test_manifest_cover_none(local_library):
    """无文件夹封面且无内嵌 APIC → cover_source=null，其余字段空值"""
    m = client.get("/api/sync/manifest").json()["songs"][0]
    assert m["cover_source"] == "null"
    assert m["cover_path"] is None
    assert m["cover_size"] == 0 and m["cover_mtime"] == 0


# ============ manifest 增强：歌词 ============
def test_manifest_lyric(local_library):
    """同目录同名 .lrc → lyric_path/lyric_mtime 正确"""
    lrc = local_library.with_suffix(".lrc")
    lrc.write_text("[00:00.00]test", encoding="utf-8")
    m = client.get("/api/sync/manifest").json()["songs"][0]
    st = lrc.stat()
    assert m["lyric_path"] == "local.lrc"
    assert m["lyric_mtime"] == int(st.st_mtime * 1000)


def test_manifest_lyric_unique_sibling(local_library):
    """无同名歌词但目录内唯一 .lrc → 用该文件（复用曲库扫描的发现逻辑）"""
    lrc = local_library.parent / "唯一歌词.lrc"
    lrc.write_text("[00:00.00]only", encoding="utf-8")
    m = client.get("/api/sync/manifest").json()["songs"][0]
    assert m["lyric_path"] == "唯一歌词.lrc"
    assert m["lyric_mtime"] == int(lrc.stat().st_mtime * 1000)


def test_manifest_lyric_missing_file(local_library):
    """扫描缓存有 lyric 但文件已删 → lyric_path=null / lyric_mtime=0"""
    lrc = local_library.with_suffix(".lrc")
    lrc.write_text("[00:00.00]gone", encoding="utf-8")
    m1 = client.get("/api/sync/manifest").json()["songs"][0]
    assert m1["lyric_path"] == "local.lrc"
    lrc.unlink()
    m2 = client.get("/api/sync/manifest").json()["songs"][0]
    assert m2["lyric_path"] is None and m2["lyric_mtime"] == 0


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
    db.books_save([{"id": "b1", "title": "测试书", "author": "某作者", "addedAt": 123}])
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
    """dicts：DICTS_DIR 下 MDX/MDD（含子目录），name/size/mtime/path；title 映射配置真实名"""
    (tmp_path / "dicts").mkdir()
    f1 = tmp_path / "dicts" / "oxford.mdx"
    f1.write_bytes(b"mdx-content")
    sub = tmp_path / "dicts" / "abc123"
    sub.mkdir()
    f2 = sub / "coca.mdd"
    f2.write_bytes(b"mdd-content")
    # 配置里 abc123 对应真实词典名（上传场景：配置 id = d_<uuid>，文件名 uuid 与之一致；
    # _norm_dict_list 要求 id/name/path 非空，缺 path 的配置会被丢弃）
    settings_service.save_all_settings(
        {
            "dict": {
                "dictionaries": [{"id": "d_abc123", "name": "测试词典", "path": "abc123/coca.mdd"}]
            }
        }
    )
    m = client.get("/api/sync/manifest").json()
    by_name = {d["name"]: d for d in m["dicts"]}
    assert by_name["oxford.mdx"]["size"] == 11
    assert by_name["oxford.mdx"]["path"] == "oxford.mdx"
    assert by_name["coca.mdd"]["path"] == "abc123/coca.mdd"
    assert by_name["coca.mdd"]["mtime"] == int(f2.stat().st_mtime * 1000)
    # title：配置匹配（子目录 uuid = abc123）→ 真实词典名；未匹配（散装 oxford）→ 空串
    assert by_name["coca.mdd"]["title"] == "测试词典"
    assert by_name["oxford.mdx"]["title"] == ""
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
    data = db.pairing_load()
    data.setdefault("devices", []).append(
        {
            "device_id": device_id,
            "device_name": "iPhone 15",
            "device_type": "ios",
            "token_hash": hashlib.sha256(token.encode("utf-8")).hexdigest(),
            "paired_at": "2026-08-22T00:00:00+00:00",
        }
    )
    db.pairing_save(data)
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


# ============ P2-B：annotations / vocab 接入 manifest + ops ============
def test_manifest_annotations_per_book():
    """annotations：顶层独立条目，按书全量 + version（该书条目最新 ts）"""
    db.annotations_save(
        {
            "b1": {
                "highlights": [
                    {"id": "hl_1", "cfi": "c", "text": "x", "color": "yellow", "createdAt": 100},
                    {"id": "hl_2", "cfi": "c2", "text": "y", "createdAt": 300},
                ],
                "bookmarks": [{"id": "bm_1", "cfi": "c", "createdAt": 200}],
                "notes": [
                    {"id": "nt_1", "cfi": "c", "text": "n", "createdAt": 250, "updatedAt": 400}
                ],
            },
            "b2": {"highlights": [], "bookmarks": [], "notes": []},
        }
    )
    m = client.get("/api/sync/manifest").json()
    by_book = {a["bookId"]: a for a in m["annotations"]}
    assert set(by_book) == {"b1", "b2"}
    assert by_book["b1"]["version"] == 400  # 全部条目 ts 最大值
    assert len(by_book["b1"]["highlights"]) == 2
    assert len(by_book["b1"]["bookmarks"]) == 1
    assert len(by_book["b1"]["notes"]) == 1
    assert by_book["b2"]["version"] == 0  # 无条目 → 0
    # books 条目保持轻量：不携带 annotations
    books = {b["id"]: b for b in m["books"]}
    assert "annotations" not in books.get("b1", {})


def test_manifest_vocab_full():
    """vocab：全量列表（含 addedAt，版本依据）"""
    db.vocab_save(
        [
            {
                "id": "vw_1",
                "word": "hello",
                "context": "",
                "bookId": "b1",
                "bookTitle": "书",
                "cfi": "",
                "addedAt": 100,
            },
            {
                "id": "vw_2",
                "word": "world",
                "context": "",
                "bookId": "",
                "bookTitle": "",
                "cfi": "",
                "addedAt": 200,
            },
        ]
    )
    m = client.get("/api/sync/manifest").json()
    assert len(m["vocab"]) == 2
    assert {v["id"] for v in m["vocab"]} == {"vw_1", "vw_2"}
    assert all("addedAt" in v for v in m["vocab"])


def test_manifest_version_changes_on_annotations_vocab():
    """annotations/vocab 变化 → manifest 版本串变化（客户端据此刷新缓存）"""
    db.annotations_save(
        {
            "b1": {
                "highlights": [{"id": "hl_1", "cfi": "c", "text": "x", "createdAt": 100}],
                "bookmarks": [],
                "notes": [],
            }
        }
    )
    v1 = client.get("/api/sync/manifest").json()["version"]
    db.annotations_save(
        {
            "b1": {
                "highlights": [{"id": "hl_1", "cfi": "c", "text": "x", "createdAt": 99999}],
                "bookmarks": [],
                "notes": [],
            }
        }
    )
    v2 = client.get("/api/sync/manifest").json()["version"]
    assert v2 != v1
    db.vocab_save([{"id": "vw_1", "word": "hello", "addedAt": 100000}])  # 大于标注的 99999
    v3 = client.get("/api/sync/manifest").json()["version"]
    assert v3 != v2


def test_push_annotations_save_lww():
    """annotations save：按书 LWW 覆盖（updatedAt 大者胜）"""
    _push(
        [
            {
                "entity": "annotations",
                "entity_id": "b1",
                "op": "save",
                "payload": {
                    "bookId": "b1",
                    "updatedAt": 1000,
                    "annotations": {
                        "highlights": [{"id": "hl_a", "cfi": "c", "text": "A", "createdAt": 1000}],
                        "bookmarks": [],
                        "notes": [],
                    },
                },
            }
        ]
    )
    assert db.annotations_load()["b1"]["highlights"][0]["id"] == "hl_a"
    # 更旧的 save → 跳过（现有版本 1000 > 500）
    _push(
        [
            {
                "entity": "annotations",
                "entity_id": "b1",
                "op": "save",
                "payload": {
                    "bookId": "b1",
                    "updatedAt": 500,
                    "annotations": {
                        "highlights": [
                            {"id": "hl_old", "cfi": "c", "text": "OLD", "createdAt": 500}
                        ],
                        "bookmarks": [],
                        "notes": [],
                    },
                },
            }
        ]
    )
    assert db.annotations_load()["b1"]["highlights"][0]["id"] == "hl_a"
    # 更新的 save → 整书替换
    _push(
        [
            {
                "entity": "annotations",
                "entity_id": "b1",
                "op": "save",
                "payload": {
                    "bookId": "b1",
                    "updatedAt": 2000,
                    "annotations": {
                        "highlights": [],
                        "bookmarks": [{"id": "bm_new", "cfi": "c", "createdAt": 2000}],
                        "notes": [],
                    },
                },
            }
        ]
    )
    book = db.annotations_load()["b1"]
    assert book["highlights"] == [] and book["bookmarks"][0]["id"] == "bm_new"
    # 桌面端 API 读得到（同源数据）
    assert client.get("/api/books/b1/annotations").json()["bookmarks"][0]["id"] == "bm_new"


def test_push_vocab_add_remove_lww():
    """vocab add/remove：按 id，addedAt 大者胜"""
    # add 新词
    _push(
        [
            {
                "entity": "vocab",
                "entity_id": "vw_1",
                "op": "add",
                "payload": {
                    "id": "vw_1",
                    "word": "hello",
                    "context": "Hello world.",
                    "bookId": "b1",
                    "bookTitle": "书",
                    "cfi": "c",
                    "addedAt": 1000,
                },
            }
        ]
    )
    assert [v["word"] for v in db.vocab_load()] == ["hello"]
    # 更旧 add（同 id）→ 跳过
    _push(
        [
            {
                "entity": "vocab",
                "entity_id": "vw_1",
                "op": "add",
                "payload": {"id": "vw_1", "word": "OLD", "addedAt": 500},
            }
        ]
    )
    assert [v["word"] for v in db.vocab_load()] == ["hello"]
    # 更新 add → 覆盖字段
    _push(
        [
            {
                "entity": "vocab",
                "entity_id": "vw_1",
                "op": "add",
                "payload": {"id": "vw_1", "word": "hello!", "bookTitle": "新书", "addedAt": 2000},
            }
        ]
    )
    v = next(v for v in db.vocab_load() if v["id"] == "vw_1")
    assert v["word"] == "hello!" and v["bookTitle"] == "新书" and v["addedAt"] == 2000
    # 更旧 remove → 保留（addedAt 2000 > ts 1500）
    _push(
        [
            {
                "entity": "vocab",
                "entity_id": "vw_1",
                "op": "remove",
                "payload": {"id": "vw_1"},
                "ts": 1500,
            }
        ]
    )
    assert any(v["id"] == "vw_1" for v in db.vocab_load())
    # 更新 remove → 删除
    _push(
        [
            {
                "entity": "vocab",
                "entity_id": "vw_1",
                "op": "remove",
                "payload": {"id": "vw_1"},
                "ts": 2500,
            }
        ]
    )
    assert not any(v["id"] == "vw_1" for v in db.vocab_load())
    # 删除不存在的 id → 幂等不报错
    _push(
        [
            {
                "entity": "vocab",
                "entity_id": "vw_nope",
                "op": "remove",
                "payload": {"id": "vw_nope"},
                "ts": 1,
            }
        ]
    )


def test_invalid_annotations_vocab_ops_400():
    """annotations/vocab 非法 ops → 整批拒绝 400"""
    cases = [
        # annotations：缺 bookId / op 非法 / annotations 非对象 / 子数组非对象数组 / updatedAt 非数字
        {"ops": [{"entity": "annotations", "op": "save", "payload": {"updatedAt": 1}}]},
        {
            "ops": [
                {
                    "entity": "annotations",
                    "op": "delete",
                    "payload": {"bookId": "b1", "updatedAt": 1},
                }
            ]
        },
        {
            "ops": [
                {
                    "entity": "annotations",
                    "op": "save",
                    "payload": {"bookId": "b1", "updatedAt": 1, "annotations": "nope"},
                }
            ]
        },
        {
            "ops": [
                {
                    "entity": "annotations",
                    "op": "save",
                    "payload": {
                        "bookId": "b1",
                        "updatedAt": 1,
                        "annotations": {"highlights": ["not-a-dict"], "bookmarks": [], "notes": []},
                    },
                }
            ]
        },
        {
            "ops": [
                {
                    "entity": "annotations",
                    "op": "save",
                    "payload": {
                        "bookId": "b1",
                        "annotations": {"highlights": [], "bookmarks": [], "notes": []},
                    },
                }
            ]
        },  # 缺 updatedAt
        # vocab：缺 id / op 非法 / add 缺 word / add addedAt 非数字
        {"ops": [{"entity": "vocab", "op": "add", "payload": {"word": "x", "addedAt": 1}}]},
        {"ops": [{"entity": "vocab", "op": "update", "payload": {"id": "v1", "addedAt": 1}}]},
        {
            "ops": [{"entity": "vocab", "op": "add", "payload": {"id": "v1", "addedAt": 1}}]
        },  # 缺 word
        {
            "ops": [
                {
                    "entity": "vocab",
                    "op": "add",
                    "payload": {"id": "v1", "word": "x", "addedAt": "now"},
                }
            ]
        },
        {"ops": [{"entity": "vocab", "op": "remove", "payload": {}}]},  # 缺 id
    ]
    for body in cases:
        r = client.post("/api/sync/ops", json=body)
        assert r.status_code == 400, (body, r.status_code)
        assert r.json()["detail"]
    # 整批不落盘
    assert db.vocab_load() == []
    assert db.annotations_load() == {}
