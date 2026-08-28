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
          :class="{ on: searchOpen }"
          :title="t('books.search')"
          @click="toggleSearch"
        >
          <Search :size="18" />
        </button>
        <!-- 词典管理常驻入口（查词空态之外任何时候可打开，V2 改进） -->
        <button class="reader-btn icon" :title="t('books.dictManage')" @click="onOpenDictManager">
          <BookOpenText :size="18" />
        </button>
        <button
          class="reader-btn icon"
          :class="{ on: panelOpen }"
          :title="t('books.annotations')"
          @click="togglePanel"
        >
          <Highlighter :size="18" />
        </button>
        <button
          v-if="!isMobile"
          class="reader-btn icon"
          :title="t('books.prevPage')"
          @click="prevPage"
        >
          <ChevronLeft :size="18" />
        </button>
        <button
          v-if="!isMobile"
          class="reader-btn icon"
          :title="t('books.nextPage')"
          @click="nextPage"
        >
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
      <!-- iOS：全屏透明遮罩实现“菜单外点击关闭”（iframe 触摸事件在 WKWebView 不可靠，原生遮罩最稳） -->
      <div v-if="toolbar.visible && isIOSShell" class="reader-toolbar-scrim" @click="hideToolbar" />
      <SelectionToolbar
        v-if="toolbar.visible && !isNativeShell"
        :x="toolbar.x"
        :y="toolbar.y"
        :visible="toolbar.visible"
        :text="currentSelection?.text ?? ''"
        :has-highlight="toolbarHasHighlight"
        :color="toolbarColor"
        :underline-active="toolbarHighlight?.style === 'underline'"
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

      <!-- 书内搜索面板（右侧抽屉无遮罩：跳转后阅读区保持可见，可连续点结果；关闭/翻页清理临时高亮） -->
      <Transition name="search-slide">
        <SearchPanel
          v-if="searchOpen"
          :book-id="book.id"
          :initial-query="searchInitial"
          @close="closeSearch"
          @jump="onSearchJump"
        />
      </Transition>

      <!-- 查词弹窗 -->
      <DictLookupModal
        v-if="lookupState.open"
        :word="lookupState.word"
        :context="lookupState.context"
        :book-id="book.id"
        :book-title="book.title"
        :theme-colors="dictThemeColors"
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
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import {
  Bookmark,
  BookOpen,
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  Highlighter,
  List,
  Loader2,
  Minus,
  Plus,
  Search,
  Settings2,
  StickyNote,
  Trash2,
} from "@lucide/vue";
import ePub from "epubjs";
import type { Book, Rendition, Location, NavItem } from "epubjs";
import type { BookView } from "./types";
import { saveBookProgress } from "./api";
import { api } from "../utils/apiClient.js";
import { assetForBook, ensureAsset, localAssetHTTPURL, syncEnabled } from "../utils/sync.js";
import ReaderSettingsPanel from "./ReaderSettingsPanel.vue";
import SelectionToolbar from "./SelectionToolbar.vue";
import HighlightMenu from "./HighlightMenu.vue";
import { isMobile } from "../composables/useMobileViewport.js";
import SearchPanel from "./SearchPanel.vue";
import AnnotationPanel from "./AnnotationPanel.vue";
import DictLookupModal from "./DictLookupModal.vue";
import NoteEditorModal from "./NoteEditorModal.vue";
import DictManagerModal from "./DictManagerModal.vue";
import { useReaderSettings } from "../composables/useReaderSettings";
import { useAnnotations } from "../composables/useAnnotations";
import { useSelectionToolbar } from "../composables/useSelectionToolbar";
import { useDictLookup } from "../composables/useDictLookup";
import { useReaderSearch } from "../composables/useReaderSearch";
import { useNativeReaderBridge } from "../composables/useNativeReaderBridge";
import { useReaderStyling } from "../composables/useReaderStyling";
import { useReaderNavigation } from "../composables/useReaderNavigation";

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

// ============ Swift 壳桥接（useNativeReaderBridge：window.qqplayerNative 注入时启用；浏览器内全部静默 no-op） ============
const {
  isNativeShell,
  isIOSShell,
  inNativeShell,
  postReaderState,
  selectionHasHighlight,
  selectionHighlightStyle,
  findHighlightForSelection,
  installNativeMenuApi,
  uninstallNativeMenuApi,
} = useNativeReaderBridge({
  containerRef,
  // 晚绑定：以下依赖均来自后续创建的 composable，调用点全部在运行时（非 setup 期）
  getCurrentSelection: () => currentSelection.value,
  setCurrentSelection: (sel) => {
    currentSelection.value = sel;
  },
  getAnnotations: () => annotations.value,
  cfiPath: (cfi) => cfiPath(cfi),
  getCurrentContents: () => getCurrentContents(),
  extractSentence: (text, contents) => extractSentence(text, contents),
  onToolbarLookup: (text) => onToolbarLookup(text),
  onToolbarHighlight: (text, color, style) => onToolbarHighlight(text, color, style),
  onToolbarRemove: () => onToolbarRemove(),
  onToolbarSearch: (text) => onToolbarSearch(text),
  onToolbarNote: (text) => onToolbarNote(text),
  changeHighlightColor: (h, color) => changeHighlightColor(h, color),
});

