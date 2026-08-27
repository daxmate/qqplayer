"""电子书（EPUB）导入/书架/进度 API 测试

用 zipfile 在 tmp_path 现场生成最小合法 EPUB（container.xml + OPF + xhtml + PNG 封面
+ nav/toc.ncx），不依赖真实电子书；send2trash 用桩记录调用，不真删文件。
"""

import json
import shutil
import struct
import sys
import zipfile
import zlib
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent

sys.path.insert(0, str(ROOT))
import app.routers.books as books_router  # noqa: E402
import backend  # noqa: E402
from app import db, state  # noqa: E402

client = TestClient(backend.app)

CONTAINER_XML = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""


def make_png() -> bytes:
    """1x1 红色 PNG（合法文件头，封面提取校验用）"""

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(b"\x00\xff\x00\x00"))
        + chunk(b"IEND", b"")
    )


def build_epub(
    path: Path,
    title: str = "测试书籍",
    author: str = "测试作者",
    cover: str = "meta",  # meta | property | filename | none
    toc: str = "nav",  # nav | ncx | none
    missing_doc: bool = False,
) -> None:
    """生成最小合法 EPUB：container + OPF（2 章 spine）+ 封面 + 目录"""
    title_meta = f"<dc:title>{title}</dc:title>" if title else ""
    creator_meta = f"<dc:creator>{author}</dc:creator>" if author else ""
    cover_meta = '<meta name="cover" content="cover-img"/>' if cover == "meta" else ""
    cover_props = ' properties="cover-image"' if cover == "property" else ""
    cover_item = (
        f'<item id="cover-img" href="cover.png" media-type="image/png"{cover_props}/>'
        if cover != "none"
        else ""
    )
    if toc == "nav":
        toc_item = (
            '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'
        )
    elif toc == "ncx":
        toc_item = '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>'
    else:
        toc_item = ""
    opf = f"""<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-001</dc:identifier>
    {title_meta}
    {creator_meta}
    {cover_meta}
  </metadata>
  <manifest>
    {cover_item}
    {toc_item}
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xhtml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xhtml"/>
  </manifest>
  <spine>
    <itemref idref="c1"/>
    <itemref idref="c2"/>
  </spine>
</package>"""
    chapters = {
        "chapter1.xhtml": (
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第一章</title></head>'
            "<body><p>你好世界。这是一个测试句子！第二句？</p></body></html>"
        ),
        "chapter2.xhtml": (
            '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>第二章</title></head>'
            "<body><p>Hello world. This is a test. Another one!</p></body></html>"
        ),
    }
    nav_xhtml = (
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
        '<body><nav epub:type="toc"><ol>'
        '<li><a href="chapter1.xhtml">第一章</a></li>'
        '<li><a href="chapter2.xhtml">第二章</a></li>'
        "</ol></nav></body></html>"
    )
    ncx_xml = """<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="p1"><navLabel><text>第一章</text></navLabel><content src="chapter1.xhtml"/></navPoint>
    <navPoint id="p2"><navLabel><text>第二章</text></navLabel><content src="chapter2.xhtml"/></navPoint>
  </navMap>
</ncx>"""
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER_XML)
        z.writestr("OEBPS/content.opf", opf)
        if toc == "nav":
            z.writestr("OEBPS/nav.xhtml", nav_xhtml)
        elif toc == "ncx":
            z.writestr("OEBPS/toc.ncx", ncx_xml)
        if cover != "none":
            z.writestr("OEBPS/cover.png", make_png())
        for name, content in chapters.items():
            if missing_doc and name == "chapter2.xhtml":
                continue  # spine 引用缺失文档：索引该章句子为空但不阻断
            z.writestr(f"OEBPS/{name}", content)


@pytest.fixture(autouse=True)
def _isolate_books(tmp_path, monkeypatch):
    """书架存储/书籍目录隔离：全部走临时目录，不碰真实数据"""
    monkeypatch.setattr(state, "BOOKS_FILE", tmp_path / "books.json")
    monkeypatch.setattr(state, "BOOKS_DIR", tmp_path / "books")
    yield


def import_epub(epub_path: Path):
    """POST /api/books/import 上传指定 epub 文件（保留原始文件名）"""
    with epub_path.open("rb") as f:
        return client.post(
            "/api/books/import", files={"file": (epub_path.name, f, "application/epub+zip")}
        )


def _index_of(bid: str) -> dict:
    return json.loads((state.BOOKS_DIR / bid / "index.json").read_text("utf-8"))


class _FakeSend2Trash:
    """模拟 send2trash 模块：记录调用并实际移走目录"""

    def __init__(self, calls):
        self.calls = calls

    def send2trash(self, path):
        self.calls.append(path)
        p = Path(path)
        if p.exists():
            shutil.rmtree(p)


