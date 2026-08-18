"""书内搜索 API 测试（V4）：GET /api/books/{bid}/search?q=

走真实导入管线（POST /api/books/import 解析 tests/fixtures/mini.epub），再断言：
- 命中字段完整（href/chapterTitle/sentence/cfi/matchStart/matchEnd）
- 大小写不敏感 / 多章节命中 / 一条句子多命中取第一个 / 无命中空 results
- q 空与超长 400 / 书无 index.json 与未知书 → 空 results（宽容语义）
- cfi 解析自检（epub.js 编码）：spineIdx 与 href 对应、元素/文本节点路径在 mini.epub
  对应 XHTML 中真实存在、文本节点 :offset 处确实以句子首词开头（可被 display(cfi) 定位）

契约：docs/reader-v2/01-contract-backend-core.md 第五节 + 05-contract-highlight-menu-v4.md。
"""

import importlib.util
import posixpath
import re
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
import backend  # noqa: E402
from app import state  # noqa: E402
from app.services.book_import import _local, _resolve  # noqa: E402

client = TestClient(backend.app)

MINI_EPUB = Path(__file__).resolve().parent / "fixtures" / "mini.epub"


def _load_generator():
    """importlib 加载 fixture 生成脚本（tests/ 非包，避免 sys.path 污染）"""
    spec = importlib.util.spec_from_file_location(
        "make_mini_epub", ROOT / "tests" / "fixtures" / "make_mini_epub.py"
    )
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """书架元数据/书籍目录/标注存储全部走临时目录，不碰真实数据"""
    monkeypatch.setattr(state, "BOOKS_FILE", tmp_path / "books.json")
    monkeypatch.setattr(state, "BOOKS_DIR", tmp_path / "books")
    monkeypatch.setattr(state, "ANNOTATIONS_FILE", tmp_path / "annotations.json")


def import_epub(path: Path) -> str:
    """POST /api/books/import 导入指定 epub → bookId"""
    with path.open("rb") as f:
        r = client.post("/api/books/import", files={"file": (path.name, f, "application/epub+zip")})
    assert r.status_code == 200, r.text
    return r.json()["id"]


def search(bid: str, q: str) -> dict:
    return client.get(f"/api/books/{bid}/search", params={"q": q})


@pytest.fixture()
def bid():
    """导入 mini.epub → bookId（每用例独立临时目录）"""
    return import_epub(MINI_EPUB)


# ============ CFI 解析自检工具（与 epub.js EpubCFI.parseStep 同一编码）============
_CFI_RE = re.compile(r"^epubcfi\(/(\d+)/(\d+)(?:\[([^\]]*)\])?!([^,)]+):(\d+)\)$")


