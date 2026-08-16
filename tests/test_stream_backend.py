"""任务 A：流媒体播放后端测试

- GET /api/stream/url：网易云直链（mock provider）/ 失败 502 / 非法 level 回落默认 / 缺 id 422
- 网络曲库条目 CRUD：增删查 / provider+id 去重幂等 / POST 后 library version +1 / 文件容错
- /api/songs 合并：本地 + 网络混合输出、stream 条目字段正确
- playback 白名单 streamStats：合法 bool 保留 / 非法回落

运行：cd /Users/dax/codes/qqplayerA && /Users/dax/codes/qqplayer/venv/bin/python -m pytest tests/test_stream_backend.py -q
"""

import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
import netease_provider  # noqa: E402

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate_data(tmp_path, monkeypatch):
    """存储隔离：settings / network_songs 都写临时目录，不碰真实用户数据；每测试后重置缓存"""
    monkeypatch.setattr(backend, "SETTINGS_FILE", tmp_path / "settings.json")
    monkeypatch.setattr(backend, "UI_SETTINGS_FILE", tmp_path / "ui_settings.json")
    monkeypatch.setattr(backend, "DESKTOP_LYRIC_FILE", tmp_path / "desktop_lyric.json")
    monkeypatch.setattr(backend, "NETWORK_SONGS_FILE", tmp_path / "network_songs.json")
    backend._settings = None
    yield
    backend._settings = None


def _add_song(**overrides):
    """POST /api/network-songs 添加一条网络歌（返回响应）"""
    body = {
        "id": "123456",
        "title": "晴天",
        "artist": "周杰伦",
        "album": "叶惠美",
        "coverUrl": "http://p1.music.126.net/cover.jpg",
        "duration": 269,
    }
    body.update(overrides)
    return client.post("/api/network-songs", json=body)


def make_mp3(path: Path):
    """生成带 ID3 标签的假 mp3（与 test_backend 同款），模拟本地歌曲"""
    from mutagen.id3 import ID3, TIT2, TPE1

    frame = b"\xff\xfb\x90\x00" + b"\x00" * 413  # 完整 128kbps/44100 MPEG1 L3 帧
    path.write_bytes(frame * 3)
    tags = ID3()
    tags.add(TIT2(encoding=3, text="本地歌"))
    tags.add(TPE1(encoding=3, text="本地歌手"))
    tags.save(path)


@pytest.fixture()
def local_library(tmp_path, monkeypatch):
    """临时歌曲库：1 首本地歌"""
    monkeypatch.setattr(backend, "LIBRARY", tmp_path / "lib")
    (tmp_path / "lib").mkdir()
    make_mp3(tmp_path / "lib" / "local.mp3")
    backend._scan_cache = None
    yield tmp_path / "lib"
    backend._scan_cache = None


# ============ GET /api/stream/url ============
def test_stream_url_ok(monkeypatch):
    """mock meting 返回直链 → 200 {url, level, ext}；level 透传"""
    captured = {}

    def fake(sid, level="exhigh"):
        captured["sid"] = sid
        captured["level"] = level
        return {"url": "http://m7.music.126.net/direct.mp3", "ext": "mp3", "bitrate": "320"}

    monkeypatch.setattr(netease_provider, "get_play_info", fake)
    r = client.get(
        "/api/stream/url", params={"provider": "netease", "id": "123", "level": "exhigh"}
    )
    assert r.status_code == 200
    assert r.json() == {
        "url": "http://m7.music.126.net/direct.mp3",
        "level": "exhigh",
        "ext": "mp3",
    }
    assert captured == {"sid": "123", "level": "exhigh"}


def test_stream_url_invalid_level_falls_back(monkeypatch):
    """非法 level 回落默认 exhigh（传给 provider 与响应 level 都是 exhigh）"""
    captured = {}

    def fake(sid, level="exhigh"):
        captured["level"] = level
        return {"url": "http://cdn.example.com/a.flac", "ext": "flac", "bitrate": "320"}

    monkeypatch.setattr(netease_provider, "get_play_info", fake)
    r = client.get("/api/stream/url", params={"id": "123", "level": "hq"})
    assert r.status_code == 200
    assert captured["level"] == "exhigh"
    assert r.json()["level"] == "exhigh"
    assert r.json()["ext"] == "flac"


