<template>
  <div ref="rootRef" class="reader">
    <!-- 顶栏：返回 / 书名 / 目录 / 字号 / 翻页 -->
    <header class="reader-topbar">
      <button class="reader-btn" :title="t('books.back')" @click="emit('close')">
        <ChevronLeft :size="18" />
        <span>{{ t("books.back") }}</span>
      </button>
      <span class="reader-title" :title="book.title">{{ book.title }}</span>
      <div class="reader-actions">
        <button
          class="reader-btn icon"
          :class="{ on: tocOpen }"
          :title="t('books.toc')"
          @click="toggleToc"
        >
          <List :size="18" />
        </button>
        <span class="reader-font">
          <button class="reader-btn icon" :title="t('books.fontSize')" @click="bumpFontSize(-10)">
            <Minus :size="15" />
          </button>
          <span class="reader-font-val">{{ readerSettings.fontSize }}%</span>
          <button class="reader-btn icon" :title="t('books.fontSize')" @click="bumpFontSize(10)">
            <Plus :size="15" />
          </button>
        </span>
        <button
          class="reader-btn icon"
          :class="{ on: settingsOpen }"
          :title="t('books.settings')"
          @click="toggleSettings"
        >
          <Settings2 :size="18" />
        </button>
        <button
          class="reader-btn icon"
          :class="{ on: isCurrentBookmarked }"
          :title="t('books.bookmark')"
          @click="toggleBookmark"
        >
          <Bookmark :size="18" />
        </button>
        <button
          class="reader-btn icon"
          :class="{ on: panelOpen }"
          :title="t('books.annotations')"
          @click="togglePanel"
        >
          <Highlighter :size="18" />
        </button>
        <button class="reader-btn icon" :title="t('books.prevPage')" @click="prevPage">
          <ChevronLeft :size="18" />
        </button>
        <button class="reader-btn icon" :title="t('books.nextPage')" @click="nextPage">
          <ChevronRight :size="18" />
        </button>
      </div>
    </header>

    <!-- 阅读区（epubjs 挂载点 + 左右点击翻页热区；容器 padding 实现页边距设置） -->
    <div class="reader-body">
      <div ref="containerRef" class="reader-container" :style="readerContainerStyle">
        <div v-if="loading" class="reader-status">
          <Loader2 :size="28" class="reader-spin" />
          <span>{{ t("books.loading") }}</span>
        </div>
        <div v-else-if="errorMsg" class="reader-status err">
          <BookOpen :size="28" />
          <span>{{ errorMsg }}</span>
          <button class="reader-retry" @click="loadBook">{{ t("books.back") }}</button>
        </div>
        <!-- 左右 1/3 点击翻页（z-index 盖过 epubjs iframe；中间留白给链接点击） -->
        <button
          v-if="!loading && !errorMsg"
          class="reader-tap left"
          :title="t('books.prevPage')"
          @click="prevPage"
        />
        <button
          v-if="!loading && !errorMsg"
          class="reader-tap right"
          :title="t('books.nextPage')"
          @click="nextPage"
        />
      </div>

      <!-- 目录抽屉（tree 渲染，点击跳转） -->
      <Transition name="toc-fade">
        <div v-if="tocOpen" class="reader-toc-mask" @click.self="tocOpen = false">
          <aside class="reader-toc">
            <h3 class="reader-toc-title">{{ t("books.toc") }}</h3>
            <div class="reader-toc-scroll">
              <template v-if="tocItems.length">
                <button
                  v-for="(entry, i) in tocItems"
                  :key="entry.item.id || entry.item.href || i"
                  class="reader-toc-item"
                  :style="{ paddingLeft: 14 + entry.depth * 16 + 'px' }"
                  @click="goToTocItem(entry.item)"
                >
                  {{ entry.item.label }}
                </button>
              </template>
              <p v-else class="reader-toc-empty">{{ t("books.loading") }}</p>
            </div>
          </aside>
        </div>
      </Transition>

      <!-- 阅读设置抽屉（右侧滑出；改动由 Reader 防抖写回后端；遮罩点击关闭） -->
      <Transition name="toc-fade">
        <div v-if="settingsOpen" class="reader-settings-mask" @click.self="settingsOpen = false">
          <ReaderSettingsPanel
            :settings="readerSettings"
            @patch="onSettingsPatch"
            @close="settingsOpen = false"
          />
        </div>
      </Transition>

      <!-- 标注侧栏（标注 + 生词本；与设置抽屉同遮罩模式） -->
      <Transition name="toc-fade">
        <div v-if="panelOpen" class="reader-settings-mask" @click.self="panelOpen = false">
          <AnnotationPanel
            :annotations="annotations"
            :vocab="vocabList"
            @close="panelOpen = false"
            @jump="jumpTo"
            @delete-highlight="removeHighlight"
            @delete-bookmark="(id) => removeBookmark(id, false)"
            @delete-note="removeNote"
            @edit-note="openNoteEdit"
            @delete-vocab="removeVocab"
          />
        </div>
      </Transition>

      <!-- 选中工具栏（选区上方/下方悬浮） -->
      <SelectionToolbar
        v-if="toolbar.visible"
        :x="toolbar.x"
        :y="toolbar.y"
        :visible="toolbar.visible"
        :text="currentSelection?.text ?? ''"
        @lookup="onToolbarLookup"
        @highlight="onToolbarHighlight"
        @note="onToolbarNote"
      />

      <!-- 查词弹窗 -->
      <DictLookupModal
        v-if="lookupState.open"
        :word="lookupState.word"
        :context="lookupState.context"
        :book-id="book.id"
        :book-title="book.title"
        :cfi="lookupState.cfi"
        @close="onLookupClose"
        @open-dict-manager="onOpenDictManager"
      />

      <!-- 笔记编辑（创建/编辑共用） -->
      <NoteEditorModal
        v-if="noteModal.open"
        :excerpt="noteModal.excerpt"
        :initial-text="noteModal.mode === 'edit' ? (noteModal.note?.text ?? '') : ''"
        :saving="noteModal.saving"
        @save="saveNote"
        @cancel="onNoteCancel"
      />

      <!-- 词典管理（查词空态跳转入口同用） -->
      <DictManagerModal v-if="dictManagerOpen" @close="dictManagerOpen = false" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, reactive, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  Bookmark,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  List,
  Loader2,
  Minus,
  Plus,
  Settings2,
} from "@lucide/vue";
import ePub from "epubjs";
import type { Book, Rendition, Location, NavItem } from "epubjs";
import type {
  BookAnnotations,
  BookView,
  HighlightColor,
  NoteAnnotation,
  ReaderSelection,
  ReaderSettings,
  VocabEntry,
} from "./types";
import { saveBookProgress } from "./api";
import {
  createBookmark,
  createHighlight,
  createNote,
  deleteBookmark,
  deleteHighlight,
  deleteNote,
  deleteVocab,
  fetchAnnotations,
  fetchVocab,
  HIGHLIGHT_COLOR_STYLES,
  isDarkBackground,
  updateNote,
} from "./annotations";
import { showToast, toastError } from "../composables/useToast.js";
import { uiSettings } from "../composables/useSettings.js";
import ReaderSettingsPanel from "./ReaderSettingsPanel.vue";
import SelectionToolbar from "./SelectionToolbar.vue";
import AnnotationPanel from "./AnnotationPanel.vue";
import DictLookupModal from "./DictLookupModal.vue";
import NoteEditorModal from "./NoteEditorModal.vue";
import DictManagerModal from "./DictManagerModal.vue";
import {
  READER_SETTINGS_DEFAULTS,
  getReaderSettings,
  saveReaderSettings,
  resolveReaderThemeColors,
} from "./settings";

