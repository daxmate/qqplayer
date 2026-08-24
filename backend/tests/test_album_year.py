"""网易云歌曲详情 → 专辑年份（get_album_year + POST /api/tags/album-year）测试

全部 mock 网络（FakeClient + monkeypatch），CI 稳定。
覆盖：
- provider：publishTime 毫秒 → UTC 年份（1517500800000 → 2018）
- provider：无 album / publishTime 缺失 / 0 / 非数字 / 网络异常 → None（绝不抛）
- 模块级函数委托默认实例
- 路由：song_id 缺失/空/非字符串 → 400；正常 → {"year": int}；provider None → {"year": None}
"""

import json
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

SONG_DETAIL = {
    "songs": [
        {
            "id": 123,
            "name": "夜に駆ける",
            "album": {"name": "THE BOOK", "publishTime": 1517500800000},
        }
    ]
}


class FakeResponse:
    def __init__(self, payload=None, status_code=200, exc=None):
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}
        self._exc = exc
        if payload is not None:
            self.content = json.dumps(payload).encode()
        else:
            self.content = b""

    def json(self):
        return json.loads(self.content)

    def raise_for_status(self):
        if self._exc:
            raise self._exc
        if self.status_code >= 400:
            raise httpx.HTTPError(f"status {self.status_code}")


class FakeClient:
    """记录 POST 调用；按顺序返回 mock 响应，元素是 Exception 时直接抛出"""

    def __init__(self):
        self.posts = []
        self.calls = []

    def post(self, url, **kw):
        self.calls.append((url, kw))
        if self.posts:
            r = self.posts.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        raise AssertionError(f"未 mock 的 POST: {url}")


def make_provider(client=None):
    return netease_provider.NeteaseProvider(client=client or FakeClient())


# ============ provider: get_album_year ============
def test_album_year_from_publish_time():
    """publishTime 毫秒时间戳 → UTC 年份；请求走 eapi song/detail 且 ids 为 [song_id] JSON"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse(SONG_DETAIL))
    provider = make_provider(fclient)
    assert provider.get_album_year("123") == 2018
    url, kw = fclient.calls[0]
    assert url == "https://interface.music.163.com/eapi/song/detail"
    dec = netease_provider.eapi_decrypt(kw["data"]["params"].encode())
    assert dec["e_r"] is True
    assert dec["ids"] == json.dumps(["123"])


def test_album_year_rounds_down_utc():
    """时区边界：UTC 2018-02-01 01:00 的毫秒戳在 UTC 仍是 2018（不因东八区变 2018+）"""
    fclient = FakeClient()
    fclient.posts.append(
        FakeResponse({"songs": [{"id": 1, "album": {"name": "x", "publishTime": 1517432400000}}]})
    )
    assert make_provider(fclient).get_album_year("1") == 2018


def test_album_year_no_album():
    """songs[0] 无 album → None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": [{"id": 1, "name": "x"}]}))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_album_not_dict():
    """album 不是 dict（如 null）→ None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": [{"id": 1, "album": None}]}))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_publish_time_missing():
    """album 缺 publishTime → None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": [{"id": 1, "album": {"name": "x"}}]}))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_publish_time_zero():
    """publishTime == 0 → None（无意义时间戳）"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": [{"id": 1, "album": {"publishTime": 0}}]}))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_publish_time_non_numeric():
    """publishTime 非数字（字符串）→ None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": [{"id": 1, "album": {"publishTime": "2018"}}]}))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_publish_time_negative():
    """publishTime 负数 → None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": [{"id": 1, "album": {"publishTime": -1}}]}))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_empty_songs():
    """songs 为空列表 / 缺 songs 字段 → None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse({"songs": []}))
    assert make_provider(fclient).get_album_year("1") is None
    fclient2 = FakeClient()
    fclient2.posts.append(FakeResponse({"result": {}}))
    assert make_provider(fclient2).get_album_year("1") is None


def test_album_year_network_error_returns_none():
    """网络异常 → None（绝不抛）"""
    fclient = FakeClient()
    fclient.posts.append(httpx.TimeoutException("timeout"))
    assert make_provider(fclient).get_album_year("1") is None


def test_album_year_http_error_returns_none():
    """HTTP 4xx/5xx → None"""
    fclient = FakeClient()
    fclient.posts.append(FakeResponse(status_code=500))
    assert make_provider(fclient).get_album_year("1") is None


def test_module_level_get_album_year_delegates():
    """模块级 get_album_year 委托给默认实例"""
    assert callable(netease_provider.get_album_year)


# ============ 路由: POST /api/tags/album-year ============
def test_route_returns_year(monkeypatch):
    """正常：provider 返回年份 → {"year": 2018}；请求体 song_id 透传"""
    monkeypatch.setattr(netease_provider, "get_album_year", lambda song_id: 2018)
    r = client.post("/api/tags/album-year", json={"song_id": "123"})
    assert r.status_code == 200
    assert r.json() == {"year": 2018}


def test_route_provider_none_returns_null(monkeypatch):
    """provider 查询失败/无数据 → {"year": null}（HTTP 200 不报错）"""
    monkeypatch.setattr(netease_provider, "get_album_year", lambda song_id: None)
    r = client.post("/api/tags/album-year", json={"song_id": "123"})
    assert r.status_code == 200
    assert r.json() == {"year": None}


@pytest.mark.parametrize("body", [{}, {"song_id": ""}, {"song_id": "  "}, {"song_id": 123}])
def test_route_empty_song_id_400(monkeypatch, body):
    """song_id 缺失/空/非字符串 → 400（不触达 provider）"""
    calls = []

    def fake(song_id):
        calls.append(song_id)
        return 2018

    monkeypatch.setattr(netease_provider, "get_album_year", fake)
    r = client.post("/api/tags/album-year", json=body)
    assert r.status_code == 400
    assert r.json()["detail"] == "song_id 必填"
    assert calls == []
