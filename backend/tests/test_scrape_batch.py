"""POST /api/tags/scrape-batch 批量刮削测试（mock 网络 + mock settings，CI 稳定）

覆盖：
- batch_enabled 关闭 → enabled:false 空结果（HTTP 200）
- paths 模式高置信度三分支：单候选 / 首候选 artist 匹配 / 文件无 artist 取首候选
- paths 模式不唯一且不匹配 → skipped；无候选 → skipped；缺文件 → skipped
- library 模式只补 year/genre（不覆盖 title/artist/album；已齐歌曲不处理）
- 100 首截断 truncated:true；单文件失败不中断整批；每首之间 sleep
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import app.routers.tags as tags_router  # noqa: E402
import backend  # noqa: E402
from app import state  # noqa: E402
from app.services import settings as settings_service  # noqa: E402

client = TestClient(backend.app)

NETEASE_CAND = {
    "title": "安静",
    "artist": "周杰伦",
    "album": "范特西",
    "year": 2001,
    "genre": "流行",
}
MB_CAND = {
    "title": "安静",
    "artist": "Jay Chou",
    "album": "Fantasy",
    "year": 2001,
    "genre": "pop",
    "track": 3,
    "album_artist": "Jay Chou",
}


def make_mp3(path, title=None, artist=None, album=None):
    from mutagen.id3 import ID3, TALB, TIT2, TPE1

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    if title:
        tags.add(TIT2(encoding=3, text=title))
    if artist:
        tags.add(TPE1(encoding=3, text=artist))
    if album:
        tags.add(TALB(encoding=3, text=album))
    tags.save(path)


@pytest.fixture(autouse=True)
def _isolate_storage(tmp_path, monkeypatch):
    """设置存储隔离：settings.json 写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    state._settings = None
    yield
    state._settings = None


@pytest.fixture(autouse=True)
def _no_batch_sleep(monkeypatch):
    """批量刮削每首歌之间 0.8s sleep 替换为 no-op（防慢/防限流）"""
    monkeypatch.setattr(tags_router, "_batch_sleep", lambda: None)


def _enable_batch():
    settings_service.save_all_settings({"scraping": {"batch_enabled": True}})


def _fake_scrape(monkeypatch, result):
    monkeypatch.setattr(backend.tag_scraper, "scrape", lambda query, artist="": result)


def _tags_of(path):
    return backend.extract_tags(path)


# ============ 开关与参数校验 ============
def test_batch_disabled_returns_enabled_false(tmp_path):
    """batch_enabled 默认关闭 → HTTP 200 空结果（前端据此提示）"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静", artist="周杰伦")
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    assert r.status_code == 200
    assert r.json() == {
        "enabled": False,
        "truncated": False,
        "results": [],
        "summary": {"total": 0, "written": 0, "skipped": 0, "failed": 0},
    }


def test_batch_invalid_body_400(tmp_path):
    """既无 paths 也无 mode=library → 400"""
    _enable_batch()
    r = client.post("/api/tags/scrape-batch", json={})
    assert r.status_code == 400


# ============ paths 模式：高置信度三分支 ============
def test_batch_paths_single_candidate_writes_all(tmp_path, monkeypatch):
    """单候选 → 高置信度；title/artist/album/year/genre 全写（覆盖）；不写 track/album_artist/封面"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="旧名", artist="旧歌手")
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": []})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    assert r.status_code == 200
    data = r.json()
    assert data["enabled"] is True and data["truncated"] is False
    assert data["summary"] == {"total": 1, "written": 1, "skipped": 0, "failed": 0}
    res = data["results"][0]
    assert res["status"] == "written" and res["reason"] == ""
    assert sorted(res["written"]) == ["album", "artist", "genre", "title", "year"]
    assert res["candidates"] == 1
    new = Path(res["path"])
    assert new.exists() and new.name == "周杰伦 - 安静.mp3"  # 默认模板改名
    artist, title, album, year, genre, track, album_artist = _tags_of(new)
    assert (artist, title, album) == ("周杰伦", "安静", "范特西")
    assert (year, genre) == (2001, "流行")
    # 批量保守：不写 track/album_artist
    assert track is None and album_artist == ""


