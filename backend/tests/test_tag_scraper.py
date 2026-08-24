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
    "releases": [
        {
            "id": "mb-rel-1",
            "title": "范特西",
            "date": "2001-09-14",
            "artist-credit": [{"name": "周杰伦"}],
            "media": [{"track": [{"number": "3", "recording": {"id": "mb-rec-1"}}]}],
        }
    ],
    "tags": [
        {"count": 5, "name": "pop"},
        {"count": 9, "name": "mandopop"},
        {"count": 2, "name": "chinese"},
        {"count": 1, "name": "ballad"},
    ],
    "first-release-date": "2001-09-14",
}

CAA_URL = tag_scraper.COVERARTARCHIVE_FRONT.format(mbid="mb-rel-1")


# ============ scrape 返回形状 ============
def test_scrape_netease_shape_and_no_extra_fields():
    """网易云候选只暴露契约 6 字段（无 level 等内部字段）；有 cover 不触发 fallback。
    主 MB 搜索走降级链（3 阶段全空才算空），但不会因此触发 iTunes/CAA。"""
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": []})] * 3,  # 精确/fuzzy/关键词三阶段全空
        netease_items=[NETEASE_ITEM],
    )
    result = scraper.scrape("安静", "周杰伦")
    assert set(result) == {"netease", "musicbrainz"}
    assert result["musicbrainz"] == []
    assert len(result["netease"]) == 1
    cand = result["netease"][0]
    assert set(cand) == {"id", "title", "artist", "album", "cover", "duration"}
    assert cand["cover"] == NETEASE_ITEM["cover"]
    # 3 次 HTTP 调用全是主 MB 搜索降级链（网易云 cover 存在，不走 fallback）
    assert len(client.calls) == 3
    assert all(c[0] == tag_scraper.MUSICBRAINZ_API for c in client.calls)


def test_mb_query_never_contains_artist_condition():
    """降级链三个阶段的查询都不含 artist 硬条件（旧版 AND artist: 是刮削不全根因）"""
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": []})] * 3,
        netease_items=[],
    )
    scraper._scrape_musicbrainz("安静", "周杰伦")
    assert len(client.calls) == 3
    for _, kw in client.calls:
        q = kw["params"]["query"]
        assert "artist:" not in q
        assert "AND" not in q


def _mb_queries(client):
    """只取 MusicBrainz API 调用的查询串（CAA 调用无 params）"""
    return [kw["params"]["query"] for url, kw in client.calls if url == tag_scraper.MUSICBRAINZ_API]


def test_mb_exact_empty_fuzzy_hit():
    """精确短语无结果 → 降级到 fuzzy 命中（首阶段有结果即停）"""
    scraper, client, sleeps = make_scraper(
        gets=[
            FakeResponse({"recordings": []}),  # recording:"t" 无结果
            FakeResponse({"recordings": [MB_RECORDING]}),  # recording:"t"~ 命中
            FakeResponse(status_code=302),  # CAA front
        ],
        netease_items=[],
    )
    result = scraper._scrape_musicbrainz("安静", "周杰伦")
    assert len(result) == 1
    assert result[0]["mbid"] == "mb-rec-1"
    assert _mb_queries(client) == ['recording:"安静"', 'recording:"安静"~']
    assert sleeps == [1, 1]  # 每阶段调用前 sleep 1s


def test_mb_exact_fuzzy_empty_title_keyword_hit():
    """精确 + fuzzy 都无结果 → 降级到 title 关键词命中（最多 3 阶段）"""
    scraper, client, sleeps = make_scraper(
        gets=[
            FakeResponse({"recordings": []}),
            FakeResponse({"recordings": []}),
            FakeResponse({"recordings": [MB_RECORDING]}),  # title:安静 命中
            FakeResponse(status_code=302),  # CAA front
        ],
        netease_items=[],
    )
    result = scraper._scrape_musicbrainz("安静", "周杰伦")
    assert len(result) == 1
    assert _mb_queries(client) == ['recording:"安静"', 'recording:"安静"~', "title:安静"]
    assert sleeps == [1, 1, 1]


def test_mb_all_stages_empty_returns_empty():
    """三阶段全空 → 空数组，且正好 3 次 MB 请求（不无限降级）"""
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": []})] * 3,
        netease_items=[],
    )
    result = scraper._scrape_musicbrainz("安静", "周杰伦")
    assert result == []
    assert len(client.calls) == 3


