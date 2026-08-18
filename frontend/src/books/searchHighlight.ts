/**
 * 书内搜索临时高亮工具（V4）：纯函数，便于单测。
 *
 * 定位 + 高亮方案（设计决策）：
 * - 临时高亮**不走 epub.js annotations.add / hooks.render 自动重放链路**（那会随每次
 *   relocate 重放成持久标注，污染阅读器）。改为**直接在 iframe document 上操作 DOM**：
 *   用 Range 精确圈住命中词 → `<mark class="qqp-search-hl">` 包住 → 跳转/翻页/关面板时
 *   removeTempMark 解包还原。成本最低、可完全自控生命周期，且不触碰持久标注数据。
 * - 句子定位：epub.js display(cfi) 定位到句子起始后，在该章节 iframe document 里
 *   按「整句原文精确匹配 → 空白归一化匹配 → 单词级大小写不敏感匹配」三级兜底找命中词
 *   （index.json 句子是提纯后的，DOM 里可能有换行/多空格/实体差异）。
 */

/** 临时高亮 mark 的 class（iframe 文档内样式由 ensureTempMarkStyle 注入） */
export const SEARCH_TEMP_CLASS = "qqp-search-hl";

const SEARCH_TEMP_STYLE_ID = "qqp-search-hl-style";

/**
 * 面板展示用：按 matchStart/matchEnd 切片句子。
 * 注意：sentence 可能含首尾空白（index.json 提纯句），展示前 trim 并对齐偏移——
 * lead = 被 trim 掉的前导空白数，matchStart/End 整体前移后 clamp 到 [0, trimmed.length]。
 */
export function highlightParts(
  sentence: string,
  matchStart: number,
  matchEnd: number,
): { before: string; word: string; after: string } {
  const stripped = sentence.trim();
  const lead = sentence.length - sentence.trimStart().length;
  const len = stripped.length;
  const start = Math.max(0, Math.min(matchStart - lead, len));
  const end = Math.max(start, Math.min(matchEnd - lead, len));
  return {
    before: stripped.slice(0, start),
    word: stripped.slice(start, end),
    after: stripped.slice(end),
  };
}

/** 文本节点切片：绝对字符偏移 → 节点（document 顺序拼接全文） */
interface TextSlice {
  node: Text;
  start: number;
  end: number;
}

function collectTextSlices(doc: Document): { slices: TextSlice[]; text: string } {
  const slices: TextSlice[] = [];
  let text = "";
  let abs = 0;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const t = (node as Text).data ?? "";
    slices.push({ node: node as Text, start: abs, end: abs + t.length });
    text += t;
    abs += t.length;
  }
  return { slices, text };
}

/** 空白归一化（连续空白 → 单个空格），并记录每个归一化字符对应的原文偏移 */
function normalizeWhitespace(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const isSpace = /\s/.test(c);
    if (isSpace && prevSpace) continue; // 折叠连续空白
    norm += isSpace ? " " : c;
    map.push(i);
    prevSpace = isSpace;
  }
  return { norm, map };
}

/** 绝对偏移区间 → Range（跨多个文本节点时正确切分） */
function rangeFromOffsets(
  doc: Document,
  slices: TextSlice[],
  start: number,
  end: number,
): Range | null {
  if (end <= start || !slices.length) return null;
  let startNode: Text | null = null;
  let startOff = 0;
  let endNode: Text | null = null;
  let endOff = 0;
  for (const s of slices) {
    if (!startNode && start < s.end) {
      startNode = s.node;
      startOff = Math.max(0, Math.min(start - s.start, s.node.data.length));
    }
    if (end > s.start) {
      endNode = s.node;
      endOff = Math.max(0, Math.min(end - s.start, s.node.data.length));
    }
  }
  if (!startNode || !endNode) return null;
  try {
    const range = doc.createRange();
    range.setStart(startNode, startOff);
    range.setEnd(endNode, endOff);
    return range;
  } catch {
    return null;
  }
}

