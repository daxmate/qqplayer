<template>
  <div class="ml-page">
    <!-- 顶栏：返回 + 标题 -->
    <header class="ml-head">
      <button class="ml-back" title="返回" @click="$emit('back')">
        <ChevronLeft :size="24" />
      </button>
      <h1 class="ml-title">{{ title }}</h1>
      <span class="ml-count">{{ display === "songs" ? songRows.length + " 首" : "" }}</span>
    </header>

    <!-- 搜索框 -->
    <div class="ml-search">
      <Search :size="15" />
      <input
        ref="searchInput"
        v-model="query"
        type="text"
        :placeholder="searchPlaceholder"
        spellcheck="false"
      />
      <button v-if="query" class="ml-clear" title="清除" @click="query = ''">
        <X :size="14" />
      </button>
    </div>

    <!-- 列表 -->
    <div ref="listEl" class="ml-scroll">
      <!-- 歌曲列表 -->
      <template v-if="display === 'songs'">
        <div
          v-for="{ song, i } in filteredSongs"
          :key="song.path"
          class="ml-item"
          :class="{ active: i === state.currentIndex }"
          :data-path="song.path"
          @click="onPlay(song)"
        >
          <span v-if="canReorder" class="ml-drag" title="拖拽排序">
            <GripVertical :size="15" />
          </span>
          <div class="ml-row-cover">
            <img
              v-if="coverOk(song.path)"
              :src="'/api/cover?path=' + encodeURIComponent(song.path)"
              :alt="song.name"
              loading="lazy"
              @error="markCoverError(song.path)"
            />
            <Music2 v-else :size="18" />
          </div>
          <div class="ml-row-info">
            <div class="ml-row-name">
              {{ song.name }}
              <span v-if="i === state.currentIndex && state.isPlaying" class="ml-eq" title="播放中">
                <span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span>
              </span>
            </div>
            <div class="ml-row-sub">
              {{ song.artist }}<template v-if="song.album"> · {{ song.album }}</template>
            </div>
          </div>
          <button
            class="ml-heart"
            :class="{ on: isFavorite(song.path) }"
            :title="isFavorite(song.path) ? '取消收藏' : '收藏'"
            @click.stop="toggleFavorite(song.path)"
          >
            <Heart :size="17" :fill="isFavorite(song.path) ? 'currentColor' : 'none'" />
          </button>
        </div>
        <div v-if="!filteredSongs.length" class="ml-empty">
          {{ state.loading ? "扫描中…" : query ? "没有匹配的歌曲" : emptyText }}
        </div>
      </template>

      <!-- 分组列表（播放列表/艺术家/专辑） -->
      <template v-else>
        <div v-for="g in filteredGroups" :key="g.key" class="ml-item ml-group" @click="onGroup(g)">
          <div class="ml-row-cover">
            <img
              v-if="g.coverUrl && coverOk(g.coverKey)"
              :src="g.coverUrl"
              :alt="g.name"
              loading="lazy"
              @error="markCoverError(g.coverKey)"
            />
            <template v-else>
              <span
                v-if="kind === 'artists'"
                class="ml-avatar"
                :style="{ background: hashBg(g.name) }"
                >{{ g.name[0] }}</span
              >
              <ListMusic v-else :size="18" />
            </template>
          </div>
          <div class="ml-row-info">
            <div class="ml-row-name">{{ g.name }}</div>
            <div class="ml-row-sub">{{ g.subtitle }}</div>
          </div>
          <ChevronRight :size="18" class="ml-chevron" />
        </div>
        <div v-if="!filteredGroups.length" class="ml-empty">
          {{ query ? "没有匹配的结果" : emptyText }}
        </div>
      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import Sortable from "sortablejs";
import {
  ChevronLeft,
  ChevronRight,
  Search,
  X,
  Music2,
  ListMusic,
  Heart,
  GripVertical,
} from "@lucide/vue";
import {
  state,
  isFavorite,
  toggleFavorite,
  setPlaylistOrder,
} from "../../composables/usePlayer.js";

const props = defineProps({
  kind: { type: String, required: true }, // songs | favorites | playlist | artist | album | playlists | artists | albums
  title: { type: String, default: "" },
  payload: { type: Object, default: null },
});

const emit = defineEmits(["back", "play", "open"]);

const query = ref("");

// 未知值归一化（与 Playlist.vue 一致）
const UNKNOWN_ARTIST = "未知歌手";
const UNKNOWN_ALBUM = "未知专辑";
const norm = (v, fallback) => (v && v.trim ? v.trim() : "") || fallback;