// ============ 标注：高亮 / 书签 / 笔记 + 生词本（useAnnotations） ============
const {
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
  changeHighlightColor,
  toggleHighlightStyle,
  changeMenuColor,
  toggleMenuStyle,
  removeMenuHighlight,
  openMenuNote,
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
} = useAnnotations({
  renditionRef,
  getBookId: () => props.book.id,
  // 壳上报（useNativeReaderBridge；Reader 未拆前为下方内部函数，函数声明提升可安全引用）
  inNativeShell,
  postReaderState,
  selectionHasHighlight,
  selectionHighlightStyle,
  // 选中数据源（useSelectionToolbar；晚绑定：读写均在加载/交互后）
  getToolbar: () => ({ currentSelection, clearSelection }),
  // 阅读设置（useReaderSettings；晚绑定，高亮样式跟随当前主题）
  getSettings: () => readerSettings,
  // 设置抽屉互锁（useReaderSettings；晚绑定）
  closeSettings: () => {
    settingsOpen.value = false;
  },
  tocOpen,
});

// ============ 阅读设置（useReaderSettings：后端 /api/settings books namespace；localStorage 只读不写） ============
const {
  settingsOpen,
  readerSettings,
  dictThemeColors,
  loadReaderSettings,
  onSettingsPatch,
  onResetSettings,
  toggleSettings,
  toggleToc,
  bumpFontSize,
  clearSaveTimer,
} = useReaderSettings({
  tocOpen,
  panelOpen,
  // 设置应用到 epub.js 由 useReaderStyling 提供（晚绑定：loadReaderSettings 挂载后才调用）
  apply: () => applyReaderSettings(),
});

// ============ 翻页 / 点击热区 / 滑动（useReaderNavigation：epubjs 翻页 + 左右 22% 热区 + iOS 滑动翻页） ============
const {
  prevPage,
  nextPage,
  getCurrentContents,
  attachTapHandlers,
  detachTapHandlers,
  subscribeSwipe,
  unsubscribeSwipe,
} = useReaderNavigation({
  renditionRef,
  containerRef,
  bodyRef,
  annotations,
  hlMenu,
  closeHighlightMenu,
  // 晚绑定：useSelectionToolbar 随后创建，调用点全部在运行时
  getToolbar: () => toolbar,
  hideToolbar: () => hideToolbar(),
});

// ============ 选中工具栏（useSelectionToolbar：选区状态 + 轮询 + 工具栏动作） ============
const {
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
} = useSelectionToolbar({
  rootRef,
  containerRef,
  renditionRef,
  annotations,
  // 壳上报/高亮匹配（useNativeReaderBridge；Reader 未拆前为下方内部函数，函数声明提升可安全引用）
  findHighlightForSelection,
  postReaderState,
  selectionHasHighlight,
  selectionHighlightStyle,
  // 当前 contents（useReaderNavigation；Reader 未拆前为下方内部函数）
  getCurrentContents,
  // 标注动作（useAnnotations）
  closeHighlightMenu,
  addHighlight,
  removeHighlight,
  toggleHighlightStyle,
  changeHighlightColor,
  openNoteCreate,
});

// ============ 查词（useDictLookup：弹窗状态 + 查词/词典管理入口） ============
const { lookupState, onToolbarLookup, onLookupClose, onOpenDictManager } = useDictLookup({
  currentSelection,
  dictManagerOpen,
  clearSelection,
  refreshVocab,
});

// ============ 书内搜索（useReaderSearch：面板状态 + 临时高亮 + 跳转） ============
const {
  searchOpen,
  searchInitial,
  closeSearch,
  toggleSearch,
  clearTempHighlight,
  onSearchJump,
  releaseTempHighlight,
} = useReaderSearch({
  searchRequest,
  tocOpen,
  settingsOpen,
  panelOpen,
  renditionRef,
  // 当前 contents（useReaderNavigation；Reader 未拆前为下方内部函数）
  getCurrentContents,
});

// ============ 设置应用到 epub.js（useReaderStyling：themes.override 作用到 iframe body 的 inline 样式） ============
const {
  applyReaderSettings,
  applyFontToContents,
  blockNativeContextMenu,
  stripContentLinks,
  applyNoTouchCallout,
  readerContainerStyle,
} = useReaderStyling({
  renditionRef,
  readerSettings,
  onResize,
});

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

