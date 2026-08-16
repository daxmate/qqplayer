"""曲库删除 API（send2trash 移废纸篓 + 歌单/收藏引用清理）与孤儿歌词清理测试

测试数据全部用 tmp_path 现场生成，收藏/歌单/设置/手动歌词目录全部隔离，
绝不触碰真实用户数据（send2trash 用桩记录调用，不真删文件）。
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import app.routers.library as library_router  # noqa: E402
import app.services.library_scan as library_scan  # noqa: E402
import backend  # noqa: E402
import lyric_fetch  # noqa: E402
from app import state  # noqa: E402

client = TestClient(backend.app)


def delete_songs(paths):
    """DELETE /api/library/songs（带 JSON body；本环境 TestClient.delete 不支持 json=，走 request）"""
    return client.request("DELETE", "/api/library/songs", json={"paths": paths})


def make_mp3(path: Path, title: str = "测试歌曲"):
    """生成带 ID3 标签的假 mp3（同 test_backend 的生成方式）"""
    from mutagen.id3 import ID3, TIT2

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    tags.add(TIT2(encoding=3, text=title))
    tags.save(path)


class _FakeSend2Trash:
    """模拟 send2trash 模块：.send2trash(path) 记录调用并实际移走文件"""

    def __init__(self, calls):
        self.calls = calls

    def send2trash(self, path):
        self.calls.append(path)
        p = Path(path)
        if p.exists():
            p.unlink()


@pytest.fixture(autouse=True)
def _isolate_storage(tmp_path, monkeypatch):
    """用户数据隔离：设置/收藏/歌单/手动歌词目录全走临时目录，不碰真实数据"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    monkeypatch.setattr(state, "PLAYLISTS_FILE", tmp_path / "playlists.json")
    monkeypatch.setattr(lyric_fetch, "MANUAL_DIR", tmp_path / "manual")
    state._settings = None
    yield
    state._settings = None


@pytest.fixture(autouse=True)
def _reset_watch_state():
    """每个测试前重置扫描缓存/版本号/去抖 timer，避免全局状态串扰"""
    with backend._scan_lock:
        state._scan_cache = None
        state._scan_version = 0
        if backend._watch_timer is not None:
            backend._watch_timer.cancel()
            state._watch_timer = None
    yield
    with backend._scan_lock:
        state._scan_cache = None
        state._scan_version = 0
        if backend._watch_timer is not None:
            backend._watch_timer.cancel()
            state._watch_timer = None


@pytest.fixture()
def song_library(tmp_path):
    """临时歌曲库：2 首假 mp3"""
    old = backend.LIBRARY
    try:
        state.LIBRARY = tmp_path
        make_mp3(tmp_path / "a.mp3", title="歌曲A")
        make_mp3(tmp_path / "b.mp3", title="歌曲B")
        yield tmp_path
    finally:
        state.LIBRARY = old


# ============ 曲库删除 API ============
def test_delete_songs_trash_and_clean_refs(song_library, monkeypatch):
    """删除库内歌曲：send2trash 调用（重复路径去重）、歌单/收藏引用清理、触发重扫"""
    calls = []
    monkeypatch.setattr(library_router, "send2trash", _FakeSend2Trash(calls))
    monkeypatch.setattr(library_scan, "_schedule_rescan", lambda: calls.append("rescan"))
    a = song_library / "a.mp3"
    b = song_library / "b.mp3"
    backend.scan_library()  # 预热缓存
    # 收藏 + 歌单都含 a、b，歌单另有不相关 path
    client.post("/api/favorites/toggle", json={"path": str(a)})
    client.post("/api/favorites/toggle", json={"path": str(b)})
    pid = client.post("/api/playlists", json={"name": "测试"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"path": str(a)})
    client.post(f"/api/playlists/{pid}/songs", json={"path": str(b)})
    client.post(f"/api/playlists/{pid}/songs", json={"path": "/other.mp3"})

    r = delete_songs([str(a), str(a), str(b)])
    assert r.status_code == 200
    assert r.json() == {"deleted": 2, "missing": [], "errors": []}
    # 去重：重复路径只删一次；重扫被触发
    assert calls.count(str(a)) == 1
    assert calls.count(str(b)) == 1
    assert calls.count("rescan") == 1
    # 引用清理：收藏清空，歌单只剩不相关 path
    assert client.get("/api/favorites").json() == {"paths": []}
    pl = client.get("/api/playlists").json()["playlists"][0]
    assert pl["songPaths"] == ["/other.mp3"]


def test_delete_outside_library_goes_to_missing(song_library, monkeypatch):
    """不在库内（但磁盘真实存在）→ missing 且绝不调 send2trash、文件原样保留"""
    calls = []
    monkeypatch.setattr(library_router, "send2trash", _FakeSend2Trash(calls))
    monkeypatch.setattr(library_scan, "_schedule_rescan", lambda: calls.append("rescan"))
    outside = song_library.parent / "outside.mp3"
    outside.write_bytes(b"x" * 100)
    r = delete_songs([str(outside)])
    assert r.status_code == 200
    assert r.json() == {"deleted": 0, "missing": [str(outside)], "errors": []}
    assert calls == []  # 绝不碰磁盘
    assert outside.exists()


