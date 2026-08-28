<!-- search anything —— Spotlight 式全屏搜索层（用户 2026-08-14 拍板）
  两种形态（同一组件）：
    entry 模式：顶栏/移动端入口，常态只显示小放大镜图标
    默认（非 entry）：全屏遮罩搜索层本体（挂 App 根部，桌面/移动共用），v-if 由 isSearchOpen 单例控制
  数据契约（TASK.md）：useSearchAnything 单例 { query, results, loading, isSearchOpen, clear }
    ResultItem: { kind:'song'|'online'|'artist'|'album'|'setting', id, title, subtitle, badge, score, payload }
  键盘：Cmd+K（可配置 searchKey）唤起/收起；Esc 收起；↑↓ 移动高亮；Enter 执行（设置行=展开内联控件）
  Cmd+K 组合键处理：searchKey 默认 'Meta+K'（= Cmd+K）；用户录单键（如 'KeyK'）则纯单键触发，
    但搜索层打开且焦点在输入框时不拦截打字（防止录了单键后打字误关） -->
<template>
  <!-- ============ 入口：常态小放大镜图标 ============ -->
  <button
    v-if="entry"
    type="button"
    class="sa-entry"
    :title="t('search.entryTitle', { key: fmtSearchKey })"
    :aria-label="t('search.entryTitle', { key: fmtSearchKey })"
    @click="isSearchOpen = !isSearchOpen"
  >
    <Search :size="18" />
  </button>

  <!-- ============ 全屏搜索层本体（App 根部挂载，桌面/移动共用） ============ -->
  <Transition v-else name="sa-fade">
    <div
      v-if="isSearchOpen"
      class="sa-mask"
      role="dialog"
      aria-modal="true"
      @mousedown.self="close"
    >
      <div class="sa-panel">
        <!-- 大搜索框 -->
        <div class="sa-input-wrap">
          <Search :size="20" class="sa-input-icon" />
          <input
            ref="inputEl"
            v-model="query"
            class="sa-input"
            type="text"
            :placeholder="t('search.placeholder')"
            spellcheck="false"
            autocomplete="off"
            aria-label="search anything"
            @focus="inputFocused = true"
            @blur="inputFocused = false"
          />
          <Loader2 v-if="loading" :size="16" class="sa-spin" />
          <button
            v-else-if="query"
            type="button"
            class="sa-clear"
            :title="t('search.clear')"
            @mousedown.prevent="clearQuery"
          >
            <X :size="14" />
          </button>
        </div>

        <!-- 结果区：混合结果列表 / 空态设置目录 -->
        <div class="sa-body">
          <template v-if="query.trim()">
            <!-- 在线源切换（网易云 / 歌曲海）：仅输入时显示，切源立即重搜 -->
            <div class="sa-sources">
              <button
                type="button"
                class="sa-source"
                :class="{ on: onlineSource === 'netease' }"
                @click="setOnlineSource('netease')"
              >
                {{ t("online.sourceNetease") }}
              </button>
              <button
                type="button"
                class="sa-source"
                :class="{ on: onlineSource === 'gequhai' }"
                @click="setOnlineSource('gequhai')"
              >
                {{ t("online.sourceGequhai") }}
              </button>
            </div>
            <template v-if="results.length">
              <template v-for="(item, i) in results" :key="item.id">
                <!-- 在线行（网易云）：试听 / 添加到曲库 / 下载 三按钮布局；行点击 = 下载（保留现有行为） -->
                <div
                  v-if="item.kind === 'online'"
                  class="sa-row sa-row-online"
                  :class="{ active: i === activeIndex }"
                  role="button"
                  tabindex="0"
                  @mousemove="activeIndex = i"
                  @click="downloadOnline(item)"
                >
                  <span class="sa-badge" :class="'sa-badge-' + item.kind">
                    {{ item.badge || t("search.badge." + item.kind) }}
                  </span>
                  <span class="sa-info">
                    <span class="sa-title">{{ item.title }}</span>
                    <span v-if="item.subtitle" class="sa-subtitle">{{ item.subtitle }}</span>
                  </span>
                  <span class="sa-acts">
                    <button
                      v-if="onlineSource === 'netease'"
                      type="button"
                      class="sa-act"
                      :title="t('search.preview')"
                      :aria-label="t('search.preview')"
                      @click.stop="previewOnline(item)"
                    >
                      <Play :size="13" />
                    </button>
                    <button
                      v-if="onlineSource === 'netease'"
                      type="button"
                      class="sa-act"
                      :title="t('search.addToLibrary')"
                      :aria-label="t('search.addToLibrary')"
                      @click.stop="addOnlineToLibrary(item)"
                    >
                      <Plus :size="13" />
                    </button>
                    <button
                      type="button"
                      class="sa-act"
                      :class="{ busy: downloading[item.id] }"
                      :title="t('search.download')"
                      :aria-label="t('search.download')"
                      @click.stop="downloadOnline(item)"
                    >
                      <Loader2 v-if="downloading[item.id]" :size="13" class="sa-spin" />
                      <Download v-else :size="13" />
                    </button>
                  </span>
                </div>
                <button
                  v-else
                  type="button"
                  class="sa-row"
                  :class="{ active: i === activeIndex }"
                  @mousemove="activeIndex = i"
                  @click="onRowClick(item)"
                >
                  <span class="sa-badge" :class="'sa-badge-' + item.kind">
                    {{ item.badge || t("search.badge." + item.kind) }}
                  </span>
                  <span class="sa-info">
                    <span class="sa-title">{{ item.title }}</span>
                    <span v-if="item.subtitle" class="sa-subtitle">{{ item.subtitle }}</span>
                  </span>
                  <ChevronRight
                    v-if="item.kind === 'setting'"
                    :size="14"
                    class="sa-chevron"
                    :class="{ open: expandedId === item.id }"
                  />
                  <Play v-else-if="item.kind === 'song'" :size="14" class="sa-row-ic" />
                </button>
                <!-- 设置行展开的内联控件（同一时间只展开一个；按 payload 条目 id 匹配） -->
                <div
                  v-if="item.kind === 'setting' && expandedId === payloadId(item) && expandedEntry"
                  class="sa-inline"
                  @mousedown.stop
                >
                  <InlineControl :entry="expandedEntry" />
                </div>
              </template>
            </template>
            <div v-else class="sa-empty">
              {{ loading ? t("search.loading") : t("search.noResult") }}
            </div>
          </template>

          <!-- 空 query + 聚焦 + 有历史：历史列表（Spotlight 式；点击/回车直接搜索，✕ 单删） -->
          <div v-else-if="showHistory" class="sa-history">
            <div class="sa-history-head">
              <span class="sa-history-title">{{ t("search.searchHistory") }}</span>
              <button
                type="button"
                class="sa-history-clear"
                :title="t('search.searchHistoryClear')"
                @mousedown.prevent
                @click="clearHistory"
              >
                {{ t("search.searchHistoryClear") }}
              </button>
            </div>
            <div
              v-for="(item, i) in history"
              :key="item"
              class="sa-row sa-history-row"
              :class="{ active: i === activeIndex }"
              role="button"
              tabindex="0"
              @mousedown.prevent
              @mousemove="activeIndex = i"
              @click="activateHistory(item)"
            >
              <History :size="14" class="sa-history-ic" />
              <span class="sa-info">
                <span class="sa-title">{{ item }}</span>
              </span>
              <button
                type="button"
                class="sa-act sa-history-del"
                :title="t('search.clear')"
                :aria-label="t('search.clear')"
                @mousedown.prevent
                @click.stop="removeHistory(item)"
              >
                <X :size="13" />
              </button>
            </div>
          </div>

          <!-- 空态（未输入）：提示输入（不展示任何结果/设置目录） -->
          <div v-else class="sa-empty">
            <Search :size="16" class="sa-empty-ic" />
            {{ t("search.typeToSearch") }}
          </div>
        </div>

        <!-- 底部快捷键提示 -->
        <div class="sa-foot">
          <span><kbd>↑↓</kbd>{{ t("search.navHint") }}</span>
          <span><kbd>↵</kbd>{{ t("search.enterHint") }}</span>
          <span><kbd>Esc</kbd>{{ t("search.escHint") }}</span>
        </div>
      </div>

      <!-- 下载/添加结果提示：走全局 toast（ToastContainer），搜索层收起后仍可见 -->
    </div>
  </Transition>

  <!-- 夸克扫码登录弹窗（歌曲海下载 401 时触发；Teleport 到 body） -->
  <QuarkLoginModal :open="loginOpen" @success="onQuarkLoginSuccess" @close="loginOpen = false" />
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, Loader2, Play, Plus, Download, ChevronRight, History } from "@lucide/vue";
import {
  selectSong,
  play,
  playPreview,
  findSongIndex,
  playbackSettings,
  fmtShortcutKey,
  parseShortcutCombo,
  type Song,
} from "../composables/usePlayer.js";
import { downloadSettings } from "../composables/useSettings.js";
import { useSearchAnything, type SearchResult } from "../composables/useSearchAnything.js";
import { showToast, toastError } from "../composables/useToast.js";
import { apiPost } from "../utils/apiClient.js";
import { settingsIndex, type SettingEntry } from "../settingsIndex";
import InlineControl from "./InlineControl.vue";
import QuarkLoginModal from "./QuarkLoginModal.vue";

