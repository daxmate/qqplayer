"""本地视频后端测试：videoDirs 设置 / 列表扫描 / Range 流 / 字幕解析 / 路径穿越拒绝

测试数据用 tmp_path 现场生成假视频文件（任意字节即可，后端不校验容器），
字幕用真实 SRT/VTT 文本；设置存储按惯例隔离到临时目录。
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402

client = TestClient(backend.app)

SRT_TEXT = """1
00:00:01,000 --> 00:00:03,500
こんにちは世界

2
00:00:04,000 --> 00:00:06,000
これはテストです
"""

VTT_TEXT = """WEBVTT

STYLE
::cue { color: yellow }

00:00:01.000 --> 00:00:02.500
Hello world

00:00:03.000 --> 00:00:04.500 align:start position:10%
Second line
"""


@pytest.fixture(autouse=True)
def _isolate_settings(tmp_path, monkeypatch):
    """设置存储隔离：写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(state, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(state, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(state, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    state._settings = None
    yield
    state._settings = None


def set_video_dirs(*dirs: Path) -> None:
    """写入 videoDirs 设置并落盘（走公开 PUT API，顺带验证设置接线）"""
    r = client.put("/api/settings", json={"video": {"videoDirs": [str(d) for d in dirs if d]}})
    assert r.status_code == 200
    assert r.json()["settings"]["video"]["videoDirs"] == [str(d) for d in dirs if d]


def make_video(path: Path, data: bytes = b"FAKE-VIDEO-BYTES-0123456789") -> Path:
    """生成假视频文件（后端只按扩展名/文件字节服务，不校验容器）"""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


# ============ videoDirs 设置 ============
def test_video_dirs_default_empty():
    """默认 videoDirs 为空数组，随 GET /api/settings 返回（video namespace 含 bilibiliCookie 默认空串）"""
    s = client.get("/api/settings").json()["settings"]["video"]
    assert s == {"videoDirs": [], "bilibiliCookie": ""}


def test_video_dirs_put_persist():
    """PUT 写入多目录合法值保留并落盘；模拟重启后仍读到"""
    set_video_dirs(Path("/tmp/v1"), Path("/tmp/v2"))
    state._settings = None
    s = client.get("/api/settings").json()["settings"]["video"]
    assert s["videoDirs"] == ["/tmp/v1", "/tmp/v2"]


def test_video_dirs_invalid_falls_back():
    """非法类型回落默认空数组；非字符串/空白项被过滤"""
    r = client.put("/api/settings", json={"video": {"videoDirs": 123}})
    assert r.json()["settings"]["video"]["videoDirs"] == []
    r = client.put("/api/settings", json={"video": {"videoDirs": ["/ok", 42, "", "  "]}})
    assert r.json()["settings"]["video"]["videoDirs"] == ["/ok"]


# ============ 列表 ============
def test_videos_list_empty_when_no_dirs():
    """videoDirs 未配置 → 空列表"""
    assert client.get("/api/videos").json() == {"items": []}


def test_videos_list_scans_dirs(tmp_path):
    """扫描多目录：只收视频扩展名，返回 path/name/size/mtime，非视频文件忽略"""
    d1 = tmp_path / "videos"
    d2 = tmp_path / "more"
    make_video(d1 / "movie.mp4")
    make_video(d1 / "clip.webm", data=b"x" * 1024)
    make_video(d2 / "subdir" / "anime.mkv")
    (d1 / "notes.txt").write_text("not a video", encoding="utf-8")
    (d1 / "audio.mp3").write_bytes(b"x")
    set_video_dirs(d1, d2)
    items = client.get("/api/videos").json()["items"]
    assert {it["name"] for it in items} == {"movie", "clip", "anime"}
    by_name = {it["name"]: it for it in items}
    assert by_name["movie"]["path"] == str(d1 / "movie.mp4")
    assert by_name["movie"]["size"] == 27
    assert isinstance(by_name["movie"]["mtime"], int) and by_name["movie"]["mtime"] > 0
    assert by_name["clip"]["size"] == 1024


def test_videos_list_skips_missing_dirs(tmp_path):
    """videoDirs 里的目录不存在 → 跳过不报错，返回其余目录内容"""
    make_video(tmp_path / "ok" / "a.mp4")
    set_video_dirs(tmp_path / "ok", tmp_path / "nope")
    items = client.get("/api/videos").json()["items"]
    assert [it["name"] for it in items] == ["a"]


# ============ Range 流 ============
def test_stream_full(tmp_path):
    """无 Range 头 → 200 全量内容 + Accept-Ranges: bytes"""
    p = make_video(tmp_path / "v" / "full.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(p)})
    assert r.status_code == 200
    assert r.content == b"0123456789" * 10
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-length"] == "100"
    assert r.headers["content-type"] == "video/mp4"


def test_stream_range_partial(tmp_path):
    """Range: bytes=10-19 → 206 + Content-Range + 对应切片内容"""
    p = make_video(tmp_path / "v" / "r.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(p)}, headers={"Range": "bytes=10-19"})
    assert r.status_code == 206
    assert r.content == b"0123456789"
    assert r.headers["content-range"] == "bytes 10-19/100"
    assert r.headers["content-length"] == "10"
    assert r.headers["accept-ranges"] == "bytes"


def test_stream_range_open_ended(tmp_path):
    """Range: bytes=90- → 206 从 90 到文件尾"""
    p = make_video(tmp_path / "v" / "o.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(p)}, headers={"Range": "bytes=90-"})
    assert r.status_code == 206
    assert r.content == b"0123456789"
    assert r.headers["content-range"] == "bytes 90-99/100"


def test_stream_range_suffix(tmp_path):
    """Range: bytes=-5 → 206 末尾 5 字节"""
    p = make_video(tmp_path / "v" / "s.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(p)}, headers={"Range": "bytes=-5"})
    assert r.status_code == 206
    assert r.content == b"56789"
    assert r.headers["content-range"] == "bytes 95-99/100"


def test_stream_range_clamped(tmp_path):
    """Range 末尾越界 → 截断到文件尾"""
    p = make_video(tmp_path / "v" / "c.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(p)}, headers={"Range": "bytes=0-999"})
    assert r.status_code == 206
    assert len(r.content) == 100
    assert r.headers["content-range"] == "bytes 0-99/100"


def test_stream_range_unsatisfiable(tmp_path):
    """越界 Range → 416 + Content-Range: bytes */size"""
    p = make_video(tmp_path / "v" / "u.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(p)}, headers={"Range": "bytes=100-"})
    assert r.status_code == 416
    assert r.headers["content-range"] == "bytes */100"


def test_stream_range_invalid_format_ignored(tmp_path):
    """非 bytes 单位/非法格式 Range → 忽略，按 200 全量返回"""
    p = make_video(tmp_path / "v" / "i.mp4", data=b"0123456789" * 10)
    set_video_dirs(tmp_path / "v")
    for bad in ("items=0-1", "bytes=abc", "bytes="):
        r = client.get("/api/videos/stream", params={"path": str(p)}, headers={"Range": bad})
        assert r.status_code == 200, bad
        assert len(r.content) == 100, bad


def test_stream_missing_file(tmp_path):
    """文件不存在 → 404"""
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/stream", params={"path": str(tmp_path / "v" / "ghost.mp4")})
    assert r.status_code == 404


def test_stream_no_dirs(tmp_path):
    """未配置 videoDirs → 400"""
    r = client.get("/api/videos/stream", params={"path": str(tmp_path / "a.mp4")})
    assert r.status_code == 400


# ============ 路径穿越拒绝 ============
def test_stream_traversal_rejected(tmp_path):
    """path 指向 videoDirs 外（含 .. 穿越/绝对路径/符号链接逃逸）→ 403"""
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"secret")
    d = tmp_path / "v"
    set_video_dirs(d)
    cases = [
        str(outside),  # 绝对路径在目录外
        str(d / ".." / "outside.mp4"),  # .. 穿越
        "/etc/hosts",  # 系统文件
    ]
    for path in cases:
        r = client.get("/api/videos/stream", params={"path": path})
        assert r.status_code == 403, path
    # URL 编码的 .. 穿越（%2F）
    r = client.get(
        "/api/videos/stream",
        params={"path": f"{d.name}%2F..%2F..%2Foutside.mp4"},
    )
    assert r.status_code in (403, 404)


def test_stream_symlink_escape_rejected(tmp_path):
    """videoDirs 内符号链接指向外部文件 → 解析后不在目录内，拒绝"""
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"secret")
    d = tmp_path / "v"
    d.mkdir()
    (d / "link.mp4").symlink_to(outside)
    set_video_dirs(d)
    r = client.get("/api/videos/stream", params={"path": str(d / "link.mp4")})
    assert r.status_code == 403


def test_stream_missing_param():
    """缺 path 参数 → 400"""
    r = client.get("/api/videos/stream")
    assert r.status_code == 400


# ============ 字幕 ============
def test_subtitle_srt(tmp_path):
    """SRT 解析：时间戳转秒浮点，text 取文本行，translation 为 None"""
    p = make_video(tmp_path / "v" / "song.mp4")
    (tmp_path / "v" / "song.srt").write_text(SRT_TEXT, encoding="utf-8")
    set_video_dirs(tmp_path / "v")
    items = client.get("/api/videos/subtitle", params={"path": str(p)}).json()["items"]
    assert items == [
        {"start": 1.0, "end": 3.5, "text": "こんにちは世界", "translation": None},
        {"start": 4.0, "end": 6.0, "text": "これはテストです", "translation": None},
    ]


def test_subtitle_vtt(tmp_path):
    """VTT 解析：忽略 WEBVTT 头部/STYLE 块/cue 尾部设置"""
    p = make_video(tmp_path / "v" / "talk.webm")
    (tmp_path / "v" / "talk.vtt").write_text(VTT_TEXT, encoding="utf-8")
    set_video_dirs(tmp_path / "v")
    items = client.get("/api/videos/subtitle", params={"path": str(p)}).json()["items"]
    assert items == [
        {"start": 1.0, "end": 2.5, "text": "Hello world", "translation": None},
        {"start": 3.0, "end": 4.5, "text": "Second line", "translation": None},
    ]


def test_subtitle_prefers_srt(tmp_path):
    """同名 srt/vtt 同时存在 → srt 优先"""
    p = make_video(tmp_path / "v" / "both.mp4")
    (tmp_path / "v" / "both.srt").write_text(SRT_TEXT, encoding="utf-8")
    (tmp_path / "v" / "both.vtt").write_text(VTT_TEXT, encoding="utf-8")
    set_video_dirs(tmp_path / "v")
    items = client.get("/api/videos/subtitle", params={"path": str(p)}).json()["items"]
    assert items[0]["text"] == "こんにちは世界"  # 来自 srt


def test_subtitle_none(tmp_path):
    """无同名字幕 → {items: []}"""
    p = make_video(tmp_path / "v" / "nosub.mp4")
    set_video_dirs(tmp_path / "v")
    assert client.get("/api/videos/subtitle", params={"path": str(p)}).json() == {"items": []}


def test_subtitle_traversal_rejected(tmp_path):
    """字幕 path 同样防穿越：目录外 → 403"""
    outside = tmp_path / "outside.mp4"
    outside.write_bytes(b"x")
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/subtitle", params={"path": str(outside)})
    assert r.status_code == 403


def test_subtitle_missing_video(tmp_path):
    """视频文件不存在 → 404（不尝试找字幕）"""
    set_video_dirs(tmp_path / "v")
    r = client.get("/api/videos/subtitle", params={"path": str(tmp_path / "v" / "ghost.mp4")})
    assert r.status_code == 404


# ============ 服务层直接测试 ============
def test_parse_subtitle_roundtrip(tmp_path):
    """parse_subtitle_file 直接读文件（BOM 容忍 + GBK 兜底）"""
    from app.services import video_subtitle

    p = tmp_path / "gbk.srt"
    p.write_bytes("1\n00:00:05,000 --> 00:00:06,000\n你好\n".encode("gbk"))
    items = video_subtitle.parse_subtitle_file(p)
    assert items == [{"start": 5.0, "end": 6.0, "text": "你好", "translation": None}]
    # 无字幕文本 → 空列表
    assert video_subtitle.parse_subtitle_text("随便写点什么") == []


def test_transcribe_placeholder():
    """ASR 接口占位：签名可调用（本轮不实现，方案未定）"""
    import inspect

    from app.services import transcribe

    assert inspect.iscoroutinefunction(transcribe.transcribe)
    sig = inspect.signature(transcribe.transcribe)
    assert list(sig.parameters) == ["media_path", "language"]
    assert sig.parameters["language"].default is None
