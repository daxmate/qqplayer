/**
 * 标注（useAnnotations）——从 Reader.vue 拆出（P3 拆分，行为零变化）。
 *
 * 职责：annotations/vocab 状态与全部增删改查（高亮/书签/笔记/生词本）、
 * epub.js 高亮渲染与重放、点击高亮小菜单（hlMenu）、笔记弹窗（noteModal）、
 * 标注侧栏开合（panelOpen/togglePanel）、标注锚点跳转（jumpTo）。
 * 依赖注入（均为晚绑定/回调）：epub.js rendition、壳上报（useNativeReaderBridge）、
 * 选中数据源（useSelectionToolbar 的 currentSelection/clearSelection）、
 * 阅读设置（useReaderSettings.readerSettings）、设置抽屉关闭回调。
 */
import { computed, reactive, ref } from "vue";
import type { Ref, ShallowRef } from "vue";
import { useI18n } from "vue-i18n";
import type { Location, Rendition } from "epubjs";
import type {
  BookAnnotations,
  HighlightAnnotation,
  HighlightColor,
  HighlightStyle,
  NoteAnnotation,
  ReaderSelection,
  ReaderSettings,
  VocabEntry,
} from "../books/types";
import {
  HIGHLIGHT_COLOR_STYLES,
  UNDERLINE_COLOR,
  UNDERLINE_STYLE,
  createBookmark,
  createHighlight,
  createNote,
  deleteBookmark,
  deleteHighlight,
  deleteNote,
  deleteVocab,
  fetchAnnotations,
  fetchVocab,
  isDarkBackground,
  updateNote,
} from "../books/annotations";
import { resolveReaderThemeColors } from "../books/settings";
import { showToast, toastError } from "./useToast.js";

