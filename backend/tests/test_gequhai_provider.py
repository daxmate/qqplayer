"""gequhai_provider 歌曲海 provider 测试（fixture 解析 + mock 网络，CI 稳定）"""

import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import gequhai_provider  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"

SEARCH_HTML = (FIXTURES / "gequhai_search.html").read_text(encoding="utf-8", errors="replace")
PLAY_HTML = (FIXTURES / "gequhai_play.html").read_text(encoding="utf-8", errors="replace")


class FakeResponse:
    """测试用最小 httpx 响应替身"""

    def __init__(self, text: str = ""):
        self.text = text

    def raise_for_status(self):
        pass


# ============ _parse_search_html（纯解析）============
def test_parse_search_html_extracts_items():
    """fixture 搜索页 → ≥1 条 {id,title,artist}，晴天/周杰伦 字段正确"""
    items = gequhai_provider._parse_search_html(SEARCH_HTML)
    assert len(items) >= 1
    first = items[0]
    assert set(first) == {"id", "title", "artist", "page_url"}
    assert first["id"] == "326"
    assert first["title"] == "晴天"
    assert first["artist"] == "周杰伦"
    assert first["page_url"] == "https://www.gequhai.com/play/326"


def test_parse_search_html_skips_header_and_missing_rows():
    """表头行/无歌手 td 的行被跳过，提取数与 fixture 实际数据行一致（10 条）"""
    items = gequhai_provider._parse_search_html(SEARCH_HTML)
    assert len(items) == 10
    assert all(item["id"].isdigit() for item in items)


def test_parse_search_html_empty_input():
    """空字符串/无 myTables 表格 → []"""
    assert gequhai_provider._parse_search_html("") == []
    assert gequhai_provider._parse_search_html("<html><body>无表格</body></html>") == []


# ============ _decode_extra_url（纯解码）============
def test_decode_extra_url_known_vector():
    """已知 base64 样本：'#'→'H'、'%'→'S' 后解码为夸克分享 URL"""
    raw = "a#R0c#M6Ly9wYW4ucXVhcmsuY24vcy84NmY2MzU1MWE4YTM="
    assert gequhai_provider._decode_extra_url(raw) == "https://pan.quark.cn/s/86f63551a8a3"


def test_decode_extra_url_failures():
    """损坏 base64 / 非 URL 解码结果 → None"""
    assert gequhai_provider._decode_extra_url("") is None
    assert gequhai_provider._decode_extra_url("###not-base64###") is None
    assert gequhai_provider._decode_extra_url("a#R0c#aGVsbG8=") is None  # 解码出 "hello" 非 URL


# ============ get_share_url（fixture 解析）============
def test_get_share_url_from_fixture(monkeypatch):
    """play.html fixture → play_id + 夸克分享链接（pan.quark.cn/s/ 开头）"""
    monkeypatch.setattr(
        gequhai_provider.provider._client, "get", lambda *a, **k: FakeResponse(PLAY_HTML)
    )
    result = gequhai_provider.get_share_url("326")
    assert result["play_id"] == "1cddd181d2b68a9e72413639f26c83ba"
    assert result["share_url"] is not None
    assert result["share_url"].startswith("https://pan.quark.cn/s/")


def test_get_share_url_missing_extra_url(monkeypatch):
    """无 mp3_extra_url 的 HTML → {"share_url": None, ...}，不抛异常"""
    html = "<html><body><script>window.play_id = 'abc123';</script></body></html>"
    monkeypatch.setattr(
        gequhai_provider.provider._client, "get", lambda *a, **k: FakeResponse(html)
    )
    result = gequhai_provider.get_share_url("999")
    assert result == {"share_url": None, "play_id": "abc123"}


def test_get_share_url_network_error(monkeypatch):
    """网络异常 → {"share_url": None, "play_id": None}，不抛异常"""

    def boom(*args, **kwargs):
        raise httpx.ConnectError("network down")

    monkeypatch.setattr(gequhai_provider.provider._client, "get", boom)
    assert gequhai_provider.get_share_url("326") == {"share_url": None, "play_id": None}


# ============ search（网络层）============
def test_search_network_error_returns_empty(monkeypatch):
    """网络失败（预检/结果页均异常）→ 返回 []"""

    def boom(*args, **kwargs):
        raise httpx.ConnectError("network down")

    monkeypatch.setattr(gequhai_provider.provider._client, "post", boom)
    monkeypatch.setattr(gequhai_provider.provider._client, "get", boom)
    assert gequhai_provider.search("晴天") == []


def test_search_precheck_rejected_returns_empty(monkeypatch):
    """预检 code!=1 → 返回 []"""

    class FakeJsonResponse(FakeResponse):
        def json(self):
            return {"code": 0, "msg": "fail"}

    monkeypatch.setattr(
        gequhai_provider.provider._client, "post", lambda *a, **k: FakeJsonResponse("")
    )
    assert gequhai_provider.search("晴天") == []


def test_search_empty_query():
    """空 query → []（不发网络请求）"""
    assert gequhai_provider.search("") == []
    assert gequhai_provider.search("   ") == []
