"""歌词解析服务：SRT/LRC 解析、中文翻译合并、AI 对齐 LRC 序列化。"""

import re


def parse_srt(text: str):
    """解析 srt -> 段落/句子混合列表
    块内以 # 开头的行作为段落标题（type: sec），时间行后的文本作为句子（type: line）
    句子文本支持 1~3 行：原文 / 罗马音 / 中文
    """
    blocks = re.split(r"\n\s*\n", text.replace("\r", ""))
    result = []
    for block in blocks:
        lines = [x.strip() for x in block.split("\n") if x.strip()]
        if not lines:
            continue
        # 分离块内标题行和内容行（即使标题和句子粘在同一块也能拆开）
        sec_lines = [x for x in lines if x.startswith("#") and "-->" not in x]
        content = [x for x in lines if not (x.startswith("#") and "-->" not in x)]
        for sl in sec_lines:
            result.append({"type": "sec", "name": sl.lstrip("#").strip()})
        if not content:
            continue
        time_idx = -1
        for i, ln in enumerate(content):
            if "-->" in ln:
                time_idx = i
                break
        if time_idx < 0:
            continue
        m = re.match(
            r"(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.]?(\d{0,3})",
            content[time_idx],
        )
        if not m:
            continue

        def sec(h, mm, s, ms):
            return int(h) * 3600 + int(mm) * 60 + int(s) + int(ms or 0) / 1000

        result.append(
            {
                "type": "line",
                "s": sec(m[1], m[2], m[3], m[4]),
                "e": sec(m[5], m[6], m[7], m[8]),
                "text": content[time_idx + 1 :],
            }
        )
    return result


def parse_lrc(text: str):
    """解析 lrc -> 句子列表（无段落，type 统一为 line）"""
    result = []
    pattern = re.compile(r"\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]")
    items = []
    for line in text.replace("\r", "").split("\n"):
        matches = list(pattern.finditer(line))
        if not matches:
            continue
        lyric_text = line[matches[-1].end() :].strip()
        for m in matches:
            ms = m.group(3) or "0"
            ms = int(ms) * (10 ** (3 - len(ms)))
            t = int(m.group(1)) * 60 + int(m.group(2)) + ms / 1000
            items.append((t, lyric_text))
    items.sort(key=lambda x: x[0])
    for i, (t, txt) in enumerate(items):
        e = items[i + 1][0] if i + 1 < len(items) else t + 5
        result.append({"type": "line", "s": t, "e": e, "text": [txt]})
    return result


def merge_translation(lines: list, tlyric_text: str | None):
    """把网易云中文翻译（tlyric LRC）按时间戳合并进主歌词行
    约定 text = [原文, 罗马音(空), 中文翻译]（与前端 KaraokePanel/LyricPanel 渲染位一致）
    """
    if not tlyric_text:
        return lines
    tlines = [t for t in parse_lrc(tlyric_text) if t.get("text")]
    if not tlines:
        return lines
    result = []
    for ln in lines:
        if ln["type"] == "line":
            for t in tlines:
                if abs(t["s"] - ln["s"]) <= 0.6:
                    ln = {**ln, "text": [ln["text"][0], "", t["text"][0]]}
                    break
        result.append(ln)
    return result


def _align_to_lrc(sentences: list) -> str:
    """align json 的 sentences（[{start, end, text}]）→ LRC 字符串 [mm:ss.xx]text 每行"""
    lines = []
    for s in sentences:
        try:
            start = float(s.get("start") or 0)
        except (TypeError, ValueError):
            continue
        line_text = (s.get("text") or "").strip()
        if not line_text:
            continue
        total_cs = int(round(start * 100))
        mm, rem = divmod(total_cs, 6000)
        ss, cs = divmod(rem, 100)
        lines.append(f"[{mm:02d}:{ss:02d}.{cs:02d}]{line_text}")
    return "\n".join(lines)