def parse_cfi(cfi: str) -> tuple[int, str | None, list[tuple[str, int]], int]:
    """epubcfi(/A/B[id]!/steps:offset) → (spine_pos, spine_id, [(类型, 序号)], offset)"""
    m = _CFI_RE.match(cfi)
    assert m, f"cfi 格式不符合契约: {cfi!r}"
    base_first, base_pos, spine_id, path, offset = m.groups()
    assert int(base_first) == 6, f"base 首步应为 6（标准 OPF spine 为 package 第 3 子元素）: {cfi}"
    spine_pos = int(base_pos) // 2 - 1  # epub.js: 偶数步 = (index+1)*2
    steps = []
    for s in path.split("/")[1:]:
        n = int(s)
        if n % 2 == 0:
            steps.append(("element", n // 2 - 1))
        else:
            steps.append(("text", (n - 1) // 2))
    return spine_pos, spine_id, steps, int(offset)


def spine_hrefs(zf: zipfile.ZipFile) -> tuple[list[str], str]:
    """spine 顺序（itemref 文档序，0 基）→ href 列表 + OPF 目录"""
    container = ET.fromstring(zf.read("META-INF/container.xml"))
    opf_path = next(
        el.get("full-path")
        for el in container.iter()
        if _local(el.tag) == "rootfile" and el.get("full-path")
    )
    opf = ET.fromstring(zf.read(opf_path))
    root = opf
    base = posixpath.dirname(opf_path)
    items = {el.get("id"): el for el in root.iter() if _local(el.tag) == "item"}
    hrefs = []
    for el in root.iter():
        if _local(el.tag) != "itemref":
            continue
        item = items.get(el.get("idref"))
        if item is not None:
            hrefs.append(item.get("href"))
    return hrefs, base


def resolve_cfi(cfi: str, epub_path: Path) -> tuple[str, str, str, int]:
    """按 epub.js 算法解析 cfi → (href, 所属元素标签, 文本节点原文, 字符偏移)。

    元素/文本节点路径必须真实存在，否则断言失败。
    """
    spine_pos, spine_id, steps, offset = parse_cfi(cfi)
    with zipfile.ZipFile(epub_path) as zf:
        hrefs, base = spine_hrefs(zf)
        assert spine_pos < len(hrefs), f"spineIdx 越界: {cfi}"
        href = hrefs[spine_pos]
        tree = ET.fromstring(zf.read(_resolve(base, href)))
        root = tree
        body = next(el for el in root.iter() if _local(el.tag) == "body")
        assert steps[0] == ("element", 1), f"路径首步应为 body（html 第 2 子元素）: {cfi}"
        el = body
        for kind, idx in steps[1:]:
            if kind == "element":
                kids = [c for c in list(el) if isinstance(c.tag, str)]
                assert idx < len(kids), f"元素路径不存在: {cfi}"
                el = kids[idx]
            else:
                texts = [
                    t
                    for t in [el.text] + [c.tail for c in list(el) if isinstance(c.tag, str)]
                    if t is not None
                ]
                assert idx < len(texts), f"文本节点不存在: {cfi}"
                return href, _local(el.tag), texts[idx], offset
    raise AssertionError(f"cfi 缺少文本步: {cfi}")


def assert_cfi_points_to_sentence(cfi: str, sentence: str, epub_path: Path) -> None:
    """cfi 解析自检：spine↔href 一致 + 文本节点 :offset 处以句子首词开头"""
    href, tag, text, offset = resolve_cfi(cfi, epub_path)
    first = sentence.split()[0]
    assert text[offset : offset + len(first)] == first, (
        f"cfi {cfi} 未定位到句子 {sentence!r}（{tag} 文本节点偏移 {offset} 处为 {text[offset : offset + 12]!r}）"
    )
    return href


# ============ 命中 ============
def test_search_hit_fields_and_exact_cfi(bid):
    """命中：字段完整；cfi 精确格式 epubcfi(/6/2[chap01]!/4/4/1:0)（首章首段首文本节点）"""
    r = search(bid, "galling")
    assert r.status_code == 200
    body = r.json()
    assert body["query"] == "galling"
    assert len(body["results"]) == 1
    hit = body["results"][0]
    assert hit["href"] == "chapter1.xhtml"
    assert hit["chapterTitle"] == "Chapter 1"
    assert hit["sentence"] == "It was a galling defeat."
    assert hit["matchStart"] == 9
    assert hit["matchEnd"] == 16
    assert hit["cfi"] == "epubcfi(/6/2[chap01]!/4/4/1:0)"
    # 解析自检：该 cfi 指向 chapter1.xhtml 的正文首段，偏移 0 处即句子首词
    assert_cfi_points_to_sentence(hit["cfi"], hit["sentence"], MINI_EPUB)


def test_search_case_insensitive(bid):
    """大小写不敏感：全大写/混合大小写 query 都命中原文句子"""
    for q in ("GALLING", "GaLLiNg"):
        r = search(bid, q)
        assert r.status_code == 200
        assert r.json()["results"][0]["sentence"] == "It was a galling defeat."
        assert r.json()["results"][0]["matchStart"] == 9
    r = search(bid, "sEcReT")
    hits = r.json()["results"]
    assert [h["sentence"] for h in hits] == [
        "The captain kept a SeCrEt treasure map in his cabin.",
        "In the secret room the secret vault waits.",
    ]


def test_search_multi_chapter(bid):
    """跨章节重复词：按章节顺序返回全部命中（不分页）"""
    r = search(bid, "treasure")
    hits = r.json()["results"]
    assert len(hits) == 3
    assert [h["href"] for h in hits] == [
        "chapter1.xhtml",
        "chapter1.xhtml",
        "chapter2.xhtml",
    ]
    assert [h["chapterTitle"] for h in hits] == ["Chapter 1", "Chapter 1", "Chapter 2"]
    assert [h["sentence"] for h in hits] == [
        "The captain kept a SeCrEt treasure map in his cabin.",
        "Treasure is buried on the island.",
        "Old legends say the treasure is guarded by ghosts.",
    ]
    assert hits[0]["matchStart"] == 26 and hits[0]["matchEnd"] == 34
    assert hits[1]["matchStart"] == 0 and hits[1]["matchEnd"] == 8
    assert hits[2]["matchStart"] == 20 and hits[2]["matchEnd"] == 28
    # 每章 cfi 的 spineIdx 与各自 href 对应
    for h in hits:
        assert_cfi_points_to_sentence(h["cfi"], h["sentence"], MINI_EPUB)


def test_search_sentence_multiple_matches_takes_first(bid):
    """一条句子多个命中只取第一个（matchStart 为首次出现）"""
    r = search(bid, "secret")
    s8 = [h for h in r.json()["results"] if "vault" in h["sentence"]][0]
    assert s8["sentence"] == "In the secret room the secret vault waits."
    assert s8["matchStart"] == 7  # 第一个 secret（7..13），不是第二个（22..28）
    assert s8["matchEnd"] == 13


def test_search_multi_word_query(bid):
    """多词 query：matchStart/matchEnd 覆盖整个 query 串"""
    r = search(bid, "secret room")
    hit = r.json()["results"][0]
    assert hit["sentence"] == "In the secret room the secret vault waits."
    assert hit["matchStart"] == 7
    assert hit["matchEnd"] == 18


def test_search_mid_text_node_cfi(bid):
    """句子起始在行内元素 tail 文本节点（text_idx=1）：cfi 文本步为 3、偏移为 tail 内真实偏移"""
    r = search(bid, "hands")
    hit = r.json()["results"][0]
    assert hit["sentence"] == "All hands on deck."
    assert hit["matchStart"] == 4 and hit["matchEnd"] == 9
    assert hit["cfi"] == "epubcfi(/6/2[chap01]!/4/10/3:10)"  # em.tail " at dawn. All hands..."
    assert_cfi_points_to_sentence(hit["cfi"], hit["sentence"], MINI_EPUB)


def test_search_cfi_mid_paragraph_sentences(bid):
    """同一段落多句：后两句 cfi 定位到段内文本节点偏移，而非段落首"""
    r = search(bid, "Nobody found")
    hit = r.json()["results"][0]
    assert hit["sentence"] == "Nobody found a thing."
    href, tag, text, offset = resolve_cfi(hit["cfi"], MINI_EPUB)
    assert href == "chapter1.xhtml"
    assert text[offset : offset + len("Nobody")] == "Nobody"
    assert text[offset - 1] == " "  # 偏移在段中（前一句结尾之后），不是 0


def test_search_anchor_first_paragraph_text_idx(bid):
    """段落以空元素（书内锚点）开头：el.text 缺失不占文本节点序号（浏览器 DOM 语义）"""
    r = search(bid, "anchor speaks")
    hit = r.json()["results"][0]
    assert hit["sentence"] == "The anchor speaks first."
    assert hit["cfi"] == "epubcfi(/6/2[chap01]!/4/14/1:0)"  # a.tail = 文本节点 0
    assert_cfi_points_to_sentence(hit["cfi"], hit["sentence"], MINI_EPUB)


def test_search_glued_quote_mid_token_cfi(bid):
    """无空白紧贴的对话引号：句子起点在 token 内部，cfi 精确指向该字符（真实书常见）"""
    r = search(bid, "show is over")
    hit = r.json()["results"][0]
    assert hit["sentence"] == "\u201cThe show is over."
    assert hit["matchStart"] == 5 and hit["matchEnd"] == 17
    href, tag, text, off = resolve_cfi(hit["cfi"], MINI_EPUB)
    assert href == "chapter1.xhtml"
    assert text[off : off + 4] == "\u201cThe"


def test_search_no_match(bid):
    """无命中词 → 空 results"""
    r = search(bid, "zebra")
    assert r.status_code == 200
    assert r.json() == {"query": "zebra", "results": []}


# ============ 参数校验 ============
def test_search_invalid_query(bid):
    """q 空/纯空白/超长 → 400 {"detail":"invalid query"}"""
    for q in ("", "   ", "x" * 101):
        r = search(bid, q)
        assert r.status_code == 400, f"q={q!r}"
        assert r.json() == {"detail": "invalid query"}
    # 长度恰好 100 合法
    assert search(bid, "a" * 100).status_code == 200


# ============ 缺数据宽容语义 ============
def test_search_no_index_empty_results(bid):
    """书目录无 index.json → 空 results（不报错）"""
    (state.BOOKS_DIR / bid / "index.json").unlink()
    r = search(bid, "galling")
    assert r.status_code == 200
    assert r.json() == {"query": "galling", "results": []}


def test_search_unknown_book_empty_results():
    """书架不存在的书 → 空 results（宽容语义，同 annotations GET）"""
    r = search("no-such-book", "galling")
    assert r.status_code == 200
    assert r.json() == {"query": "galling", "results": []}


# ============ 上限 100 条截断 ============
def test_search_result_limit_100(tmp_path):
    """命中 >100 条时截断到 100，且每条 cfi 真实可解析并指向各自段落（同句重复不串位）"""
    gen = _load_generator()
    epub = tmp_path / "cap.epub"
    gen.build_epub(epub, fox_paragraphs=101)
    bid = import_epub(epub)
    r = search(bid, "fox")
    assert r.status_code == 200
    hits = r.json()["results"]
    assert len(hits) == 100
    offsets = []
    cfis = []
    for h in hits:
        assert h["href"] == "chapter2.xhtml"
        assert h["sentence"] == "The quick fox jumps."
        href, tag, text, off = resolve_cfi(h["cfi"], epub)
        assert text[off : off + len("The")] == "The"
        offsets.append(off)
        cfis.append(h["cfi"])
    # 101 个重复段落：每条的 cfi 必须指向各自的段落（元素路径不同 → cfi 互不相同）
    assert len(set(cfis)) == 100
    assert offsets == [0] * 100


# ============ 全量 cfi 解析自检（多 query 扫一遍）============
@pytest.mark.parametrize(
    "q",
    ["galling", "treasure", "secret", "hands", "Nobody", "the end", "deck", "island"],
)
def test_search_all_results_cfi_resolvable(bid, q):
    """每个命中的 cfi 都能按 epub.js 算法解析到真实文本节点且落在句子首词"""
    r = search(bid, q)
    assert r.status_code == 200
    assert r.json()["results"], f"query {q!r} 应至少有 1 条命中"
    for h in r.json()["results"]:
        assert h["cfi"]
        assert h["cfi"].startswith("epubcfi(/6/")
        assert h["cfi"].endswith(")")
        assert_cfi_points_to_sentence(h["cfi"], h["sentence"], MINI_EPUB)
