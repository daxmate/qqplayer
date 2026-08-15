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
                <button
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
                  <Download
                    v-else-if="item.kind === 'online'"
                    :size="13"
                    class="sa-row-ic"
                    :class="{ busy: downloading[item.id] }"
                  />
                </button>
                <!-- 设置行展开的内联控件（同一时间只展开一个；按 payload 条目 id 匹配） -->
                <div
                  v-if="item.kind === 'setting' && expandedId === item.payload?.id && expandedEntry"
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

          <!-- 空态（未输入）：设置目录 —— 全部设置项按分类分组 -->
          <div v-else class="sa-dir">
            <div class="sa-dir-head">
              <SlidersHorizontal :size="13" />
              {{ t("search.dirTitle") }}
            </div>
            <div v-for="cat in categories" :key="cat.key" class="sa-dir-group">
              <div class="sa-dir-title">{{ t(cat.labelKey) }}</div>
              <template v-if="entriesOf(cat.key).length">
                <template v-for="e in entriesOf(cat.key)" :key="e.id">
                  <button
                    type="button"
                    class="sa-row sa-dir-row"
                    :class="{ active: expandedId === e.id }"
                    @click="toggleEntry(e)"
                  >
                    <span class="sa-badge sa-badge-setting">{{ t("search.badge.setting") }}</span>
                    <span class="sa-info">
                      <span class="sa-title">{{ t(e.labelKey) }}</span>
                    </span>
                    <ChevronRight
                      :size="14"
                      class="sa-chevron"
                      :class="{ open: expandedId === e.id }"
                    />
                  </button>
                  <div
                    v-if="expandedId === e.id && expandedEntry"
                    class="sa-inline"
                    @mousedown.stop
                  >
                    <InlineControl :entry="expandedEntry" />
                  </div>
                </template>
              </template>
              <div v-else class="sa-dir-empty">{{ t("search.dirEmpty") }}</div>
            </div>
          </div>
        </div>

        <!-- 底部快捷键提示 -->
        <div class="sa-foot">
          <span><kbd>↑↓</kbd>{{ t("search.navHint") }}</span>
          <span><kbd>↵</kbd>{{ t("search.enterHint") }}</span>
          <span><kbd>Esc</kbd>{{ t("search.escHint") }}</span>
        </div>
      </div>

      <!-- 下载结果 toast -->
      <Transition name="sa-toast">
        <div v-if="toast" class="sa-toast" :class="{ err: toastErr }">{{ toast }}</div>
      </Transition>
    </div>
  </Transition>

  <!-- 夸克扫码登录弹窗（歌曲海下载 401 时触发；Teleport 到 body） -->
  <QuarkLoginModal :open="loginOpen" @success="onQuarkLoginSuccess" @close="loginOpen = false" />
</template>

<script setup>
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, Loader2, Play, Download, ChevronRight, SlidersHorizontal } from "@lucide/vue";
import { state, selectSong, play, playbackSettings } from "../composables/usePlayer.js";
import { downloadSettings } from "../composables/useSettings.js";
import { useSearchAnything } from "../composables/useSearchAnything.js";
import { SETTING_CATEGORIES, settingsIndex } from "../settingsIndex.js";
import InlineControl from "./InlineControl.vue";
import QuarkLoginModal from "./QuarkLoginModal.vue";

const props = defineProps({
  // true = 顶栏入口（只渲染放大镜按钮）；false = 全屏搜索层本体
  entry: { type: Boolean, default: false },
});
const emit = defineEmits(["pick"]); // 歌手/专辑点击 → 分组浏览（stub：maintainer 集成时接）

const { t } = useI18n();

const { query, results, loading, isSearchOpen, onlineSource, setOnlineSource, clear } =
  useSearchAnything();

const inputEl = ref(null);
const activeIndex = ref(-1); // 结果高亮行索引
const expandedId = ref(null); // 当前展开内联控件的设置条目 id（互斥单开）
const downloading = reactive({}); // 在线条目 id → 下载中
const toast = ref("");
const toastErr = ref(false);

const categories = SETTING_CATEGORIES;
const expandedEntry = computed(() => settingsIndex.find((e) => e.id === expandedId.value) || null);

function entriesOf(categoryKey) {
  return settingsIndex.filter((e) => e.category === categoryKey);
}

// 当前快捷键显示（默认 Meta+K → ⌘K；用户录的单键 → 键名）
const fmtSearchKey = computed(() => {
  const k = playbackSettings.searchKey || "Meta+K";
  if (k === "Meta+K") return "⌘K";
  const arrows = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
  if (arrows[k]) return arrows[k];
  if (k.startsWith("Key")) return k.slice(3);
  if (k.startsWith("Digit")) return k.slice(5);
  return k;
});

