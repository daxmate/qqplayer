<template>
  <div class="mh-page">
    <!-- 顶栏：标题 + 搜索/设置入口 -->
    <header class="mh-head">
      <h1 class="mh-title">{{ t("mobile.home.title") }}</h1>
      <div class="mh-actions">
        <button
          class="mh-icon-btn"
          :title="t('mobile.home.searchSong')"
          @click="$emit('open', searchEntry)"
        >
          <Search :size="20" />
        </button>
        <button
          class="mh-icon-btn"
          :title="t('mobile.home.settings')"
          @click="$emit('open-settings')"
        >
          <Settings :size="20" />
        </button>
      </div>
    </header>

    <div class="mh-scroll">
      <!-- 九张入口卡片 -->
      <div class="mh-grid">
        <button
          class="mh-card"
          @click="$emit('open', { name: 'list', kind: 'songs', title: t('mobile.home.allSongs') })"
        >
          <span class="mh-tile" style="--tile: var(--accent); --tile2: var(--accent2)">
            <Music2 :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.allSongs") }}</span>
            <span class="mh-card-count">{{
              t("mobile.count.song", { n: state.songs.length })
            }}</span>
          </span>
        </button>

        <button
          class="mh-card"
          @click="
            $emit('open', { name: 'list', kind: 'favorites', title: t('mobile.home.favorites') })
          "
        >
          <span class="mh-tile" style="--tile: #ff6b81; --tile2: #ff9aa8">
            <Heart :size="22" fill="currentColor" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.favorites") }}</span>
            <span class="mh-card-count">{{ t("mobile.count.song", { n: favoriteCount }) }}</span>
          </span>
        </button>

        <button
          class="mh-card"
          @click="
            $emit('open', { name: 'list', kind: 'playlists', title: t('mobile.home.playlists') })
          "
        >
          <span class="mh-tile" style="--tile: #34d399; --tile2: #6ee7b7">
            <ListMusic :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.playlists") }}</span>
            <span class="mh-card-count">{{
              t("mobile.count.playlist", { n: state.playlists.length })
            }}</span>
          </span>
        </button>

        <button
          class="mh-card"
          @click="$emit('open', { name: 'list', kind: 'artists', title: t('mobile.home.artists') })"
        >
          <span class="mh-tile" style="--tile: #5b9dff; --tile2: #8ab4ff">
            <Users :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.artists") }}</span>
            <span class="mh-card-count">{{
              t("mobile.count.artist", { n: artistGroups.length })
            }}</span>
          </span>
        </button>

        <button
          class="mh-card"
          @click="$emit('open', { name: 'list', kind: 'albums', title: t('mobile.home.albums') })"
        >
          <span class="mh-tile" style="--tile: #a78bfa; --tile2: #c4b5fd">
            <Disc3 :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.albums") }}</span>
            <span class="mh-card-count">{{
              t("mobile.count.album", { n: albumGroups.length })
            }}</span>
          </span>
        </button>

        <button class="mh-card" @click="openFilePicker">
          <span class="mh-tile" style="--tile: #f59e0b; --tile2: #fbbf24">
            <FolderInput :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.openFile") }}</span>
            <span class="mh-card-count">{{ t("mobile.home.importMusic") }}</span>
          </span>
        </button>

        <!-- 智能视图入口：最近添加 / 最近播放 / 常听排行 -->
        <button class="mh-card" @click="openSmartView('recentAdded')">
          <span class="mh-tile" style="--tile: #06b6d4; --tile2: #22d3ee">
            <Sparkles :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.recentAdded") }}</span>
            <span class="mh-card-count">{{
              t("mobile.count.song", { n: Math.min(SMART_VIEW_LIMIT, state.songs.length) })
            }}</span>
          </span>
        </button>

        <button class="mh-card" @click="openSmartView('recentPlayed')">
          <span class="mh-tile" style="--tile: #ec4899; --tile2: #f472b6">
            <History :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.recentPlayed") }}</span>
            <span class="mh-card-count">{{
              t("mobile.count.recentSongs", { n: SMART_VIEW_LIMIT })
            }}</span>
          </span>
        </button>

        <button class="mh-card" @click="openSmartView('topPlayed')">
          <span class="mh-tile" style="--tile: #eab308; --tile2: #fde047">
            <TrendingUp :size="22" />
          </span>
          <span class="mh-card-meta">
            <span class="mh-card-name">{{ t("mobile.home.topPlayed") }}</span>
            <span class="mh-card-count">{{ t("mobile.home.topPlayedDesc") }}</span>
          </span>
        </button>
      </div>

      <!-- 文件选择提示 -->
      <Transition name="mh-toast">
        <div v-if="toast" class="mh-toast">{{ toast }}</div>
      </Transition>

      <p class="mh-foot">{{ t("mobile.home.foot") }}</p>
    </div>

    <!-- 打开文件：手机浏览器文件选择（NAS 场景导入入口） -->
    <input
      ref="fileInput"
      class="mh-file-input"
      type="file"
      accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.aac"
      multiple
      @change="onFilePicked"
    />

    <!-- 智能视图列表（覆盖首页，保留底部迷你播放条） -->
    <MobileSmartList
      v-if="smartKind"
      :kind="smartKind"
      @close="smartKind = null"
      @open-player="$emit('open', { name: 'player' })"
    />
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Music2,
  Heart,
  ListMusic,
  Users,
  Disc3,
  FolderInput,
  Search,
  Settings,
  Sparkles,
  History,
  TrendingUp,
} from "@lucide/vue";
import { state, isFavorite } from "../../composables/usePlayer.js";
import { SMART_VIEW_LIMIT } from "../../composables/useSmartViews.js";
import MobileSmartList from "./MobileSmartList.vue";