def test_batch_paths_ambiguous_skipped(tmp_path, monkeypatch):
    """多候选且首候选 artist 与文件不匹配 → skipped 候选不唯一"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静", artist="林俊杰")
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": [MB_CAND]})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    res = r.json()["results"][0]
    assert res["status"] == "skipped" and res["reason"] == "候选不唯一"
    assert res["candidates"] == 2 and res["written"] == []
    # 文件未被改动
    assert _tags_of(f)[:2] == ("林俊杰", "安静")


def test_batch_paths_artist_match_high_confidence(tmp_path, monkeypatch):
    """多候选但首候选 artist 归一化匹配文件 artist → 高置信度写入（source_order 置 MB 在前）"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静", artist="Jay Chou")
    _enable_batch()
    settings_service.save_all_settings({"scraping": {"source_order": ["musicbrainz", "netease"]}})
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": [MB_CAND]})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    res = r.json()["results"][0]
    assert res["status"] == "written"
    # 首候选 = MusicBrainz（写入其字段：album Fantasy / genre pop）
    artist, _t, album, _y, genre, _tr, _aa = _tags_of(Path(res["path"]))
    assert (artist, album, genre) == ("Jay Chou", "Fantasy", "pop")


def test_batch_paths_no_artist_takes_first(tmp_path, monkeypatch):
    """文件无 artist → 取首候选（高置信度）"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静")
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": [MB_CAND]})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    res = r.json()["results"][0]
    assert res["status"] == "written"
    assert _tags_of(Path(res["path"]))[1] == "安静" and _tags_of(Path(res["path"]))[0] == "周杰伦"


def test_batch_paths_no_candidates_skipped(tmp_path, monkeypatch):
    """两源都无候选 → skipped 无候选"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静", artist="周杰伦")
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [], "musicbrainz": []})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    res = r.json()["results"][0]
    assert res["status"] == "skipped" and res["reason"] == "无候选"
    assert res["candidates"] == 0


def test_batch_paths_missing_file_skipped(tmp_path):
    """文件不存在 → skipped 文件不存在，不中断整批"""
    _enable_batch()
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(tmp_path / "nope.mp3")]})
    res = r.json()["results"][0]
    assert res["status"] == "skipped" and res["reason"] == "文件不存在"


