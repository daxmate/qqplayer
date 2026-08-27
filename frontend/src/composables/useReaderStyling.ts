/**
 * 阅读器样式注入（useReaderStyling）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：阅读设置应用到 epub.js（themes.override 作用到 iframe body 的 inline 样式）+
 * 内容 iframe 样式注入（字体强覆盖 / 禁右键菜单 / 去链接语义 / touch-callout）+
 * 设置变化 watch（即时应用 + 页边距变化时容器尺寸跟随）。
 */
import { computed, watch } from "vue";
import type { ShallowRef } from "vue";
import type { Rendition } from "epubjs";
import type { ReaderSettings } from "../books/types";
import {
  READER_SETTINGS_DEFAULTS,
  readerFontCss,
  resolveReaderThemeColors,
} from "../books/settings";
import { uiSettings } from "./useSettings.js";

export function useReaderStyling(options: {
  renditionRef: ShallowRef<Rendition | null>;
  /** 阅读设置（useReaderSettings 持有；reactive，watch 直接依赖） */
  readerSettings: ReaderSettings;
  /** 窗口/容器尺寸跟随（Reader 主组件持有；页边距变化时调用） */
  onResize: () => void;
}) {
  const { renditionRef, readerSettings, onResize } = options;

  /** 字体注入 style 的 id（hooks.content 每次内容加载时应用；applyReaderSettings 时对当前内容手动应用） */
  const FONT_STYLE_ID = "qqp-reader-font";

  /**
   * 字体族注入：themes.font() 只把 font-family 设在 documentElement（html）上，EPUB 内部
   * CSS 对 body/段落的显式 font-family 会覆盖继承值 → 点字体不生效。改用注入
   * `body, body * { font-family: <css> !important }` 强覆盖（iBooks 等阅读器同类做法）。
   * default（空 CSS）→ 移除注入，恢复 EPUB 原字体。
   */
  function applyFontToContents(contents: { document?: Document }) {
    const doc = contents.document;
    if (!doc) return;
    doc.getElementById(FONT_STYLE_ID)?.remove();
    const css = readerFontCss(readerSettings.fontFamily);
    if (!css) return;
    const style = doc.createElement("style");
    style.id = FONT_STYLE_ID;
    style.textContent = `body, body * { font-family: ${css} !important; }`;
    doc.head.appendChild(style);
  }

  /**
   * 禁 EPUB 内容 iframe 内浏览器默认右键菜单（EPUB 正文只读，右键应弹自定义菜单/无菜单；
   * input/textarea/[contenteditable] 保留系统菜单）。iframe 内 contextmenu 不冒泡到父页面，
   * 必须挂在内容 document 上（走 hooks.content 注入，换章重建 iframe 后自动重新挂）。
   * 注意：处理器是父 realm 函数、事件来自 iframe realm，e.target instanceof Element 会判错，
   * 用 realm 无关的 .closest 方法判断（同 onTapClick 的写法）。
   */
  function blockNativeContextMenu(contents: { document?: Document }) {
    const doc = contents.document;
    if (!doc) return;
    doc.addEventListener(
      "contextmenu",
      (e: Event) => {
        const t = (e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable]");
        if (!t) e.preventDefault();
      },
      true,
    );
  }

  /**
   * 章节内容去链接语义（2026-08-23 阶段4）：<a> → <span>（保留子节点与 class）。
   * 原因：iOS WKWebView 选区包含 <a> 时，系统编辑菜单自动加“拷贝链接”项（绕过
   * canPerformAction），盖住 Web 选区工具栏；阅读器导航走顶栏目录/epubjs cfi，
   * 正文内链接无功能依赖，去掉后选区工具栏独占交互。
   */
  function stripContentLinks(contents: { document?: Document }) {
    const doc = contents.document;
    if (!doc) return;
    try {
      doc.querySelectorAll("a").forEach((a) => {
        const span = doc.createElement("span");
        if (a.className) span.className = a.className;
        while (a.firstChild) span.appendChild(a.firstChild);
        a.replaceWith(span);
      });
    } catch {
      /* 内容处理失败不影响阅读 */
    }
  }

  /**
   * iframe 内容注入 -webkit-touch-callout: none（2026-08-23 阶段4）：
   * iOS 选区菜单里的“拷贝高亮标记的链接”胶囊是 WebKit 的 touch callout 行为，
   * 全局 CSS 只作用于主文档，epub 章节在 iframe 内需要单独注入；
   * 禁掉后选区交互只保留 Web 工具栏（五色点/查词/笔记/搜索/拷贝）。
   */
  function applyNoTouchCallout(contents: { document?: Document }) {
    const doc = contents.document;
    if (!doc || !doc.head) return;
    try {
      if (doc.getElementById("__qq_no_touch_callout")) return;
      const style = doc.createElement("style");
      style.id = "__qq_no_touch_callout";
      style.textContent =
        "html, body, * { -webkit-touch-callout: none !important; }\n" +
        // 水平手势归 JS（滑动翻页）；保留垂直滚动
        "html, body { touch-action: pan-y !important; }";
      doc.head.appendChild(style);
    } catch {
      /* 样式注入失败不影响阅读 */
    }
  }

  /**
   * 高亮位置重算：marks-pane 的 SVG 矩形只在 epubjs reframe（尺寸变化）时重算，
   * 字体/字号/行距等设置变化引起的内容重排不会触发 → 高亮错位。设置应用后手动
   * 对所有 view 的 pane 重算一次（pane.render 内部遍历 mark 重新 getBoundingClientRect）。
   */
  function refreshMarks() {
    const rendition = renditionRef.value;
    if (!rendition) return;
    try {
      (rendition as { views?: () => Array<{ pane?: { render?: () => void } }> })
        .views?.()
        ?.forEach((v) => v.pane?.render?.());
    } catch {
      /* 高亮重算失败不影响阅读 */
    }
  }

  function applyReaderSettings() {
    const rendition = renditionRef.value;
    if (!rendition) return;
    const themes = rendition.themes;
    const s = readerSettings;
    // 字体族：注入 body * !important 覆盖（见 applyFontToContents）；default → 移除注入
    try {
      const cs = rendition.getContents();
      const list = (Array.isArray(cs) ? cs : cs ? [cs] : []) as { document?: Document }[];
      list.forEach(applyFontToContents);
    } catch {
      /* 内容未就绪时忽略（hooks.content 会在加载后自动应用） */
    }
    // 字号（百分比，相对 iframe 默认字号）
    themes.fontSize(s.fontSize + "%");
    // 行距（body 无单位值，子元素按倍数继承）
    themes.override("line-height", String(s.lineHeight));
    // 粗体开关：只覆盖 body 字重（EPUB 自带 heading 等显式样式不受影响）；关 → 空值移除覆盖
    themes.override("font-weight", s.bold ? "700" : "");
    // 主题色：预设 + textColor/bgColor 自定义覆盖；!important 压过 EPUB 自带 body 样式
    const { text, bg } = resolveReaderThemeColors(s);
    themes.override("color", text, true);
    themes.override("background", bg, true);
    // 页边距不在这里做：epub.js 分页布局（columns()）会强制写 body padding-left/right !important，
    // themes.override 会被覆盖。改为容器 padding（readerContainerStyle）+ renderTo/resize 用内容盒尺寸。
    // 内容重排（字体/字号/行距等）后高亮 SVG 位置需重算
    refreshMarks();
  }

  // 页边距：容器 padding（iframe 外部，不受 epub.js 内部布局影响）
  const readerContainerStyle = computed(() => ({ padding: `${readerSettings.margin}px` }));
  // 页边距变化时 iframe 尺寸跟随（容器 padding 改变 → 内容盒宽度改变）
  let lastMargin = READER_SETTINGS_DEFAULTS.margin;

  // 阅读设置变化 → 即时应用到当前渲染（保存走 onSettingsPatch 的防抖）
  watch(
    () => ({ ...readerSettings }),
    () => {
      applyReaderSettings();
      if (readerSettings.margin !== lastMargin) {
        lastMargin = readerSettings.margin;
        onResize();
      }
    },
  );

  // App 主题变化 → 阅读主题 auto 时需重算（非 auto 重跑无副作用）
  watch(
    () => uiSettings.theme,
    () => applyReaderSettings(),
  );

  return {
    applyReaderSettings,
    applyFontToContents,
    blockNativeContextMenu,
    stripContentLinks,
    applyNoTouchCallout,
    readerContainerStyle,
  };
}
