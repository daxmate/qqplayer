<template>
  <div class="playlist" :class="{ 'sv-hidden': smartViewState.active }">
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

    <!-- 网格视图：歌手 / 专辑卡片（聚合/卡片/搜索过滤在 PlaylistBrowse 内部） -->
    <PlaylistBrowse
      v-if="gridMode"
      :browse-mode="browseMode"
      :query="query"
      :loading="state.loading"
      :cover-src="coverSrc"
      :cover-ok="coverOk"
      :mark-cover-error="markCoverError"
      :resolve-cover="resolveCover"
      @enter-group="enterGroup"
    />

    <!-- 多选批量操作条（桌面：⌘/Ctrl 点选进入多选态）+ 列头 + 歌曲列表 -->
    <div v-else class="pl-body">
      <!-- 多选批量操作条（桌面：⌘/Ctrl 点选进入多选态）：多选状态在 PlaylistBatchBar 内部 -->
      <PlaylistBatchBar
        ref="batchBar"
        @delete="openDeleteDialog"
        @add-playlist="openAddMenuBatch"
        @push-device="batchPushToDevice"
      />
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
        <PlaylistRow
          v-for="({ song, i }, vi) in visible"
          :key="song.id as PropertyKey"
          :song="song"
          :vi="vi"
          :active="i === state.currentIndex"
          :selected="isSelected(song.path)"
          :can-drag-out="canDragOut"
          :can-reorder="canReorder"
          :downloading="downloading"
          :in-playlist-view="inPlaylistView"
          :cover-src="coverSrc"
          :cover-ok="coverOk"
          :mark-cover-error="markCoverError"
          @click="onRowClick"
          @contextmenu="openCtxMenu"
          @dragstart="onRowDragStart"
          @favorite="toggleFavorite"
          @add-menu="openAddMenu"
          @download="downloadSong"
          @remove="removeItem"
          @locate="locateCurrent"
        />
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

    <!-- 加歌浮层（Teleport to body 防裁剪；位置计算/开关状态在 AddToPlaylistMenu 内部） -->
    <AddToPlaylistMenu ref="addMenuRef" />

    <!-- 右键菜单（桌面，Teleport 到 body 防裁剪） -->
    <ContextMenu
      :visible="ctxOpen"
      :x="ctxPos.x"
      :y="ctxPos.y"
      :fav="ctxSong ? isFavorite(ctxSong.path!) : false"
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
      :song="tagEditorSong ?? undefined"
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

<script setup lang="ts">
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import type { Song } from "../composables/playerState.js";
import { smartViewState } from "../composables/useSmartViews.js";
import { Music, RefreshCw, Search, Heart, ArrowLeft, Trash2, LocateFixed } from "@lucide/vue";
import {
  state,
  activePlaylist,
  selectSong,
  loadSongs,
  play,
  isFavorite,
  toggleFavorite,
  removeFromQueue,
  removeFromPlaylist,
  downloadSettings,
} from "../composables/usePlayer.js";
import { deleteLibrarySongs, removeSongsFromQueue } from "../composables/useLibrary.js";
import ScrapeResultModal from "./ScrapeResultModal.vue";
import { normalizeQuery, normalizeText } from "../utils/searchNormalize.js";
import { apiPost } from "../utils/apiClient.js";
import { showToast, toastError } from "../composables/useToast.js";
import { useCoverURL, COVER_CACHE_FIRST_N } from "../composables/useCoverURL.js";
import ContextMenu from "./ContextMenu.vue";
import TagEditorModal from "./TagEditorModal.vue";
import DevicePickerModal from "./DevicePickerModal.vue";
import PlaylistRow from "./PlaylistRow.vue";
import AddToPlaylistMenu, { computeAddMenuPos } from "./AddToPlaylistMenu.vue";
import PlaylistBatchBar from "./PlaylistBatchBar.vue";
import PlaylistBrowse from "./PlaylistBrowse.vue";
import { usePlaylistContextMenu } from "../composables/usePlaylistContextMenu.ts";
import { usePlaylistDnD } from "../composables/usePlaylistDnD.ts";
import { fetchDevices, pushSongsToDevice } from "../utils/deviceCommands.js";

// 视图行结构：可见列表元素（{ song, i }；i 为曲库索引，歌单/过滤/排序视图下与视图索引不同）
interface ViewEntry {
  song: Song;
  i: number;
}
// 设备记录结构型（deviceCommands 接口未导出，用 ReturnType 跟随真实签名）
type DeviceRecord = Awaited<ReturnType<typeof fetchDevices>>["devices"][number];

// 注：曾有过 compact prop（class 绑定），无任何调用方且与全局 html[data-compact] 机制重复，已移除。

const { t } = useI18n();

