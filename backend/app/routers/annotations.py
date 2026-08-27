"""阅读器 V2 标注路由：按书分组的高亮 / 书签 / 笔记 + 书内搜索（SQLite kv_store[annotations] 持久化）。

存储结构（db.annotations_load/save）：
{
  "<bookId>": {
    "highlights": [{"id": "hl_<hex>", "cfi": "...", "text": "...", "color": "yellow",
                    "style": "highlight", "createdAt": 1710000000000}],
    "bookmarks":  [{"id": "bm_<hex>", "cfi": "...", "text": "...", "createdAt": 1710000000000}],
    "notes":      [{"id": "nt_<hex>", "cfi": "...", "excerpt": "...", "text": "...",
                    "createdAt": 1710000000000, "updatedAt": 1710000000000}]
  }
}

契约（docs/reader-v2/01-contract-backend-core.md）：所有写操作 bookId 不存在于 books_store
时返回 404 {"detail": "book not found"}；id 前缀 hl_/bm_/nt_ + uuid4().hex。
V4（docs/reader-v2/05-contract-highlight-menu-v4.md）：高亮五色 + 下划线 style；书内搜索
GET /api/books/{bid}/search（index.json 句子级匹配 + 句子起始 CFI，可被 epub.js display 定位）。
"""

import json
import posixpath
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response

from app import db, state
from app.services.book_import import _find_rootfile, _local, _resolve, _split_sentences

router = APIRouter()

# 高亮颜色白名单（V4 契约：iBooks 五色 + underline 固定 red；非法值回落 yellow）
_HIGHLIGHT_COLORS = {"yellow", "green", "blue", "pink", "purple", "red"}
# 高亮形态（V4：高亮 / 下划线；缺省或非法回落 highlight）
_HIGHLIGHT_STYLES = {"highlight", "underline"}


def _fresh_book() -> dict:
    """空标注分组（每次新建独立对象，避免多书共享同一 list）"""
    return {"highlights": [], "bookmarks": [], "notes": []}


def _require_book(bid: str) -> None:
    """写操作前置校验：书不在书架 → 404（契约指定 detail）"""
    if not any(b.get("id") == bid for b in db.books_load()):
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
    data = db.annotations_load()
    return data, data.setdefault(bid, _fresh_book())


# ============ 读取 ============
@router.get("/api/books/{bid}/annotations")
def api_annotations_get(bid: str):
    """该书完整标注对象；无任何标注返回空结构（对未知书宽容，契约只要求写操作 404）。

    V4：旧数据（无 style 字段的高亮）响应时规范化补 "style": "highlight"（不写回磁盘）。
    """
    data = db.annotations_load()
    book = data.get(bid)
    if book is None:
        return _fresh_book()
    out = _fresh_book()
    for h in book.get("highlights", []):
        item = dict(h)
        item.setdefault("style", "highlight")
        out["highlights"].append(item)
    out["bookmarks"] = [dict(m) for m in book.get("bookmarks", [])]
    out["notes"] = [dict(n) for n in book.get("notes", [])]
    return out


# ============ 高亮 ============
@router.put("/api/books/{bid}/annotations/highlights")
def api_highlight_create(bid: str, body: dict):
    """创建高亮：body {cfi, text, color, style?} → {"id": "hl_..."}

    color 非法回落 yellow；style 缺省/非法回落 "highlight"（V4 契约）。
    """
    _require_book(bid)
    body = body or {}
    cfi = _norm_cfi(body.get("cfi"))
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(400, "text 不能为空")
    color = body.get("color")
    if not isinstance(color, str) or color not in _HIGHLIGHT_COLORS:
        color = "yellow"
    style = body.get("style")
    if not isinstance(style, str) or style not in _HIGHLIGHT_STYLES:
        style = "highlight"
    data, book = _load_book(bid)
    item = {
        "id": f"hl_{uuid.uuid4().hex}",
        "cfi": cfi,
        "text": text,
        "color": color,
        "style": style,
        "createdAt": _now(),
    }
    book["highlights"].append(item)
    db.annotations_save(data)
    return {"id": item["id"]}


@router.delete("/api/books/{bid}/annotations/highlights/{hid}")
def api_highlight_delete(bid: str, hid: str):
    """删除高亮 → 204；书/高亮不存在 → 404"""
    _require_book(bid)
    data = db.annotations_load()
    book = data.get(bid)
    if book is None:
        raise HTTPException(404, "book not found")
    highlights = book.get("highlights", [])
    book["highlights"] = [h for h in highlights if h.get("id") != hid]
    if len(book["highlights"]) == len(highlights):
        raise HTTPException(404, "highlight not found")
    db.annotations_save(data)
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
    db.annotations_save(data)
    return {"id": item["id"]}


