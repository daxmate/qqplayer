"""backend.py API 测试（测试数据用 tmp_path 现场生成假 mp3/srt，不依赖仓库内真实音频）"""

import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import app.routers.lyrics as router_lyrics  # noqa: E402
import app.services.library_scan as library_scan  # noqa: E402
import backend  # noqa: E402
import netease_provider  # noqa: E402
from app import state  # noqa: E402

client = TestClient(backend.app)

# 假 JPEG 封面字节（真实歌曲库数据太大，不入仓库；测试用临时文件模拟）
FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"x" * 200

SRT_TEXT = """# 主歌1

1
00:00:10,000 --> 00:00:15,000
君が前に付き合っていた人のこと
kimi ga mae ni

# 副歌

2
00:00:20,000 --> 00:00:25,000
サビの歌詞
"""


def make_mp3(
    path: Path,
    title: str | None = None,
    artist: str | None = None,
    album: str | None = None,
    cover: bytes | None = None,
):
    """生成带 ID3 标签（可选内嵌封面 APIC）的假 mp3，模拟真实歌曲文件"""
    from mutagen.id3 import APIC, ID3, TALB, TIT2, TPE1

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    if title:
        tags.add(TIT2(encoding=3, text=title))
    if artist:
        tags.add(TPE1(encoding=3, text=artist))
    if album:
        tags.add(TALB(encoding=3, text=album))
    if cover:
        tags.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=cover))
    tags.save(path)


@pytest.fixture()
def song_library(tmp_path):
    """临时歌曲库：子目录 1 首带歌词的日文歌，根目录 1 首带内嵌封面、无歌词的中文歌"""
    old = backend.LIBRARY
    try:
        state.LIBRARY = tmp_path
        d = tmp_path / "yakimochi"
        d.mkdir()
        make_mp3(d / "song.mp3", title="ヤキモチ", artist="高橋優", album="開往明天的旅行")
        (d / "yakimochi.srt").write_text(SRT_TEXT, encoding="utf-8")
        make_mp3(tmp_path / "五月天 - 知足.mp3", title="知足", artist="五月天", cover=FAKE_JPEG)
        yield tmp_path
    finally:
        state.LIBRARY = old


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：统一 settings.json + 两个遗留文件都写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    state._settings = None
    yield


@pytest.fixture(autouse=True)
def _isolate_manual_dir(tmp_path, monkeypatch):
    """手动指定歌词目录隔离：不碰真实用户缓存"""
    import lyric_fetch

    monkeypatch.setattr(lyric_fetch, "MANUAL_DIR", tmp_path / "manual")
    yield
    state._settings = None


@pytest.fixture(autouse=True)
def _no_auto_translation(monkeypatch):
    """默认禁用自动补翻译（真实实现会发网易云网络请求），各用例自行 monkeypatch 覆盖"""
    monkeypatch.setattr(router_lyrics, "auto_attach_translation", lambda *a, **kw: None)


# ============ 歌曲库扫描 ============
def test_scan_library_counts(song_library):
    songs = backend.scan_library()
    assert len(songs) == 2
    by_name = {s["name"]: s for s in songs}
    assert set(by_name) == {"ヤキモチ", "知足"}


def test_scan_library_metadata(song_library):
    by_name = {s["name"]: s for s in backend.scan_library()}
    yakimochi = by_name["ヤキモチ"]
    assert yakimochi["artist"] == "高橋優"
    assert yakimochi["album"] == "開往明天的旅行"
    assert yakimochi["ext"] == "mp3"
    assert yakimochi["has_lyric"] is True
    assert yakimochi["lyric"] == "yakimochi.srt"

    zhizu = by_name["知足"]
    assert zhizu["artist"] == "五月天"
    assert zhizu["album"] == ""  # 无专辑标签
    assert zhizu["has_lyric"] is False
    assert zhizu["lyric"] is None


def test_scan_empty_library(tmp_path):
    old = backend.LIBRARY
    state.LIBRARY = tmp_path
    try:
        assert backend.scan_library() == []
    finally:
        state.LIBRARY = old


# ============ API 路由 ============
def test_api_songs(song_library):
    r = client.get("/api/songs")
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_api_library(song_library):
    r = client.get("/api/library")
    assert r.status_code == 200
    assert r.json()["path"] == str(song_library)


def test_api_set_library_invalid():
    r = client.post("/api/library", json={"path": "/no/such/dir"})
    assert r.status_code == 400


def test_api_audio_range(song_library):
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/audio", params={"path": song["path"]}, headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert len(r.content) == 100


def test_api_audio_missing():
    r = client.get("/api/audio", params={"path": "/no/such/file.mp3"})
    assert r.status_code == 404


# ============ 歌词 ============
def test_api_lyric_yakimochi(song_library):
    song = next(s for s in backend.scan_library() if s["name"] == "ヤキモチ")
    r = client.get("/api/lyric", params={"path": song["path"]})
    assert r.status_code == 200
    data = r.json()
    assert data["format"] == "srt"
    types = [ln["type"] for ln in data["lines"]]
    assert "sec" in types and "line" in types
    line = next(ln for ln in data["lines"] if ln["type"] == "line")
    assert line["s"] < line["e"]
    assert len(line["text"]) >= 1


def test_api_lyric_missing(song_library, monkeypatch):
    """本地无歌词且在线也获取失败 → 404"""
    monkeypatch.setattr(router_lyrics, "fetch_online_lyric", lambda *a, **k: (None, None, None))
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/lyric", params={"path": song["path"]})
    assert r.status_code == 404


def test_api_lyric_online_fallback(song_library, monkeypatch):
    """本地无歌词时在线获取成功 → 200，带 source 和翻译合并"""
    lrc = "[00:10.00]沈むように溶けてゆくように\n[00:20.00]二人だけの空"
    tlyric = "[00:10.00]像是沉溺溶化一般\n[00:20.00]只有两人的天空"
    monkeypatch.setattr(
        router_lyrics, "fetch_online_lyric", lambda *a, **k: (lrc, tlyric, "netease")
    )
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/lyric", params={"path": song["path"]})
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "netease"
    assert data["format"] == "lrc"
    first = next(ln for ln in data["lines"] if ln["type"] == "line")
    assert first["text"] == ["沈むように溶けてゆくように", "", "像是沉溺溶化一般"]


def test_api_lyric_prefer_online_uses_online(song_library, monkeypatch):
    """prefer=online 且本地有歌词 → 用在线歌词（在线优先）"""
    lrc = "[00:01.00]オンライン優先の歌詞\n[00:02.00]二行目"
    monkeypatch.setattr(router_lyrics, "fetch_online_lyric", lambda *a, **k: (lrc, None, "lrclib"))
    song = next(s for s in backend.scan_library() if s["name"] == "ヤキモチ")  # 本地有 srt
    r = client.get("/api/lyric", params={"path": song["path"], "prefer": "online"})
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "lrclib"
    assert data["format"] == "lrc"
    first = next(ln for ln in data["lines"] if ln["type"] == "line")
    assert first["text"] == ["オンライン優先の歌詞"]


def test_api_lyric_prefer_online_fallback_local(song_library, monkeypatch):
    """prefer=online 且在线失败 → 回退本地歌词"""
    monkeypatch.setattr(router_lyrics, "fetch_online_lyric", lambda *a, **k: (None, None, None))
    song = next(s for s in backend.scan_library() if s["name"] == "ヤキモチ")
    r = client.get("/api/lyric", params={"path": song["path"], "prefer": "online"})
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "local"
    assert data["format"] == "srt"


def test_api_lyric_prefer_online_missing(song_library, monkeypatch):
    """prefer=online、本地无歌词且在线失败 → 404"""
    monkeypatch.setattr(router_lyrics, "fetch_online_lyric", lambda *a, **k: (None, None, None))
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/lyric", params={"path": song["path"], "prefer": "online"})
    assert r.status_code == 404


def test_api_lyric_prefer_invalid_defaults_local(song_library, monkeypatch):
    """prefer 非法值 → 按 local 处理（本地优先）"""
    lrc = "[00:01.00]不应使用"
    monkeypatch.setattr(router_lyrics, "fetch_online_lyric", lambda *a, **k: (lrc, None, "netease"))
    song = next(s for s in backend.scan_library() if s["name"] == "ヤキモチ")
    r = client.get("/api/lyric", params={"path": song["path"], "prefer": "bogus"})
    assert r.status_code == 200
    assert r.json()["source"] == "local"


# ============ 封面 ============
def test_api_cover_embedded(song_library):
    """提取 mp3 内嵌封面（ID3 APIC）"""
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/cover", params={"path": song["path"]})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("image/")
    assert len(r.content) > 100


def test_api_cover_missing_file():
    r = client.get("/api/cover", params={"path": "/no/such/file.mp3"})
    assert r.status_code == 404


def test_api_cover_from_file(tmp_path):
    """文件夹内有 cover.jpg 时返回图片"""
    (tmp_path / "cover.jpg").write_bytes(b"\xff\xd8\xff\xe0fakejpeg")
    mp3 = tmp_path / "song.mp3"
    mp3.write_bytes(b"ID3fake")
    r = client.get("/api/cover", params={"path": str(mp3)})
    assert r.status_code == 200
    assert r.content == b"\xff\xd8\xff\xe0fakejpeg"