// 分组入口数据（playlists/artists/albums 三类的下一层入口）
const groupEntries = {
  playlists: (p) => ({
    key: "p:" + p.id,
    name: p.name,
    subtitle: `${(p.songPaths || []).length} 首`,
    entry: { name: "list", kind: "playlist", title: p.name, payload: { playlist: p } },
  }),
  artists: (name, count) => ({
    key: "a:" + name,
    name,
    subtitle: `${count} 首`,
    entry: { name: "list", kind: "artist", title: name, payload: { artist: name } },
  }),
  albums: (g) => ({
    key: "l:" + g.album + ":" + g.artist,
    name: g.album,
    subtitle: `${g.artist} · ${g.count} 首`,
    coverUrl: g.coverUrl,
    coverKey: "l:" + g.album,
    entry: { name: "list", kind: "album", title: g.album, payload: { album: g.album } },
  }),
};

// ============ 歌曲列表（按 kind 计算） ============
const songRows = computed(() => {
  switch (props.kind) {
    case "songs":
      return state.songs.map((song, i) => ({ song, i }));
    case "favorites":
      return state.songs
        .map((song, i) => ({ song, i }))
        .filter(({ song }) => isFavorite(song.path));
    case "playlist": {
      const pl = props.payload?.playlist;
      if (!pl) return [];
      const byPath = new Map(state.songs.map((s, i) => [s.path, { song: s, i }]));
      return (pl.songPaths || []).map((path) => byPath.get(path)).filter(Boolean);
    }
    case "artist": {
      const name = props.payload?.artist;
      return state.songs
        .map((song, i) => ({ song, i }))
        .filter(({ song }) => norm(song.artist, UNKNOWN_ARTIST) === name);
    }
    case "album": {
      const album = props.payload?.album;
      return state.songs
        .map((song, i) => ({ song, i }))
        .filter(({ song }) => norm(song.album, UNKNOWN_ALBUM) === album);
    }
    default:
      return [];
  }
});

// ============ 分组列表（playlists/artists/albums） ============
const groupRows = computed(() => {
  if (props.kind === "playlists") {
    return state.playlists.map((p) => groupEntries.playlists(p));
  }
  if (props.kind === "artists") {
    const m = new Map();
    for (const s of state.songs) {
      const name = norm(s.artist, UNKNOWN_ARTIST);
      m.set(name, (m.get(name) || 0) + 1);
    }
    return [...m.entries()]
      .map(([name, count]) => groupEntries.artists(name, count))
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }
  if (props.kind === "albums") {
    const m = new Map();
    for (const s of state.songs) {
      const album = norm(s.album, UNKNOWN_ALBUM);
      const artist = norm(s.artist, UNKNOWN_ARTIST);
      const cur = m.get(album);
      if (cur) {
        cur.count++;
        if (!cur.artists.has(artist)) cur.artists.add(artist);
      } else {
        m.set(album, {
          album,
          artists: new Set([artist]),
          count: 1,
          coverUrl: `/api/cover?path=${encodeURIComponent(s.path)}`,
        });
      }
    }
    return [...m.values()]
      .map((g) => {
        const list = [...g.artists];
        return groupEntries.albums({
          ...g,
          artist: list.length > 2 ? list.slice(0, 2).join(" / ") + " 等" : list.join(" / "),
        });
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh"));
  }
  return [];
});

const display = computed(() =>
  props.kind === "playlists" || props.kind === "artists" || props.kind === "albums"
    ? "groups"
    : "songs",
);

const searchPlaceholder = computed(() =>
  props.kind === "artists" ? "搜索歌手" : props.kind === "albums" ? "搜索专辑" : "搜索歌名 / 歌手",
);

const emptyText = computed(() => {
  if (props.kind === "playlists") return "还没有歌单";
  if (props.kind === "favorites") return "还没有收藏的歌曲";
  if (props.kind === "artist") return "该歌手没有歌曲";
  if (props.kind === "album") return "该专辑没有歌曲";
  if (props.kind === "playlist") return "歌单是空的";
  return "没有歌曲，请先导入音乐";
});

// 搜索过滤
const filteredSongs = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return songRows.value;
  return songRows.value.filter(
    ({ song }) =>
      (song.name || "").toLowerCase().includes(q) || (song.artist || "").toLowerCase().includes(q),
  );
});