def test_stream_url_provider_error_502(monkeypatch):
    """provider 抛异常（meting/cenguigui 都失败）→ 502 detail"""

    def boom(sid, level="exhigh"):
        raise RuntimeError("all sources failed")

    monkeypatch.setattr(netease_provider, "get_play_info", boom)
    r = client.get("/api/stream/url", params={"id": "abc"})
    assert r.status_code == 502
    assert "detail" in r.json()


def test_stream_url_no_url_502(monkeypatch):
    """provider 返回空/无直链 → 502"""
    monkeypatch.setattr(netease_provider, "get_play_info", lambda sid, level="exhigh": {})
    r = client.get("/api/stream/url", params={"id": "1"})
    assert r.status_code == 502
    assert "detail" in r.json()


def test_stream_url_missing_id_422():
    """缺 id 参数 → 422（FastAPI 必填 query 校验）"""
    r = client.get("/api/stream/url")
    assert r.status_code == 422
    # id 为空白字符串同样 422
    r = client.get("/api/stream/url", params={"id": "   "})
    assert r.status_code == 422


def test_stream_url_unsupported_provider_400():
    """provider 非 netease → 400"""
    r = client.get("/api/stream/url", params={"id": "1", "provider": "gequhai"})
    assert r.status_code == 400


# ============ GET /api/stream/proxy ============
class _FakeProxyResp:
    """mock httpx.stream 响应（proxy 端点用）：chunk 迭代 + 头/状态 + 上下文管理"""

    def __init__(self, chunks=b"", status_code=200, headers=None, error=None):
        self._chunks = chunks if isinstance(chunks, (list, tuple)) else [chunks]
        self.status_code = status_code
        self.headers = headers or {}
        self._error = error

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
def fake_proxy_stream(monkeypatch):
    """mock backend.httpx.stream：记录 (method, url, kwargs)，返回可配置流式响应
    state["resp"] 可以是响应对象或返回响应的 callable（模拟连接失败抛错）"""
    state = {"calls": [], "resp": None}

    def stream_fn(method, url, **kw):
        state["calls"].append((method, url, kw))
        return state["resp"]() if callable(state["resp"]) else state["resp"]

    monkeypatch.setattr(backend.httpx, "stream", stream_fn)
    return state


def test_stream_proxy_ok(fake_proxy_stream):
    """正常 200 流式转发：body = 上游 chunks；content-type/content-length 透传；
    httpx 参数符合契约（timeout/follow_redirects/trust_env=False）"""
    fake_proxy_stream["resp"] = _FakeProxyResp(
        chunks=[b"ID3", b" audio bytes"],
        headers={"content-type": "audio/mpeg", "content-length": "12"},
    )
    r = client.get("/api/stream/proxy", params={"url": "http://m701.music.126.net/a.mp3"})
    assert r.status_code == 200
    assert r.content == b"ID3 audio bytes"
    assert r.headers["content-type"].startswith("audio/mpeg")
    assert r.headers["content-length"] == "12"
    method, url, kw = fake_proxy_stream["calls"][0]
    assert method == "GET"
    assert url == "http://m701.music.126.net/a.mp3"
    assert kw["timeout"] == 30.0
    assert kw["follow_redirects"] is True
    assert kw["trust_env"] is False
    assert kw["headers"]["User-Agent"]


def test_stream_proxy_range_passthrough(fake_proxy_stream):
    """带 Range 请求 → 上游透传 Range 头；206 + content-range/accept-ranges 透传"""
    fake_proxy_stream["resp"] = _FakeProxyResp(
        chunks=[b"x" * 1024],
        status_code=206,
        headers={"content-range": "bytes 0-1023/102400", "accept-ranges": "bytes"},
    )
    r = client.get(
        "/api/stream/proxy",
        params={"url": "http://cdn.example.com/a.mp3"},
        headers={"Range": "bytes=0-1023"},
    )
    assert r.status_code == 206
    assert len(r.content) == 1024
    assert r.headers["content-range"] == "bytes 0-1023/102400"
    assert r.headers["accept-ranges"] == "bytes"
    kw = fake_proxy_stream["calls"][0][2]
    assert kw["headers"]["Range"] == "bytes=0-1023"