# ============ 导入 ============
def test_import_ok(tmp_path):
    """导入成功：元数据入库、book.epub/cover.png/index.json 落盘、nav 章节标题 + 分句"""
    epub = tmp_path / "test.epub"
    build_epub(epub)
    r = import_epub(epub)
    assert r.status_code == 200
    book = r.json()
    assert book["title"] == "测试书籍"
    assert book["author"] == "测试作者"
    assert book["progress"] is None
    assert book["id"]
    d = state.BOOKS_DIR / book["id"]
    assert (d / "book.epub").exists()
    assert (d / "cover.png").exists()
    index = _index_of(book["id"])
    assert [c["title"] for c in index["chapters"]] == ["第一章", "第二章"]
    assert index["chapters"][0]["sentences"] == ["你好世界。", "这是一个测试句子！", "第二句？"]
    assert index["chapters"][1]["sentences"] == ["Hello world.", "This is a test.", "Another one!"]
    assert "generatedAt" in index
    lst = client.get("/api/books").json()
    assert any(b["id"] == book["id"] for b in lst)


def test_import_cover_variants(tmp_path):
    """封面三种来源都提取成功：properties=cover-image / meta[name=cover] / 文件名含 cover"""
    for mode in ("property", "meta", "filename"):
        epub = tmp_path / f"{mode}.epub"
        build_epub(epub, cover=mode)
        r = import_epub(epub)
        assert r.status_code == 200, mode
        bid = r.json()["id"]
        assert (state.BOOKS_DIR / bid / "cover.png").exists(), mode
        assert client.get(f"/api/books/{bid}/cover").status_code == 200, mode


def test_import_no_cover_404(tmp_path):
    """无封面 EPUB：导入成功但 /cover 返回 404"""
    epub = tmp_path / "nocover.epub"
    build_epub(epub, cover="none")
    r = import_epub(epub)
    assert r.status_code == 200
    bid = r.json()["id"]
    assert not (state.BOOKS_DIR / bid / "cover.png").exists()
    assert client.get(f"/api/books/{bid}/cover").status_code == 404


def test_import_ncx_titles(tmp_path):
    """epub2 toc.ncx 章节标题：拿不到 nav 时用 ncx"""
    epub = tmp_path / "ncx.epub"
    build_epub(epub, toc="ncx")
    r = import_epub(epub)
    assert r.status_code == 200
    assert [c["title"] for c in _index_of(r.json()["id"])["chapters"]] == ["第一章", "第二章"]


def test_import_no_toc_fallback_filename(tmp_path):
    """无 nav 无 ncx：章节标题用文档文件名兜底"""
    epub = tmp_path / "ft.epub"
    build_epub(epub, toc="none")
    r = import_epub(epub)
    assert r.status_code == 200
    assert [c["title"] for c in _index_of(r.json()["id"])["chapters"]] == [
        "chapter1",
        "chapter2",
    ]


def test_import_missing_meta_fallbacks(tmp_path):
    """缺 dc:title/dc:creator：title 用文件名兜底、author 空串"""
    epub = tmp_path / "无题书.epub"
    build_epub(epub, title="", author="")
    r = import_epub(epub)
    assert r.status_code == 200
    book = r.json()
    assert book["title"] == "无题书"
    assert book["author"] == ""


def test_import_missing_doc_index_nonblocking(tmp_path):
    """spine 文档缺失 → 该章句子为空数组，导入不失败、元数据照常入库"""
    epub = tmp_path / "miss.epub"
    build_epub(epub, missing_doc=True)
    r = import_epub(epub)
    assert r.status_code == 200
    book = r.json()
    assert book["title"] == "测试书籍"
    chapters = _index_of(book["id"])["chapters"]
    assert len(chapters) == 2
    assert chapters[1]["sentences"] == []


def test_import_bad_zip_400(tmp_path):
    """坏文件（非 zip）→ 400，目录不留残留、不进书架"""
    bad = tmp_path / "bad.epub"
    bad.write_bytes(b"not a zip file at all")
    r = import_epub(bad)
    assert r.status_code == 400
    assert "EPUB" in r.json()["detail"]
    assert client.get("/api/books").json() == []
    assert not any(state.BOOKS_DIR.glob("*"))


def test_import_wrong_ext_400(tmp_path):
    """非 .epub 文件 → 400"""
    f = tmp_path / "book.txt"
    f.write_bytes(b"hello")
    with f.open("rb") as fh:
        r = client.post("/api/books/import", files={"file": ("book.txt", fh, "text/plain")})
    assert r.status_code == 400
    assert client.get("/api/books").json() == []


def test_import_duplicate_new_id(tmp_path):
    """重复导入同一文件 → 新 id 新目录，书架两条"""
    epub = tmp_path / "dup.epub"
    build_epub(epub)
    a = import_epub(epub).json()
    b = import_epub(epub).json()
    assert a["id"] != b["id"]
    assert (state.BOOKS_DIR / a["id"]).exists()
    assert (state.BOOKS_DIR / b["id"]).exists()
    assert len(client.get("/api/books").json()) == 2


