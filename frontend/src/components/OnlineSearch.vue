<template>
  <div ref="rootEl" class="os" :class="variant">
    <!-- 搜索框 -->
    <div class="os-input-wrap">
      <Search :size="14" class="os-icon" />
      <input
        v-model="query"
        class="os-input"
        type="text"
        :placeholder="t('online.searchPlaceholder')"
        spellcheck="false"
        @focus="open = true"
        @keydown="onInputKeydown"
      />
      <button
        v-if="query"
        class="os-clear"
        :title="t('online.clear')"
        @mousedown.prevent="clearQuery"
      >
        <X :size="12" />
      </button>
    </div>

    <!-- 结果面板：本地歌曲 + 在线（网易云）两组 -->
    <div v-if="open" class="os-panel">
      <div class="os-group">
        <div class="os-group-title">{{ t("online.groupLocal") }}</div>
        <template v-if="localMatches.length">
          <button
            v-for="song in localMatches"
            :key="song.path ?? ''"
            class="os-item os-local"
            :data-path="song.path"
            @click="playLocal(song)"
          >
            <span class="os-cover os-cover-local">
              <Music :size="15" />
            </span>
            <span class="os-info">
              <span class="os-name">{{ song.name }}</span>
              <span class="os-sub"
                >{{ song.artist }}<template v-if="song.album"> · {{ song.album }}</template></span
              >
            </span>
            <Play :size="14" class="os-play-ic" />
          </button>
        </template>
        <div v-else class="os-empty">
          {{ query.trim() ? t("online.localEmpty") : t("online.typeHint") }}
        </div>
      </div>

      <div class="os-group">
        <div class="os-group-title-row">
          <span class="os-group-title">{{
            source === "gequhai" ? t("online.groupOnlineGequhai") : t("online.groupOnline")
          }}</span>
          <div class="src-seg">
            <button
              class="src-btn"
              :class="{ on: source === 'netease' }"
              @click="switchSource('netease')"
            >
              {{ t("online.sourceNetease") }}
            </button>
            <button
              class="src-btn"
              :class="{ on: source === 'gequhai' }"
              @click="switchSource('gequhai')"
            >
              {{ t("online.sourceGequhai") }}
            </button>
          </div>
        </div>
        <div v-if="loading" class="os-loading">
          <Loader2 :size="14" class="spin" />
          {{ t("online.loading") }}
        </div>
        <template v-else-if="onlineItems.length">
          <div v-for="item in onlineItems" :key="item.id" class="os-item os-online">
            <span class="os-cover">
              <img
                v-if="item.cover"
                :src="item.cover"
                alt=""
                loading="lazy"
                @error="item.cover = ''"
              />
              <Music v-else :size="15" />
            </span>
            <span class="os-info">
              <span class="os-name">{{ item.title }}</span>
              <span class="os-sub">
                {{ item.artist }}<template v-if="item.album"> · {{ item.album }}</template>
                <template v-if="item.duration"> · {{ item.duration }}</template>
              </span>
            </span>
            <span class="os-quality">{{ qualityLabel }}</span>
            <button
              class="os-download"
              :class="{ busy: downloading[item.id] }"
              :disabled="downloading[item.id]"
              @click="download(item)"
            >
              <Loader2 v-if="downloading[item.id]" :size="12" class="spin" />
              <Download v-else :size="12" />
              {{ downloading[item.id] ? t("online.downloading") : t("online.download") }}
            </button>
          </div>
        </template>
        <div v-else-if="searchError" class="os-empty os-err">{{ searchError }}</div>
        <div v-else-if="searched" class="os-empty">{{ t("online.noResult") }}</div>
        <div v-else class="os-empty">{{ t("online.typeHint") }}</div>
      </div>
    </div>

    <!-- 夸克扫码登录（歌曲海下载 401 时弹出；登录成功自动重试下载） -->
    <QuarkLoginModal
      :open="quarkLoginOpen"
      @success="onQuarkLoginSuccess"
      @close="quarkLoginOpen = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { Search, X, Music, Play, Download, Loader2 } from "@lucide/vue";
