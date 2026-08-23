"""parse_lrc 过滤规则测试（与前端 parseLrc.js parseLrcText 同构）

覆盖：空行丢弃 / 信息行（作词作曲等元信息）丢弃 / 超短行丢弃 /
保守性（关键词开头但无分隔的正常歌词不误杀）/ 空行导致的时长空洞被跳过。
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from app.services.lyrics import parse_lrc  # noqa: E402


def texts(lines):
    return [ln["text"][0] for ln in lines]


def test_parse_lrc_basic_timeline():
    lines = parse_lrc("[00:10.00]第一句\n[00:20.50]第二句\n[00:30.25]第三句\n")
    assert len(lines) == 3
    assert lines[0]["s"] == 10.0
    assert lines[1]["s"] == 20.5
    assert lines[2]["e"] == 35.25  # 末行默认 +5s


def test_parse_lrc_drops_info_lines():
    """信息行（作词/作曲等元信息，全角/半角冒号、可带可不带冒号）被丢弃"""
    lines = parse_lrc(
        "[00:01.00]作词：姚谦\n"
        "[00:02.00]作曲 李宗盛\n"
        "[00:03.00]编曲:李荣浩\n"
        "[00:04.00]制作人：陈奕迅\n"
        "[00:05.00]原唱：周杰伦\n"
        "[00:06.00]第一句歌词\n"
        "[00:07.00]第二句\n"
    )
    assert texts(lines) == ["第一句歌词", "第二句"]


def test_parse_lrc_drops_empty_lines_and_gap():
    """空行（仅时间戳无文本）丢弃，且前一行句末跳过空洞接到下一句（くるみ 30s 空行场景）"""
    lines = parse_lrc(
        "[00:10.00]第一句\n"
        "[00:20.00]\n"  # 空行
        "[00:50.00]第二句\n"
    )
    assert texts(lines) == ["第一句", "第二句"]
    assert lines[0]["e"] == 50.0  # 空洞被跳过，不再产生 0.3s 怪行


def test_parse_lrc_drops_ultra_short_lines():
    """超短行：duration < 0.3s 且文本 <= 2 字（残留碎片）丢弃（Pretender 0.13s 空行场景）"""
    lines = parse_lrc(
        "[00:10.00]第一句\n"
        "[00:10.13].\n"  # 0.13s 残留碎片
        "[00:10.25]~\n"  # 0.15s 残留碎片
        "[00:10.40]第二句\n"
    )
    assert texts(lines) == ["第一句", "第二句"]


def test_parse_lrc_keeps_ultra_short_long_text():
    """超短但文本 > 2 字的不算碎片，保留（保守规则）"""
    lines = parse_lrc("[00:10.00]第一句\n[00:10.20]啊哈哈\n[00:20.00]第二句\n")
    assert texts(lines) == ["第一句", "啊哈哈", "第二句"]


def test_parse_lrc_does_not_kill_normal_lyrics():
    """保守性：关键词开头但后面直接粘着字的正常歌词不误杀（宁可漏杀不可误杀）"""
    lines = parse_lrc(
        "[00:01.00]词不达意\n[00:02.00]曲终人散\n[00:03.00]唱吧\n[00:04.00]录音棚里写歌\n"
    )
    assert texts(lines) == ["词不达意", "曲终人散", "唱吧", "录音棚里写歌"]


def test_parse_lrc_multi_timestamp_line():
    """同一行多时间戳仍展开为多行，过滤同样生效"""
    lines = parse_lrc("[00:01.00][00:05.00]一句歌词\n[00:03.00]作词：某人\n[00:06.00]另一句\n")
    assert texts(lines) == ["一句歌词", "一句歌词", "另一句"]
