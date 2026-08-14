"""多源标签刮削：网易云 + MusicBrainz recording 搜索 + 封面 fallback 链

- 网易云复用 netease_provider.search()（签名/返回结构不变）
- MusicBrainz ws/2 recording 搜索（自定义 User-Agent，低频调用前 sleep 1s）
- 封面 fallback 链：网易云 cover → iTunes Search API → Cover Art Archive → None，
  在 scrape 返回前补好，前端不感知 fallback
- 任何外部源挂掉都不影响其他源：单源失败返回空数组，整体不抛异常

测试通过注入 FakeClient / fake netease_search / sleep_fn 全 mock 网络。
"""

from time import sleep as _sleep

import httpx

import netease_provider

MUSICBRAINZ_API = "https://musicbrainz.org/ws/2/recording"
MUSICBRAINZ_UA = "QQPlayer/1.0 (https://github.com/daxmate/qqplayer)"
COVERARTARCHIVE_FRONT = "https://coverartarchive.org/release/{mbid}/front"
ITUNES_SEARCH_API = "https://itunes.apple.com/search"
TIMEOUT = 10.0
SEARCH_LIMIT = 20


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
    def _scrape_musicbrainz(self, query: str, artist: str) -> list[dict]:
        mb_query = f'recording:"{query}"'
        if artist:
            mb_query += f' AND artist:"{artist}"'
        try:
            self._sleep(1)
            resp = self._client.get(
                MUSICBRAINZ_API,
                params={"query": mb_query, "fmt": "json", "limit": SEARCH_LIMIT},
                headers={"User-Agent": MUSICBRAINZ_UA, "Accept": "application/json"},
            )
            resp.raise_for_status()
            recordings = (resp.json() or {}).get("recordings") or []
        except Exception:
            return []
        results = []
        for rec in recordings:
            if not isinstance(rec, dict) or not rec.get("id") or not rec.get("title"):
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
        """MusicBrainz 搜 recording，取第一个有 id 的 release MBID（低频 sleep 1s）"""
        mb_query = f'recording:"{title}"'
        if artist:
            mb_query += f' AND artist:"{artist}"'
        try:
            self._sleep(1)
            resp = self._client.get(
                MUSICBRAINZ_API,
                params={"query": mb_query, "fmt": "json", "limit": 5},
                headers={"User-Agent": MUSICBRAINZ_UA, "Accept": "application/json"},
            )
            resp.raise_for_status()
            for rec in (resp.json() or {}).get("recordings") or []:
                for release in rec.get("releases") or []:
                    if isinstance(release, dict) and release.get("id"):
                        return release["id"]
        except Exception:
            pass
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