# ============ 收藏 ============
def test_api_favorites_empty(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    r = client.get("/api/favorites")
    assert r.status_code == 200
    assert r.json() == {"paths": []}


def test_api_favorites_toggle(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    # 收藏
    r = client.post("/api/favorites/toggle", json={"path": "/a.mp3"})
    assert r.json() == {"path": "/a.mp3", "favorited": True}
    r = client.get("/api/favorites")
    assert r.json() == {"paths": ["/a.mp3"]}
    # 再点取消
    r = client.post("/api/favorites/toggle", json={"path": "/a.mp3"})
    assert r.json() == {"path": "/a.mp3", "favorited": False}
    r = client.get("/api/favorites")
    assert r.json() == {"paths": []}


def test_api_favorites_multi(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    client.post("/api/favorites/toggle", json={"path": "/a.mp3"})
    client.post("/api/favorites/toggle", json={"path": "/b.mp3"})
    r = client.get("/api/favorites")
    assert r.json() == {"paths": ["/a.mp3", "/b.mp3"]}


def test_api_favorites_missing_path(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "FAVORITES_FILE", tmp_path / "favorites.json")
    r = client.post("/api/favorites/toggle", json={})
    assert r.status_code == 400


# ============ 播放记录 ============


def _playback(tmp_path, monkeypatch):
    """把 PLAYBACK_FILE 指到临时目录并返回该路径"""
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    p = tmp_path / "playback.json"
    monkeypatch.setattr(state, "PLAYBACK_FILE", p)
    return p


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


def test_api_playback_append(tmp_path, monkeypatch):
    p = _playback(tmp_path, monkeypatch)
    r = client.post("/api/playback", json=_rec())
    assert r.json() == {"ok": True}
    data = json.loads(p.read_text(encoding="utf-8"))
    assert len(data) == 1
    assert data[0]["path"] == "/songs/a.mp3"
    assert data[0]["played"] == 180.5
    assert data[0]["ratio"] == 0.9


def test_api_playback_too_short_skipped(tmp_path, monkeypatch):
    _playback(tmp_path, monkeypatch)
    r = client.post("/api/playback", json=_rec(played=1.5))
    assert r.json() == {"ok": False, "reason": "invalid"}
    # 2.9s 也不记（阈值 3s）
    client.post("/api/playback", json=_rec(played=2.9))
    assert not (tmp_path / "playback.json").exists()


def test_api_playback_missing_path(tmp_path, monkeypatch):
    _playback(tmp_path, monkeypatch)
    r = client.post("/api/playback", json=_rec(path=""))
    assert r.json() == {"ok": False, "reason": "invalid"}


def test_api_playback_rollover_limit(tmp_path, monkeypatch):
    p = _playback(tmp_path, monkeypatch)
    monkeypatch.setattr(state, "PLAYBACK_LIMIT", 5)
    for i in range(7):
        client.post(
            "/api/playback", json=_rec(path=f"/songs/{i}.mp3", ts=f"2026-08-12T12:0{i}:00+00:00")
        )
    data = json.loads(p.read_text(encoding="utf-8"))
    assert len(data) == 5  # 只留最近 5 条
    assert data[0]["path"] == "/songs/2.mp3"
    assert data[-1]["path"] == "/songs/6.mp3"


def test_api_playback_list_sorted(tmp_path, monkeypatch):
    _playback(tmp_path, monkeypatch)
    client.post("/api/playback", json=_rec(ts="2026-08-12T10:00:00+00:00"))
    client.post("/api/playback", json=_rec(ts="2026-08-12T11:00:00+00:00", path="/songs/b.mp3"))
    r = client.get("/api/playback")
    body = r.json()
    assert body["count"] == 2
    assert body["records"][0]["path"] == "/songs/b.mp3"  # 最新在前
    assert body["limit"] == 5000


def test_api_playback_stats(tmp_path, monkeypatch):
    _playback(tmp_path, monkeypatch)
    client.post("/api/playback", json=_rec(played=100, completed=True))
    client.post("/api/playback", json=_rec(played=50, completed=False))
    client.post("/api/playback", json=_rec(path="/songs/b.mp3", name="B", played=30))
    r = client.get("/api/playback/stats")
    songs = r.json()["songs"]
    assert r.json()["count"] == 2
    a = next(s for s in songs if s["path"] == "/songs/a.mp3")
    assert a["plays"] == 2
    assert a["totalPlayed"] == 150.0
    assert a["completed"] == 1
    assert a["lastPlayed"] == "2026-08-12T12:00:00+00:00"


def test_api_playback_stats_empty(tmp_path, monkeypatch):
    _playback(tmp_path, monkeypatch)
    r = client.get("/api/playback/stats")
    assert r.json() == {"count": 0, "songs": []}


def test_scan_duration(song_library):
    """假 mp3 是完整 MPEG 帧，mutagen 能读出时长"""
    songs = backend.scan_library()
    for s in songs:
        assert s["duration"] is not None and s["duration"] > 0


def test_get_duration_bad_file(tmp_path):
    """损坏/非音频文件返回 None 而不是抛异常"""
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"not audio")
    assert backend.get_duration(bad) is None


# ============ 解析器单元测试 ============
def test_parse_srt_with_sections():
    text = """# 主歌1

1
00:00:24,000 --> 00:00:31,100
君が前に付き合っていた人のこと
kimi ga mae ni

# 副歌

2
00:00:35,000 --> 00:00:40,000
サビの歌詞
"""
    lines = backend.parse_srt(text)
    assert [ln["type"] for ln in lines] == ["sec", "line", "sec", "line"]
    assert lines[0]["name"] == "主歌1"
    assert lines[1]["s"] == pytest.approx(24.0)
    assert lines[1]["text"] == ["君が前に付き合っていた人のこと", "kimi ga mae ni"]


def test_parse_srt_title_attached_to_block():
    """段落标题和句子粘在同一块（无空行）也必须拆开"""
    text = """# 主歌1
1
00:00:10,000 --> 00:00:15,000
一句歌词
"""
    lines = backend.parse_srt(text)
    assert [ln["type"] for ln in lines] == ["sec", "line"]
    assert lines[1]["text"] == ["一句歌词"]


def test_parse_lrc():
    text = """[00:10.00]第一句
[00:20.50]第二句
[00:30.25]第三句
"""
    lines = backend.parse_lrc(text)
    assert len(lines) == 3
    assert lines[0]["s"] == pytest.approx(10.0)
    assert lines[1]["s"] == pytest.approx(20.5)
    assert lines[2]["e"] == pytest.approx(35.25)


# ============ 翻译合并 ============
def test_merge_translation():
    lines = [
        {"type": "line", "s": 10.0, "e": 15.0, "text": ["原文一"]},
        {"type": "line", "s": 20.0, "e": 25.0, "text": ["原文二"]},
    ]
    tlyric = "[00:10.00]翻译一\n[00:20.00]翻译二"
    merged = backend.merge_translation(lines, tlyric)
    # 约定 text = [原文, 罗马音(空), 中文翻译]
    assert merged[0]["text"] == ["原文一", "", "翻译一"]
    assert merged[1]["text"] == ["原文二", "", "翻译二"]


def test_merge_translation_mismatch():
    """翻译行与主行时间差超过容差 → 不合并"""
    lines = [{"type": "line", "s": 10.0, "e": 15.0, "text": ["原文"]}]
    merged = backend.merge_translation(lines, "[00:30.00]翻译")
    assert merged[0]["text"] == ["原文"]


def test_merge_translation_none():
    lines = [{"type": "line", "s": 1.0, "e": 2.0, "text": ["原文"]}]
    assert backend.merge_translation(lines, None) == lines
    assert backend.merge_translation(lines, "") == lines


# ============ 歌单 ============
def _pl_client(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "DATA_DIR", tmp_path)
    monkeypatch.setattr(state, "PLAYLISTS_FILE", tmp_path / "playlists.json")
    return client


def test_api_playlists_create_and_list(tmp_path, monkeypatch):
    _pl_client(tmp_path, monkeypatch)
    assert client.get("/api/playlists").json() == {"playlists": []}
    r = client.post("/api/playlists", json={"name": "日语歌"})
    assert r.status_code == 200
    p = r.json()
    assert p["name"] == "日语歌" and p["songPaths"] == [] and p["id"]
    # 空名拒绝
    assert client.post("/api/playlists", json={"name": "  "}).status_code == 400
    r = client.get("/api/playlists")
    assert len(r.json()["playlists"]) == 1


def test_api_playlists_rename_delete(tmp_path, monkeypatch):
    _pl_client(tmp_path, monkeypatch)
    pid = client.post("/api/playlists", json={"name": "旧名"}).json()["id"]
    r = client.patch(f"/api/playlists/{pid}", json={"name": "新名"})
    assert r.json()["name"] == "新名"
    assert client.patch(f"/api/playlists/{pid}", json={"name": ""}).status_code == 400
    assert client.delete("/api/playlists/not-exist").status_code == 404
    assert client.delete(f"/api/playlists/{pid}").json() == {"ok": True}
    assert client.get("/api/playlists").json() == {"playlists": []}


def test_api_playlists_songs_add_remove_order(tmp_path, monkeypatch):
    from urllib.parse import quote

    _pl_client(tmp_path, monkeypatch)
    pid = client.post("/api/playlists", json={"name": "测试"}).json()["id"]
    # 加歌（去重）
    r = client.post(f"/api/playlists/{pid}/songs", json={"path": "/a.mp3"})
    assert r.json()["songPaths"] == ["/a.mp3"]
    client.post(f"/api/playlists/{pid}/songs", json={"path": "/a.mp3"})
    client.post(f"/api/playlists/{pid}/songs", json={"path": "/b.mp3"})
    # 排序：整体重排
    r = client.put(f"/api/playlists/{pid}/order", json={"paths": ["/b.mp3", "/a.mp3"]})
    assert r.json()["songPaths"] == ["/b.mp3", "/a.mp3"]
    # 排序提交不存在的 path 会过滤掉，但原歌不丢
    r = client.put(f"/api/playlists/{pid}/order", json={"paths": ["/ghost.mp3"]})
    assert set(r.json()["songPaths"]) == {"/b.mp3", "/a.mp3"}
    # 移除（path 带斜杠需 URL 编码）
    r = client.delete(f"/api/playlists/{pid}/songs/{quote('/a.mp3')}")
    assert r.json()["songPaths"] == ["/b.mp3"]
    # 不存在的歌单
    assert client.post("/api/playlists/xxx/songs", json={"path": "/a.mp3"}).status_code == 404
    assert client.put("/api/playlists/xxx/order", json={"paths": []}).status_code == 404


def test_api_playlists_persist(tmp_path, monkeypatch):
    """歌单写入文件后重新加载仍在（持久化）"""
    _pl_client(tmp_path, monkeypatch)
    pid = client.post("/api/playlists", json={"name": "持久"}).json()["id"]
    client.post(f"/api/playlists/{pid}/songs", json={"path": "/x.mp3"})
    # 模拟重启：重新加载
    data = json.loads((tmp_path / "playlists.json").read_text(encoding="utf-8"))
    assert data[0]["name"] == "持久" and data[0]["songPaths"] == ["/x.mp3"]


# ============ 库监听（watchdog）与扫描缓存 ============


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


def test_scan_library_cache_hit(song_library, monkeypatch):
    """同库二次扫描命中缓存，不再全量扫（_full_scan 只调一次）"""
    real = backend._full_scan
    calls = []

    def counting():
        calls.append(1)
        return real()

    monkeypatch.setattr(library_scan, "_full_scan", counting)
    backend.scan_library()
    backend.scan_library()
    assert len(calls) == 1


def test_scan_cache_invalid_when_library_changes(song_library, monkeypatch):
    """切换歌曲库路径后缓存自动失效（按 library 路径做 key）"""
    backend.scan_library()
    state.LIBRARY = song_library / "sub"
    backend.LIBRARY.mkdir()
    make_mp3(backend.LIBRARY / "新歌.mp3", title="新歌")
    songs = backend.scan_library()
    assert len(songs) == 1 and songs[0]["name"] == "新歌"


def test_rescan_bumps_version_and_updates_cache(song_library):
    """库变动重扫：版本号 +1，缓存同步更新（新增文件能扫到）"""
    backend.scan_library()
    make_mp3(song_library / "新增.mp3", title="新增")
    backend._rescan()
    assert state._scan_version == 1
    assert backend.scan_library() == backend._scan_cache["songs"]
    names = {s["name"] for s in backend.scan_library()}
    assert "新增" in names


def test_schedule_rescan_debounce(song_library, monkeypatch):
    """去抖：窗口内多次事件只触发一次重扫"""
    state.WATCH_DEBOUNCE_SECONDS = 0.05
    calls = []
    monkeypatch.setattr(library_scan, "_rescan", lambda: calls.append(1))
    for _ in range(5):
        backend._schedule_rescan()
    assert len(calls) == 0  # 去抖窗口内还没执行
    import time

    time.sleep(0.2)
    assert len(calls) == 1  # 合并成一次


def test_handler_skips_dir_modified(song_library, monkeypatch):
    """目录自身 modified 事件（iCloud 同步频繁）不触发重扫；文件事件触发"""
    calls = []
    monkeypatch.setattr(library_scan, "_schedule_rescan", lambda: calls.append(1))
    h = backend._LibraryHandler()

    class Ev:
        def __init__(self, is_dir, event_type):
            self.is_directory = is_dir
            self.event_type = event_type

    h.on_any_event(Ev(True, "modified"))  # 跳过
    assert calls == []
    h.on_any_event(Ev(False, "created"))  # 文件创建 → 触发
    h.on_any_event(Ev(False, "modified"))  # 文件修改 → 触发
    assert len(calls) == 2


def test_start_watcher_skips_missing_dir(song_library):
    """歌曲库目录不存在时不启动 observer"""
    state.LIBRARY = song_library / "ghost"
    backend.start_watcher()
    assert backend._watch_observer is None


def test_api_library_version(song_library):
    """version 接口：初始 0，重扫后递增"""
    r = client.get("/api/library/version")
    assert r.json() == {"version": 0}
    backend._rescan()
    assert client.get("/api/library/version").json() == {"version": 1}


def test_api_set_library_clears_cache_and_bumps_version(song_library, monkeypatch):
    """切换歌曲库：缓存清空、版本号 +1、新库可扫（watcher 用桩避免真起线程）"""
    monkeypatch.setattr(library_scan, "start_watcher", lambda: None)
    monkeypatch.setattr(library_scan, "stop_watcher", lambda: None)
    backend.scan_library()
    v0 = client.get("/api/library/version").json()["version"]
    new_dir = song_library / "newlib"
    new_dir.mkdir()
    make_mp3(new_dir / "b.mp3", title="B")
    r = client.post("/api/library", json={"path": str(new_dir)})
    assert r.status_code == 200
    assert r.json()["count"] == 1
    assert client.get("/api/library/version").json()["version"] == v0 + 1
    # 新库扫描结果（缓存已换新）
    songs = client.get("/api/songs").json()
    assert len(songs) == 1 and songs[0]["name"] == "B"


# ============ 音乐库设置（第三批） ============


def test_settings_defaults():
    """无设置文件时回落默认值（全格式 / 忽略隐藏 / 自动刷新 / 启动扫描）"""
    s = backend.load_settings()
    assert s["audioExts"] == backend.DEFAULT_AUDIO_EXTS
    assert s["ignoreHidden"] is True
    assert s["autoRefresh"] is True
    assert s["autoScanOnStart"] is True


def test_settings_persist_roundtrip(tmp_path, monkeypatch):
    """保存后写盘，重置内存缓存再读仍生效"""
    new = backend.save_settings({"audioExts": [".mp3", ".flac"], "autoRefresh": False})
    assert new["audioExts"] == [".mp3", ".flac"]
    assert new["autoRefresh"] is False
    assert backend.SETTINGS_FILE.exists()
    state._settings = None  # 模拟重启
    s = backend.load_settings()
    assert s["audioExts"] == [".mp3", ".flac"]
    assert s["autoRefresh"] is False
    assert s["ignoreHidden"] is True  # 未提及的字段保持默认


def test_settings_normalize_invalid():
    """非法值回落默认：空格式列表、非列表、非 bool"""
    s = backend.save_settings({"audioExts": [], "ignoreHidden": "yes", "autoRefresh": 1})
    assert s["audioExts"] == backend.DEFAULT_AUDIO_EXTS
    assert s["ignoreHidden"] is True
    assert s["autoRefresh"] is True
    s = backend.save_settings({"audioExts": ["mp3", ".flac", 42]})
    assert s["audioExts"] == [".flac"]  # 只留合法扩展名，非空即采纳


def test_full_scan_filters_by_audio_exts(song_library):
    """文件类型多选：只扫 mp3 时其他格式不进列表"""
    make_mp3(song_library / "only.flac", title="Flac 歌")
    backend.save_settings({"audioExts": [".mp3"]})
    songs = backend._full_scan()
    assert all(s["ext"] == "mp3" for s in songs)


def test_full_scan_ignores_hidden_by_default(song_library):
    """忽略隐藏：隐藏目录/文件里的歌默认不进列表；关闭开关后进入"""
    (song_library / ".hidden").mkdir()
    make_mp3(song_library / ".hidden" / "a.mp3", title="隐藏目录歌")
    make_mp3(song_library / ".spotlight.mp3", title="隐藏文件歌")
    assert {s["name"] for s in backend._full_scan()} == {"ヤキモチ", "知足"}
    backend.save_settings({"ignoreHidden": False})
    names = {s["name"] for s in backend._full_scan()}
    assert {"隐藏目录歌", "隐藏文件歌"} <= names


def test_api_library_settings_get(song_library):
    """GET 设置接口返回完整设置"""
    r = client.get("/api/library/settings")
    assert r.status_code == 200
    s = r.json()["settings"]
    assert s["audioExts"] == backend.DEFAULT_AUDIO_EXTS
    assert s["ignoreHidden"] is True


def test_api_update_settings_ext_bumps_version(song_library):
    """PUT 改文件类型：缓存清空、版本号 +1、count 反映新过滤"""
    make_mp3(song_library / "only.flac", title="Flac 歌")
    v0 = client.get("/api/library/version").json()["version"]
    r = client.put(
        "/api/library/settings",
        json={"audioExts": [".mp3", ".flac"], "autoRefresh": False},
    )
    assert r.status_code == 200
    assert r.json()["count"] == 3  # 2 mp3 + 1 flac
    assert client.get("/api/library/version").json()["version"] == v0 + 1
    assert client.get("/api/library/settings").json()["settings"]["audioExts"] == [
        ".mp3",
        ".flac",
    ]


def test_api_update_settings_auto_refresh_toggle(song_library, monkeypatch):
    """autoRefresh 开关变化：关→stop_watcher，开→start_watcher（幂等安全）"""
    calls = []
    monkeypatch.setattr(library_scan, "start_watcher", lambda: calls.append("start"))
    monkeypatch.setattr(library_scan, "stop_watcher", lambda: calls.append("stop"))
    backend.save_settings({"autoRefresh": True})
    calls.clear()
    # 关闭自动刷新 → stop
    client.put("/api/library/settings", json={"autoRefresh": False})
    assert calls == ["stop"]
    # 再开 → start
    client.put("/api/library/settings", json={"autoRefresh": True})
    assert calls == ["stop", "start"]
    # 值没变 → 不重复启停
    calls.clear()
    client.put("/api/library/settings", json={"autoRefresh": True})
    assert calls == []


def test_start_watcher_respects_auto_refresh_off(song_library):
    """autoRefresh=false 时 start_watcher 不启动 observer"""
    backend.save_settings({"autoRefresh": False})
    backend.start_watcher()
    assert backend._watch_observer is None


def test_init_library_respects_settings(song_library, monkeypatch):
    """启动初始化：autoScanOnStart 控制预热扫描，autoRefresh 控制 watcher"""
    calls = {"scan": 0, "watch": 0}
    monkeypatch.setattr(
        library_scan, "scan_library", lambda: calls.__setitem__("scan", calls["scan"] + 1)
    )
    monkeypatch.setattr(
        library_scan, "start_watcher", lambda: calls.__setitem__("watch", calls["watch"] + 1)
    )
    backend.save_settings({"autoScanOnStart": True, "autoRefresh": True})
    backend.init_library()
    assert calls == {"scan": 1, "watch": 1}
    backend.save_settings({"autoScanOnStart": False, "autoRefresh": False})
    backend.init_library()
    assert calls == {"scan": 1, "watch": 1}  # 不再额外调用


# ============ 统一设置（6 namespace Settings API）============
def test_api_settings_get_all_namespaces():
    """GET /api/settings 返回 7 namespace 全量，每 namespace 合并默认值"""
    r = client.get("/api/settings")
    assert r.status_code == 200
    s = r.json()["settings"]
    assert set(s) == {"library", "ui", "lyric", "playback", "desktopLyric", "player", "download"}
    # library 4 字段
    assert set(s["library"]) == {"audioExts", "ignoreHidden", "autoRefresh", "autoScanOnStart"}
    assert s["library"]["audioExts"] == backend.DEFAULT_AUDIO_EXTS
    # ui 10 字段（含任务 D searchHistory）
    assert set(s["ui"]) == {
        "showSongInfo",
        "karaokeShowTime",
        "karaokeShowNum",
        "theme",
        "miniTheme",
        "accent",
        "coverBlur",
        "compact",
        "showCover",
        "searchHistory",
    }
    assert s["ui"]["theme"] == "dark" and s["ui"]["accent"] == "orange"
    assert s["ui"]["showCover"] is True
    assert s["ui"]["searchHistory"] == []
    # lyric 15 字段（与前端 LYRIC_SETTINGS_DEFAULTS 一致）
    assert set(s["lyric"]) == set(backend.LYRIC_SETTINGS_DEFAULTS)
    assert (
        s["lyric"]["fontSize"] == 20 and s["lyric"]["focusPos"] == 0.5 and s["lyric"]["offset"] == 0
    )
    # playback 15 字段（含睡眠定时器，与前端 PLAYBACK_SETTINGS_DEFAULTS 一致）
    assert set(s["playback"]) == set(backend.PLAYBACK_SETTINGS_DEFAULTS)
    assert s["playback"]["playMode"] == "order" and s["playback"]["eqGains"] == [0] * 10
    assert s["playback"]["sleepTimerOn"] is False and s["playback"]["sleepTimerMinutes"] == 30
    # 任务 K：visualizerStyle 默认 'bars'，与前端 PLAYBACK_SETTINGS_DEFAULTS 一致
    assert s["playback"]["visualizerStyle"] == "bars"
    # desktopLyric 11 字段
    assert set(s["desktopLyric"]) == set(backend.DESKTOP_LYRIC_DEFAULTS)
    assert s["desktopLyric"]["fontSize"] == 26
    # player 4 字段
    assert s["player"] == {"volume": 1.0, "panel": True, "controls": False, "lastPlayed": None}
    # download 2 字段
    assert set(s["download"]) == {
        "downloadDir",
        "defaultQuality",
        "quarkQuality",
        "engine",
        "aria2Rpc",
        "aria2Secret",
    }
    assert s["download"]["downloadDir"] == ""
    assert s["download"]["defaultQuality"] == "exhigh"
    assert s["download"]["quarkQuality"] == "mp3"


def test_api_settings_put_deep_merge():
    """PUT 两级深合并：只改传入字段，未传字段不动；返回合并后全量"""
    r = client.put("/api/settings", json={"lyric": {"fontSize": 24}, "player": {"volume": 0.5}})
    assert r.status_code == 200
    s = r.json()["settings"]
    assert s["lyric"]["fontSize"] == 24
    assert s["player"]["volume"] == 0.5
    assert s["lyric"]["align"] == "left"  # 未传字段保持默认
    assert s["player"]["panel"] is True
    # 再改另一批，之前的改动保留
    r = client.put("/api/settings", json={"lyric": {"offset": 1.2}})
    s = r.json()["settings"]
    assert s["lyric"]["fontSize"] == 24  # 保留
    assert s["lyric"]["offset"] == 1.2
    # 落盘后重置缓存（模拟重启）再读
    state._settings = None
    s = client.get("/api/settings").json()["settings"]
    assert s["lyric"]["fontSize"] == 24 and s["lyric"]["offset"] == 1.2
    assert s["player"]["volume"] == 0.5


def test_api_settings_put_validation():
    """字段校验：非法值回落默认；eqGains clamp ±12；volume clamp 0~1；lastPlayed 非法回落 null"""
    r = client.put(
        "/api/settings",
        json={
            "lyric": {"fontSize": "big", "align": "diagonal", "colorScheme": "neon"},
            "ui": {"theme": 123, "compact": "yes", "showCover": "no"},
            "playback": {
                "eqGains": [99] * 10,
                "abLoopMaxCount": 0,
                "playMode": "weird",
                "visualizerStyle": "spiral",
            },
            "player": {"volume": 5, "panel": "x", "lastPlayed": {"path": 1}},
        },
    )
    s = r.json()["settings"]
    assert s["lyric"]["fontSize"] == 20  # 非法类型回落默认
    assert s["lyric"]["align"] == "left"
    assert s["lyric"]["colorScheme"] == "neon"  # 合法字符串保留
    assert s["ui"]["theme"] == "dark"
    assert s["ui"]["compact"] is False
    assert s["ui"]["showCover"] is True  # 类型非法回落默认
    assert s["playback"]["eqGains"] == [12.0] * 10  # clamp 到 +12
    assert s["playback"]["abLoopMaxCount"] == 1  # 越界 clamp 到 1~20（与前端一致）
    assert s["playback"]["playMode"] == "order"
    assert s["playback"]["visualizerStyle"] == "bars"  # 枚举非法回落默认
    assert s["player"]["volume"] == 1.0  # clamp 0~1
    assert s["player"]["panel"] is True
    assert s["player"]["lastPlayed"] is None  # 非法结构回落 null

    # sleepTimer：合法值保留、非法值回落默认
    r = client.put(
        "/api/settings", json={"playback": {"sleepTimerOn": True, "sleepTimerMinutes": 45}}
    )
    assert r.json()["settings"]["playback"]["sleepTimerOn"] is True
    assert r.json()["settings"]["playback"]["sleepTimerMinutes"] == 45
    r = client.put(
        "/api/settings", json={"playback": {"sleepTimerOn": "x", "sleepTimerMinutes": 20}}
    )
    assert r.json()["settings"]["playback"]["sleepTimerOn"] is False
    assert r.json()["settings"]["playback"]["sleepTimerMinutes"] == 30  # 不在选项内回落 30

    # eqGains 长度不对 / 含非数字 → 全 0；负值 clamp 到 -12
    r = client.put("/api/settings", json={"playback": {"eqGains": [1, 2]}})
    assert r.json()["settings"]["playback"]["eqGains"] == [0] * 10
    r = client.put("/api/settings", json={"playback": {"eqGains": [1, "x"] * 5}})
    assert r.json()["settings"]["playback"]["eqGains"] == [0] * 10
    r = client.put("/api/settings", json={"playback": {"eqGains": [-99] * 10}})
    assert r.json()["settings"]["playback"]["eqGains"] == [-12.0] * 10

    # lastPlayed 合法结构保留
    r = client.put(
        "/api/settings", json={"player": {"lastPlayed": {"path": "/a/b.mp3", "time": 12.5}}}
    )
    assert r.json()["settings"]["player"]["lastPlayed"] == {"path": "/a/b.mp3", "time": 12.5}

    # 任务 K：showCover / visualizerStyle 合法值保留
    r = client.put(
        "/api/settings",
        json={"ui": {"showCover": False}, "playback": {"visualizerStyle": "wave"}},
    )
    s = r.json()["settings"]
    assert s["ui"]["showCover"] is False
    assert s["playback"]["visualizerStyle"] == "wave"
    r = client.put(
        "/api/settings",
        json={"ui": {"showCover": 1}, "playback": {"visualizerStyle": "particle!"}},
    )
    s = r.json()["settings"]
    assert s["ui"]["showCover"] is True  # 非法类型回落默认 True
    assert s["playback"]["visualizerStyle"] == "bars"  # 非法枚举回落默认


def test_api_settings_put_unknown_namespace_ignored():
    """未知 namespace 忽略；namespace 值非对象忽略"""
    r = client.put(
        "/api/settings", json={"hack": {"x": 1}, "library": 123, "player": {"volume": 0.3}}
    )
    s = r.json()["settings"]
    assert "hack" not in s
    assert s["player"]["volume"] == 0.3
    assert s["library"]["ignoreHidden"] is True  # 原值保留（默认）


def test_api_settings_search_history_validation():
    """searchHistory：字符串数组校验——过滤非字符串/空白、截断 10 条、非列表回落默认、落盘保留"""
    # 合法字符串数组：保留顺序（最新在前），落盘后可读回
    r = client.put("/api/settings", json={"ui": {"searchHistory": ["晴天", "五月天", "周杰伦"]}})
    s = r.json()["settings"]
    assert s["ui"]["searchHistory"] == ["晴天", "五月天", "周杰伦"]
    state._settings = None  # 模拟重启
    assert client.get("/api/settings").json()["settings"]["ui"]["searchHistory"] == [
        "晴天",
        "五月天",
        "周杰伦",
    ]
    # 过滤非字符串/空白 + trim
    r = client.put(
        "/api/settings",
        json={"ui": {"searchHistory": [" 晴天 ", 42, None, "", "   ", "好歌"]}},
    )
    assert r.json()["settings"]["ui"]["searchHistory"] == ["晴天", "好歌"]
    # 超过 10 条截断（保留前 10 = 最新）
    r = client.put("/api/settings", json={"ui": {"searchHistory": [f"词{i}" for i in range(12)]}})
    assert r.json()["settings"]["ui"]["searchHistory"] == [f"词{i}" for i in range(10)]
    # 空列表合法（用户清空历史）
    r = client.put("/api/settings", json={"ui": {"searchHistory": []}})
    assert r.json()["settings"]["ui"]["searchHistory"] == []
    # 非列表（字符串/数字/对象）→ 回落默认 []
    r = client.put("/api/settings", json={"ui": {"searchHistory": "晴天,五月天"}})
    assert r.json()["settings"]["ui"]["searchHistory"] == []
    r = client.put("/api/settings", json={"ui": {"searchHistory": 123}})
    assert r.json()["settings"]["ui"]["searchHistory"] == []
    r = client.put("/api/settings", json={"ui": {"searchHistory": {"a": 1}}})
    assert r.json()["settings"]["ui"]["searchHistory"] == []
    # 未传该字段 → 不动（深合并语义）
    r = client.put("/api/settings", json={"ui": {"theme": "light"}})
    s = r.json()["settings"]
    assert s["ui"]["theme"] == "light"
    assert s["ui"]["searchHistory"] == []


def test_migrate_legacy_settings():
    """旧三文件一次性迁移：旧 settings.json(library) + ui_settings.json + desktop_lyric.json → 统一结构"""
    # 造旧格式文件（autouse fixture 已把三个路径隔离到 tmp_path）
    backend.SETTINGS_FILE.write_text(
        json.dumps({"audioExts": [".mp3"], "ignoreHidden": False}), encoding="utf-8"
    )
    backend.UI_SETTINGS_FILE.write_text(
        json.dumps({"theme": "light", "miniTheme": "dark", "extra": 1}), encoding="utf-8"
    )
    backend.DESKTOP_LYRIC_FILE.write_text(
        json.dumps({"enabled": True, "fontSize": 30}), encoding="utf-8"
    )
    backend.migrate_legacy_settings()
    s = backend.load_all_settings()
    # library 数据并入 library namespace
    assert s["library"]["audioExts"] == [".mp3"]
    assert s["library"]["ignoreHidden"] is False
    assert s["library"]["autoRefresh"] is True  # 默认保留
    # ui 只迁 theme/miniTheme，未知字段丢弃
    assert s["ui"]["theme"] == "light"
    assert s["ui"]["miniTheme"] == "dark"
    assert "extra" not in s["ui"]
    assert s["ui"]["accent"] == "orange"  # 未迁移字段用默认
    # desktopLyric 全量迁移
    assert s["desktopLyric"]["enabled"] is True
    assert s["desktopLyric"]["fontSize"] == 30
    # 旧文件保留不删（备份）
    assert backend.SETTINGS_FILE.exists()
    assert backend.UI_SETTINGS_FILE.exists()
    assert backend.DESKTOP_LYRIC_FILE.exists()


def test_migrate_legacy_settings_idempotent():
    """迁移幂等：重复执行结果不变；新格式文件已存在 → 整体跳过不再覆盖"""
    backend.SETTINGS_FILE.write_text(json.dumps({"audioExts": [".mp3"]}), encoding="utf-8")
    backend.migrate_legacy_settings()
    first = json.loads(backend.SETTINGS_FILE.read_text(encoding="utf-8"))
    assert set(first) == {
        "library",
        "ui",
        "lyric",
        "playback",
        "desktopLyric",
        "player",
        "download",
    }
    state._settings = None
    backend.migrate_legacy_settings()  # 再跑一次
    second = json.loads(backend.SETTINGS_FILE.read_text(encoding="utf-8"))
    assert first == second
    # 已是新格式 → 跳过，后续改动不被覆盖
    first["library"]["autoRefresh"] = False
    backend.SETTINGS_FILE.write_text(json.dumps(first), encoding="utf-8")
    state._settings = None
    backend.migrate_legacy_settings()
    assert backend.load_all_settings()["library"]["autoRefresh"] is False


def test_migrate_legacy_settings_no_data_noop():
    """无任何旧数据 → 不写文件（保持默认）"""
    backend.migrate_legacy_settings()
    assert not backend.SETTINGS_FILE.exists()


def test_migrate_legacy_settings_keeps_player_namespace():
    """迁移时 player namespace 用默认值；迁移后写入新值不被旧文件覆盖"""
    backend.SETTINGS_FILE.write_text(json.dumps({"audioExts": [".mp3"]}), encoding="utf-8")
    backend.migrate_legacy_settings()
    backend.save_all_settings(
        {"player": {"volume": 0.7, "lastPlayed": {"path": "/x.mp3", "time": 3}}}
    )
    state._settings = None
    backend.migrate_legacy_settings()  # 新格式已存在 → 跳过
    s = backend.load_all_settings()
    assert s["player"]["volume"] == 0.7
    assert s["player"]["lastPlayed"] == {"path": "/x.mp3", "time": 3}


# ============ 兼容层：旧三端点读写统一存储 ============
def test_compat_ui_settings_reads_unified_store():
    """GET/PUT /api/ui/settings 读写统一 settings.json 的 ui namespace（现可接受全部 9 字段）"""
    client.put("/api/settings", json={"ui": {"theme": "light", "accent": "blue", "compact": True}})
    s = client.get("/api/ui/settings").json()["settings"]
    assert s["theme"] == "light" and s["accent"] == "blue" and s["compact"] is True
    # 兼容层写 → 新区读
    client.put("/api/ui/settings", json={"miniTheme": "dark"})
    s = client.get("/api/settings").json()["settings"]["ui"]
    assert s["miniTheme"] == "dark" and s["theme"] == "light"
    # 兼容层 PUT 接受全部 9 个 ui 字段
    client.put(
        "/api/ui/settings",
        json={
            "showSongInfo": True,
            "karaokeShowTime": True,
            "karaokeShowNum": False,
            "coverBlur": True,
            "showCover": False,
        },
    )
    s = client.get("/api/ui/settings").json()["settings"]
    assert s["showSongInfo"] is True
    assert s["karaokeShowTime"] is True
    assert s["karaokeShowNum"] is False
    assert s["coverBlur"] is True
    assert s["showCover"] is False
    # 非法字段忽略（回落默认）
    client.put("/api/ui/settings", json={"theme": 999})
    assert client.get("/api/ui/settings").json()["settings"]["theme"] == "dark"


def test_compat_desktop_lyric_settings_reads_unified_store():
    """GET/PUT /api/desktop-lyric/settings 读写统一存储的 desktopLyric namespace"""
    client.put("/api/settings", json={"desktopLyric": {"enabled": True, "fontSize": 30}})
    s = client.get("/api/desktop-lyric/settings").json()["settings"]
    assert s["enabled"] is True and s["fontSize"] == 30
    # 兼容层写 → 新区读
    client.put("/api/desktop-lyric/settings", json={"align": "right"})
    s = client.get("/api/settings").json()["settings"]["desktopLyric"]
    assert s["align"] == "right" and s["enabled"] is True


def test_compat_library_settings_reads_unified_store(song_library):
    """GET/PUT /api/library/settings 读写统一存储的 library namespace（扫描副作用保持）"""
    client.put("/api/settings", json={"library": {"audioExts": [".flac"], "autoRefresh": False}})
    s = client.get("/api/library/settings").json()["settings"]
    assert s["audioExts"] == [".flac"] and s["autoRefresh"] is False
    # 兼容层写 → 新区读
    client.put("/api/library/settings", json={"ignoreHidden": False})
    s = client.get("/api/settings").json()["settings"]["library"]
    assert s["ignoreHidden"] is False and s["audioExts"] == [".flac"]


# ============ 手动指定歌词 ============
def test_manual_lyric_flow(song_library, tmp_path):
    """保存 → 查询 → 手动优先（盖过本地 srt）→ 清除恢复自动"""
    song = tmp_path / "yakimochi" / "song.mp3"
    # 初始：无指定
    r = client.get("/api/lyric/manual", params={"path": str(song)})
    assert r.json() == {"specified": False}
    # 保存
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "lrc", "text": "[00:01.00]手动指定", "source": "粘贴"},
    )
    assert r.status_code == 200
    assert r.json()["format"] == "lrc"
    # 查询
    r = client.get("/api/lyric/manual", params={"path": str(song)})
    assert r.json()["specified"] is True
    assert r.json()["source"] == "粘贴"
    # /api/lyric：手动优先，盖过同目录 srt
    r = client.get("/api/lyric", params={"path": str(song)})
    assert r.json()["source"] == "manual"
    assert r.json()["lines"][0]["text"][0] == "手动指定"
    # prefer=online 时手动仍优先
    r = client.get("/api/lyric", params={"path": str(song), "prefer": "online"})
    assert r.json()["source"] == "manual"
    # 清除 → 恢复本地 srt
    r = client.delete("/api/lyric/manual", params={"path": str(song)})
    assert r.json() == {"ok": True, "removed": True}
    r = client.get("/api/lyric", params={"path": str(song)})
    assert r.json()["source"] == "local"


