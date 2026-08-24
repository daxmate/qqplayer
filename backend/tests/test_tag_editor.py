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
from tag_editor import UnsupportedFormatError, save_tags, target_filename  # noqa: E402

client = TestClient(backend.app)

FAKE_JPEG = b"\xff\xd8\xff\xe0" + b"x" * 200


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：settings.json 写临时目录（/api/tags 保存时读 rename_template），每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    state._settings = None
    yield
    state._settings = None


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
    artist, title, album, *_ = backend.extract_tags(new)
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
    artist, title, album, *_ = backend.extract_tags(new)
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
    artist, title, album, *_ = backend.extract_tags(new)
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
    artist, title, album, *_ = backend.extract_tags(new)
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
    assert backend.extract_tags(f) == ("旧歌手", "旧名", None, None, "", None, "")
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
    assert backend.extract_tags(f) == ("周杰伦", "安静", None, None, "", None, "")


def test_album_only_no_rename_name_falls_back_to_stem(tmp_path):
    f = tmp_path / "song.mp3"
    make_mp3(f)
    result = save_tags(f, album="范特西")
    assert result["renamed"] is False
    assert result["path"] == str(f)
    assert result["name"] == "song"
    assert backend.extract_tags(f) == (None, None, "范特西", None, "", None, "")


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
    """预置三个旧 JSON 数据文件（favorites/playlists/playback）含旧路径引用。

    SQLite 版：JSON 文件由首次 DB 访问时的自动迁移导入（旧文件改 .migrated.bak），
    迁移源路径与 DB 都落在 tmp 临时目录（DB 路径由 conftest 注入）。
    """
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
    """写标签 + 改名 + favorites/playlists/playback 旧路径自动迁移（JSON → SQLite）"""
    from app import db as app_db

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
    # 首次 DB 访问触发自动迁移：三个旧 JSON 改名 .migrated.bak
    assert (data_dir / "favorites.json.migrated.bak").exists()
    assert (data_dir / "playlists.json.migrated.bak").exists()
    assert (data_dir / "playback.json.migrated.bak").exists()
    # 三表迁移 + 旧路径引用替换为改名后路径
    assert app_db.favorites_load() == [str(new), "/other/fav.mp3"]
    pls = app_db.playlists_load()
    assert pls[0]["songPaths"] == [str(new), "/other/song.mp3", str(new)]
    assert pls[1]["songPaths"] == []
    records = app_db.playback_all()
    assert [r_["path"] for r_ in records] == [str(new), "/other/rec.mp3"]


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
    assert backend.extract_tags(f) == ("旧歌手", "旧名", None, None, "", None, "")
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
    assert backend.extract_tags(new) == ("周杰伦", "安静", None, None, "", None, "")
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


# ============ 新字段 year/genre/track/album_artist（四格式写入）============
def test_save_tags_mp3_new_fields(tmp_path):
    """MP3 写 year(TYER)/genre(TCON)/track(TRCK)/album_artist(TPE2) 并读回"""
    f = tmp_path / "song.mp3"
    make_mp3(f)
    r = save_tags(
        f,
        title="安静",
        artist="周杰伦",
        year=2001,
        genre="流行/华语",
        track=3,
        album_artist="合集歌手",
    )
    artist, title, _album, year, genre, track, album_artist = backend.extract_tags(Path(r["path"]))
    assert (artist, title) == ("周杰伦", "安静")
    assert (year, genre, track, album_artist) == (2001, "流行/华语", 3, "合集歌手")
    from mutagen.id3 import ID3

    tags = ID3(str(Path(r["path"])))
    # mutagen 写 TYER 时自动转存 TDRC（v2.3/v2.4 兼容由 mutagen 处理）
    assert str(tags["TDRC"].text[0]) == "2001"
    assert str(tags["TCON"].text[0]) == "流行/华语"
    assert str(tags["TRCK"].text[0]) == "3"
    assert str(tags["TPE2"].text[0]) == "合集歌手"


def test_save_tags_m4a_new_fields(tmp_path):
    """M4A 写 ©day/©gen/trkn/aART 并读回"""
    f = tmp_path / "song.m4a"
    make_m4a(f)
    r = save_tags(
        f, title="安静", artist="周杰伦", year=2001, genre="流行", track=3, album_artist="合集歌手"
    )
    _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(Path(r["path"]))
    assert (year, genre, track, album_artist) == (2001, "流行", 3, "合集歌手")
    from mutagen.mp4 import MP4

    audio = MP4(str(Path(r["path"])))
    assert audio["\xa9day"] == ["2001"]
    assert audio["\xa9gen"] == ["流行"]
    assert audio["trkn"] == [(3, 0)]
    assert audio["aART"] == ["合集歌手"]


