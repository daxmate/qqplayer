"""backend.py API 测试（测试数据用 tmp_path 现场生成假 mp3/srt，不依赖仓库内真实音频）"""

import json
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import backend  # noqa: E402

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
        backend.LIBRARY = tmp_path
        d = tmp_path / "yakimochi"
        d.mkdir()
        make_mp3(d / "song.mp3", title="ヤキモチ", artist="高橋優", album="開往明天的旅行")
        (d / "yakimochi.srt").write_text(SRT_TEXT, encoding="utf-8")
        make_mp3(tmp_path / "五月天 - 知足.mp3", title="知足", artist="五月天", cover=FAKE_JPEG)
        yield tmp_path
    finally:
        backend.LIBRARY = old


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """音乐库设置隔离：写临时文件不碰真实用户目录；每个测试后重置内存缓存"""
    monkeypatch.setattr(backend, "SETTINGS_FILE", tmp_path / "settings.json")
    backend._settings = None
    yield
    backend._settings = None


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
    backend.LIBRARY = tmp_path
    try:
        assert backend.scan_library() == []
    finally:
        backend.LIBRARY = old


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
    monkeypatch.setattr(backend, "fetch_online_lyric", lambda *a, **k: (None, None, None))
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/lyric", params={"path": song["path"]})
    assert r.status_code == 404


def test_api_lyric_online_fallback(song_library, monkeypatch):
    """本地无歌词时在线获取成功 → 200，带 source 和翻译合并"""
    lrc = "[00:10.00]沈むように溶けてゆくように\n[00:20.00]二人だけの空"
    tlyric = "[00:10.00]像是沉溺溶化一般\n[00:20.00]只有两人的天空"
    monkeypatch.setattr(backend, "fetch_online_lyric", lambda *a, **k: (lrc, tlyric, "netease"))
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
    monkeypatch.setattr(backend, "fetch_online_lyric", lambda *a, **k: (lrc, None, "lrclib"))
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
    monkeypatch.setattr(backend, "fetch_online_lyric", lambda *a, **k: (None, None, None))
    song = next(s for s in backend.scan_library() if s["name"] == "ヤキモチ")
    r = client.get("/api/lyric", params={"path": song["path"], "prefer": "online"})
    assert r.status_code == 200
    data = r.json()
    assert data["source"] == "local"
    assert data["format"] == "srt"


def test_api_lyric_prefer_online_missing(song_library, monkeypatch):
    """prefer=online、本地无歌词且在线失败 → 404"""
    monkeypatch.setattr(backend, "fetch_online_lyric", lambda *a, **k: (None, None, None))
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/lyric", params={"path": song["path"], "prefer": "online"})
    assert r.status_code == 404


def test_api_lyric_prefer_invalid_defaults_local(song_library, monkeypatch):
    """prefer 非法值 → 按 local 处理（本地优先）"""
    lrc = "[00:01.00]不应使用"
    monkeypatch.setattr(backend, "fetch_online_lyric", lambda *a, **k: (lrc, None, "netease"))
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
    monkeypatch.setattr(backend, "DATA_DIR", tmp_path)
    monkeypatch.setattr(backend, "FAVORITES_FILE", tmp_path / "favorites.json")
    r = client.get("/api/favorites")
    assert r.status_code == 200
    assert r.json() == {"paths": []}


def test_api_favorites_toggle(tmp_path, monkeypatch):
    monkeypatch.setattr(backend, "DATA_DIR", tmp_path)
    monkeypatch.setattr(backend, "FAVORITES_FILE", tmp_path / "favorites.json")
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
    monkeypatch.setattr(backend, "DATA_DIR", tmp_path)
    monkeypatch.setattr(backend, "FAVORITES_FILE", tmp_path / "favorites.json")
    client.post("/api/favorites/toggle", json={"path": "/a.mp3"})
    client.post("/api/favorites/toggle", json={"path": "/b.mp3"})
    r = client.get("/api/favorites")
    assert r.json() == {"paths": ["/a.mp3", "/b.mp3"]}


def test_api_favorites_missing_path(tmp_path, monkeypatch):
    monkeypatch.setattr(backend, "DATA_DIR", tmp_path)
    monkeypatch.setattr(backend, "FAVORITES_FILE", tmp_path / "favorites.json")
    r = client.post("/api/favorites/toggle", json={})
    assert r.status_code == 400