def test_manual_lyric_srt_format(song_library, tmp_path):
    """SRT 格式手动指定：保存 + 解析"""
    song = tmp_path / "五月天 - 知足.mp3"
    srt = "1\n00:00:01,000 --> 00:00:05,000\n指定歌词行\n"
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "srt", "text": srt, "source": "上传"},
    )
    assert r.status_code == 200
    r = client.get("/api/lyric", params={"path": str(song)})
    assert r.json()["format"] == "srt"
    assert r.json()["source"] == "manual"
    assert r.json()["lines"][0]["text"][0] == "指定歌词行"


def test_manual_lyric_with_tlyric(song_library, tmp_path):
    """JSON 歌词上传（lrc + tlyric）：/api/lyric 合并中文翻译"""
    song = tmp_path / "yakimochi" / "song.mp3"
    lrc = "[00:01.00]原文第一行\n[00:05.00]原文第二行\n"
    tlyric = "[00:01.00]翻译第一行\n[00:05.00]翻译第二行\n"
    r = client.put(
        "/api/lyric/manual",
        json={
            "path": str(song),
            "format": "lrc",
            "text": lrc,
            "source": "上传·x.json",
            "tlyric": tlyric,
        },
    )
    assert r.status_code == 200
    assert r.json()["tlyric"] == tlyric
    r = client.get("/api/lyric", params={"path": str(song)})
    assert r.json()["source"] == "manual"
    lines = r.json()["lines"]
    assert lines[0]["text"][0] == "原文第一行"
    assert lines[0]["text"][2] == "翻译第一行"  # 中文翻译已合并
    # 查询接口也返回 tlyric
    r = client.get("/api/lyric/manual", params={"path": str(song)})
    assert r.json()["tlyric"] == tlyric


