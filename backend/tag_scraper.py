"""多源标签刮削：网易云 + MusicBrainz recording 搜索 + 封面 fallback 链

- 网易云复用 netease_provider.search()（签名/返回结构不变）
- MusicBrainz ws/2 recording 搜索（自定义 User-Agent，低频调用前 sleep 1s）：
  查询用 title 降级链（精确短语 → fuzzy → title 关键词，最多 3 阶段，任一阶段有结果即返回），
  artist 不再是查询硬条件（文件 tag 歌手名与 MB 写法不一致——别名/繁简/大小写/标点/feat. 部分——
  会导致整条查询 0 结果），改为结果排序加分（artist 归一化后相等/包含的排前面）
- 封面 fallback 链：网易云 cover → iTunes Search API → Cover Art Archive → None，
  在 scrape 返回前补好，前端不感知 fallback
- MusicBrainz 候选新增 year/genre/track/album_artist（尽力取值，失败 → None/空串，绝不抛异常）；
  网易云候选字段保持不变（拿不到新字段，缺省即可，前端容错）
- 任何外部源挂掉都不影响其他源：单源失败返回空数组，整体不抛异常

测试通过注入 FakeClient / fake netease_search / sleep_fn 全 mock 网络。
"""

import re
from time import sleep as _sleep

import httpx

import netease_provider

MUSICBRAINZ_API = "https://musicbrainz.org/ws/2/recording"
MUSICBRAINZ_UA = "QQPlayer/1.0 (https://github.com/daxmate/qqplayer)"
COVERARTARCHIVE_FRONT = "https://coverartarchive.org/release/{mbid}/front"
ITUNES_SEARCH_API = "https://itunes.apple.com/search"
TIMEOUT = 10.0
SEARCH_LIMIT = 20


def _mb_query_stages(query: str) -> list[str]:
    """MusicBrainz recording 查询降级链（title 优先，最多 3 个阶段）。

    1. recording:"title" —— 精确短语（相关性最好）
    2. recording:"title"~ —— Lucene fuzzy（抓拼写/大小写/标点/繁简差异）
    3. title:title —— 关键词形式（最宽松兜底）

    artist 故意不放进来：作为硬条件时，文件 tag 歌手名与 MB 写法不一致
    （别名/繁简/大小写/标点/feat. 部分）会让整条查询 0 结果，
    因此 artist 只参与结果排序加分（见 TagScraper._artist_matches）。
    """
    q = (query or "").strip()
    if not q:
        return []
    # 转义 Lucene 特殊字符：短语内容里只可能被引号/反斜杠破坏
    esc = q.replace("\\", "\\\\").replace('"', '\\"')
    return [f'recording:"{esc}"', f'recording:"{esc}"~', f"title:{esc}"]


# ---- MusicBrainz 候选新字段（year/genre/track/album_artist）----


def _release_year(release: dict | None, recording: dict) -> int | None:
    """年份：release.date 优先，recording first-release-date 兜底；解析失败 → None"""
    for source in (release.get("date") if release else None, recording.get("first-release-date")):
        m = re.search(r"\d{4}", str(source or ""))
        if m:
            try:
                return int(m.group(0))
            except (ValueError, TypeError):
                return None
    return None


def _recording_genre(recording: dict) -> str:
    """流派：recording.tags 按 count 降序取前 3 个 name 用 / 连接；无 →"""
    tags = [t for t in (recording.get("tags") or []) if isinstance(t, dict) and t.get("name")]
    tags = sorted(tags, key=lambda t: int(t.get("count") or 0), reverse=True)
    return "/".join(str(t["name"]) for t in tags[:3])


def _recording_track_number(recording: dict) -> int | None:
    """音轨序号（尽力）：releases[0] 的 media 里找本 recording 对应的 track.number；找不到 → None"""
    try:
        release = next((r for r in (recording.get("releases") or []) if isinstance(r, dict)), None)
        if not release:
            return None
        rec_id = recording.get("id")
        for medium in release.get("media") or []:
            if not isinstance(medium, dict):
                continue
            for tr in medium.get("track") or []:
                if not isinstance(tr, dict):
                    continue
                tr_rec = tr.get("recording")
                tr_rec_id = tr_rec.get("id") if isinstance(tr_rec, dict) else tr_rec
                if tr_rec_id and tr_rec_id == rec_id:
                    m = re.match(r"\s*(\d+)", str(tr.get("number") or ""))
                    if m:
                        return int(m.group(1))
        return None
    except Exception:
        return None