def test_mb_artist_mismatch_title_ok_has_results():
    """artist 与 MB 写法不一致（别名/大小写/标点）但 title 对 → 有结果（旧版整条 0 结果）"""
    scraper, client, _ = make_scraper(
        gets=[
            FakeResponse(
                {
                    "recordings": [
                        {**MB_RECORDING, "artist-credit": [{"name": "Jay Chou"}]},
                    ]
                }
            )
        ],
        netease_items=[],
    )
    result = scraper._scrape_musicbrainz("安静", "周杰伦")
    assert len(result) == 1
    assert result[0]["artist"] == "Jay Chou"
    assert "artist" not in client.calls[0][1]["params"]["query"]


def test_mb_artist_match_sort_bonus():
    """artist 归一化后匹配的 recording 排前面（score 序保持），不匹配的排后面"""
    rec_other = {
        **MB_RECORDING,
        "id": "mb-rec-other",
        "artist-credit": [{"name": "Someone Else"}],
        "releases": [{"id": "mb-rel-other", "title": "其他专辑"}],
    }
    rec_match = {
        **MB_RECORDING,
        "id": "mb-rec-match",
        "artist-credit": [{"name": "jay chou"}],  # 传入 '周杰伦' 之外的匹配样例：'Jay Chou'
        "releases": [{"id": "mb-rel-match", "title": "Fantasy"}],
    }
    scraper, client, _ = make_scraper(
        gets=[
            FakeResponse({"recordings": [rec_other, rec_match]}),
            FakeResponse(status_code=302),  # CAA mb-rel-other
            FakeResponse(status_code=302),  # CAA mb-rel-match
        ],
        netease_items=[],
    )
    result = scraper._scrape_musicbrainz("安静", "Jay Chou")
    assert [r["mbid"] for r in result] == ["mb-rec-match", "mb-rec-other"]


def test_mb_release_mbid_degrades_without_artist():
    """封面 fallback 的 release MBID 查询同样走降级链，artist 不是硬条件"""
    scraper, client, _ = make_scraper(
        gets=[
            FakeResponse({"recordings": []}),
            FakeResponse({"recordings": [MB_RECORDING]}),
        ],
        netease_items=[],
    )
    mbid = scraper._musicbrainz_release_mbid("安静", "周杰伦")
    assert mbid == "mb-rel-1"
    queries = [kw["params"]["query"] for _, kw in client.calls]
    assert queries == ['recording:"安静"', 'recording:"安静"~']
    assert all("artist" not in q for q in queries)


def test_mb_norm_and_artist_matches():
    """归一化匹配：大小写/标点/空白差异算匹配；空 artist 不匹配"""
    assert TagScraper._norm("  Jay Chou! ") == "jaychou"
    assert TagScraper._norm("周杰伦") == "周杰伦"
    assert TagScraper._artist_matches("Jay Chou", "jaychou")
    assert TagScraper._artist_matches("A feat. B", "A")  # 互相包含
    assert TagScraper._artist_matches("周杰伦", "周杰伦")
    assert not TagScraper._artist_matches("周杰倫", "周杰伦")  # 繁简差异：不加分但也不挡结果
    assert not TagScraper._artist_matches("Someone Else", "")


def test_mb_query_escapes_quotes_in_title():
    """标题含引号/反斜杠时转义，不破坏 Lucene 短语语法"""
    stages = tag_scraper._mb_query_stages('say "hi" \\ x')
    assert stages == [
        'recording:"say \\"hi\\" \\\\ x"',
        'recording:"say \\"hi\\" \\\\ x"~',
        'title:say \\"hi\\" \\\\ x',
    ]
    assert tag_scraper._mb_query_stages("   ") == []  # 空标题 → 无阶段


def test_scrape_musicbrainz_shape_ua_and_sleep():
    """MusicBrainz 候选 9 字段（含 year/genre/track/album_artist）+ 自定义 UA + 调用前 sleep 1s"""
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
    assert set(cand) == {
        "title",
        "artist",
        "album",
        "cover",
        "mbid",
        "year",
        "genre",
        "track",
        "album_artist",
    }
    assert cand["mbid"] == "mb-rec-1"
    assert cand["artist"] == "周杰伦"
    assert cand["album"] == "范特西"
    assert cand["cover"] == CAA_URL
    # 新字段：year 取 release date 年份；genre 按 count 降序前 3 join；track 从 media 找；album_artist 取 release credit
    assert cand["year"] == 2001
    assert cand["genre"] == "mandopop/pop/chinese"
    assert cand["track"] == 3
    assert cand["album_artist"] == "周杰伦"
    # 自定义 User-Agent（否则 MusicBrainz 403）+ 每次调用前 sleep 1s
    mb_call = client.calls[0]
    assert mb_call[0] == tag_scraper.MUSICBRAINZ_API
    assert mb_call[1]["headers"]["User-Agent"] == tag_scraper.MUSICBRAINZ_UA
    assert sleeps == [1]