def test_manual_lyric_invalid_content(song_library, tmp_path):
    """内容解析不出歌词行 → 400，不保存"""
    song = tmp_path / "yakimochi" / "song.mp3"
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "lrc", "text": "没有任何时间戳的纯文本"},
    )
    assert r.status_code == 400
    r = client.get("/api/lyric/manual", params={"path": str(song)})
    assert r.json() == {"specified": False}


def test_manual_lyric_missing_fields():
    """缺 path / 空内容 → 400"""
    assert (
        client.put("/api/lyric/manual", json={"format": "lrc", "text": "[00:01.00]x"}).status_code
        == 400
    )
    assert (
        client.put("/api/lyric/manual", json={"path": "/x.mp3", "text": "   "}).status_code == 400
    )


def test_manual_lyric_auto_translation(song_library, tmp_path, monkeypatch):
    """未带 tlyric 的保存：自动补翻译并落盘（行级匹配在 lyric_fetch，这里验证后端调用与存储）"""
    song = tmp_path / "yakimochi" / "song.mp3"
    lrc = "[00:01.00]君が前に付き合っていた人のこと\n"
    calls = {}

    def fake_auto(title, artist, text, fmt="lrc"):
        calls["args"] = (title, artist, text, fmt)
        return "[00:01.00]你之前交往过的人的事\n"

    monkeypatch.setattr(router_lyrics, "auto_attach_translation", fake_auto)
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "lrc", "text": lrc, "source": "粘贴"},
    )
    assert r.status_code == 200
    assert r.json()["tlyric"] == "[00:01.00]你之前交往过的人的事\n"
    # 歌名/歌手取自歌曲文件元数据
    assert calls["args"] == ("ヤキモチ", "高橋優", lrc, "lrc")
    # /api/lyric 合并翻译进歌词行
    r = client.get("/api/lyric", params={"path": str(song)})
    assert r.json()["source"] == "manual"
    assert r.json()["lines"][0]["text"][2] == "你之前交往过的人的事"


