"""电子书（EPUB）书架路由：导入 / 列表 / 文件 / 封面 / 进度 / 删除。

磁盘布局：books/<id>/ 下 book.epub + cover.jpg|png + index.json
书架元数据：DATA_DIR/books.json（books_store，JsonStore 延迟解析路径）
"""

import json
import shutil
import time
import uuid
from pathlib import Path
from typing import Annotated

import send2trash
from fastapi import APIRouter, File, HTTPException, Response, UploadFile
from fastapi.responses import FileResponse

from app import state
from app.services.book_import import BadEpubError, parse_epub

router = APIRouter()


def _find_book(books: list[dict], bid: str) -> dict | None:
    for b in books:
        if b.get("id") == bid:
            return b
    return None


def _book_dir(bid: str) -> Path:
    return state.BOOKS_DIR / bid


# ============ 书架 ============
@router.get("/api/books")
def api_books():
    """书架全部书籍（按 addedAt 倒序）"""
    books = state.books_store.load()
    return sorted(books, key=lambda b: b.get("addedAt", 0), reverse=True)


@router.post("/api/books/import")
async def api_books_import(file: Annotated[UploadFile, File()]):
    """导入 EPUB：解析元数据/封面/句子索引 → 落盘 books/<id>/，登记书架

    坏文件/非 EPUB → 400（目录清理，不留残留）；超大小上限 → 400。
    """
    raw = (file.filename or "").strip()
    if not raw.lower().endswith(".epub"):
        raise HTTPException(400, "仅支持 .epub 文件")
    bid = uuid.uuid4().hex
    dest = _book_dir(bid)
    try:
        state.BOOKS_DIR.mkdir(parents=True, exist_ok=True)
        dest.mkdir(parents=True, exist_ok=True)
        epub_path = dest / "book.epub"
        written = 0
        with epub_path.open("wb") as out:
            while True:  # 大文件流式写入，不一次性进内存
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                written += len(chunk)
                if written > state.IMPORT_MAX_BYTES:
                    raise HTTPException(400, f"超过单文件 {state.IMPORT_MAX_BYTES} 字节上限")
                out.write(chunk)
        meta = parse_epub(epub_path, name_hint=raw)
    except BadEpubError as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(400, str(e)) from None
    except HTTPException:
        shutil.rmtree(dest, ignore_errors=True)
        raise
    except OSError as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(500, f"写入失败: {e}") from None
    try:
        if meta["cover"]:
            (dest / f"cover.{meta['cover_ext']}").write_bytes(meta["cover"])
        (dest / "index.json").write_text(json.dumps(meta["index"], ensure_ascii=False), "utf-8")
    except OSError as e:
        shutil.rmtree(dest, ignore_errors=True)
        raise HTTPException(500, f"写入失败: {e}") from None
    book = {
        "id": bid,
        "title": meta["title"],
        "author": meta["author"],
        "addedAt": int(time.time() * 1000),
        "progress": None,
    }
    books = state.books_store.load()
    books.append(book)
    state.books_store.save(books)
    return book


@router.get("/api/books/{bid}/file")
def api_books_file(bid: str):
    """EPUB 原文件（epub.js 加载用）"""
    if _find_book(state.books_store.load(), bid) is None:
        raise HTTPException(404, "书籍不存在")
    p = _book_dir(bid) / "book.epub"
    if not p.exists():
        raise HTTPException(404, "书籍文件不存在")
    return FileResponse(p, media_type="application/epub+zip")


@router.get("/api/books/{bid}/cover")
def api_books_cover(bid: str):
    """封面图片（无封面返回 404）"""
    if _find_book(state.books_store.load(), bid) is None:
        raise HTTPException(404, "书籍不存在")
    d = _book_dir(bid)
    for ext in ("jpg", "png"):
        p = d / f"cover.{ext}"
        if p.exists():
            return FileResponse(p)
    raise HTTPException(404, "封面不存在")


# ============ 阅读进度 ============
@router.get("/api/books/{bid}/progress")
def api_books_progress_get(bid: str):
    """阅读进度 {cfi, location?, updatedAt}，未读返回 null"""
    b = _find_book(state.books_store.load(), bid)
    if b is None:
        raise HTTPException(404, "书籍不存在")
    return b.get("progress")


@router.put("/api/books/{bid}/progress")
def api_books_progress_put(bid: str, body: dict):
    """保存阅读进度：body {cfi: str, location?: number, updatedAt: int}"""
    cfi = body.get("cfi")
    if not isinstance(cfi, str) or not cfi.strip():
        raise HTTPException(400, "cfi 必须是字符串")
    updated_at = body.get("updatedAt")
    if not isinstance(updated_at, int):
        raise HTTPException(400, "updatedAt 必须是整数时间戳")
    location = body.get("location")
    if location is not None and not isinstance(location, (int, float)):
        raise HTTPException(400, "location 必须是数字")
    books = state.books_store.load()
    b = _find_book(books, bid)
    if b is None:
        raise HTTPException(404, "书籍不存在")
    progress = {"cfi": cfi, "updatedAt": updated_at}
    if location is not None:
        progress["location"] = location
    b["progress"] = progress
    state.books_store.save(books)
    return progress


@router.delete("/api/books/{bid}")
def api_books_delete(bid: str):
    """删除书籍：send2trash 移废纸篓 books/<id>/ + 书架移除 → 204

    与曲库删除一致：书架元数据先移除；send2trash 失败不阻断（文件留原地）。
    """
    books = state.books_store.load()
    if _find_book(books, bid) is None:
        raise HTTPException(404, "书籍不存在")
    state.books_store.save([b for b in books if b.get("id") != bid])
    d = _book_dir(bid)
    try:
        if d.exists():
            send2trash.send2trash(str(d))
    except Exception:
        pass
    return Response(status_code=204)