def test_batch_paths_source_order_netease_first(tmp_path, monkeypatch):
    """source_order 默认 netease 在前 → 合并后首候选是网易云（写入其字段）"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静")
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": [MB_CAND]})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(f)]})
    res = r.json()["results"][0]
    assert res["status"] == "written" and res["candidates"] == 2
    artist, _t, album, _y, genre, _tr, _aa = _tags_of(Path(res["path"]))
    # 首候选 = 网易云（album 范特西 / genre 流行；无 track/album_artist）
    assert (artist, album, genre) == ("周杰伦", "范特西", "流行")


def test_batch_unsupported_format_failed_continues(tmp_path, monkeypatch):
    """单个文件写入失败（UnsupportedFormatError）→ failed，不中断整批"""
    bad = tmp_path / "bad.wav"
    bad.write_bytes(b"RIFFxxxxWAVE")
    ok = tmp_path / "ok.mp3"
    make_mp3(ok, title="安静", artist="周杰伦")
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": []})
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(bad), str(ok)]})
    data = r.json()
    assert [x["status"] for x in data["results"]] == ["failed", "written"]
    assert data["summary"] == {"total": 2, "written": 1, "skipped": 0, "failed": 1}
    assert "写入失败" in data["results"][0]["reason"]


def test_batch_sleep_between_songs(tmp_path, monkeypatch):
    """每首歌之间 sleep（N 首歌 → sleep N-1 次）"""
    files = []
    for i in range(3):
        f = tmp_path / f"song{i}.mp3"
        make_mp3(f, title=f"歌{i}", artist="歌手")
        files.append(f)
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [NETEASE_CAND], "musicbrainz": []})
    sleeps = []
    monkeypatch.setattr(tags_router, "_batch_sleep", lambda: sleeps.append(1))
    r = client.post("/api/tags/scrape-batch", json={"paths": [str(x) for x in files]})
    assert r.status_code == 200
    assert len(sleeps) == 2


def test_batch_truncated_100(tmp_path, monkeypatch):
    """超过 100 首 → 只处理前 100，truncated: true"""
    _enable_batch()
    _fake_scrape(monkeypatch, {"netease": [], "musicbrainz": []})
    paths = []
    for i in range(105):
        f = tmp_path / f"song{i:03d}.mp3"
        make_mp3(f, title=f"歌{i}")
        paths.append(str(f))
    r = client.post("/api/tags/scrape-batch", json={"paths": paths})
    data = r.json()
    assert data["truncated"] is True
    assert len(data["results"]) == 100
    assert data["summary"]["total"] == 100
    assert all(x["status"] == "skipped" for x in data["results"])


# ============ library 模式：只补 year/genre ============
def _make_library(tmp_path, with_full=False):
    """临时歌曲库：一首只有 title/artist（缺 year/genre），一首标签齐全"""
    lib = tmp_path / "lib"
    lib.mkdir()
    incomplete = lib / "incomplete.mp3"
    make_mp3(incomplete, title="旧名", artist="旧歌手")
    complete = lib / "complete.mp3"
    make_mp3(complete, title="完整", artist="歌手", album="专辑")
    from mutagen.id3 import ID3, TCON, TYER

    tags = ID3(str(complete))
    tags.add(TYER(encoding=3, text="2001"))
    tags.add(TCON(encoding=3, text="流行"))
    tags.save(complete)
    old = state.LIBRARY
    state.LIBRARY = lib
    return lib, incomplete, complete, old


def test_batch_library_mode_only_fills_year_genre(tmp_path, monkeypatch):
    """library 模式：只补 year/genre，不覆盖 title/artist/album；已齐歌曲不处理"""
    lib, incomplete, complete, old = _make_library(tmp_path)
    try:
        _enable_batch()
        _fake_scrape(
            monkeypatch,
            {"netease": [{**NETEASE_CAND, "title": "安静", "artist": "周杰伦"}], "musicbrainz": []},
        )
        r = client.post("/api/tags/scrape-batch", json={"mode": "library"})
        data = r.json()
        assert data["enabled"] is True and data["truncated"] is False
        assert data["summary"]["total"] == 1  # 只有缺 year/genre 的那首
        res = data["results"][0]
        assert res["status"] == "written"
        assert res["written"] == ["genre", "year"]
        # 只补 year/genre：title/artist/album 原样保留，未改名
        artist, title, album, year, genre, track, album_artist = _tags_of(incomplete)
        assert (artist, title, album) == ("旧歌手", "旧名", None)
        assert (year, genre) == (2001, "流行")
        # 标签齐全的歌曲未被处理（也不在 results 里）
        assert not (lib / "完整 - 歌手.mp3").exists()
    finally:
        state.LIBRARY = old


def test_batch_library_mode_candidate_without_year(tmp_path, monkeypatch):
    """library 模式：候选只有 genre → 只补 genre；候选两者都无 → skipped"""
    lib, incomplete, complete, old = _make_library(tmp_path)
    try:
        _enable_batch()
        _fake_scrape(monkeypatch, {"netease": [{"genre": "摇滚"}], "musicbrainz": []})
        r = client.post("/api/tags/scrape-batch", json={"mode": "library"})
        res = r.json()["results"][0]
        assert res["status"] == "written" and res["written"] == ["genre"]
        _a, _t, _al, year, genre, _tr, _aa = _tags_of(incomplete)
        assert (year, genre) == (None, "摇滚")
    finally:
        state.LIBRARY = old


def test_batch_library_mode_no_candidate_skipped(tmp_path, monkeypatch):
    """library 模式：候选无 year/genre → skipped 候选无 year/genre"""
    lib, incomplete, complete, old = _make_library(tmp_path)
    try:
        _enable_batch()
        _fake_scrape(monkeypatch, {"netease": [{"title": "x"}], "musicbrainz": []})
        r = client.post("/api/tags/scrape-batch", json={"mode": "library"})
        res = r.json()["results"][0]
        assert res["status"] == "skipped" and res["reason"] == "候选无 year/genre"
    finally:
        state.LIBRARY = old
