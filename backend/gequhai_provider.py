"""歌曲海（gequhai.com）provider

能力:
- search(query, limit): 歌曲搜索（GET /s/<kw> 结果页，HTML 表格解析，翻页凑 limit，上限 50 条）
- get_share_url(song_id): 获取夸克网盘分享链接（GET /play/<id>，解析 JS 变量
  mp3_extra_url，'#'→'H' / '%'→'S' 替换后 base64 解码）

歌曲海只做"搜索 + 提取夸克分享链接"，HQ 下载由 quark_provider 负责。
网络/解析失败策略与 netease_provider.search 一致：search 失败返回 []，
get_share_url 解析失败返回 {"share_url": None, "play_id": None}，均不抛异常。
"""

import base64
import html as html_module
import re
import threading
from urllib.parse import quote

import httpx

BASE_URL = "https://www.gequhai.com"
SEARCH_API_URL = f"{BASE_URL}/api/s"
SEARCH_URL = f"{BASE_URL}/s"
PLAY_URL = f"{BASE_URL}/play"
PAGE_SIZE = 10
MAX_RESULTS = 50
TIMEOUT = 15.0

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

_TR_ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
_TABLE_RE = re.compile(r'<table[^>]*id=["\']?myTables["\']?[^>]*>(.*?)</table>', re.S)
_SONG_LINK_RE = re.compile(r'<a[^>]*href="/play/(\d+)"[^>]*>(.*?)</a>', re.S)
# 歌手 td 的 color 样式实测为 `color: #666;font-size: 15px;`，兼容 `color:#666` 无空格写法
_ARTIST_TD_RE = re.compile(r"<td[^>]*color\s*:\s*#666[^>]*>(.*?)</td>", re.S)
_PLAY_ID_RE = re.compile(r"""window\.play_id\s*=\s*['"]([^'"]*)['"]""")
_EXTRA_URL_RE = re.compile(r"""window\.mp3_extra_url\s*=\s*['"]([^'"]*)['"]""")
_HTTP_URL_RE = re.compile(r"^https?://", re.IGNORECASE)


# ============ 纯解析函数（可独立测试，网络层薄封装）============
def _clean_text(value: str) -> str:
    """HTML 文本清理：解实体 + 折叠空白 + 去首尾空格"""
    return html_module.unescape(re.sub(r"\s+", " ", value or "")).strip()


def _parse_search_html(html_text: str) -> list[dict]:
    """解析搜索结果页 HTML → [{id, title, artist, page_url}]；无结果/解析失败返回 []

    只解析 id="myTables" 表格内的行（每行：排名 / <a href="/play/<id>">歌名</a> /
    color:#666 样式的歌手 td）。表头行、无关行自然跳过。
    """
    if not html_text:
        return []
    table = _TABLE_RE.search(html_text)
    if not table:
        return []
    items = []
    for row in _TR_ROW_RE.findall(table.group(1)):
        link = _SONG_LINK_RE.search(row)
        artist_td = _ARTIST_TD_RE.search(row)
        if not link or not artist_td:
            continue
        title = _clean_text(link.group(2))
        if not title:
            continue
        artist = _clean_text(artist_td.group(1)) or "未知歌手"
        song_id = link.group(1)
        items.append(
            {
                "id": song_id,
                "title": title,
                "artist": artist,
                "page_url": f"{PLAY_URL}/{song_id}",
            }
        )
    return items


