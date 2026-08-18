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
    <div ref="bodyRef" class="reader-body">
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
        <!-- 翻页热区不再用透明按钮盖住 iframe（会挡住边缘文字拖选）；改由 iframe 内
             mousedown/click 事件按坐标判断：左右 22% 翻页，中间留给链接/选中（见 attachTapHandlers） -->
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
            @reset="onResetSettings"
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

      <!-- 选中工具栏（选区上方/下方悬浮，iBooks 式：顶行五色点 + U，下方功能列表）；Swift 壳内隐藏（壳用系统右键菜单，见 installNativeMenuApi），浏览器照旧 -->
      <SelectionToolbar
        v-if="toolbar.visible && !isNativeShell"
        :x="toolbar.x"
        :y="toolbar.y"
        :visible="toolbar.visible"
        :text="currentSelection?.text ?? ''"
        :has-highlight="toolbarHasHighlight"
        @lookup="onToolbarLookup"
        @highlight="onToolbarHighlight"
        @note="onToolbarNote"
        @search="onToolbarSearch"
        @remove="onToolbarRemove"
      />

      <!-- 点击已有高亮/下划线 → 小菜单（换色 + U 切换 + 移除 + 添加笔记；复用 HighlightMenu 壳） -->
      <HighlightMenu
        v-if="hlMenu.visible && hlMenuHighlight"
        :x="hlMenu.x"
        :y="hlMenu.y"
        :visible="hlMenu.visible"
        :color="hlMenuHighlight.style === 'underline' ? null : hlMenuHighlight.color"
        :underline-active="hlMenuHighlight.style === 'underline'"
        @color="changeMenuColor"
        @underline="toggleMenuStyle"
      >
        <button
          class="hl-menu-action danger"
          :title="t('books.removeHighlight')"
          @click="removeMenuHighlight"
        >
          <Trash2 :size="14" />
          <span>{{ t("books.removeHighlight") }}</span>
        </button>
        <button class="hl-menu-action" :title="t('books.note')" @click="openMenuNote">
          <StickyNote :size="14" />
          <span>{{ t("books.note") }}</span>
        </button>
      </HighlightMenu>

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
  StickyNote,
  Trash2,
} from "@lucide/vue";
import ePub from "epubjs";
import type { Book, Rendition, Location, NavItem } from "epubjs";
import type {
  BookAnnotations,
  BookView,
  HighlightAnnotation,
  HighlightColor,
  HighlightStyle,
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
  UNDERLINE_COLOR,
  UNDERLINE_STYLE,
  updateNote,
} from "./annotations";
import { showToast, toastError } from "../composables/useToast.js";
import { uiSettings } from "../composables/useSettings.js";
import ReaderSettingsPanel from "./ReaderSettingsPanel.vue";
import SelectionToolbar from "./SelectionToolbar.vue";
import HighlightMenu from "./HighlightMenu.vue";
import AnnotationPanel from "./AnnotationPanel.vue";
import DictLookupModal from "./DictLookupModal.vue";
import NoteEditorModal from "./NoteEditorModal.vue";
import DictManagerModal from "./DictManagerModal.vue";
import {
  READER_SETTINGS_DEFAULTS,
  getReaderSettings,
  saveReaderSettings,
  resolveReaderThemeColors,
  readerFontCss,
} from "./settings";

const props = defineProps<{ book: BookView }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const rootRef = ref<HTMLElement | null>(null);
const bodyRef = ref<HTMLElement | null>(null);
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

