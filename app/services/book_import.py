"""EPUB 导入解析（纯标准库 zipfile + xml.etree.ElementTree，无第三方依赖）。

从 .epub 提取：书名/作者元数据、封面图片、章节句子索引（有声书对齐预留）。
解析失败统一抛 BadEpubError（可读中文信息），由路由层转 400；
索引生成失败不阻断导入（_build_index 兜底返回空 chapters，元数据照常入库）。
"""

import posixpath
import re
import time
import urllib.parse
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

DC_NS = "http://purl.org/dc/elements/1.1/"
NCX_NS = "http://www.daisy.org/z3986/2005/ncx/"

# 分句边界：中文句读（。！？；…）与英文句点/问号/感叹号/分号（简单实现即可）
_SENT_SPLIT_RE = re.compile(r"(?<=[。！？；…!?.;])\s*")


class BadEpubError(Exception):
    """EPUB 解析失败（坏 zip / 缺 container / 非 epub），路由层转 400。"""


def _local(tag: str) -> str:
    """去掉 Clark notation 命名空间前缀，返回本地标签名"""
    return tag.rsplit("}", 1)[-1]


def _resolve(base: str, href: str) -> str:
    """把相对 base 目录的 href 规整成 zip 内绝对路径（去 fragment/query/../）"""
    href = urllib.parse.unquote(href.split("#")[0].split("?")[0])
    if not href:
        return ""
    return posixpath.normpath(posixpath.join(base, href)).lstrip("/")


def _find_rootfile(zf: zipfile.ZipFile) -> str:
    """META-INF/container.xml → OPF full-path"""
    try:
        container = ET.fromstring(zf.read("META-INF/container.xml"))
    except KeyError:
        raise BadEpubError("不是有效的 EPUB 文件（缺少 META-INF/container.xml）") from None
    except ET.ParseError as e:
        raise BadEpubError(f"container.xml 解析失败: {e}") from None
    for el in container.iter():
        if _local(el.tag) == "rootfile":
            path = el.get("full-path")
            if path:
                return path
    raise BadEpubError("container.xml 中找不到 rootfile（非 EPUB 结构）")


def _opf_items(opf: ET.Element) -> dict[str, ET.Element]:
    """manifest：id → item 元素"""
    items = {}
    for el in opf.iter():
        if _local(el.tag) == "item":
            items[el.get("id")] = el
    return items


def _opf_meta_text(opf: ET.Element, ns: str, tag: str) -> str:
    """取指定命名空间下首个非空元素文本（dc:title / dc:creator）"""
    for el in opf.iter(f"{{{ns}}}{tag}"):
        if el.text and el.text.strip():
            return el.text.strip()
    return ""


def _extract_cover(zf: zipfile.ZipFile, opf: ET.Element, base: str):
    """提取封面 → (bytes|None, ext|None)。

    优先级：manifest properties="cover-image" > meta[name=cover] 指向的 item
    > 文件名含 cover 的图片；只认 jpg/jpeg/png（jpeg 归一成 jpg）。
    """
    items = _opf_items(opf)
    candidates: list[ET.Element] = []
    for item in items.values():
        if "cover-image" in (item.get("properties") or "").split():
            candidates.append(item)
    if not candidates:
        for el in opf.iter():
            if _local(el.tag) == "meta" and el.get("name") == "cover":
                item = items.get(el.get("content"))
                if item is not None:
                    candidates.append(item)
                break
    if not candidates:
        for item in items.values():
            stem = Path(item.get("href") or "").stem.lower()
            if "cover" in stem:
                candidates.append(item)
    for item in candidates:
        path = _resolve(base, item.get("href") or "")
        if not path:
            continue
        ext = Path(path).suffix.lower().lstrip(".")
        if ext not in {"jpg", "jpeg", "png"}:
            continue
        try:
            data = zf.read(path)
        except KeyError:
            continue
        if data:
            return data, ("jpg" if ext == "jpeg" else ext)
    return None, None


