#!/usr/bin/env python3
"""生成 tests/fixtures/mini.epub —— 书内搜索测试用最小合法 EPUB。

两个章节 XHTML，正文含已知句子：
- 大小写混合目标词：SeCrEt（query "secret" 命中）
- 跨章节重复词：treasure（chapter1 ×2、chapter2 ×1）
- 无命中词：zebra 全书不出现
- 单段落多句（cfi 需定位到段中句）+ 行内元素 tail 文本（cfi 文本节点序号 >0 的路径）

重新生成：python3 tests/fixtures/make_mini_epub.py（zip 条目时间戳固定，输出可复现）。
"""

import sys
import zipfile
from pathlib import Path
from zipfile import ZipInfo

FIXTURE = Path(__file__).resolve().parent / "mini.epub"

CONTAINER_XML = """<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>"""


def build_epub(path: Path, fox_paragraphs: int = 0) -> None:
    """写 mini.epub；fox_paragraphs > 0 时往 chapter2 追加 N 个重复句（上限 100 截断用例用）。"""
    opf = """<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">mini-001</dc:identifier>
    <dc:title>Mini Test Book</dc:title>
    <dc:creator>Test Author</dc:creator>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref id="chap01" idref="c1"/>
    <itemref id="chap02" idref="c2"/>
  </spine>
</package>"""

    nav_xhtml = (
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">'
        '<body><nav epub:type="toc"><ol>'
        '<li><a href="chapter1.xhtml">Chapter 1</a></li>'
        '<li><a href="chapter2.xhtml">Chapter 2</a></li>'
        "</ol></nav></body></html>"
    )

    chapter1 = (
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 1</title></head><body>'
        "<h1>Chapter One.</h1>"
        "<p>It was a galling defeat.</p>"
        "<p>The captain kept a SeCrEt treasure map in his cabin.</p>"
        "<p>Treasure is buried on the island. The crew searched all night. Nobody found a thing.</p>"
        "<p>The quest begins <em>here</em> at dawn. All hands on deck.</p>"
        "<p>In the secret room the secret vault waits.</p>"
        '<p><a id="anchor1" />The anchor speaks first.</p>'
        "<p>\u201cBravo,\u201d said the crowd.\u201cThe show is over.\u201d</p>"
        "</body></html>"
    )
    fox_paras = "".join("<p>The quick fox jumps.</p>" for _ in range(fox_paragraphs))
    chapter2 = (
        '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Chapter 2</title></head><body>'
        "<h1>Chapter Two.</h1>"
        "<p>Old legends say the treasure is guarded by ghosts.</p>"
        "<p>Nobody believes a word of them.</p>"
        "<p>Now the story ends. The end.</p>"
        f"{fox_paras}"
        "</body></html>"
    )

    # 固定时间戳 → 输出可复现（git 友好）；mimetype 按 EPUB 规范不压缩且排第一
    def zi(name: str) -> ZipInfo:
        info = ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
        info.external_attr = 0o644 << 16
        return info

    with zipfile.ZipFile(path, "w") as z:
        z.writestr(zi("mimetype"), "application/epub+zip", compress_type=zipfile.ZIP_STORED)
        z.writestr(zi("META-INF/container.xml"), CONTAINER_XML)
        z.writestr(zi("OEBPS/content.opf"), opf)
        z.writestr(zi("OEBPS/nav.xhtml"), nav_xhtml)
        z.writestr(zi("OEBPS/chapter1.xhtml"), chapter1)
        z.writestr(zi("OEBPS/chapter2.xhtml"), chapter2)


if __name__ == "__main__":
    build_epub(FIXTURE)
    print(f"written: {FIXTURE}")
    sys.exit(0)