// 封面 URL 异步解析（阶段 F1）：iOS 壳本地优先（离线可显示），未命中远程 + 后台缓存；
// 桌面/非壳远程直出（行为零变化）。coverSrc 未解析完成返回 ""，模板 v-if 配合隐藏 <img>。
// 解析动作在主组件（watch visible 驱动），行内读取/错误标记通过 props 传入 PlaylistRow
// （useCoverURL 的 urlMap 每实例一份，解析与读取必须同源）。
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
const browseFilter = ref<{ type: "artist" | "album"; value: string; artist?: string } | null>(null); // { type: 'artist'|'album', value }

// 供外部（search anything @pick）进入分组浏览：type='artists'|'albums'，value 为规范化名字
function openBrowse(type: string, value: string) {
  browseMode.value = type;
  browseFilter.value = { type: type === "artists" ? "artist" : "album", value };
}
defineExpose({ openBrowse, computeAddMenuPos });

const UNKNOWN_ARTIST = t("playlist.unknownArtist");
const UNKNOWN_ALBUM = t("playlist.unknownAlbum");
const norm = (v: unknown, fallback: string) => (typeof v === "string" ? v.trim() : "") || fallback;

// 当前视图的歌曲列表：歌单视图按歌单顺序（songPaths）展开，i 为曲库索引；分组过滤后只留该组
const viewSongs = computed<ViewEntry[]>(() => {
  let list: ViewEntry[];
  if (!inPlaylistView.value) {
    list = state.songs.map((song, i) => ({ song, i }));
  } else {
    const pl = activePlaylist.value;
    if (!pl) return [];
    const byPath = new Map(state.songs.map((s, i) => [s.path, { song: s, i }]));
    list = (pl.songPaths || [])
      .map((path) => byPath.get(path))
      .filter((x): x is ViewEntry => Boolean(x));
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

// 分组详情标题（未知歌手/专辑保留原名）
const browseFilterTitle = computed(() => {
  const f = browseFilter.value;
  if (!f) return "";
  return f.type === "artist" ? f.value : `${f.value} · ${f.artist}`;
});

// 切换浏览 tab（清空分组过滤）
function enterBrowse(mode: string) {
  browseMode.value = mode;
  browseFilter.value = null;
  query.value = "";
}

// 点击卡片进入分组
function enterGroup(g: { name?: string; album?: string; artist?: string }) {
  browseFilter.value =
    browseMode.value === "artists"
      ? { type: "artist", value: g.name! }
      : { type: "album", value: g.album!, artist: g.artist };
  query.value = "";
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
    list = list.filter(({ song }) => isFavorite(song.path!));
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
function onColSort(key: string) {
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
function colArrow(key: string) {
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

function pick(i: number) {
  selectSong(i);
  play(); // 点击列表直接开始播放
}

// ============ 多选批量（桌面：⌘/Ctrl 点选进入多选态） ============
// 多选状态由 PlaylistBatchBar 持有（isSelected/清空/切换经模板 ref 转发）
const batchBar = ref<InstanceType<typeof PlaylistBatchBar> | null>(null);
const multiMode = computed(() => !!batchBar.value?.isMulti());

function isSelected(path: string | null) {
  return path != null && !!batchBar.value?.isSelected(path);
}

function clearSelection() {
  batchBar.value?.clearSelection();
}

// 行点击：多选态 = 切换选中；⌘/Ctrl+点选 = 进入多选态并选中；否则播放
// 网络歌（path=null）不参与多选（所有批量操作都是 path 语义），⌘/Ctrl+点选也不动作
// vi 是 visible（过滤+排序后）视图索引，entry.i 才是原始曲库索引——歌单/过滤/排序视图下两者不一致（8-19 壳内实测暴露）
function onRowClick(vi: number, e: MouseEvent) {
  const entry = visible.value[vi];
  if (!entry) return;
  const path = entry.song.path;
  const mod = e?.metaKey || e?.ctrlKey;
  if (multiMode.value || mod) {
    if (path != null) batchBar.value?.toggleSelected(path);
    return;
  }
  // 必须用 entry.i（全局曲库索引）：viewSongs 可能被过滤/歌单/排序，视图索引 ≠ 曲库索引
  pick(entry.i);
}

// 批量加歌单：复用 addMenu 浮层（批量模式 = 只加不删），路径由 PlaylistBatchBar emit 上来
function openAddMenuBatch(paths: string[]) {
  addMenuRef.value?.openForBatch(paths);
}

// ============ 右键菜单（桌面）+ 壳右键事件桥 ============
// ctx 状态/动作/全局事件绑定在 usePlaylistContextMenu（浏览器与 Swift 壳 NSMenu 共用同一套动作）；
// 弹窗（加歌浮层/废纸篓确认/标签编辑/设备选择）仍由主组件协调，经依赖注入传入。
const {
  ctxOpen,
  ctxSong,
  ctxPos,
  openCtxMenu,
  ctxCanGoArtist,
  ctxCanGoAlbum,
  ctxPlay,
  ctxPlayNext,
  ctxToggleFav,
  ctxAddPlaylist,
  ctxGoArtist,
  ctxGoAlbum,
  ctxDelete,
  ctxEditTags,
  ctxPushToDevice,
} = usePlaylistContextMenu({
  getVisible: () => visible.value,
  browseFilter,
  norm,
  UNKNOWN_ARTIST,
  UNKNOWN_ALBUM,
  openAddMenuAt,
  openDeleteDialog,
  openTagEditor,
  openDevicePicker,
});

// ============ 编辑标签/刮削（右键目标歌曲；autoScrape 打开自动刮削） ============
// （不切换当前播放；弹窗内保存/刮削都以该歌曲的 path 为准）
const tagEditorOpen = ref(false);
const tagEditorSong = ref<Song | null>(null);

function openTagEditor(song: Song | null) {
  if (!song?.path) return;
  tagEditorSong.value = song;
  tagEditorOpen.value = true;
}

// ============ 推送到设备（右键单选 / 多选批量 → DevicePickerModal） ============
const pickerOpen = ref(false);
const pickerDevices = ref<DeviceRecord[]>([]);
const pickerSongs = ref<Song[]>([]); // 待推送的曲库歌曲对象数组（含 path）

// 打开选择浮层：先拉设备清单，无已配对设备 → toast 提示（不弹浮层）
async function openDevicePicker(songs: unknown[]) {
  const list = (songs || []).filter((s): s is Song => !!s && !!(s as Song).path);
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

// 多选批量：选中路径（PlaylistBatchBar emit）→ 曲库歌曲对象（路径语义，网络歌天然被过滤）
function batchPushToDevice(paths: string[]) {
  const songs = state.songs.filter((s) => s && paths.includes(s.path!));
  openDevicePicker(songs);
}

// 浮层确认：推送选中歌曲到目标设备 → toast 成功/失败
async function onDevicePicked(device: DeviceRecord) {
  pickerOpen.value = false;
  const songs = pickerSongs.value;
  pickerSongs.value = [];
  const r = await pushSongsToDevice(
    songs as Parameters<typeof pushSongsToDevice>[0],
    device.device_id!,
  );
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

// ============ 行操作：移除（跟随视图语义） / 加歌 ============
function removeItem(vi: number) {
  const entry = visible.value[vi];
  if (!entry) return;
  if (inPlaylistView.value) {
    const path = entry.song.path;
    if (path) removeFromPlaylist(state.activePlaylistId!, path);
  } else {
    removeFromQueue(entry.i);
  }
}

// ============ 下载网络歌（行内按钮） ============
// 后端 POST /api/online/download（body {id, level?, title?, artist?}）→ 网易云取直链落盘到
// 下载目录（设置 download.downloadDir，空 = 曲库）；曲库 mtime 监听自动刷新，下载完成即出现为本地歌。
const downloading = reactive<Record<string, boolean>>({}); // streamId → 下载中

async function downloadSong(song: Song) {
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
    toastError(t("playlist.downloadFailed", { msg: (err as Error).message || "" }));
  } finally {
    downloading[id] = false;
  }
}

// 加歌浮层（AddToPlaylistMenu）：状态/位置计算/Teleport 全在子组件内，主组件只做打开转发与 Esc 协调
const addMenuRef = ref<InstanceType<typeof AddToPlaylistMenu> | null>(null);

// 行内按钮：锚定触发按钮（getBoundingClientRect 动态定位）
function openAddMenu(e: MouseEvent, path: string) {
  addMenuRef.value?.openForSingle(path, e.currentTarget as HTMLElement | null);
}

// 统一入口：anchor 为带 getBoundingClientRect 的元素（行内按钮 / 右键菜单鼠标位置的假 rect）
function openAddMenuAt(path: string, anchor: unknown) {
  addMenuRef.value?.openForSingle(path, anchor as { getBoundingClientRect(): DOMRect } | null);
}

// Esc 关闭（优先级：删除弹窗 → 右键菜单 → 加歌浮层 → 多选态）；
// resize/滚动重算（scroll 用捕获阶段）在 AddToPlaylistMenu 内部自管
function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (deleteOpen.value) {
    deleteOpen.value = false;
    return;
  }
  if (ctxOpen.value) {
    ctxOpen.value = false;
    return;
  }
  if (addMenuRef.value?.isOpen()) {
    addMenuRef.value.close();
    return;
  }
  if (multiMode.value) clearSelection();
}
onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
});

// ============ 移到废纸篓（确认 → DELETE → toast → 刷新，单曲/批量同一链路） ============
const deleteOpen = ref(false);
const deletePaths = ref<string[]>([]);

function openDeleteDialog(paths: string[]) {
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
    toastError((e as Error).message || t("errors.deleteSongs"));
    clearSelection();
  }
}

// ============ 歌单拖拽排序 + 定位当前播放 ============
// sortablejs/壳内 pointer 模拟/拖出加歌单数据源/定位滚动全部在 usePlaylistDnD
// （生命周期自管：重建/初始化/清理集中在 composable 内）
const { listEl, onRowDragStart, locateCurrent } = usePlaylistDnD({
  canReorder,
  canDragOut,
  visible,
});
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
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
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
</style>
