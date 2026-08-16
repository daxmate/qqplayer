"""标签刮削与写入路由（tag_scraper + tag_editor）。"""

from pathlib import Path

from fastapi import APIRouter, HTTPException

import tag_editor
import tag_scraper
from app.services import tags

router = APIRouter()


@router.post("/api/tags/scrape")
def api_tags_scrape(body: dict):
    """多源刮削候选：网易云 + MusicBrainz；封面 fallback 链在返回前补好"""
    f = Path(str(body.get("path") or ""))
    if not f.is_file():
        raise HTTPException(404, "文件不存在")
    artist, title, _album = tags.extract_tags(f)
    query = title or f.stem
    result = tag_scraper.scrape(query, artist or "")
    return {"query": query, **result}


@router.post("/api/tags")
def api_tags_save(body: dict):
    """写标签（原子写）+ 统一改名 + 引用迁移"""
    path = str(body.get("path") or "")
    title = str(body.get("title") or "").strip()
    artist = str(body.get("artist") or "").strip()
    album = str(body.get("album") or "").strip()
    cover_url = str(body.get("cover_url") or "") or None
    f = Path(path)
    if not path or not f.is_file():
        raise HTTPException(404, "文件不存在")
    if not (title or artist or album):
        raise HTTPException(400, "title/artist/album 至少一个非空")
    try:
        result = tag_editor.save_tags(
            f,
            title=title,
            artist=artist,
            album=album,
            cover_url=cover_url,
            migrate=tags._migrate_path_refs,
        )
    except tag_editor.UnsupportedFormatError as e:
        raise HTTPException(400, str(e)) from None
    except Exception as e:
        raise HTTPException(409, f"写标签失败: {e}") from None
    return result