class TagScraper:
    """网易云 + MusicBrainz 刮削器（依赖注入 client / netease_search / sleep_fn，便于测试）"""

    def __init__(self, client=None, netease_search=netease_provider.search, sleep_fn=_sleep):
        self._client = client or httpx.Client(timeout=TIMEOUT, follow_redirects=True)
        self._netease_search = netease_search
        self._sleep = sleep_fn
        # 同一 release MBID 只查一次 Cover Art Archive（候选间共享结果）
        self._caa_cache: dict[str, str | None] = {}

    def scrape(self, query: str, artist: str = "") -> dict:
        """返回 {"netease": [...], "musicbrainz": [...]}；单源失败返回空数组"""
        query = (query or "").strip()
        return {
            "netease": self._scrape_netease(query),
            "musicbrainz": self._scrape_musicbrainz(query, (artist or "").strip()),
        }

    # ---- 网易云 ----
    def _scrape_netease(self, query: str) -> list[dict]:
        try:
            items = self._netease_search(query, limit=SEARCH_LIMIT)
        except Exception:
            items = []
        results = []
        for it in items or []:
            if not isinstance(it, dict):
                continue
            # 契约只暴露这 6 个字段（去掉 netease 内部 extra 字段如 level）
            cand = {k: it.get(k) for k in ("id", "title", "artist", "album", "cover", "duration")}
            if not cand.get("cover"):
                cand["cover"] = self._fallback_cover(
                    str(cand.get("title") or ""), str(cand.get("artist") or "")
                )
            results.append(cand)
        return results

    # ---- MusicBrainz ----
    def _mb_search(self, query: str, limit: int = SEARCH_LIMIT) -> list[dict]:
        """MB recording 降级查询链：精确短语 → fuzzy → title 关键词。

        任一阶段有结果即返回（不再降级）；异常（限流/网络挂）直接返回空，
        不继续打下一个阶段（避免对不可用的 API 反复请求）。每阶段调用前 sleep 1s。
        """
        for mb_query in _mb_query_stages(query):
            try:
                self._sleep(1)
                resp = self._client.get(
                    MUSICBRAINZ_API,
                    params={"query": mb_query, "fmt": "json", "limit": limit},
                    headers={"User-Agent": MUSICBRAINZ_UA, "Accept": "application/json"},
                )
                resp.raise_for_status()
                recordings = (resp.json() or {}).get("recordings") or []
            except Exception:
                return []
            recordings = [r for r in recordings if isinstance(r, dict)]
            if recordings:
                return recordings
        return []

    @staticmethod
    def _norm(s: str) -> str:
        """artist 匹配用归一化：小写 + 去标点/空白/下划线（保留 CJK 等字母数字）"""
        return re.sub(r"[\W_]+", "", (s or "").lower(), flags=re.UNICODE)

    @classmethod
    def _artist_matches(cls, credit: str, artist: str) -> bool:
        """传入 artist 与 MB artist-credit 归一化后相等/互相包含 → 排序加分"""
        if not artist:
            return False
        a, b = cls._norm(credit), cls._norm(artist)
        return bool(a and b) and (a == b or a in b or b in a)

    def _scrape_musicbrainz(self, query: str, artist: str) -> list[dict]:
        """MB 搜索：title 降级链取结果；artist 仅用于排序加分（匹配的排前面，
        MB score 序保持——Python sort 稳定）"""
        recordings = self._mb_search(query)
        if artist:
            recordings = sorted(
                recordings,
                key=lambda rec: (
                    0
                    if self._artist_matches(
                        self._join_artist_credit(rec.get("artist-credit") or []), artist
                    )
                    else 1
                ),
            )
        results = []
        for rec in recordings:
            if not rec.get("id") or not rec.get("title"):
                continue
            release = next(
                (r for r in (rec.get("releases") or []) if isinstance(r, dict) and r.get("id")),
                None,
            )
            cover = self._coverartarchive_front(release["id"]) if release else None
            results.append(
                {
                    "title": rec["title"],
                    "artist": self._join_artist_credit(rec.get("artist-credit") or []),
                    "album": release.get("title") if release else None,
                    "cover": cover,
                    "mbid": rec["id"],
                    # 新字段：全部尽力取值，失败 → None/空串，绝不抛异常
                    "year": _release_year(release, rec),
                    "genre": _recording_genre(rec),
                    "track": _recording_track_number(rec),
                    "album_artist": (
                        self._join_artist_credit(release.get("artist-credit") or [])
                        if release
                        else ""
                    ),
                }
            )
        return results

    @staticmethod
    def _join_artist_credit(credit: list) -> str:
        """MusicBrainz artist-credit → 显示名（保留 joinphrase，如 'A feat. B'）"""
        parts = []
        for ac in credit:
            if isinstance(ac, str):
                parts.append(ac)
            elif isinstance(ac, dict) and ac.get("name"):
                parts.append(ac["name"])
                if ac.get("joinphrase"):
                    parts.append(ac["joinphrase"])
        return "".join(parts).strip()

    # ---- 封面 fallback 链 ----
    def _fallback_cover(self, title: str, artist: str) -> str | None:
        """iTunes Search API → Cover Art Archive → None（网易云 cover 由调用方先取）"""
        cover = self._itunes_cover(title, artist)
        if cover:
            return cover
        release_mbid = self._musicbrainz_release_mbid(title, artist)
        if release_mbid:
            return self._coverartarchive_front(release_mbid)
        return None

    def _itunes_cover(self, title: str, artist: str) -> str | None:
        """iTunes Search API：取 results[0].artworkUrl100 换成 artworkUrl600 拿高清"""
        term = f"{title} {artist}".strip()
        if not term:
            return None
        try:
            resp = self._client.get(
                ITUNES_SEARCH_API,
                params={"term": term, "media": "music", "limit": 5},
            )
            resp.raise_for_status()
            results = (resp.json() or {}).get("results") or []
            if results and results[0].get("artworkUrl100"):
                return str(results[0]["artworkUrl100"]).replace("100x100", "600x600")
        except Exception:
            pass
        return None

    def _musicbrainz_release_mbid(self, title: str, artist: str) -> str | None:
        """MusicBrainz 搜 recording，取第一个有 id 的 release MBID（封面 fallback）。
        同样走 title 降级链（精确→fuzzy→关键词），artist 不作为硬条件；
        artist 仅用于排序加分（匹配的 recording 先被取 release）。"""
        recordings = self._mb_search(title, limit=5)
        if artist:
            recordings = sorted(
                recordings,
                key=lambda rec: (
                    0
                    if self._artist_matches(
                        self._join_artist_credit(rec.get("artist-credit") or []), artist
                    )
                    else 1
                ),
            )
        for rec in recordings:
            for release in rec.get("releases") or []:
                if isinstance(release, dict) and release.get("id"):
                    return release["id"]
        return None

    def _coverartarchive_front(self, release_mbid: str) -> str | None:
        """Cover Art Archive release 前封面；404/异常 → None（不报错），同 MBID 缓存"""
        if release_mbid in self._caa_cache:
            return self._caa_cache[release_mbid]
        url = COVERARTARCHIVE_FRONT.format(mbid=release_mbid)
        cover: str | None = None
        try:
            resp = self._client.get(
                url,
                headers={"User-Agent": MUSICBRAINZ_UA},
                follow_redirects=False,
            )
            # CAA 有封面时返回 3xx 重定向到 archive.org 图片（302/307 都有），404 表示无封面
            if 200 <= resp.status_code < 400:
                cover = url
        except Exception:
            cover = None
        self._caa_cache[release_mbid] = cover
        return cover


# 模块级默认实例（路由直接调用模块级函数，与 netease_provider 风格一致）
scraper = TagScraper()


def scrape(query: str, artist: str = "") -> dict:
    return scraper.scrape(query, artist)
