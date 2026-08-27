/**
 * 书内搜索（useReaderSearch）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：搜索面板状态（searchOpen/searchInitial）、菜单搜索请求消费（watch
 * searchRequest）、搜索跳转 + iframe DOM 临时高亮（searchHighlight.ts 纯函数）。
 */
import { ref, watch } from "vue";
import type { Ref, ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import type { Rendition } from "epubjs";
import {
  applyTempMark,
  ensureTempMarkStyle,
  findSentenceRange,
  removeTempMark,
} from "../books/searchHighlight";
import { toastError } from "./useToast.js";

export function useReaderSearch(options: {
  /** 菜单「搜索」请求（useSelectionToolbar 持有；本 composable watch 消费） */
  searchRequest: Ref<string | null>;
  /** 面板互锁（Reader/useReaderSettings/useAnnotations 持有） */
  tocOpen: Ref<boolean>;
  settingsOpen: Ref<boolean>;
  panelOpen: Ref<boolean>;
  renditionRef: ShallowRef<Rendition | null>;
  /** 当前 epub.js contents（useReaderNavigation；Reader 未拆前为内部函数） */
  getCurrentContents: () => unknown;
}) {
  const { t } = useI18n();

  const searchOpen = ref(false);
  const searchInitial = ref<string | null>(null);
  /** 当前临时高亮 <mark>（直接包在 iframe DOM 上，不进 annotations/重放链路） */
  let searchTempMark: HTMLElement | null = null;

  /** 打开搜索面板（initial 非空 → SearchPanel 挂载后自动预填并搜索） */
  function openSearch(initial: string | null) {
    searchInitial.value = initial;
    searchOpen.value = true;
    options.tocOpen.value = false;
    options.settingsOpen.value = false;
    options.panelOpen.value = false;
  }

  /** 关闭面板：同时清理临时高亮（面板不再可见，书内标记应还原） */
  function closeSearch() {
    searchOpen.value = false;
    clearTempHighlight();
  }

  function toggleSearch() {
    if (searchOpen.value) closeSearch();
    else openSearch(null);
  }

  /** 消费菜单搜索请求：非空 → 打开面板预填该词，并置回 null 防重复触发 */
  watch(options.searchRequest, (v) => {
    if (!v) return;
    openSearch(v);
    options.searchRequest.value = null;
  });

  /** 临时高亮还原：<mark> 解包回原文 DOM（翻页 relocated / 关面板 / 新跳转前调用） */
  function clearTempHighlight() {
    if (!searchTempMark) return;
    try {
      removeTempMark(searchTempMark);
    } catch {
      /* 还原失败忽略（epubjs 重渲染时 mark 随文档消失） */
    }
    searchTempMark = null;
  }

  /** 当前 iframe document（views 优先，getContents 兜底；mock 缺 views 时返回 null） */
  function getSearchDoc(): Document | null {
    let contents = options.getCurrentContents();
    if (!contents) {
      try {
        const cs = options.renditionRef.value?.getContents?.();
        contents = Array.isArray(cs) ? cs[0] : cs;
      } catch {
        contents = null;
      }
    }
    return (contents as { document?: Document } | null)?.document ?? null;
  }

  /**
   * 搜索跳转：display(cfi) 定位 → 当前章节文档内找句子/命中词 → <mark> 临时高亮。
   * 临时高亮只操作 iframe DOM（见 searchHighlight.ts），不注册 annotations——
   * 否则会进 epub.js hooks.render 自动重放链路，翻页/重渲染后被反复重放成脏标记。
   */
  async function onSearchJump(cfi: string, matchStart: number, matchEnd: number, sentence: string) {
    clearTempHighlight();
    try {
      await options.renditionRef.value?.display(cfi);
    } catch {
      toastError(t("books.searchJumpFailed"));
      return;
    }
    const doc = getSearchDoc();
    if (!doc) {
      toastError(t("books.searchJumpFailed"));
      return;
    }
    const hit = findSentenceRange(doc, sentence, matchStart, matchEnd);
    if (!hit) {
      toastError(t("books.searchJumpFailed"));
      return;
    }
    ensureTempMarkStyle(doc);
    searchTempMark = applyTempMark(hit.range);
    try {
      searchTempMark.scrollIntoView?.({ block: "center" });
    } catch {
      /* 滚动定位失败不影响高亮 */
    }
  }

  /** teardown 用：仅清引用（iframe 文档随 rendition.destroy 销毁，不做 DOM 还原） */
  function releaseTempHighlight() {
    searchTempMark = null;
  }

  return {
    searchOpen,
    searchInitial,
    openSearch,
    closeSearch,
    toggleSearch,
    clearTempHighlight,
    onSearchJump,
    releaseTempHighlight,
  };
}