const props = defineProps<{ book: BookView }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const rootRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const bookRef = shallowRef<Book | null>(null);
const renditionRef = shallowRef<Rendition | null>(null);

const loading = ref(true);
const errorMsg = ref("");
const tocOpen = ref(false);

// ============ 阅读设置（后端 /api/settings books namespace；localStorage 只读不写） ============
// 旧字号 localStorage 键（V1 遗留，仅一次性迁移读取，迁移成功后清除）
const LEGACY_FONT_KEY = "qqplayer.books.fontSize";
const settingsOpen = ref(false);
const readerSettings = reactive<ReaderSettings>({ ...READER_SETTINGS_DEFAULTS });
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 旧字号：localStorage 读取（70~200 合法才认），读不到返回 null */
function readLegacyFontSize(): number | null {
  try {
    const saved = Number(localStorage.getItem(LEGACY_FONT_KEY));
    return Number.isFinite(saved) && saved >= 70 && saved <= 200 ? saved : null;
  } catch {
    return null; // 隐私模式等场景 localStorage 不可用
  }
}

/** 初始化：读后端设置；若后端 fontSize 仍是默认 100 且 localStorage 有旧值 → 一次性迁移（PUT + 清除） */
async function loadReaderSettings() {
  const saved = await getReaderSettings();
  const legacy = readLegacyFontSize();
  const migrated =
    legacy !== null && saved.fontSize === READER_SETTINGS_DEFAULTS.fontSize
      ? { ...saved, fontSize: legacy }
      : saved;
  Object.assign(readerSettings, migrated);
  applyReaderSettings();
  if (migrated.fontSize !== saved.fontSize) {
    // 迁移：旧值写回后端，成功后清除 localStorage；失败保留旧值下次再迁
    saveReaderSettings({ fontSize: migrated.fontSize }).then((ok) => {
      if (ok) {
        try {
          localStorage.removeItem(LEGACY_FONT_KEY);
        } catch {
          /* 忽略清除失败 */
        }
      }
    });
  }
}

