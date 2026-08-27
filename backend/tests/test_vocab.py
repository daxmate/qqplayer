"""阅读器 V2 生词本 API 测试：创建 / 列表倒序 / 删除 / 404 / 导出（vocab.json 隔离）

契约：docs/reader-v2/01-contract-backend-core.md 第三节。
运行：cd ~/codes/qqplayerA && ~/codes/qqplayer/venv/bin/python -m pytest tests/test_vocab.py -q
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import db, state  # noqa: E402

client = TestClient(backend.app)


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """生词本存储隔离：写临时目录，不碰真实用户数据"""
    monkeypatch.setattr(state, "VOCAB_FILE", tmp_path / "vocab.json")


def _add(word="hello", **extra):
    """POST /api/vocab（缺省字段自动补空串）"""
    return client.post("/api/vocab", json={"word": word, **extra})


def _set_added_at(seconds_by_word: dict) -> None:
    """直接改磁盘数据设定 addedAt（保证排序断言确定，不依赖真实时钟）"""
    items = db.vocab_load()
    for it in items:
        it["addedAt"] = seconds_by_word[it["word"]]
    db.vocab_save(items)


# ============ 创建 ============
def test_create_returns_id_with_full_fields():
    """创建：id 前缀 vw_，word/context/bookId/bookTitle/cfi/addedAt 完整存储"""
    r = _add("hello", context="Hello world.", bookId="b1", bookTitle="测试书", cfi="epubcfi(/6/4)")
    assert r.status_code == 200
    vid = r.json()["id"]
    assert vid.startswith("vw_")
    items = client.get("/api/vocab").json()
    assert len(items) == 1
    it = items[0]
    assert it["id"] == vid
    assert it["word"] == "hello"
    assert it["context"] == "Hello world."
    assert it["bookId"] == "b1"
    assert it["bookTitle"] == "测试书"
    assert it["cfi"] == "epubcfi(/6/4)"
    assert isinstance(it["addedAt"], int)


def test_create_word_required():
    """word 必填非空：缺失/空串/纯空白/非字符串 → 400"""
    assert client.post("/api/vocab", json={}).status_code == 400
    assert _add("").status_code == 400
    assert _add("   ").status_code == 400
    assert _add(123).status_code == 400


def test_create_optional_fields_default_empty():
    """context/bookId/bookTitle/cfi 允许空串/缺省，非法类型回落空串"""
    vid = _add("world").json()["id"]
    it = next(x for x in client.get("/api/vocab").json() if x["id"] == vid)
    assert it["context"] == ""
    assert it["bookId"] == ""
    assert it["bookTitle"] == ""
    assert it["cfi"] == ""
    # 非法类型（数字）回落空串
    vid2 = _add("weird", context=123, bookTitle=None).json()["id"]
    it2 = next(x for x in client.get("/api/vocab").json() if x["id"] == vid2)
    assert it2["context"] == "" and it2["bookTitle"] == ""


# ============ 列表 ============
def test_list_desc_by_added_at():
    """列表按 addedAt 倒序（最新在前）"""
    ids = [_add("a").json()["id"], _add("b").json()["id"], _add("c").json()["id"]]
    _set_added_at({"a": 0, "b": 1000, "c": 2000})
    got = [x["id"] for x in client.get("/api/vocab").json()]
    assert got == [ids[2], ids[1], ids[0]]


def test_list_empty():
    """空词表 → []"""
    assert client.get("/api/vocab").json() == []


# ============ 删除 ============
def test_delete_then_404():
    """删除 → 204；再删同一 id → 404"""
    vid = _add("x").json()["id"]
    assert client.delete(f"/api/vocab/{vid}").status_code == 204
    assert client.get("/api/vocab").json() == []
    assert client.delete(f"/api/vocab/{vid}").status_code == 404


def test_delete_unknown_404():
    """删除不存在的 id → 404"""
    assert client.delete("/api/vocab/vw_nope").status_code == 404


# ============ 导出 ============
def test_export_empty_file():
    """空词表 → 200 空文件，text/plain + attachment filename=vocab.txt"""
    r = client.get("/api/vocab/export")
    assert r.status_code == 200
    assert r.content == b""
    assert "text/plain" in r.headers["content-type"]
    assert "vocab.txt" in r.headers["content-disposition"]


def test_export_tsv_format():
    """导出格式：每行 word\\tbookTitle\\tcontext（UTF-8），最新在前，末尾换行"""
    _add("hello", bookTitle="测试书", context="Hello world.")
    _add("world", bookTitle="", context="")
    _set_added_at({"hello": 1000, "world": 2000})
    r = client.get("/api/vocab/export")
    assert r.status_code == 200
    assert "text/plain" in r.headers["content-type"]
    assert "vocab.txt" in r.headers["content-disposition"]
    lines = r.content.decode("utf-8").split("\n")
    assert lines[0] == "world\t\t"  # addedAt 最新在前
    assert lines[1] == "hello\t测试书\tHello world."
    assert lines[2] == ""  # 末尾换行