@router.delete("/api/books/{bid}/annotations/bookmarks/{bid2}")
def api_bookmark_delete(bid: str, bid2: str):
    """删除书签 → 204；书/书签不存在 → 404（路径参数名 bid2 按契约原文，实为书签 id）"""
    _require_book(bid)
    data = db.annotations_load()
    book = data.get(bid)
    if book is None:
        raise HTTPException(404, "book not found")
    bookmarks = book.get("bookmarks", [])
    book["bookmarks"] = [m for m in bookmarks if m.get("id") != bid2]
    if len(book["bookmarks"]) == len(bookmarks):
        raise HTTPException(404, "bookmark not found")
    db.annotations_save(data)
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
    db.annotations_save(data)
    return {"id": item["id"]}


@router.patch("/api/books/{bid}/annotations/notes/{nid}")
def api_note_update(bid: str, nid: str, body: dict):
    """更新笔记：body {text} → 更新 text + updatedAt，返回更新后笔记"""
    _require_book(bid)
    body = body or {}
    text = body.get("text")
    if not isinstance(text, str):
        raise HTTPException(400, "text 必须是字符串")
    data = db.annotations_load()
    book = data.get(bid)
    note = None
    if book is not None:
        note = next((n for n in book.get("notes", []) if n.get("id") == nid), None)
    if note is None:
        raise HTTPException(404, "note not found")
    note["text"] = text
    note["updatedAt"] = _now()
    db.annotations_save(data)
    return note


@router.delete("/api/books/{bid}/annotations/notes/{nid}")
def api_note_delete(bid: str, nid: str):
    """删除笔记 → 204；书/笔记不存在 → 404"""
    _require_book(bid)
    data = db.annotations_load()
    book = data.get(bid)
    if book is None:
        raise HTTPException(404, "book not found")
    notes = book.get("notes", [])
    book["notes"] = [n for n in notes if n.get("id") != nid]
    if len(book["notes"]) == len(notes):
        raise HTTPException(404, "note not found")
    db.annotations_save(data)
    return Response(status_code=204)


# ============ 书内搜索（V4：iBooks 式「搜索」菜单项配套）============
# 数据源：books/<id>/index.json 的 chapters[]（导入时由 book_import._build_index 生成）；
# cfi 生成：zipfile 重开 book.epub，按 spine 顺序解析 XHTML，用与 _build_index 相同的提纯
# 逻辑（_doc_text 等价：去 head/script/style 文本、压缩空白、_split_sentences 分句）把命中
# 句子映射回原文文本节点，按 epub.js 的 CFI 编码（偶数=元素步 (idx+1)*2、奇数=文本步 1+2*idx、
# 终止 :offset）生成句子起始 CFI —— 与 app 内真实高亮/进度 CFI（如 epubcfi(/6/16!/4/4/1:0)）
# 同构，可被 epub.js rendition.display(cfi) 定位。

_SEARCH_RESULT_LIMIT = 100
_SEARCH_MAX_QUERY_LEN = 100
# 与 book_import._doc_text 一致的正文剔除标签（文本/子树剔除，tail 保留）
_SKIP_TEXT_TAGS = {"head", "script", "style"}


def _book_dir(bid: str) -> Path:
    return state.BOOKS_DIR / bid


def _spine_map(zf: zipfile.ZipFile) -> tuple[dict, int, str]:
    """OPF spine 解析 → (zip 内绝对路径 → (spine 序号, itemref id), base 首步, OPF 目录)。

    与 book_import._build_index 同序（文档顺序 itemref）；序号为 epub.js 的 spinePos
    （itemref 数组下标，含 non-linear）。base 首步 = (spine 元素在 package 子元素中的
    序号 + 1) * 2（epub.js generateChapterComponent，标准 OPF 为 6）。
    """
    opf_path = _find_rootfile(zf)
    root = ET.fromstring(zf.read(opf_path))
    base = posixpath.dirname(opf_path)
    children = [el for el in list(root) if isinstance(el.tag, str)]
    try:
        spine_idx = next(i for i, el in enumerate(children) if _local(el.tag) == "spine")
    except StopIteration:
        spine_idx = 2  # 畸形 OPF 兜底（正常 EPUB 必有 spine，metadata/manifest/spine 为 2）
    base_step = (spine_idx + 1) * 2
    items = {el.get("id"): el for el in root.iter() if _local(el.tag) == "item"}
    mapping: dict[str, tuple[int, str | None]] = {}
    order = 0
    for el in root.iter():
        if _local(el.tag) != "itemref":
            continue
        item = items.get(el.get("idref"))
        if item is None:
            continue
        path = _resolve(base, item.get("href") or "")
        if not path:
            continue
        mapping[path] = (order, el.get("id"))
        order += 1
    return mapping, base_step, base


