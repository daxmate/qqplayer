"""tag_editor 写标签 + 原子写 + 改名 + 引用迁移测试（真实 tmp 文件，不依赖仓库内真实音频）"""

import json
import struct
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import backend  # noqa: E402
import tag_editor  # noqa: E402
from app import state  # noqa: E402
from tag_editor import UnsupportedFormatError, save_tags  # noqa: E402

client = TestClient(backend.app)

FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"x" * 200


# ============ 假音频文件生成（真实磁盘文件，mutagen 可读写）============
def make_mp3(path, title=None, artist=None, album=None, cover=None):
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


def make_m4a(path):
    def atom(t, payload):
        return struct.pack(">I", 8 + len(payload)) + t + payload

    ftyp = atom(b"ftyp", b"M4A \x00\x00\x02\x00M4A mp42isom")
    path.write_bytes(ftyp + atom(b"moov", b"") + atom(b"mdat", b"\x00" * 64))


def make_flac(path):
    pre = struct.pack(">HH", 4096, 4096) + b"\x00\x00\x00" + b"\x00\x00\x00"
    sr_ch_bits = (44100 << 8) | ((2 - 1) << 5) | (16 - 1)
    tail = (sr_ch_bits << 36).to_bytes(8, "big")
    streaminfo = pre + tail + b"\x00" * 16
    path.write_bytes(b"fLaC" + b"\x80\x00\x00\x22" + streaminfo)


def make_ogg(path):
    def page(payload, seq=0, header_type=0):
        segs = []
        rest = payload
        while len(rest) >= 255:
            segs.append(255)
            rest = rest[255:]
        segs.append(len(rest))
        return (
            b"OggS\x00"
            + bytes([header_type])
            + struct.pack("<q", 0)
            + struct.pack("<I", 1)
            + struct.pack("<I", seq)
            + b"\x00\x00\x00\x00"
            + bytes([len(segs)])
            + bytes(segs)
            + payload
        )

    vid = (
        b"\x01vorbis"
        + struct.pack("<I", 0)
        + bytes([2])
        + struct.pack("<I", 44100)
        + struct.pack("<i", 0) * 3
        + bytes([0xB8])
        + b"\x01"
    )
    vendor = b"QQPlayerTest"
    vcom = b"\x03vorbis" + struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", 0) + b"\x01"
    mode = (0 << 41) | 0
    vsetup = (
        b"\x05vorbis"
        + bytes([0])
        + struct.pack("<B", 1)
        + bytes([0])
        + struct.pack("<B", 0)
        + struct.pack("<B", 0)
        + struct.pack("<B", 0)
        + struct.pack("<B", 1)
        + mode.to_bytes(6, "little")
        + b"\x01"
    )
    path.write_bytes(page(vid, header_type=2) + page(vcom, seq=1) + page(vsetup, seq=2))


# ============ 写标签：三格式 文本+封面 ============
def test_save_tags_mp3_text_and_cover(tmp_path, monkeypatch):
    f = tmp_path / "song.mp3"
    make_mp3(f, title="旧名", artist="旧歌手")
    monkeypatch.setattr(tag_editor, "fetch_cover", lambda url: FAKE_JPEG)
    result = save_tags(
        f, title="安静", artist="周杰伦", album="范特西", cover_url="https://x/c.jpg"
    )
    new = tmp_path / "周杰伦 - 安静.mp3"
    assert result["path"] == str(new)
    assert result["newPath"] == str(new)
    assert result["renamed"] is True
    assert result["name"] == "安静"
    assert not f.exists() and new.exists()
    artist, title, album = backend.extract_tags(new)
    assert (artist, title, album) == ("周杰伦", "安静", "范特西")
    from mutagen.id3 import ID3

    apics = ID3(str(new)).getall("APIC")
    assert len(apics) == 1 and apics[0].data == FAKE_JPEG


