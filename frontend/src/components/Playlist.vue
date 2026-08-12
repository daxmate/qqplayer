<template>
  <div class="playlist" :class="{ compact }">
    <div class="pl-head">
      <Music :size="13" />
      {{ viewTitle }}
      <button
        class="pl-refresh"
        :class="{ spinning: state.loading }"
        title="重新扫描"
        @click="loadSongs()"
      >
        <RefreshCw :size="17" />
      </button>
    </div>

    <!-- 工具条：搜索 / 排序 / 只看收藏 -->
    <div class="pl-tools">
      <div class="pl-search">
        <Search :size="13" />
        <input v-model="query" type="text" placeholder="搜索歌名 / 歌手" spellcheck="false" />
      </div>
      <select v-model="sortKey" class="pl-sort" title="排序方式">
        <option value="default">默认顺序</option>
        <option value="name">按标题</option>
        <option value="artist">按歌手</option>
        <option value="duration">按时长</option>
      </select>
      <button
        class="pl-fav-btn"
        :class="{ on: favOnly }"
        :title="favOnly ? '显示全部' : '只看收藏'"
        @click="favOnly = !favOnly"
      >
        <Heart :size="13" :fill="favOnly ? 'currentColor' : 'none'" />
      </button>
    </div>

    <div ref="listEl" class="pl-list">
      <div
        v-for="({ song, i }, vi) in visible"
        :key="song.id"
        class="pl-item"
        :class="{ active: i === state.currentIndex }"
        :data-path="song.path"
        @click="pick(i)"
      >
        <span v-if="canDrag" class="pl-drag" title="拖拽排序">
          <GripVertical :size="14" />
        </span>
        <span class="pl-idx">{{ vi + 1 }}</span>
        <div class="pl-info">
          <div class="pl-name">
            {{ song.name }}
            <span v-if="isFavorite(song.path)" class="pl-fav-mark" title="已收藏">
              <Heart :size="10" fill="currentColor" />
            </span>
          </div>
          <div class="pl-artist">
            {{ song.artist }}
            <span v-if="song.duration" class="pl-dur">{{ fmtDur(song.duration) }}</span>
            <span v-if="song.has_lyric" class="pl-lyric" title="有歌词">
              <Mic :size="11" />
            </span>
          </div>
        </div>
        <span v-if="i === state.currentIndex" class="pl-eq" title="播放中">
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
        </span>
        <button
          class="pl-action heart"
          :class="{ on: isFavorite(song.path) }"
          :title="isFavorite(song.path) ? '取消收藏' : '收藏'"
          @click.stop="toggleFavorite(song.path)"
        >
          <Heart :size="14" :fill="isFavorite(song.path) ? 'currentColor' : 'none'" />
        </button>
        <button
          class="pl-action"
          title="加入歌单"
          @click.stop="openAddMenu(song.path)"
        >
          <ListPlus :size="14" />
        </button>
        <button
          class="pl-action remove"
          :title="inPlaylistView ? '从歌单移除' : '从队列移除'"
          @click.stop="removeItem(i)"
        >
          <X :size="14" />
        </button>
      </div>
      <div v-if="!visible.length" class="pl-empty">
        {{
          state.loading
            ? "扫描中…"
            : viewSongs.length
              ? favOnly
                ? "没有收藏的歌曲"
                : "没有匹配的歌曲"
              : inPlaylistView
                ? "歌单是空的，点击行上的 ＋ 加歌"
                : "没有歌曲，请设置歌曲库"
        }}
      </div>
    </div>

    <!-- 加歌浮层 -->
    <Teleport to="body">
      <div v-if="addMenuOpen" class="am-backdrop" @click="addMenuOpen = false"></div>
      <div v-if="addMenuOpen" class="add-menu">
        <div class="am-title">
          <ListPlus :size="13" />
          加入歌单
        </div>
        <div
          v-for="p in state.playlists"
          :key="p.id"
          class="am-item"
          :class="{ in: isInPlaylist(p.id, addMenuPath) }"
          @click="toggleAdd(p.id)"
        >
          <ListMusic :size="13" />
          <span class="am-name">{{ p.name }}</span>
          <span class="am-state">
            <Check v-if="isInPlaylist(p.id, addMenuPath)" :size="13" />
            <Plus v-else :size="13" />
          </span>
        </div>
        <div v-if="!state.playlists.length" class="am-empty">
          还没有歌单，点左侧「新建歌单」
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import Sortable from "sortablejs";
import {
  Music,
  Mic,
  RefreshCw,
  Search,
  Heart,
  X,
  GripVertical,
  ListPlus,
  ListMusic,
  Check,
  Plus,
} from "@lucide/vue";
import {
  state,
  activePlaylist,
  selectSong,
  loadSongs,
  play,
  isFavorite,
  toggleFavorite,
  removeFromQueue,
  isInPlaylist,
  addToPlaylist,
  removeFromPlaylist,
  setPlaylistOrder,
} from "../composables/usePlayer.js";

