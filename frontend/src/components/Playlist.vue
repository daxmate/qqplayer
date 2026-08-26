<template>
  <div class="playlist" :class="{ compact, 'sv-hidden': smartViewState.active }">
    <div class="pl-head">
      <Music :size="13" />
      {{ viewTitle }}
      <button
        class="pl-refresh"
        :class="{ spinning: state.loading }"
        :title="t('playlist.rescan')"
        @click="loadSongs({ force: true })"
      >
        <RefreshCw :size="17" />
      </button>
    </div>

    <!-- 浏览 tab：全部歌曲 / 歌手 / 专辑 -->
    <div class="pl-browse">
      <button
        class="pb-tab"
        :class="{ on: browseMode === 'songs' && !browseFilter }"
        @click="enterBrowse('songs')"
      >
        {{ t("playlist.browse.allSongs") }}
      </button>
      <button
        class="pb-tab"
        :class="{ on: browseMode === 'artists' && !browseFilter }"
        @click="enterBrowse('artists')"
      >
        {{ t("playlist.browse.artists") }}
      </button>
      <button
        class="pb-tab"
        :class="{ on: browseMode === 'albums' && !browseFilter }"
        @click="enterBrowse('albums')"
      >
        {{ t("playlist.browse.albums") }}
      </button>
    </div>

    <!-- 分组详情：返回 + 分组名 -->
    <div v-if="browseFilter" class="pl-filter-bar">
      <button class="pl-back" :title="t('playlist.backTitle')" @click="browseFilter = null">
        <ArrowLeft :size="12" />
        {{ t("playlist.back") }}
      </button>
      <span class="pl-filter-title">{{ browseFilterTitle }}</span>
      <span class="pl-filter-count">{{ t("playlist.songsCount", { n: viewSongs.length }) }}</span>
    </div>

    <!-- 工具条：搜索 / 排序 / 只看收藏（网格视图只留搜索） -->
    <div class="pl-tools">
      <div class="pl-search">
        <Search :size="13" />
        <input
          v-model="query"
          type="text"
          :placeholder="
            gridMode
              ? browseMode === 'artists'
                ? t('playlist.searchPlaceholder.artist')
                : t('playlist.searchPlaceholder.album')
              : t('playlist.searchPlaceholder.song')
          "
          spellcheck="false"
        />
      </div>
      <template v-if="!gridMode">
        <select
          v-model="sortKey"
          class="pl-sort"
          :title="t('playlist.sort.title')"
          @change="onSelectSort"
        >
          <option value="default">{{ t("playlist.sort.default") }}</option>
          <option value="name">{{ t("playlist.sort.name") }}</option>
          <option value="artist">{{ t("playlist.sort.artist") }}</option>
          <option value="duration">{{ t("playlist.sort.duration") }}</option>
        </select>
        <button
          class="pl-locate"
          :disabled="state.currentIndex < 0"
          :title="t('playlist.locate.title')"
          @click="locateCurrent"
        >
          <LocateFixed :size="13" />
        </button>
        <button
          class="pl-fav-btn"
          :class="{ on: favOnly }"
          :title="favOnly ? t('playlist.fav.all') : t('playlist.fav.only')"
          @click="favOnly = !favOnly"
        >
          <Heart :size="13" :fill="favOnly ? 'currentColor' : 'none'" />
        </button>
      </template>
    </div>

    <!-- 网格视图：歌手 / 专辑卡片 -->
    <div v-if="gridMode" class="pl-grid">
      <button
        v-for="g in gridGroups"
        :key="gridKey(g)"
        class="gr-card"
        :class="{ album: browseMode === 'albums' }"
        @click="enterGroup(g)"
      >
        <template v-if="browseMode === 'artists'">
          <span class="gr-avatar" :style="{ background: hashBg(g.name) }">{{ g.name[0] }}</span>
          <span class="gr-meta">
            <span class="gr-name">{{ g.name }}</span>
            <span class="gr-count">{{ t("playlist.songsCount", { n: g.count }) }}</span>
          </span>
        </template>
        <template v-else>
          <span v-if="uiSettings.showCover" class="gr-cover">
            <img
              v-if="g.coverUrl"
              :src="g.coverUrl"
              alt=""
              loading="lazy"
              @error="g.coverUrl = ''"
            />
            <Music v-else :size="20" />
          </span>
          <span class="gr-meta">
            <span class="gr-name">{{ g.album }}</span>
            <span class="gr-count"
              >{{ g.artist }} · {{ t("playlist.songsCount", { n: g.count }) }}</span
            >
          </span>
        </template>
      </button>
      <div v-if="!gridGroups.length" class="pl-empty">
        {{
          state.loading
            ? t("playlist.empty.scanning")
            : browseMode === "artists"
              ? t("playlist.empty.noMatchArtist")
              : t("playlist.empty.noMatchAlbum")
        }}
      </div>
    </div>

    <!-- 多选批量操作条（桌面：⌘/Ctrl 点选进入多选态）+ 列头 + 歌曲列表 -->
    <div v-else class="pl-body">
      <div v-if="multiMode" class="pl-multi">
        <span class="pl-multi-count">
          {{ t("playlist.multi.selected", { n: selectedPaths.length }) }}
        </span>
        <button class="pl-multi-btn" :title="t('playlist.multi.fav')" @click="batchFavorite">
          <Heart :size="13" fill="none" />
          {{ t("playlist.multi.fav") }}
        </button>
        <button
          class="pl-multi-btn"
          :title="t('playlist.multi.addToPlaylist')"
          @click="batchAddPlaylist"
        >
          <ListPlus :size="13" />
          {{ t("playlist.multi.addToPlaylist") }}
        </button>
        <!-- 批量刮削（仅开启批量刮削后显示） -->
        <button
          v-if="scrapingSettings.batch_enabled"
          class="pl-multi-btn"
          :disabled="scrapeBatchState.loading"
          :title="t('playlist.multi.scrape')"
          data-testid="pl-multi-scrape"
          @click="batchScrape"
        >
          <Loader2 v-if="scrapeBatchState.loading" :size="13" class="spin" />
          <Sparkles v-else :size="13" />
          {{
            scrapeBatchState.loading
              ? t("playlist.multi.scraping", { n: selectedPaths.length })
              : t("playlist.multi.scrape")
          }}
        </button>
        <button
          class="pl-multi-btn danger"
          :title="t('playlist.multi.deleteToTrash')"
          @click="batchDelete"
        >
          <Trash2 :size="13" />
          {{ t("playlist.multi.deleteToTrash") }}
        </button>
        <button class="pl-multi-btn" :title="t('playlist.multi.clear')" @click="clearSelection">
          <X :size="13" />
          {{ t("playlist.multi.clear") }}
        </button>
        <!-- 推送到设备（放在末尾：现有测试按位置索引 pl-multi-btn，插入中间会破坏索引） -->
        <button
          class="pl-multi-btn"
          :title="t('playlist.pushToDevice')"
          data-testid="pl-multi-push-device"
          @click="batchPushToDevice"
        >
          <Send :size="13" />
          {{ t("playlist.pushToDevice") }}
        </button>
      </div>
      <!-- 列头（桌面）：点击排序，三态循环 升序 → 降序 → 默认顺序；与工具条 select 共用 sortKey -->
      <div class="pl-cols">
        <span class="pl-cols-idx" aria-hidden="true"></span>
        <button
          type="button"
          class="pl-col"
          :class="{ on: sortKey === 'name' }"
          data-testid="pl-col-name"
          @click="onColSort('name')"
        >
          {{ t("playlist.sort.cols.name") }}
          <span v-if="colArrow('name')" class="pl-col-arrow">{{
            colArrow("name") === "asc" ? "↑" : "↓"
          }}</span>
        </button>
        <button
          type="button"
          class="pl-col"
          :class="{ on: sortKey === 'artist' }"
          data-testid="pl-col-artist"
          @click="onColSort('artist')"
        >
          {{ t("playlist.sort.cols.artist") }}
          <span v-if="colArrow('artist')" class="pl-col-arrow">{{
            colArrow("artist") === "asc" ? "↑" : "↓"
          }}</span>
        </button>
        <button
          type="button"
          class="pl-col"
          :class="{ on: sortKey === 'duration' }"
          data-testid="pl-col-duration"
          @click="onColSort('duration')"
        >
          {{ t("playlist.sort.cols.duration") }}
          <span v-if="colArrow('duration')" class="pl-col-arrow">{{
            colArrow("duration") === "asc" ? "↑" : "↓"
          }}</span>
        </button>
      </div>
      <div ref="listEl" class="pl-list">
        <div
          v-for="({ song, i }, vi) in visible"
          :key="song.id"
          class="pl-item"
          :class="{ active: i === state.currentIndex, selected: isSelected(song.path) }"
          :data-path="song.path"
          @click="onRowClick(vi, $event)"
          @contextmenu.prevent="openCtxMenu($event, vi)"
        >
          <span
            v-if="canDragOut"
            class="pl-drag"
            :title="canReorder ? t('playlist.dragSort') : t('playlist.dragOut')"
            draggable="true"
            @dragstart="onRowDragStart($event, song.path)"
          >
            <GripVertical :size="14" />
          </span>
          <span v-if="uiSettings.showCover" class="pl-cover">
            <img
              v-if="coverSrc(song.path) && coverOk(song.path)"
              :src="coverSrc(song.path)"
              :alt="song.name"
              loading="lazy"
              @error="markCoverError(song.path)"
            />
          </span>
          <span class="pl-idx">{{ vi + 1 }}</span>
          <div class="pl-info">
            <div class="pl-name">
              {{ song.name }}
              <span
                v-if="isFavorite(song.path)"
                class="pl-fav-mark"
                :title="t('playlist.fav.faved')"
              >
                <Heart :size="10" fill="currentColor" />
              </span>
            </div>
            <div class="pl-artist">
              {{ song.artist }}
              <span v-if="song.duration" class="pl-dur">{{ fmtDur(song.duration) }}</span>
              <span v-if="song.has_lyric" class="pl-lyric" :title="t('playlist.hasLyric')">
                <Mic :size="11" />
              </span>
            </div>
          </div>
          <span
            v-if="i === state.currentIndex"
            class="pl-eq"
            :title="t('playlist.locate.title')"
            @click.stop="locateCurrent"
          >
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
            <span class="eq-bar"></span>
          </span>
          <button
            class="pl-action heart"
            :class="{ on: isFavorite(song.path) }"
            :title="isFavorite(song.path) ? t('playlist.fav.remove') : t('playlist.fav.add')"
            @click.stop="toggleFavorite(song.path)"
          >
            <Heart :size="14" :fill="isFavorite(song.path) ? 'currentColor' : 'none'" />
          </button>
          <button
            class="pl-action"
            :title="t('playlist.addMenu.title')"
            @click.stop="openAddMenu($event, song.path)"
          >
            <ListPlus :size="14" />
          </button>
          <button
            v-if="isStreamSong(song)"
            class="pl-action dl"
            :class="{ busy: downloading[song.streamId] }"
            :title="downloading[song.streamId] ? t('playlist.downloading') : t('playlist.download')"
            @click.stop="downloadSong(song)"
          >
            <Loader2 v-if="downloading[song.streamId]" :size="14" class="pl-spin" />
            <Download v-else :size="14" />
          </button>
          <button
            class="pl-action remove"
            :title="
              inPlaylistView ? t('playlist.removeFromPlaylist') : t('playlist.removeFromQueue')
            "
            @click.stop="removeItem(vi)"
          >
            <X :size="14" />
          </button>
        </div>
        <div v-if="!visible.length" class="pl-empty">
          {{
            state.loading
              ? t("playlist.empty.scanning")
              : viewSongs.length
                ? favOnly
                  ? t("playlist.empty.noFav")
                  : t("playlist.empty.noMatch")
                : browseFilter
                  ? t("playlist.empty.noGroupSongs")
                  : inPlaylistView
                    ? t("playlist.empty.emptyPlaylist")
                    : t("playlist.empty.noSongs")
          }}
        </div>
      </div>
    </div>

    <!-- 加歌浮层 -->
    <Teleport to="body">
      <div v-if="addMenuOpen" class="am-backdrop" @click="addMenuOpen = false"></div>
      <div v-if="addMenuOpen" ref="addMenuEl" class="add-menu" :style="addMenuStyle">
        <div class="am-title">
          <ListPlus :size="13" />
          {{ t("playlist.addMenu.title") }}
        </div>
        <div
          v-for="p in state.playlists"
          :key="p.id"
          class="am-item"
          :class="{ in: addMenuIn(p.id) }"
          @click="toggleAdd(p.id)"
        >
          <ListMusic :size="13" />
          <span class="am-name">{{ p.name }}</span>
          <span class="am-state">
            <Check v-if="addMenuIn(p.id)" :size="13" />
            <Plus v-else :size="13" />
          </span>
        </div>
        <div v-if="!state.playlists.length" class="am-empty">
          {{ t("playlist.addMenu.noPlaylists") }}
        </div>
      </div>
    </Teleport>

    <!-- 右键菜单（桌面，Teleport 到 body 防裁剪） -->
    <ContextMenu
      :visible="ctxOpen"
      :x="ctxPos.x"
      :y="ctxPos.y"
      :fav="ctxSong ? isFavorite(ctxSong.path) : false"
      :can-go-artist="ctxCanGoArtist"
      :can-go-album="ctxCanGoAlbum"
      :has-path="!!ctxSong?.path"
      @play="ctxPlay"
      @play-next="ctxPlayNext"
      @toggle-fav="ctxToggleFav"
      @add-playlist="ctxAddPlaylist"
      @go-artist="ctxGoArtist"
      @go-album="ctxGoAlbum"
      @edit-tags="ctxEditTags"
      @delete="ctxDelete"
      @push-device="ctxPushToDevice"
      @close="ctxOpen = false"
    />

    <!-- 设备选择浮层（推送到设备） -->
    <DevicePickerModal
      :open="pickerOpen"
      :devices="pickerDevices"
      @close="pickerOpen = false"
      @select="onDevicePicked"
    />

    <!-- 编辑标签/刮削弹窗（右键目标歌曲；autoScrape 打开自动刮削） -->
    <TagEditorModal
      :open="tagEditorOpen"
      :song="tagEditorSong"
      auto-scrape
      @close="tagEditorOpen = false"
    />

    <!-- 移到废纸篓确认弹窗 -->
    <Teleport to="body">
      <div v-if="deleteOpen" class="dt-backdrop" @mousedown.self="deleteOpen = false"></div>
      <div v-if="deleteOpen" class="dt-modal" role="dialog" aria-modal="true">
        <div class="dt-title">
          <Trash2 :size="15" />
          {{ t("playlist.deleteToTrash.title") }}
        </div>
        <div class="dt-text">
          {{ t("playlist.deleteToTrash.confirm", { n: deletePaths.length }) }}
        </div>
        <div class="dt-actions">
          <button class="dt-btn" @click="deleteOpen = false">{{ t("common.cancel") }}</button>
          <button class="dt-btn danger" @click="doDelete">{{ t("common.confirm") }}</button>
        </div>
      </div>
    </Teleport>

    <!-- 批量刮削结果面板（多选批量；与设置页一键整库共用同一面板） -->
    <ScrapeResultModal />
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import Sortable from "sortablejs";
import { smartViewState } from "../composables/useSmartViews.js";
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
  ArrowLeft,
  Trash2,
  LocateFixed,
  Download,
  Send,
  Loader2,
  Sparkles,
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
  reorderQueue,
  persistQueueOrder,
  DRAG_SONG_TYPE,
  _resetPlayMode,
  isStreamSong,
  downloadSettings,
  uiSettings,
} from "../composables/usePlayer.js";
import { deleteLibrarySongs, removeSongsFromQueue } from "../composables/useLibrary.js";
import { scrapingSettings } from "../composables/useScrapingSettings.js";
import { scrapeBatchState, runScrapeBatch } from "../composables/useScrapeBatch.js";
import ScrapeResultModal from "./ScrapeResultModal.vue";
import { normalizeQuery, normalizeText } from "../utils/searchNormalize.js";
import { apiPost, resolveServerUrl } from "../utils/apiClient.js";
import { showToast, toastError } from "../composables/useToast.js";
import { inNativeShell, setupShellRowDrag } from "../composables/useShellDrag.js";
import { useCoverURL, COVER_CACHE_FIRST_N } from "../composables/useCoverURL.js";
import ContextMenu from "./ContextMenu.vue";
import TagEditorModal from "./TagEditorModal.vue";
import DevicePickerModal from "./DevicePickerModal.vue";
import { fetchDevices, pushSongsToDevice } from "../utils/deviceCommands.js";