def test_delete_mixed_in_and_out(song_library, monkeypatch):
    """混合请求：库内路径正常删除，非库内路径进 missing"""
    calls = []
    monkeypatch.setattr(library_router, "send2trash", _FakeSend2Trash(calls))
    monkeypatch.setattr(library_scan, "_schedule_rescan", lambda: calls.append("rescan"))
    a = song_library / "a.mp3"
    r = delete_songs([str(a), "/not/in/library.mp3"])
    assert r.status_code == 200
    assert r.json() == {"deleted": 1, "missing": ["/not/in/library.mp3"], "errors": []}
    assert calls[0] == str(a)  # 只有库内路径被移废纸篓
    assert "rescan" in calls


def test_delete_file_already_gone_counts_deleted(song_library, monkeypatch):
    """库内但磁盘已丢 → 计入 deleted、照常清理引用、不调 send2trash、触发重扫"""
    calls = []
    monkeypatch.setattr(library_router, "send2trash", _FakeSend2Trash(calls))
    monkeypatch.setattr(library_scan, "_schedule_rescan", lambda: calls.append("rescan"))
    a = song_library / "a.mp3"
    backend.scan_library()  # 预热缓存（库里含 a）
    a.unlink()  # 磁盘丢失
    client.post("/api/favorites/toggle", json={"path": str(a)})
    r = delete_songs([str(a)])
    assert r.status_code == 200
    assert r.json() == {"deleted": 1, "missing": [], "errors": []}
    assert str(a) not in calls  # 文件已不存在，无需调 send2trash
    assert "rescan" in calls
    assert client.get("/api/favorites").json() == {"paths": []}  # 引用照常清理


def test_delete_send2trash_error_reported(song_library, monkeypatch):
    """send2trash 抛错且文件还在 → errors，不清理引用、文件保留、不触发重扫"""

    class _BoomSend2Trash:
        def send2trash(self, path):
            raise OSError("模拟移废纸篓失败")

    monkeypatch.setattr(library_router, "send2trash", _BoomSend2Trash())
    monkeypatch.setattr(library_scan, "_schedule_rescan", lambda: pytest.fail("不应触发重扫"))
    a = song_library / "a.mp3"
    client.post("/api/favorites/toggle", json={"path": str(a)})
    r = delete_songs([str(a)])
    assert r.status_code == 200
    assert r.json()["deleted"] == 0
    assert r.json()["errors"] == [{"path": str(a), "reason": "模拟移废纸篓失败"}]
    assert a.exists()  # 文件还在
    assert client.get("/api/favorites").json() == {"paths": [str(a)]}  # 引用保留


def test_delete_validation(song_library):
    """非法请求：缺 paths / 空数组 → 400；网络歌 path=null 不参与（返回全 0）"""
    assert client.request("DELETE", "/api/library/songs", json={}).status_code == 400
    assert client.request("DELETE", "/api/library/songs", json={"paths": []}).status_code == 400
    r = delete_songs([None])
    assert r.status_code == 200
    assert r.json() == {"deleted": 0, "missing": [], "errors": []}


# ============ 孤儿歌词清理 ============
def test_cleanup_orphan_manual_lyrics(tmp_path):
    """有效/孤儿混合：只删孤儿、返回正确计数；有效文件与非 json 文件原样保留"""
    manual = tmp_path / "manual"
    manual.mkdir()
    valid = tmp_path / "valid.mp3"
    orphan1 = tmp_path / "orphan1.mp3"
    orphan2 = tmp_path / "orphan2.mp3"
    (manual / f"{lyric_fetch.manual_key(str(valid))}.json").write_text("{}")
    (manual / f"{lyric_fetch.manual_key(str(orphan1))}.json").write_text("{}")
    (manual / f"{lyric_fetch.manual_key(str(orphan2))}.json").write_text("{}")
    (manual / "readme.txt").write_text("keep")

    removed = lyric_fetch.cleanup_orphan_manual_lyrics([str(valid)])
    assert removed == 2
    assert (manual / f"{lyric_fetch.manual_key(str(valid))}.json").exists()
    assert not (manual / f"{lyric_fetch.manual_key(str(orphan1))}.json").exists()
    assert not (manual / f"{lyric_fetch.manual_key(str(orphan2))}.json").exists()
    assert (manual / "readme.txt").exists()


def test_cleanup_orphan_manual_lyrics_empty_valid(tmp_path):
    """valid_paths 为空 → 目录内全部 .json 视为孤儿删光"""
    manual = tmp_path / "manual"
    manual.mkdir()
    f = manual / f"{lyric_fetch.manual_key('/x/any.mp3')}.json"
    f.write_text("{}")
    removed = lyric_fetch.cleanup_orphan_manual_lyrics([])
    assert removed == 1
    assert not f.exists()


def test_cleanup_orphan_manual_lyrics_missing_dir(tmp_path):
    """MANUAL_DIR 不存在 → 返回 0 不报错（不创建目录）"""
    assert lyric_fetch.cleanup_orphan_manual_lyrics([]) == 0
    assert not (tmp_path / "manual").exists()