# ============ MB 候选新字段（year/genre/track/album_artist）============
def test_mb_year_release_date_priority():
    """year：release.date 优先，first-release-date 兜底"""
    rec = {
        **MB_RECORDING,
        "first-release-date": "1999-03-01",
        "releases": [{**MB_RECORDING["releases"][0], "date": "2001-09-14"}],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["year"] == 2001


def test_mb_year_fallback_first_release_date():
    """year：release 无 date → first-release-date 年份"""
    rec = {
        **MB_RECORDING,
        "first-release-date": "2001-09-14",
        "releases": [{**MB_RECORDING["releases"][0], "date": None}],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["year"] == 2001


def test_mb_year_missing_null():
    """year：release 与 first-release-date 都没有 → None，不抛异常"""
    rec = {
        **MB_RECORDING,
        "first-release-date": None,
        "releases": [{**MB_RECORDING["releases"][0], "date": None}],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["year"] is None


def test_mb_genre_sorted_top3_join():
    """genre：tags 按 count 降序取前 3 个 name 用 / 连接（输入乱序）"""
    rec = {
        **MB_RECORDING,
        "tags": [
            {"count": 1, "name": "ballad"},
            {"count": 9, "name": "mandopop"},
            {"count": 5, "name": "pop"},
            {"count": 2, "name": "chinese"},
        ],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["genre"] == "mandopop/pop/chinese"


def test_mb_genre_empty_string():
    """genre：无 tags / tags 无 name → 空串"""
    for tags in (None, [], [{"count": 3}]):
        rec = {**MB_RECORDING, "tags": tags}
        scraper, client, _ = make_scraper(
            gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
            netease_items=[],
        )
        assert scraper._scrape_musicbrainz("安静", "")[0]["genre"] == ""


def test_mb_track_number_from_media():
    """track：releases[0].media 里按 recording id 找 track.number"""
    rec = {
        **MB_RECORDING,
        "releases": [
            {
                **MB_RECORDING["releases"][0],
                "media": [
                    {"track": [{"number": "1", "recording": {"id": "other-rec"}}]},
                    {"track": [{"number": "12", "recording": {"id": "mb-rec-1"}}]},
                ],
            }
        ],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["track"] == 12


def test_mb_track_missing_null():
    """track：media 里找不到本 recording → None，不抛异常"""
    rec = {
        **MB_RECORDING,
        "releases": [
            {
                **MB_RECORDING["releases"][0],
                "media": [{"track": [{"number": "1", "recording": {"id": "other-rec"}}]}],
            }
        ],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["track"] is None


def test_mb_album_artist_from_release_credit():
    """album_artist：release artist-credit joinphrase（同 _join_artist_credit）"""
    rec = {
        **MB_RECORDING,
        "releases": [
            {
                **MB_RECORDING["releases"][0],
                "artist-credit": [{"name": "Various", "joinphrase": " Artists"}],
            }
        ],
    }
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]}), FakeResponse(status_code=302)],
        netease_items=[],
    )
    assert scraper._scrape_musicbrainz("安静", "")[0]["album_artist"] == "Various Artists"


def test_mb_no_release_new_fields_defaults():
    """无 release 时：album/cover 为 None，year/track 为 None，genre/album_artist 空串，不抛异常"""
    rec = {**MB_RECORDING, "releases": [], "tags": None, "first-release-date": None}
    scraper, client, _ = make_scraper(
        gets=[FakeResponse({"recordings": [rec]})],
        netease_items=[],
    )
    cand = scraper._scrape_musicbrainz("安静", "")[0]
    assert cand["album"] is None and cand["cover"] is None
    assert cand["year"] is None and cand["track"] is None
    assert cand["genre"] == "" and cand["album_artist"] == ""


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
    fake = TagScraper(
        client=FakeClient(), netease_search=lambda q, limit=20: [], sleep_fn=lambda s: None
    )
    monkeypatch.setattr(tag_scraper, "scraper", fake)
    result = tag_scraper.scrape("安静")
    assert set(result) == {"netease", "musicbrainz"}
