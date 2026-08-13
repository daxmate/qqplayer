// 搜索归一化层：简繁互通 + 声调剥离 + 全半角归一 + 小写
// 纯函数、零组件依赖、零运行时副作用，供 Playlist 与未来全局搜索（search anywhere）复用。
import { sify } from "chinese-conv";

// 全角 ASCII（！～）与全角空格（U+3000）
const FULLWIDTH_RE = /[\uFF01-\uFF5E\u3000]/g;
// NFD 分解后残留的组合变音标记（é → e + U+0301，ā → a + U+0304，ü → u + U+0308）
const COMBINING_MARKS_RE = /[\u0300-\u036f]/g;

/**
 * 归一化单个文本（供每行匹配用）：
 * NFD 分解 → 剥离组合变音标记 → 全角转半角 → 繁转简 → 小写。
 * 空值统一返回 ""。
 */
export function normalizeText(text) {
  if (!text) return "";
  return sify(
    String(text)
      .normalize("NFD")
      .replace(FULLWIDTH_RE, (ch) =>
        ch === "\u3000" ? " " : String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
      ),
  )
    .replace(COMBINING_MARKS_RE, "")
    .toLowerCase();
}

/**
 * 查询串归一化：去首尾空白 + normalizeText。
 * 供输入框查询变化时归一化一次，避免每行重复归一化同一 query。
 */
export function normalizeQuery(query) {
  return normalizeText(query == null ? "" : String(query).trim());
}

/**
 * 归一化后包含匹配。空 query 恒为 false（"无查询 → 无匹配"），
 * 调用方需自行保证空查询显示全部（Playlist 现有逻辑已如此）。
 */
export function matchQuery(text, query) {
  const q = normalizeQuery(query);
  if (!q) return false;
  return normalizeText(text).includes(q);
}