def _collect_segments(body: ET.Element) -> list[dict]:
    """按文档顺序收集正文文本节点（与 book_import._doc_text 提纯一致）。

    返回 [{path, text_idx, raw}]（含纯空白段，不剔除）：
    - path：body → 文本节点所属元素 的子元素序号链（0 基，element children 计数）
    - text_idx：文本节点在其所属元素直接文本子节点中的序号（epub.js textNodes 同序：
      el.text + 各子元素 tail，纯空白节点也占序号）
    - raw：原始文本（相邻节点无空白时拼接不插空格，与 _doc_text 的整串 split 语义一致）
    """
    segs: list[dict] = []

    def children(el: ET.Element) -> list[ET.Element]:
        return [c for c in list(el) if isinstance(c.tag, str)]

    def visit(el: ET.Element, path: list[int]) -> None:
        kids = children(el)
        ti = 0

        def next_text_idx() -> int:
            # 浏览器 DOM 语义：el.text 缺失（None）时没有文本节点，不占序号；
            # 现有文本节点（el.text + 各子元素 tail）按序从 0 计数
            nonlocal ti
            idx = ti
            ti += 1
            return idx

        if el.text is not None:
            segs.append({"path": path, "text_idx": next_text_idx(), "raw": el.text})
        for i, child in enumerate(kids):
            if _local(child.tag) not in _SKIP_TEXT_TAGS:
                visit(child, path + [i])
            # 被剔除元素的 tail 仍属于父元素（_doc_text 同语义），照常收录
            if child.tail is not None:
                segs.append({"path": path, "text_idx": next_text_idx(), "raw": child.tail})

    visit(body, [])
    return segs


def _build_text_map(segs: list[dict]) -> tuple[str, list[dict]]:
    """重建提纯全文（与 book_import._doc_text 的 " ".join(raw.split()) 完全一致）→
    (full, tokens)。tokens：原始拼接文本中的非空白 token，含 {start, len, pure_start}。

    关键：token 按原始拼接文本切分（相邻文本节点无空白时属同一 token，如
    "love<i>Magic</i>" → "loveMagic"），提纯后 token 间以单个空格连接。
    """
    raw_whole = "".join(s["raw"] for s in segs)
    tokens: list[dict] = []
    pure_pos = 0
    i = 0
    n = len(raw_whole)
    while i < n:
        while i < n and raw_whole[i].isspace():
            i += 1
        if i >= n:
            break
        start = i
        while i < n and not raw_whole[i].isspace():
            i += 1
        tokens.append({"start": start, "len": i - start, "pure_start": pure_pos})
        pure_pos += (i - start) + 1
    full = " ".join(raw_whole[i["start"] : i["start"] + i["len"]] for i in tokens)
    return full, tokens


def _map_offset(
    segs: list[dict], tokens: list[dict], pure_off: int, start: int = 0
) -> tuple[dict, int]:
    """提纯全文偏移 → (所属文本段, 段内原始字符偏移)。

    从 start 起找包含 pure_off 的 token（句子起始必为 token 起点，但支持命中 token 内部），
    再按 token 的原始跨度定位到所属文本段。调用方保证 pure_off 随句子顺序递增。
    """
    raw_off = 0
    for j in range(start, len(tokens)):
        tok = tokens[j]
        if pure_off < tok["pure_start"] + tok["len"]:
            raw_off = tok["start"] + (pure_off - tok["pure_start"])
            break
    else:
        last = tokens[-1]
        raw_off = last["start"] + last["len"]
    acc = 0
    for seg in segs:
        if raw_off < acc + len(seg["raw"]):
            return seg, raw_off - acc
        acc += len(seg["raw"])
    return segs[-1], len(segs[-1]["raw"])


def _body_step(root: ET.Element, body: ET.Element) -> int:
    """CFI 路径首步：body 在根元素（html）element children 中的序号 → (idx+1)*2（epub.js 约定）。"""
    children = [c for c in list(root) if isinstance(c.tag, str)]
    try:
        idx = children.index(body)
    except ValueError:
        idx = 0
    return (idx + 1) * 2


