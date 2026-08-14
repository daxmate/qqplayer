"""tag_scraper 多源刮削测试（全部 mock 网络：FakeClient 注入 + fake netease_search，CI 稳定）"""

import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import tag_scraper  # noqa: E402
from tag_scraper import TagScraper  # noqa: E402


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.status_code = status_code
        if payload is not None:
            self.content = json.dumps(payload).encode()
        else:
            self.content = b""

    def json(self):
        return json.loads(self.content)

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPError(f"status {self.status_code}")


class FakeClient:
    """按调用顺序返回 mock 响应；元素是 Exception 时直接抛出"""

    def __init__(self):
        self.gets = []
        self.calls = []

    def get(self, url, **kw):
        self.calls.append((url, kw))
        if self.gets:
            r = self.gets.pop(0)
            if isinstance(r, Exception):
                raise r
            return r
        raise AssertionError(f"未 mock 的 GET: {url}")


def make_scraper(gets=None, netease_items=None, netease_error=None):
    client = FakeClient()
    client.gets = list(gets or [])

    def fake_search(query, limit=20):
        if netease_error:
            raise netease_error
        return list(netease_items or [])

    sleeps = []
    scraper = TagScraper(client=client, netease_search=fake_search, sleep_fn=sleeps.append)
    return scraper, client, sleeps


NETEASE_ITEM = {
    "id": "123456",
    "title": "安静",
    "artist": "周杰伦",
    "album": "范特西",
    "cover": "http://p1.music.126.net/cover.jpg",
    "duration": "04:30",
}

MB_RECORDING = {
    "id": "mb-rec-1",
    "title": "安静",
    "artist-credit": [{"name": "周杰伦"}],
    "releases": [{"id": "mb-rel-1", "title": "范特西"}],
}

CAA_URL = tag_scraper.COVERARTARCHIVE_FRONT.format(mbid="mb-rel-1")


# ============ scrape 返回形状 ============
def test_scrape_netease_shape_and_no_extra_fields():
    """网易云候选只暴露契约 6 字段（无 level 等内部字段）；有 cover 不触发 fallback"""
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": []})],
        netease_items=[NETEASE_ITEM],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert set(result) == {"netease", "musicbrainz"}
    assert result["musicbrainz"] == []
    assert len(result["netease"]) == 1
    cand = result["netease"][0]
    assert set(cand) == {"id", "title", "artist", "album", "cover", "duration"}
    assert cand["cover"] == NETEASE_ITEM["cover"]
    # 唯一一次 HTTP 调用是主 MusicBrainz 搜索（网易云 cover 存在，不走 fallback）
    assert len(client.calls) == 1
    assert client.calls[0][0] == tag_scraper.MUSICBRAINZ_API


