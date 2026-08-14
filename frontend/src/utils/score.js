// 匹配度打分：search anything 混合结果排序核心
// 纯函数、零 vue 依赖；与 searchNormalize.js 互通（简繁/声调/全半角归一后比较）
//
// 打分细则（满足 前缀 > 包含 > 不中）：
//   归一化后 text 以 query 开头      → 100（前缀命中）
//   归一化后 text 包含 query（非前缀）→ 50（包含命中）
//   都不中                            → 0
//   完全相等额外 +20（前缀命中特例，总分 120）
// 字段权重（歌名>歌手>专辑）、别名加成（设置项 keywords）由调用方叠加。
import { normalizeQuery, normalizeText } from "./searchNormalize.js";

/**
 * 单字段匹配度：0-120 整数。
 * query 为空 → 0；text 为空 → 0；归一化后前缀/包含/不中。
 */
export function matchScore(query, text) {
  const q = normalizeQuery(query);
  if (!q) return 0;
  const t = normalizeText(text);
  if (!t) return 0;
  if (t === q) return 120; // 完全相等：前缀命中 100 + 完全相等加 20
  if (t.startsWith(q)) return 100;
  if (t.includes(q)) return 50;
  return 0;
}

/**
 * 类别优先级：本地歌曲 > 在线歌曲 > 歌手 > 专辑 > 设置。
 * 同匹配度时按此升序排列（数字小的在前）。
 */
export function kindRank(kind) {
  switch (kind) {
    case "song":
      return 0;
    case "online":
      return 1;
    case "artist":
      return 2;
    case "album":
      return 3;
    case "setting":
      return 4;
    default:
      return 99;
  }
}