def test_manual_lyric_srt_auto_translation(song_library, tmp_path, monkeypatch):
    """SRT 手动歌词保存：自动补翻译传入 srt 格式（翻译时间戳 = SRT 起始时间）"""
    song = tmp_path / "yakimochi" / "song.mp3"
    srt = "1\n00:00:10,000 --> 00:00:15,000\n君が前に付き合っていた人のこと\n"
    calls = {}

    def fake_auto(title, artist, text, fmt="lrc"):
        calls["args"] = (title, artist, text, fmt)
        return "[00:10.00]你之前交往过的人的事\n"

    monkeypatch.setattr(router_lyrics, "auto_attach_translation", fake_auto)
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "srt", "text": srt, "source": "上传"},
    )
    assert r.status_code == 200
    assert calls["args"] == ("ヤキモチ", "高橋優", srt, "srt")
    assert r.json()["tlyric"] == "[00:10.00]你之前交往过的人的事\n"


def test_manual_lyric_auto_not_called_with_explicit_tlyric(song_library, tmp_path, monkeypatch):
    """请求体显式带 tlyric → 尊重用户，不自动补翻译"""
    song = tmp_path / "yakimochi" / "song.mp3"

    def boom(*a, **kw):
        raise AssertionError("不该自动补翻译")

    monkeypatch.setattr(router_lyrics, "auto_attach_translation", boom)
    tlyric = "[00:01.00]用户自带翻译\n"
    r = client.put(
        "/api/lyric/manual",
        json={
            "path": str(song),
            "format": "lrc",
            "text": "[00:01.00]原文\n",
            "source": "上传·x.json",
            "tlyric": tlyric,
        },
    )
    assert r.status_code == 200
    assert r.json()["tlyric"] == tlyric


