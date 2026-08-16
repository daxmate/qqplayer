"""在线歌词获取（多源 fallback + 本地缓存）+ 用户手动指定歌词

链路: 网易云音乐（原文+翻译） → lrclib.net → None
缓存: ~/.cache/qqplayer/lyric/<key>.json（key = sha1(title|artist)）
手动指定: ~/.cache/qqplayer/lyric/manual/<key>.json（key = sha1(歌曲绝对路径)）
"""

import difflib
import hashlib
import json
import os
import re
import threading
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


# ============ 自动补翻译（手动歌词 → 网易云 tlyric 行级匹配） ============
# 网易云 tlyric 按时间戳对齐，而手动歌词（粘贴/AI 对齐）时间轴与网易云完全不同，
# 直接按时间戳合并会错位；这里逐行按文本内容匹配，翻译行时间戳改用手动歌词行的时间戳。
AUTO_TRANSLATION_TIMEOUT = 15.0  # 整体超时（秒），超时静默放弃（后台线程 join 硬限）
AUTO_TRANSLATION_MIN_RATIO = 0.6  # 行匹配率阈值：匹配行数/手动总行数低于此值视为错配，放弃
AUTO_TRANSLATION_MAX_CANDIDATES = 5  # 最多尝试的网易云候选数
AUTO_TRANSLATION_LINE_RATIO = 0.85  # 单行编辑相似度阈值（0.8 会把差一个字符的短行误配，故取 0.85）

_LRC_TS_RE = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")
_SRT_TS_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})\s*-->\s*"
    r"(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})"
)


def _lrc_lines(text: str) -> list[tuple[float, str]]:
    """解析 LRC → [(时间秒, 文本)]；多时间戳行取第一个时间戳；无文本行跳过"""
    out = []
    for raw in text.replace("\r", "").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        m = _LRC_TS_RE.match(raw)
        if not m:
            continue
        ms = m.group(3) or "0"
        ms = int(ms) * (10 ** (3 - len(ms)))
        t = int(m.group(1)) * 60 + int(m.group(2)) + ms / 1000
        content = _LRC_TS_RE.sub("", raw[m.end() :]).strip()
        if content:
            out.append((t, content))
    return out


def _srt_lines(text: str) -> list[tuple[float, str]]:
    """解析 SRT → [(起始时间秒, 文本)]；一个时间轴只取其后第一行文本（与 parse_srt 对齐）"""
    out = []
    cur = None
    for raw in text.replace("\r", "").splitlines():
        if "-->" in raw:
            m = _SRT_TS_RE.search(raw)
            if m:
                h, mi, s = int(m.group(1)), int(m.group(2)), int(m.group(3))
                ms = int(m.group(4) or 0) * (10 ** (3 - len(m.group(4) or "0")))
                cur = h * 3600 + mi * 60 + s + ms / 1000
            continue
        line = raw.strip()
        if cur is None or not line or line.isdigit():
            continue
        out.append((cur, line))
        cur = None
    return out


def _normalize_lyric_line(text: str) -> str:
    """清洗歌词行用于文本匹配：去空白/标点/下划线，统一小写（保留中日韩/字母/数字）"""
    return re.sub(r"[\W_]+", "", text).lower()


def _lyric_line_match(a: str, b: str) -> bool:
    """两条已清洗歌词行是否匹配：相同 / 一方包含另一方（短方 ≥ 2 字符）/ 编辑相似度 ≥ 0.8"""
    if not a or not b:
        return False
    if a == b:
        return True
    if len(a) >= 2 and len(b) >= 2 and (a in b or b in a):
        return True
    return difflib.SequenceMatcher(None, a, b).ratio() >= AUTO_TRANSLATION_LINE_RATIO