defineProps({
  compact: { type: Boolean, default: false },
});

const { t } = useI18n();

// 封面 URL 异步解析（阶段 F1）：iOS 壳本地优先（离线可显示），未命中远程 + 后台缓存；
// 桌面/非壳远程直出（行为零变化）。coverSrc 未解析完成返回 ""，模板 v-if 配合隐藏 <img>。
const { coverSrc, coverOk, markCoverError, resolveCover } = useCoverURL();

// ============ 视图：全部歌曲 / 歌单（独立视图）/ 分组浏览 ============
const inPlaylistView = computed(() => !!state.activePlaylistId);
const viewTitle = computed(() =>
  inPlaylistView.value
    ? activePlaylist.value?.name || t("playlist.title.playlist")
    : t("playlist.title.queue"),
);

// 浏览模式：songs（列表）/ artists（歌手网格）/ albums（专辑网格）
const browseMode = ref("songs");
// 分组过滤：进入某歌手/专辑后的歌曲列表
const browseFilter = ref(null); // { type: 'artist'|'album', value }

// 供外部（search anything @pick）进入分组浏览：type='artists'|'albums'，value 为规范化名字
function openBrowse(type, value) {
  browseMode.value = type;
  browseFilter.value = { type: type === "artists" ? "artist" : "album", value };
}
defineExpose({ openBrowse, computeAddMenuPos });

