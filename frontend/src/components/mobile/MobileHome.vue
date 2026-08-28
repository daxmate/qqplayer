<template>
  <div class="mh-page">
    <!-- 顶栏：标题 + 刷新/搜索/设置入口 -->
    <header class="mh-head">
      <h1 class="mh-title">{{ t("mobile.home.title") }}</h1>
      <div class="mh-actions">
        <button
          class="mh-icon-btn"
          :class="{ spinning: refreshing }"
          :disabled="refreshing"
          :title="t('mobile.home.rescan')"
          @click="onRescan"
        >
          <RefreshCw :size="20" />
        </button>
        <button
          class="mh-icon-btn"
          :title="t('mobile.home.searchSong')"
          @click="isSearchOpen = true"
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
      <!-- 一列入口列表：仅音乐相关 6 项（图书/有声书/视频改为分页屏，智能视图入口移除） -->
      <div class="mh-list">
        <button
          class="mh-row"
          @click="$emit('open', { name: 'list', kind: 'songs', title: t('mobile.home.allSongs') })"
        >
          <span class="mh-tile" style="--tile: var(--accent); --tile2: var(--accent2)">
            <Music2 :size="20" />
          </span>
          <span class="mh-row-meta">
            <span class="mh-row-name">{{ t("mobile.home.allSongs") }}</span>
            <span class="mh-row-count">{{
              t("mobile.count.song", { n: state.songs.length })
            }}</span>
          </span>
          <ChevronRight :size="18" class="mh-row-arrow" />
        </button>

        <button
          class="mh-row"
          @click="
            $emit('open', { name: 'list', kind: 'favorites', title: t('mobile.home.favorites') })
          "
        >
          <span class="mh-tile" style="--tile: #ff6b81; --tile2: #ff9aa8">
            <Heart :size="20" fill="currentColor" />
          </span>
          <span class="mh-row-meta">
            <span class="mh-row-name">{{ t("mobile.home.favorites") }}</span>
            <span class="mh-row-count">{{ t("mobile.count.song", { n: favoriteCount }) }}</span>
          </span>
          <ChevronRight :size="18" class="mh-row-arrow" />
        </button>

        <button
          class="mh-row"
          @click="
            $emit('open', { name: 'list', kind: 'playlists', title: t('mobile.home.playlists') })
          "
        >
          <span class="mh-tile" style="--tile: #34d399; --tile2: #6ee7b7">
            <ListMusic :size="20" />
          </span>
          <span class="mh-row-meta">
            <span class="mh-row-name">{{ t("mobile.home.playlists") }}</span>
            <span class="mh-row-count">{{
              t("mobile.count.playlist", { n: state.playlists.length })
            }}</span>
          </span>
          <ChevronRight :size="18" class="mh-row-arrow" />
        </button>

        <button
          class="mh-row"
          @click="$emit('open', { name: 'list', kind: 'artists', title: t('mobile.home.artists') })"
        >
          <span class="mh-tile" style="--tile: #5b9dff; --tile2: #8ab4ff">
            <Users :size="20" />
          </span>
          <span class="mh-row-meta">
            <span class="mh-row-name">{{ t("mobile.home.artists") }}</span>
            <span class="mh-row-count">{{
              t("mobile.count.artist", { n: artistGroups.length })
            }}</span>
          </span>
          <ChevronRight :size="18" class="mh-row-arrow" />
        </button>

        <button
          class="mh-row"
          @click="$emit('open', { name: 'list', kind: 'albums', title: t('mobile.home.albums') })"
        >
          <span class="mh-tile" style="--tile: #a78bfa; --tile2: #c4b5fd">
            <Disc3 :size="20" />
          </span>
          <span class="mh-row-meta">
            <span class="mh-row-name">{{ t("mobile.home.albums") }}</span>
            <span class="mh-row-count">{{
              t("mobile.count.album", { n: albumGroups.length })
            }}</span>
          </span>
          <ChevronRight :size="18" class="mh-row-arrow" />
        </button>

        <button class="mh-row" @click="openFilePicker">
          <span class="mh-tile" style="--tile: #f59e0b; --tile2: #fbbf24">
            <FolderInput :size="20" />
          </span>
          <span class="mh-row-meta">
            <span class="mh-row-name">{{ t("mobile.home.openFile") }}</span>
            <span class="mh-row-count">{{ t("mobile.home.importMusic") }}</span>
          </span>
          <ChevronRight :size="18" class="mh-row-arrow" />
        </button>
      </div>

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
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Music2,
  Heart,
  ListMusic,
  Users,
  Disc3,
  FolderInput,
  ChevronRight,
  Search,
  Settings,
  RefreshCw,
} from "@lucide/vue";
import { state, isFavorite, loadSongs } from "../../composables/usePlayer.js";
import { useSearchAnything } from "../../composables/useSearchAnything.js";
import { showToast, toastError } from "../../composables/useToast.js";
import { isAudioFile, importFiles } from "../../composables/useDragImport.js";

