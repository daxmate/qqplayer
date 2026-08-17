"""阅读器 V2 标注路由：按书分组的高亮 / 书签 / 笔记（annotations.json 持久化）。

存储结构（annotations_store，JsonStore 延迟解析路径）：
{
  "<bookId>": {
    "highlights": [{"id": "hl_<hex>", "cfi": "...", "text": "...", "color": "yellow",
                    "createdAt": 1710000000000}],
    "bookmarks":  [{"id": "bm_<hex>", "cfi": "...", "text": "...", "createdAt": 1710000000000}],
    "notes":      [{"id": "nt_<hex>", "cfi": "...", "excerpt": "...", "text": "...",
                    "createdAt": 1710000000000, "updatedAt": 1710000000000}]
  }
}

契约（docs/reader-v2/01-contract-backend-core.md）：所有写操作 bookId 不存在于 books_store
时返回 404 {"detail": "book not found"}；id 前缀 hl_/bm_/nt_ + uuid4().hex。
"""

import time
import uuid

from fastapi import APIRouter, HTTPException, Response

from app import state

router = APIRouter()

# 高亮颜色白名单（契约指定；非法值回落 yellow）
_HIGHLIGHT_COLORS = {"yellow", "green", "blue", "pink"}


def _fresh_book() -> dict:
    """空标注分组（每次新建独立对象，避免多书共享同一 list）"""
    return {"highlights": [], "bookmarks": [], "notes": []}


def _require_book(bid: str) -> None:
    """写操作前置校验：书不在书架 → 404（契约指定 detail）"""
    if not any(b.get("id") == bid for b in state.books_store.load()):
        raise HTTPException(404, "book not found")


def _norm_cfi(value) -> str:
    """cfi：必须是非空字符串（标注定位锚点）"""
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(400, "cfi 必须是字符串")
    return value


def _norm_optional_str(value) -> str:
    """可选字符串字段：非字符串回落空串"""
    return value if isinstance(value, str) else ""


def _now() -> int:
    return int(time.time() * 1000)


def _load_book(bid: str) -> tuple[dict, dict]:
    """读标注库，返回 (顶层 data, 该书分组)；书无分组时建空结构（未落盘）"""
    data = state.annotations_store.load()
    return data, data.setdefault(bid, _fresh_book())


# ============ 读取 ============
@router.get("/api/books/{bid}/annotations")
def api_annotations_get(bid: str):
    """该书完整标注对象；无任何标注返回空结构（对未知书宽容，契约只要求写操作 404）"""
    data = state.annotations_store.load()
    return data.get(bid, _fresh_book())


# ============ 高亮 ============
@router.put("/api/books/{bid}/annotations/highlights")
def api_highlight_create(bid: str, body: dict):
    """创建高亮：body {cfi, text, color} → {"id": "hl_..."}；color 非法回落 yellow"""
    _require_book(bid)
    body = body or {}
    cfi = _norm_cfi(body.get("cfi"))
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "text 不能为空")
    color = body.get("color")
    if not isinstance(color, str) or color not in _HIGHLIGHT_COLORS:
        color = "yellow"
    data, book = _load_book(bid)
    item = {
        "id": f"hl_{uuid.uuid4().hex}",
        "cfi": cfi,
        "text": text,
        "color": color,
        "createdAt": _now(),
    }
    book["highlights"].append(item)
    state.annotations_store.save(data)
    return {"id": item["id"]}


@router.delete("/api/books/{bid}/annotations/highlights/{hid}")
def api_highlight_delete(bid: str, hid: str):
    """删除高亮 → 204；书/高亮不存在 → 404"""
    _require_book(bid)
    data = state.annotations_store.load()
    book = data.get(bid)
    if book is None:
        raise HTTPException(404, "book not found")
    highlights = book.get("highlights", [])
    book["highlights"] = [h for h in highlights if h.get("id") != hid]
    if len(book["highlights"]) == len(highlights):
        raise HTTPException(404, "highlight not found")
    state.annotations_store.save(data)
    return Response(status_code=204)


# ============ 书签 ============
@router.put("/api/books/{bid}/annotations/bookmarks")
def api_bookmark_create(bid: str, body: dict):
    """创建书签：body {cfi, text} → {"id": "bm_..."}；同 cfi 重复创建允许（前端保证去重）"""
    _require_book(bid)
    body = body or {}
    cfi = _norm_cfi(body.get("cfi"))
    data, book = _load_book(bid)
    item = {
        "id": f"bm_{uuid.uuid4().hex}",
        "cfi": cfi,
        "text": _norm_optional_str(body.get("text")),
        "createdAt": _now(),
    }
    book["bookmarks"].append(item)
    state.annotations_store.save(data)
    return {"id": item["id"]}


@router.delete("/api/books/{bid}/annotations/bookmarks/{bid2}")
def api_bookmark_delete(bid: str, bid2: str):
    """删除书签 → 204；书/书签不存在 → 404（路径参数名 bid2 按契约原文，实为书签 id）"""
    _require_book(bid)
    data = state.annotations_store.load()
    book = data.get(bid)
    if book is None:
        raise HTTPException(404, "book not found")
    bookmarks = book.get("bookmarks", [])
    book["bookmarks"] = [m for m in bookmarks if m.get("id") != bid2]
    if len(book["bookmarks"]) == len(bookmarks):
        raise HTTPException(404, "bookmark not found")
    state.annotations_store.save(data)
    return Response(status_code=204)


# ============ 笔记 ============
@router.put("/api/books/{bid}/annotations/notes")
def api_note_create(bid: str, body: dict):
    """创建笔记：body {cfi, excerpt, text} → {"id": "nt_..."}；text 允许空串（点开只读摘录）"""
    _require_book(bid)
    body = body or {}
    cfi = _norm_cfi(body.get("cfi"))
    data, book = _load_book(bid)
    now = _now()
    item = {
        "id": f"nt_{uuid.uuid4().hex}",
        "cfi": cfi,
        "excerpt": _norm_optional_str(body.get("excerpt")),
        "text": _norm_optional_str(body.get("text")),
        "createdAt": now,
        "updatedAt": now,
    }
    book["notes"].append(item)
    state.annotations_store.save(data)
    return {"id": item["id"]}


@router.patch("/api/books/{bid}/annotations/notes/{nid}")
def api_note_update(bid: str, nid: str, body: dict):
    """更新笔记：body {text} → 更新 text + updatedAt，返回更新后笔记"""
    _require_book(bid)
    body = body or {}
    text = body.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "text 必须是字符串")
    data = state.annotations_store.load()
    book = data.get(bid)
    note = None
    if book is not None:
        note = next((n for n in book.get("notes", []) if n.get("id") == nid), None)
    if note is None:
        raise HTTPException(404, "note not found")
    note["text"] = text
    note["updatedAt"] = _now()
    state.annotations_store.save(data)
    return note


@router.delete("/api/books/{bid}/annotations/notes/{nid}")
def api_note_delete(bid: str, nid: str):
    """删除笔记 → 204；书/笔记不存在 → 404"""
    _require_book(bid)
    data = state.annotations_store.load()
    book = data.get(bid)
    if book is None:
        raise HTTPException(404, "book not found")
    notes = book.get("notes", [])
    book["notes"] = [n for n in notes if n.get("id") != nid]
    if len(book["notes"]) == len(notes):
        raise HTTPException(404, "note not found")
    state.annotations_store.save(data)
    return Response(status_code=204)