const filteredGroups = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return groupRows.value;
  return groupRows.value.filter((g) => g.name.toLowerCase().includes(q));
});

// ============ 行点击 ============
function onPlay(song) {
  emit("play", song);
}
function onGroup(g) {
  emit("open", g.entry);
}

// 搜索入口自动聚焦（首页顶栏搜索 → 进入列表页直接开键盘输入）
const searchInput = ref(null);
onMounted(() => {
  if (props.payload?.focusSearch) searchInput.value?.focus();
});

// ============ 歌单拖拽排序（触屏/鼠标，pointer 事件） ============
// 仅在歌单视图 + 未搜索时启用（可见集 = 歌单全量，排序不丢歌；与桌面 Playlist 同规则）
const listEl = ref(null);
const canReorder = computed(() => props.kind === "playlist" && !query.value.trim());
let sortable = null;

function setupSortable() {
  sortable?.destroy();
  sortable = null;
  if (!canReorder.value || !listEl.value) return;
  sortable = Sortable.create(listEl.value, {
    handle: ".ml-drag",
    animation: 150,
    ghostClass: "ml-ghost",
    supportPointer: true, // pointer 事件统一触摸/鼠标
    onEnd: ({ oldIndex, newIndex }) => {
      if (oldIndex === newIndex || !props.payload?.playlist) return;
      const paths = [...listEl.value.querySelectorAll(".ml-item")].map((el) => el.dataset.path);
      setPlaylistOrder(props.payload.playlist.id, paths).catch((e) => alert(e.message));
    },
  });
}

watch([canReorder, () => props.payload?.playlist?.id], () => nextTick(setupSortable));
onMounted(() => nextTick(setupSortable));
onBeforeUnmount(() => sortable?.destroy());

// ============ 封面错误缓存 ============
const coverErrors = ref(new Set());
function coverOk(path) {
  return !coverErrors.value.has(path);
}
function markCoverError(path) {
  coverErrors.value.add(path);
}

// 歌手首字母色块（与 Playlist.vue 一致）
function hashBg(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 48% 52%), hsl(${(hue + 42) % 360} 45% 40%))`;
}
</script>

<style scoped>
.ml-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.ml-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  padding-top: calc(10px + env(safe-area-inset-top));
}
.ml-back {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  flex-shrink: 0;
  touch-action: manipulation;
}
.ml-back:active {
  background: var(--card2);
  color: var(--text);
}
.ml-title {
  flex: 1;
  min-width: 0;
  font-size: 17px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.ml-count {
  width: 38px;
  font-size: 12px;
  color: var(--text3);
  text-align: right;
  flex-shrink: 0;
}
.ml-search {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 16px 8px;
  padding: 0 12px;
  height: 38px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  color: var(--text3);
}
.ml-search input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text);
  font-size: 14px;
}
.ml-search input::placeholder {
  color: var(--text3);
}
.ml-clear {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
}
.ml-clear:active {
  background: var(--card2);
}
.ml-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 10px 28px;
  -webkit-overflow-scrolling: touch;
}
.ml-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 12px;
  cursor: pointer;
  transition: background 0.12s;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.ml-item:active {
  background: var(--card2);
}
.ml-item.active {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 20%, transparent),
    color-mix(in srgb, var(--accent2) 10%, transparent)
  );
}
.ml-drag {
  width: 26px;
  height: 38px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  cursor: grab;
  touch-action: none; /* 触屏拖拽：禁止浏览器接管手势（否则变滚动） */
}
.ml-ghost {
  opacity: 0.4;
  background: var(--card2);
}
.ml-row-cover {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  font-size: 0;
}
.ml-row-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ml-avatar {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 18px;
  font-weight: 700;
}
.ml-row-info {
  flex: 1;
  min-width: 0;
}
.ml-row-name {
  font-size: 14.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}
.ml-row-sub {
  font-size: 12px;
  color: var(--text3);
  margin-top: 3px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ml-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
  flex-shrink: 0;
  color: var(--accent);
}
.ml-eq .eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: eq-bounce 1s ease-in-out infinite;
}
.ml-eq .eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.ml-eq .eq-bar:nth-child(3) {
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
.ml-heart {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
  touch-action: manipulation;
}
.ml-heart:active {
  background: var(--card2);
}
.ml-heart.on {
  color: var(--red);
}
.ml-chevron {
  color: var(--text3);
  flex-shrink: 0;
}
.ml-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13.5px;
  padding: 40px 0;
}
</style>