import { state, selectSong, play, findSongIndex, type Song } from "../composables/usePlayer.js";
import {
  downloadSettings,
  DOWNLOAD_QUALITY_OPTIONS,
  QUARK_QUALITY_OPTIONS,
} from "../composables/useSettings.js";
import { normalizeQuery, normalizeText } from "../utils/searchNormalize.js";
import { apiGet, apiPost } from "../utils/apiClient.js";
import { showToast, toastError } from "../composables/useToast.js";
import QuarkLoginModal from "./QuarkLoginModal.vue";

// 在线搜索防抖时长（输入停止后才请求）
const DEBOUNCE_MS = 400;
// 在线结果数量上限（契约：limit 1-50）
const ONLINE_LIMIT = 20;
// 本地结果最多展示条数
const LOCAL_LIMIT = 8;

defineProps({
  // 展示形态：'desktop' 顶栏下拉（绝对定位面板）| 'mobile' 移动端内联展开
  variant: { type: String, default: "desktop" },
});
const emit = defineEmits(["open-player"]);

const { t } = useI18n();

/** 在线搜索结果条目（/api/online/search → items[] 与 /api/gequhai/search 共用字段） */
interface OnlineItem {
  id: string;
  title?: string;
  artist?: string;
  album?: string;
  cover?: string;
  duration?: string;
}

const rootEl = ref<HTMLElement | null>(null);
const query = ref("");
const open = ref(false);
const loading = ref(false); // 在线请求中
const searched = ref(false); // 是否已完成过至少一次在线搜索（控制空结果文案）
const searchError = ref("");
const onlineItems = ref<OnlineItem[]>([]);
const downloading = reactive<Record<string, boolean>>({}); // 在线条目 id → 下载中

// 在线源：'netease' 网易云（默认，现有行为不变）| 'gequhai' 歌曲海（夸克网盘直链下载）
const source = ref("netease");
const quarkLoginOpen = ref(false); // 夸克扫码登录弹窗
let pendingDownload: OnlineItem | null = null; // 401 触发登录时待重试的歌曲海条目

let debounceTimer: number | undefined;
let searchSeq = 0; // 请求序列号：过期响应丢弃（快速连续输入时）

// 本地歌曲匹配：title/artist/album 模糊匹配（复用 Playlist 过滤思路 + searchNormalize）
const localMatches = computed(() => {
  const q = normalizeQuery(query.value);
  if (!q) return [];
  return state.songs
    .filter((s) => {
      const text = normalizeText([s.name, s.artist, s.album].filter(Boolean).join(" "));
      return text.includes(q);
    })
    .slice(0, LOCAL_LIMIT);
});

// 音质标签：网易云 = 设置里的默认音质；歌曲海 = 夸克下载品质（quarkQuality）
const qualityLabel = computed(() => {
  const options = source.value === "gequhai" ? QUARK_QUALITY_OPTIONS : DOWNLOAD_QUALITY_OPTIONS;
  const key =
    source.value === "gequhai" ? downloadSettings.quarkQuality : downloadSettings.defaultQuality;
  const q = options.find((o) => o.key === key);
  return q
    ? t(q.labelKey)
    : t(
        source.value === "gequhai"
          ? "settings.quarkQualityOptions.mp3"
          : "settings.downloadQuality.exhigh",
      );
});

// 源切换：切源 → 重新搜索（保留输入；若已有在途/待发请求则作废）
function switchSource(next: string) {
  if (next === source.value) return;
  source.value = next;
  searchSeq++;
  clearTimeout(debounceTimer);
  const val = query.value.trim();
  if (!val) return;
  loading.value = true;
  runSearch();
}

