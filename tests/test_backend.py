"""backend.py API 测试（测试数据用 tmp_path 现场生成假 mp3/srt，不依赖仓库内真实音频）"""

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
    path: Path, title: str | None = None, artist: str | None = None, cover: bytes | None = None
):
    """生成带 ID3 标签（可选内嵌封面 APIC）的假 mp3，模拟真实歌曲文件"""
    from mutagen.id3 import APIC, ID3, TIT2, TPE1

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    if title:
        tags.add(TIT2(encoding=3, text=title))
    if artist:
        tags.add(TPE1(encoding=3, text=artist))
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
        make_mp3(d / "song.mp3", title="ヤキモチ", artist="高橋優")
        (d / "yakimochi.srt").write_text(SRT_TEXT, encoding="utf-8")
        make_mp3(tmp_path / "五月天 - 知足.mp3", title="知足", artist="五月天", cover=FAKE_JPEG)
        yield tmp_path
    finally:
        backend.LIBRARY = old


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