def _decode_extra_url(value: str) -> str | None:
    """mp3_extra_url 解码：'#'→'H'，'%'→'S'，base64 解码 → 夸克分享 URL

    解码失败或结果非 http(s) URL 返回 None。
    """
    if not value:
        return None
    try:
        decoded = base64.b64decode(value.replace("#", "H").replace("%", "S")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None
    decoded = decoded.strip()
    return decoded if _HTTP_URL_RE.match(decoded) else None


def _parse_play_html(html_text: str) -> dict:
    """解析播放页 HTML → {"share_url": str|None, "play_id": str|None}

    提取 window.play_id / window.mp3_extra_url 两个 JS 变量；字段缺失时对应值为 None。
    """
    play_id = None
    extra_url = None
    if html_text:
        m = _PLAY_ID_RE.search(html_text)
        if m:
            play_id = m.group(1)
        m = _EXTRA_URL_RE.search(html_text)
        if m:
            extra_url = m.group(1)
    return {"share_url": _decode_extra_url(extra_url), "play_id": play_id}


class GequhaiProvider:
    """歌曲海 provider（模块级共用 httpx.Client + 锁，多线程串行安全）

    每个实例独立 Client；search/get_share_url 的请求序列由锁串行化，
    避免 FastAPI 同步路由多线程下共享 Client 的竞态。
    """

    def __init__(self, client: httpx.Client | None = None):
        self._client = client or httpx.Client(timeout=httpx.Timeout(TIMEOUT), follow_redirects=True)
        self._lock = threading.Lock()

    # ---- 内部：请求头 / 预检 ----
    def _headers(self, referer: str | None = None) -> dict:
        headers = {"User-Agent": DEFAULT_UA}
        if referer:
            headers["Referer"] = referer
        return headers

    def _api_ready(self, keyword: str) -> bool:
        """搜索预检：POST /api/s（XMLHttpRequest），code==1 才算可用

        网络异常 / 非 JSON / code!=1 一律视为不可用（search 返回 []）。
        """
        try:
            resp = self._client.post(
                SEARCH_API_URL,
                data={"keyword": keyword},
                headers={
                    "User-Agent": DEFAULT_UA,
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": f"{BASE_URL}/",
                },
            )
            resp.raise_for_status()
            return resp.json().get("code") == 1
        except (httpx.HTTPError, OSError, ValueError):
            return False

    # ---- search ----
    def search(self, query: str, limit: int = 20) -> list[dict]:
        """搜索歌曲；失败返回 [] 不抛异常

        每页 10 条：limit≤10 取第一页，limit>10 翻页凑够（上限 50 条）。
        返回 [{id(str), title, artist, page_url}]。
        """
        keyword = (query or "").strip()
        if not keyword:
            return []
        try:
            limit = max(1, min(MAX_RESULTS, int(limit)))
            with self._lock:
                if not self._api_ready(keyword):
                    return []
                items: list[dict] = []
                pages = min((limit + PAGE_SIZE - 1) // PAGE_SIZE, MAX_RESULTS // PAGE_SIZE)
                for page in range(1, pages + 1):
                    url = f"{SEARCH_URL}/{quote(keyword)}"
                    if page > 1:
                        url += f"?page={page}"
                    resp = self._client.get(url, headers=self._headers(f"{SEARCH_URL}/"))
                    resp.raise_for_status()
                    page_items = _parse_search_html(resp.text)
                    items.extend(page_items)
                    if not page_items or len(items) >= limit:
                        break
                return items[:limit]
        except (httpx.HTTPError, OSError, ValueError):
            return []

    # ---- get_share_url ----
    def get_share_url(self, song_id: str) -> dict:
        """获取夸克分享链接：GET /play/<id> → 解析 JS 变量

        返回 {"share_url": str|None, "play_id": str|None}；
        网络/解析失败字段为 None，不抛异常。
        """
        try:
            with self._lock:
                url = f"{PLAY_URL}/{str(song_id).strip()}"
                resp = self._client.get(url, headers=self._headers(f"{SEARCH_URL}/"))
                resp.raise_for_status()
                return _parse_play_html(resp.text)
        except (httpx.HTTPError, OSError, ValueError):
            return {"share_url": None, "play_id": None}


# 模块级默认实例（与 netease_provider 一致的模块级函数入口）
provider = GequhaiProvider()


def search(query: str, limit: int = 20) -> list[dict]:
    return provider.search(query, limit)


def get_share_url(song_id: str) -> dict:
    return provider.get_share_url(song_id)