def test_manual_lyric_auto_skip_without_metadata(song_library, tmp_path, monkeypatch):
    """无歌名/歌手元数据的歌 → 跳过自动补翻译，保存不受影响"""
    song = tmp_path / "no_tags.mp3"
    make_mp3(song)  # 无 ID3 标签
    calls = []

    def fake_auto(*a, **kw):
        calls.append(a)
        return "[00:01.00]不应出现\n"

    monkeypatch.setattr(router_lyrics, "auto_attach_translation", fake_auto)
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "lrc", "text": "[00:01.00]ok\n", "source": "粘贴"},
    )
    assert r.status_code == 200
    assert calls == []
    assert "tlyric" not in r.json()


def test_manual_lyric_auto_failure_silent(song_library, tmp_path, monkeypatch):
    """自动补翻译失败（返回 None）→ 保存成功且不附带 tlyric"""
    song = tmp_path / "yakimochi" / "song.mp3"
    monkeypatch.setattr(router_lyrics, "auto_attach_translation", lambda *a, **kw: None)
    r = client.put(
        "/api/lyric/manual",
        json={"path": str(song), "format": "lrc", "text": "[00:01.00]原文\n", "source": "粘贴"},
    )
    assert r.status_code == 200
    assert "tlyric" not in r.json()
    r = client.get("/api/lyric/manual", params={"path": str(song)})
    assert r.json()["specified"] is True
    assert "tlyric" not in r.json()


def test_lyric_search_api(song_library, monkeypatch):
    """搜索 API：返回候选列表；空关键词 400"""
    monkeypatch.setattr(
        router_lyrics,
        "search_lyric_candidates",
        lambda t, a: [{"source": "netease", "title": "T", "artist": "A", "text": "[00:01.00]hi"}],
    )
    r = client.get("/api/lyric/search", params={"title": "T", "artist": "A"})
    assert r.status_code == 200
    assert len(r.json()["results"]) == 1
    assert r.json()["results"][0]["source"] == "netease"
    r = client.get("/api/lyric/search", params={"title": "   "})
    assert r.status_code == 400