defineEmits(["open", "open-settings"]);

const { t } = useI18n();
const { isSearchOpen } = useSearchAnything();

// ============ 重新扫描曲库（对应桌面刷新按钮：loadSongs 立即拉取 /api/songs） ============
const refreshing = ref(false);

async function onRescan() {
  if (refreshing.value) return; // 进行中：禁用重复点击
  refreshing.value = true;
  try {
    await loadSongs({ force: true }); // 失败时内部写 state.error（不抛），完成/失败都收 spinner
    if (state.error) toastError(state.error);
    else showToast(t("mobile.home.refreshed"));
  } finally {
    refreshing.value = false;
  }
}

// 收藏数量：以曲库中实际收藏的歌曲计（path 可能为 null 的流媒体歌按空串查询，行为不变）
const favoriteCount = computed(() => state.songs.filter((s) => isFavorite(s.path || "")).length);

// 艺术家/专辑分组（与 Playlist.vue 网格视图一致的分组逻辑）
const UNKNOWN_ARTIST = t("mobile.unknown.artist");
const UNKNOWN_ALBUM = t("mobile.unknown.album");
const norm = (v: string | undefined, fallback: string) => (v && v.trim ? v.trim() : "") || fallback;

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

// ============ 打开文件（NAS 导入入口） ============
const fileInput = ref<HTMLInputElement | null>(null);

function openFilePicker() {
  fileInput.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files || [])];
  input.value = ""; // 允许重复选择同一文件
  if (!files.length) return;
  const audioFiles = files.filter((f) => isAudioFile(f));
  if (!audioFiles.length) {
    toastError(t("import.noAudio"));
    return;
  }
  // FormData 多值 files → POST /api/import → 成功 toast 实际导入数 / 失败 toastError
  // 曲库自动刷新依赖 3s 轮询（后端 version+1）
  importFiles(audioFiles);
}
</script>

<style scoped>
.mh-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
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
.mh-icon-btn:disabled {
  opacity: 0.6;
}
.mh-icon-btn.spinning svg {
  animation: mh-refresh-spin 0.9s linear infinite;
}
@keyframes mh-refresh-spin {
  to {
    transform: rotate(360deg);
  }
}
.mh-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 16px 20px;
  -webkit-overflow-scrolling: touch;
}
/* 一列入口列表：每行 = 左侧图标 tile + 名称 + 副标题计数 */
.mh-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mh-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.12s;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mh-row:active {
  background: var(--card2);
  transform: scale(0.98);
}
.mh-tile {
  width: 42px;
  height: 42px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, var(--tile, var(--accent)), var(--tile2, var(--accent2)));
  box-shadow: 0 4px 12px color-mix(in srgb, var(--tile, var(--accent)) 35%, transparent);
  flex-shrink: 0;
}
.mh-row-meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.mh-row-name {
  font-size: 15px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mh-row-count {
  font-size: 12px;
  color: var(--text3);
}
.mh-row-arrow {
  color: var(--text3);
  flex-shrink: 0;
  opacity: 0.7;
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