defineEmits(["open", "open-settings"]);

const { t } = useI18n();

// 首页顶栏搜索入口：进入全部歌曲列表并自动聚焦搜索框（复用列表内过滤）
// setup 内常量保证同引用，连续点击可被页面栈去重
const searchEntry = {
  name: "list",
  kind: "songs",
  title: t("mobile.home.allSongs"),
  payload: { focusSearch: true },
};

// 收藏数量：以曲库中实际收藏的歌曲计
const favoriteCount = computed(() => state.songs.filter((s) => isFavorite(s.path)).length);

// 艺术家/专辑分组（与 Playlist.vue 网格视图一致的分组逻辑）
const UNKNOWN_ARTIST = t("mobile.unknown.artist");
const UNKNOWN_ALBUM = t("mobile.unknown.album");
const norm = (v, fallback) => (v && v.trim ? v.trim() : "") || fallback;

const artistGroups = computed(() => {
  const m = new Map();
  for (const s of state.songs) {
    const name = norm(s.artist, UNKNOWN_ARTIST);
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh"));
});

const albumGroups = computed(() => {
  const m = new Map();
  for (const s of state.songs) {
    const album = norm(s.album, UNKNOWN_ALBUM);
    const cur = m.get(album);
    if (cur) cur.count++;
    else m.set(album, { album, count: 1 });
  }
  return [...m.values()].sort((a, b) => a.album.localeCompare(b.album, "zh"));
});

// ============ 智能视图入口（卡片 → 列表浮层） ============
const smartKind = ref(null); // 当前打开的智能视图 kind；null = 关闭

function openSmartView(kind) {
  smartKind.value = smartKind.value === kind ? null : kind; // 再点同一卡片 = 关闭
}

// ============ 打开文件 ============
const fileInput = ref(null);
const toast = ref("");
let toastTimer = null;

function openFilePicker() {
  fileInput.value?.click();
}

function onFilePicked(e) {
  const files = [...(e.target.files || [])];
  e.target.value = ""; // 允许重复选择同一文件
  if (!files.length) return;
  showToast(t("mobile.home.importToast", { n: files.length }));
  // TODO(backend): /api/import 上传接口实现后，在这里上传到音乐库目录
}

function showToast(msg) {
  toast.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 3200);
}
</script>

<style scoped>
.mh-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative; /* 智能视图列表浮层定位基准 */
}
.mh-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  padding-top: calc(14px + env(safe-area-inset-top));
}
.mh-title {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: 0.5px;
}
.mh-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.mh-icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card);
  border: 1px solid var(--border);
  transition: all 0.15s;
  touch-action: manipulation;
}
.mh-icon-btn:active {
  background: var(--card2);
  color: var(--text);
  transform: scale(0.92);
}
.mh-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 16px 16px;
  -webkit-overflow-scrolling: touch;
}
.mh-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
/* 平板（≥600px）：三列卡片，避免拉伸过宽 */
@media (min-width: 600px) {
  .mh-grid {
    grid-template-columns: repeat(3, 1fr);
  }
}
.mh-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 14px;
  border-radius: 16px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.12s;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mh-card:active {
  background: var(--card2);
  transform: scale(0.97);
}
.mh-tile {
  width: 44px;
  height: 44px;
  border-radius: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--tile, var(--accent)), var(--tile2, var(--accent2)));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--tile, var(--accent)) 35%, transparent);
  flex-shrink: 0;
}
.mh-card-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.mh-card-name {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mh-card-count {
  font-size: 12px;
  color: var(--text3);
  margin-top: 3px;
}
.mh-toast {
  margin-top: 14px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--card2);
  border: 1px solid var(--border);
  color: var(--text2);
  font-size: 13px;
  line-height: 1.5;
}
.mh-toast-enter-active,
.mh-toast-leave-active {
  transition: opacity 0.25s;
}
.mh-toast-enter-from,
.mh-toast-leave-to {
  opacity: 0;
}
.mh-foot {
  margin-top: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--text3);
  opacity: 0.75;
}
.mh-file-input {
  display: none;
}
</style>