const props = defineProps({
  // true = 顶栏入口（只渲染放大镜按钮）；false = 全屏搜索层本体
  entry: { type: Boolean, default: false },
});
const emit = defineEmits(["pick"]); // 歌手/专辑点击 → 分组浏览（stub：maintainer 集成时接）

const { t } = useI18n();

const {
  query,
  results,
  loading,
  isSearchOpen,
  onlineSource,
  history,
  setOnlineSource,
  clear,
  addHistory,
  removeHistory,
  clearHistory,
} = useSearchAnything();

const inputEl = ref<HTMLInputElement | null>(null);
const inputFocused = ref(false); // 输入框聚焦态：空 query + 聚焦才显示历史列表
const activeIndex = ref(-1); // 高亮行索引（有输入=结果行；空输入=历史行，复用同一索引）
const expandedId = ref<string | null>(null); // 当前展开内联控件的设置条目 id（互斥单开）
const downloading = reactive<Record<string, boolean>>({}); // 在线条目 id → 下载中
const adding = reactive<Record<string, boolean>>({}); // 在线条目 id → 添加到曲库中

// 空 query + 输入框聚焦 + 有历史 → 显示历史列表（否则提示输入）
const showHistory = computed(
  () => !String(query.value).trim() && inputFocused.value && history.value.length > 0,
);