const UNKNOWN_ARTIST = t("playlist.unknownArtist");
const UNKNOWN_ALBUM = t("playlist.unknownAlbum");
const norm = (v, fallback) => (v && v.trim ? v.trim() : "") || fallback;

// 当前视图的歌曲列表：歌单视图按歌单顺序（songPaths）展开，i 为曲库索引；分组过滤后只留该组
const viewSongs = computed(() => {
  let list;
  if (!inPlaylistView.value) {
    list = state.songs.map((song, i) => ({ song, i }));
  } else {
    const pl = activePlaylist.value;
    if (!pl) return [];
    const byPath = new Map(state.songs.map((s, i) => [s.path, { song: s, i }]));
    list = (pl.songPaths || []).map((path) => byPath.get(path)).filter(Boolean);
  }
  const f = browseFilter.value;
  if (f) {
    list = list.filter(({ song }) => {
      const v =
        f.type === "artist" ? norm(song.artist, UNKNOWN_ARTIST) : norm(song.album, UNKNOWN_ALBUM);
      return v === f.value;
    });
  }
  return list;
});

// 网格视图：浏览 tab 非列表且未进入分组
const gridMode = computed(() => browseMode.value !== "songs" && !browseFilter.value);

// 歌手分组聚合（名称 → 歌曲数）
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

// 专辑分组聚合（按专辑名，歌手去重显示，取代表歌封面）
const albumGroups = computed(() => {
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
        coverUrl: resolveServerUrl(`/api/cover?path=${encodeURIComponent(s.path)}`),
      });
    }
  }
  return [...m.values()]
    .map((g) => {
      const list = [...g.artists];
      return {
        ...g,
        artist:
          list.length > 2 ? list.slice(0, 2).join(" / ") + t("playlist.etc") : list.join(" / "),
      };
    })
    .sort((a, b) => a.album.localeCompare(b.album, "zh"));
});

// 网格视图当前分组列表（支持搜索过滤卡片）
const gridGroups = computed(() => {
  const groups = browseMode.value === "artists" ? artistGroups.value : albumGroups.value;
  const q = normalizeQuery(query.value);
  if (!q) return groups;
  return groups.filter((g) => {
    const text = browseMode.value === "artists" ? g.name : g.album + " " + g.artist;
    return normalizeText(text).includes(q);
  });
});

const gridKey = (g) =>
  browseMode.value === "artists" ? "a:" + g.name : "l:" + g.album + ":" + g.artist;

// 分组详情标题（未知歌手/专辑保留原名）
const browseFilterTitle = computed(() => {
  const f = browseFilter.value;
  if (!f) return "";
  return f.type === "artist" ? f.value : `${f.value} · ${f.artist}`;
});

// 切换浏览 tab（清空分组过滤）
function enterBrowse(mode) {
  browseMode.value = mode;
  browseFilter.value = null;
  query.value = "";
}

// 点击卡片进入分组
function enterGroup(g) {
  browseFilter.value =
    browseMode.value === "artists"
      ? { type: "artist", value: g.name }
      : { type: "album", value: g.album, artist: g.artist };
  query.value = "";
}

// 歌手首字母色块：名字哈希 → 渐变背景
function hashBg(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `linear-gradient(135deg, hsl(${hue} 48% 52%), hsl(${(hue + 42) % 360} 45% 40%))`;
}

// ============ 搜索 / 排序 / 收藏过滤 ============
const query = ref("");
const sortKey = ref("default");
// 列头排序方向（select 无方向语义；列头点击才驱动）：'asc' | 'desc'
const sortDir = ref("asc");
const favOnly = ref(false);

// 过滤 + 排序后的可见列表
const visible = computed(() => {
  let list = viewSongs.value;
  if (favOnly.value) {
    list = list.filter(({ song }) => isFavorite(song.path));
  }
  const q = normalizeQuery(query.value);
  if (q) {
    list = list.filter(
      ({ song }) =>
        normalizeText(song.name || "").includes(q) || normalizeText(song.artist || "").includes(q),
    );
  }
  const key = sortKey.value;
  if (key === "name" || key === "artist" || key === "duration") {
    const dir = sortDir.value === "desc" ? -1 : 1;
    list = [...list].sort((a, b) => {
      let cmp;
      if (key === "name") cmp = (a.song.name || "").localeCompare(b.song.name || "");
      else if (key === "artist") cmp = (a.song.artist || "").localeCompare(b.song.artist || "");
      else cmp = (a.song.duration ?? 0) - (b.song.duration ?? 0);
      return cmp * dir;
    });
  }
  return list;
});