# ============ 桌面歌词/迷你窗：now-playing 上报 + 播放控制指令队列 ============


def test_api_now_playing_roundtrip():
    """now-playing 上报完整字段（含迷你窗需要的 name/artist/duration/isPlaying）→ GET 原样返回"""
    backend._now_playing_lock.acquire()
    try:
        backend._now_playing["path"] = None
        backend._now_playing["updatedAt"] = 0.0
    finally:
        backend._now_playing_lock.release()
    r = client.post(
        "/api/now-playing",
        json={
            "path": "/x/song.mp3",
            "name": "ヤキモチ",
            "artist": "高橋優",
            "duration": 240.0,
            "currentTime": 12.5,
            "isPlaying": True,
            "volume": 0.7,
            "lineIndex": 3,
            "accent": "#ff7e6b",
        },
    )
    assert r.status_code == 200
    body = client.get("/api/now-playing").json()
    assert body["path"] == "/x/song.mp3"
    assert body["name"] == "ヤキモチ"
    assert body["artist"] == "高橋優"
    assert body["duration"] == 240.0
    assert body["currentTime"] == 12.5
    assert body["isPlaying"] is True
    assert body["volume"] == 0.7
    assert body["lineIndex"] == 3
    assert body["accent"] == "#ff7e6b"


def test_api_player_action_queue():
    """指令入队 → 轮询取走并清空（迷你窗控制主播放器的核心链路）"""
    for a in ["togglePlay", "next", "prev"]:
        assert client.post("/api/player/action", json={"action": a}).status_code == 200
    r = client.get("/api/player/actions")
    assert r.status_code == 200
    assert r.json()["actions"] == [
        {"action": "togglePlay", "value": None},
        {"action": "next", "value": None},
        {"action": "prev", "value": None},
    ]
    # 取走即清空
    assert client.get("/api/player/actions").json()["actions"] == []


def test_api_player_action_unknown_rejected():
    """非法指令拒绝入队"""
    assert client.post("/api/player/action", json={"action": "rm -rf"}).json()["ok"] is False
    assert client.get("/api/player/actions").json()["actions"] == []


def test_api_player_action_seek_volume_validation():
    """seek/volume 必须带数值，且 clamp 到合法范围"""
    assert client.post("/api/player/action", json={"action": "seek"}).json()["ok"] is False
    assert (
        client.post("/api/player/action", json={"action": "volume", "value": "loud"}).json()["ok"]
        is False
    )
    assert (
        client.post("/api/player/action", json={"action": "seek", "value": -5}).status_code == 200
    )
    assert (
        client.post("/api/player/action", json={"action": "volume", "value": 2.5}).status_code
        == 200
    )
    actions = client.get("/api/player/actions").json()["actions"]
    assert actions == [
        {"action": "seek", "value": 0.0},
        {"action": "volume", "value": 1.0},
    ]


def test_api_mini_status_roundtrip():
    """迷你窗运行状态：Swift 壳上报 → GET 返回；非 bool 拒绝"""
    assert client.post("/api/mini/status", json={"running": True}).status_code == 200
    assert client.get("/api/mini/status").json() == {"running": True}
    assert client.post("/api/mini/status", json={"running": False}).status_code == 200
    assert client.get("/api/mini/status").json() == {"running": False}
    assert client.post("/api/mini/status", json={"running": "yes"}).json()["ok"] is False
    assert client.post("/api/mini/status", json={}).json()["ok"] is False


def test_api_ui_settings_roundtrip():
    """主题设置：迷你窗读 / 主窗口写；非法值回落默认；未知字段忽略；文件隔离不碰真实用户数据"""
    # 默认值
    s = client.get("/api/ui/settings").json()["settings"]
    assert s["theme"] == "dark"
    assert s["miniTheme"] == "theme"

    # 保存 → 读回
    assert client.put("/api/ui/settings", json={"theme": "light"}).status_code == 200
    s = client.get("/api/ui/settings").json()["settings"]
    assert s["theme"] == "light"
    assert s["miniTheme"] == "theme"

    assert client.put("/api/ui/settings", json={"miniTheme": "dark"}).status_code == 200
    s = client.get("/api/ui/settings").json()["settings"]
    assert s["miniTheme"] == "dark"
    # 未提交字段保留
    assert s["theme"] == "light"

    # 非法类型回落默认；未知字段忽略
    assert client.put("/api/ui/settings", json={"theme": 123, "hack": "x"}).status_code == 200
    s = client.get("/api/ui/settings").json()["settings"]
    assert s["theme"] == "dark"  # 统一校验：非法值回落默认
    assert "hack" not in s

    # 统一存储已落盘（settings.json 的 ui namespace）
    on_disk = json.loads(backend.SETTINGS_FILE.read_text(encoding="utf-8"))
    assert on_disk["ui"]["theme"] == "dark"


# ============ download settings namespace ============
def test_settings_download_namespace():
    """download namespace：默认值 / 合法值保留 / 非法值回落默认"""
    assert backend.load_all_settings()["download"] == {
        "downloadDir": "",
        "defaultQuality": "exhigh",
        "quarkQuality": "mp3",
        "engine": "httpx",
        "aria2Rpc": "http://localhost:6800/jsonrpc",
        "aria2Secret": "dax",
    }
    # 合法值保留
    s = backend.save_all_settings(
        {"download": {"downloadDir": "/tmp/dl", "defaultQuality": "lossless"}}
    )["download"]
    assert s["downloadDir"] == "/tmp/dl"
    assert s["defaultQuality"] == "lossless"
    # 新增字段（歌曲海/下载引擎）合法值保留
    s = backend.save_all_settings({"download": {"quarkQuality": "flac", "engine": "aria2"}})[
        "download"
    ]
    assert s["quarkQuality"] == "flac"
    assert s["engine"] == "aria2"
    # 非法值回落默认
    s = backend.save_all_settings({"download": {"downloadDir": 123, "defaultQuality": "jymaster"}})[
        "download"
    ]
    assert s["downloadDir"] == ""  # 非字符串回落默认
    assert s["defaultQuality"] == "exhigh"  # 不在白名单回落默认
    # 非法音质/引擎枚举回落默认
    s = backend.save_all_settings({"download": {"quarkQuality": "wav", "engine": "wget"}})[
        "download"
    ]
    assert s["quarkQuality"] == "mp3"
    assert s["engine"] == "httpx"
    # 合法音质枚举保留
    s = backend.save_all_settings({"download": {"defaultQuality": "hires"}})["download"]
    assert s["defaultQuality"] == "hires"


def test_api_settings_put_download_namespace():
    """PUT /api/settings 可写入 download namespace"""
    r = client.put(
        "/api/settings", json={"download": {"downloadDir": "/x/y", "defaultQuality": "standard"}}
    )
    assert r.status_code == 200
    d = r.json()["settings"]["download"]
    assert d["downloadDir"] == "/x/y"
    assert d["defaultQuality"] == "standard"


# ============ 在线搜索/下载（网易云 eapi） ============
class _FakeStreamResp:
    """mock httpx.stream 的响应：chunk 迭代 + raise_for_status"""

    def __init__(self, chunks):
        self._chunks = chunks
        self._error = None

    def fail(self, error):
        self._error = error
        return self

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def raise_for_status(self):
        if self._error:
            raise self._error

    def iter_bytes(self):
        yield from self._chunks


@pytest.fixture
def fake_stream(monkeypatch):
    """mock backend.httpx.stream：记录 (method, url, kwargs)，返回可控 chunk 流"""
    state = {"calls": [], "chunks": [b"ID3 fake audio bytes"]}

    def stream_fn(method, url, **kw):
        state["calls"].append((method, url, kw))
        return _FakeStreamResp(state["chunks"])

    monkeypatch.setattr(backend.httpx, "stream", stream_fn)
    return state


SEARCH_ITEM = {
    "id": "186016",
    "title": "晴天",
    "artist": "周杰伦",
    "album": "叶惠美",
    "cover": "http://p1.music.126.net/cover.jpg",
    "duration": "04:29",
    "level": "exhigh",
}


def test_api_online_search_ok(monkeypatch):
    """搜索返回 items；q/limit 透传给 provider"""
    captured = {}

    def fake_search(q, limit=20):
        captured["q"] = q
        captured["limit"] = limit
        return [SEARCH_ITEM]

    monkeypatch.setattr(netease_provider, "search", fake_search)
    r = client.get("/api/online/search", params={"q": "晴天", "limit": 2})
    assert r.status_code == 200
    assert captured == {"q": "晴天", "limit": 2}
    items = r.json()["items"]
    assert items == [SEARCH_ITEM]


def test_api_online_search_empty_q():
    """q 为空/纯空白 → 400"""
    assert client.get("/api/online/search").status_code == 400
    assert client.get("/api/online/search", params={"q": "   "}).status_code == 400


def test_api_online_search_limit_clamp(monkeypatch):
    """limit clamp 到 1-50（默认 20）"""
    limits = []

    def fake_search(q, limit=20):
        limits.append(limit)
        return []

    monkeypatch.setattr(netease_provider, "search", fake_search)
    client.get("/api/online/search", params={"q": "x", "limit": 999})
    client.get("/api/online/search", params={"q": "x", "limit": 0})
    client.get("/api/online/search", params={"q": "x"})
    assert limits == [50, 1, 20]