const expandedEntry = computed(() => settingsIndex.find((e) => e.id === expandedId.value) || null);

/** 设置行 payload 的 id（展开匹配用）；非对象/缺 id → undefined */
function payloadId(item: SearchResult): string | undefined {
  const p = item.payload;
  if (!p || typeof p !== "object") return undefined;
  return typeof (p as { id?: unknown }).id === "string"
    ? ((p as { id: string }).id as string)
    : undefined;
}

// 当前快捷键显示（默认 ⌘K；录制值含 "Meta+" 前缀 → ⌘ 组合）
const fmtSearchKey = computed(() => fmtShortcutKey(playbackSettings.searchKey));

// Cmd+K（或用户录制键）匹配："Meta+<code>" = ⌘ 组合；纯 <code> = 单键触发。
// 单键快捷在输入框/文本域聚焦时不触发（防止打字误唤/误关）；组合键（Cmd+K）不受限。
function matchSearchShortcut(e: KeyboardEvent) {
  const p = parseShortcutCombo(playbackSettings.searchKey || "Meta+K");
  if (!p) return false;
  if (p.meta) return e.metaKey && e.code === p.code;
  if (e.code !== p.code) return false;
  if (
    (e.target && (e.target as HTMLElement).tagName === "INPUT") ||
    (e.target as HTMLElement).tagName === "TEXTAREA" ||
    (e.target as HTMLElement).isContentEditable
  ) {
    return e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  }
  return true;
}