// Cmd+K（或用户录制键）匹配：默认 Meta+K = Cmd+K；录制单键则纯单键触发。
// 单键快捷在输入框/文本域聚焦时不触发（防止打字误唤/误关）；组合键（Cmd+K）不受限。
function matchSearchShortcut(e) {
  const k = playbackSettings.searchKey || "Meta+K";
  if (k === "Meta+K") return e.metaKey && e.code === "KeyK";
  if (e.code !== k) return false;
  if (
    e.target &&
    (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable)
  ) {
    return e.metaKey || e.ctrlKey || e.altKey || e.shiftKey;
  }
  return true;
}

// 全局键盘：capture 阶段（先于 SettingsModal 的 bubble Esc 监听，避免两层一起收起）
function onWindowKeydown(e) {
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
    if (!results.value.length) return;
    const dir = e.key === "ArrowDown" ? 1 : -1;
    const next = activeIndex.value + dir;
    activeIndex.value = next < 0 ? results.value.length - 1 : next % results.value.length;
    return;
  }
  if (e.key === "Enter") {
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

// ============ 结果行交互 ============
function onRowClick(item) {
  switch (item.kind) {
    case "song":
      playLocal(item);
      break;
    case "online":
      downloadOnline(item);
      break;
    case "setting":
      toggleEntry(item.payload);
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
function playLocal(item) {
  const p = item.payload || {};
  const idx = state.songs.findIndex((s) => s.path === p.path);
  if (idx < 0) return;
  selectSong(idx);
  play();
  close();
}

// 在线歌曲点击 = 下载：网易云走 /api/online/download（level=默认音质）；
// 歌曲海走 /api/gequhai/download（夸克 HQ），401 未登录 → 弹扫码登录，成功后自动重试
async function downloadOnline(item) {
  if (downloading[item.id]) return;
  const p = item.payload || {};
  downloading[item.id] = true;
  try {
    const isGequhai = onlineSource.value === "gequhai";
    const res = await fetch(isGequhai ? "/api/gequhai/download" : "/api/online/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        isGequhai
          ? { id: p.id, title: p.title || item.title, artist: p.artist || "" }
          : {
              id: p.id,
              level: downloadSettings.defaultQuality,
              title: p.title || item.title,
              artist: p.artist || "",
            },
      ),
    });
    if (res.status === 401 && isGequhai) {
      pendingDownload.value = item; // 登录成功后自动重试
      loginOpen.value = true;
      return;
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || data.message || "");
    }
    showToast(t("search.downloadSuccess", { title: item.title }), false);
  } catch (err) {
    showToast(t("search.downloadFailed", { msg: err.message || t("search.noResult") }), true);
  } finally {
    downloading[item.id] = false;
  }
}

// ============ 夸克扫码登录（歌曲海下载 401 时触发）============
const loginOpen = ref(false);
const pendingDownload = ref(null); // 登录成功后要自动重试的在线条目

function onQuarkLoginSuccess() {
  loginOpen.value = false;
  showToast(t("online.quarkLoginOk"), false);
  const item = pendingDownload.value;
  pendingDownload.value = null;
  if (item) downloadOnline(item); // 自动重试刚才的下载
}

// 设置行展开内联控件：再点收起；同一时间只展开一个
function toggleEntry(entry) {
  if (!entry) return;
  expandedId.value = expandedId.value === entry.id ? null : entry.id;
}

let toastTimer = null;
function showToast(msg, isErr) {
  toast.value = msg;
  toastErr.value = isErr;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.value = "";
  }, 3200);
}

onMounted(() => {
  // Cmd+K 监听只在搜索层本体注册（entry 只是按钮，避免双实例双监听导致双切换）
  if (!props.entry) window.addEventListener("keydown", onWindowKeydown, true);
});
onBeforeUnmount(() => {
  if (!props.entry) window.removeEventListener("keydown", onWindowKeydown, true);
  clearTimeout(toastTimer);
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
  position: fixed;
  inset: 0;
  z-index: 200; /* 高于顶栏(2)/弹窗(100)，盖住一切 */
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
/* 设置行展开的内联控件 */
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

/* toast */
.sa-toast {
  position: fixed;
  left: 50%;
  bottom: 84px;
  transform: translateX(-50%);
  z-index: 210;
  background: rgba(38, 41, 55, 0.95);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 10px 18px;
  border-radius: 12px;
  font-size: 12.5px;
  box-shadow: 0 10px 32px var(--shadow-strong);
  white-space: nowrap;
  max-width: calc(100vw - 32px);
  overflow: hidden;
  text-overflow: ellipsis;
}
.sa-toast.err {
  border-color: rgba(255, 107, 107, 0.5);
  color: #ffb3b3;
}
.sa-toast-enter-active,
.sa-toast-leave-active {
  transition:
    opacity 0.25s,
    transform 0.25s;
}
.sa-toast-enter-from,
.sa-toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
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
}
</style>
