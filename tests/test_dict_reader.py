"""dict_reader（MDX/MDD 封装）测试：fixtures 现场生成最小词典，不依赖用户词典目录。

运行：cd ~/codes/qqplayerB && ~/codes/qqplayer/venv/bin/python -m pytest tests/test_dict_reader.py -q
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.services import dict_reader  # noqa: E402
from tests.fixtures.mini_mdict import build_mdd, build_mdx  # noqa: E402


@pytest.fixture(autouse=True)
def _clear_cache():
    dict_reader.clear_cache()
    yield
    dict_reader.clear_cache()


@pytest.fixture
def mini_dir(tmp_path):
    """mini.mdx（4 词条，含音频引用）+ mini.mdd（3 资源）"""
    build_mdx(
        tmp_path / "mini.mdx",
        [
            (
                "hello",
                '<link href="mini.css"><b>hello</b> 你好 <img src="img/hi.gif"> '
                "sound://sound/hello.mp3",
            ),
            ("helloed", "<b>helloed</b>"),
            ("cats", "<b>cats</b>"),
            ("ladies", "<b>ladies</b>"),
        ],
    )
    build_mdd(
        tmp_path / "mini.mdd",
        [
            (r"\mini.css", b"body{}"),
            (r"\img\hi.gif", b"GIF89a"),
            (r"\sound\hello.mp3", b"ID3"),
        ],
    )
    return tmp_path / "mini.mdx"


# ============ 基础 ============
def test_name_and_keys_count(mini_dir):
    d = dict_reader.get_dict(str(mini_dir))
    assert d.name == "mini"
    assert d.keys_count == 4
    assert d.has_mdd() is True


def test_lookup_hit(mini_dir):
    html = dict_reader.get_dict(str(mini_dir)).lookup("hello")
    assert html is not None
    assert "<b>hello</b>" in html
    assert "你好" in html  # utf-8 解码正确


def test_lookup_miss(mini_dir):
    assert dict_reader.get_dict(str(mini_dir)).lookup("zzz") is None


def test_lookup_variants_suffix(mini_dir):
    d = dict_reader.get_dict(str(mini_dir))
    # cat + s → cats（原词 miss，变形命中）
    assert d.lookup("cat") is None
    assert "<b>cats</b>" in d.lookup_variants("cat")
    # hello + ed → helloed
    assert "<b>helloed</b>" in d.lookup_variants("hello")
    # lady → y 变 ies → ladies
    assert "<b>ladies</b>" in d.lookup_variants("lady")


def test_lookup_variants_case_fallback(mini_dir):
    d = dict_reader.get_dict(str(mini_dir))
    assert d.lookup("Hello") is None  # 词典只有小写 hello
    assert "<b>hello</b>" in d.lookup_variants("Hello")


def test_lookup_variants_no_hit(mini_dir):
    assert dict_reader.get_dict(str(mini_dir)).lookup_variants("zzz") is None


# ============ @@@LINK 重定向 ============
@pytest.fixture
def link_dir(tmp_path):
    """含 @@@LINK 重定向条目的词典：直跳 / 链式 / 循环 / 引号目标 / 大小写目标 / 目标缺失"""
    build_mdx(
        tmp_path / "link.mdx",
        [
            ("photograph", "<b>photograph</b> real"),
            ("photographs", "@@@LINK=photograph\r\n"),
            ("a", "@@@LINK=b\r\n"),
            ("b", "@@@LINK=c\r\n"),
            ("c", "<b>c</b> real"),
            ("x", "@@@LINK=y\r\n"),
            ("y", "@@@LINK=x\r\n"),
            ("self", "@@@LINK=self\r\n"),
            ("quoted", '@@@LINK="photograph"\r\n'),
            ("upper", "@@@LINK=PHOTOGRAPH\r\n"),
            ("ghost", "@@@LINK=nowhere\r\n"),
        ],
    )
    return tmp_path / "link.mdx"


def test_lookup_link_direct(link_dir):
    """直跳：photographs → photograph 词条内容（不再返回链接文本）"""
    html = dict_reader.get_dict(str(link_dir)).lookup("photographs")
    assert html is not None
    assert "<b>photograph</b>" in html
    assert "@@@LINK=" not in html


def test_lookup_link_chain(link_dir):
    """链式跳转：a → b → c"""
    html = dict_reader.get_dict(str(link_dir)).lookup("a")
    assert html is not None
    assert "<b>c</b>" in html


def test_lookup_link_cycle_no_hang(link_dir):
    """循环不卡死：x ↔ y 互跳、self 自引用，均返回链接条目"""
    d = dict_reader.get_dict(str(link_dir))
    html = d.lookup("x")
    assert html is not None and html.startswith("@@@LINK=")
    html2 = d.lookup("self")
    assert html2 is not None and html2.startswith("@@@LINK=")


def test_lookup_link_quoted_target(link_dir):
    """目标词带引号（@@@LINK="photograph"）也能解出"""
    html = dict_reader.get_dict(str(link_dir)).lookup("quoted")
    assert html is not None
    assert "<b>photograph</b>" in html


def test_lookup_link_case_insensitive(link_dir):
    """目标词任意大小写：PHOTOGRAPH 回退小写命中"""
    html = dict_reader.get_dict(str(link_dir)).lookup("upper")
    assert html is not None
    assert "<b>photograph</b>" in html


def test_lookup_link_missing_target(link_dir):
    """目标词不存在 → 保留原链接条目（不吞词条）"""
    html = dict_reader.get_dict(str(link_dir)).lookup("ghost")
    assert html is not None and html.startswith("@@@LINK=")


def test_lookup_variants_benefits_from_link(link_dir):
    """lookup_variants 命中重定向条目 → 自动跳到目标词条"""
    html = dict_reader.get_dict(str(link_dir)).lookup_variants("Photographs")
    assert html is not None
    assert "<b>photograph</b>" in html


# ============ 资源（mdd）============
def test_resource_normalization(mini_dir):
    d = dict_reader.get_dict(str(mini_dir))
    assert d.resource("mini.css") == b"body{}"
    assert d.resource("/mini.css") == b"body{}"
    assert d.resource("\\mini.css") == b"body{}"
    assert d.resource("img/hi.gif") == b"GIF89a"
    assert d.resource("sound/hello.mp3") == b"ID3"


def test_resource_missing(mini_dir):
    assert dict_reader.get_dict(str(mini_dir)).resource("nope.png") is None


def test_resource_without_mdd(tmp_path):
    build_mdx(tmp_path / "bare.mdx", [("hi", "<b>hi</b>")])  # 无 mdd
    d = dict_reader.get_dict(str(tmp_path / "bare.mdx"))
    assert d.has_mdd() is False
    assert d.resource("anything.css") is None


# ============ 缓存 ============
def test_cache_reuses_instance(mini_dir):
    a = dict_reader.get_dict(str(mini_dir))
    b = dict_reader.get_dict(str(mini_dir))
    assert a is b
    dict_reader.clear_cache()
    c = dict_reader.get_dict(str(mini_dir))
    assert c is not a


def test_evict(mini_dir):
    a = dict_reader.get_dict(str(mini_dir))
    dict_reader.evict(str(mini_dir))
    assert dict_reader.get_dict(str(mini_dir)) is not a


# ============ 打开失败 ============
def test_load_failed_file_not_found(tmp_path):
    d = dict_reader.get_dict(str(tmp_path / "missing.mdx"))
    with pytest.raises(dict_reader.MdxLoadError) as ei:
        d.lookup("hello")
    assert "file not found" in str(ei.value)


def test_load_failed_corrupt_file(tmp_path):
    bad = tmp_path / "bad.mdx"
    bad.write_bytes(b"this is not an mdx file at all")
    d = dict_reader.get_dict(str(bad))
    with pytest.raises(dict_reader.MdxLoadError):
        d.lookup("hello")


def test_load_failed_error_is_sticky(tmp_path):
    """同一实例失败后报同样错误（不反复重试）；evict 后新实例可恢复"""
    bad = tmp_path / "bad.mdx"
    bad.write_bytes(b"garbage")
    d = dict_reader.get_dict(str(bad))
    with pytest.raises(dict_reader.MdxLoadError):
        d.lookup("x")
    with pytest.raises(dict_reader.MdxLoadError) as ei:
        d.lookup("y")
    assert str(ei.value)  # 带可读原因（不重复尝试打开）


# ============ HTML 解析辅助 ============
def test_extract_audio_refs():
    html = 'sound://sound/hello.mp3 <img src="img/hi.gif"> <a href="x.mp3"> src="a.mp3"'
    assert dict_reader.extract_audio_refs(html) == ["sound/hello.mp3", "a.mp3"]


def test_parse_rank():
    assert dict_reader.parse_rank('<div class="word">the</div><span class="rank">1</span>') == 1
    assert dict_reader.parse_rank('<span class="rank">18253</span>') == 18253
    assert dict_reader.parse_rank("<b>no rank</b>") is None


def test_resource_fallback_sidecar(tmp_path, monkeypatch):
    """mdd 没有的资源回退到词典同目录实体文件（外置 css 场景）"""
    from app.services import dict_reader

    (tmp_path / "fake.mdx").write_bytes(b"x")
    (tmp_path / "fake.mdd").write_bytes(b"x")
    (tmp_path / "style.css").write_bytes(b"body{color:red}")

    d = dict_reader.MdxDict(str(tmp_path / "fake.mdx"))
    monkeypatch.setattr(d, "_ensure_mdd_loaded", lambda: None)
    monkeypatch.setattr(d, "_mdd_index", None)
    assert d.resource("style.css") == b"body{color:red}"
    assert d.resource("nope.css") is None
    # 路径穿越防护
    assert d.resource("../secret.txt") is None
