<template>
  <div class="ml-page">
    <!-- 顶栏：返回 + 标题 -->
    <header class="ml-head">
      <button class="ml-back" :title="t('mobile.list.back')" @click="$emit('back')">
        <ChevronLeft :size="24" />
      </button>
      <h1 class="ml-title">{{ title }}</h1>
      <span class="ml-count">{{
        display === "songs" ? t("mobile.count.song", { n: songRows.length }) : ""
      }}</span>
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
      <button v-if="query" class="ml-clear" :title="t('mobile.list.clear')" @click="query = ''">
        <X :size="14" />
      </button>
    </div>

    <!-- 列表 -->
    <div ref="listEl" class="ml-scroll">
      <!-- 歌曲列表（行左滑露出操作区：收藏/移除） -->
      <template v-if="display === 'songs'">
        <div
          v-for="{ song, i } in filteredSongs"
          :key="song.path"
          class="ml-wrap"
          :class="{ open: isOpen(song.path) }"
        >
          <!-- 左滑露出的操作区（藏在行内容下方） -->
          <div class="ml-actions">
            <button
              class="ml-act"
              :class="{ on: isFavorite(song.path) }"
              :title="
                isFavorite(song.path) ? t('mobile.list.unfavorite') : t('mobile.list.favorite')
              "
              @click.stop="actFavorite(song.path)"
            >
              <Heart :size="17" :fill="isFavorite(song.path) ? 'currentColor' : 'none'" />
            </button>
            <button
              class="ml-act ml-act-remove"
              :title="t('mobile.list.remove')"
              @click.stop="actRemove(song)"
            >
              <Trash2 :size="16" />
            </button>
            <!-- 删除（移到废纸篓 + 删磁盘文件）：网络歌 path=null 不显示 -->
            <button
              v-if="song.path"
              class="ml-act ml-act-danger"
              :title="t('mobile.list.delete')"
              @click.stop="actDelete(song)"
            >
              <Trash2 :size="16" />
              <span class="ml-act-label">{{ t("mobile.list.delete") }}</span>
            </button>
          </div>
          <div
            class="ml-item"
            :class="{ active: i === state.currentIndex }"
            :data-path="song.path"
            :style="{
              transform: rowTransform(song.path),
              transition: isDragging(song.path) ? 'none' : '',
            }"
            @click="onRowClick(song, i, song.path)"
          >
            <span v-if="canReorder" class="ml-drag" :title="t('mobile.list.reorder')">
              <GripVertical :size="15" />
            </span>
            <!-- showListCover 关（设置→界面→列表封面）：整个封面容器不渲染（含回退图标），行信息占满 -->
            <div v-if="coverVisible('list')" class="ml-row-cover">
              <img
                v-if="coverSrc(song.path) && coverOk(song.path)"
                :src="coverSrc(song.path)"
                :alt="song.name"
                loading="lazy"
                @error="markCoverError(song.path)"
              />
              <Music2 v-else :size="18" />
            </div>
            <div class="ml-row-info">
              <div class="ml-row-name">
                {{ song.name }}
                <span
                  v-if="i === state.currentIndex && state.isPlaying"
                  class="ml-eq"
                  :title="t('mobile.list.playing')"
                >
                  <span class="eq-bar"></span><span class="eq-bar"></span
                  ><span class="eq-bar"></span>
                </span>
              </div>
              <div class="ml-row-sub">
                {{ song.artist }}<template v-if="song.album"> · {{ song.album }}</template>
              </div>
            </div>
            <button
              class="ml-heart"
              :class="{ on: isFavorite(song.path) }"
              :title="
                isFavorite(song.path) ? t('mobile.list.unfavorite') : t('mobile.list.favorite')
              "
              @click.stop="toggleFavorite(song.path)"
            >
              <Heart :size="17" :fill="isFavorite(song.path) ? 'currentColor' : 'none'" />
            </button>
          </div>
        </div>
        <div v-if="!filteredSongs.length" class="ml-empty">
          {{
            state.loading
              ? t("mobile.list.scanning")
              : query
                ? t("mobile.list.noMatchSongs")
                : emptyText
          }}
        </div>
      </template>

      <!-- 分组列表（播放列表/艺术家/专辑） -->
      <template v-else>
        <div v-for="g in filteredGroups" :key="g.key" class="ml-item ml-group" @click="onGroup(g)">
          <!-- 分组行封面容器同样遵守 showListCover（隐藏后艺术家首字色块/图标一并隐藏） -->
          <div v-if="coverVisible('list')" class="ml-row-cover">
            <img
              v-if="g.coverPath && coverSrc(g.coverPath) && coverOk(g.coverKey)"
              :src="coverSrc(g.coverPath)"
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
          {{ query ? t("mobile.list.noMatchResults") : emptyText }}
        </div>
      </template>
    </div>

    <!-- 删除确认弹层（轻量实现：遮罩 + 卡片，danger 操作防误触；全库无现成 confirm 组件） -->
    <div v-if="confirmSong" class="ml-confirm-mask" @click.self="cancelDelete">
      <div
        class="ml-confirm"
        role="alertdialog"
        aria-modal="true"
        :aria-label="t('mobile.list.deleteTitle')"
      >
        <h2 class="ml-confirm-title">{{ t("mobile.list.deleteTitle") }}</h2>
        <p class="ml-confirm-text">
          {{ t("mobile.list.deleteConfirm", { name: confirmSong.name }) }}
        </p>
        <div class="ml-confirm-btns">
          <button class="ml-confirm-cancel" :disabled="deleting" @click="cancelDelete">
            {{ t("common.cancel") }}
          </button>
          <button class="ml-confirm-ok" :disabled="deleting" @click="doDelete">
            {{ t("mobile.list.delete") }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
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
  Trash2,
} from "@lucide/vue";
import {
  state,
  isFavorite,
  toggleFavorite,
  removeFromQueue,
  removeFromPlaylist,
  setPlaylistOrder,
  findSongIndex,
  loadSongs,
} from "../../composables/usePlayer.js";
import { showToast, toastError } from "../../composables/useToast.js";
import { useSwipeReveal } from "../../composables/useSwipe.js";
import { deleteSongs } from "../../composables/useDeleteSong.js";
import { coverVisible } from "../../composables/useCoverGuard.ts";
import { useCoverURL, COVER_CACHE_FIRST_N } from "../../composables/useCoverURL.js";

