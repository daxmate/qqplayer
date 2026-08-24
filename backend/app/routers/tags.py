"""标签刮削与写入路由（tag_scraper + tag_editor + 批量刮削）。"""

import time
from pathlib import Path

from fastapi import APIRouter, HTTPException

import tag_editor
import tag_scraper
from app.services import settings as settings_service
from app.services import tags
from app.services.library_scan import _full_scan
from tag_scraper import TagScraper

router = APIRouter()

# 批量刮削：每首歌之间防限流 sleep（秒）；单批处理上限（超出取前 N 首，返回 truncated: true）
BATCH_SLEEP_SECONDS = 0.8
BATCH_LIMIT = 100
# paths 模式批量写入字段（保守：不写封面/track/album_artist，避免刮错）
BATCH_WRITABLE_FIELDS = ("title", "artist", "album", "year", "genre")


def _to_int(v) -> int | None:
    """宽松转 int：int/整 float/数字字符串 → int；其他（含 bool）→ None"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v
    if isinstance(v, float) and v.is_integer():
        return int(v)
    if isinstance(v, str) and v.strip().lstrip("-").isdigit():
        return int(v.strip())
    return None


def _batch_sleep():
    """批量刮削每首歌之间的防限流 sleep（测试 monkeypatch 为 no-op）"""
    time.sleep(BATCH_SLEEP_SECONDS)


def _batch_result(f: Path, status: str, reason: str, written: list, candidates: int = 0) -> dict:
    return {
        "path": str(f),
        "status": status,
        "reason": reason,
        "written": written,
        "candidates": candidates,
    }


def _batch_response(enabled: bool, results: list, truncated: bool, total: int = 0) -> dict:
    summary = {
        "total": total,
        "written": sum(1 for r in results if r["status"] == "written"),
        "skipped": sum(1 for r in results if r["status"] == "skipped"),
        "failed": sum(1 for r in results if r["status"] == "failed"),
    }
    return {"enabled": enabled, "truncated": truncated, "results": results, "summary": summary}


def _merge_candidates(scraped: dict, source_order: list) -> list[dict]:
    """按 settings.scraping.source_order 合并两源候选（保序）"""
    out = []
    for src in source_order:
        for cand in scraped.get(src) or []:
            if isinstance(cand, dict):
                out.append(cand)
    return out


def _is_high_confidence(candidates: list[dict], artist: str) -> bool:
    """paths 模式高置信度判定：候选数==1 或 文件无 artist（取首候选）
    或 首候选 artist 与文件 artist 归一化匹配（复用 TagScraper._artist_matches）"""
    if not candidates:
        return False
    if len(candidates) == 1:
        return True
    if not artist:
        return True
    return TagScraper._artist_matches(str(candidates[0].get("artist") or ""), artist)


def _process_batch_file(
    f: Path, library_mode: bool, source_order: list, rename_template: str
) -> dict:
    """单首批量刮削：提取 query/artist → 两源候选 → 按 source_order 合并 → 高置信度 → 写入。

    返回 _batch_result：written/skipped/failed 三态，单文件失败不中断整批。
    paths 模式写 title/artist/album/year/genre（覆盖）；library 模式只补 year/genre。
    """
    try:
        artist, title, _album, _y, _g, _t, _aa = tags.extract_tags(f)
    except Exception:
        artist, title = None, None
    if not f.is_file():
        return _batch_result(f, "skipped", "文件不存在", [])
    query = title or f.stem
    try:
        scraped = tag_scraper.scrape(query, artist or "")
    except Exception:
        scraped = {}
    candidates = _merge_candidates(scraped, source_order)
    if not candidates:
        return _batch_result(f, "skipped", "无候选", [], candidates=0)
    if not library_mode and not _is_high_confidence(candidates, artist or ""):
        return _batch_result(f, "skipped", "候选不唯一", [], candidates=len(candidates))

    first = candidates[0]
    if library_mode:
        # 只补 year/genre（候选有值才写），不碰其他字段
        write = {}
        if first.get("year") is not None:
            write["year"] = _to_int(first["year"])
        if first.get("genre"):
            write["genre"] = str(first["genre"]).strip()
        if not write:
            return _batch_result(f, "skipped", "候选无 year/genre", [], candidates=len(candidates))
    else:
        write = {}
        for k in BATCH_WRITABLE_FIELDS:
            v = first.get(k)
            if v in (None, ""):
                continue
            write[k] = _to_int(v) if k in ("year",) else str(v).strip()
        if not write:
            return _batch_result(f, "skipped", "候选无有效字段", [], candidates=len(candidates))

    try:
        result = tag_editor.save_tags(
            f,
            title=write.get("title", ""),
            artist=write.get("artist", ""),
            album=write.get("album", ""),
            year=write.get("year"),
            genre=write.get("genre", ""),
            rename_template=rename_template,
        )
    except tag_editor.UnsupportedFormatError as e:
        return _batch_result(f, "failed", f"写入失败: {e}", [], candidates=len(candidates))
    except Exception as e:
        return _batch_result(f, "failed", f"写入失败: {e}", [], candidates=len(candidates))
    return _batch_result(
        Path(result["path"]), "written", "", sorted(write), candidates=len(candidates)
    )


@router.post("/api/tags/scrape")
def api_tags_scrape(body: dict):
    """多源刮削候选：网易云 + MusicBrainz；封面 fallback 链在返回前补好"""
    f = Path(str(body.get("path") or ""))
    if not f.is_file():
        raise HTTPException(404, "文件不存在")
    artist, title, _album, _y, _g, _t, _aa = tags.extract_tags(f)
    query = title or f.stem
    result = tag_scraper.scrape(query, artist or "")
    return {"query": query, **result}


@router.post("/api/tags")
def api_tags_save(body: dict):
    """写标签（原子写）+ 按模板改名 + 引用迁移；新增可选 year/genre/track/album_artist"""
    path = str(body.get("path") or "")
    title = str(body.get("title") or "").strip()
    artist = str(body.get("artist") or "").strip()
    album = str(body.get("album") or "").strip()
    genre = str(body.get("genre") or "").strip()
    album_artist = str(body.get("album_artist") or "").strip()
    year = _to_int(body.get("year"))
    track = _to_int(body.get("track"))
    cover_url = str(body.get("cover_url") or "") or None
    f = Path(path)
    if not path or not f.is_file():
        raise HTTPException(404, "文件不存在")
    if not (
        title or artist or album or genre or album_artist or year is not None or track is not None
    ):
        raise HTTPException(400, "title/artist/album/year/genre/track/album_artist 至少一个非空")
    try:
        result = tag_editor.save_tags(
            f,
            title=title,
            artist=artist,
            album=album,
            cover_url=cover_url,
            year=year,
            genre=genre,
            track=track,
            album_artist=album_artist,
            rename_template=settings_service.load_all_settings()["scraping"]["rename_template"],
            migrate=tags._migrate_path_refs,
        )
    except tag_editor.UnsupportedFormatError as e:
        raise HTTPException(400, str(e)) from None
    except Exception as e:
        raise HTTPException(409, f"写标签失败: {e}") from None
    return result


@router.post("/api/tags/scrape-batch")
def api_tags_scrape_batch(body: dict):
    """批量刮削：多选 paths 模式 + 一键 library 模式。

    - {"paths": ["/abs/path.mp3", ...]}：对指定文件刮削，高置信度自动写入
      title/artist/album/year/genre（覆盖现有值；不写封面/track/album_artist）
    - {"mode": "library"}：整库只处理 year 为空 或 genre 为空 的歌曲，只补 year/genre
    - settings.scraping.batch_enabled 关闭 → {"enabled": false, ...}（HTTP 200，前端据此提示）
    - 单批最多 100 首（超出取前 100，返回 truncated: true）；每首歌之间 sleep 0.8s 防限流
    """
    body = body or {}
    scraping_settings = settings_service.load_all_settings()["scraping"]
    if not scraping_settings["batch_enabled"]:
        return _batch_response(False, [], truncated=False, total=0)

    paths = body.get("paths")
    if body.get("mode") == "library":
        songs = _full_scan()
        files = [Path(s["path"]) for s in songs if not s.get("year") or not s.get("genre")]
        library_mode = True
    elif isinstance(paths, list) and paths:
        files = [Path(p) for p in paths if isinstance(p, str) and p.strip()]
        library_mode = False
    else:
        raise HTTPException(400, "body 必须传 paths 数组或 mode=library")

    truncated = len(files) > BATCH_LIMIT
    files = files[:BATCH_LIMIT]
    source_order = scraping_settings["source_order"]
    rename_template = scraping_settings["rename_template"]

    results = []
    for i, f in enumerate(files):
        if i > 0:
            _batch_sleep()
        results.append(_process_batch_file(f, library_mode, source_order, rename_template))
    return _batch_response(True, results, truncated=truncated, total=len(files))