// 全局键盘：capture 阶段（先于 SettingsModal 的 bubble Esc 监听，避免两层一起收起）
function onWindowKeydown(e: KeyboardEvent) {
  // 唤起/收起快捷键
  if (matchSearchShortcut(e)) {
    e.preventDefault();
    isSearchOpen.value = !isSearchOpen.value;
    return;
  }
  if (!isSearchOpen.value) return;
  if (e.isComposing) return; // 中文输入法组词中的 Enter 不执行
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation(); // 只收搜索层，不连带关闭下层设置弹窗
    close();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); // 输入框内防止光标移动
    const dir = e.key === "ArrowDown" ? 1 : -1;
    if (!String(query.value).trim()) {
      // 空 query：高亮在历史列表内循环移动（复用 activeIndex）
      if (!showHistory.value) return;
      const n = history.value.length;
      const next = activeIndex.value + dir;
      activeIndex.value = next < 0 ? n - 1 : next % n;
      return;
    }
    if (!results.value.length) return;
    const next = activeIndex.value + dir;
    activeIndex.value = next < 0 ? results.value.length - 1 : next % results.value.length;
    return;
  }
  if (e.key === "Enter") {
    const q = String(query.value).trim();
    if (!q) {
      // 空 query：Enter 执行高亮的历史项（无高亮忽略；Esc 收起行为不变）
      if (showHistory.value && activeIndex.value >= 0) {
        e.preventDefault();
        activateHistory(history.value[activeIndex.value]);
      }
      return;
    }
    addHistory(q); // 显式 Enter 提交才记录（防抖自动搜索不记录）
    const idx = activeIndex.value >= 0 ? activeIndex.value : 0;
    const item = results.value[idx];
    if (item) {
      e.preventDefault();
      onRowClick(item);
    }
  }
}

// 打开时自动聚焦搜索框
watch(isSearchOpen, (open) => {
  if (open) nextTick(() => inputEl.value?.focus());
});

// 输入变化：重置高亮与展开
watch(query, () => {
  activeIndex.value = -1;
  expandedId.value = null;
});

function close() {
  isSearchOpen.value = false;
  clear();
  expandedId.value = null;
  activeIndex.value = -1;
}

function clearQuery() {
  query.value = "";
}

// 点击/回车历史项：填入 query（走现有 watch→防抖搜索链路）并去重置顶
function activateHistory(term: string) {
  const q = String(term ?? "").trim();
  if (!q) return;
  query.value = q;
  addHistory(q); // 已在历史中则移到最前（去重）
}

// ============ 结果行交互 ============
function onRowClick(item: SearchResult) {
  switch (item.kind) {
    case "song":
      playLocal(item);
      break;
    case "online":
      downloadOnline(item);
      break;
    case "setting":
      toggleEntry(item.payload as SettingEntry);
      break;
    case "artist":
    case "album":
      // 分组浏览：收起搜索层后交给 App 根部 @pick 处理（进入 Playlist 分组视图）
      isSearchOpen.value = false;
      emit("pick", item);
      break;
  }
}

// 本地歌曲点击 → 播放（selectSong/play），播放后收起搜索层
function playLocal(item: SearchResult) {
  const p = (item.payload || {}) as Song;
  const idx = findSongIndex(p);
  if (idx < 0) return;
  selectSong(idx);
  play();
  close();
}

/** 在线条目 payload（/api/online/search items[] 与歌曲海共用字段的宽松视图） */
interface OnlinePayload {
  id?: string | number;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  duration?: number;
}

