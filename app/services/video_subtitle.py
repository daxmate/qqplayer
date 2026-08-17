"""字幕解析服务：本地视频同名字幕（SRT / VTT）→ 时间戳字幕 JSON。

- 解析规则：只取时间戳行 + 其后文本行；SRT 序号、VTT 头部/STYLE/NOTE 等忽略
- 时间戳统一转秒浮点（SRT 逗号 `00:00:10,000` 与 VTT 点号 `00:00:10.000` 都支持）
- translation 字段本轮恒为 None（双语字幕解析留待后续，需明确格式约定）
"""

import re
from pathlib import Path

# 时间戳：可选小时 `HH:MM:SS[,.]mmm`，也兼容 `MM:SS[,.]mmm`；毫秒可 1~3 位
_TS_RE = re.compile(r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})")
# cue 行：起止时间戳，中间必须带 -->（允许 VTT cue 尾部设置，如 align:start）
_CUE_RE = re.compile(
    r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*"
    r"(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})"
)
# VTT 结构行（cue 文本外出现时跳过；STYLE 块在首个 cue 前，序号无影响）
_VTT_IGNORE_PREFIXES = (
    "WEBVTT",
    "NOTE",
    "STYLE",
    "REGION",
    "X-TIMESTAMP-MAP",
    "Kind:",
    "Language:",
)


def _parse_ts(text: str) -> float | None:
    """时间戳字符串 → 秒浮点；解析失败返回 None"""
    m = _TS_RE.search(text)
    if not m:
        return None
    h, mi, s, ms = m.groups()
    hours = int(h) if h else 0
    return hours * 3600 + int(mi) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def parse_subtitle_text(text: str) -> list[dict]:
    """解析 SRT/VTT 文本 → [{start, end, text, translation}]（translation 恒 None）

    按行扫描：空行结束当前 cue；cue 行（含 -->）开启新 cue 并解析起止；
    其余行若处于 cue 内则作为文本累积。无有效 cue 返回空列表。
    """
    items: list[dict] = []
    current: dict | None = None  # {"start": float, "end": float, "lines": [str]}

    def flush() -> None:
        nonlocal current
        if current is not None and current["lines"]:
            items.append(
                {
                    "start": current["start"],
                    "end": current["end"],
                    "text": "\n".join(current["lines"]),
                    "translation": None,
                }
            )
        current = None

    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            flush()
            continue
        m = _CUE_RE.search(line)
        if m:
            # 上一 cue 未以空行收尾（文件尾/紧邻 cue）先落盘
            flush()
            start = _parse_ts(m.group(0).split("-->")[0])
            end = _parse_ts(m.group(0).split("-->")[1])
            if start is not None and end is not None:
                current = {"start": start, "end": end, "lines": []}
            continue
        if current is None:
            continue
        if line.startswith(_VTT_IGNORE_PREFIXES):
            continue
        current["lines"].append(line)
    flush()
    return items


def parse_subtitle_file(path: Path) -> list[dict]:
    """读取字幕文件并解析：UTF-8（容忍 BOM）→ GBK（常见中文 SRT）→ 替换模式兜底"""
    p = Path(path)
    try:
        text = p.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = p.read_text(encoding="gbk")
        except (UnicodeDecodeError, LookupError):
            try:
                text = p.read_text(encoding="utf-8", errors="replace")
            except OSError:
                return []
    except OSError:
        return []
    return parse_subtitle_text(text)
