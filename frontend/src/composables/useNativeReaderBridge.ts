/**
 * Swift 壳桥接（useNativeReaderBridge）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：window.qqplayerNative 壳环境判定（条件启用，浏览器内全部静默 no-op）、
 * 选区状态上报（统一壳桥：webkit postMessage / tauri invoke / 浏览器 noop，状态去重）、
 * 壳系统右键菜单 API 挂载（lookup/highlight/underline/remove/recolor/search/note）、
 * 选区兜底同步（syncSelectionFromDom：系统右键自动选词瞬间 400ms 轮询未跟上时从 iframe 实时读）。
 */
import { computed } from "vue";
import type { Ref } from "vue";
import type {
  BookAnnotations,
  HighlightAnnotation,
  HighlightColor,
  HighlightStyle,
  ReaderSelection,
} from "../books/types";
import { HIGHLIGHT_COLOR_STYLES } from "../books/annotations";
import { useShellBridge } from "./useShellBridge.js";

export function useNativeReaderBridge(options: {
  /** 阅读器容器（Reader 主组件持有；选区兜底同步时查 iframe） */
  containerRef: Ref<HTMLElement | null>;
  /** 当前选中（useSelectionToolbar 持有；晚绑定：壳动作运行时才读取） */
  getCurrentSelection: () => ReaderSelection | null;
  /** 写入当前选中（useSelectionToolbar 持有；晚绑定：syncSelectionFromDom 兜底填充） */
  setCurrentSelection: (sel: ReaderSelection | null) => void;
  /** 标注列表（useAnnotations 持有；晚绑定：findHighlightForSelection 运行时读取） */
  getAnnotations: () => BookAnnotations;
  /** cfi 去 offset 规范化（useAnnotations 持有；晚绑定） */
  cfiPath: (cfi: string) => string;
  /** 当前 epub.js contents（useReaderNavigation 持有；晚绑定） */
  getCurrentContents: () => unknown;
  /** 选区上下文提取（useSelectionToolbar 持有；晚绑定） */
  extractSentence: (text: string, contents: unknown) => string;
  /** 壳菜单动作转发（useSelectionToolbar/useDictLookup 持有；晚绑定） */
  onToolbarLookup: (text: string) => void;
  onToolbarHighlight: (text: string, color: HighlightColor, style?: HighlightStyle) => void;
  onToolbarRemove: () => void;
  onToolbarSearch: (text: string) => void;
  onToolbarNote: (text: string) => void;
  /** 高亮换色（useAnnotations 持有；晚绑定） */
  changeHighlightColor: (h: HighlightAnnotation, color: HighlightColor) => void;
}) {
  /** 壳注入的全局对象：qqplayerNative 环境标记 + webkit 消息桥 + 菜单 API 挂载点 */
  const nativeShell = window as unknown as {
    qqplayerNative?: boolean;
    qqplayerIosBridge?: unknown;
    webkit?: { messageHandlers?: { native?: { postMessage?: (message: unknown) => void } } };
    __qqReaderMenu?: {
      lookup: () => void;
      highlight: (color: HighlightColor) => void;
      underline: () => void;
      remove: () => void;
      recolor: (color: string) => void;
      search: () => void;
      note: () => void;
    };
  };

  /** 是否运行在 Swift 原生壳内（壳注入 window.qqplayerNative；浏览器没有）。
   * 桌面壳（macOS/Windows）有原生右键菜单 → 隐藏 Web 工具栏；
   * iOS 壳无原生选区菜单（系统菜单无法禁用，WebKit bug 244149），Web 工具栏必须保留。 */
  function inNativeShell(): boolean {
    return (
      typeof window !== "undefined" &&
      !!nativeShell.qqplayerNative &&
      !nativeShell.qqplayerIosBridge
    );
  }

  /** 壳内隐藏悬浮工具条（浏览器保留）；选区轮询与 currentSelection 照常维护（壳右键菜单依赖 cfi/context） */
  const isNativeShell = computed(inNativeShell);

  /** iOS 壳标记（qqplayerIosBridge 由壳注入）：选区工具栏遮罩等 iOS 特有逻辑用 */
  const isIOSShell = computed(
    () =>
      typeof window !== "undefined" &&
      !!(window as { qqplayerIosBridge?: unknown }).qqplayerIosBridge,
  );

  /** 已上报给壳的选区状态（去重：仅状态变化时发送，400ms 轮询不重复刷屏） */
  let reportedActive = false;
  let reportedText = "";
  let reportedHasHighlight = false;
  let reportedHighlightStyle: HighlightStyle | null = null;

  /** 当前选中 cfi 是否已有高亮（壳右键菜单「移除高亮」显示条件） */
  function selectionHasHighlight(): boolean {
    return findHighlightForSelection() !== null;
  }

  /** 当前选区已有高亮的样式（壳右键菜单「下划线」勾选态；与 hasHighlight 同源宽松匹配） */
  function selectionHighlightStyle(): HighlightStyle | null {
    return findHighlightForSelection()?.style ?? null;
  }

  /** 按当前选区找高亮条目（换色/移除用）：精确 cfi → 去 offset 的 cfiPath → 文本包含（右键自动选词
   *  选中的单词常落在整句高亮内，cfi 对不上但文本能命中）。无选区/无匹配返回 null。 */
  function findHighlightForSelection(): HighlightAnnotation | null {
    const sel = options.getCurrentSelection();
    if (!sel) return null;
    const hs = options.getAnnotations().highlights;
    return (
      hs.find((h) => h.cfi === sel.cfi) ??
      hs.find((h) => options.cfiPath(h.cfi) === options.cfiPath(sel.cfi)) ??
      (sel.text
        ? (hs.find((h) => h.text && (h.text.includes(sel.text) || sel.text.includes(h.text))) ??
          null)
        : null)
    );
  }

  /** 上报选区状态给壳（统一壳桥：webkit 走 postMessage / tauri 走 invoke / 浏览器 noop）；状态没变化不发，非壳环境静默跳过 */
  function postReaderState(
    active: boolean,
    text: string,
    hasHighlight = false,
    highlightStyle: HighlightStyle | null = null,
  ) {
    if (!inNativeShell()) return;
    if (
      reportedActive === active &&
      reportedText === text &&
      reportedHasHighlight === hasHighlight &&
      reportedHighlightStyle === highlightStyle
    )
      return;
    reportedActive = active;
    reportedText = text;
    reportedHasHighlight = hasHighlight;
    reportedHighlightStyle = highlightStyle;
    try {
      useShellBridge().report({
        type: "readerState",
        active,
        hasSelection: text.length > 0,
        text,
        hasHighlight,
        highlightStyle,
      });
    } catch {
      /* 壳消息发送失败忽略（不影响阅读） */
    }
  }

  /** 壳菜单动作兜底：currentSelection 为空时从 iframe 实时读选区（系统右键自动选词瞬间，
   *  400ms 轮询还没上报，currentSelection 尚未建立）。读到则填充 currentSelection（含 cfi/context），
   *  后续 addHighlight/onToolbarLookup 等以 currentSelection 为数据源的动作即可正常工作。 */
  function syncSelectionFromDom(): boolean {
    if (options.getCurrentSelection()) return true;
    const iframe = options.containerRef.value?.querySelector("iframe");
    const iw = iframe?.contentWindow;
    const sel = iw?.getSelection?.();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
    const text = sel.toString().trim();
    if (!text) return false;
    const contents = options.getCurrentContents();
    if (!contents) return false;
    try {
      const cfi = (contents as { cfiFromRange?: (r: Range) => string }).cfiFromRange?.(
        sel.getRangeAt(0),
      );
      if (!cfi) return false;
      options.setCurrentSelection({
        cfi,
        text,
        context: options.extractSentence(text, contents),
      });
      return true;
    } catch {
      return false;
    }
  }

  /** 挂载全局菜单 API（Swift 点击系统右键菜单项时经 evaluateJavaScript 调用）；卸载时清理 */
  function installNativeMenuApi() {
    nativeShell.__qqReaderMenu = {
      // 查词：复用 onToolbarLookup（currentSelection 为数据源）；无选中时安全 no-op
      lookup: () => {
        syncSelectionFromDom();
        options.onToolbarLookup(options.getCurrentSelection()?.text ?? "");
      },
      // 高亮：复用 onToolbarHighlight；非法颜色回退黄色（壳传 'yellow'|'green'|'blue'|'pink'|'purple'）
      highlight: (color: string) => {
        syncSelectionFromDom();
        const c: HighlightColor = HIGHLIGHT_COLOR_STYLES[color as HighlightColor]
          ? (color as HighlightColor)
          : "yellow";
        options.onToolbarHighlight("", c);
      },
      // 下划线（V4）：选中文字 → underline 标注（落库 red）
      underline: () => {
        syncSelectionFromDom();
        options.onToolbarHighlight("", "yellow", "underline");
      },
      // 移除高亮：选中 cfi 已有高亮时删除该条；无选中/无高亮安全 no-op
      remove: () => {
        syncSelectionFromDom();
        options.onToolbarRemove();
      },
      // 改颜色：已有高亮条目换色（删除重建，色点永远产出底色高亮，iBooks 行为）
      recolor: (color: string) => {
        syncSelectionFromDom();
        const c: HighlightColor = HIGHLIGHT_COLOR_STYLES[color as HighlightColor]
          ? (color as HighlightColor)
          : "yellow";
        const h = findHighlightForSelection();
        if (h) options.changeHighlightColor(h, c);
      },
      // 书内搜索：选中词 → SearchPanel（searchRequest 由 watch 消费）
      search: () => {
        syncSelectionFromDom();
        options.onToolbarSearch(options.getCurrentSelection()?.text ?? "");
      },
      // 笔记：复用 onToolbarNote（openNoteCreate 内部判空）；无选中时安全 no-op
      note: () => {
        syncSelectionFromDom();
        options.onToolbarNote("");
      },
    };
  }

  function uninstallNativeMenuApi() {
    delete nativeShell.__qqReaderMenu;
  }

  return {
    isNativeShell,
    isIOSShell,
    inNativeShell,
    postReaderState,
    selectionHasHighlight,
    selectionHighlightStyle,
    findHighlightForSelection,
    installNativeMenuApi,
    uninstallNativeMenuApi,
  };
}