/** 还原所有设置：全部字段回默认 → 即时应用（watch）→ 立即保存（取消未落地的防抖）→ 成功 toast */
async function onResetSettings() {
  if (settingsSaveTimer) {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = null;
  }
  Object.assign(readerSettings, READER_SETTINGS_DEFAULTS);
  const ok = await saveReaderSettings({ ...READER_SETTINGS_DEFAULTS });
  if (ok) showToast(t("books.settingsResetDone"));
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

/** 书内搜索请求（V4）：菜单"搜索"只写这个 ref；SearchPanel 由搜索子代理挂载并 watch（本文件不建面板） */
const searchRequest = ref<string | null>(null);

/** 选中 cfi 是否已有高亮（工具栏"移除"项显示条件；与 addHighlight 的重复判断同思路） */
const toolbarHasHighlight = computed(() => {
  const sel = currentSelection.value;
  return sel ? annotations.value.highlights.some((h) => h.cfi === sel.cfi) : false;
});

/** 点击已有高亮弹菜单状态（位置 + 目标高亮 id；条目被删则菜单自动关闭） */
const hlMenu = reactive({ x: 0, y: 0, visible: false, id: null as string | null });
const hlMenuHighlight = computed(
  () => annotations.value.highlights.find((h) => h.id === hlMenu.id) ?? null,
);

function closeHighlightMenu() {
  hlMenu.visible = false;
  hlMenu.id = null;
}

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
  postReaderState(true, ""); // 壳右键菜单：选区已清（去重：仅状态变化时发送）
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
  postReaderState(true, text); // 壳右键菜单：选区状态变化时上报（去重：文本没变不重复发）
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
  const contents = getCurrentContents();
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
  closeHighlightMenu(); // 新选区优先：收起点击高亮菜单
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

/** 单条高亮渲染到 epub.js（style=highlight 用底色 SVG，underline 用下划线 + UNDERLINE_STYLE） */
function renderHighlight(h: HighlightAnnotation) {
  const rendition = renditionRef.value;
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
  const rendition = renditionRef.value;
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
function addHighlight(color: HighlightColor, style: HighlightStyle = "highlight") {
  const sel = currentSelection.value;
  if (!sel) return;
  if (annotations.value.highlights.some((h) => h.cfi === sel.cfi)) {
    toastError(t("books.highlightExists"));
    clearSelection();
    return;
  }
  // 下划线固定红色落库（V4 契约）；底色高亮用用户选色
  const payloadColor: HighlightColor | "red" = style === "underline" ? UNDERLINE_COLOR : color;
  createHighlight(props.book.id, { cfi: sel.cfi, text: sel.text, color: payloadColor, style })
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
  deleteHighlight(props.book.id, id)
    .then(() => {
      if (h) {
        try {
          renditionRef.value?.annotations.remove(
            h.cfi,
            h.style === "underline" ? "underline" : "highlight",
          );
        } catch {
          /* 本地移除失败忽略 */
        }
      }
      annotations.value.highlights = annotations.value.highlights.filter((x) => x.id !== id);
      if (hlMenu.id === id) closeHighlightMenu();
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
  deleteHighlight(props.book.id, h.id)
    .then(() =>
      createHighlight(props.book.id, {
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
        renditionRef.value?.annotations.remove(
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
    next === "highlight" ? (h.color === "red" ? "yellow" : (h.color as HighlightColor)) : "yellow";
  replaceHighlight(h, { color, style: next });
}

/** 点击高亮菜单动作（内部取当前菜单目标，模板无需空值断言） */
function changeMenuColor(color: HighlightColor) {
  const h = hlMenuHighlight.value;
  if (h) changeHighlightColor(h, color);
}

function toggleMenuStyle() {
  const h = hlMenuHighlight.value;
  if (h) toggleHighlightStyle(h);
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
  currentSelection.value = { cfi: h.cfi, text: h.text, context: h.text };
  openNoteCreate();
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

function onToolbarHighlight(_text: string, color: HighlightColor, style?: HighlightStyle) {
  addHighlight(color, style ?? "highlight");
}

/** 书内搜索：只写 searchRequest（SearchPanel 由搜索子代理挂载并 watch 该 ref） */
function onToolbarSearch(text: string) {
  searchRequest.value = text;
}

/** 移除：选中 cfi 已有高亮时删除该条（hasHighlight 显示条件同源） */
function onToolbarRemove() {
  const sel = currentSelection.value;
  if (!sel) return;
  const h = annotations.value.highlights.find((x) => x.cfi === sel.cfi);
  if (h) removeHighlight(h.id);
}

function onToolbarNote(_text: string) {
  openNoteCreate();
}

// ============ Swift 壳桥接（window.qqplayerNative 注入时启用；浏览器内全部静默 no-op） ============
/** 壳注入的全局对象：qqplayerNative 环境标记 + webkit 消息桥 + 菜单 API 挂载点 */
const nativeShell = window as unknown as {
  qqplayerNative?: boolean;
  webkit?: { messageHandlers?: { native?: { postMessage?: (message: unknown) => void } } };
  __qqReaderMenu?: {
    lookup: () => void;
    highlight: (color: HighlightColor) => void;
    note: () => void;
  };
};

/** 是否运行在 Swift 原生壳内（壳注入 window.qqplayerNative；浏览器没有） */
function inNativeShell(): boolean {
  return typeof window !== "undefined" && !!nativeShell.qqplayerNative;
}

/** 壳内隐藏悬浮工具条（浏览器保留）；选区轮询与 currentSelection 照常维护（壳右键菜单依赖 cfi/context） */
const isNativeShell = computed(inNativeShell);

/** 已上报给壳的选区状态（去重：仅状态变化时发送，400ms 轮询不重复刷屏） */
let reportedActive = false;
let reportedText = "";

/** 上报选区状态给 Swift 壳（channel "native"，type: readerState）；状态没变化不发，非壳环境静默跳过 */
function postReaderState(active: boolean, text: string) {
  if (!inNativeShell()) return;
  if (reportedActive === active && reportedText === text) return;
  reportedActive = active;
  reportedText = text;
  try {
    nativeShell.webkit?.messageHandlers?.native?.postMessage?.({
      type: "readerState",
      active,
      hasSelection: text.length > 0,
      text,
    });
  } catch {
    /* 壳消息发送失败忽略（不影响阅读） */
  }
}

/** 挂载全局菜单 API（Swift 点击系统右键菜单项时经 evaluateJavaScript 调用）；卸载时清理 */
function installNativeMenuApi() {
  nativeShell.__qqReaderMenu = {
    // 查词：复用 onToolbarLookup（currentSelection 为数据源）；无选中时安全 no-op
    lookup: () => onToolbarLookup(currentSelection.value?.text ?? ""),
    // 高亮：复用 onToolbarHighlight；非法颜色回退黄色（壳传 'yellow'|'green'|'blue'|'pink'）
    highlight: (color: string) => {
      const c: HighlightColor = HIGHLIGHT_COLOR_STYLES[color as HighlightColor]
        ? (color as HighlightColor)
        : "yellow";
      onToolbarHighlight("", c);
    },
    // 笔记：复用 onToolbarNote（openNoteCreate 内部判空）；无选中时安全 no-op
    note: () => onToolbarNote(""),
  };
}

function uninstallNativeMenuApi() {
  delete nativeShell.__qqReaderMenu;
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
  const rendition = renditionRef.value;
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
  tapContents = contents;
  const doc = (contents as { document?: Document }).document;
  if (!doc) return;
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
  const container = containerRef.value;
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
  let h = mark.id ? (annotations.value.highlights.find((x) => x.id === mark.id) ?? null) : null;
  if (!h && mark.cfi) h = annotations.value.highlights.find((x) => x.cfi === mark.cfi) ?? null;
  if (!h) return;
  // mark 的 rect 是父文档 viewport 坐标（marks-pane 渲染在父文档，与工具栏的 iframe 内容坐标不同）。
  // 菜单挂在 .reader-body 内（position:absolute 以它为包含块）→ 用 body 的 rect 换算，不能用 .reader（
  // 两者相差顶栏高度，浏览器实测：算错会导致菜单盖住高亮、点不到 mark）。
  const bodyEl = bodyRef.value;
  if (!bodyEl) return;
  const bodyRect = bodyEl.getBoundingClientRect();
  const r = mark.rect;
  hlMenu.x = r.left + r.width / 2 - bodyRect.left;
  hlMenu.y = r.top - bodyRect.top;
  hlMenu.id = h.id;
  hlMenu.visible = true;
  hideToolbar();
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
  if (hlMenu.visible) closeHighlightMenu();
  // 链接点击交给 epubjs 默认处理，不翻页
  const target = e.target as HTMLElement | null;
  if (target?.closest?.("a")) return;
  // 拖选不翻页：位移超阈值（拖选文字）或 iframe 内有非空选区
  if (Math.hypot(e.clientX - tapDownX, e.clientY - tapDownY) > TAP_DRAG_THRESHOLD) return;
  const iframe = containerRef.value?.querySelector("iframe");
  const sel = iframe?.contentWindow?.getSelection?.();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return;
  // 坐标基准用容器（可见区域）：epubjs iframe 元素宽度是横向分页内容总宽（远超视口），
  // 用它算 22%/78% 会全落在中间；容器 rect = 用户实际看到的区域，与原 .reader-tap 定位一致
  const container = containerRef.value;
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

// ============ 进度保存（relocated 防抖 ~1s，静默失败） ============
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function onRelocated(loc: Location) {
  curCfi.value = loc.start.cfi ?? "";
  // epubjs 翻页会重建 contents → 重新挂翻页热区监听（防重复：attach 内部去重）
  attachTapHandlers();
  hideToolbar();
  closeHighlightMenu();
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
    } else if (hlMenu.visible) {
      closeHighlightMenu();
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

// 点击应用其它区域（非工具栏/高亮菜单）→ 收起
function onWindowMouseDown(e: MouseEvent) {
  const target = e.target as HTMLElement | null;
  if (target?.closest?.(".sel-toolbar, .hl-menu")) return;
  if (toolbar.visible) hideToolbar();
  if (hlMenu.visible) closeHighlightMenu();
}

// ============ 尺寸跟随（窗口变化 → rendition.resize；内容盒尺寸 = 容器 - 页边距 padding） ============
function onResize() {
  const container = containerRef.value;
  const rendition = renditionRef.value;
  if (!container || !rendition) return;
  const m = readerSettings.margin;
  try {
    rendition.resize(container.clientWidth - m * 2, container.clientHeight - m * 2);
  } catch {
    // 预存竞态：设置 watch 可能在 renderTo 后、display 完成前触发 resize（epubjs manager 未挂载），静默忽略
  }
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
  detachTapHandlers();
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
  closeHighlightMenu();
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
    // 内容加载（含换章重建）后自动注入字体覆盖（body * !important，见 applyFontToContents）
    rendition.hooks.content.register((contents: { document?: Document }) => {
      applyFontToContents(contents);
    });
    applyReaderSettings();
    rendition.on("relocated", onRelocated);
    rendition.on("selected", onSelected);
    await rendition.display(props.book.progress?.cfi ?? undefined);
    attachTapHandlers();
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
  installNativeMenuApi();
  postReaderState(true, ""); // 壳：Reader 激活初始状态（无选区）
  loadReaderSettings();
  loadBook();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("mousedown", onWindowMouseDown, true);
  stopSelPolling();
  uninstallNativeMenuApi();
  postReaderState(false, ""); // 壳：Reader 已卸载（hasSelection:false, text:""）
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

<style>
/* epub.js marks-pane 下划线红色覆盖：marks-pane 的 Underline 把 stroke/stroke-width 硬编码
   为黑色表现属性（0.3.93 实测），而 view.underline 传的 styles 只落到 <g> 上被 line 显式属性盖掉。
   SVG 表现属性优先级低于任何 CSS 规则 → 用类选择器强制红色，与 UNDERLINE_STYLE 常量一致。 */
.epubjs-ul line {
  stroke: #e5484d;
  stroke-width: 2;
}
</style>
