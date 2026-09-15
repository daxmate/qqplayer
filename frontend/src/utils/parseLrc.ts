// 前端 LRC 解析（流媒体/试听歌的在线歌词用）
//
// 本地歌的歌词由后端 /api/lyric 解析（parse_lrc → lines）；非本地歌（无 path）没有对应
// 文件，后端无法解析，这里复用 /api/lyric/search 的候选原文，在前端解析成与后端相同的
// lines 结构：{type:'line', s, e, text:[原文]}（text[1] 罗马音 / text[2] 翻译由下方
// 附轨合并函数填入：romalrc → text[1]、tlyric → text[2]；无附轨则不填不占位）。
import type { LyricLine } from "../composables/playerState.js";

const LRC_TIME_RE = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

// 信息行（元信息）保守过滤：关键词开头 + 冒号/空白分隔 + 后面还有内容；
// 如"作词：姚谦""作曲 李宗盛"；"词不达意""曲终人散"等正常歌词不被误杀。
// 与后端 lyrics.py _META_LINE_RE 同构。
const LRC_META_RE =
  /^(?:作词|作曲|编曲|制作人?|原唱|出品|企划|监制|录音|混音|母带|发行|策划|词|曲|唱)(?:\s*[:：]\s*|\s+)\S/;

/** 解析 LRC 文本 → [{type:'line', s, e, text:[txt]}]（与后端 parse_lrc 同构） */
export function parseLrcText(text: string | null | undefined): LyricLine[] {
  const items: { t: number; text: string }[] = [];
  for (const line of String(text || "")
    .replace(/\r/g, "")
    .split("\n")) {
    const matches = [...line.matchAll(LRC_TIME_RE)];
    if (!matches.length) continue;
    const lyricText = line
      .slice(matches[matches.length - 1].index! + matches[matches.length - 1][0].length)
      .trim();
    for (const m of matches) {
      const ms = m[3] || "0";
      const frac = parseInt(ms, 10) * 10 ** (3 - ms.length);
      const t = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac / 1000;
      items.push({ t, text: lyricText });
    }
  }
  items.sort((a, b) => a.t - b.t);
  // 过滤 1/2：空行 + 信息行（与后端 parse_lrc 同构的保守规则，宁可漏杀不可误杀正常歌词）
  const kept = items.filter((it) => {
    const txt = it.text.trim();
    return txt && !LRC_META_RE.test(txt);
  });
  const out: LyricLine[] = [];
  for (let i = 0; i < kept.length; i++) {
    const e = i + 1 < kept.length ? kept[i + 1].t : kept[i].t + 5;
    // 过滤 3：超短行（duration < 0.3s 且文本 <= 2 字，如 0.13s 的残留碎片/标点残行）
    if (e - kept[i].t < 0.3 && kept[i].text.trim().length <= 2) continue;
    out.push({ type: "line", s: kept[i].t, e, text: [kept[i].text] });
  }
  return out;
}

/** 附轨在 text 数组中的槽位（**唯一事实源**，与后端 backend/app/services/lyrics.py
 *  的 ATTACH_TRACK_SLOTS 同构）：text = [原文, 罗马音(romalrc), 中文翻译(tlyric)] */
export const LYRIC_ROMA_SLOT = 1;
export const LYRIC_ZH_SLOT = 2;

/** 把一条附轨（已解析的 LRC 行）按时间戳（±0.6s）填进 text[slot]
 *
 * 只写自己的槽位，其余槽位原样保留（附轨之间互不覆盖，合并顺序无关）；
 * 数组不足则补空串。无附轨行 / 无匹配行 → 原样返回（不占位）。
 * 两条附轨共用这一个实现（见下方两个导出包装）。
 */
function mergeAttachLines(lines: LyricLine[], tlines: LyricLine[], slot: number): LyricLine[] {
  if (!tlines || !tlines.length) return lines;
  return lines.map((ln) => {
    if (ln.type !== "line") return ln;
    for (const t of tlines) {
      if (t.type === "line" && Math.abs(t.s - ln.s) <= 0.6) {
        const text = ln.text.slice();
        while (text.length < slot + 1) text.push("");
        text[slot] = t.text[0];
        return { ...ln, text };
      }
    }
    return ln;
  });
}

/** 合并中文翻译（tlyric LRC）→ text[2]（与后端 merge_translation 同构） */
export function mergeTranslationLines(lines: LyricLine[], tlines: LyricLine[]): LyricLine[] {
  return mergeAttachLines(lines, tlines, LYRIC_ZH_SLOT);
}

/** 合并罗马音（romalrc LRC）→ text[1]（与后端 merge_translation 同构） */
export function mergeRomaLines(lines: LyricLine[], tlines: LyricLine[]): LyricLine[] {
  return mergeAttachLines(lines, tlines, LYRIC_ROMA_SLOT);
}
