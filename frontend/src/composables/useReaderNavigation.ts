/**
 * 阅读器翻页 / 点击热区 / 滑动（useReaderNavigation）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：prev/next 翻页（epubjs rendition）、点击热区（iframe 内 mousedown/click 按坐标
 * 判左右 22% 翻页，拖选/链接/选区不翻页）、高亮点击反查（findMarkAt → openHighlightMenu）、
 * iOS 原生滑动翻页事件订阅（UISwipeGestureRecognizer → native swipe 事件）。
 */
import type { Ref, ShallowRef } from "vue";
import type { Rendition } from "epubjs";
import type { BookAnnotations } from "../books/types";
import { onNativeEvent } from "./nativeAudioBridge.js";

/** 点击高亮菜单状态（useAnnotations.hlMenu 的结构） */
interface HighlightMenuState {
  x: number;
  y: number;
  visible: boolean;
  id: string | null;
}

/** 选区工具栏状态（useSelectionToolbar.toolbar 的结构） */
interface ToolbarState {
  x: number;
  y: number;
  visible: boolean;
}

export function useReaderNavigation(options: {
  renditionRef: ShallowRef<Rendition | null>;
  containerRef: Ref<HTMLElement | null>;
  bodyRef: Ref<HTMLElement | null>;
  /** 标注列表（useAnnotations 持有；openHighlightMenu 运行时读取） */
  annotations: Ref<BookAnnotations>;
  /** 点击高亮菜单（useAnnotations 持有；openHighlightMenu 定位/显示） */
  hlMenu: HighlightMenuState;
  /** 收起点击高亮菜单（useAnnotations） */
  closeHighlightMenu: () => void;
  /** 选区工具栏（useSelectionToolbar 持有；晚绑定：onTapClick 点外部收起） */
  getToolbar: () => ToolbarState;
  /** 收起选区工具栏（useSelectionToolbar；晚绑定） */
  hideToolbar: () => void;
}) {
  // ============ 翻页 ============
  function prevPage() {
    options.renditionRef.value?.prev();
  }

  function nextPage() {
    options.renditionRef.value?.next();
  }

  // ============ 翻页热区（iframe 内事件，不再用透明按钮盖住 iframe） ============
  // 原实现：左右各 22% 透明 button（z-index 2）盖住 epubjs iframe → 左右边缘文字无法拖选。
  // 现方案：epubjs Contents 把 iframe 内 DOM 事件（mousedown/click）转发成 contents 事件，
  // 直接在 iframe document 上监听：click 按坐标判断左右 22% 翻页；拖选（位移 > 阈值或非空选区）不翻页。
  const TAP_EDGE_RATIO = 0.22; // 左右热区各占容器宽度比例（与原 .reader-tap 一致）
  const TAP_DRAG_THRESHOLD = 8; // px：mousedown→click 位移超过视为拖选而非点击
  /** 当前挂了翻页监听的 contents（epubjs 翻页会重建 contents，relocated 后重新挂，防重复挂载） */
  let tapContents: unknown = null;
  let tapDownX = 0;
  let tapDownY = 0;

  function getCurrentContents(): unknown {
    const rendition = options.renditionRef.value;
    // 单测 mock 可能没有 views 方法（08-18 坑：诊断逻辑别碰 mock 缺失的 API）
    if (!rendition || typeof (rendition as { views?: unknown }).views !== "function") return null;
    let contents: unknown = null;
    (rendition as { views: () => Array<{ contents?: unknown }> }).views().forEach((v) => {
      const vc = (v as { contents?: unknown }).contents;
      if (vc) contents = vc;
    });
    return contents;
  }

  function attachTapHandlers() {
    const contents = getCurrentContents();
    if (!contents || contents === tapContents) return;
    detachTapHandlers();
    const doc = (contents as { document?: Document }).document;
    // 内容未就绪时不设 tapContents（否则永不重挂），等 relocated/下一次调用重试
    if (!doc) return;
    tapContents = contents;
    doc.addEventListener("mousedown", onTapMouseDown, true);
    doc.addEventListener("click", onTapClick, true);
  }

  function detachTapHandlers() {
    if (!tapContents) return;
    const doc = (tapContents as { document?: Document }).document;
    if (doc) {
      doc.removeEventListener("mousedown", onTapMouseDown, true);
      doc.removeEventListener("click", onTapClick, true);
    }
    tapContents = null;
  }

  function onTapMouseDown(e: MouseEvent) {
    tapDownX = e.clientX;
    tapDownY = e.clientY;
  }

  /** iOS 原生滑动翻页事件订阅（UISwipeGestureRecognizer → native swipe 事件；onMounted 注册，onBeforeUnmount 取消） */
  let unsubSwipe: (() => void) | null = null;

  /**
   * 命中检测：epub.js marks 渲染在父文档的 SVG overlay（marks-pane，pointer-events:none），
   * 不在 iframe 内容文档里 —— contents click 的 e.target 是文字本身，closest(".epubjs-hl") 永远不中。
   * 真实验证（0.3.93 + 浏览器实测）：marks-pane 在 iframe 内容文档上监听 click，命中坐标后向父文档的
   * <g class="epubjs-hl|epubjs-ul"> 派发克隆事件（bubbles:false），epubjs 再转发 markClicked ——
   * 顺序依赖 pane 创建时机（首次高亮 vs attachTapHandlers 先后不定），不可靠。
   * 改为在 onTapClick 里按坐标反查父文档 mark：取 <g> 子元素（rect/line）逐段命中。
   * 坐标系：点击事件 clientX/Y 是 iframe 内容文档视口坐标（0 在 iframe 左上），而 mark rect 的
   * getBoundingClientRect 是父文档视口坐标 → 比较前先减去 iframe 偏移（浏览器实测确认）。
   * cfi/id 从 dataset 拿（epubjs 会把 data 和 epubcfi 写进 <g> 的 data-* 属性）。
   */
  function findMarkAt(
    clientX: number,
    clientY: number,
  ): { el: Element; id: string | null; cfi: string | null; rect: DOMRect } | null {
    const container = options.containerRef.value;
    if (!container) return null;
    const iframe = container.querySelector("iframe");
    const iframeRect = iframe?.getBoundingClientRect();
    const offX = iframeRect?.left ?? 0;
    const offY = iframeRect?.top ?? 0;
    const marks = container.querySelectorAll(".epubjs-hl, .epubjs-ul");
    for (const g of marks) {
      const gEl = g as Element & { dataset?: DOMStringMap };
      for (const child of Array.from(g.children)) {
        const r = (child as SVGGraphicsElement).getBoundingClientRect();
        // 内容文档坐标 = 父文档坐标 - iframe 偏移
        const rx = r.left - offX;
        const ry = r.top - offY;
        if (clientX >= rx && clientX <= rx + r.width && clientY >= ry && clientY <= ry + r.height) {
          return { el: g, id: gEl.dataset?.id ?? null, cfi: gEl.dataset?.epubcfi ?? null, rect: r };
        }
      }
    }
    return null;
  }

  /** 点击高亮：按命中段定位菜单（默认高亮上方，靠上翻转），优先 id 反查、cfi 兜底 */
  function openHighlightMenu(mark: { id: string | null; cfi: string | null; rect: DOMRect }) {
    let h = mark.id
      ? (options.annotations.value.highlights.find((x) => x.id === mark.id) ?? null)
      : null;
    if (!h && mark.cfi)
      h = options.annotations.value.highlights.find((x) => x.cfi === mark.cfi) ?? null;
    if (!h) return;
    // mark 的 rect 是父文档 viewport 坐标（marks-pane 渲染在父文档，与工具栏的 iframe 内容坐标不同）。
    // 菜单挂在 .reader-body 内（position:absolute 以它为包含块）→ 用 body 的 rect 换算，不能用 .reader（
    // 两者相差顶栏高度，浏览器实测：算错会导致菜单盖住高亮、点不到 mark）。
    const bodyEl = options.bodyRef.value;
    if (!bodyEl) return;
    const bodyRect = bodyEl.getBoundingClientRect();
    const r = mark.rect;
    options.hlMenu.x = r.left + r.width / 2 - bodyRect.left;
    options.hlMenu.y = r.top - bodyRect.top;
    options.hlMenu.id = h.id;
    options.hlMenu.visible = true;
    options.hideToolbar();
  }

  function onTapClick(e: MouseEvent) {
    // 点击已有高亮/下划线 → 弹菜单（不翻页、不触发链接）
    const mark = findMarkAt(e.clientX, e.clientY);
    if (mark) {
      e.preventDefault();
      openHighlightMenu(mark);
      return;
    }
    // 菜单开着时点击内容其它区域 → 收起（iframe 内点击不冒泡到父窗口，onWindowMouseDown 收不到）
    if (options.hlMenu.visible) options.closeHighlightMenu();
    // 选区工具栏打开时点击菜单外区域 → 收起（用户要求：点外部应消失）
    if (options.getToolbar().visible) {
      options.hideToolbar();
      return;
    }
    // 链接点击交给 epubjs 默认处理，不翻页
    const target = e.target as HTMLElement | null;
    if (target?.closest?.("a")) return;
    // 拖选不翻页：位移超阈值（拖选文字）或 iframe 内有非空选区
    if (Math.hypot(e.clientX - tapDownX, e.clientY - tapDownY) > TAP_DRAG_THRESHOLD) return;
    const iframe = options.containerRef.value?.querySelector("iframe");
    const sel = iframe?.contentWindow?.getSelection?.();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    // 坐标基准用容器（可见区域）：epubjs iframe 元素宽度是横向分页内容总宽（远超视口），
    // 用它算 22%/78% 会全落在中间；容器 rect = 用户实际看到的区域，与原 .reader-tap 定位一致
    const container = options.containerRef.value;
    const cRect = container?.getBoundingClientRect();
    if (!cRect || cRect.width === 0) return;
    const x = e.clientX - cRect.left;
    if (x < cRect.width * TAP_EDGE_RATIO) {
      e.preventDefault();
      prevPage();
    } else if (x > cRect.width * (1 - TAP_EDGE_RATIO)) {
      e.preventDefault();
      nextPage();
    }
  }

  /** iOS 原生滑动翻页事件订阅（UISwipeGestureRecognizer → native swipe 事件；onMounted 注册，onBeforeUnmount 取消） */
  function subscribeSwipe() {
    unsubSwipe = onNativeEvent("swipe", (payload: { dir?: string }) => {
      if (options.getToolbar().visible) options.hideToolbar();
      if (options.hlMenu.visible) options.closeHighlightMenu();
      if (payload?.dir === "left") nextPage();
      else if (payload?.dir === "right") prevPage();
    });
  }

  function unsubscribeSwipe() {
    unsubSwipe?.();
    unsubSwipe = null;
  }

  return {
    prevPage,
    nextPage,
    getCurrentContents,
    attachTapHandlers,
    detachTapHandlers,
    subscribeSwipe,
    unsubscribeSwipe,
  };
}