def test_save_tags_m4a_text_and_cover(tmp_path, monkeypatch):
    f = tmp_path / "song.m4a"
    make_m4a(f)
    monkeypatch.setattr(tag_editor, "fetch_cover", lambda url: FAKE_JPEG)
    result = save_tags(
        f, title="安静", artist="周杰伦", album="范特西", cover_url="https://x/c.jpg"
    )
    new = tmp_path / "周杰伦 - 安静.m4a"
    assert result["renamed"] is True
    assert new.exists()
    artist, title, album = backend.extract_tags(new)
    assert (artist, title, album) == ("周杰伦", "安静", "范特西")
    from mutagen.mp4 import MP4, MP4Cover

    covr = MP4(str(new))["covr"]
    assert bytes(covr[0]) == FAKE_JPEG
    assert covr[0].imageformat == MP4Cover.FORMAT_JPEG


def test_save_tags_flac_text_and_cover(tmp_path, monkeypatch):
    f = tmp_path / "song.flac"
    make_flac(f)
    monkeypatch.setattr(tag_editor, "fetch_cover", lambda url: FAKE_JPEG)
    result = save_tags(
        f, title="安静", artist="周杰伦", album="范特西", cover_url="https://x/c.jpg"
    )
    new = tmp_path / "周杰伦 - 安静.flac"
    assert result["renamed"] is True
    assert new.exists()
    artist, title, album = backend.extract_tags(new)
    assert (artist, title, album) == ("周杰伦", "安静", "范特西")
    from mutagen.flac import FLAC

    pictures = FLAC(str(new)).pictures
    assert len(pictures) == 1 and pictures[0].data == FAKE_JPEG


def test_save_tags_ogg_text_only_cover_skipped(tmp_path, monkeypatch):
    """OGG 只写文本标签，封面跳过且不报错"""
    f = tmp_path / "song.ogg"
    make_ogg(f)
    monkeypatch.setattr(tag_editor, "fetch_cover", lambda url: FAKE_JPEG)
    result = save_tags(
        f, title="安静", artist="周杰伦", album="范特西", cover_url="https://x/c.jpg"
    )
    new = tmp_path / "周杰伦 - 安静.ogg"
    assert result["renamed"] is True
    assert new.exists()
    artist, title, album = backend.extract_tags(new)
    assert (artist, title, album) == ("周杰伦", "安静", "范特西")


def test_save_tags_cover_none_keeps_original_cover(tmp_path, monkeypatch):
    """cover_url 为空 → 不碰封面（原有内嵌封面保留）"""
    f = tmp_path / "song.mp3"
    make_mp3(f, cover=FAKE_JPEG)
    result = save_tags(f, title="安静", artist="周杰伦")
    from mutagen.id3 import ID3

    apics = ID3(str(result["path"])).getall("APIC")
    assert len(apics) == 1 and apics[0].data == FAKE_JPEG


# ============ 原子写失败保护 ============
def test_atomic_write_failure_preserves_original(tmp_path, monkeypatch):
    f = tmp_path / "song.mp3"
    make_mp3(f, title="旧名", artist="旧歌手")

    def boom(*args, **kwargs):
        raise RuntimeError("写标签失败")

    monkeypatch.setattr(tag_editor, "_write_tags", boom)
    with pytest.raises(RuntimeError):
        save_tags(f, title="新名", artist="新歌手")
    # 原文件保持完好：内容与标签都没变
    assert f.exists()
    assert backend.extract_tags(f) == ("旧歌手", "旧名", None)
    # 临时文件已清理
    assert list(tmp_path.glob(".*.tagtmp-*")) == []


# ============ 改名 + 序号冲突 ============
def test_rename_collision_dedupes(tmp_path):
    f = tmp_path / "song.mp3"
    make_mp3(f)
    (tmp_path / "周杰伦 - 安静.mp3").write_bytes(b"occupied")
    result = save_tags(f, title="安静", artist="周杰伦")
    assert result["path"] == str(tmp_path / "周杰伦 - 安静 (2).mp3")
    assert result["renamed"] is True
    assert (tmp_path / "周杰伦 - 安静.mp3").read_bytes() == b"occupied"  # 绝不覆盖


def test_rename_artist_only(tmp_path):
    f = tmp_path / "song.mp3"
    make_mp3(f)
    result = save_tags(f, artist="周杰伦")
    assert result["path"] == str(tmp_path / "周杰伦.mp3")
    assert result["renamed"] is True