// ============ 进度保存（relocated 防抖 ~1s，静默失败） ============
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function onRelocated(loc: Location) {
  // 翻页/跳转 → 临时高亮还原（mark 留在旧位置没有意义；epubjs 重渲染前手动解包）
  clearTempHighlight();
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
    } else if (searchOpen.value) {
      closeSearch();
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
  releaseTempHighlight(); // iframe 文档随 rendition.destroy 销毁，仅清引用
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  clearSaveTimer();
  detachTapHandlers();
  renditionRef.value?.destroy();
  renditionRef.value = null;
  bookRef.value?.destroy();
  bookRef.value = null;
}

/** 获取 EPUB 二进制：iOS 壳优先本地资产（已下载 → 本地 HTTP 读取，离线可用；
 *  未下载 → 远程加载 + 后台触发下载，下次打开秒开）；桌面/浏览器走远程，零变化。
 *  ensureAsset 默认「只查不下载」（autoPrefetch 关），阅读器链路显式 download:true
 *  保持既有「打开即后台下载」语义（播放链路的下载判断不受影响）。 */
async function loadBookBuffer() {
  if (syncEnabled()) {
    try {
      const item = await assetForBook(props.book);
      const localURL = item ? await ensureAsset(item, { download: true }) : null;
      const httpURL = localAssetHTTPURL(localURL);
      if (httpURL) {
        const resp = await fetch(httpURL); // 本地 server 无鉴权，裸 fetch
        if (resp.ok) return await resp.arrayBuffer();
      }
    } catch {
      /* 本地读取失败回退远程 */
    }
  }
  const resp = await api({ url: props.book.fileUrl, raw: true });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return await resp.response.arrayBuffer();
}

async function loadBook() {
  teardown();
  loading.value = true;
  errorMsg.value = "";
  tocOpen.value = false;
  settingsOpen.value = false;
  panelOpen.value = false;
  searchOpen.value = false;
  searchInitial.value = null;
  searchRequest.value = null;
  clearTempHighlight();
  dictManagerOpen.value = false;
  lookupState.open = false;
  noteModal.open = false;
  hideToolbar();
  closeHighlightMenu();
  annotations.value = { highlights: [], bookmarks: [], notes: [] };
  try {
    // 先取 ArrayBuffer 再喂 epub.js：绕开 URL 语义（非 .epub 后缀被当书库目录）
    // 与 request/XHR 兼容问题（参考 ~/codes/qq 成功案例：ePub(arrayBuffer) 直接解析）
    // raw 模式：二进制大文件不解析 JSON、不进缓存，调用方直接消费 Response
    const buf = await loadBookBuffer();
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
    // + 禁默认右键菜单（见 blockNativeContextMenu）
    // + 去链接语义（见 stripContentLinks：iOS 系统“拷贝链接”菜单项干扰选区工具栏）
    rendition.hooks.content.register((contents: { document?: Document }) => {
      applyFontToContents(contents);
      blockNativeContextMenu(contents);
      stripContentLinks(contents);
      applyNoTouchCallout(contents);
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
  // iOS 原生滑动翻页（UISwipeGestureRecognizer → native swipe 事件 → 翻页；useReaderNavigation 订阅）
  subscribeSwipe();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", onResize);
  window.removeEventListener("mousedown", onWindowMouseDown, true);
  stopSelPolling();
  uninstallNativeMenuApi();
  unsubscribeSwipe();
  postReaderState(false, ""); // 壳：Reader 已卸载（hasSelection:false, text:"")
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
/* iOS 选区工具栏遮罩：全屏透明，点任意处关工具栏（iframe 触摸事件在 WKWebView 不可靠，
   用父文档遮罩实现“菜单外点击关闭”；z-index 低于工具栏 hl-menu 的 10） */
.reader-toolbar-scrim {
  position: absolute;
  inset: 0;
  z-index: 9;
  background: transparent;
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
/* 搜索面板滑入滑出（无遮罩，面板自身 translateX） */
.search-slide-enter-active,
.search-slide-leave-active {
  transition:
    transform 0.22s ease,
    opacity 0.22s ease;
}
.search-slide-enter-from,
.search-slide-leave-to {
  transform: translateX(100%);
  opacity: 0;
}
</style>

<style>
/* epub.js marks-pane 下划线修复（0.3.93 实测）：
   1. Underline.render 对每个文本行画 <rect fill="none">（覆盖整个文本区域）+ <line>（底部）两个元素；
      view.underline 传的 styles 只落到 <g> 上，rect 继承 <g> 的 stroke → 画出红色方框（“下划线是框” bug）。
      去掉 rect 的 stroke（fill 本来就是 none），只留底部真正的下划线。
   2. line 的 stroke/stroke-width 被硬编码为黑色表现属性，显式属性盖掉 <g> 继承；
      SVG 表现属性优先级低于任何 CSS 规则 → 用类选择器强制红色，与 UNDERLINE_STYLE 常量一致。 */
.epubjs-ul rect {
  stroke: none;
}
.epubjs-ul line {
  stroke: #e5484d;
  stroke-width: 2;
}
</style>
