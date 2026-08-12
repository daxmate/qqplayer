"""lyric_fetch 在线歌词获取测试（全部 mock 网络，CI 稳定）"""

import httpx
import pytest

import lyric_fetch


# ============ fake HTTP ============
class FakeResp:
    def __init__(self, payload=None, error=None):
        self._payload = payload
        self._error = error

    def raise_for_status(self):
        if self._error:
            raise self._error

    def json(self):
        return self._payload


class FakeClient:
    """按 URL 关键字分发响应"""

    def __init__(self, routes, timeout=None):
        self._routes = routes
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, **kw):
        self.calls.append(url)
        for key, resp in self._routes.items():
            if key in url:
                return resp
        raise AssertionError(f"未 mock 的 URL: {url}")


@pytest.fixture
def fake_http(monkeypatch):
    """把 httpx.Client 换成 FakeClient，返回 routes 字典供测试填充"""
    routes = {}
    monkeypatch.setattr(lyric_fetch.httpx, "Client", lambda **kw: FakeClient(routes))
    return routes


@pytest.fixture
def cache_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(lyric_fetch, "CACHE_DIR", tmp_path)
    return tmp_path


# ============ 缓存 ============
def test_cache_key_stable():
    assert lyric_fetch.cache_key("夜に駆ける", "YOASOBI") == lyric_fetch.cache_key(
        "夜に駆ける", "YOASOBI"
    )
    assert lyric_fetch.cache_key("A", "B") != lyric_fetch.cache_key("B", "A")


def test_cache_roundtrip(cache_dir):
    key = "abc123"
    assert lyric_fetch._load_cache(key) is None
    lyric_fetch._save_cache(key, "[00:01.00]hello", "netease", "[00:01.00]你好")
    lrc, tlyric, source = lyric_fetch._load_cache(key)
    assert lrc == "[00:01.00]hello"
    assert tlyric == "[00:01.00]你好"
    assert source == "netease"


# ============ 网易云 ============
def test_fetch_netease_success(fake_http):
    fake_http["search/get/web"] = FakeResp(
        {"result": {"songs": [{"id": 123, "name": "夜に駆ける", "artists": [{"name": "YOASOBI"}]}]}}
    )
    fake_http["song/lyric"] = FakeResp(
        {"lrc": {"lyric": "[00:01.00]沈むように"}, "tlyric": {"lyric": "[00:01.00]像是沉溺"}}
    )
    assert lyric_fetch.fetch_netease("夜に駆ける", "YOASOBI") == (
        "[00:01.00]沈むように",
        "[00:01.00]像是沉溺",
    )


def test_fetch_netease_no_tlyric(fake_http):
    """无翻译时 tlyric 为 None，不报错"""
    fake_http["search/get/web"] = FakeResp(
        {"result": {"songs": [{"id": 123, "name": "x", "artists": []}]}}
    )
    fake_http["song/lyric"] = FakeResp({"lrc": {"lyric": "[00:01.00]hi"}})
    assert lyric_fetch.fetch_netease("x", "") == ("[00:01.00]hi", None)


def test_fetch_netease_no_result(fake_http):
    fake_http["search/get/web"] = FakeResp({"result": {"songs": []}})
    assert lyric_fetch.fetch_netease("不存在", "无名") is None


def test_fetch_netease_empty_lyric(fake_http):
    """搜索命中但歌词为空（uncollected）→ 返回 None"""
    fake_http["search/get/web"] = FakeResp(
        {"result": {"songs": [{"id": 1, "name": "x", "artists": []}]}}
    )
    fake_http["song/lyric"] = FakeResp({"lrc": {"lyric": ""}, "uncollected": True})
    assert lyric_fetch.fetch_netease("x", "") is None


def test_fetch_netease_network_error(fake_http):
    fake_http["search/get/web"] = FakeResp(error=httpx.TimeoutException("timeout"))
    assert lyric_fetch.fetch_netease("x", "") is None


# ============ lrclib ============
def test_fetch_lrclib_synced_priority(fake_http):
    """优先带时间戳的 syncedLyrics，跳过 instrumental"""
    fake_http["lrclib.net"] = FakeResp(
        [
            {"instrumental": True, "plainLyrics": "乐器版"},
            {"instrumental": False, "syncedLyrics": "[00:01.00]一句", "plainLyrics": "一句"},
        ]
    )
    assert lyric_fetch.fetch_lrclib("x", "") == "[00:01.00]一句"


def test_fetch_lrclib_fallback_plain(fake_http):
    """无 syncedLyrics 时退回 plainLyrics"""
    fake_http["lrclib.net"] = FakeResp(
        [{"instrumental": False, "syncedLyrics": None, "plainLyrics": "纯文本"}]
    )
    assert lyric_fetch.fetch_lrclib("x", "") == "纯文本"


def test_fetch_lrclib_empty(fake_http):
    fake_http["lrclib.net"] = FakeResp([])
    assert lyric_fetch.fetch_lrclib("x", "") is None


# ============ 统一入口（fallback 链 + 缓存） ============
def test_online_fallback_chain(fake_http, cache_dir, monkeypatch):
    """网易云失败 → 自动走 lrclib"""
    fake_http["search/get/web"] = FakeResp(error=httpx.TimeoutException("timeout"))
    fake_http["lrclib.net"] = FakeResp([{"instrumental": False, "syncedLyrics": "[00:01.00]ok"}])
    lrc, tlyric, source = lyric_fetch.fetch_online_lyric("歌", "手")
    assert lrc == "[00:01.00]ok"
    assert tlyric is None
    assert source == "lrclib"


def test_online_cache_hit_no_request(fake_http, cache_dir):
    """缓存命中后不再发网络请求"""
    fake_http["search/get/web"] = FakeResp(
        {"result": {"songs": [{"id": 1, "name": "x", "artists": []}]}}
    )
    fake_http["song/lyric"] = FakeResp(
        {"lrc": {"lyric": "[00:01.00]first"}, "tlyric": {"lyric": "[00:01.00]第一"}}
    )
    lrc, tlyric, source = lyric_fetch.fetch_online_lyric("x", "")
    assert lrc == "[00:01.00]first"
    assert tlyric == "[00:01.00]第一"
    # 第二次：清空路由让任何请求都失败——但缓存命中不会发请求
    fake_http.clear()
    lrc, tlyric, source = lyric_fetch.fetch_online_lyric("x", "")
    assert lrc == "[00:01.00]first"
    assert tlyric == "[00:01.00]第一"
    assert source == "netease"


def test_online_no_result_cached(fake_http, cache_dir):
    """无结果也会缓存，第二次不再请求"""
    fake_http["search/get/web"] = FakeResp({"result": {"songs": []}})
    fake_http["lrclib.net"] = FakeResp([])
    assert lyric_fetch.fetch_online_lyric("无", "") == (None, None, None)
    fake_http.clear()
    assert lyric_fetch.fetch_online_lyric("无", "") == (None, None, None)