def test_no_rename_when_target_same_as_current(tmp_path):
    f = tmp_path / "周杰伦 - 安静.mp3"
    make_mp3(f)
    result = save_tags(f, title="安静", artist="周杰伦")
    assert result["renamed"] is False
    assert result["path"] == str(f) and result["newPath"] == str(f)
    assert backend.extract_tags(f) == ("周杰伦", "安静", None)


def test_album_only_no_rename_name_falls_back_to_stem(tmp_path):
    f = tmp_path / "song.mp3"
    make_mp3(f)
    result = save_tags(f, album="范特西")
    assert result["renamed"] is False
    assert result["path"] == str(f)
    assert result["name"] == "song"
    assert backend.extract_tags(f) == (None, None, "范特西")


def test_unsupported_format_raises(tmp_path):
    f = tmp_path / "song.wav"
    f.write_bytes(b"RIFFxxxxWAVE")
    with pytest.raises(UnsupportedFormatError):
        save_tags(f, title="安静", artist="周杰伦")
    assert f.exists()  # 原文件未被破坏


# ============ fetch_cover 下载 ============
def test_fetch_cover_ok_and_fail(monkeypatch):
    class Resp:
        def __init__(self, content, status=200):
            self.content = content
            self.status_code = status

        def raise_for_status(self):
            pass

    monkeypatch.setattr(tag_editor.httpx, "get", lambda url, **kw: Resp(FAKE_JPEG))
    assert tag_editor.fetch_cover("https://x/c.jpg") == FAKE_JPEG
    monkeypatch.setattr(tag_editor.httpx, "get", lambda url, **kw: Resp(b"not an image"))
    assert tag_editor.fetch_cover("https://x/c.jpg") is None
    monkeypatch.setattr(
        tag_editor.httpx, "get", lambda url, **kw: (_ for _ in ()).throw(httpx.HTTPError("down"))
    )
    assert tag_editor.fetch_cover("https://x/c.jpg") is None
    assert tag_editor.fetch_cover(None) is None
    assert tag_editor.fetch_cover("") is None