// 输入变化 → 打开面板 + 防抖 400ms 触发在线搜索；清空 → 取消在途请求
watch(query, () => {
  const val = query.value.trim();
  searchSeq++;
  clearTimeout(debounceTimer);
  if (!val) {
    loading.value = false;
    onlineItems.value = [];
    searched.value = false;
    searchError.value = "";
    return;
  }
  open.value = true;
  loading.value = true;
  debounceTimer = setTimeout(runSearch, DEBOUNCE_MS);
});

// 输入框按键：Esc 收起面板
function onInputKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closePanel();
}

async function runSearch() {
  const val = query.value.trim();
  const seq = searchSeq;
  const src = source.value;
  // source 省略 = netease（现有行为不变）；歌曲海显式传 source=gequhai
  const srcParam = src === "gequhai" ? `&source=${src}` : "";
  try {
    // 在线搜索是实时数据，不走缓存
    const res = await apiGet(
      `/api/online/search?q=${encodeURIComponent(val)}&limit=${ONLINE_LIMIT}${srcParam}`,
    );
    if (seq !== searchSeq) return; // 过期响应丢弃
    if (!res.ok) throw new Error();
    const data = res.data || {};
    if (seq !== searchSeq) return;
    onlineItems.value = Array.isArray(data.items) ? data.items : [];
    searched.value = true;
    searchError.value = "";
  } catch {
    if (seq !== searchSeq) return;
    onlineItems.value = [];
    searched.value = true;
    searchError.value = t("online.searchFailed");
  } finally {
    if (seq === searchSeq) loading.value = false;
  }
}

// 本地歌曲点击：走现有选歌逻辑直接播放
function playLocal(song: Song) {
  const idx = findSongIndex(song);
  if (idx < 0) return;
  selectSong(idx);
  play();
  emit("open-player"); // 移动端父组件据此打开全屏播放器；桌面忽略
  closePanel();
}

// 下载：网易云走 /api/online/download（level=默认音质）；歌曲海走 /api/gequhai/download
// （走夸克直链，品质由 quarkQuality 设置决定；401 = 未登录 → 弹扫码登录，成功后自动重试）
// 按钮转圈禁用（单条目粒度），成功/失败 toast 提示
async function download(item: OnlineItem, opts: { noLoginPrompt?: boolean } = {}) {
  const { noLoginPrompt = false } = opts;
  if (downloading[item.id]) return;
  downloading[item.id] = true;
  try {
    if (source.value === "gequhai") {
      // 歌曲海下载 401 = 夸克未登录（非配对失效），skip401 关闭特判
      const res = await apiPost(
        "/api/gequhai/download",
        {
          id: item.id,
          title: item.title,
          artist: item.artist,
        },
        { skip401: true },
      );
      if (res.status === 401) {
        const data = res.data || {};
        // 登录成功后重试：不再弹框，失败直接提示
        if (noLoginPrompt) throw new Error(data.message || t("online.quarkLoginRequired"));
        pendingDownload = item;
        quarkLoginOpen.value = true;
        return;
      }
      if (!res.ok) {
        const data = res.data || {};
        throw new Error(data.error || "");
      }
      showToast(t("online.downloadSuccess", { title: item.title }));
      return;
    }
    // 网易云：现有逻辑不变
    const res = await apiPost("/api/online/download", {
      id: item.id,
      level: downloadSettings.defaultQuality,
      title: item.title,
      artist: item.artist,
    });
    if (!res.ok) {
      const data = res.data || {};
      throw new Error(data.error || "");
    }
    showToast(t("online.downloadSuccess", { title: item.title }));
  } catch (e) {
    toastError(
      t("online.downloadFailed", {
        msg: e instanceof Error ? e.message : t("online.searchFailed"),
      }),
    );
  } finally {
    downloading[item.id] = false;
  }
}

// 扫码登录成功：关闭弹窗并重试刚才被 401 拦下的下载
function onQuarkLoginSuccess() {
  quarkLoginOpen.value = false;
  const item = pendingDownload;
  pendingDownload = null;
  if (item) download(item, { noLoginPrompt: true });
}