/** 用户改设置：合并进 reactive（watch 即时应用）+ 防抖 300ms 写回后端（深合并） */
function onSettingsPatch(patch: Partial<ReaderSettings>) {
  Object.assign(readerSettings, patch);
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveReaderSettings({ ...readerSettings });
  }, 300);
}

function toggleSettings() {
  settingsOpen.value = !settingsOpen.value;
  if (settingsOpen.value) {
    tocOpen.value = false;
    panelOpen.value = false;
  }
}

function toggleToc() {
  tocOpen.value = !tocOpen.value;
  if (tocOpen.value) {
    settingsOpen.value = false;
    panelOpen.value = false;
  }
}

function bumpFontSize(delta: number) {
  const next = Math.min(200, Math.max(70, readerSettings.fontSize + delta));
  if (next === readerSettings.fontSize) return;
  onSettingsPatch({ fontSize: next });
}

// ============ 标注：高亮 / 书签 / 笔记 + 生词本 + 选中工具栏（V2） ============
const annotations = ref<BookAnnotations>({ highlights: [], bookmarks: [], notes: [] });
const vocabList = ref<VocabEntry[]>([]);
const panelOpen = ref(false);
const dictManagerOpen = ref(false);
const curCfi = ref("");

/** 选中工具栏位置（相对 .reader 根，px） */
const toolbar = reactive({ x: 0, y: 0, visible: false });
/** 当前选中（工具栏操作的数据源；工具栏收起时保留到操作完成） */
const currentSelection = ref<ReaderSelection | null>(null);

/** 查词弹窗状态 */
const lookupState = reactive({
  open: false,
  word: "",
  context: "",
  cfi: "",
});

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

function hideToolbar() {
  toolbar.visible = false;
}

/** 清空 iframe 选区 + 收起工具栏（工具栏操作后调用） */
function clearSelection() {
  hideToolbar();
  try {
    const contents = renditionRef.value?.getContents?.();
    const list = contents ? (Array.isArray(contents) ? contents : [contents]) : [];
    for (const c of list) {
      c.window?.getSelection?.()?.removeAllRanges();
    }
  } catch {
    /* 清选区失败不影响主流程 */
  }
  currentSelection.value = null;
}

