"""在线歌词获取（多源 fallback + 本地缓存）+ 用户手动指定歌词

链路: 网易云音乐（原文+翻译） → lrclib.net → None
缓存: ~/.cache/qqplayer/lyric/<key>.json（key = sha1(title|artist)）
手动指定: ~/.cache/qqplayer/lyric/manual/<key>.json（key = sha1(歌曲绝对路径)）
"""

import hashlib
import json
import os
import time
from pathlib import Path

import httpx

import netease_provider

CACHE_DIR = Path(os.path.expanduser("~")) / ".cache" / "qqplayer" / "lyric"
CACHE_TTL = 30 * 24 * 3600  # 30 天

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


# ============ 用户手动指定歌词 ============
MANUAL_DIR = CACHE_DIR / "manual"


def manual_key(path: str) -> str:
    """手动指定歌词的文件 key = sha1(歌曲绝对路径)"""
    return hashlib.sha1(str(path).encode()).hexdigest()[:16]


def load_manual_lyric(path: str):
    """读取手动指定歌词，返回 {format, text, source, created_at} 或 None"""
    f = MANUAL_DIR / f"{manual_key(path)}.json"
    if not f.exists():
        return None
    try:
        data = json.loads(f.read_text(encoding="utf-8"))
        if data.get("format") not in ("lrc", "srt") or not data.get("text"):
            return None
        return data
    except (OSError, json.JSONDecodeError):
        return None


def save_manual_lyric(
    path: str, format: str, text: str, source: str = "manual", tlyric: str | None = None
) -> dict:
    """保存手动指定歌词（覆盖旧值），返回完整 payload；tlyric 为可选中文翻译 LRC"""
    fmt = format if format in ("lrc", "srt") else "lrc"
    payload = {
        "format": fmt,
        "text": text,
        "source": source or "manual",
        "created_at": int(time.time()),
    }
    if tlyric:
        payload["tlyric"] = tlyric
    try:
        MANUAL_DIR.mkdir(parents=True, exist_ok=True)
        (MANUAL_DIR / f"{manual_key(path)}.json").write_text(
            json.dumps(payload, ensure_ascii=False), encoding="utf-8"
        )
    except OSError:
        pass  # 写盘失败不影响功能
    return payload


def delete_manual_lyric(path: str) -> bool:
    """删除手动指定歌词，返回是否删除了文件"""
    f = MANUAL_DIR / f"{manual_key(path)}.json"
    try:
        if f.exists():
            f.unlink()
            return True
    except OSError:
        pass
    return False


def cleanup_orphan_manual_lyrics(valid_paths: list[str]) -> int:
    """清理孤儿手动歌词：删除 MANUAL_DIR 下不在 valid_paths 集合内的 .json，返回删除文件数

    手动歌词文件名 = manual_key(绝对路径) + ".json"，哈希不可逆，孤儿判定只能正向索引：
    valid_paths 逐个算 key 得"应存在"集合，再扫目录删集合外的文件。
    OSError 容错：单个文件删除失败不影响其他文件。
    """
    if not MANUAL_DIR.is_dir():
        return 0
    valid_keys = {manual_key(p) for p in valid_paths}
    removed = 0
    for f in MANUAL_DIR.iterdir():
        if not f.is_file() or f.suffix.lower() != ".json":
            continue
        if f.stem in valid_keys:
            continue
        try:
            f.unlink()
            removed += 1
        except OSError:
            continue
    return removed


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


# ============ 网易云音乐（eapi 官方接口，netease_provider）============
def _netease_candidates(title: str, artist: str, limit: int = 8):
    """搜索歌曲，返回候选列表 [{id, title, artist, duration, cover}]（未过滤歌词可用性）"""
    q = f"{title} {artist}".strip()
    items = netease_provider.search(q, limit=limit)
    out = []
    for it in items:
        dur = 0.0
        d = it.get("duration")  # provider 返回 "mm:ss"
        if d and ":" in d:
            try:
                mm, ss = d.split(":", 1)
                dur = float(int(mm) * 60 + int(ss))
            except ValueError:
                dur = 0.0
        out.append(
            {
                "id": it.get("id"),
                "title": it.get("title", ""),
                "artist": it.get("artist", ""),
                "duration": dur,
                "cover": it.get("cover"),
            }
        )
    return out


def _netease_search(title: str, artist: str):
    """搜索歌曲，返回最匹配的歌曲 id（兼容旧调用）"""
    cands = _netease_candidates(title, artist)
    if not cands:
        return None
    for c in cands:
        if c["title"] == title and (not artist or artist in c["artist"]):
            return c["id"]
    return cands[0]["id"]


def _netease_lyric(song_id: int):
    """按歌曲 id 获取 (原文 LRC, 中文翻译 LRC)；无歌词返回 (None, None)

    新版逐字歌词（lrc.lyric 为 JSON-lines 格式）自动转成普通 LRC，
    老歌普通 LRC 原样透传。
    """
    data = netease_provider.get_lyric(song_id)
    lrc = ""
    if data and isinstance(data.get("lrc"), dict):
        lrc = netease_provider.word_json_to_lrc(data["lrc"].get("lyric", ""))
    if not lrc.strip():
        return None, None
    tlyric = None
    if data and isinstance(data.get("tlyric"), dict):
        tlyric = netease_provider.word_json_to_lrc(data["tlyric"].get("lyric", "")) or None
    return lrc, tlyric


def fetch_netease(title: str, artist: str) -> tuple[str, str | None] | None:
    """网易云获取歌词，返回 (原文, 翻译)；失败/无结果返回 None"""
    try:
        song_id = _netease_search(title, artist)
        if song_id is None:
            return None
        lrc, tlyric = _netease_lyric(song_id)
        if lrc is None:
            return None
        return lrc, tlyric
    except (httpx.HTTPError, OSError, ValueError, KeyError):
        return None


def search_netease(title: str, artist: str):
    """搜索网易云候选（带歌词全文+翻译），返回 [{source, title, artist, duration, text, tlyric}]"""
    try:
        cands = _netease_candidates(title, artist)
        out = []
        for c in cands[:5]:
            lrc, tlyric = _netease_lyric(c["id"])
            if not lrc:
                continue
            out.append({"source": "netease", **c, "text": lrc, "tlyric": tlyric})
        return out
    except (httpx.HTTPError, OSError, ValueError, KeyError):
        return []


# ============ lrclib.net ============
def search_lrclib(title: str, artist: str):
    """搜索 lrclib 候选（仅保留带时间戳的 syncedLyrics，无时间戳纯文本对播放器无用）
    返回 [{source, title, artist, duration, text}]"""
    try:
        with httpx.Client(timeout=TIMEOUT) as client:
            r = client.get(
                "https://lrclib.net/api/search",
                params={"track_name": title, "artist_name": artist},
                headers={"User-Agent": "qqplayer/1.0"},
            )
            r.raise_for_status()
            hits = r.json()
            out = []
            for hit in hits:
                if hit.get("instrumental"):
                    continue
                text = hit.get("syncedLyrics")
                if not text:
                    continue
                out.append(
                    {
                        "source": "lrclib",
                        "title": hit.get("trackName", ""),
                        "artist": hit.get("artistName", ""),
                        "duration": hit.get("duration"),
                        "text": text,
                        "tlyric": None,
                    }
                )
            return out
    except (httpx.HTTPError, OSError, ValueError):
        return []


def search_lyric_candidates(title: str, artist: str):
    """多源搜索歌词候选（网易云 → lrclib），返回统一列表；全部失败返回 []"""
    return search_netease(title, artist) + search_lrclib(title, artist)


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