// ============ 封面异步填充（阶段 F1） ============
// 可见行 hasAsset 查询 + 前 N 行后台缓存；播放中歌曲恒缓存（节流取舍见 useCoverURL 注释）。
// 行结构：visible 元素为 { song, i }（viewSongs 过滤/排序后视图），用 r.song.path 解析封面。
watch(
  visible,
  (rows) => {
    rows.forEach((r, i) => {
      if (r.song?.path) resolveCover(r.song.path, { download: i < COVER_CACHE_FIRST_N });
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

// ============ 列头点击排序（三态循环：升序 → 降序 → 默认顺序） ============
// 不同列 → 切列并重置为升序；同列升 → 降；同列降 → 回到默认（曲库原始顺序）
function onColSort(key) {
  if (sortKey.value !== key) {
    sortKey.value = key;
    sortDir.value = "asc";
  } else if (sortDir.value === "asc") {
    sortDir.value = "desc";
  } else {
    sortKey.value = "default";
    sortDir.value = "asc";
  }
}

// 列头激活态方向箭头：仅当前排序列返回 'asc' | 'desc'，否则 null（不显示）
function colArrow(key) {
  return sortKey.value === key ? sortDir.value : null;
}

// 工具条 select 切换：重置列头方向为升序（select 无方向语义，保持可预期）
function onSelectSort() {
  sortDir.value = "asc";
}

// 列表内排序启用条件：无搜索/排序/收藏/分组过滤时（保证可见集 = 全量，排序不丢歌）。
// 歌单视图 = 歌单内排序；全部歌曲视图 = 播放队列排序。
const canReorder = computed(
  () => sortKey.value === "default" && !query.value.trim() && !favOnly.value && !browseFilter.value,
);
// 拖出到侧栏歌单：所有视图行手柄始终可用（搜索/排序/收藏/分组过滤也拖得出）；
// 网络歌（path=null）由 onRowDragStart preventDefault / 壳内 sourcePath null 天然拦截
const canDragOut = computed(() => true);

function pick(i) {
  selectSong(i);
  play(); // 点击列表直接开始播放
}

// ============ 多选批量（桌面：⌘/Ctrl 点选进入多选态） ============
const selectedPaths = ref([]);
const multiMode = computed(() => selectedPaths.value.length > 0);

function isSelected(path) {
  return path != null && selectedPaths.value.includes(path);
}

function toggleSelected(path) {
  const i = selectedPaths.value.indexOf(path);
  if (i >= 0) selectedPaths.value.splice(i, 1);
  else selectedPaths.value.push(path);
}

function clearSelection() {
  selectedPaths.value = [];
}

// 行点击：多选态 = 切换选中；⌘/Ctrl+点选 = 进入多选态并选中；否则播放
// 网络歌（path=null）不参与多选（所有批量操作都是 path 语义），⌘/Ctrl+点选也不动作
// vi 是 visible（过滤+排序后）视图索引，entry.i 才是原始曲库索引——歌单/过滤/排序视图下两者不一致（8-19 壳内实测暴露）
function onRowClick(vi, e) {
  const entry = visible.value[vi];
  if (!entry) return;
  const path = entry.song.path;
  const mod = e?.metaKey || e?.ctrlKey;
  if (multiMode.value) {
    if (path != null) toggleSelected(path);
    return;
  }
  if (mod) {
    if (path != null) toggleSelected(path);
    return;
  }
  // 必须用 entry.i（全局曲库索引）：viewSongs 可能被过滤/歌单/排序，视图索引 ≠ 曲库索引
  pick(entry.i);
}

// 批量收藏：只加不删（幂等），新增数 toast
async function batchFavorite() {
  const paths = selectedPaths.value.filter((p) => p != null && !isFavorite(p));
  if (!paths.length) return;
  for (const p of paths) await toggleFavorite(p);
  showToast(t("playlist.fav.batchAdded", { n: paths.length }));
}

// 批量加歌单：复用 addMenu 浮层（批量模式 = 只加不删）
function batchAddPlaylist() {
  const paths = selectedPaths.value.filter((p) => p != null);
  if (!paths.length) return;
  openAddMenuBatch(paths);
}

function openAddMenuBatch(paths) {
  addMenuMode.value = "batch";
  addMenuPaths.value = paths;
  addMenuPos.value = {
    top: ADD_MENU_MARGIN,
    left: Math.max(ADD_MENU_MARGIN, window.innerWidth - ADD_MENU_WIDTH - 340),
    flip: false,
  };
  addMenuOpen.value = true;
}

// 批量移到废纸篓（与单曲同一链路：确认弹窗 → DELETE → toast → loadSongs）
function batchDelete() {
  openDeleteDialog(selectedPaths.value);
}

// ============ 批量刮削（多选 → POST /api/tags/scrape-batch） ============
// 按钮仅当设置里开启 batch_enabled 后显示（关闭时入口隐藏）；批量写入会改文件名，
// 完成后刷新曲库 + 清空多选；结果面板（ScrapeResultModal）展示 summary + 明细。
async function batchScrape() {
  if (!scrapingSettings.batch_enabled) return;
  const paths = selectedPaths.value.filter((p) => p != null);
  if (!paths.length) return;
  await runScrapeBatch({ paths });
  // 请求结束（成功/未启用/失败都收敛）：改没改名都刷一次保险，多选清空
  await loadSongs({ force: true });
  clearSelection();
}

// ============ 右键菜单（桌面） ============
const ctxOpen = ref(false);
const ctxSong = ref(null);
const ctxIdx = ref(-1); // 曲库队列索引（viewSongs 可能被过滤/排序，用原始 i）
const ctxPos = ref({ x: 0, y: 0 });

function openCtxMenu(e, vi) {
  const entry = visible.value[vi];
  if (!entry) return;
  ctxSong.value = entry.song;
  ctxIdx.value = entry.i;
  ctxPos.value = { x: e.clientX, y: e.clientY };
  ctxOpen.value = true;
}

function ctxClose() {
  ctxOpen.value = false;
}

// 进歌手/进专辑：仅可跳转时显示（已在该分组视图内 → 隐藏对应入口）
const ctxCanGoArtist = computed(() => {
  const s = ctxSong.value;
  if (!s || !s.artist) return false;
  const v = norm(s.artist, UNKNOWN_ARTIST);
  return !(browseFilter.value?.type === "artist" && browseFilter.value.value === v);
});
const ctxCanGoAlbum = computed(() => {
  const s = ctxSong.value;
  if (!s || !s.album) return false;
  const v = norm(s.album, UNKNOWN_ALBUM);
  return !(browseFilter.value?.type === "album" && browseFilter.value.value === v);
});

// 播放指定曲库索引的歌（浏览器/壳右键菜单共用；idx 越界静默）
function playFor(idx) {
  if (idx >= 0 && idx < state.songs.length) {
    selectSong(idx);
    play();
  }
}

function ctxPlay() {
  playFor(ctxIdx.value);
  ctxClose();
}

// 下一首播放：把该歌挪到当前歌之后并立即播放（列表即队列，避免重复条目）
function playNextFor(idx) {
  if (idx < 0 || idx >= state.songs.length) return;
  const cur = state.currentIndex;
  if (cur < 0 || idx === cur) {
    selectSong(idx);
    play();
    return;
  }
  const song = state.songs[idx];
  state.songs.splice(idx, 1);
  // 取走后当前歌索引可能前移；插到当前歌之后
  const cur2 = idx < cur ? cur - 1 : cur;
  state.songs.splice(cur2 + 1, 0, song);
  _resetPlayMode(); // 洗牌队列失效，selectSong 会按新歌重建
  selectSong(cur2 + 1);
  play();
}

function ctxPlayNext() {
  playNextFor(ctxIdx.value);
  ctxClose();
}

function ctxToggleFav() {
  const p = ctxSong.value?.path;
  if (p != null) toggleFavorite(p);
  ctxClose();
}

// 加歌单：复用现有 addMenu 浮层，锚定在鼠标位置（假 rect 右对齐 → 菜单从光标处展开）
function ctxAddPlaylist() {
  const p = ctxSong.value?.path;
  if (p == null) {
    ctxClose();
    return;
  }
  const { x, y } = ctxPos.value;
  ctxClose();
  openAddMenuAt(p, {
    getBoundingClientRect: () => ({
      left: x,
      top: y,
      right: x + ADD_MENU_WIDTH,
      bottom: y + 4,
      width: ADD_MENU_WIDTH,
      height: 4,
    }),
  });
}

// 进歌手/进专辑分组视图（浏览器/壳右键菜单共用）：按歌曲数据设置 browseFilter
function goArtistFor(song) {
  if (song?.artist) {
    browseFilter.value = { type: "artist", value: norm(song.artist, UNKNOWN_ARTIST) };
  }
}

function goAlbumFor(song) {
  if (song?.album) {
    browseFilter.value = {
      type: "album",
      value: norm(song.album, UNKNOWN_ALBUM),
      artist: song.artist,
    };
  }
}

function ctxGoArtist() {
  goArtistFor(ctxSong.value);
  ctxClose();
}

function ctxGoAlbum() {
  goAlbumFor(ctxSong.value);
  ctxClose();
}

function ctxDelete() {
  const p = ctxSong.value?.path;
  if (p == null) {
    ctxClose();
    return;
  }
  ctxClose();
  openDeleteDialog([p]);
}

// 编辑标签/刮削：打开 TagEditorModal（autoScrape 自动触发刮削），编辑对象 = 被右键的歌曲
// （不切换当前播放；弹窗内保存/刮削都以该歌曲的 path 为准）
const tagEditorOpen = ref(false);
const tagEditorSong = ref(null);

function openTagEditor(song) {
  if (!song?.path) return;
  tagEditorSong.value = song;
  tagEditorOpen.value = true;
}

function ctxEditTags() {
  const s = ctxSong.value;
  ctxClose();
  openTagEditor(s);
}

// ============ 推送到设备（右键单选 / 多选批量 → DevicePickerModal） ============
const pickerOpen = ref(false);
const pickerDevices = ref([]);
const pickerSongs = ref([]); // 待推送的曲库歌曲对象数组（含 path）

// 打开选择浮层：先拉设备清单，无已配对设备 → toast 提示（不弹浮层）
async function openDevicePicker(songs) {
  const list = (songs || []).filter((s) => s && s.path);
  if (!list.length) {
    showToast(t("playlist.pushFailed"), { type: "error" });
    return;
  }
  const r = await fetchDevices();
  if (!r.ok || !r.devices.length) {
    showToast(t("playlist.noDevicesToast"), { type: "error" });
    return;
  }
  pickerSongs.value = list;
  pickerDevices.value = r.devices;
  pickerOpen.value = true;
}

function ctxPushToDevice() {
  const s = ctxSong.value;
  ctxClose();
  openDevicePicker(s ? [s] : []);
}

// 多选批量：选中路径 → 曲库歌曲对象（路径语义，网络歌天然被过滤）
function batchPushToDevice() {
  const paths = selectedPaths.value.filter((p) => p != null);
  if (!paths.length) return;
  const songs = state.songs.filter((s) => s && paths.includes(s.path));
  openDevicePicker(songs);
}

// 浮层确认：推送选中歌曲到目标设备 → toast 成功/失败
async function onDevicePicked(device) {
  pickerOpen.value = false;
  const songs = pickerSongs.value;
  pickerSongs.value = [];
  const r = await pushSongsToDevice(songs, device.device_id);
  if (r.ok) {
    const n = songs.length - (Array.isArray(r.skipped) ? r.skipped.length : 0);
    showToast(t("playlist.pushSuccess", { n: Math.max(0, n) }));
  } else if (r.reason === "no_valid_items") {
    showToast(t("playlist.pushFailed"), { type: "error" });
  } else {
    showToast(t("playlist.pushFailedReason", { reason: r.error || r.reason || "" }), {
      type: "error",
    });
  }
}

// ============ Swift 壳右键菜单动作（useNativeCtxMenu 上报上下文 → 壳注入 NSMenu → 点击调 __qqCtxMenu → 事件派发到这里） ============
// 与浏览器右键菜单共用同一套实现（playFor/playNextFor/goArtistFor/goAlbumFor/openAddMenuAt/openDeleteDialog），
// 壳内与浏览器行为完全一致；事件只在原生壳内由 __qqCtxMenu 派发，浏览器永不触发。
function ctxSongFromEvent(e) {
  const path = e.detail?.path;
  if (path == null) return null;
  return state.songs.find((s) => s.path === path) ?? null;
}

function onCtxPlay(e) {
  const s = ctxSongFromEvent(e);
  if (s) playFor(state.songs.indexOf(s));
}

function onCtxPlayNext(e) {
  const s = ctxSongFromEvent(e);
  if (s) playNextFor(state.songs.indexOf(s));
}

function onCtxToggleFav(e) {
  const s = ctxSongFromEvent(e);
  if (s?.path != null) toggleFavorite(s.path);
}

// 加歌单：与 ctxAddPlaylist 同一锚定方式（右键坐标 → 假 rect 右对齐 → 浮层从光标处展开）
function onCtxAddPlaylist(e) {
  const p = e.detail?.path;
  if (p == null) return;
  const { x, y } = e.detail;
  openAddMenuAt(p, {
    getBoundingClientRect: () => ({
      left: x,
      top: y,
      right: x + ADD_MENU_WIDTH,
      bottom: y + 4,
      width: ADD_MENU_WIDTH,
      height: 4,
    }),
  });
}

// 移到废纸篓：与 ctxDelete 同一确认弹窗链路
function onCtxDeleteSong(e) {
  const p = e.detail?.path;
  if (p != null) openDeleteDialog([p]);
}

function onCtxGoArtist(e) {
  const s = ctxSongFromEvent(e);
  if (s) goArtistFor(s);
}

function onCtxGoAlbum(e) {
  const s = ctxSongFromEvent(e);
  if (s) goAlbumFor(s);
}

// 编辑标签/刮削（壳菜单）：与浏览器右键菜单同一链路 → 打开 TagEditorModal(autoScrape)
function onCtxEditTags(e) {
  const s = ctxSongFromEvent(e);
  if (s) openTagEditor(s);
}

const CTX_EVENTS = [
  ["qqplayer:ctx-play", onCtxPlay],
  ["qqplayer:ctx-playnext", onCtxPlayNext],
  ["qqplayer:ctx-togglefav", onCtxToggleFav],
  ["qqplayer:ctx-addplaylist", onCtxAddPlaylist],
  ["qqplayer:ctx-deletesong", onCtxDeleteSong],
  ["qqplayer:ctx-goartist", onCtxGoArtist],
  ["qqplayer:ctx-goalbum", onCtxGoAlbum],
  ["qqplayer:ctx-edittags", onCtxEditTags],
];

function bindCtxEvents() {
  for (const [name, fn] of CTX_EVENTS) window.addEventListener(name, fn);
}

function unbindCtxEvents() {
  for (const [name, fn] of CTX_EVENTS) window.removeEventListener(name, fn);
}

// ============ 行操作：移除（跟随视图语义） / 加歌 ============
function removeItem(vi) {
  const entry = visible.value[vi];
  if (!entry) return;
  if (inPlaylistView.value) {
    const path = entry.song.path;
    if (path) removeFromPlaylist(state.activePlaylistId, path);
  } else {
    removeFromQueue(entry.i);
  }
}

// ============ 下载网络歌（行内按钮） ============
// 后端 POST /api/online/download（body {id, level?, title?, artist?}）→ 网易云取直链落盘到
// 下载目录（设置 download.downloadDir，空 = 曲库）；曲库 mtime 监听自动刷新，下载完成即出现为本地歌。
const downloading = reactive({}); // streamId → 下载中

async function downloadSong(song) {
  const id = song?.streamId;
  if (!id || downloading[id]) return;
  downloading[id] = true;
  try {
    const res = await apiPost("/api/online/download", {
      id,
      level: downloadSettings.defaultQuality,
      title: song.name,
      artist: song.artist || "",
    });
    if (!res.ok) {
      const data = res.data || {};
      throw new Error(data.error || data.message || "");
    }
    showToast(t("playlist.downloadSuccess", { title: song.name }));
  } catch (err) {
    toastError(t("playlist.downloadFailed", { msg: err.message || "" }));
  } finally {
    downloading[id] = false;
  }
}

// 加歌浮层：锚定触发按钮（getBoundingClientRect 动态定位，保留 Teleport 到 body 防裁剪）
const addMenuOpen = ref(false);
// 目标路径：单曲=[path]（切换收藏态）；批量=多 path（只加不删）
const addMenuPaths = ref([]);
const addMenuMode = ref("single"); // 'single' 切换 | 'batch' 只加
const addMenuEl = ref(null); // 浮层根元素（用于测量实际高度）
const addMenuAnchor = ref(null); // 触发按钮元素（resize/滚动时重取 rect）
const addMenuPos = ref({ top: 0, left: 0 });

const ADD_MENU_WIDTH = 220; // 与 .add-menu width 一致
const ADD_MENU_GAP = 6; // 浮层与按钮间距
const ADD_MENU_EST_HEIGHT = 220; // 预估高度（标题 + 常见歌单数），渲染后用实际高度精修
const ADD_MENU_MARGIN = 8; // 视口边缘留白

// 纯函数：按钮 rect + 浮层高度 + 视口尺寸 → { top, left, flip }
// 右对齐按钮右缘（浮层宽 220 向左展开）：与旧视觉"右侧弹层"一致，且不盖住行内其他内容
function computeAddMenuPos(btnRect, menuHeight, vw = window.innerWidth, vh = window.innerHeight) {
  const below = Math.max(ADD_MENU_MARGIN, btnRect.bottom + ADD_MENU_GAP);
  // 下方放不下 → 翻转到按钮上方
  const flip = below + menuHeight > vh - ADD_MENU_MARGIN;
  const top = flip ? Math.max(ADD_MENU_MARGIN, btnRect.top - menuHeight - ADD_MENU_GAP) : below;
  // 右边界 clamp + 左侧兜底（窄窗口时右缘 - 220 可能为负）
  const left = Math.max(
    ADD_MENU_MARGIN,
    Math.min(btnRect.right - ADD_MENU_WIDTH, vw - ADD_MENU_WIDTH - ADD_MENU_MARGIN),
  );
  return { top, left, flip };
}

function measureMenuHeight() {
  const h = addMenuEl.value ? addMenuEl.value.getBoundingClientRect().height : 0;
  return h > 0 ? h : ADD_MENU_EST_HEIGHT;
}

function applyAddMenuPos(rect) {
  addMenuPos.value = computeAddMenuPos(rect, measureMenuHeight());
}

function openAddMenu(e, path) {
  openAddMenuAt(path, e?.currentTarget);
}

// 统一入口：anchor 为带 getBoundingClientRect 的元素（行内按钮 / 右键菜单鼠标位置的假 rect）
function openAddMenuAt(path, anchor) {
  addMenuMode.value = "single";
  addMenuPaths.value = [path];
  if (anchor && typeof anchor.getBoundingClientRect === "function") {
    addMenuAnchor.value = anchor;
    addMenuPos.value = computeAddMenuPos(anchor.getBoundingClientRect(), ADD_MENU_EST_HEIGHT);
    addMenuOpen.value = true;
    // 渲染后用实际浮层高度精修（歌单多时浮层更高，翻转判定更准）
    nextTick(() => {
      if (!addMenuOpen.value || !addMenuAnchor.value) return;
      applyAddMenuPos(addMenuAnchor.value.getBoundingClientRect());
    });
  } else {
    // 兜底：取不到按钮 rect 时退回首屏右上方（接近旧位置）
    addMenuPos.value = {
      top: ADD_MENU_MARGIN,
      left: Math.max(ADD_MENU_MARGIN, window.innerWidth - ADD_MENU_WIDTH - 340),
      flip: false,
    };
    addMenuOpen.value = true;
  }
}

const addMenuStyle = computed(() => ({
  top: addMenuPos.value.top + "px",
  left: addMenuPos.value.left + "px",
}));

// Esc 关闭（优先级：删除弹窗 → 右键菜单 → 加歌浮层 → 多选态）；resize/滚动重算（scroll 用捕获阶段，任意滚动容器都能触发）
function onKeydown(e) {
  if (e.key !== "Escape") return;
  if (deleteOpen.value) {
    deleteOpen.value = false;
    return;
  }
  if (ctxOpen.value) {
    ctxOpen.value = false;
    return;
  }
  if (addMenuOpen.value) {
    addMenuOpen.value = false;
    return;
  }
  if (multiMode.value) clearSelection();
}
function onViewportChange() {
  if (!addMenuOpen.value || !addMenuAnchor.value) return;
  applyAddMenuPos(addMenuAnchor.value.getBoundingClientRect());
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  bindCtxEvents(); // 壳右键菜单动作（浏览器内事件永不派发，无副作用）
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
  unbindCtxEvents();
});

async function toggleAdd(pid) {
  const paths = addMenuPaths.value;
  if (!paths.length) return;
  try {
    if (addMenuMode.value === "batch") {
      // 批量：只加不删（幂等），避免逐首移除弹多条撤销 toast
      for (const p of paths) {
        if (!isInPlaylist(pid, p)) await addToPlaylist(pid, p);
      }
    } else if (isInPlaylist(pid, paths[0])) {
      await removeFromPlaylist(pid, paths[0]);
    } else {
      await addToPlaylist(pid, paths[0]);
    }
  } catch (e) {
    toastError(e.message);
  }
}

// 浮层内歌单的勾选态：单曲 = 该歌在歌单；批量 = 全部选中歌都在歌单
function addMenuIn(pid) {
  const paths = addMenuPaths.value;
  return paths.length > 0 && paths.every((p) => isInPlaylist(pid, p));
}

// ============ 移到废纸篓（确认 → DELETE → toast → 刷新，单曲/批量同一链路） ============
const deleteOpen = ref(false);
const deletePaths = ref([]);

function openDeleteDialog(paths) {
  deletePaths.value = paths.filter((p) => p != null);
  if (deletePaths.value.length) deleteOpen.value = true;
}

async function doDelete() {
  const paths = deletePaths.value;
  if (!paths.length) return;
  deleteOpen.value = false;
  try {
    const res = await deleteLibrarySongs(paths);
    // 成功删除的路径 = 请求路径 − missing − errors（用于播放队列清理）
    const missingSet = new Set(res.missing || []);
    const errSet = new Set((res.errors || []).map((e) => e.path));
    const successPaths = paths.filter((p) => !missingSet.has(p) && !errSet.has(p));
    // 被删歌曲在播放队列 → 移除；当前播放 → 自动切下一首（removeSongsFromQueue 处理）
    removeSongsFromQueue(successPaths);
    // 汇总 toast：已删除 / 不在曲库 / 删除失败
    const parts = [];
    if (res.deleted > 0) parts.push(t("playlist.deleteToTrash.deleted", { n: res.deleted }));
    if (res.missing?.length)
      parts.push(t("playlist.deleteToTrash.missing", { n: res.missing.length }));
    if (res.errors?.length)
      parts.push(t("playlist.deleteToTrash.failed", { n: res.errors.length }));
    if (parts.length) {
      const msg = parts.join("，");
      if (res.deleted > 0) showToast(msg);
      else toastError(msg);
    } else {
      toastError(t("errors.deleteSongs"));
    }
    clearSelection();
    // 刷新曲库；最近添加/最近播放/常听排行由既有 watch 自动重算
    await loadSongs({ force: true });
  } catch (e) {
    toastError(e.message || t("errors.deleteSongs"));
    clearSelection();
  }
}

// ============ 歌单拖拽排序（sortablejs / 壳内 Pointer Events 模拟） ============
const listEl = ref(null);
let sortable = null;
let shellDragCleanup = null; // 壳内拖拽清理函数（useShellDrag）

function setupSortable() {
  sortable?.destroy();
  sortable = null;
  shellDragCleanup?.();
  shellDragCleanup = null;
  if (!listEl.value) return;
  if (inNativeShell()) {
    // 壳内（WKWebView 无 HTML5 DnD）：手柄 pointer 事件模拟排序 + 拖到侧栏歌单；
    // 任何视图都挂（canDragOut 恒真），getCanReorder 控制列表内排序是否放行（过滤时禁）
    shellDragCleanup = setupShellRowDrag({
      listEl: listEl.value,
      getCanDrag: () => canDragOut.value,
      getCanReorder: () => canReorder.value,
      isPlaylistView: () => !!state.activePlaylistId,
      onQueueReorder: (from, to) => {
        reorderQueue(from, to);
        persistQueueOrder().catch((e) => toastError(e.message));
      },
      onPlaylistReorder: (paths) => {
        setPlaylistOrder(state.activePlaylistId, paths).catch((e) => toastError(e.message));
      },
    });
    return;
  }
  // 浏览器：列表内排序只在无过滤时初始化 SortableJS（过滤时排序禁，但行手柄仍可 HTML5 DnD 拖出加歌单）
  if (!canReorder.value) return;
  sortable = Sortable.create(listEl.value, {
    handle: ".pl-drag",
    animation: 150,
    ghostClass: "pl-ghost",
    supportPointer: true, // pointer 事件统一鼠标/触控笔/触摸（触屏可拖拽排序）
    onEnd: ({ oldIndex, newIndex }) => {
      if (oldIndex === newIndex) return;
      if (state.activePlaylistId) {
        // 歌单视图：重排歌单内歌曲顺序
        const paths = [...listEl.value.querySelectorAll(".pl-item")].map((el) => el.dataset.path);
        setPlaylistOrder(state.activePlaylistId, paths).catch((e) => toastError(e.message));
      } else {
        // 全部歌曲视图：重排播放队列顺序并持久化（后端 /api/queue/order，刷新后恢复）
        reorderQueue(oldIndex, newIndex);
        persistQueueOrder().catch((e) => toastError(e.message));
      }
    },
  });
}

watch([activePlaylist, canReorder], () => nextTick(setupSortable));
onMounted(() => nextTick(setupSortable));
onBeforeUnmount(() => {
  sortable?.destroy();
  shellDragCleanup?.();
  clearTimeout(locateTimer);
});

// ============ 拖拽到侧栏歌单（HTML5 DnD：歌曲行手柄 → Sidebar 歌单项） ============
// 与 sortablejs 同源共用手柄：sortablejs 用 pointerdown + 原生 dragstart 驱动列表内排序，
// 我们只附加 dataTransfer 元数据，drop 目标只有 Sidebar 歌单，两套语义互不干扰。
function onRowDragStart(e, path) {
  if (!path) {
    // 网络歌（path=null）不能加入歌单
    e.preventDefault();
    return;
  }
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(DRAG_SONG_TYPE, path);
  dt.effectAllowed = "copy";
}

// ============ 定位当前播放（工具条按钮 / EQ 标记点击） ============
let locateTimer = null;

// 滚动 .pl-list 让行可见：行在视口内不动，否则滚到行顶（带内边距留白）
function scrollRowIntoList(list, rowEl) {
  const pad = 6;
  const listRect = list.getBoundingClientRect();
  const rowRect = rowEl.getBoundingClientRect();
  const relTop = rowRect.top - listRect.top + list.scrollTop;
  const relBottom = relTop + rowRect.height;
  const viewTop = list.scrollTop;
  const viewBottom = viewTop + list.clientHeight;
  if (relTop < viewTop || relBottom > viewBottom) {
    const top = Math.max(0, relTop - pad);
    if (typeof list.scrollTo === "function") {
      list.scrollTo({ top, behavior: "smooth" });
    } else {
      list.scrollTop = top;
    }
  }
}

function locateCurrent() {
  const idx = state.currentIndex;
  if (idx < 0 || !listEl.value) return;
  const domIdx = visible.value.findIndex((v) => v.i === idx);
  if (domIdx < 0) {
    // 搜索/过滤中当前播放行不可见 → 提示
    showToast(t("playlist.locate.notVisible"));
    return;
  }
  const rowEl = listEl.value.querySelectorAll(".pl-item")[domIdx];
  if (!rowEl) return;
  scrollRowIntoList(listEl.value, rowEl);
  // 临时高亮闪烁
  rowEl.classList.add("pl-locate");
  clearTimeout(locateTimer);
  locateTimer = setTimeout(() => rowEl.classList.remove("pl-locate"), 1500);
}

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
/* 智能视图浮层打开时隐藏列表本体（visibility 保留占位，grid cell/panelStyle rect 不受影响）；
   浮层背后直接透出封面模糊层，毛玻璃与全部歌曲/歌单列表完全同源 */
.playlist.sv-hidden {
  visibility: hidden;
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
@media (hover: hover) {
  .pl-refresh:hover {
    background: var(--border);
    color: var(--text);
  }
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
/* 浏览 tab */
.pl-browse {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  flex-shrink: 0;
}
.pb-tab {
  flex: 1;
  height: 26px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text3);
  transition: all 0.12s;
}
@media (hover: hover) {
  .pb-tab:hover {
    color: var(--text);
    background: var(--card2);
  }
}
.pb-tab.on {
  color: var(--accent);
  background: var(--accent-soft);
}
/* 分组详情返回条 */
.pl-filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 0;
  flex-shrink: 0;
}
.pl-back {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 24px;
  padding: 0 9px;
  border-radius: 8px;
  background: var(--card2);
  color: var(--text2);
  font-size: 11.5px;
  font-weight: 600;
  transition: all 0.12s;
  flex-shrink: 0;
}
@media (hover: hover) {
  .pl-back:hover {
    background: var(--border);
    color: var(--text);
  }
}
.pl-filter-title {
  font-size: 13px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-filter-count {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
}
/* 歌手/专辑网格 */
.pl-grid {
  flex: 1;
  overflow-y: auto;
  padding: 10px 12px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-content: start;
}
.gr-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
  padding: 12px 6px 10px;
  border-radius: 12px;
  background: var(--card);
  border: 1px solid transparent;
  transition: all 0.12s;
  text-align: center;
}
@media (hover: hover) {
  .gr-card:hover {
    background: var(--card2);
    border-color: var(--border);
    transform: translateY(-1px);
  }
  .gr-card.album:hover {
    transform: none;
  }
}
/* 专辑卡：1 列横排（封面在左，信息在右） */
.gr-card.album {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  text-align: left;
}
.gr-card.album .gr-cover {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  flex-shrink: 0;
}
.gr-card.album .gr-meta {
  flex: 1;
}
.gr-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  font-size: 19px;
  font-weight: 700;
  box-shadow: 0 3px 10px var(--shadow-sm);
  flex-shrink: 0;
}
.gr-cover {
  width: 58px;
  height: 58px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  box-shadow: 0 3px 10px var(--shadow-sm);
  flex-shrink: 0;
}
.gr-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.gr-meta {
  min-width: 0;
  width: 100%;
}
.gr-name {
  display: block;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.gr-count {
  display: block;
  font-size: 10.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
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
@media (hover: hover) {
  .pl-sort:hover {
    color: var(--text);
  }
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
@media (hover: hover) {
  .pl-fav-btn:hover {
    color: var(--text);
  }
}
.pl-fav-btn.on {
  color: var(--red);
  background: var(--red-soft);
}
.pl-locate {
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
@media (hover: hover) {
  .pl-locate:hover:not(:disabled) {
    color: var(--accent);
    background: var(--accent-soft);
  }
}
.pl-locate:disabled {
  opacity: 0.45;
  cursor: default;
}
.pl-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
/* 列头（桌面列表视图）：点击排序。左缩进与行内序号对齐（列表内边距 6 + 行内边距 10 + 序号 20 + gap 10 = 46px），
   歌名列与歌名左缘对齐；升/降箭头随激活态显示，默认顺序时不激活 */
.pl-cols {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 10px 6px 16px;
  font-size: 11px;
  color: var(--text3);
  user-select: none;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.pl-cols-idx {
  width: 20px;
  flex-shrink: 0;
}
.pl-col {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: none;
  background: none;
  padding: 3px 6px;
  border-radius: 6px;
  color: inherit;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s;
}
@media (hover: hover) {
  .pl-col:hover {
    color: var(--text2);
    background: var(--card2);
  }
}
.pl-col.on {
  color: var(--accent);
  font-weight: 700;
}
.pl-col-arrow {
  font-size: 10px;
  line-height: 1;
}
/* 列表分支容器：多选条 + 列表纵向排列（v-else 与网格视图互斥） */
.pl-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.pl-drag {
  display: inline-flex;
  align-items: center;
  color: var(--text3);
  cursor: grab;
  flex-shrink: 0;
  opacity: 0.5;
  /* 触屏拖拽：禁止浏览器接管手势（否则拖拽变成页面滚动） */
  touch-action: none;
}
@media (hover: hover) {
  .pl-drag:hover {
    opacity: 1;
    color: var(--text2);
  }
}
.pl-drag:active {
  cursor: grabbing;
}
.pl-ghost {
  opacity: 0.4;
  background: var(--card2);
}
/* 壳内拖拽（pointer 模拟）：源行幽灵跟随指针 + 插入位置指示线 */
.pl-item.pl-drag-source {
  opacity: 0.45;
  background: var(--card2);
  cursor: grabbing;
  position: relative;
  z-index: 2;
  transition: none;
}
.pl-item.pl-drop-before {
  box-shadow: inset 0 2px 0 0 var(--accent);
}
.pl-item.pl-drop-after {
  box-shadow: inset 0 -2px 0 0 var(--accent);
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
@media (hover: hover) {
  .pl-item:hover {
    background: var(--card2);
  }
}
.pl-item.active {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 22%, transparent),
    color-mix(in srgb, var(--accent2) 12%, transparent)
  );
}
/* 多选态行 */
.pl-item.selected {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}
@media (hover: hover) {
  .pl-item.selected:hover {
    background: var(--accent-soft);
  }
}
.pl-idx {
  width: 20px;
  font-size: 12px;
  color: var(--text3);
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.pl-cover {
  width: 36px;
  height: 36px;
  border-radius: 8px;
  overflow: hidden;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  flex-shrink: 0;
}
.pl-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
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
  color: var(--red);
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
  cursor: pointer;
}
/* 定位当前播放：行临时高亮闪烁 */
.pl-item.pl-locate {
  animation: pl-locate-flash 1.4s ease-out;
}
@keyframes pl-locate-flash {
  0% {
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }
  100% {
    background: transparent;
  }
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
/* 行操作按钮：桌面 hover 显示；触屏设备常显半透明（无 hover 能力，不依赖悬停） */
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
@media (hover: hover) {
  .pl-item:hover .pl-action {
    opacity: 1;
  }
  .pl-action:hover {
    background: var(--border);
    color: var(--text);
  }
  .pl-action.remove:hover {
    color: var(--red);
  }
}
@media (hover: none) {
  .pl-action {
    opacity: 0.55;
  }
}
.pl-action.heart.on {
  opacity: 1;
  color: var(--red);
}
.pl-action.dl.busy {
  opacity: 1;
  color: var(--accent);
}
.pl-spin {
  animation: pl-dl-spin 0.9s linear infinite;
}
.spin {
  animation: pl-dl-spin 0.9s linear infinite;
}
@keyframes pl-dl-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
/* 多选批量操作条 */
.pl-multi {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--accent-soft);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pl-multi-count {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  margin-right: auto;
}
.pl-multi-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border-radius: 8px;
  background: var(--card);
  color: var(--text2);
  font-size: 11.5px;
  font-weight: 600;
  transition: all 0.12s;
}
.pl-multi-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
@media (hover: hover) {
  .pl-multi-btn:hover {
    background: var(--border);
    color: var(--text);
  }
}
.pl-multi-btn.danger {
  color: var(--red);
}
@media (hover: hover) {
  .pl-multi-btn.danger:hover {
    background: var(--red-soft);
    color: var(--red);
  }
}
/* 移到废纸篓确认弹窗 */
.dt-backdrop {
  position: fixed;
  inset: 0;
  z-index: 92;
  background: rgba(0, 0, 0, 0.35);
}
.dt-modal {
  position: fixed;
  z-index: 93;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 320px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 16px 48px var(--shadow-strong);
  padding: 18px;
}
.dt-title {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.dt-title svg {
  color: var(--red);
}
.dt-text {
  font-size: 12.5px;
  color: var(--text2);
  line-height: 1.6;
  margin: 10px 0 16px;
}
.dt-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dt-btn {
  height: 30px;
  padding: 0 14px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  background: var(--card2);
  transition: all 0.12s;
}
@media (hover: hover) {
  .dt-btn:hover {
    background: var(--border);
    color: var(--text);
  }
}
.dt-btn.danger {
  color: #fff;
  background: var(--red);
}
@media (hover: hover) {
  .dt-btn.danger:hover {
    background: color-mix(in srgb, var(--red) 85%, #000);
  }
}
/* 加歌浮层 */
.am-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.add-menu {
  position: fixed;
  z-index: 91;
  width: 220px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 12px 32px var(--shadow-strong);
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
@media (hover: hover) {
  .am-item:hover {
    background: var(--card2);
    color: var(--text);
  }
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