/** 选区收起（selectionchange）→ 收起工具栏；同一函数引用重复 add 自动去重 */
function onContentsSelectionChange(e: Event) {
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
  const iframe = containerRef.value?.querySelector("iframe");
  const iw = iframe?.contentWindow;
  const sel = iw?.getSelection?.();
  if (!sel) return;
  const text = sel.toString().trim();
  if (sel.isCollapsed || sel.rangeCount === 0 || !text) {
    // 无选区：重置稳定计数 + 收起工具栏
    selPollLastText = "";
    selPollStableCount = 0;
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
  const rendition = renditionRef.value;
  let contents: unknown = null;
  rendition?.views()?.forEach((v) => {
    const vc = (v as { contents?: unknown }).contents;
    if (vc) contents = vc;
  });
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
  const iframe = containerRef.value?.querySelector("iframe");
  const root = rootRef.value;
  if (!iframe || !root) return;
  const iframeRect = iframe.getBoundingClientRect();
  const rootRect = root.getBoundingClientRect();
  toolbar.x = iframeRect.left + rangeRect.left + rangeRect.width / 2 - rootRect.left;
  toolbar.y = iframeRect.top + rangeRect.top - rootRect.top;
  toolbar.visible = true;
  currentSelection.value = { cfi, text, context: extractSentence(text, contents) };
  // 挂载选区收起监听（contents 每次新建都会触发 selected，函数引用去重）
  (contents as { document?: Document }).document?.addEventListener(
    "selectionchange",
    onContentsSelectionChange,
  );
}

/** 高亮 SVG 样式：深色主题用 screen 混合（multiply 在深底几乎不可见） */
function highlightStyles(color: HighlightColor): Record<string, string> {
  const { bg } = resolveReaderThemeColors(readerSettings);
  const base = HIGHLIGHT_COLOR_STYLES[color];
  return isDarkBackground(bg) ? { ...base, "mix-blend-mode": "screen" } : base;
}

/** 标注重放：后端高亮逐条 add 到 epub.js（切章自动重放由 annotations hooks.render 负责） */
function replayHighlights() {
  const rendition = renditionRef.value;
  if (!rendition?.annotations) return;
  for (const h of annotations.value.highlights) {
    try {
      rendition.annotations.add(
        "highlight",
        h.cfi,
        { id: h.id, text: h.text, color: h.color },
        undefined,
        "epubjs-hl",
        highlightStyles(h.color),
      );
    } catch {
      /* 单条重放失败忽略（cfi 过期等） */
    }
  }
}

/** 读标注 + 重放高亮（书加载后调用一次；此后本地增量维护） */
async function loadAnnotations() {
  try {
    annotations.value = await fetchAnnotations(props.book.id);
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
function addHighlight(color: HighlightColor) {
  const sel = currentSelection.value;
  if (!sel) return;
  if (annotations.value.highlights.some((h) => h.cfi === sel.cfi)) {
    toastError(t("books.highlightExists"));
    clearSelection();
    return;
  }
  createHighlight(props.book.id, { cfi: sel.cfi, text: sel.text, color })
    .then(({ id }) => {
      annotations.value.highlights.push({
        id,
        cfi: sel.cfi,
        text: sel.text,
        color,
        createdAt: Date.now(),
      });
      try {
        renditionRef.value?.annotations.add(
          "highlight",
          sel.cfi,
          { id },
          undefined,
          "epubjs-hl",
          highlightStyles(color),
        );
      } catch {
        /* 渲染失败不影响持久化 */
      }
      showToast(t("books.highlightDone"));
    })
    .catch(() => toastError(t("books.loadError")))
    .finally(() => clearSelection());
}

function removeHighlight(id: string) {
  const h = annotations.value.highlights.find((x) => x.id === id);
  deleteHighlight(props.book.id, id)
    .then(() => {
      if (h) {
        try {
          renditionRef.value?.annotations.remove(h.cfi, "highlight");
        } catch {
          /* 本地移除失败忽略 */
        }
      }
      annotations.value.highlights = annotations.value.highlights.filter((x) => x.id !== id);
      showToast(t("books.highlightDeleteDone"));
    })
    .catch(() => toastError(t("books.loadError")));
}

// ---- 书签 ----
function toggleBookmark() {
  // epub.js 类型把 currentLocation() 标为 DisplayedLocation，运行时实为 {start,end}（Location 形状）
  const loc = renditionRef.value?.currentLocation?.() as unknown as Location | undefined;
  const cfi = loc?.start?.cfi;
  if (!cfi) return;
  const existing = annotations.value.bookmarks.find((b) => cfiPath(b.cfi) === cfiPath(cfi));
  if (existing) {
    removeBookmark(existing.id, true);
    return;
  }
  const page =
    typeof loc.start.location === "number" && loc.start.location >= 0 ? loc.start.location + 1 : 1;
  const text = t("books.bookmarkLabel", { page });
  createBookmark(props.book.id, { cfi, text })
    .then(({ id }) => {
      annotations.value.bookmarks.push({ id, cfi, text, createdAt: Date.now() });
      showToast(t("books.bookmarkDone"));
    })
    .catch(() => toastError(t("books.loadError")));
}

function removeBookmark(id: string, fromToggle: boolean) {
  deleteBookmark(props.book.id, id)
    .then(() => {
      annotations.value.bookmarks = annotations.value.bookmarks.filter((b) => b.id !== id);
      showToast(t(fromToggle ? "books.bookmarkRemoved" : "books.bookmarkDeleteDone"));
    })
    .catch(() => toastError(t("books.loadError")));
}

// ---- 笔记 ----
function openNoteCreate() {
  const sel = currentSelection.value;
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
    const sel = currentSelection.value;
    if (!sel) {
      noteModal.saving = false;
      noteModal.open = false;
      return;
    }
    createNote(props.book.id, { cfi: sel.cfi, excerpt: sel.text, text })
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
    updateNote(props.book.id, note.id, text)
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
  deleteNote(props.book.id, id)
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

// ---- 工具栏动作 ----
function onToolbarLookup(text: string) {
  const sel = currentSelection.value;
  if (!sel) return;
  lookupState.open = true;
  lookupState.word = text.slice(0, 60);
  lookupState.context = sel.context || text.slice(0, 200);
  lookupState.cfi = sel.cfi;
  clearSelection();
}

function onToolbarHighlight(_text: string, color: HighlightColor) {
  addHighlight(color);
}

function onToolbarNote(_text: string) {
  openNoteCreate();
}

function onLookupClose() {
  lookupState.open = false;
  void refreshVocab(); // 弹窗内可能加入了生词
}

function onOpenDictManager() {
  lookupState.open = false;
  dictManagerOpen.value = true;
}

function togglePanel() {
  panelOpen.value = !panelOpen.value;
  if (panelOpen.value) {
    tocOpen.value = false;
    settingsOpen.value = false;
    void refreshVocab();
  }
}

/** 跳转到标注锚点（书签点 cfi / 高亮与笔记范围 cfi 均可 display） */
function jumpTo(cfi: string) {
  try {
    void renditionRef.value?.display(cfi)?.catch?.(() => {});
  } catch {
    /* 跳转失败静默 */
  }
}

// ============ 设置应用到 epub.js（themes.override 作用到 iframe body 的 inline 样式） ============
const FONT_FAMILY_CSS: Record<"serif" | "sans" | "rounded", string> = {
  serif: "Georgia, serif",
  sans: "Helvetica, Arial, sans-serif",
  rounded: "Avenir Next Rounded, 'Arial Rounded MT Bold', sans-serif",
};

function applyReaderSettings() {
  const rendition = renditionRef.value;
  if (!rendition) return;
  const themes = rendition.themes;
  const s = readerSettings;
  // 字体族：default → 空值 override（epubjs 运行时对空值走 removeProperty，等同移除覆盖）
  if (s.fontFamily === "default") themes.override("font-family", "");
  else themes.font(FONT_FAMILY_CSS[s.fontFamily]);
  // 字号（百分比，相对 iframe 默认字号）
  themes.fontSize(s.fontSize + "%");
  // 行距（body 无单位值，子元素按倍数继承）
  themes.override("line-height", String(s.lineHeight));
  // 主题色：预设 + textColor/bgColor 自定义覆盖；!important 压过 EPUB 自带 body 样式
  const { text, bg } = resolveReaderThemeColors(s);
  themes.override("color", text, true);
  themes.override("background", bg, true);
  // 页边距不在这里做：epub.js 分页布局（columns()）会强制写 body padding-left/right !important，
  // themes.override 会被覆盖。改为容器 padding（readerContainerStyle）+ renderTo/resize 用内容盒尺寸。
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

// ============ 目录（tree 展平为带缩进列表） ============
function flattenToc(items: NavItem[], depth = 0): { item: NavItem; depth: number }[] {
  const out: { item: NavItem; depth: number }[] = [];
  for (const item of items) {
    out.push({ item, depth });
    if (item.subitems?.length) out.push(...flattenToc(item.subitems, depth + 1));
  }
  return out;
}

const tocItems = computed(() => flattenToc(bookRef.value?.navigation.toc ?? []));

async function goToTocItem(item: NavItem) {
  tocOpen.value = false;
  if (!item.href) return;
  try {
    await renditionRef.value?.display(item.href);
  } catch {
    /* 跳转失败静默 */
  }
}

// ============ 翻页 ============
function prevPage() {
  renditionRef.value?.prev();
}

function nextPage() {
  renditionRef.value?.next();
}

// ============ 进度保存（relocated 防抖 ~1s，静默失败） ============
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function onRelocated(loc: Location) {
  curCfi.value = loc.start.cfi ?? "";
  hideToolbar();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveBookProgress(props.book.id, {
      cfi: loc.start.cfi,
      location: loc.start.percentage,
      updatedAt: Date.now(),
    }).catch(() => {
      /* 静默失败：进度保存不影响阅读 */
    });
  }, 1000);
}

// ============ 键盘（← 上一页 / →、Space 下一页；Escape 关目录） ============
// capture 阶段监听并 stopPropagation：优先于 App 全局快捷键（bubble 阶段）
function onKeydown(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null;
  if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) {
    return;
  }
  if (e.key === "Escape") {
    if (lookupState.open) {
      lookupState.open = false;
      e.preventDefault();
      e.stopPropagation();
    } else if (noteModal.open) {
      noteModal.open = false;
      e.preventDefault();
      e.stopPropagation();
    } else if (panelOpen.value) {
      panelOpen.value = false;
      e.preventDefault();
      e.stopPropagation();
    } else if (tocOpen.value) {
      tocOpen.value = false;
      e.preventDefault();
      e.stopPropagation();
    } else if (settingsOpen.value) {
      settingsOpen.value = false;
      e.preventDefault();
      e.stopPropagation();
    }
    return;
  }
  if (e.code === "ArrowLeft") {
    e.preventDefault();
    e.stopPropagation();
    prevPage();
  } else if (e.code === "ArrowRight" || e.code === "Space") {
    e.preventDefault();
    e.stopPropagation();
    nextPage();
  }
}

// 点击应用其它区域（非工具栏）→ 收起选中工具栏
function onWindowMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (target?.closest?.(".sel-toolbar")) return;
  if (toolbar.visible) hideToolbar();
}

// ============ 尺寸跟随（窗口变化 → rendition.resize；内容盒尺寸 = 容器 - 页边距 padding） ============
function onResize() {
  const container = containerRef.value;
  const rendition = renditionRef.value;
  if (!container || !rendition) return;
  const m = readerSettings.margin;
  rendition.resize(container.clientWidth - m * 2, container.clientHeight - m * 2);
}

// ============ 加载 / 销毁 ============
function teardown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  renditionRef.value?.destroy();
  renditionRef.value = null;
  bookRef.value?.destroy();
  bookRef.value = null;
}

