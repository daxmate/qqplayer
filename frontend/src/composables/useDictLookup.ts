/**
 * 查词（useDictLookup）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：查词弹窗状态（lookupState）+ 查词入口（工具栏/壳菜单）、弹窗关闭
 * （刷新生词本）、词典管理入口（onOpenDictManager）。
 * 独立成文件：给未来查词扩展（词典 UI 演进）留位。
 */
import { reactive } from "vue";
import type { Ref } from "vue";
import type { ReaderSelection } from "../books/types";

export function useDictLookup(options: {
  /** 当前选中（useSelectionToolbar 持有；查词数据源） */
  currentSelection: Ref<ReaderSelection | null>;
  /** 词典管理弹窗开关（useAnnotations 持有） */
  dictManagerOpen: Ref<boolean>;
  /** 清空选区 + 收起工具栏（useSelectionToolbar；查词后调用） */
  clearSelection: () => void;
  /** 刷新生词本（useAnnotations；查词弹窗内可能加入了生词） */
  refreshVocab: () => void;
}) {
  /** 查词弹窗状态 */
  const lookupState = reactive({
    open: false,
    word: "",
    context: "",
    cfi: "",
  });

  function onToolbarLookup(text: string) {
    const sel = options.currentSelection.value;
    if (!sel) return;
    lookupState.open = true;
    lookupState.word = text.slice(0, 60);
    lookupState.context = sel.context || text.slice(0, 200);
    lookupState.cfi = sel.cfi;
    options.clearSelection();
  }

  function onLookupClose() {
    lookupState.open = false;
    void options.refreshVocab(); // 弹窗内可能加入了生词
  }

  function onOpenDictManager() {
    lookupState.open = false;
    options.dictManagerOpen.value = true;
  }

  return { lookupState, onToolbarLookup, onLookupClose, onOpenDictManager };
}