# ============ API 路由 ============
def _api_files(tmp_path, monkeypatch, old):
    """把三个数据文件指到临时目录并预置旧路径引用；返回数据目录"""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(state, "DATA_DIR", data_dir)
    fav = data_dir / "favorites.json"
    pls = data_dir / "playlists.json"
    pb = data_dir / "playback.json"
    monkeypatch.setattr(state, "FAVORITES_FILE", fav)
    monkeypatch.setattr(state, "PLAYLISTS_FILE", pls)
    monkeypatch.setattr(state, "PLAYBACK_FILE", pb)
    fav.write_text(json.dumps([old, "/other/fav.mp3"], ensure_ascii=False), encoding="utf-8")
    pls.write_text(
        json.dumps(
            [
                {"id": "p1", "name": "歌单", "songPaths": [old, "/other/song.mp3", old]},
                {"id": "p2", "name": "另一个", "songPaths": []},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    pb.write_text(
        json.dumps(
            [
                {"ts": "2026-01-01T00:00:00+00:00", "path": old, "played": 10},
                {"ts": "2026-01-02T00:00:00+00:00", "path": "/other/rec.mp3", "played": 5},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return data_dir


def test_api_tags_write_and_migrate_refs(tmp_path, monkeypatch):
    """写标签 + 改名 + favorites/playlists/playback 三文件旧路径自动迁移"""
    f = tmp_path / "song.mp3"
    make_mp3(f)
    data_dir = _api_files(tmp_path, monkeypatch, str(f))
    r = client.post(
        "/api/tags",
        json={"path": str(f), "title": "安静", "artist": "周杰伦", "album": "范特西"},
    )
    assert r.status_code == 200
    data = r.json()
    new = tmp_path / "周杰伦 - 安静.mp3"
    assert data["path"] == str(new) and data["newPath"] == str(new)
    assert data["renamed"] is True
    assert data["name"] == "安静"
    assert not f.exists() and new.exists()
    # 三文件迁移
    assert json.loads((data_dir / "favorites.json").read_text(encoding="utf-8")) == [
        str(new),
        "/other/fav.mp3",
    ]
    pls = json.loads((data_dir / "playlists.json").read_text(encoding="utf-8"))
    assert pls[0]["songPaths"] == [str(new), "/other/song.mp3", str(new)]
    assert pls[1]["songPaths"] == []
    pb = json.loads((data_dir / "playback.json").read_text(encoding="utf-8"))
    assert pb[0]["path"] == str(new)
    assert pb[1]["path"] == "/other/rec.mp3"


def test_api_tags_all_empty_400(tmp_path):
    f = tmp_path / "song.mp3"
    make_mp3(f)
    r = client.post("/api/tags", json={"path": str(f), "title": "", "artist": "", "album": ""})
    assert r.status_code == 400


def test_api_tags_unsupported_format_400(tmp_path):
    f = tmp_path / "song.aac"
    f.write_bytes(b"not really aac")
    r = client.post("/api/tags", json={"path": str(f), "title": "x", "artist": "y"})
    assert r.status_code == 400
    assert "不支持写标签" in r.json()["detail"]


def test_api_tags_missing_file_404(tmp_path):
    r = client.post("/api/tags", json={"path": str(tmp_path / "nope.mp3"), "title": "x"})
    assert r.status_code == 404


def test_api_tags_write_failure_409(tmp_path, monkeypatch):
    """改名场景下原子落位失败 → 409，原文件回滚保持完好"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="旧名", artist="旧歌手")
    real_replace = tag_editor.os.replace
    state = {"n": 0}

    def flaky_replace(src, dst):
        state["n"] += 1
        if state["n"] == 1:  # 唯一一次 replace（tmp → 目标名）失败
            raise OSError("rename failed")
        return real_replace(src, dst)

    monkeypatch.setattr(tag_editor.os, "replace", flaky_replace)
    r = client.post("/api/tags", json={"path": str(f), "title": "新名", "artist": "新歌手"})
    assert r.status_code == 409
    assert f.exists()  # 原文件回滚
    assert backend.extract_tags(f) == ("旧歌手", "旧名", None)
    assert list(tmp_path.glob(".*.tagtmp-*")) == []


def test_api_tags_cover_download_failure_ignored(tmp_path, monkeypatch):
    """cover 下载失败 → 忽略封面继续写文本标签（不报错）"""
    f = tmp_path / "song.mp3"
    make_mp3(f)
    monkeypatch.setattr(tag_editor, "fetch_cover", lambda url: None)
    r = client.post(
        "/api/tags",
        json={
            "path": str(f),
            "title": "安静",
            "artist": "周杰伦",
            "cover_url": "https://bad/cover.jpg",
        },
    )
    assert r.status_code == 200
    new = tmp_path / "周杰伦 - 安静.mp3"
    assert backend.extract_tags(new) == ("周杰伦", "安静", None)
    from mutagen.id3 import ID3

    assert ID3(str(new)).getall("APIC") == []  # 封面确实没写


# ============ scrape API ============
def test_api_tags_scrape_shape_and_query_from_title(tmp_path, monkeypatch):
    f = tmp_path / "song.mp3"
    make_mp3(f, title="安静", artist="周杰伦")
    seen = {}

    def fake_scrape(query, artist=""):
        seen["query"] = query
        seen["artist"] = artist
        return {"netease": [{"id": "1"}], "musicbrainz": []}

    monkeypatch.setattr(backend.tag_scraper, "scrape", fake_scrape)
    r = client.post("/api/tags/scrape", json={"path": str(f)})
    assert r.status_code == 200
    data = r.json()
    assert data["query"] == "安静" and seen["query"] == "安静"
    assert seen["artist"] == "周杰伦"
    assert data["netease"] == [{"id": "1"}] and data["musicbrainz"] == []


def test_api_tags_scrape_query_fallback_to_stem(tmp_path, monkeypatch):
    f = tmp_path / "无名歌.mp3"
    make_mp3(f)
    seen = {}

    def fake_scrape(query, artist=""):
        seen["query"] = query
        return {"netease": [], "musicbrainz": []}

    monkeypatch.setattr(backend.tag_scraper, "scrape", fake_scrape)
    r = client.post("/api/tags/scrape", json={"path": str(f)})
    assert r.status_code == 200
    assert seen["query"] == "无名歌"


def test_api_tags_scrape_missing_file_404(tmp_path):
    r = client.post("/api/tags/scrape", json={"path": str(tmp_path / "nope.mp3")})
    assert r.status_code == 404