// 在线歌曲点击 = 下载：网易云走 /api/online/download（level=默认音质）；
// 歌曲海走 /api/gequhai/download（夸克 HQ），401 未登录 → 弹扫码登录，成功后自动重试
async function downloadOnline(item: SearchResult) {
  if (downloading[item.id]) return;
  const p = (item.payload || {}) as OnlinePayload;
  downloading[item.id] = true;
  try {
    const isGequhai = onlineSource.value === "gequhai";
    // 歌曲海下载 401 = 夸克未登录（非配对失效），skip401 关闭特判
    const res = await apiPost(
      isGequhai ? "/api/gequhai/download" : "/api/online/download",
      isGequhai
        ? { id: p.id, title: p.title || item.title, artist: p.artist || "" }
        : {
            id: p.id,
            level: downloadSettings.defaultQuality,
            title: p.title || item.title,
            artist: p.artist || "",
          },
      { skip401: isGequhai },
    );
    if (res.status === 401 && isGequhai) {
      pendingDownload.value = item; // 登录成功后自动重试
      loginOpen.value = true;
      return;
    }
    if (!res.ok) {
      const data = res.data || {};
      throw new Error(data.error || data.message || "");
    }
    showToast(t("search.downloadSuccess", { title: item.title }));
    // 下载完成提示走全局 toast（ToastContainer）：搜索层收起/切页后也能看到
  } catch (err) {
    toastError(
      t("search.downloadFailed", {
        msg: err instanceof Error ? err.message : t("search.noResult"),
      }),
    );
  } finally {
    downloading[item.id] = false;
  }
}

// 在线歌曲试听（网易云）：实时取直链 → playPreview（临时播放列表语义：
// 不改曲库/队列/currentIndex，播完自然停，切歌回主队列；默认不计播放统计）
async function previewOnline(item: SearchResult) {
  const p = (item.payload || {}) as OnlinePayload;
  const ok = await playPreview({
    provider: "netease",
    id: p.id,
    title: p.title || item.title,
    artist: p.artist || "",
    album: p.album || "",
    cover: p.cover,
    duration: p.duration,
  });
  // 直链获取失败时 playPreview 已 toast 错误，这里只报成功
  if (ok) showToast(t("search.previewing", { title: item.title }));
}

// 添加到曲库：POST /api/network-songs（后端幂等去重；曲库 3s 轮询自动刷新）
async function addOnlineToLibrary(item: SearchResult) {
  if (adding[item.id]) return;
  adding[item.id] = true;
  const p = (item.payload || {}) as OnlinePayload;
  try {
    const res = await apiPost("/api/network-songs", {
      id: p.id,
      title: p.title || item.title,
      artist: p.artist || "",
      album: p.album || undefined,
      coverUrl: p.cover || undefined,
      duration: p.duration || undefined,
    });
    // 幂等去重：409 或响应携带 alreadyExists/alreadyInLibrary 标记 → 提示已在曲库
    let already = res.status === 409;
    let failed = false;
    let errMsg = "";
    if (!already) {
      const data = res.data || {};
      if (res.ok) {
        already = !!(data && (data.alreadyExists || data.alreadyInLibrary));
      } else {
        failed = true;
        errMsg = data.error || data.detail || "";
      }
    }
    if (already) {
      toastError(t("search.alreadyInLibrary", { title: item.title }));
      return;
    }
    if (failed) throw new Error(errMsg);
    showToast(t("search.addedToLibrary", { title: item.title }));
  } catch (err) {
    toastError(t("search.addToLibraryFailed", { msg: err instanceof Error ? err.message : "" }));
  } finally {
    adding[item.id] = false;
  }
}

// ============ 夸克扫码登录（歌曲海下载 401 时触发）============
const loginOpen = ref(false);
const pendingDownload = ref<SearchResult | null>(null); // 登录成功后要自动重试的在线条目