def _chapter_sentence_cfis(
    zf: zipfile.ZipFile,
    path: str,
    mapping: dict,
    base_step: int,
    sentences: list[str],
) -> list[str]:
    """章节每条句子的起始 CFI（与 index.json 的 chapters[i].sentences 同序）。

    提纯逻辑与 book_import._doc_text 等价：先重建整章提纯全文（并记录文本节点映射），
    再逐句 find 定位起始偏移 → 映射回文本节点 → epub.js CFI 编码。句子未能定位时
    返回空串（结果仍返回，cfi 留空，不阻断搜索）。
    """
    tree = ET.fromstring(zf.read(path))
    root = tree
    body = next((el for el in root.iter() if _local(el.tag) == "body"), None)
    if body is None:
        return [""] * len(sentences)
    segs = _collect_segments(body)
    full, tokens = _build_text_map(segs)
    # 一致性自检：重算分句必须与 index.json 的句子完全一致（同提纯逻辑），不一致说明
    # epub 已与索引不同步，此时 cfi 不可信 → 整章留空，不阻断搜索
    if _split_sentences(full) != sentences:
        return [""] * len(sentences)
    spine_pos, spine_id = mapping.get(path, (None, None))
    if spine_pos is None:
        return [""] * len(sentences)
    body_step = _body_step(root, body)
    id_part = f"[{spine_id}]" if spine_id else ""
    cfis: list[str] = []
    search_pos = 0
    tok_i = 0
    for s in sentences:
        idx = full.find(s, search_pos)
        if idx < 0:
            cfis.append("")
            continue
        search_pos = idx + len(s)
        while tok_i < len(tokens) - 1 and tokens[tok_i]["pure_start"] + tokens[tok_i]["len"] <= idx:
            tok_i += 1
        seg, raw_off = _map_offset(segs, tokens, idx, tok_i)
        elem_steps = "".join(f"/{(i + 1) * 2}" for i in seg["path"])
        text_step = 1 + 2 * seg["text_idx"]
        cfis.append(
            f"epubcfi(/{base_step}/{(spine_pos + 1) * 2}{id_part}!/{body_step}{elem_steps}/{text_step}:{raw_off})"
        )
    return cfis


@router.get("/api/books/{bid}/search")
def api_book_search(bid: str, q: str = ""):
    """书内搜索：index.json 句子级大小写不敏感子串匹配，返回句子起始 CFI。

    - q 为空/空白或长度 > 100 → 400 {"detail": "invalid query"}
    - 全部命中不分页，上限 100 条截断
    - 书目录无 index.json / 书不在书架 → 空 results（不报错，宽容语义同 annotations GET）
    - 响应：{"query", "results": [{href, chapterTitle, sentence, cfi, matchStart, matchEnd}]}
    """
    if not isinstance(q, str) or not q.strip() or len(q) > _SEARCH_MAX_QUERY_LEN:
        raise HTTPException(400, "invalid query")
    q = q.strip()
    index_path = _book_dir(bid) / "index.json"
    if not index_path.exists():
        return {"query": q, "results": []}
    try:
        index = json.loads(index_path.read_text("utf-8"))
    except (OSError, ValueError):
        return {"query": q, "results": []}
    ql = q.lower()
    # hits: (章节, 句子在章节内的序号, 句子, matchStart, matchEnd) —— 序号随枚举记录，
    # 同章重复句子（如 "The quick fox jumps." ×N）也能映射到各自出现位置
    hits: list[tuple[dict, int, str, int, int]] = []
    for ch in index.get("chapters") or []:
        sents = ch.get("sentences") or []
        for i, s in enumerate(sents):
            if not s:
                continue
            pos = s.lower().find(ql)
            if pos >= 0:
                hits.append((ch, i, s, pos, pos + len(q)))
    if not hits:
        return {"query": q, "results": []}
    # 分组按章生成 cfi（每章只解析一次 XHTML），前 100 条命中截断
    epub_path = _book_dir(bid) / "book.epub"
    results: list[dict] = []
    try:
        zf = zipfile.ZipFile(epub_path)
    except (zipfile.BadZipFile, OSError):
        zf = None
    if zf is not None:
        with zf:
            mapping, base_step, base = _spine_map(zf)
            chapter_cfis: dict[str, list[str]] = {}
            for ch, i, s, st, en in hits[:_SEARCH_RESULT_LIMIT]:
                href = ch.get("href", "")
                key = _resolve(base, href)
                if key not in chapter_cfis:
                    try:
                        chapter_cfis[key] = _chapter_sentence_cfis(
                            zf, key, mapping, base_step, ch.get("sentences") or []
                        )
                    except (ET.ParseError, KeyError, OSError):
                        chapter_cfis[key] = [""] * len(ch.get("sentences") or [])
                results.append(
                    {
                        "href": href,
                        "chapterTitle": ch.get("title", ""),
                        "sentence": s,
                        "cfi": chapter_cfis[key][i],
                        "matchStart": st,
                        "matchEnd": en,
                    }
                )
    else:
        for ch, _i, s, st, en in hits[:_SEARCH_RESULT_LIMIT]:
            results.append(
                {
                    "href": ch.get("href", ""),
                    "chapterTitle": ch.get("title", ""),
                    "sentence": s,
                    "cfi": "",
                    "matchStart": st,
                    "matchEnd": en,
                }
            )
    return {"query": q, "results": results}