/**
 * 在文档里定位命中词 Range。
 * 返回 { range, word }；找不到返回 null（调用方 toast，不崩溃）。
 */
export function findSentenceRange(
  doc: Document,
  sentence: string,
  matchStart: number,
  matchEnd: number,
): { range: Range; word: string } | null {
  if (!doc?.body) return null;
  const trimmed = sentence.trim();
  const lead = sentence.length - sentence.trimStart().length;
  const word = sentence.slice(matchStart, matchEnd).trim();
  const { slices, text } = collectTextSlices(doc);
  if (!slices.length) return null;

  // 1) 整句原文精确匹配（DOM 与 index.json 提纯结果一致时最可靠）
  if (trimmed) {
    const idx = text.indexOf(trimmed);
    if (idx >= 0) {
      const start = idx + Math.max(0, matchStart - lead);
      const end = idx + Math.min(trimmed.length, matchEnd - lead);
      if (end > start) {
        const range = rangeFromOffsets(doc, slices, start, end);
        if (range) return { range, word };
      }
    }
  }

  // 2) 空白归一化后整句匹配（DOM 换行/多空格与 index.json 单空格差异的兜底）
  if (trimmed && word) {
    const { norm, map } = normalizeWhitespace(text);
    const normSentence = trimmed.replace(/\s+/g, " ");
    const normWord = word.replace(/\s+/g, " ");
    const sIdx = norm.indexOf(normSentence);
    if (sIdx >= 0 && normWord) {
      const wIdx = normSentence.indexOf(normWord);
      const ws = sIdx + wIdx;
      const we = ws + normWord.length;
      if (we > ws && ws < map.length && we - 1 < map.length) {
        const range = rangeFromOffsets(doc, slices, map[ws], map[we - 1] + 1);
        if (range) return { range, word };
      }
    }
  }

  // 3) 整句找不到（HTML 实体/标签插入等）→ 单词级大小写不敏感匹配
  if (word) {
    const lower = text.toLowerCase();
    const w = word.toLowerCase();
    const idx = lower.indexOf(w);
    if (idx >= 0) {
      const range = rangeFromOffsets(doc, slices, idx, idx + w.length);
      if (range) return { range, word };
    }
  }
  return null;
}

/** 用 <mark> 包住 Range 内容（extractContents + insertNode，跨文本节点安全）；返回 mark 元素 */
export function applyTempMark(range: Range): HTMLElement {
  // Range 必然属于某个文档（iframe document）；ownerDocument 类型为 nullable，运行时恒非空
  const doc = (range.startContainer.ownerDocument ??
    range.commonAncestorContainer.ownerDocument) as Document;
  const mark = doc.createElement("mark");
  mark.className = SEARCH_TEMP_CLASS;
  const frag = range.extractContents();
  mark.appendChild(frag);
  range.insertNode(mark);
  return mark;
}

/** 解包还原 DOM（把 mark 的子节点换回原位）；mark 已不在文档中则视为已随重渲染消失 */
export function removeTempMark(mark: HTMLElement | null): void {
  if (!mark || !mark.isConnected) return;
  const parent = mark.parentNode;
  if (!parent) return;
  const frag = mark.ownerDocument.createDocumentFragment();
  while (mark.firstChild) frag.appendChild(mark.firstChild);
  parent.replaceChild(frag, mark);
}

/** 向 iframe document 注入临时高亮样式（幂等；深色/浅色主题均保证可读） */
export function ensureTempMarkStyle(doc: Document): void {
  if (!doc?.head || doc.getElementById(SEARCH_TEMP_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = SEARCH_TEMP_STYLE_ID;
  style.textContent =
    `mark.${SEARCH_TEMP_CLASS}{background:#f6d32d !important;color:#1f2430 !important;` +
    "border-radius:2px;box-shadow:0 1px 2px rgba(0,0,0,.25);}";
  doc.head.appendChild(style);
}