def test_api_online_download_success(monkeypatch, fake_stream, tmp_path):
    """下载落盘到 download.downloadDir；文件名清洗（去掉 : /）；响应结构"""
    backend.save_all_settings({"download": {"downloadDir": str(tmp_path)}})
    monkeypatch.setattr(
        netease_provider,
        "get_play_info",
        lambda sid, level="exhigh": {
            "url": "http://cdn.example.com/a.mp3",
            "ext": "mp3",
            "bitrate": "320",
        },
    )
    r = client.post(
        "/api/online/download",
        json={"id": "123", "title": "歌:曲/测试", "artist": "歌手", "level": "exhigh"},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["path"] == str(tmp_path / "歌曲测试-歌手.mp3")
    assert (tmp_path / "歌曲测试-歌手.mp3").read_bytes() == b"ID3 fake audio bytes"
    # 直链 + 浏览器 UA 透传
    method, url, kw = fake_stream["calls"][0]
    assert method == "GET"
    assert url == "http://cdn.example.com/a.mp3"
    assert "User-Agent" in kw["headers"]


def test_api_online_download_dir_setting(monkeypatch, fake_stream, tmp_path):
    """downloadDir 为空 → 落到当前 LIBRARY；无 title/artist 用 id 兜底"""
    old = backend.LIBRARY
    state.LIBRARY = tmp_path / "lib"
    (tmp_path / "lib").mkdir()
    try:
        monkeypatch.setattr(
            netease_provider,
            "get_play_info",
            lambda sid, level="exhigh": {"url": "http://x/y.mp3", "ext": "mp3", "bitrate": "128"},
        )
        r = client.post("/api/online/download", json={"id": "1"})
        assert r.status_code == 200
        assert r.json()["path"] == str(tmp_path / "lib" / "1.mp3")
        assert (tmp_path / "lib" / "1.mp3").exists()
    finally:
        state.LIBRARY = old


def test_api_online_download_no_url(monkeypatch):
    """provider 无直链 → 404 error"""
    monkeypatch.setattr(netease_provider, "get_play_info", lambda sid, level="exhigh": {})
    r = client.post("/api/online/download", json={"id": "1"})
    assert r.status_code == 404
    assert "error" in r.json()


def test_api_online_download_provider_error(monkeypatch):
    """provider 抛异常 → 404 error"""

    def boom(sid, level="exhigh"):
        raise RuntimeError("no url")

    monkeypatch.setattr(netease_provider, "get_play_info", boom)
    r = client.post("/api/online/download", json={"id": "1"})
    assert r.status_code == 404
    assert "error" in r.json()


def test_api_online_download_missing_id():
    """缺 id / id 为空白 → 400"""
    assert client.post("/api/online/download", json={}).status_code == 400
    assert client.post("/api/online/download", json={"id": "  "}).status_code == 400


def test_api_online_download_stream_failure(monkeypatch, fake_stream, tmp_path):
    """流式下载失败 → 404；不留下半成品文件"""
    backend.save_all_settings({"download": {"downloadDir": str(tmp_path)}})
    monkeypatch.setattr(
        netease_provider,
        "get_play_info",
        lambda sid, level="exhigh": {"url": "http://x/a.mp3", "ext": "mp3", "bitrate": "320"},
    )

    def fail(method, url, **kw):
        return _FakeStreamResp([]).fail(httpx.HTTPError("403 forbidden"))

    monkeypatch.setattr(backend.httpx, "stream", fail)
    r = client.post("/api/online/download", json={"id": "1", "title": "t"})
    assert r.status_code == 404
    assert not (tmp_path / "t.mp3").exists()


def test_sanitize_filename():
    """文件名清洗：去掉 / \\ : * ? " < > | 与首尾空白"""
    assert backend._sanitize_filename('a/b\\c:d*e?f"g<h>i|j  ') == "abcdefghij"
    assert backend._sanitize_filename("  正常 名字 ") == "正常 名字"
    assert backend._sanitize_filename(None) == ""
    assert backend._sanitize_filename("///") == ""


# ============ 曲库导入 /api/import ============
def _import_files(*pairs):
    """pairs: (filename, bytes) → multipart files 参数（字段名统一 files）"""
    return [("files", (name, data, "application/octet-stream")) for name, data in pairs]


def test_api_import_basic(song_library):
    """正常导入多文件：复制进库（源字节一致）、version+1、扫描能扫到"""
    v0 = client.get("/api/library/version").json()["version"]
    r = client.post(
        "/api/import",
        files=_import_files(("新歌.mp3", b"ID3 fake bytes"), ("贝斯.flac", b"fLaC fake")),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == 2
    assert body["skipped"] == []
    assert body["errors"] == []
    assert (song_library / "新歌.mp3").read_bytes() == b"ID3 fake bytes"
    assert (song_library / "贝斯.flac").read_bytes() == b"fLaC fake"
    # version +1（前端 3s 轮询自动刷新曲库）
    assert client.get("/api/library/version").json()["version"] == v0 + 1
    # 导入后库扫描能扫到
    names = {s["name"] for s in backend.scan_library()}
    assert {"新歌", "贝斯"} <= names
    assert len(backend.scan_library()) == 4  # fixture 2 首 + 导入 2 首


def test_api_import_duplicate_suffix(song_library):
    """同名冲突不覆盖：第二次导入同名 → xxx (1).mp3，源文件字节不变"""
    r1 = client.post("/api/import", files=_import_files(("歌.mp3", b"AAA")))
    assert r1.json()["imported"] == 1
    r2 = client.post("/api/import", files=_import_files(("歌.mp3", b"BBB")))
    assert r2.json()["imported"] == 1
    r3 = client.post("/api/import", files=_import_files(("歌.mp3", b"CCC")))
    assert r3.json()["imported"] == 1
    assert (song_library / "歌.mp3").read_bytes() == b"AAA"
    assert (song_library / "歌 (1).mp3").read_bytes() == b"BBB"
    assert (song_library / "歌 (2).mp3").read_bytes() == b"CCC"
    # 同一请求里同名也各自加后缀
    r4 = client.post("/api/import", files=_import_files(("歌.mp3", b"DDD"), ("歌.mp3", b"EEE")))
    assert r4.json()["imported"] == 2
    assert (song_library / "歌 (3).mp3").read_bytes() == b"DDD"
    assert (song_library / "歌 (4).mp3").read_bytes() == b"EEE"


def test_api_import_skip_non_audio(song_library):
    """非音频跳过（skipped 计数），混合请求只导入音频；imported=0 不 bump version"""
    v0 = client.get("/api/library/version").json()["version"]
    r = client.post(
        "/api/import",
        files=_import_files(
            ("a.mp3", b"AAA"),
            ("note.txt", b"hello"),
            ("photo.jpg", b"\xff\xd8jpeg"),
        ),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == 1
    assert body["skipped"] == ["note.txt", "photo.jpg"]
    assert body["errors"] == []
    assert (song_library / "a.mp3").read_bytes() == b"AAA"
    assert not (song_library / "note.txt").exists()
    assert not (song_library / "photo.jpg").exists()
    assert client.get("/api/library/version").json()["version"] == v0 + 1  # 有 1 个导入


def test_api_import_path_traversal(song_library):
    """文件名清洗/路径穿越防护：../、绝对路径、反斜杠只落为库内纯文件名，绝不写到 LIBRARY 外"""
    r = client.post(
        "/api/import",
        files=_import_files(
            ("../evil.mp3", b"X"),
            ("/tmp/abs.mp3", b"Y"),
            ("..\\win.mp3", b"Z"),
            ("a:b?c.mp3", b"W"),
        ),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == 4
    assert body["errors"] == []
    # 库外/系统路径未被写入
    assert not (song_library.parent / "evil.mp3").exists()
    assert not Path("/tmp/abs.mp3").exists()
    assert not (song_library.parent / "win.mp3").exists()
    # 清洗后都在 LIBRARY 内
    assert (song_library / "evil.mp3").read_bytes() == b"X"
    assert (song_library / "abs.mp3").read_bytes() == b"Y"
    assert (song_library / "..win.mp3").read_bytes() == b"Z"
    assert (song_library / "abc.mp3").read_bytes() == b"W"


def test_api_import_too_large(song_library, monkeypatch):
    """超大文件报 error 不崩：不落盘、不 bump version"""
    monkeypatch.setattr(state, "IMPORT_MAX_BYTES", 1024)
    v0 = client.get("/api/library/version").json()["version"]
    big = b"x" * 2048
    r = client.post(
        "/api/import",
        files=_import_files(("big.mp3", big), ("ok.mp3", b"small")),
    )
    assert r.status_code == 200
    body = r.json()
    assert body["imported"] == 1  # 小文件照常导入
    assert body["skipped"] == []
    assert len(body["errors"]) == 1
    assert body["errors"][0]["name"] == "big.mp3"
    assert "上限" in body["errors"][0]["detail"]
    assert not (song_library / "big.mp3").exists()  # 超限文件不残留
    assert (song_library / "ok.mp3").read_bytes() == b"small"
    assert client.get("/api/library/version").json()["version"] == v0 + 1


def test_api_import_no_files():
    """不传 files 字段 → 422（FastAPI 必填校验），不崩"""
    r = client.post("/api/import")
    assert r.status_code == 422
