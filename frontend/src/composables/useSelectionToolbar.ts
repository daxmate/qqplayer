/**
 * 选区工具栏（useSelectionToolbar）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：选中状态（currentSelection/toolbar/searchRequest）、选区轮询定时器
 * （WKWebView 兜底：selectionchange 在 WebKit 不可靠，400ms 主动轮询）、
 * 工具栏动作入口（高亮/搜索/移除/笔记，行为矩阵转发 useAnnotations）。
 */
import { computed, reactive, ref } from "vue";
import type { Ref, ShallowRef } from "vue";
import type { Rendition } from "epubjs";
import type {
  BookAnnotations,
  HighlightAnnotation,
  HighlightColor,
  HighlightStyle,
  ReaderSelection,
} from "../books/types";

export function useSelectionToolbar(options: {
  /** 定位基准（相对 .reader 根，px） */
  rootRef: Ref<HTMLElement | null>;
  containerRef: Ref<HTMLElement | null>;
  renditionRef: ShallowRef<Rendition | null>;
  /** 标注列表（useAnnotations；computed 直接依赖，须传真 ref） */
  annotations: Ref<BookAnnotations>;
  /** 宽松匹配找当前选区高亮（useNativeReaderBridge；Reader 未拆前为内部函数） */
  findHighlightForSelection: () => HighlightAnnotation | null;
  /** 壳选区状态上报（useNativeReaderBridge；Reader 未拆前为内部函数） */
  postReaderState: (
    active: boolean,
    text: string,
    hasHighlight?: boolean,
    highlightStyle?: HighlightStyle | null,
  ) => void;
  selectionHasHighlight: () => boolean;
  selectionHighlightStyle: () => HighlightStyle | null;
  /** 当前 epub.js contents（useReaderNavigation；Reader 未拆前为内部函数） */
  getCurrentContents: () => unknown;
  /** 收起点击高亮菜单（useAnnotations） */
  closeHighlightMenu: () => void;
  /** 标注动作（useAnnotations） */
  addHighlight: (color: HighlightColor, style?: HighlightStyle) => void;
  removeHighlight: (id: string) => void;
  toggleHighlightStyle: (h: HighlightAnnotation) => void;
  changeHighlightColor: (h: HighlightAnnotation, color: HighlightColor) => void;
  openNoteCreate: () => void;
}) {
  /** 选中工具栏位置（相对 .reader 根，px） */
  const toolbar = reactive({ x: 0, y: 0, visible: false });
  /** 工具栏锁定（iOS：弹出后自动收起选区隐藏手柄，期间选区收起不隐藏工具栏；操作后解除） */
  let toolbarLocked = false;
  /** 当前选中（工具栏操作的数据源；工具栏收起时保留到操作完成） */
  const currentSelection = ref<ReaderSelection | null>(null);

  /** 书内搜索请求（V4）：菜单"搜索"只写这个 ref；SearchPanel 由搜索子代理挂载并 watch（本文件不建面板） */
  const searchRequest = ref<string | null>(null);

  /** 选中 cfi 是否已有高亮（工具栏"移除"项显示条件；与 addHighlight 的重复判断同思路） */
  const toolbarHasHighlight = computed(() => {
    const sel = currentSelection.value;
    return sel ? options.annotations.value.highlights.some((h) => h.cfi === sel.cfi) : false;
  });

  /** 当前选区已有高亮（工具栏 active 态数据源：色点/U 亮起；宽松匹配，与壳上报/移除/换色同源） */
  const toolbarHighlight = computed(() => {
    const sel = currentSelection.value;
    return sel ? options.findHighlightForSelection() : null;
  });

  /** 工具栏色点激活色：选中已有底色高亮时传其颜色；下划线/无高亮 → null（red 只属于下划线） */
  const toolbarColor = computed<HighlightColor | null>(() => {
    const h = toolbarHighlight.value;
    return h && h.style === "highlight" && h.color !== "red" ? h.color : null;
  });

  function hideToolbar() {
    toolbar.visible = false;
    toolbarLocked = false;
  }

  /** 清空 iframe 选区 + 收起工具栏（工具栏操作后调用） */
  function clearSelection() {
    hideToolbar();
    try {
      const contents = options.renditionRef.value?.getContents?.();
      const list = contents ? (Array.isArray(contents) ? contents : [contents]) : [];
      for (const c of list) {
        c.window?.getSelection?.()?.removeAllRanges();
      }
    } catch {
      /* 清选区失败不影响主流程 */
    }
    currentSelection.value = null;
    options.postReaderState(true, ""); // 壳右键菜单：选区已清（去重：仅状态变化时发送）
  }

  /** 选区收起（selectionchange）→ 收起工具栏；同一函数引用重复 add 自动去重。
   * 工具栏锁定（选区已自动收起）时忽略，防收起动作本身把工具栏关掉。 */
  function onContentsSelectionChange(e: Event) {
    if (toolbarLocked && toolbar.visible) return;
    const doc = e.target as Document;
    const sel = doc.defaultView?.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) hideToolbar();
  }

  /** 选中句子提取：选区在全文中的前后句边界（查词/生词本 context 用） */
  function extractSentence(text: string, contents: unknown): string {
    try {
      const c = contents as { document?: { body?: { innerText?: string; textContent?: string } } };
      const full = c.document?.body?.innerText ?? c.document?.body?.textContent ?? "";
      const i = full.indexOf(text);
      if (i < 0) return text.slice(0, 200);
      let start = i;
      while (start > 0 && !/[.!?。！？…\n]/.test(full[start - 1])) start--;
      let end = i + text.length;
      while (end < full.length && !/[.!?。！？…\n]/.test(full[end])) end++;
      if (end < full.length) end++; // 带上结尾标点
      return full.slice(start, end).trim().slice(0, 300);
    } catch {
      return text.slice(0, 200);
    }
  }

  /**
   * WKWebView 兜底（终极方案）：事件链路在 WebKit 里全部不可靠（selectionchange
   * 不触发、iframe document 监听器收不到事件、跨 frame 冒泡捕获不到），改主动轮询：
   * 每 400ms 读一次 epub.js iframe 的选区，有选中文字就显示工具栏（走 onSelected），
   * 选区消失则收起。不依赖任何事件，只要选区存在就能工作。
   */
  let selPollTimer: number | null = null;
  /** 轮询稳定判断：拖选过程中选区持续变化，连续 N 次相同才视为拖选完成（鼠标已释放） */
  let selPollLastText = "";
  let selPollStableCount = 0;
  /** 需要连续几次轮询选区相同才弹工具条（400ms/次，2 次 ≈ 800ms） */
  const SEL_POLL_STABLE = 2;
  function stopSelPolling() {
    if (selPollTimer !== null) {
      clearInterval(selPollTimer);
      selPollTimer = null;
    }
  }

  function startSelPolling() {
    stopSelPolling();
    selPollTimer = window.setInterval(pollSelection, 400);
  }

  function pollSelection() {
    const iframe = options.containerRef.value?.querySelector("iframe");
    const iw = iframe?.contentWindow;
    const sel = iw?.getSelection?.();
    if (!sel) return;
    const text = sel.toString().trim();
    options.postReaderState(
      true,
      text,
      options.selectionHasHighlight(),
      options.selectionHighlightStyle(),
    ); // 壳右键菜单：选区状态变化时上报（去重：文本/高亮态没变不重复发）
    if (sel.isCollapsed || sel.rangeCount === 0 || !text) {
      // 无选区：重置稳定计数 + 收起工具栏（工具栏锁定期间保持，iOS 自动收起选区后不隐藏）
      selPollLastText = "";
      selPollStableCount = 0;
      if (toolbar.visible && toolbarLocked) return;
      if (toolbar.visible) hideToolbar();
      return;
    }
    if (text !== selPollLastText) {
      // 选区在变化（拖选中）→ 记录并等待稳定
      selPollLastText = text;
      selPollStableCount = 1;
      return;
    }
    selPollStableCount++;
    if (selPollStableCount < SEL_POLL_STABLE) return;
    // 选区已稳定（鼠标释放）→ 同一选区已处理过则跳过
    if (currentSelection.value?.text === text) return;
    const contents = options.getCurrentContents();
    if (!contents) return;
    try {
      const cfi = (contents as { cfiFromRange?: (r: Range) => string }).cfiFromRange?.(
        sel.getRangeAt(0),
      );
      if (cfi) onSelected(cfi, contents);
    } catch {
      /* 轮询 CFI 生成失败忽略 */
    }
  }

  /** epub.js selected 事件（选区非空，250ms 防抖后触发）：定位工具栏 + 记录选中 */
  function onSelected(cfi: string, contents: unknown) {
    const c = contents as { window?: Window };
    const sel = c.window?.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const rangeRect = sel.getRangeAt(0).getBoundingClientRect();
    const iframe = options.containerRef.value?.querySelector("iframe");
    const root = options.rootRef.value;
    if (!iframe || !root) return;
    const iframeRect = iframe.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    toolbar.x = iframeRect.left + rangeRect.left + rangeRect.width / 2 - rootRect.left;
    // iOS 系统“拷贝链接”胶囊固定显示在选区上方（WebKit 无法禁用，见 bug 244149），
    // 工具栏改挂选区下方避免被盖住（2026-08-23 阶段4）
    toolbar.y = iframeRect.top + rangeRect.bottom - rootRect.top + 12;
    toolbar.visible = true;
    toolbarLocked = false;
    options.closeHighlightMenu(); // 新选区优先：收起点击高亮菜单
    currentSelection.value = { cfi, text, context: extractSentence(text, contents) };
    options.postReaderState(
      true,
      text,
      options.selectionHasHighlight(),
      options.selectionHighlightStyle(),
    ); // 壳：选区稳定后补发精确 hasHighlight/highlightStyle（轮询首拍可能滞后）
    // 挂载选区收起监听（contents 每次新建都会触发 selected，函数引用去重）
    (contents as { document?: Document }).document?.addEventListener(
      "selectionchange",
      onContentsSelectionChange,
    );
    // iOS 壳：选区手柄（原生蓝色圆点）会叠在工具栏上/旁（无 API 单独禁用），
    // 工具栏弹出后立即收起选区隐藏手柄；先锁定工具栏防选区收起事件把它关掉（2026-08-23）
    if (
      typeof window !== "undefined" &&
      (window as { qqplayerIosBridge?: unknown }).qqplayerIosBridge
    ) {
      toolbarLocked = true;
      requestAnimationFrame(() => {
        try {
          (contents as { window?: Window }).window?.getSelection()?.removeAllRanges();
        } catch {
          /* 收起失败不影响 */
        }
      });
    }
  }

  // ---- 工具栏动作 ----
  /**
   * 工具栏/壳菜单统一入口（行为矩阵，iBooks 契约）：
   * - 无已有标注 → 新建（色点 = 底色高亮，U = 下划线）
   * - 点 U：已有下划线 → 移除（toggle off）；已有底色 → 转下划线
   * - 点色点 C：已有同色底色 → 移除（toggle off）；已有异色 → 换色；已有下划线 → 转底色
   * 复用 findHighlightForSelection 宽松匹配，杜绝"已有标注仍新建"（原 bug 根因）。
   */
  function onToolbarHighlight(_text: string, color: HighlightColor, style?: HighlightStyle) {
    const existing = options.findHighlightForSelection();
    if (!existing) {
      options.addHighlight(color, style ?? "highlight");
      return;
    }
    if (style === "underline") {
      // 点 U
      if (existing.style === "underline") options.removeHighlight(existing.id);
      else options.toggleHighlightStyle(existing);
      return;
    }
    // 点色点
    if (existing.style === "highlight" && existing.color === color)
      options.removeHighlight(existing.id);
    else options.changeHighlightColor(existing, color);
  }

  /** 书内搜索：只写 searchRequest（SearchPanel 由搜索子代理挂载并 watch 该 ref） */
  function onToolbarSearch(text: string) {
    searchRequest.value = text;
  }

  /** 移除：选中 cfi 已有高亮时删除该条（宽松匹配，hasHighlight 显示条件同源） */
  function onToolbarRemove() {
    const h = options.findHighlightForSelection();
    if (h) options.removeHighlight(h.id);
  }

  function onToolbarNote(_text: string) {
    void _text; // 事件 payload 兼容（SelectionToolbar 统一发 text）；创建笔记不需要文本
    options.openNoteCreate();
  }

  return {
    toolbar,
    currentSelection,
    searchRequest,
    toolbarHasHighlight,
    toolbarHighlight,
    toolbarColor,
    hideToolbar,
    clearSelection,
    extractSentence,
    stopSelPolling,
    startSelPolling,
    onSelected,
    onToolbarHighlight,
    onToolbarSearch,
    onToolbarRemove,
    onToolbarNote,
  };
}