# ============ 播放记录 ============


def _playback(tmp_path, monkeypatch):
    """把 PLAYBACK_FILE 指到临时目录并返回该路径"""
    monkeypatch.setattr(backend, "DATA_DIR", tmp_path)
    p = tmp_path / "playback.json"
    monkeypatch.setattr(backend, "PLAYBACK_FILE", p)
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
    monkeypatch.setattr(backend, "PLAYBACK_LIMIT", 5)
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
    monkeypatch.setattr(backend, "DATA_DIR", tmp_path)
    monkeypatch.setattr(backend, "PLAYLISTS_FILE", tmp_path / "playlists.json")
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
        backend._scan_cache = None
        backend._scan_version = 0
        if backend._watch_timer is not None:
            backend._watch_timer.cancel()
            backend._watch_timer = None
    yield
    with backend._scan_lock:
        backend._scan_cache = None
        backend._scan_version = 0
        if backend._watch_timer is not None:
            backend._watch_timer.cancel()
            backend._watch_timer = None


def test_scan_library_cache_hit(song_library, monkeypatch):
    """同库二次扫描命中缓存，不再全量扫（_full_scan 只调一次）"""
    real = backend._full_scan
    calls = []

    def counting():
        calls.append(1)
        return real()

    monkeypatch.setattr(backend, "_full_scan", counting)
    backend.scan_library()
    backend.scan_library()
    assert len(calls) == 1


def test_scan_cache_invalid_when_library_changes(song_library, monkeypatch):
    """切换歌曲库路径后缓存自动失效（按 library 路径做 key）"""
    backend.scan_library()
    backend.LIBRARY = song_library / "sub"
    backend.LIBRARY.mkdir()
    make_mp3(backend.LIBRARY / "新歌.mp3", title="新歌")
    songs = backend.scan_library()
    assert len(songs) == 1 and songs[0]["name"] == "新歌"


def test_rescan_bumps_version_and_updates_cache(song_library):
    """库变动重扫：版本号 +1，缓存同步更新（新增文件能扫到）"""
    backend.scan_library()
    make_mp3(song_library / "新增.mp3", title="新增")
    backend._rescan()
    assert backend._scan_version == 1
    assert backend.scan_library() == backend._scan_cache["songs"]
    names = {s["name"] for s in backend.scan_library()}
    assert "新增" in names


def test_schedule_rescan_debounce(song_library, monkeypatch):
    """去抖：窗口内多次事件只触发一次重扫"""
    backend.WATCH_DEBOUNCE_SECONDS = 0.05
    calls = []
    monkeypatch.setattr(backend, "_rescan", lambda: calls.append(1))
    for _ in range(5):
        backend._schedule_rescan()
    assert len(calls) == 0  # 去抖窗口内还没执行
    import time

    time.sleep(0.2)
    assert len(calls) == 1  # 合并成一次


def test_handler_skips_dir_modified(song_library, monkeypatch):
    """目录自身 modified 事件（iCloud 同步频繁）不触发重扫；文件事件触发"""
    calls = []
    monkeypatch.setattr(backend, "_schedule_rescan", lambda: calls.append(1))
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
    backend.LIBRARY = song_library / "ghost"
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
    monkeypatch.setattr(backend, "start_watcher", lambda: None)
    monkeypatch.setattr(backend, "stop_watcher", lambda: None)
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
    backend._settings = None  # 模拟重启
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
    monkeypatch.setattr(backend, "start_watcher", lambda: calls.append("start"))
    monkeypatch.setattr(backend, "stop_watcher", lambda: calls.append("stop"))
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
        backend, "scan_library", lambda: calls.__setitem__("scan", calls["scan"] + 1)
    )
    monkeypatch.setattr(
        backend, "start_watcher", lambda: calls.__setitem__("watch", calls["watch"] + 1)
    )
    backend.save_settings({"autoScanOnStart": True, "autoRefresh": True})
    backend.init_library()
    assert calls == {"scan": 1, "watch": 1}
    backend.save_settings({"autoScanOnStart": False, "autoRefresh": False})
    backend.init_library()
    assert calls == {"scan": 1, "watch": 1}  # 不再额外调用