function onQuarkLoginSuccess() {
  loginOpen.value = false;
  showToast(t("online.quarkLoginOk"));
  const item = pendingDownload.value;
  pendingDownload.value = null;
  if (item) downloadOnline(item); // 自动重试刚才的下载
}

// 设置行展开内联控件：再点收起；同一时间只展开一个
function toggleEntry(entry: SettingEntry) {
  if (!entry) return;
  expandedId.value = expandedId.value === entry.id ? null : entry.id;
}

onMounted(() => {
  // Cmd+K 监听只在搜索层本体注册（entry 只是按钮，避免双实例双监听导致双切换）
  if (!props.entry) window.addEventListener("keydown", onWindowKeydown, true);
});
onBeforeUnmount(() => {
  if (!props.entry) window.removeEventListener("keydown", onWindowKeydown, true);
});
</script>

<style scoped>
/* ============ 入口（顶栏小放大镜） ============ */
.sa-entry {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  flex-shrink: 0;
}
@media (hover: hover) {
  .sa-entry:hover {
    color: var(--text);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}

/* ============ 全屏搜索层 ============ */
.sa-mask {
  /* !important：App.vue 的 `.app > :not(.bg-blur)`（specificity 0,3,0）会覆盖本组件 scoped
     的 position:fixed（0,2,0）→ 遮罩变 relative 锚到底部，内容高度变化时整个搜索层位移
     （2026-08-16 用户反馈“输入时搜索框位置跳动”的根因） */
  position: fixed !important;
  inset: 0 !important;
  z-index: 200 !important; /* 高于顶栏(2)/弹窗(100)，盖住一切 */
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: min(14vh, 120px) 16px 16px;
  background: color-mix(in srgb, var(--bg) 55%, transparent);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  overflow-y: auto;
}
.sa-panel {
  width: 640px;
  max-width: 100%;
  max-height: min(72vh, 680px);
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--card) 88%, transparent);
  border: 1px solid var(--border);
  border-radius: 18px;
  box-shadow: 0 24px 72px var(--shadow-strong);
  overflow: hidden;
}
/* 搜索框 */
.sa-input-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sa-input-icon {
  color: var(--accent2);
  flex-shrink: 0;
}
.sa-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 17px;
}
.sa-input::placeholder {
  color: var(--text3);
}
.sa-clear {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  transition: all 0.12s;
}
@media (hover: hover) {
  .sa-clear:hover {
    background: var(--border);
    color: var(--text);
  }
}
.sa-spin {
  color: var(--text3);
  flex-shrink: 0;
  animation: sa-spin 0.9s linear infinite;
}
@keyframes sa-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* 结果区 */
.sa-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px;
}
/* 在线源切换条（网易云 / 歌曲海）：轻量 segmented，随结果区滚动 */
.sa-sources {
  display: flex;
  gap: 6px;
  padding: 2px 4px 8px;
  justify-content: center;
}
.sa-source {
  font-size: 11px;
  line-height: 1;
  padding: 5px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-color, rgba(128, 128, 128, 0.35));
  color: var(--text-secondary, #999);
  background: transparent;
  cursor: pointer;
  transition: all 0.15s ease;
}
.sa-source:hover {
  border-color: var(--accent, #f97316);
  color: var(--text-primary, #eee);
}
.sa-source.on {
  background: var(--accent, #f97316);
  border-color: var(--accent, #f97316);
  color: #fff;
}
.sa-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border-radius: 11px;
  text-align: left;
  transition: background 0.1s;
  color: inherit;
}
.sa-row.active {
  background: var(--accent-soft);
}
@media (hover: hover) {
  .sa-row:hover {
    background: var(--accent-soft);
  }
}
/* 类别 badge：五类不同配色 */
.sa-badge {
  font-size: 10.5px;
  font-weight: 700;
  padding: 3px 8px;
  border-radius: 7px;
  white-space: nowrap;
  flex-shrink: 0;
}
.sa-badge-song {
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.sa-badge-online {
  color: #fff;
  background: #f43f5e;
}
.sa-badge-artist {
  color: #fff;
  background: #5b9dff;
}
.sa-badge-album {
  color: #fff;
  background: #a78bfa;
}
.sa-badge-setting {
  color: #fff;
  background: #34d399;
}
.sa-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.sa-title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sa-subtitle {
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sa-chevron {
  color: var(--text3);
  flex-shrink: 0;
  transition: transform 0.18s;
}
.sa-chevron.open {
  transform: rotate(90deg);
  color: var(--accent);
}
.sa-row-ic {
  color: var(--accent);
  flex-shrink: 0;
}
.sa-row-ic.busy {
  opacity: 0.5;
}
/* 在线行：三按钮布局（试听 / 添加到曲库 / 下载） */
.sa-row-online {
  cursor: pointer;
}
.sa-acts {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.sa-act {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  transition: all 0.12s;
}
@media (hover: hover) {
  .sa-act:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }
}
.sa-act.busy {
  opacity: 0.5;
  pointer-events: none;
} /* 设置行展开的内联控件 */
.sa-inline {
  margin: 0 10px 8px 10px;
  padding: 10px 14px;
  border-radius: 11px;
  background: var(--bg2);
  border: 1px solid var(--border);
}
.sa-empty {
  padding: 40px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--text3);
}

/* 空态设置目录 */
.sa-dir-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 1.2px;
  color: var(--accent2);
}
.sa-dir-group + .sa-dir-group {
  margin-top: 4px;
}
.sa-dir-title {
  font-size: 12px;
  font-weight: 700;
  color: var(--text2);
  padding: 8px 10px 4px;
}
.sa-dir-empty {
  padding: 4px 10px 8px;
  font-size: 11.5px;
  color: var(--text3);
  opacity: 0.7;
}
.sa-dir-row .sa-title {
  font-weight: 500;
  font-size: 13.5px;
}

/* 底部提示 */
.sa-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 9px 18px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
}
.sa-foot kbd {
  font-family: inherit;
  font-size: 10.5px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 1px 5px;
  margin-right: 4px;
}

/* 历史列表 */
.sa-history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px 6px 14px;
}
.sa-history-title {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.5px;
  color: var(--text3);
}
.sa-history-clear {
  font-size: 11px;
  color: var(--text3);
  padding: 3px 8px;
  border-radius: 7px;
  transition: all 0.12s;
}
@media (hover: hover) {
  .sa-history-clear:hover {
    color: var(--accent);
    background: var(--accent-soft);
  }
}
.sa-history-row {
  cursor: pointer;
}
.sa-history-ic {
  color: var(--text3);
  flex-shrink: 0;
}
.sa-history-row .sa-title {
  font-weight: 500;
}
.sa-history-del {
  opacity: 0.55;
  transition: all 0.12s;
}
@media (hover: hover) {
  .sa-history-del:hover {
    opacity: 1;
    color: var(--accent);
    background: var(--accent-soft);
  }
}

/* 淡入 */
.sa-fade-enter-active,
.sa-fade-leave-active {
  transition: opacity 0.18s ease;
}
.sa-fade-enter-from,
.sa-fade-leave-to {
  opacity: 0;
}

/* 移动端（<1024px）：面板全宽贴顶，字号自适应 */
@media (max-width: 1023.98px) {
  .sa-mask {
    align-items: stretch;
    padding: calc(12px + env(safe-area-inset-top)) 10px 10px;
  }
  .sa-panel {
    width: 100%;
    max-height: none;
    border-radius: 16px;
  }
  .sa-input-wrap {
    padding: 12px 14px;
  }
  .sa-input {
    font-size: 16px;
  }
  .sa-foot {
    gap: 10px;
    padding: 8px 14px;
  }
  /* 在线行动作按钮：增大触摸目标 */
  .sa-act {
    width: 32px;
    height: 32px;
  }
}
</style>