async function loadBook() {
  teardown();
  loading.value = true;
  errorMsg.value = "";
  tocOpen.value = false;
  settingsOpen.value = false;
  panelOpen.value = false;
  dictManagerOpen.value = false;
  lookupState.open = false;
  noteModal.open = false;
  hideToolbar();
  annotations.value = { highlights: [], bookmarks: [], notes: [] };
  try {
    // 先取 ArrayBuffer 再喂 epub.js：绕开 URL 语义（非 .epub 后缀被当书库目录）
    // 与 request/XHR 兼容问题（参考 ~/codes/qq 成功案例：ePub(arrayBuffer) 直接解析）
    const resp = await fetch(props.book.fileUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    const book = ePub(buf);
    bookRef.value = book;
    await book.ready;
    const container = containerRef.value;
    if (!container) return;
    const m = readerSettings.margin;
    const rendition = book.renderTo(container, {
      width: container.clientWidth - m * 2,
      height: container.clientHeight - m * 2,
    });
    renditionRef.value = rendition;
    applyReaderSettings();
    rendition.on("relocated", onRelocated);
    rendition.on("selected", onSelected);
    await rendition.display(props.book.progress?.cfi ?? undefined);
    await loadAnnotations();
    void refreshVocab();
  } catch {
    errorMsg.value = t("books.loadError");
  } finally {
    loading.value = false;
  }
}

// book 变化（书架换书）→ 重建
watch(
  () => props.book.id,
  () => {
    loadBook();
  },
);

onMounted(() => {
  window.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onResize);
  window.addEventListener("mousedown", onWindowMouseDown, true);
  startSelPolling();
  loadReaderSettings();
  loadBook();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("mousedown", onWindowMouseDown, true);
  stopSelPolling();
  teardown();
});
</script>