defineProps({
  compact: { type: Boolean, default: false },
});

// ============ 视图：全部歌曲 / 歌单（独立视图） ============
const inPlaylistView = computed(() => !!state.activePlaylistId);
const viewTitle = computed(() =>
  inPlaylistView.value ? activePlaylist.value?.name || "歌单" : "播放列表",
);

// 当前视图的歌曲列表：歌单视图按歌单顺序（songPaths）展开，i 为曲库索引
const viewSongs = computed(() => {
  if (!inPlaylistView.value) {
    return state.songs.map((song, i) => ({ song, i }));
  }
  const pl = activePlaylist.value;
  if (!pl) return [];
  const byPath = new Map(state.songs.map((s, i) => [s.path, { song: s, i }]));
  return (pl.songPaths || [])
    .map((path) => byPath.get(path))
    .filter(Boolean);
});

// ============ 搜索 / 排序 / 收藏过滤 ============
const query = ref("");
const sortKey = ref("default");
const favOnly = ref(false);

// 过滤 + 排序后的可见列表
const visible = computed(() => {
  let list = viewSongs.value;
  if (favOnly.value) {
    list = list.filter(({ song }) => isFavorite(song.path));
  }
  const q = query.value.trim().toLowerCase();
  if (q) {
    list = list.filter(
      ({ song }) =>
        (song.name || "").toLowerCase().includes(q) ||
        (song.artist || "").toLowerCase().includes(q),
    );
  }
  const key = sortKey.value;
  if (key === "name") {
    list = [...list].sort((a, b) => (a.song.name || "").localeCompare(b.song.name || ""));
  } else if (key === "artist") {
    list = [...list].sort((a, b) => (a.song.artist || "").localeCompare(b.song.artist || ""));
  } else if (key === "duration") {
    list = [...list].sort((a, b) => (a.song.duration ?? 0) - (b.song.duration ?? 0));
  }
  return list;
});

// 拖拽启用条件：歌单视图 + 无搜索/排序/收藏过滤（保证可见集 = 歌单全量，排序不丢歌）
const canDrag = computed(
  () =>
    inPlaylistView.value &&
    sortKey.value === "default" &&
    !query.value.trim() &&
    !favOnly.value,
);

function pick(i) {
  selectSong(i);
  play(); // 点击列表直接开始播放
}

// ============ 行操作：移除（跟随视图语义） / 加歌 ============
function removeItem(i) {
  if (inPlaylistView.value) {
    const path = viewSongs.value[i]?.song.path;
    if (path) removeFromPlaylist(state.activePlaylistId, path);
  } else {
    removeFromQueue(i);
  }
}

// 加歌浮层
const addMenuOpen = ref(false);
const addMenuPath = ref("");

function openAddMenu(path) {
  addMenuPath.value = path;
  addMenuOpen.value = true;
}

async function toggleAdd(pid) {
  const path = addMenuPath.value;
  try {
    if (isInPlaylist(pid, path)) {
      await removeFromPlaylist(pid, path);
    } else {
      await addToPlaylist(pid, path);
    }
  } catch (e) {
    alert(e.message);
  }
}

// ============ 歌单拖拽排序（sortablejs） ============
const listEl = ref(null);
let sortable = null;

function setupSortable() {
  sortable?.destroy();
  sortable = null;
  if (!canDrag.value || !listEl.value) return;
  sortable = Sortable.create(listEl.value, {
    handle: ".pl-drag",
    animation: 150,
    ghostClass: "pl-ghost",
    onEnd: ({ oldIndex, newIndex }) => {
      if (oldIndex === newIndex || !state.activePlaylistId) return;
      const paths = [...listEl.value.querySelectorAll(".pl-item")].map(
        (el) => el.dataset.path,
      );
      setPlaylistOrder(state.activePlaylistId, paths).catch((e) => alert(e.message));
    },
  });
}