def _find_toc(zf: zipfile.ZipFile, opf: ET.Element, base: str) -> dict[str, str]:
    """章节标题表（zip 内绝对路径 → 标题）：优先 epub3 nav，其次 epub2 toc.ncx。"""
    titles: dict[str, str] = {}
    nav_item = None
    ncx_item = None
    for item in _opf_items(opf).values():
        props = (item.get("properties") or "").split()
        mtype = item.get("media-type") or ""
        if nav_item is None and "nav" in props:
            nav_item = item
        if ncx_item is None and mtype == "application/x-dtbncx+xml":
            ncx_item = item
    if nav_item is not None:
        try:
            nav_path = _resolve(base, nav_item.get("href") or "")
            tree = ET.fromstring(zf.read(nav_path))
            nav_base = posixpath.dirname(nav_path)
            for a in tree.iter():
                if _local(a.tag) != "a":
                    continue
                href = a.get("href") or ""
                text = "".join(a.itertext()).strip()
                if href and text:
                    titles[_resolve(nav_base, href)] = text
        except (KeyError, ET.ParseError):
            pass
        if titles:
            return titles
    if ncx_item is not None:
        try:
            ncx_path = _resolve(base, ncx_item.get("href") or "")
            tree = ET.fromstring(zf.read(ncx_path))
            ncx_base = posixpath.dirname(ncx_path)
            for np_ in tree.iter():
                if _local(np_.tag) != "navPoint":
                    continue
                content = np_.find(f"{{{NCX_NS}}}content")
                label = np_.find(f"{{{NCX_NS}}}navLabel")
                if content is None or label is None:
                    continue
                href = content.get("src") or ""
                text = "".join(label.itertext()).strip()
                if href and text:
                    titles[_resolve(ncx_base, href)] = text
        except (KeyError, ET.ParseError):
            pass
    return titles


def _doc_text(zf: zipfile.ZipFile, path: str) -> str:
    """读 XHTML 文档 → 纯文本（去标签/script/style，压缩空白）"""
    tree = ET.fromstring(zf.read(path))
    for el in list(tree.iter()):
        # 头部/脚本/样式不属于阅读正文，全部剔除
        if _local(el.tag) in {"head", "script", "style"}:
            el.text = None
            for child in list(el):
                el.remove(child)
    return " ".join("".join(tree.itertext()).split())


def _split_sentences(text: str) -> list[str]:
    return [s.strip() for s in _SENT_SPLIT_RE.split(text) if s.strip()]


def _build_index(zf: zipfile.ZipFile, opf: ET.Element, base: str) -> dict:
    """spine 逐文档提纯文本 → 分句 → chapters 索引（有声书对齐预留）"""
    items = _opf_items(opf)
    toc = _find_toc(zf, opf, base)
    chapters = []
    for el in opf.iter():
        if _local(el.tag) != "itemref":
            continue
        item = items.get(el.get("idref"))
        if item is None:
            continue
        href = item.get("href") or ""
        path = _resolve(base, href)
        if not path:
            continue
        title = toc.get(path) or Path(path).stem
        try:
            text = _doc_text(zf, path)
        except (KeyError, ET.ParseError):
            text = ""  # 单文档解析失败不阻断整本导入
        chapters.append({"href": href, "title": title, "sentences": _split_sentences(text)})
    return {"chapters": chapters, "generatedAt": int(time.time() * 1000)}


def parse_epub(zip_path: Path, name_hint: str | None = None) -> dict:
    """解析 EPUB 文件 → {"title", "author", "cover", "cover_ext", "index"}

    name_hint：上传原始文件名（缺 dc:title 时用它的 stem 兜底）。
    """
    try:
        zf = zipfile.ZipFile(zip_path)
    except (zipfile.BadZipFile, OSError) as e:
        raise BadEpubError(f"不是有效的 EPUB 文件（{e}）") from None
    with zf:
        rootfile = _find_rootfile(zf)
        try:
            opf = ET.fromstring(zf.read(rootfile))
        except (KeyError, ET.ParseError) as e:
            raise BadEpubError(f"OPF 解析失败: {e}") from None
        # 缺 dc:title 用文件名兜底（优先上传原始名）；缺 dc:creator 给空串
        title = _opf_meta_text(opf, DC_NS, "title") or Path(name_hint or zip_path).stem
        author = _opf_meta_text(opf, DC_NS, "creator")
        base = posixpath.dirname(rootfile)
        cover, cover_ext = _extract_cover(zf, opf, base)
        try:
            index = _build_index(zf, opf, base)
        except Exception:
            index = {"chapters": [], "generatedAt": int(time.time() * 1000)}
    return {
        "title": title,
        "author": author,
        "cover": cover,
        "cover_ext": cover_ext,
        "index": index,
    }