def test_stream_proxy_non_http_400(fake_proxy_stream):
    """非 http(s) url / 空 url → 400，不发起上游请求；缺 url 参数 → 422"""
    for bad in ("ftp://x/a.mp3", "/api/audio?path=/lib/a.mp3", "", "javascript:alert(1)"):
        r = client.get("/api/stream/proxy", params={"url": bad})
        assert r.status_code == 400, f"url={bad!r} 应 400"
    assert fake_proxy_stream["calls"] == []
    assert client.get("/api/stream/proxy").status_code == 422


def test_stream_proxy_upstream_connect_fail_502(fake_proxy_stream):
    """上游连接失败（httpx.stream 抛错）→ 502 带原因"""

    def boom(*a, **kw):
        raise httpx.HTTPError("connection refused")

    fake_proxy_stream["resp"] = boom
    r = client.get("/api/stream/proxy", params={"url": "http://x/a.mp3"})
    assert r.status_code == 502
    assert "connection refused" in r.json()["detail"]


def test_stream_proxy_upstream_http_error_502(fake_proxy_stream):
    """上游非 2xx（404）→ 502 带原因"""
    req = httpx.Request("GET", "http://x/a.mp3")
    fake_proxy_stream["resp"] = _FakeProxyResp(
        error=httpx.HTTPStatusError(
            "404 Not Found", request=req, response=httpx.Response(404, request=req)
        )
    )
    r = client.get("/api/stream/proxy", params={"url": "http://x/a.mp3"})
    assert r.status_code == 502
    assert "404" in r.json()["detail"]


# ============ 网络曲库条目 CRUD ============
def test_network_songs_empty_when_missing():
    """文件不存在 → GET 返回空列表（不创建文件）"""
    r = client.get("/api/network-songs")
    assert r.status_code == 200
    assert r.json() == []
    assert not backend.NETWORK_SONGS_FILE.exists()


def test_network_songs_corrupted_file(tmp_path):
    """文件损坏 → 回退空列表不崩"""
    backend.NETWORK_SONGS_FILE.write_text("{not json", encoding="utf-8")
    assert client.get("/api/network-songs").json() == []


def test_network_songs_add_and_list():
    """POST 添加 → 返回新列表；条目字段完整；落盘可重启读回"""
    r = _add_song()
    assert r.status_code == 200
    entries = r.json()
    assert len(entries) == 1
    e = entries[0]
    assert e["id"] == "123456"
    assert e["provider"] == "netease"
    assert e["title"] == "晴天"
    assert e["artist"] == "周杰伦"
    assert e["album"] == "叶惠美"
    assert e["coverUrl"] == "http://p1.music.126.net/cover.jpg"
    assert e["duration"] == 269
    assert e["addedAt"]
    # 模拟重启：重置缓存（无缓存，直接读文件）后 GET 仍返回
    assert client.get("/api/network-songs").json() == entries


def test_network_songs_add_optional_fields_default():
    """album/coverUrl/duration 可空；非法 duration 置 None"""
    r = _add_song(album=None, coverUrl=None, duration=None)
    e = r.json()[0]
    assert e["album"] is None and e["coverUrl"] is None and e["duration"] is None
    r = _add_song(id="2", title="t", artist="a", duration="abc")
    assert r.json()[1]["duration"] is None


def test_network_songs_add_required_fields():
    """id/title/artist 必填 → 400"""
    assert _add_song(id="").status_code == 400
    assert _add_song(title="").status_code == 400
    assert _add_song(artist="  ").status_code == 400


def test_network_songs_dedupe_idempotent():
    """provider+id 相同重复 POST → 幂等返回现有列表（不新增，不重复写）"""
    _add_song()
    r = _add_song()
    assert len(r.json()) == 1
    r = _add_song(id="123456", provider="netease")
    assert len(r.json()) == 1
    # 同 id 不同 provider 视为不同条目
    r = _add_song(id="123456", provider="gequhai")
    assert len(r.json()) == 2