const props = defineProps({
  kind: { type: String, required: true }, // songs | favorites | playlist | artist | album | playlists | artists | albums
  title: { type: String, default: "" },
  payload: { type: Object, default: null },
});

const emit = defineEmits(["back", "play", "open"]);

const { t } = useI18n();

// 封面 URL 异步解析（阶段 F1）：iOS 壳本地优先（离线可显示），未命中远程 + 后台缓存；
// 桌面/非壳远程直出（行为零变化）。coverSrc 未解析完成返回 ""，模板 v-if 配合隐藏 <img>。
const { coverSrc, coverOk, markCoverError, resolveCover } = useCoverURL();

const query = ref("");

// 未知值归一化（与 Playlist.vue 一致）
const UNKNOWN_ARTIST = t("mobile.unknown.artist");
const UNKNOWN_ALBUM = t("mobile.unknown.album");
const norm = (v, fallback) => (v && v.trim ? v.trim() : "") || fallback;

// 分组入口数据（playlists/artists/albums 三类的下一层入口）
const groupEntries = {
  playlists: (p) => ({
    key: "p:" + p.id,
    name: p.name,
    subtitle: t("mobile.count.song", { n: (p.songPaths || []).length }),
    entry: { name: "list", kind: "playlist", title: p.name, payload: { playlist: p } },
  }),
  artists: (name, count) => ({
    key: "a:" + name,
    name,
    subtitle: t("mobile.count.song", { n: count }),
    entry: { name: "list", kind: "artist", title: name, payload: { artist: name } },
  }),
  albums: (g) => ({
    key: "l:" + g.album + ":" + g.artist,
    name: g.album,
    subtitle: t("mobile.list.albumSubtitle", { artist: g.artist, n: g.count }),
    coverPath: g.coverPath, // 代表歌曲 path（封面异步解析：本地优先，见 useCoverURL）
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
          coverPath: s.path,
        });
      }
    }
    return [...m.values()]
      .map((g) => {
        const list = [...g.artists];
        return groupEntries.albums({
          ...g,
          artist:
            list.length > 2
              ? t("mobile.list.moreArtists", { names: list.slice(0, 2).join(" / ") })
              : list.join(" / "),
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
  props.kind === "artists"
    ? t("mobile.list.searchArtist")
    : props.kind === "albums"
      ? t("mobile.list.searchAlbum")
      : t("mobile.list.searchSongArtist"),
);

const emptyText = computed(() => {
  if (props.kind === "playlists") return t("mobile.list.emptyPlaylists");
  if (props.kind === "favorites") return t("mobile.list.emptyFavorites");
  if (props.kind === "artist") return t("mobile.list.emptyArtist");
  if (props.kind === "album") return t("mobile.list.emptyAlbum");
  if (props.kind === "playlist") return t("mobile.list.emptyPlaylist");
  return t("mobile.list.emptySongs");
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

// ============ 封面异步填充（阶段 F1） ============
// 可见行（歌曲/分组）hasAsset 查询 + 前 N 行后台缓存；播放中歌曲恒缓存。
// 节流取舍见 useCoverURL 注释（几百首全下载会刷爆原生串行队列；查询本身零网络）。
watch(
  filteredSongs,
  (rows) => {
    rows.forEach(({ song }, i) => {
      if (song.path) resolveCover(song.path, { download: i < COVER_CACHE_FIRST_N });
    });
  },
  { immediate: true },
);
watch(
  filteredGroups,
  (groups) => {
    groups.forEach((g, i) => {
      if (g.coverPath) resolveCover(g.coverPath, { download: i < COVER_CACHE_FIRST_N });
    });
  },
  { immediate: true },
);
watch(
  () => state.currentSong?.path,
  (p) => {
    if (p) resolveCover(p, { download: true });
  },
  { immediate: true },
);

// ============ 行点击 ============
function onPlay(song) {
  emit("play", song);
}
function onGroup(g) {
  emit("open", g.entry);
}

// ============ 左滑操作（swipe-reveal：收藏 / 移除） ============
// 事件委托挂在 .ml-scroll 上（passive: false，横向判定后才 preventDefault，不抢纵向滚动）
const listEl = ref(null);
const swipe = useSwipeReveal(listEl, { rowSelector: ".ml-item" });
const { isOpen, isDragging, rowTransform, consumeSwipe } = swipe;

// 点击行：刚滑完的点击忽略；已展开的行点击 = 收起；否则播放
function onRowClick(song, i, path) {
  if (consumeSwipe(path)) return;
  if (isOpen(path)) {
    swipe.close();
    return;
  }
  onPlay(song);
}

// 操作区收藏：与行内小红心同一函数（乐观更新），静默不打扰
async function actFavorite(path) {
  await toggleFavorite(path);
  swipe.close();
}

// 操作区移除：跟随视图语义（与桌面 Playlist.removeItem 一致）——歌单视图移除自歌单，其余移除自队列
async function actRemove(song) {
  try {
    if (props.kind === "playlist") {
      await removeFromPlaylist(props.payload.playlist.id, song.path);
    } else {
      const idx = findSongIndex(song);
      if (idx >= 0) removeFromQueue(idx);
    }
    showToast(t("mobile.list.removed"));
  } catch (e) {
    toastError(e.message);
  }
  swipe.close();
}

// 操作区删除：曲库删除（移到废纸篓 + 删磁盘文件）。
// 流程：点删除 → 弹确认层防误触 → DELETE /api/library/songs → toast 结果 → loadSongs 刷新曲库
// （播放中/队列由桌面任务负责清理；loadSongs 刷新后共享 state 自动一致）
const confirmSong = ref(null);
const deleting = ref(false);

function actDelete(song) {
  confirmSong.value = song;
  swipe.close();
}

function cancelDelete() {
  if (deleting.value) return;
  confirmSong.value = null;
}

async function doDelete() {
  const song = confirmSong.value;
  if (!song || deleting.value) return;
  deleting.value = true;
  try {
    const result = await deleteSongs([song.path]);
    const failed = (result.missing || []).length + (result.errors || []).length;
    if ((result.deleted || 0) > 0) {
      showToast(
        result.deleted === 1
          ? t("mobile.list.deleted", { name: song.name })
          : t("mobile.list.deletedCount", { n: result.deleted }),
      );
    }
    if (failed > 0) {
      toastError(t("mobile.list.deleteFailed", { n: failed }));
    }
    confirmSong.value = null;
    await loadSongs({ force: true }); // 刷新曲库列表（与桌面同一链路）
  } catch (e) {
    toastError(e.message);
    confirmSong.value = null;
  } finally {
    deleting.value = false;
  }
}

// 搜索入口自动聚焦（首页顶栏搜索 → 进入列表页直接开键盘输入）
const searchInput = ref(null);
onMounted(() => {
  if (props.payload?.focusSearch) searchInput.value?.focus();
});

// ============ 歌单拖拽排序（触屏/鼠标，pointer 事件） ============
// 仅在歌单视图 + 未搜索时启用（可见集 = 歌单全量，排序不丢歌；与桌面 Playlist 同规则）
// listEl 已在左滑操作节声明（useSwipeReveal 事件委托与 Sortable 共用同一滚动容器）
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
      setPlaylistOrder(props.payload.playlist.id, paths).catch((e) => toastError(e.message));
    },
  });
}

watch([canReorder, () => props.payload?.playlist?.id], () => nextTick(setupSortable));
onMounted(() => nextTick(setupSortable));
onBeforeUnmount(() => sortable?.destroy());

// ============ 封面错误缓存 ============
// coverOk/markCoverError 由 useCoverURL 提供（本组件与 MobileSmartList 共用）

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
/* 左滑操作：行容器（裁切操作区）+ 操作按钮层 + 行内容（左移露出操作区） */
.ml-wrap {
  position: relative;
  border-radius: 12px;
  overflow: hidden;
}
.ml-actions {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: stretch;
  width: 168px;
}
.ml-act {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: #fff;
  background: var(--card2);
  touch-action: manipulation;
}
.ml-act.on {
  color: var(--red);
}
.ml-act-remove {
  background: color-mix(in srgb, var(--red) 82%, #000);
}
/* 删除（危险）：亮红底 + 文案，区别于「移除」的暗红底 */
.ml-act-danger {
  background: var(--red);
}
.ml-act-label {
  font-size: 11px;
  line-height: 1;
  pointer-events: none;
}
.ml-item {
  position: relative; /* 创建 stacking context：不透明底始终盖住下方 .ml-actions 操作区（未滑动时操作区默认隐藏） */
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 12px;
  cursor: pointer;
  background: linear-gradient(160deg, var(--bg), var(--bg2)); /* 不透明底：左移时遮住下方操作区 */
  transition:
    background 0.12s,
    transform 0.22s ease; /* 展开/收起过渡；跟手时由内联 transition:none 接管 */
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.ml-item:active {
  background: var(--card2);
}
.ml-item.active {
  /* 不透明底（用 bg 打底混 accent）：active 行也盖住下方操作区，
     否则半透明渐变会透出红色删除按钮（选中行“自动出现右滑按钮”假象） */
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 22%, var(--bg)),
    color-mix(in srgb, var(--accent2) 14%, var(--bg2))
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

/* 删除确认弹层（轻量实现）：遮罩 + 居中卡片；z 高于播放器(50)/智能列表(5)，低于 toast(300) */
.ml-confirm-mask {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 28px;
}
.ml-confirm {
  width: 100%;
  max-width: 320px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px 18px 14px;
  box-shadow: 0 12px 40px var(--shadow);
}
.ml-confirm-title {
  font-size: 16px;
  font-weight: 700;
  text-align: center;
}
.ml-confirm-text {
  margin-top: 8px;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--text2);
  text-align: center;
  word-break: break-all;
}
.ml-confirm-btns {
  display: flex;
  gap: 10px;
  margin-top: 18px;
}
.ml-confirm-cancel,
.ml-confirm-ok {
  flex: 1;
  height: 42px;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  touch-action: manipulation;
}
.ml-confirm-cancel {
  background: var(--card2);
  color: var(--text);
}
.ml-confirm-ok {
  background: var(--red);
  color: #fff;
}
.ml-confirm-cancel:active,
.ml-confirm-ok:active {
  opacity: 0.85;
}
.ml-confirm-cancel:disabled,
.ml-confirm-ok:disabled {
  opacity: 0.5;
}
</style>