<style scoped>
.reader {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  overflow: hidden;
}
.reader-topbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border);
}
.reader-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 7px 12px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.reader-btn:hover {
  background: var(--card2);
  color: var(--text);
}
.reader-btn.icon {
  padding: 7px;
  border-radius: 8px;
}
.reader-btn.icon.on {
  color: var(--accent-text);
  background: var(--accent-soft);
}
.reader-title {
  flex: 1;
  min-width: 0;
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.reader-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.reader-font {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 6px;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  margin: 0 4px;
}
.reader-font-val {
  min-width: 42px;
  text-align: center;
  font-size: 12px;
  color: var(--text2);
  font-variant-numeric: tabular-nums;
}
.reader-body {
  position: relative;
  flex: 1;
  min-height: 0;
}
.reader-container {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.reader-status {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text3);
  font-size: 13px;
}
.reader-status.err {
  color: var(--text2);
}
.reader-spin {
  animation: reader-spin 1.1s linear infinite;
  opacity: 0.7;
}
@keyframes reader-spin {
  to {
    transform: rotate(360deg);
  }
}
.reader-retry {
  margin-top: 4px;
  padding: 6px 14px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
}
.reader-retry:hover {
  border-color: var(--accent);
  color: var(--accent-text);
}
/* 左右点击翻页热区：各占 22%，中间 56% 留给内容链接/选中 */
.reader-tap {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 22%;
  border: none;
  background: transparent;
  cursor: pointer;
  z-index: 2;
  touch-action: manipulation;
}
.reader-tap.left {
  left: 0;
}
.reader-tap.right {
  right: 0;
}
/* 阅读设置抽屉遮罩（与目录抽屉同模式） */
.reader-settings-mask {
  position: absolute;
  inset: 0;
  z-index: 6;
  background: rgba(0, 0, 0, 0.35);
}
/* 目录抽屉 */
.reader-toc-mask {
  position: absolute;
  inset: 0;
  z-index: 5;
  background: rgba(0, 0, 0, 0.35);
}
.reader-toc {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: min(320px, 82%);
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-right: 1px solid var(--border);
  box-shadow: 8px 0 24px rgba(0, 0, 0, 0.18);
}
.reader-toc-title {
  flex-shrink: 0;
  padding: 14px 16px;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
}
.reader-toc-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 0;
}
.reader-toc-item {
  display: block;
  width: 100%;
  padding: 8px 16px;
  font-size: 13.5px;
  color: var(--text2);
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: all 0.12s;
}
.reader-toc-item:hover {
  background: var(--card2);
  color: var(--text);
}
.reader-toc-empty {
  padding: 18px 16px;
  font-size: 13px;
  color: var(--text3);
}
.toc-fade-enter-active,
.toc-fade-leave-active {
  transition: opacity 0.18s;
}
.toc-fade-enter-from,
.toc-fade-leave-to {
  opacity: 0;
}
</style>