# ============ 列表 ============
def test_list_desc_order(tmp_path):
    """书架按 addedAt 倒序"""
    epub = tmp_path / "ord.epub"
    build_epub(epub)
    a = import_epub(epub).json()
    b = import_epub(epub).json()
    books = db.books_load()  # 直接改时间戳保证顺序可断言
    for book in books:
        book["addedAt"] = 2000 if book["id"] == b["id"] else 1000
    db.books_save(books)
    lst = client.get("/api/books").json()
    assert [x["id"] for x in lst] == [b["id"], a["id"]]


def test_list_book_size(tmp_path):
    """列表返回每本书 size：等于 book.epub 实际字节数（>0，下载 UI 显示体积用）"""
    epub = tmp_path / "s.epub"
    build_epub(epub)
    bid = import_epub(epub).json()["id"]
    book = next(x for x in client.get("/api/books").json() if x["id"] == bid)
    assert book["size"] == (state.BOOKS_DIR / bid / "book.epub").stat().st_size
    assert book["size"] > 0


# ============ 文件 / 封面 ============
def test_file_endpoint(tmp_path):
    """GET /file 返回原 epub 字节"""
    epub = tmp_path / "f.epub"
    build_epub(epub)
    bid = import_epub(epub).json()["id"]
    r = client.get(f"/api/books/{bid}/file")
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/epub+zip"
    assert r.content == epub.read_bytes()


def test_cover_endpoint(tmp_path):
    """GET /cover 返回封面图片字节"""
    epub = tmp_path / "c.epub"
    build_epub(epub)
    bid = import_epub(epub).json()["id"]
    r = client.get(f"/api/books/{bid}/cover")
    assert r.status_code == 200
    assert r.content == make_png()


# ============ 进度 ============
def test_progress_roundtrip(tmp_path):
    """进度 PUT/GET 往返；未读为 null；location 缺省不带该字段"""
    epub = tmp_path / "p.epub"
    build_epub(epub)
    bid = import_epub(epub).json()["id"]
    assert client.get(f"/api/books/{bid}/progress").json() is None
    body = {"cfi": "epubcfi(/6/8!/4)", "location": 0.42, "updatedAt": 123456}
    r = client.put(f"/api/books/{bid}/progress", json=body)
    assert r.status_code == 200
    assert r.json() == body
    assert client.get(f"/api/books/{bid}/progress").json() == body
    client.put(f"/api/books/{bid}/progress", json={"cfi": "epubcfi(/6/2)", "updatedAt": 999})
    got = client.get(f"/api/books/{bid}/progress").json()
    assert got == {"cfi": "epubcfi(/6/2)", "updatedAt": 999}
    book = next(x for x in client.get("/api/books").json() if x["id"] == bid)
    assert book["progress"] == got


def test_progress_invalid_400(tmp_path):
    """进度参数非法 → 400"""
    epub = tmp_path / "pv.epub"
    build_epub(epub)
    bid = import_epub(epub).json()["id"]
    url = f"/api/books/{bid}/progress"
    assert client.put(url, json={"cfi": "", "updatedAt": 1}).status_code == 400
    assert client.put(url, json={"cfi": "x", "updatedAt": "1"}).status_code == 400
    assert client.put(url, json={"cfi": "x", "location": "a", "updatedAt": 1}).status_code == 400
    assert client.put(url, json={}).status_code == 400


# ============ 404 / 删除 ============
def test_unknown_id_404(tmp_path):
    """不存在的书籍：file/cover/progress/delete 全部 404"""
    assert client.get("/api/books/nope/file").status_code == 404
    assert client.get("/api/books/nope/cover").status_code == 404
    assert client.get("/api/books/nope/progress").status_code == 404
    assert (
        client.put("/api/books/nope/progress", json={"cfi": "x", "updatedAt": 1}).status_code == 404
    )
    assert client.delete("/api/books/nope").status_code == 404


def test_delete_send2trash(tmp_path, monkeypatch):
    """删除：send2trash 移废纸篓（桩记录调用）、书架移除、再访问 404"""
    calls = []
    monkeypatch.setattr(books_router, "send2trash", _FakeSend2Trash(calls))
    epub = tmp_path / "d.epub"
    build_epub(epub)
    bid = import_epub(epub).json()["id"]
    d = state.BOOKS_DIR / bid
    assert d.exists()
    r = client.delete(f"/api/books/{bid}")
    assert r.status_code == 204
    assert calls == [str(d)]
    assert not d.exists()  # 桩实际移走目录
    assert client.get("/api/books").json() == []
    assert client.get(f"/api/books/{bid}/file").status_code == 404