def _match_translation_lines(
    manual_lines: list[tuple[float, str]], lrc_text: str, tlyric_text: str
) -> list[tuple[float, str]]:
    """行级匹配手动歌词 ↔ 网易云歌词，返回 [(手动行时间戳, 翻译文本)]

    - 手动行按清洗后文本与网易云原文行匹配（不依赖时间戳对齐）
    - 网易云翻译行按时间戳（容差 0.6s，与 merge_translation 一致）挂到对应网易云原文行
    - 重复段落（副歌多次出现）优先匹配带翻译的原文行
    - 匹配率 = 匹配行数/手动总行数，低于阈值返回 []（防错配）
    """
    lrc_lines = _lrc_lines(lrc_text)
    tlyric_lines = _lrc_lines(tlyric_text)
    if not lrc_lines or not manual_lines:
        return []
    norm_lrc = [_normalize_lyric_line(t) for _ts, t in lrc_lines]
    # 网易云翻译行 → 最近的网易云原文行下标
    trans_by_lrc: dict[int, str] = {}
    for tt, ttxt in tlyric_lines:
        if not ttxt.strip():
            continue
        best = None
        for i, (ts, _t) in enumerate(lrc_lines):
            if abs(ts - tt) <= 0.6 and (
                best is None or abs(lrc_lines[best][0] - tt) > abs(ts - tt)
            ):
                best = i
        if best is not None and best not in trans_by_lrc:
            trans_by_lrc[best] = ttxt
    matched = 0
    out = []
    for m_ts, m_txt in manual_lines:
        ntxt = _normalize_lyric_line(m_txt)
        if not ntxt:
            continue
        # 先找带翻译的匹配行（重复段落场景），再退回任意匹配行
        idx = next(
            (
                i
                for i, n in enumerate(norm_lrc)
                if trans_by_lrc.get(i) and _lyric_line_match(ntxt, n)
            ),
            None,
        )
        if idx is None:
            idx = next((i for i, n in enumerate(norm_lrc) if _lyric_line_match(ntxt, n)), None)
        if idx is None:
            continue
        matched += 1
        tr = trans_by_lrc.get(idx)
        if tr:
            out.append((m_ts, tr))
    if not out or matched / len(manual_lines) < AUTO_TRANSLATION_MIN_RATIO:
        return []
    return out


def _build_translation_lrc(lines: list[tuple[float, str]]) -> str:
    """[(时间秒, 文本)] → LRC 字符串（[mm:ss.xx] 每行，与 _align_to_lrc 格式一致）"""
    out = []
    for t, txt in lines:
        total_cs = int(round(t * 100))
        mm, rem = divmod(total_cs, 6000)
        ss, cs = divmod(rem, 100)
        out.append(f"[{mm:02d}:{ss:02d}.{cs:02d}]{txt}")
    return "\n".join(out)


def _auto_attach_translation_inner(title: str, artist: str, text: str, fmt: str):
    """auto_attach_translation 的实际逻辑（在线程内执行，外层控制整体超时）"""
    manual_lines = _srt_lines(text) if fmt == "srt" else _lrc_lines(text)
    if len(manual_lines) < 2:
        return None
    deadline = time.monotonic() + AUTO_TRANSLATION_TIMEOUT
    try:
        for cand in _netease_candidates(title, artist, limit=AUTO_TRANSLATION_MAX_CANDIDATES)[
            :AUTO_TRANSLATION_MAX_CANDIDATES
        ]:
            if time.monotonic() > deadline:
                break
            lrc, tlyric = _netease_lyric(cand["id"])
            if not lrc or not tlyric:
                continue
            matched = _match_translation_lines(manual_lines, lrc, tlyric)
            if matched:
                return _build_translation_lrc(matched)
        return None
    except (httpx.HTTPError, OSError, ValueError, KeyError):
        return None


def auto_attach_translation(title: str, artist: str, text: str, fmt: str = "lrc") -> str | None:
    """自动为手动指定歌词补网易云中文翻译（行级文本匹配，不依赖时间戳对齐）

    输入: 歌名/歌手（均空则跳过）、手动歌词原文（LRC 或 SRT 可解析格式）
    流程: 网易云搜索候选 → 逐个取歌词，找第一个带翻译的 → 手动行与网易云原文行逐行
          文本匹配（清洗后相同/包含/编辑距离）→ 匹配行取网易云同时间戳 tlyric
          → 生成 LRC（时间戳用手动歌词行的时间戳，供 merge_translation 对齐）
    成功: 返回 tlyric LRC 字符串（仅含匹配到翻译的行）；失败/超时/无匹配: 返回 None（静默）
    """
    title = (title or "").strip()
    artist = (artist or "").strip()
    if not title and not artist:
        return None
    if not (text or "").strip():
        return None
    result: list[str | None] = []

    def _run():
        result.append(_auto_attach_translation_inner(title, artist, text, fmt))

    # 后台线程执行，join 限时：整体不超过 AUTO_TRANSLATION_TIMEOUT（超时返回 None，不阻塞保存）
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(AUTO_TRANSLATION_TIMEOUT)
    return result[0] if result else None


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