def test_save_tags_flac_new_fields(tmp_path):
    """FLAC 写 date/genre/tracknumber/albumartist 并读回"""
    f = tmp_path / "song.flac"
    make_flac(f)
    r = save_tags(
        f, title="安静", artist="周杰伦", year=2001, genre="流行", track=3, album_artist="合集歌手"
    )
    _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(Path(r["path"]))
    assert (year, genre, track, album_artist) == (2001, "流行", 3, "合集歌手")
    from mutagen.flac import FLAC

    audio = FLAC(str(Path(r["path"])))
    assert audio["date"] == ["2001"]
    assert audio["genre"] == ["流行"]
    assert audio["tracknumber"] == ["3"]
    assert audio["albumartist"] == ["合集歌手"]


def test_save_tags_ogg_new_fields(tmp_path):
    """OGG 写 date/genre/tracknumber/albumartist 并读回"""
    f = tmp_path / "song.ogg"
    make_ogg(f)
    r = save_tags(
        f, title="安静", artist="周杰伦", year=2001, genre="流行", track=3, album_artist="合集歌手"
    )
    _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(Path(r["path"]))
    assert (year, genre, track, album_artist) == (2001, "流行", 3, "合集歌手")


def test_save_tags_new_fields_empty_untouched(tmp_path):
    """不传新字段 → 不写（year None/genre ""/track None/album_artist ""）"""
    f = tmp_path / "song.mp3"
    make_mp3(f, title="旧名", artist="旧歌手")
    r = save_tags(f, title="新名", artist="新歌手")
    _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(Path(r["path"]))
    assert (year, genre, track, album_artist) == (None, "", None, "")


# ============ 重命名模板渲染 ============
def test_target_filename_default_template_regression():
    """默认模板 {artist} - {title} 行为与历史完全一致（回归）"""
    assert target_filename("周杰伦", "安静", ".mp3") == "周杰伦 - 安静.mp3"
    assert target_filename("", "安静", ".mp3") == "安静.mp3"
    assert target_filename("周杰伦", "", ".mp3") == "周杰伦.mp3"
    assert target_filename("", "", ".mp3") is None
    # 非法文件名字符清洗沿用（AC/DC → ACDC）
    assert target_filename("AC/DC", "Highway", ".mp3") == "ACDC - Highway.mp3"
    # 显式传默认模板字符串 → 同样走默认分支，结果一致
    assert (
        target_filename("周杰伦", "安静", ".mp3", template="{artist} - {title}")
        == "周杰伦 - 安静.mp3"
    )


def test_target_filename_custom_template_fields():
    """自定义模板占位符 {track}/{year}/{album} 渲染；空值渲染空串并清理残留分隔符"""
    t = "{track}. {artist} - {title} ({year})"
    assert (
        target_filename("周杰伦", "安静", ".mp3", album="范特西", track=3, year=2001, template=t)
        == "3. 周杰伦 - 安静 (2001).mp3"
    )
    # 空占位符 → 空串；前导分隔符被清理
    assert target_filename("周杰伦", "安静", ".mp3", template="{track} - {title}") == "安静.mp3"
    # 所有占位符都空 → None（不改名）
    assert target_filename("", "", ".mp3", template="{artist} - {title} - {year}") is None
    # album 占位符 + 子目录
    assert (
        target_filename("周杰伦", "安静", ".mp3", album="范特西", template="{album}/{title}")
        == "范特西/安静.mp3"
    )


def test_target_filename_template_sanitize():
    """模板路径清洗：非法字符去除（保留 / 子目录）；/ . .. 路径段过滤防穿越"""
    assert (
        target_filename("周杰伦", '安/静:歌"曲?<x>|y*', ".mp3", template="{artist} - {title}")
        == "周杰伦 - 安静歌曲xy.mp3"
    )
    assert target_filename("..", "x", ".mp3", template="{artist}/{title}") == "x.mp3"
    assert target_filename("a", "b", ".mp3", template="../{title}") == "b.mp3"


