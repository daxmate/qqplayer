<template>
  <div class="reader">
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
          @click="tocOpen = !tocOpen"
        >
          <List :size="18" />
        </button>
        <span class="reader-font">
          <button class="reader-btn icon" :title="t('books.fontSize')" @click="bumpFontSize(-10)">
            <Minus :size="15" />
          </button>
          <span class="reader-font-val">{{ fontSize }}%</span>
          <button class="reader-btn icon" :title="t('books.fontSize')" @click="bumpFontSize(10)">
            <Plus :size="15" />
          </button>
        </span>
        <button class="reader-btn icon" :title="t('books.prevPage')" @click="prevPage">
          <ChevronLeft :size="18" />
        </button>
        <button class="reader-btn icon" :title="t('books.nextPage')" @click="nextPage">
          <ChevronRight :size="18" />
        </button>
      </div>
    </header>

    <!-- 阅读区（epubjs 挂载点 + 左右点击翻页热区） -->
    <div class="reader-body">
      <div ref="containerRef" class="reader-container">
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
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, shallowRef, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronLeft, ChevronRight, List, Minus, Plus, Loader2, BookOpen } from "@lucide/vue";
import ePub from "epubjs";
import type { Book, Rendition, Location, NavItem } from "epubjs";
import type { BookView } from "./types";
import { saveBookProgress } from "./api";
import { uiSettings } from "../composables/useSettings.js";

const props = defineProps<{ book: BookView }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const containerRef = ref<HTMLElement | null>(null);
const bookRef = shallowRef<Book | null>(null);
const renditionRef = shallowRef<Rendition | null>(null);

const loading = ref(true);
const errorMsg = ref("");
const tocOpen = ref(false);

// ============ 字号（localStorage 记忆，70% ~ 200%） ============
const FONT_KEY = "qqplayer.books.fontSize";
const fontSize = ref(100);
try {
  const saved = Number(localStorage.getItem(FONT_KEY));
  if (Number.isFinite(saved) && saved >= 70 && saved <= 200) fontSize.value = saved;
} catch {
  /* 隐私模式等场景 localStorage 不可用，用默认 */
}

function applyFontSize() {
  renditionRef.value?.themes.fontSize(fontSize.value + "%");
}

function bumpFontSize(delta: number) {
  const next = Math.min(200, Math.max(70, fontSize.value + delta));
  if (next === fontSize.value) return;
  fontSize.value = next;
  try {
    localStorage.setItem(FONT_KEY, String(next));
  } catch {
    /* 忽略写入失败 */
  }
  applyFontSize();
}

// ============ 主题跟随（light/dark 两套 body 样式，auto 读 html data-theme） ============
const LIGHT_BODY = {
  body: {
    background: "#ffffff !important",
    color: "#24292f !important",
  },
  a: { color: "#0969da !important" },
};
const DARK_BODY = {
  body: {
    background: "#16181d !important",
    color: "#d6d9e0 !important",
  },
  a: { color: "#58a6ff !important" },
};

function applyTheme() {
  const rendition = renditionRef.value;
  if (!rendition) return;
  rendition.themes.register("light", LIGHT_BODY);
  rendition.themes.register("dark", DARK_BODY);
  let resolved: "light" | "dark";
  if (uiSettings.theme === "auto") {
    resolved =
      typeof document !== "undefined" && document.documentElement.dataset.theme === "light"
        ? "light"
        : "dark";
  } else {
    resolved = uiSettings.theme === "light" ? "light" : "dark";
  }
  rendition.themes.select(resolved);
}

watch(
  () => uiSettings.theme,
  () => applyTheme(),
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
    if (tocOpen.value) {
      tocOpen.value = false;
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

// ============ 尺寸跟随（窗口变化 → rendition.resize） ============
function onResize() {
  const container = containerRef.value;
  const rendition = renditionRef.value;
  if (!container || !rendition) return;
  rendition.resize(container.clientWidth, container.clientHeight);
}

// ============ 加载 / 销毁 ============
function teardown() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
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
    const rendition = book.renderTo(container, {
      width: container.clientWidth,
      height: container.clientHeight,
    });
    renditionRef.value = rendition;
    applyTheme();
    applyFontSize();
    rendition.on("relocated", onRelocated);
    await rendition.display(props.book.progress?.cfi ?? undefined);
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
  loadBook();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("resize", onResize);
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