export function useAnnotations(options: {
  /** epub.js rendition（Reader 主组件持有） */
  renditionRef: ShallowRef<Rendition | null>;
  /** 当前书 id（props.book.id，晚绑定） */
  getBookId: () => string;
  /** 壳环境判定 + 选区状态上报（useNativeReaderBridge；Reader 未拆前为内部函数） */
  inNativeShell: () => boolean;
  postReaderState: (
    active: boolean,
    text: string,
    hasHighlight?: boolean,
    highlightStyle?: HighlightStyle | null,
  ) => void;
  selectionHasHighlight: () => boolean;
  selectionHighlightStyle: () => HighlightStyle | null;
  /** 当前选中 ref + 清选区（useSelectionToolbar 持有；晚绑定：读写均在加载/交互后） */
  getToolbar: () => { currentSelection: Ref<ReaderSelection | null>; clearSelection: () => void };
  /** 阅读设置（useReaderSettings；晚绑定，高亮样式跟随当前主题） */
  getSettings: () => ReaderSettings;
  /** 关闭设置抽屉（useReaderSettings.settingsOpen；晚绑定，togglePanel 互锁用） */
  closeSettings: () => void;
  /** 目录抽屉开关（Reader 主组件持有；togglePanel 互锁用） */
  tocOpen: Ref<boolean>;
}) {
  const { t } = useI18n();

  // ============ 标注：高亮 / 书签 / 笔记 + 生词本 ============
  const annotations = ref<BookAnnotations>({ highlights: [], bookmarks: [], notes: [] });
  const vocabList = ref<VocabEntry[]>([]);
  const panelOpen = ref(false);
  const dictManagerOpen = ref(false);
  const curCfi = ref("");

  /** 点击已有高亮弹菜单状态（位置 + 目标高亮 id；条目被删则菜单自动关闭） */
  const hlMenu = reactive({ x: 0, y: 0, visible: false, id: null as string | null });
  const hlMenuHighlight = computed(
    () => annotations.value.highlights.find((h) => h.id === hlMenu.id) ?? null,
  );

  function closeHighlightMenu() {
    hlMenu.visible = false;
    hlMenu.id = null;
  }

  /** 笔记弹窗：create（选中新建）/ edit（面板编辑）共用 */
  const noteModal = reactive({
    open: false,
    mode: "create" as "create" | "edit",
    excerpt: "",
    note: null as NoteAnnotation | null,
    saving: false,
  });

  /** 当前页是否已加书签（顶栏 active 态；按 cfi 路径前缀匹配，容忍滚动偏移） */
  const isCurrentBookmarked = computed(() => {
    const cur = cfiPath(curCfi.value);
    return annotations.value.bookmarks.some((b) => cfiPath(b.cfi) === cur);
  });

  /** cfi 去掉末尾 :offset（书签定位锚点比对用） */
  function cfiPath(cfi: string): string {
    const i = cfi.lastIndexOf(":");
    return i > 0 ? cfi.slice(0, i) : cfi;
  }

  /** 当前选中 ref（useSelectionToolbar 持有；晚绑定读取） */
  function selRef(): Ref<ReaderSelection | null> {
    return options.getToolbar().currentSelection;
  }

  /** 清空 iframe 选区 + 收起工具栏（工具栏操作后调用；转发 useSelectionToolbar） */
  function clearSelection() {
    options.getToolbar().clearSelection();
  }

  /** 高亮 SVG 样式：深色主题用 screen 混合（multiply 在深底几乎不可见） */
  function highlightStyles(color: HighlightColor): Record<string, string> {
    const { bg } = resolveReaderThemeColors(options.getSettings());
    const base = HIGHLIGHT_COLOR_STYLES[color];
    return isDarkBackground(bg) ? { ...base, "mix-blend-mode": "screen" } : base;
  }

  /** 单条高亮渲染到 epub.js（style=highlight 用底色 SVG，underline 用下划线 + UNDERLINE_STYLE） */
  function renderHighlight(h: HighlightAnnotation) {
    const rendition = options.renditionRef.value;
    if (!rendition?.annotations) return;
    try {
      if (h.style === "underline") {
        rendition.annotations.add(
          "underline",
          h.cfi,
          { id: h.id, text: h.text },
          undefined,
          "epubjs-ul",
          UNDERLINE_STYLE,
        );
      } else {
        const color: HighlightColor = h.color === "red" ? "yellow" : h.color;
        rendition.annotations.add(
          "highlight",
          h.cfi,
          { id: h.id, text: h.text, color: h.color },
          undefined,
          "epubjs-hl",
          highlightStyles(color),
        );
      }
    } catch {
      /* 渲染失败不影响持久化 */
    }
  }

  /** 标注重放：后端高亮逐条 add 到 epub.js（切章自动重放由 annotations hooks.render 负责） */
  function replayHighlights() {
    const rendition = options.renditionRef.value;
    if (!rendition?.annotations) return;
    for (const h of annotations.value.highlights) {
      try {
        renderHighlight(h);
      } catch {
        /* 单条重放失败忽略（cfi 过期等） */
      }
    }
  }

  /** 读标注 + 重放高亮（书加载后调用一次；此后本地增量维护） */
  async function loadAnnotations() {
    try {
      annotations.value = await fetchAnnotations(options.getBookId());
    } catch {
      annotations.value = { highlights: [], bookmarks: [], notes: [] };
    }
    replayHighlights();
  }

  async function refreshVocab() {
    try {
      vocabList.value = await fetchVocab();
    } catch {
      /* 生词本拉取失败不阻断阅读 */
    }
  }

  // ---- 高亮 ----
  function addHighlight(color: HighlightColor, style: HighlightStyle = "highlight") {
    const sel = selRef().value;
    if (!sel) return;
    if (annotations.value.highlights.some((h) => h.cfi === sel.cfi)) {
      toastError(t("books.highlightExists"));
      clearSelection();
      return;
    }
    // 下划线固定红色落库（V4 契约）；底色高亮用用户选色
    const payloadColor: HighlightColor | "red" = style === "underline" ? UNDERLINE_COLOR : color;
    createHighlight(options.getBookId(), {
      cfi: sel.cfi,
      text: sel.text,
      color: payloadColor,
      style,
    })
      .then(({ id }) => {
        const h: HighlightAnnotation = {
          id,
          cfi: sel.cfi,
          text: sel.text,
          color: payloadColor,
          style,
          createdAt: Date.now(),
        };
        annotations.value.highlights.push(h);
        renderHighlight(h);
        showToast(t(style === "underline" ? "books.underlineDone" : "books.highlightDone"));
      })
      .catch(() => toastError(t("books.loadError")))
      .finally(() => clearSelection());
  }

  function removeHighlight(id: string) {
    const h = annotations.value.highlights.find((x) => x.id === id);
    deleteHighlight(options.getBookId(), id)
      .then(() => {
        if (h) {
          try {
            options.renditionRef.value?.annotations.remove(
              h.cfi,
              h.style === "underline" ? "underline" : "highlight",
            );
          } catch {
            /* 本地移除失败忽略 */
          }
        }
        annotations.value.highlights = annotations.value.highlights.filter((x) => x.id !== id);
        if (hlMenu.id === id) closeHighlightMenu();
        // 壳：删除后选区高亮态变化 → 补发（右键菜单「移除高亮」项隐藏）
        if (options.inNativeShell()) {
          options.postReaderState(
            true,
            selRef().value?.text ?? "",
            options.selectionHasHighlight(),
            options.selectionHighlightStyle(),
          );
        }
        showToast(t("books.highlightDeleteDone"));
      })
      .catch(() => toastError(t("books.loadError")));
  }

  /**
   * 换色 / 样式切换：后端无 PATCH，删除重建（先删后建）。
   * 只在创建成功后才动本地列表 —— 删除成功但创建失败时本地原条目原样保留（含渲染），无数据丢失。
   */
  function replaceHighlight(
    h: HighlightAnnotation,
    next: { color: HighlightColor; style: HighlightStyle },
  ) {
    const payloadColor: HighlightColor | "red" =
      next.style === "underline" ? UNDERLINE_COLOR : next.color;
    deleteHighlight(options.getBookId(), h.id)
      .then(() =>
        createHighlight(options.getBookId(), {
          cfi: h.cfi,
          text: h.text,
          color: payloadColor,
          style: next.style,
        }),
      )
      .then(({ id }) => {
        const nh: HighlightAnnotation = {
          id,
          cfi: h.cfi,
          text: h.text,
          color: payloadColor,
          style: next.style,
          createdAt: Date.now(),
        };
        annotations.value.highlights = annotations.value.highlights.map((x) =>
          x.id === h.id ? nh : x,
        );
        try {
          options.renditionRef.value?.annotations.remove(
            h.cfi,
            h.style === "underline" ? "underline" : "highlight",
          );
        } catch {
          /* 本地移除失败忽略 */
        }
        renderHighlight(nh);
        if (hlMenu.id === h.id) hlMenu.id = nh.id; // 菜单目标 id 跟随新条目（保持菜单打开）
        showToast(t("books.highlightDone"));
      })
      .catch(() => toastError(t("books.loadError")));
  }

  /** 换色：色点永远产出底色高亮（下划线条目点色点 → 转为该色高亮，iBooks 行为） */
  function changeHighlightColor(h: HighlightAnnotation, color: HighlightColor) {
    replaceHighlight(h, { color, style: "highlight" });
  }

  /** U 切换：highlight ↔ underline 互转（下划线固定红色；转回底色时原色是 red 则回落 yellow） */
  function toggleHighlightStyle(h: HighlightAnnotation) {
    const next: HighlightStyle = h.style === "underline" ? "highlight" : "underline";
    const color: HighlightColor =
      next === "highlight"
        ? h.color === "red"
          ? "yellow"
          : (h.color as HighlightColor)
        : "yellow";
    replaceHighlight(h, { color, style: next });
  }

  /** 点击高亮菜单动作（内部取当前菜单目标，模板无需空值断言）；色点按行为矩阵：
   *  同色底色 → 移除（toggle off）；异色 → 换色；下划线 → 转底色 */
  function changeMenuColor(color: HighlightColor) {
    const h = hlMenuHighlight.value;
    if (!h) return;
    if (h.style === "highlight" && h.color === color) removeHighlight(h.id);
    else changeHighlightColor(h, color);
  }

  /** U 按行为矩阵：下划线条目点 U = 移除（toggle off）；底色条目点 U = 转下划线 */
  function toggleMenuStyle() {
    const h = hlMenuHighlight.value;
    if (!h) return;
    if (h.style === "underline") removeHighlight(h.id);
    else toggleHighlightStyle(h);
  }

  function removeMenuHighlight() {
    const h = hlMenuHighlight.value;
    if (h) removeHighlight(h.id);
  }

  function openMenuNote() {
    const h = hlMenuHighlight.value;
    if (h) openNoteForHighlight(h);
  }

  /** 从高亮条目建笔记：借 currentSelection 数据源（openNoteCreate/saveNote 共用读取），菜单先收起 */
  function openNoteForHighlight(h: HighlightAnnotation) {
    closeHighlightMenu();
    selRef().value = { cfi: h.cfi, text: h.text, context: h.text };
    openNoteCreate();
  }

  // ---- 书签 ----
  function toggleBookmark() {
    // epub.js 类型把 currentLocation() 标为 DisplayedLocation，运行时实为 {start,end}（Location 形状）
    const loc = options.renditionRef.value?.currentLocation?.() as unknown as Location | undefined;
    const cfi = loc?.start?.cfi;
    if (!cfi) return;
    const existing = annotations.value.bookmarks.find((b) => cfiPath(b.cfi) === cfiPath(cfi));
    if (existing) {
      removeBookmark(existing.id, true);
      return;
    }
    const page =
      typeof loc.start.location === "number" && loc.start.location >= 0
        ? loc.start.location + 1
        : 1;
    const text = t("books.bookmarkLabel", { page });
    createBookmark(options.getBookId(), { cfi, text })
      .then(({ id }) => {
        annotations.value.bookmarks.push({ id, cfi, text, createdAt: Date.now() });
        showToast(t("books.bookmarkDone"));
      })
      .catch(() => toastError(t("books.loadError")));
  }

  function removeBookmark(id: string, fromToggle: boolean) {
    deleteBookmark(options.getBookId(), id)
      .then(() => {
        annotations.value.bookmarks = annotations.value.bookmarks.filter((b) => b.id !== id);
        showToast(t(fromToggle ? "books.bookmarkRemoved" : "books.bookmarkDeleteDone"));
      })
      .catch(() => toastError(t("books.loadError")));
  }

  // ---- 笔记 ----
  function openNoteCreate() {
    const sel = selRef().value;
    if (!sel) return;
    noteModal.mode = "create";
    noteModal.excerpt = sel.text;
    noteModal.note = null;
    noteModal.saving = false;
    noteModal.open = true;
  }

  function openNoteEdit(note: NoteAnnotation) {
    noteModal.mode = "edit";
    noteModal.excerpt = note.excerpt;
    noteModal.note = note;
    noteModal.saving = false;
    noteModal.open = true;
  }

  function onNoteCancel() {
    const wasCreate = noteModal.mode === "create";
    noteModal.open = false;
    if (wasCreate) clearSelection();
  }

  function saveNote(text: string) {
    if (noteModal.saving) return;
    noteModal.saving = true;
    if (noteModal.mode === "create") {
      const sel = selRef().value;
      if (!sel) {
        noteModal.saving = false;
        noteModal.open = false;
        return;
      }
      createNote(options.getBookId(), { cfi: sel.cfi, excerpt: sel.text, text })
        .then(({ id }) => {
          const now = Date.now();
          annotations.value.notes.push({
            id,
            cfi: sel.cfi,
            excerpt: sel.text,
            text,
            createdAt: now,
            updatedAt: now,
          });
          showToast(t("books.noteDone"));
        })
        .catch(() => toastError(t("books.loadError")))
        .finally(() => {
          noteModal.saving = false;
          noteModal.open = false;
          clearSelection();
        });
    } else {
      const note = noteModal.note;
      if (!note) {
        noteModal.saving = false;
        noteModal.open = false;
        return;
      }
      updateNote(options.getBookId(), note.id, text)
        .then((updated) => {
          const i = annotations.value.notes.findIndex((n) => n.id === note.id);
          if (i >= 0) annotations.value.notes[i] = updated;
          showToast(t("books.noteDone"));
        })
        .catch(() => toastError(t("books.loadError")))
        .finally(() => {
          noteModal.saving = false;
          noteModal.open = false;
        });
    }
  }

  function removeNote(id: string) {
    deleteNote(options.getBookId(), id)
      .then(() => {
        annotations.value.notes = annotations.value.notes.filter((n) => n.id !== id);
        showToast(t("books.noteDeleteDone"));
      })
      .catch(() => toastError(t("books.loadError")));
  }

  // ---- 生词本 ----
  function removeVocab(id: string) {
    deleteVocab(id)
      .then(() => {
        vocabList.value = vocabList.value.filter((v) => v.id !== id);
        showToast(t("books.vocabDeleteDone"));
      })
      .catch(() => toastError(t("books.loadError")));
  }

  function togglePanel() {
    panelOpen.value = !panelOpen.value;
    if (panelOpen.value) {
      options.tocOpen.value = false;
      options.closeSettings();
      void refreshVocab();
    }
  }

  /** 跳转到标注锚点（书签点 cfi / 高亮与笔记范围 cfi 均可 display） */
  function jumpTo(cfi: string) {
    try {
      void options.renditionRef.value?.display(cfi)?.catch?.(() => {});
    } catch {
      /* 跳转失败静默 */
    }
  }

  return {
    annotations,
    vocabList,
    panelOpen,
    dictManagerOpen,
    curCfi,
    hlMenu,
    hlMenuHighlight,
    closeHighlightMenu,
    noteModal,
    isCurrentBookmarked,
    cfiPath,
    loadAnnotations,
    refreshVocab,
    addHighlight,
    removeHighlight,
    replaceHighlight,
    changeHighlightColor,
    toggleHighlightStyle,
    changeMenuColor,
    toggleMenuStyle,
    removeMenuHighlight,
    openMenuNote,
    openNoteForHighlight,
    toggleBookmark,
    removeBookmark,
    openNoteCreate,
    openNoteEdit,
    onNoteCancel,
    saveNote,
    removeNote,
    removeVocab,
    togglePanel,
    jumpTo,
  };
}