def test_save_tags_template_subdirectory(tmp_path):
    """模板含 / → 在文件所在目录下建子目录移动；引用迁移回调收到新旧路径"""
    f = tmp_path / "song.mp3"
    make_mp3(f)
    migrated = []
    r = save_tags(
        f,
        title="安静",
        artist="周杰伦",
        album="范特西",
        rename_template="{artist}/{album} - {title}",
        migrate=lambda old, new: migrated.append((old, new)),
    )
    new = tmp_path / "周杰伦" / "范特西 - 安静.mp3"
    assert r["renamed"] is True
    assert r["path"] == str(new)
    assert new.exists() and not f.exists()
    # 子目录移动引用迁移同样生效（新旧路径完整）
    assert migrated == [(str(f), str(new))]
    assert backend.extract_tags(new)[:2] == ("周杰伦", "安静")


def test_save_tags_template_subdirectory_dedupe(tmp_path):
    """子目录内重名 → 加 (2) 序号（去重基于新目录），绝不覆盖"""
    f = tmp_path / "song.mp3"
    make_mp3(f)
    sub = tmp_path / "周杰伦"
    sub.mkdir()
    (sub / "范特西 - 安静.mp3").write_bytes(b"occupied")
    r = save_tags(
        f,
        title="安静",
        artist="周杰伦",
        album="范特西",
        rename_template="{artist}/{album} - {title}",
    )
    assert r["path"] == str(sub / "范特西 - 安静 (2).mp3")
    assert (sub / "范特西 - 安静.mp3").read_bytes() == b"occupied"  # 绝不覆盖


# ============ extract_tags 新字段解析（各格式 key 差异）============
def test_extract_tags_id3_new_fields(tmp_path):
    """ID3：TDRC（日期串取年份）/TCON/TRCK("3/12" 取 3)/TPE2"""
    from mutagen.id3 import ID3, TCON, TDRC, TPE2, TRCK

    f = tmp_path / "song.mp3"
    make_mp3(f)
    tags = ID3(str(f))
    tags.add(TDRC(encoding=3, text="2001-06-15"))
    tags.add(TCON(encoding=3, text="流行"))
    tags.add(TRCK(encoding=3, text="3/12"))
    tags.add(TPE2(encoding=3, text="合集"))
    tags.save(f)
    artist, title, _al, year, genre, track, album_artist = backend.extract_tags(f)
    assert (artist, title) == (None, None)
    assert (year, genre, track, album_artist) == (2001, "流行", 3, "合集")


def test_extract_tags_mp4_new_fields(tmp_path):
    """MP4：©day(前 4 位)/©gen(list 取第一个)/trkn/ aART"""
    from mutagen.mp4 import MP4

    f = tmp_path / "song.m4a"
    make_m4a(f)
    audio = MP4(str(f))
    audio["\xa9day"] = ["2001-06-15"]
    audio["\xa9gen"] = ["流行", "华语"]
    audio["trkn"] = [(3, 12)]
    audio["aART"] = ["合集"]
    audio.save(f)
    _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(f)
    assert (year, genre, track, album_artist) == (2001, "流行", 3, "合集")


def test_extract_tags_vorbis_new_fields(tmp_path):
    """FLAC/OGG：DATE 优先 / YEAR 兜底；GENRE/TRACKNUMBER/ALBUMARTIST"""
    for ext, maker in ((".flac", make_flac), (".ogg", make_ogg)):
        f = tmp_path / f"song{ext}"
        maker(f)
        from mutagen.flac import FLAC
        from mutagen.oggvorbis import OggVorbis

        audio = FLAC(str(f)) if ext == ".flac" else OggVorbis(str(f))
        audio["date"] = ["2001-06-15"]
        audio["genre"] = ["流行"]
        audio["tracknumber"] = ["3"]
        audio["albumartist"] = ["合集"]
        audio.save()
        _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(f)
        assert (year, genre, track, album_artist) == (2001, "流行", 3, "合集"), ext
        # YEAR 兜底（无 DATE）
        audio["date"] = []
        audio["year"] = ["1999"]
        audio.save()
        _a, _t, _al, year, *_ = backend.extract_tags(f)
        assert year == 1999, ext


def test_extract_tags_missing_new_fields_defaults(tmp_path):
    """无新字段 → year None / genre "" / track None / album_artist ""；损坏文件也不抛异常"""
    f = tmp_path / "song.mp3"
    make_mp3(f)
    _a, _t, _al, year, genre, track, album_artist = backend.extract_tags(f)
    assert (year, genre, track, album_artist) == (None, "", None, "")
    bad = tmp_path / "bad.mp3"
    bad.write_bytes(b"\x00\x01\x02 not audio")
    assert backend.extract_tags(bad) == (None, None, None, None, "", None, "")
