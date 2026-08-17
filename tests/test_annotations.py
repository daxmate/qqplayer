"""阅读器 V2 标注 API 测试：高亮 / 书签 / 笔记（annotations.json 隔离，不碰真实数据）

契约：docs/reader-v2/01-contract-backend-core.md 第二节。
运行：cd ~/codes/qqplayerA && ~/codes/qqplayer/venv/bin/python -m pytest tests/test_annotations.py -q
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402

client = TestClient(backend.app)

# 书架预置一本书：b1（写操作校验依赖 books_store）
BID = "b1"
H = f"/api/books/{BID}/annotations"


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """标注存储/书架元数据隔离：全部走临时目录"""
    monkeypatch.setattr(state, "ANNOTATIONS_FILE", tmp_path / "annotations.json")
    monkeypatch.setattr(state, "BOOKS_FILE", tmp_path / "books.json")
    state.books_store.save(
        [
            {"id": "b1", "title": "测试书一", "addedAt": 1, "progress": None},
            {"id": "b2", "title": "测试书二", "addedAt": 2, "progress": None},
        ]
    )


# ============ 读取 ============
def test_get_empty():
    """无标注的书 → 空结构 {"highlights":[],"bookmarks":[],"notes":[]}"""
    r = client.get(H)
    assert r.status_code == 200
    assert r.json() == {"highlights": [], "bookmarks": [], "notes": []}


def test_get_unknown_book_lenient():
    """书架不存在的书：GET 宽容返回空结构（契约只要求写操作 404）"""
    r = client.get("/api/books/nope/annotations")
    assert r.status_code == 200
    assert r.json() == {"highlights": [], "bookmarks": [], "notes": []}


# ============ 高亮 ============
def test_highlight_create_and_list():
    """创建高亮：id 前缀 hl_，cfi/text/color/createdAt 完整返回"""
    r = client.put(
        f"{H}/highlights", json={"cfi": "epubcfi(/6/4)", "text": "hello world", "color": "pink"}
    )
    assert r.status_code == 200
    hid = r.json()["id"]
    assert hid.startswith("hl_")
    book = client.get(H).json()
    hl = book["highlights"][0]
    assert hl["id"] == hid
    assert hl["cfi"] == "epubcfi(/6/4)"
    assert hl["text"] == "hello world"
    assert hl["color"] == "pink"
    assert isinstance(hl["createdAt"], int)
    assert book["bookmarks"] == [] and book["notes"] == []


def test_highlight_invalid_color_falls_back_yellow():
    """color 非法（枚举外/类型非法/缺省）回落 yellow"""
    for bad in ("red", 123, None, ["yellow"]):
        r = client.put(f"{H}/highlights", json={"cfi": "c", "text": "x", "color": bad})
        assert r.status_code == 200, f"color={bad!r}"
        assert r.json()["id"]
    assert all(h["color"] == "yellow" for h in client.get(H).json()["highlights"])


def test_highlight_text_required():
    """text 缺失/空/非字符串 → 400"""
    for bad in ("", "  ", None, 123):
        r = client.put(f"{H}/highlights", json={"cfi": "c", "text": bad})
        assert r.status_code == 400, f"text={bad!r}"


def test_highlight_cfi_required():
    """cfi 缺失/空 → 400"""
    assert client.put(f"{H}/highlights", json={"text": "x"}).status_code == 400
    assert client.put(f"{H}/highlights", json={"cfi": "", "text": "x"}).status_code == 400


def test_highlight_delete():
    """删除高亮 → 204；再删同一 id → 404"""
    hid = client.put(f"{H}/highlights", json={"cfi": "c", "text": "x"}).json()["id"]
    assert client.delete(f"{H}/highlights/{hid}").status_code == 204
    assert client.get(H).json()["highlights"] == []
    assert client.delete(f"{H}/highlights/{hid}").status_code == 404


def test_highlight_delete_unknown_404():
    """不存在的高亮 id → 404"""
    assert client.delete(f"{H}/highlights/hl_nope").status_code == 404


# ============ 书签 ============
def test_bookmark_create_duplicate_cfi_allowed():
    """同 cfi 重复创建允许（不去重，前端保证）；id 前缀 bm_"""
    body = {"cfi": "epubcfi(/6/8)", "text": "第 3 页"}
    a = client.put(f"{H}/bookmarks", json=body).json()["id"]
    b = client.put(f"{H}/bookmarks", json=body).json()["id"]
    assert a != b
    assert a.startswith("bm_") and b.startswith("bm_")
    got = client.get(H).json()["bookmarks"]
    assert len(got) == 2
    assert got[0]["text"] == "第 3 页"


def test_bookmark_text_optional():
    """text 可缺省/空串，默认空串"""
    r = client.put(f"{H}/bookmarks", json={"cfi": "c"})
    assert r.status_code == 200
    assert client.get(H).json()["bookmarks"][0]["text"] == ""


def test_bookmark_delete():
    """删除书签 → 204；再删同一 id → 404"""
    bid2 = client.put(f"{H}/bookmarks", json={"cfi": "c", "text": "t"}).json()["id"]
    assert client.delete(f"{H}/bookmarks/{bid2}").status_code == 204
    assert client.get(H).json()["bookmarks"] == []
    assert client.delete(f"{H}/bookmarks/{bid2}").status_code == 404


def test_bookmark_cfi_required():
    """书签 cfi 缺失/空 → 400"""
    assert client.put(f"{H}/bookmarks", json={"text": "t"}).status_code == 400
    assert client.put(f"{H}/bookmarks", json={"cfi": "", "text": "t"}).status_code == 400


# ============ 笔记 ============
def test_note_create_empty_text_allowed():
    """笔记 text 允许空串（点开只读摘录）；excerpt 可选；updatedAt 初值 = createdAt"""
    r = client.put(f"{H}/notes", json={"cfi": "c", "excerpt": "原文摘录", "text": ""})
    assert r.status_code == 200
    nid = r.json()["id"]
    assert nid.startswith("nt_")
    note = client.get(H).json()["notes"][0]
    assert note["id"] == nid
    assert note["cfi"] == "c"
    assert note["excerpt"] == "原文摘录"
    assert note["text"] == ""
    assert note["updatedAt"] == note["createdAt"]


def test_note_patch_updates_text_and_updated_at():
    """PATCH {text} → text 更新 + updatedAt 刷新，返回更新后笔记"""
    nid = client.put(f"{H}/notes", json={"cfi": "c", "text": "初稿"}).json()["id"]
    r = client.patch(f"{H}/notes/{nid}", json={"text": "修改后"})
    assert r.status_code == 200
    note = r.json()
    assert note["id"] == nid
    assert note["text"] == "修改后"
    assert note["updatedAt"] >= note["createdAt"]
    assert client.get(H).json()["notes"][0]["text"] == "修改后"


def test_note_patch_invalid_text_400():
    """PATCH text 非字符串 → 400"""
    nid = client.put(f"{H}/notes", json={"cfi": "c", "text": "t"}).json()["id"]
    assert client.patch(f"{H}/notes/{nid}", json={"text": 123}).status_code == 400


def test_note_patch_unknown_404():
    """更新不存在的笔记 id → 404"""
    assert client.patch(f"{H}/notes/nt_nope", json={"text": "x"}).status_code == 404


def test_note_delete():
    """删除笔记 → 204；再删同一 id → 404"""
    nid = client.put(f"{H}/notes", json={"cfi": "c", "text": "t"}).json()["id"]
    assert client.delete(f"{H}/notes/{nid}").status_code == 204
    assert client.get(H).json()["notes"] == []
    assert client.delete(f"{H}/notes/{nid}").status_code == 404


def test_note_delete_unknown_404():
    """删除不存在的笔记 id → 404"""
    assert client.delete(f"{H}/notes/nt_nope").status_code == 404


# ============ 书不存在（写操作 404）============
def test_writes_unknown_book_404():
    """写操作：bookId 不在 books_store → 404 {"detail":"book not found"}（契约指定）"""
    base = "/api/books/nope/annotations"
    r = client.put(f"{base}/highlights", json={"cfi": "c", "text": "x"})
    assert r.status_code == 404
    assert r.json() == {"detail": "book not found"}
    assert client.put(f"{base}/bookmarks", json={"cfi": "c"}).status_code == 404
    assert client.put(f"{base}/notes", json={"cfi": "c"}).status_code == 404
    assert client.delete(f"{base}/highlights/hl_x").status_code == 404
    assert client.delete(f"{base}/bookmarks/bm_x").status_code == 404
    assert client.patch(f"{base}/notes/nt_x", json={"text": "x"}).status_code == 404
    assert client.delete(f"{base}/notes/nt_x").status_code == 404


def test_multiple_books_isolated():
    """不同书的标注互不干扰（setdefault 不共享 list 对象）"""
    client.put(f"{H}/highlights", json={"cfi": "c", "text": "only-b1"})
    client.put("/api/books/b2/annotations/highlights", json={"cfi": "c", "text": "only-b2"})
    b1 = client.get(H).json()
    b2 = client.get("/api/books/b2/annotations").json()
    assert [h["text"] for h in b1["highlights"]] == ["only-b1"]
    assert [h["text"] for h in b2["highlights"]] == ["only-b2"]


def test_persist_across_restart():
    """模拟重启（store 重新 load）：标注仍从磁盘读到"""
    client.put(f"{H}/highlights", json={"cfi": "c", "text": "持久", "color": "blue"})
    client.put(f"{H}/notes", json={"cfi": "c", "text": "笔记"})
    book = client.get(H).json()
    assert book["highlights"][0]["text"] == "持久"
    assert book["notes"][0]["text"] == "笔记"
