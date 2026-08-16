// 前端 LRC 解析（流媒体/试听歌的在线歌词用）
//
// 本地歌的歌词由后端 /api/lyric 解析（parse_lrc → lines）；非本地歌（无 path）没有对应
// 文件，后端无法解析，这里复用 /api/lyric/search 的候选原文，在前端解析成与后端相同的
// lines 结构：{type:'line', s, e, text:[原文]}（text[1] 罗马音占位空、text[2] 翻译见合并）。

const LRC_TIME_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

/** 解析 LRC 文本 → [{type:'line', s, e, text:[txt]}]（与后端 parse_lrc 同构） */
export function parseLrcText(text) {
  const items = [];
  for (const line of String(text || "")
    .replace(/\r/g, "")
    .split("\n")) {
    const matches = [...line.matchAll(LRC_TIME_RE)];
    if (!matches.length) continue;
    const lyricText = line
      .slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length)
      .trim();
    for (const m of matches) {
      const ms = m[3] || "0";
      const frac = parseInt(ms, 10) * 10 ** (3 - ms.length);
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac / 1000;
      items.push({ t, text: lyricText });
    }
  }
  items.sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const e = i + 1 < items.length ? items[i + 1].t : items[i].t + 5;
    out.push({ type: "line", s: items[i].t, e, text: [items[i].text] });
  }
  return out;
}

/** 合并中文翻译（tlyric LRC）→ text = [原文, "", 翻译]（与后端 merge_translation 同构） */
export function mergeTranslationLines(lines, tlines) {
  if (!tlines || !tlines.length) return lines;
  return lines.map((ln) => {
    if (ln.type !== "line") return ln;
    for (const t of tlines) {
      if (t.type === "line" && Math.abs(t.s - ln.s) <= 0.6) {
        return { ...ln, text: [ln.text[0], "", t.text[0]] };
      }
    }
    return ln;
  });
}
