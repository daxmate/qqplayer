"""阅读器 V2 生词本路由：全局跨书生词（vocab.json 持久化）。

存储结构（vocab_store，JsonStore 延迟解析路径）：
[{"id": "vw_<hex>", "word": "hello", "context": "原句上下文（书里选中时的句子）",
  "bookId": "", "bookTitle": "", "cfi": "", "addedAt": 1710000000000}]

契约（docs/reader-v2/01-contract-backend-core.md）：列表按 addedAt 倒序；
导出 text/plain 每行 word\\tbookTitle\\tcontext（UTF-8，attachment filename=vocab.txt）。
"""

import time
import uuid

from fastapi import APIRouter, HTTPException, Response

from app import state

router = APIRouter()

# 导出字段白名单（与存储结构一致，TSV 每行 word/title/context）
_EXPORT_FIELDS = ("word", "bookTitle", "context")


def _load_sorted() -> list[dict]:
    """全部生词，按 addedAt 倒序（最新在前）"""
    items = state.vocab_store.load()
    return sorted(items, key=lambda it: it.get("addedAt", 0), reverse=True)


def _opt_str(value) -> str:
    """可选字符串字段：非字符串回落空串"""
    return value if isinstance(value, str) else ""


@router.get("/api/vocab")
def api_vocab_list():
    """生词列表（addedAt 倒序，最新在前）"""
    return _load_sorted()


@router.post("/api/vocab")
def api_vocab_create(body: dict):
    """添加生词：body {word, context, bookId, bookTitle, cfi} → {"id": "vw_..."}；word 必填非空"""
    body = body or {}
    word = body.get("word")
    if not isinstance(word, str) or not word.strip():
        raise HTTPException(400, "word 不能为空")
    item = {
        "id": f"vw_{uuid.uuid4().hex}",
        "word": word,
        "context": _opt_str(body.get("context")),
        "bookId": _opt_str(body.get("bookId")),
        "bookTitle": _opt_str(body.get("bookTitle")),
        "cfi": _opt_str(body.get("cfi")),
        "addedAt": int(time.time() * 1000),
    }
    items = state.vocab_store.load()
    items.append(item)
    state.vocab_store.save(items)
    return {"id": item["id"]}


@router.delete("/api/vocab/{vid}")
def api_vocab_delete(vid: str):
    """删除生词 → 204；不存在 → 404"""
    items = state.vocab_store.load()
    before = len(items)
    items = [it for it in items if it.get("id") != vid]
    if len(items) == before:
        raise HTTPException(404, "word not found")
    state.vocab_store.save(items)
    return Response(status_code=204)


@router.get("/api/vocab/export")
def api_vocab_export():
    """导出生词表：text/plain，每行 word\\tbookTitle\\tcontext（tab 分隔，UTF-8）

    字段内 \t/\n 替换为空格保证 TSV 格式合法；空词表返回 200 空文件。
    """
    lines = []
    for it in _load_sorted():
        fields = [str(it.get(f, "")).replace("\t", " ").replace("\n", " ") for f in _EXPORT_FIELDS]
        lines.append("\t".join(fields))
    payload = "\n".join(lines) + ("\n" if lines else "")
    return Response(
        content=payload.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="vocab.txt"'},
    )
