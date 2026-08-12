"""在线歌词获取（多源 fallback + 本地缓存）

链路: 网易云音乐（原文+翻译） → lrclib.net → None
缓存: ~/.cache/qqplayer/lyric/<key>.json（key = sha1(title|artist)）
"""

import hashlib
import json
import os
import time
from pathlib import Path

import httpx

CACHE_DIR = Path(os.path.expanduser("~")) / ".cache" / "qqplayer" / "lyric"
CACHE_TTL = 30 * 24 * 3600  # 30 天

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
    "Referer": "https://music.163.com/",
}

TIMEOUT = httpx.Timeout(8.0)


def cache_key(title: str, artist: str) -> str:
    return hashlib.sha1(f"{title}|{artist}".encode()).hexdigest()[:16]


def _load_cache(key: str):
    """读取缓存，返回 (lrc, tlyric, source) 或 None"""
    f = CACHE_DIR / f"{key}.json"
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        if time.time() - data.get("fetched_at", 0) > CACHE_TTL:
            return None
        return data.get("lrc"), data.get("tlyric"), data.get("source")
    except Exception:
        return None


def _save_cache(key: str, lrc: str, source: str, tlyric: str | None = None):
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        payload = {
            "lrc": lrc,
            "tlyric": tlyric,
            "source": source,
            "fetched_at": int(time.time()),
        }
        (CACHE_DIR / f"{key}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass  # 缓存失败不影响功能


# ============ 网易云音乐 ============
def _netease_search(client: httpx.Client, title: str, artist: str):
    """搜索歌曲，返回最匹配的歌曲 id"""
    q = f"{title} {artist}".strip()
    r = client.get(
        "https://music.163.com/api/search/get/web",
        params={"csrf_token": "", "s": q, "type": 1, "offset": 0, "total": "true", "limit": 5},
        headers=HEADERS,
    )
    r.raise_for_status()
    songs = r.json().get("result", {}).get("songs", [])
    if not songs:
        return None
    # 优先歌名+歌手都匹配的
    for s in songs:
        artists = {a.get("name", "") for a in s.get("artists", [])}
        if s.get("name") == title and (not artist or artist in artists):
            return s["id"]
    return songs[0]["id"]


def _netease_lyric(client: httpx.Client, song_id: int):
    """按歌曲 id 获取 (原文 LRC, 中文翻译 LRC)；无歌词返回 (None, None)"""
    r = client.get(
        "https://music.163.com/api/song/lyric",
        params={"id": song_id, "lv": 1, "kv": 1, "tv": -1},
        headers=HEADERS,
    )
    r.raise_for_status()
    data = r.json()
    lrc = data.get("lrc", {}).get("lyric", "")
    if not lrc.strip():
        return None, None
    tlyric = data.get("tlyric", {}).get("lyric", "") or None
    return lrc, tlyric


def fetch_netease(title: str, artist: str) -> tuple[str, str | None] | None:
    """网易云获取歌词，返回 (原文, 翻译)；失败/无结果返回 None"""
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            song_id = _netease_search(client, title, artist)
            if song_id is None:
                return None
            lrc, tlyric = _netease_lyric(client, song_id)
            if lrc is None:
                return None
            return lrc, tlyric
    except (httpx.HTTPError, OSError, ValueError, KeyError):
        return None


# ============ lrclib.net ============
def fetch_lrclib(title: str, artist: str) -> str | None:
    """lrclib.net 获取歌词（优先带时间戳的 syncedLyrics），无翻译"""
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(
                "https://lrclib.net/api/search",
                params={"track_name": title, "artist_name": artist},
                headers={"User-Agent": "qqplayer/1.0"},
            )
            r.raise_for_status()
            hits = r.json()
            for hit in hits:
                if hit.get("instrumental"):
                    continue
                synced = hit.get("syncedLyrics")
                if synced:
                    return synced
            for hit in hits:
                plain = hit.get("plainLyrics")
                if plain:
                    return plain
            return None
    except (httpx.HTTPError, OSError, ValueError):
        return None


# ============ 统一入口 ============
def fetch_online_lyric(title: str, artist: str) -> tuple[str | None, str | None, str | None]:
    """多源获取：网易云 → lrclib。返回 (原文, 翻译, 来源)，全部失败返回 (None, None, None)"""
    key = cache_key(title, artist)
    cached = _load_cache(key)
    if cached is not None:
        cached_lrc, cached_tlyric, cached_source = cached
        if cached_lrc:
            return cached_lrc, cached_tlyric, cached_source
        return None, None, None  # 命中"无结果"缓存，不再请求
    # 网易云
    netease = fetch_netease(title, artist)
    if netease is not None:
        lrc, tlyric = netease
        _save_cache(key, lrc, "netease", tlyric)
        return lrc, tlyric, "netease"
    # lrclib 兜底
    lrc = fetch_lrclib(title, artist)
    if lrc:
        _save_cache(key, lrc, "lrclib")
        return lrc, None, "lrclib"
    _save_cache(key, "", "none")  # 缓存"无结果"，避免反复请求
    return None, None, None