function clearQuery() {
  query.value = "";
}

function closePanel() {
  open.value = false;
}

// 点击组件外部 → 收起面板
function onDocClick(e: MouseEvent) {
  if (rootEl.value && !rootEl.value.contains(e.target as Node)) closePanel();
}

onMounted(() => {
  document.addEventListener("click", onDocClick);
});
onBeforeUnmount(() => {
  document.removeEventListener("click", onDocClick);
  clearTimeout(debounceTimer);
});
</script>

<style scoped>
.os {
  position: relative;
}
.os-input-wrap {
  display: flex;
  align-items: center;
  gap: 7px;
  background: var(--card2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0 10px;
  height: 36px;
  color: var(--text3);
  transition: border-color 0.15s;
}
.os-input-wrap:focus-within {
  border-color: var(--accent);
}
.os-icon {
  flex-shrink: 0;
}
.os-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 13px;
}
.os-input::placeholder {
  color: var(--text3);
}
.os-clear {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  transition: all 0.12s;
}
@media (hover: hover) {
  .os-clear:hover {
    background: var(--border);
    color: var(--text);
  }
}

/* 结果面板：深色毛玻璃下拉（桌面） / 内联展开（移动端） */
.os-panel {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 120;
  width: 420px;
  max-width: calc(100vw - 24px);
  max-height: 60vh;
  overflow-y: auto;
  background: color-mix(in srgb, var(--bg) 88%, transparent);
  backdrop-filter: blur(18px);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 16px 48px var(--shadow-strong);
  padding: 8px;
}
/* 移动端：面板内联在搜索框下方（不悬浮），宽度跟容器 */
.os.mobile .os-panel {
  position: static;
  width: 100%;
  max-width: none;
  max-height: 46vh;
  box-shadow: none;
  margin-top: 2px;
  background: var(--card);
}

.os-group + .os-group {
  margin-top: 6px;
  border-top: 1px solid var(--border);
  padding-top: 6px;
}
.os-group-title {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent2);
  letter-spacing: 1.2px;
  padding: 6px 8px 4px;
}
.os-group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-right: 4px;
}
/* 源切换 segmented（网易云 / 歌曲海） */
.src-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 9px;
}
.src-btn {
  padding: 3px 10px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text3);
  transition: all 0.15s;
  white-space: nowrap;
}
@media (hover: hover) {
  .src-btn:hover {
    color: var(--text);
  }
}
.src-btn.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.os-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border-radius: 10px;
  text-align: left;
  transition: background 0.12s;
}
@media (hover: hover) {
  .os-item:hover {
    background: var(--card2);
  }
}
.os-item.os-local {
  cursor: pointer;
  color: inherit;
}
.os-cover {
  width: 34px;
  height: 34px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--card2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
}
.os-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.os-cover-local {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.os-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.os-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.os-sub {
  font-size: 11px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.os-play-ic {
  color: var(--accent);
  flex-shrink: 0;
}
.os-quality {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent);
  background: var(--accent-soft);
  padding: 2px 7px;
  border-radius: 7px;
  white-space: nowrap;
  flex-shrink: 0;
}
.os-download {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 11.5px;
  font-weight: 700;
  color: var(--text2);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  white-space: nowrap;
  flex-shrink: 0;
}
@media (hover: hover) {
  .os-download:hover:not(:disabled) {
    color: var(--accent-text);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}
.os-download.busy,
.os-download:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.os-empty {
  padding: 12px 8px;
  font-size: 12px;
  color: var(--text3);
  text-align: center;
}
.os-empty.os-err {
  color: #ff6b6b;
}
.os-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 14px 8px;
  font-size: 12px;
  color: var(--text3);
}
.spin {
  animation: os-spin 0.9s linear infinite;
}
@keyframes os-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