def test_network_songs_delete():
    """DELETE → 删除条目返回新列表；再删不存在的幂等"""
    _add_song()
    _add_song(id="999", title="七里香", artist="周杰伦")
    r = client.delete("/api/network-songs", params={"provider": "netease", "id": "999"})
    assert r.status_code == 200
    entries = r.json()
    assert [e["id"] for e in entries] == ["123456"]
    # 删不存在的 → 原列表不变
    r = client.delete("/api/network-songs", params={"provider": "netease", "id": "nope"})
    assert [e["id"] for e in r.json()] == ["123456"]
    # 缺 id → 400
    assert client.delete("/api/network-songs").status_code == 400


def test_network_songs_post_bumps_library_version():
    """POST 新增条目后 library version +1（前端轮询刷新）；幂等重复 POST 不再 +1"""
    v0 = client.get("/api/library/version").json()["version"]
    _add_song()
    v1 = client.get("/api/library/version").json()["version"]
    assert v1 == v0 + 1
    _add_song()  # 去重幂等
    v2 = client.get("/api/library/version").json()["version"]
    assert v2 == v1


def test_network_songs_delete_does_not_bump_version():
    """DELETE 不要求 +1（契约只规定 POST 后 version +1）"""
    _add_song()
    v1 = client.get("/api/library/version").json()["version"]
    client.delete("/api/network-songs", params={"provider": "netease", "id": "123456"})
    assert client.get("/api/library/version").json()["version"] == v1


# ============ /api/songs 合并网络条目 ============
def test_api_songs_merge_stream_entries(local_library):
    """本地歌 + 网络歌混合：本地在前保持原结构，网络歌 type=stream 追加末尾"""
    _add_song(title="晴天", artist="周杰伦", album="叶惠美", duration=269)
    songs = client.get("/api/songs").json()
    assert len(songs) == 2
    local, stream = songs
    # 本地歌保持原结构（id/path/folder/ext...，无 type 键；新增 mtime 供“最近添加”排序）
    assert local["path"] == str(local_library / "local.mp3")
    assert local["name"] == "本地歌"
    assert "type" not in local
    assert local.get("streamId") is None
    assert isinstance(local.get("mtime"), int) and local["mtime"] > 0
    # 网络歌字段正确
    stream_expected = {
        "type": "stream",
        "streamId": "123456",
        "provider": "netease",
        "path": None,
        "name": "晴天",
        "artist": "周杰伦",
        "album": "叶惠美",
        "duration": 269,
        "coverUrl": "http://p1.music.126.net/cover.jpg",
    }
    assert {k: stream[k] for k in stream_expected} == stream_expected
    assert isinstance(stream.get("mtime"), int) and stream["mtime"] > 0  # 添加时刻（毫秒）


def test_api_songs_no_network_entries(local_library):
    """无网络条目时 /api/songs 只返回本地歌"""
    songs = client.get("/api/songs").json()
    assert len(songs) == 1
    assert songs[0]["path"] == str(local_library / "local.mp3")


# ============ playback 白名单 streamStats ============
def test_stream_stats_default_false():
    """默认 false，随 GET /api/settings 返回（白名单内）"""
    s = client.get("/api/settings").json()["settings"]["playback"]
    assert s["streamStats"] is False
    assert "streamStats" in backend.PLAYBACK_SETTINGS_DEFAULTS
    assert "streamStats" in backend._SETTINGS_SPEC["playback"]


def test_stream_stats_valid_preserved():
    """合法 bool 保留并持久化（模拟重启后仍读到）"""
    s = client.put("/api/settings", json={"playback": {"streamStats": True}}).json()["settings"][
        "playback"
    ]
    assert s["streamStats"] is True
    backend._settings = None
    s = client.get("/api/settings").json()["settings"]["playback"]
    assert s["streamStats"] is True


def test_stream_stats_invalid_falls_back():
    """非法类型回落默认 false"""
    for bad in (1, "true", None, [True], {"a": 1}):
        s = client.put("/api/settings", json={"playback": {"streamStats": bad}}).json()["settings"][
            "playback"
        ]
        assert s["streamStats"] is False, f"streamStats={bad!r} 应回落默认 false"
