"""backend.py API 测试（使用 tests/songs 测试库）"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
TESTS_SONGS = ROOT / "tests" / "songs"

sys.path.insert(0, str(ROOT))
import backend  # noqa: E402

backend.LIBRARY = TESTS_SONGS

client = TestClient(backend.app)


# ============ 歌曲库扫描 ============
def test_scan_library_counts():
    songs = backend.scan_library()
    assert len(songs) == 2
    by_name = {s["name"]: s for s in songs}
    assert set(by_name) == {"ヤキモチ", "知足"}


def test_scan_library_metadata():
    by_name = {s["name"]: s for s in backend.scan_library()}
    yakimochi = by_name["ヤキモチ"]
    assert yakimochi["artist"] == "高橋優"
    assert yakimochi["ext"] == "mp3"
    assert yakimochi["has_lyric"] is True
    assert yakimochi["lyric"] == "yakimochi.srt"

    zhizu = by_name["知足"]
    assert zhizu["artist"] == "五月天"
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
def test_api_songs():
    r = client.get("/api/songs")
    assert r.status_code == 200
    assert len(r.json()) == 2


def test_api_library():
    r = client.get("/api/library")
    assert r.status_code == 200
    assert r.json()["path"] == str(TESTS_SONGS)


def test_api_set_library_invalid():
    r = client.post("/api/library", json={"path": "/no/such/dir"})
    assert r.status_code == 400


def test_api_audio_range():
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/audio", params={"path": song["path"]}, headers={"Range": "bytes=0-99"})
    assert r.status_code == 206
    assert len(r.content) == 100


def test_api_audio_missing():
    r = client.get("/api/audio", params={"path": "/no/such/file.mp3"})
    assert r.status_code == 404


# ============ 歌词 ============
def test_api_lyric_yakimochi():
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


def test_api_lyric_missing():
    song = next(s for s in backend.scan_library() if s["name"] == "知足")
    r = client.get("/api/lyric", params={"path": song["path"]})
    assert r.status_code == 404


# ============ 封面 ============
def test_api_cover_embedded():
    """测试资产自带内嵌封面（APIC）"""
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