def test_scrape_musicbrainz_shape_ua_and_sleep():
    """MusicBrainz 候选 5 字段 + 自定义 UA + 调用前 sleep 1s"""
    scraper, client, sleeps = make_scraper(
        gets=[
            FakeResponse({"recordings": [MB_RECORDING]}),
            FakeResponse(status_code=307),  # CAA front 有封面（302/307 都算）
        ],
        netease_items=[],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert len(result["musicbrainz"]) == 1
    cand = result["musicbrainz"][0]
    assert set(cand) == {"title", "artist", "album", "cover", "mbid"}
    assert cand["mbid"] == "mb-rec-1"
    assert cand["artist"] == "周杰伦"
    assert cand["album"] == "范特西"
    assert cand["cover"] == CAA_URL
    # 自定义 User-Agent（否则 MusicBrainz 403）+ 每次调用前 sleep 1s
    mb_call = client.calls[0]
    assert mb_call[0] == tag_scraper.MUSICBRAINZ_API
    assert mb_call[1]["headers"]["User-Agent"] == tag_scraper.MUSICBRAINZ_UA
    assert sleeps == [1]


# ============ 封面 fallback 链 ============
def test_scrape_netease_fallback_itunes_600():
    """网易云无 cover → iTunes 取 results[0].artworkUrl100 换成 600"""
    scraper, client, _ = make_scraper(
        gets=[
            FakeResponse({"results": [{"artworkUrl100": "https://x/img/100x100bb.jpg"}]}),
            FakeResponse({"recordings": []}),  # 主 MB 搜索
        ],
        netease_items=[{**NETEASE_ITEM, "cover": None}],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert result["netease"][0]["cover"] == "https://x/img/600x600bb.jpg"
    assert client.calls[0][0] == tag_scraper.ITUNES_SEARCH_API
    assert client.calls[0][1]["params"] == {
        "term": "安静 周杰伦",
        "media": "music",
        "limit": 5,
    }


def test_scrape_netease_fallback_caa():
    """iTunes 无结果 → MusicBrainz 找 release MBID → Cover Art Archive front"""
    scraper, client, _ = make_scraper(
        gets=[
            FakeResponse({"results": []}),  # iTunes 无结果
            FakeResponse({"recordings": [MB_RECORDING]}),  # MB 找 release
            FakeResponse(status_code=302),  # CAA front
            FakeResponse({"recordings": []}),  # 主 MB 搜索
        ],
        netease_items=[{**NETEASE_ITEM, "cover": None}],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert result["netease"][0]["cover"] == CAA_URL


def test_scrape_cover_chain_all_fail_null():
    """iTunes / MB / CAA 全挂 → cover=null，整体不抛异常"""
    scraper, _, _ = make_scraper(
        gets=[
            httpx.TimeoutException("itunes down"),
            httpx.TimeoutException("mb down"),
            httpx.TimeoutException("mb down"),  # 主 MB 搜索也挂
        ],
        netease_items=[{**NETEASE_ITEM, "cover": None}],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert result["netease"][0]["cover"] is None
    assert result["musicbrainz"] == []


def test_scrape_musicbrainz_caa_404_cover_null():
    """CAA 404 → cover=null，不报错"""
    scraper, _, _ = make_scraper(
        gets=[
            FakeResponse({"recordings": [MB_RECORDING]}),
            FakeResponse(status_code=404),
        ],
        netease_items=[],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert result["musicbrainz"][0]["cover"] is None


def test_scrape_musicbrainz_caa_deduped_per_release():
    """同一 release MBID 的多个候选共享一次 CAA 查询"""
    rec2 = {**MB_RECORDING, "id": "mb-rec-2"}
    scraper, client, _ = make_scraper(
        gets=[
            FakeResponse({"recordings": [MB_RECORDING, rec2]}),
            FakeResponse(status_code=302),
        ],
        netease_items=[],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert len(result["musicbrainz"]) == 2
    assert result["musicbrainz"][0]["cover"] == result["musicbrainz"][1]["cover"]
    caa_calls = [c for c in client.calls if "coverartarchive.org" in c[0]]
    assert len(caa_calls) == 1


# ============ 单源失败隔离 ============
def test_scrape_single_source_failure_isolated():
    """网易云抛异常 → netease 空数组；MB 超时 → musicbrainz 空数组；整体不抛"""
    scraper, _, _ = make_scraper(
        gets=[httpx.TimeoutException("mb down")],
        netease_error=RuntimeError("netease down"),
    )
    result = scraper.scrape("安静", "周杰伦")
    assert result == {"netease": [], "musicbrainz": []}


def test_scrape_netease_error_mb_ok():
    """网易云挂掉不影响 MusicBrainz"""
    scraper, _, _ = make_scraper(
        gets=[FakeResponse({"recordings": [MB_RECORDING]}), FakeResponse(status_code=302)],
        netease_error=RuntimeError("netease down"),
    )
    result = scraper.scrape("安静", "周杰伦")
    assert result["netease"] == []
    assert len(result["musicbrainz"]) == 1


# ============ artist-credit joinphrase ============
def test_join_artist_credit_joinphrase():
    credit = [{"name": "A", "joinphrase": " feat. "}, {"name": "B"}]
    assert TagScraper._join_artist_credit(credit) == "A feat. B"
    assert TagScraper._join_artist_credit([{"name": "周杰伦"}]) == "周杰伦"


def test_module_scrape_function(monkeypatch):
    """模块级 scrape() 委托默认实例（路由入口）"""
    fake = TagScraper(client=FakeClient(), netease_search=lambda q, limit=20: [], sleep_fn=lambda s: None)
    monkeypatch.setattr(tag_scraper, "scraper", fake)
    result = tag_scraper.scrape("安静")
    assert set(result) == {"netease", "musicbrainz"}