watch([activePlaylist, canDrag], () => nextTick(setupSortable));
onMounted(() => nextTick(setupSortable));
onBeforeUnmount(() => sortable?.destroy());

function fmtDur(d) {
  const m = Math.floor(d / 60);
  const s = Math.floor(d % 60);
  return m + ":" + String(s).padStart(2, "0");
}
</script>

<style scoped>
.playlist {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  position: relative;
}
.pl-head {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pl-refresh {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.pl-refresh:hover {
  background: var(--border);
  color: var(--text);
}
.pl-refresh:active {
  transform: scale(0.92);
}
.pl-refresh.spinning svg {
  animation: refresh-spin 0.9s linear infinite;
}
@keyframes refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
/* 工具条 */
.pl-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.pl-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--card2);
  border-radius: 9px;
  padding: 0 9px;
  height: 30px;
  color: var(--text3);
}
.pl-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 12.5px;
}
.pl-search input::placeholder {
  color: var(--text3);
}
.pl-sort {
  height: 30px;
  background: var(--card2);
  color: var(--text2);
  border: none;
  border-radius: 9px;
  padding: 0 6px;
  font-size: 12px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
}
.pl-sort:hover {
  color: var(--text);
}
.pl-fav-btn {
  width: 30px;
  height: 30px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text3);
  transition: all 0.15s;
  flex-shrink: 0;
}
.pl-fav-btn:hover {
  color: var(--text);
}
.pl-fav-btn.on {
  color: #ff6b81;
  background: rgba(255, 107, 129, 0.15);
}
.pl-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.pl-drag {
  display: inline-flex;
  align-items: center;
  color: var(--text3);
  cursor: grab;
  flex-shrink: 0;
  opacity: 0.5;
}
.pl-drag:hover {
  opacity: 1;
  color: var(--text2);
}
.pl-drag:active {
  cursor: grabbing;
}
.pl-ghost {
  opacity: 0.4;
  background: var(--card2);
}
.pl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s;
}
.pl-item:hover {
  background: var(--card2);
}
.pl-item.active {
  background: linear-gradient(135deg, rgba(255, 126, 95, 0.22), rgba(254, 180, 123, 0.12));
}
.pl-idx {
  width: 20px;
  font-size: 12px;
  color: var(--text3);
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.pl-info {
  flex: 1;
  min-width: 0;
}
.pl-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-fav-mark {
  display: inline-flex;
  vertical-align: -1px;
  margin-left: 4px;
  color: #ff6b81;
}
.pl-artist {
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-dur {
  margin-left: 6px;
  font-variant-numeric: tabular-nums;
}
.pl-lyric {
  display: inline-flex;
  vertical-align: -2px;
  margin-left: 4px;
  color: var(--text2);
}
.pl-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: eq-bounce 1s ease-in-out infinite;
}
.eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.eq-bar:nth-child(3) {
  animation-delay: -0.66s;
}
@keyframes eq-bounce {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
/* 行操作按钮：默认隐藏，hover 显示 */
.pl-action {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  opacity: 0;
  transition: all 0.12s;
  flex-shrink: 0;
}
.pl-item:hover .pl-action {
  opacity: 1;
}
.pl-action:hover {
  background: var(--border);
  color: var(--text);
}
.pl-action.heart.on {
  opacity: 1;
  color: #ff6b81;
}
.pl-action.remove:hover {
  color: #ff6b81;
}
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
/* 加歌浮层 */
.am-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.add-menu {
  position: fixed;
  top: 120px;
  right: 340px;
  z-index: 91;
  width: 220px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
  padding: 6px;
}
.am-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text2);
  padding: 6px 8px 8px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 4px;
}
.am-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--text2);
  cursor: pointer;
  transition: background 0.12s;
}
.am-item:hover {
  background: var(--card2);
  color: var(--text);
}
.am-item.in {
  color: var(--accent);
}
.am-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.am-state {
  display: inline-flex;
  flex-shrink: 0;
}
.am-empty {
  text-align: center;
  color: var(--text3);
  font-size: 12px;
  padding: 16px 0;
}
</style>
