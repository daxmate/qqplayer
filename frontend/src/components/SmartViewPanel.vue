<template>
  <Teleport to="body">
    <div v-if="panelStyle" ref="panelEl" class="sv-panel" :style="panelStyle">
      <div class="sv-head">
        <button class="sv-back" :title="t('smart.back')" @click="close">
          <ArrowLeft :size="15" />
        </button>
        <span class="sv-title">{{ t(meta.titleKey) }}</span>
        <span class="sv-count">{{ t("smart.count", { n: rows.length }) }}</span>
      </div>
      <div ref="svListEl" class="sv-list">
        <div v-if="loading" class="sv-empty">{{ t("smart.loading") }}</div>
        <div v-else-if="error" class="sv-empty">{{ error }}</div>
        <template v-else>
          <div
            v-for="row in rows"
            :key="row.song.path"
            class="sv-item"
            :class="{ active: isCurrent(row) }"
            :data-path="row.song.path"
            draggable="true"
            @click="playRow(row)"
            @contextmenu.prevent="openCtxMenu($event, row)"
            @dragstart="onRowDragStart($event, row.song.path)"
            @dragend="onDragEnd"
          >
            <span class="sv-drag" :title="t('playlist.dragOut')">
              <GripVertical :size="14" />
            </span>
            <span class="sv-cover">
              <img
                v-if="coverOk(row.song.path)"
                :src="coverUrl(row.song.path)"
                alt=""
                loading="lazy"
                @error="markCoverError(row.song.path)"
              />
              <Music2 v-else :size="18" />
            </span>
            <span class="sv-info">
              <span class="sv-name">{{ row.song.name }}</span>
              <span class="sv-sub">
                {{ row.song.artist }}
                <template v-if="sub(row)"> · {{ sub(row) }}</template>
              </span>
            </span>
            <span v-if="isCurrent(row)" class="sv-eq" :title="t('smart.playing')">
              <span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span>
            </span>
          </div>
          <div v-if="!rows.length" class="sv-empty">{{ t(meta.emptyKey) }}</div>
        </template>
      </div>
    </div>

    <!-- 右键菜单（桌面，Teleport 到 body 防裁剪；浏览器环境，壳内由 NSMenu 接管） -->
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
      @delete="ctxDelete"
      @close="ctxOpen = false"
    />

    <!-- 加歌浮层（与 Playlist 同款：歌单勾选/切换） -->
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

    <!-- 移到废纸篓确认弹窗（与 Playlist 同一链路） -->
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
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import {
  ArrowLeft,
  Music2,
  ListPlus,
  ListMusic,
  Check,
  Plus,
  Trash2,
  GripVertical,
} from "@lucide/vue";
import {
  state,
  selectSong,
  play,
  loadSongs,
  isFavorite,
  toggleFavorite,
  isInPlaylist,
  addToPlaylist,
  removeFromPlaylist,
  _resetPlayMode,
  findSongIndex,
} from "../composables/usePlayer.js";
import {
  deleteLibrarySongs,
  removeSongsFromQueue,
  DRAG_SONG_TYPE,
} from "../composables/useLibrary.js";
import { inNativeShell, setupShellRowDrag } from "../composables/useShellDrag.js";
import { showToast, toastError } from "../composables/useToast.js";
import {
  SMART_VIEWS,
  smartViewState,
  loadSmartView,
  playSmartRow,
  fmtSmartSub,
} from "../composables/useSmartViews.js";
import ContextMenu from "./ContextMenu.vue";

const { t } = useI18n();

const props = defineProps({
  kind: { type: String, required: true },
});
const emit = defineEmits(["close"]);

const meta = computed(() => SMART_VIEWS[props.kind] || SMART_VIEWS.recentAdded);
const rows = computed(() => smartViewState.rows);
const loading = computed(() => smartViewState.loading);
const error = computed(() => smartViewState.error);

function isCurrent(row) {
  return state.currentSong && row.song.path === state.currentSong.path;
}
function sub(row) {
  return fmtSmartSub(row);
}
function playRow(row) {
  playSmartRow(row);
}
function close() {
  emit("close");
}

// ============ 拖拽到侧栏歌单（歌曲行 → Sidebar 歌单项） ============
// 浏览器：整行 draggable，dragstart 写自定义 MIME（与 Playlist.onRowDragStart 同一契约）；
// 网络歌（path=null）不能加歌单 → preventDefault。
// 浮层遮挡：.sv-panel 是 fixed + z-index 40 浮层，拖拽期间 drop 事件到不了下面的侧边栏歌单项，
// dragstart 时给面板根元素设 pointer-events:none 放行，dragend（drop 后必发）恢复。
const panelEl = ref(null);

function onRowDragStart(e, path) {
  if (!path) {
    e.preventDefault();
    return;
  }
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(DRAG_SONG_TYPE, path);
  dt.effectAllowed = "copy";
  if (panelEl.value) panelEl.value.style.pointerEvents = "none";
}

function onDragEnd() {
  if (panelEl.value) panelEl.value.style.pointerEvents = "";
}

// ============ 右键菜单（桌面）：浏览器 ContextMenu + 壳 NSMenu 共用同一套动作 ============
// 浏览器：行 @contextmenu.prevent → openCtxMenu 弹 ContextMenu；
// 壳内：useNativeCtxMenu 上报 .sv-item 命中 → NSMenu 点击派发 qqplayer:ctx-* 事件 → 下面同一套实现。
const ctxOpen = ref(false);
const ctxSong = ref(null);
const ctxPos = ref({ x: 0, y: 0 });

function openCtxMenu(e, row) {
  const song = row && row.song;
  if (!song) return;
  ctxSong.value = song;
  ctxPos.value = { x: e.clientX, y: e.clientY };
  ctxOpen.value = true;
}

function ctxClose() {
  ctxOpen.value = false;
}

// 进歌手/进专辑入口可见性：歌手/专辑非空才显示（与 ContextMenu.vue 的 canGoArtist/canGoAlbum 同源）
const ctxCanGoArtist = computed(() => {
  const s = ctxSong.value;
  return !!(s && s.artist && String(s.artist).trim());
});
const ctxCanGoAlbum = computed(() => {
  const s = ctxSong.value;
  return !!(s && s.album && String(s.album).trim());
});

// 播放指定曲库索引的歌（浏览器/壳共用；idx 越界静默）
function playFor(idx) {
  if (idx >= 0 && idx < state.songs.length) {
    selectSong(idx);
    play();
  }
}

// 下一首播放：把该歌挪到当前歌之后并立即播放（与 Playlist.playNextFor 同一实现）
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

function ctxPlay() {
  playFor(findSongIndex(ctxSong.value));
  ctxClose();
}

function ctxPlayNext() {
  playNextFor(findSongIndex(ctxSong.value));
  ctxClose();
}

function ctxToggleFav() {
  const p = ctxSong.value?.path;
  if (p != null) toggleFavorite(p);
  ctxClose();
}

// 加歌单：复用 addMenu 浮层，锚定在右键坐标（与 Playlist.ctxAddPlaylist 同一方式）
function ctxAddPlaylist() {
  const p = ctxSong.value?.path;
  if (p == null) {
    ctxClose();
    return;
  }
  const { x, y } = ctxPos.value;
  ctxClose();
  openAddMenuAt(p, x, y);
}

// 进歌手/进专辑：关闭智能视图并让 Playlist 进入分组浏览（App 监听 qqplayer:open-browse 窗口事件）
function goBrowse(type, value) {
  ctxClose();
  emit("close");
  window.dispatchEvent(new CustomEvent("qqplayer:open-browse", { detail: { type, value } }));
}

function ctxGoArtist() {
  const s = ctxSong.value;
  if (s?.artist) goBrowse("artist", s.artist);
}

function ctxGoAlbum() {
  const s = ctxSong.value;
  if (s?.album) goBrowse("album", s.album);
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

// ============ 加歌浮层（与 Playlist 同款：歌单列表 + 勾选/切换） ============
const addMenuOpen = ref(false);
const addMenuPaths = ref([]);
const addMenuPos = ref({ top: 0, left: 0 });

const ADD_MENU_WIDTH = 220; // 与 .add-menu width 一致
const ADD_MENU_GAP = 6;
const ADD_MENU_EST_HEIGHT = 220;
const ADD_MENU_MARGIN = 8;
let addMenuAnchorRect = null; // 右键坐标假 rect（浮层精修测量用）

// 纯函数：锚点 rect + 浮层高度 + 视口尺寸 → { top, left, flip }
// 与 Playlist.computeAddMenuPos 同公式：下方放不下翻转，右缘对齐展开
function computeAddMenuPos(rect, menuHeight, vw = window.innerWidth, vh = window.innerHeight) {
  const below = Math.max(ADD_MENU_MARGIN, rect.bottom + ADD_MENU_GAP);
  const flip = below + menuHeight > vh - ADD_MENU_MARGIN;
  const top = flip ? Math.max(ADD_MENU_MARGIN, rect.top - menuHeight - ADD_MENU_GAP) : below;
  const left = Math.max(
    ADD_MENU_MARGIN,
    Math.min(rect.right - ADD_MENU_WIDTH, vw - ADD_MENU_WIDTH - ADD_MENU_MARGIN),
  );
  return { top, left, flip };
}

// 统一入口：鼠标坐标（右键菜单锚定）→ 假 rect 右对齐展开
function openAddMenuAt(path, x, y) {
  addMenuPaths.value = [path];
  addMenuAnchorRect = {
    left: x,
    top: y,
    right: x + ADD_MENU_WIDTH,
    bottom: y + 4,
    width: ADD_MENU_WIDTH,
    height: 4,
  };
  addMenuPos.value = computeAddMenuPos(addMenuAnchorRect, ADD_MENU_EST_HEIGHT);
  addMenuOpen.value = true;
  // 渲染后用实际高度精修（歌单多时更高，翻转判定更准）
  nextTick(() => {
    if (addMenuOpen.value) refineAddMenuPos();
  });
}

const addMenuStyle = computed(() => ({
  top: addMenuPos.value.top + "px",
  left: addMenuPos.value.left + "px",
}));

const addMenuEl = ref(null); // 浮层根元素（测量实际高度）

// 渲染后用实际浮层高度精修（歌单多时浮层更高，翻转判定更准）——与 Playlist 同一做法
function refineAddMenuPos() {
  if (!addMenuAnchorRect) return;
  const el = addMenuEl.value;
  const h = el ? el.getBoundingClientRect().height : ADD_MENU_EST_HEIGHT;
  addMenuPos.value = computeAddMenuPos(addMenuAnchorRect, h);
}

// 浮层内歌单的勾选态：当前歌在歌单 = 勾选
function addMenuIn(pid) {
  const paths = addMenuPaths.value;
  return paths.length > 0 && paths.every((p) => isInPlaylist(pid, p));
}

async function toggleAdd(pid) {
  const paths = addMenuPaths.value;
  if (!paths.length) return;
  try {
    if (isInPlaylist(pid, paths[0])) {
      await removeFromPlaylist(pid, paths[0]);
    } else {
      await addToPlaylist(pid, paths[0]);
    }
  } catch (e) {
    toastError(e.message);
  }
}

// ============ 移到废纸篓（确认 → DELETE → toast → 刷新，与 Playlist 同一链路） ============
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
    // 刷新曲库；recentAdded 由 useSmartViews 的 watch 自动重算，recentPlayed/topPlayed 保持进入时数据
    await loadSongs({ force: true });
  } catch (e) {
    toastError(e.message || t("errors.deleteSongs"));
  }
}

// ============ Swift 壳右键菜单动作（useNativeCtxMenu 上报 .sv-item 命中 → NSMenu 点击 → 事件派发到这里） ============
// 与浏览器右键菜单共用同一套实现（playFor/playNextFor/goBrowse/openAddMenuAt/openDeleteDialog），
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
  openAddMenuAt(p, x, y);
}

// 移到废纸篓：与 ctxDelete 同一确认弹窗链路
function onCtxDeleteSong(e) {
  const p = e.detail?.path;
  if (p != null) openDeleteDialog([p]);
}

function onCtxGoArtist(e) {
  const s = ctxSongFromEvent(e);
  if (s?.artist) goBrowse("artist", s.artist);
}

function onCtxGoAlbum(e) {
  const s = ctxSongFromEvent(e);
  if (s?.album) goBrowse("album", s.album);
}

const CTX_EVENTS = [
  ["qqplayer:ctx-play", onCtxPlay],
  ["qqplayer:ctx-playnext", onCtxPlayNext],
  ["qqplayer:ctx-togglefav", onCtxToggleFav],
  ["qqplayer:ctx-addplaylist", onCtxAddPlaylist],
  ["qqplayer:ctx-deletesong", onCtxDeleteSong],
  ["qqplayer:ctx-goartist", onCtxGoArtist],
  ["qqplayer:ctx-goalbum", onCtxGoAlbum],
];

function bindCtxEvents() {
  for (const [name, fn] of CTX_EVENTS) window.addEventListener(name, fn);
}

function unbindCtxEvents() {
  for (const [name, fn] of CTX_EVENTS) window.removeEventListener(name, fn);
}

// ============ 定位：覆盖桌面播放列表面板（.main .playlist 的网格位置） ============
// 智能视图复用播放列表所在的 280px 列；面板随 Playlist 的 rect 变化自适应
const panelStyle = ref(null);
let ro = null;

// ============ 壳内拖拽到侧栏歌单（WKWebView 无 HTML5 DnD → Pointer Events 模拟） ============
// 只拖到侧栏歌单（自动歌单不可排序：getCanReorder=false，reorder 回调空实现）；
// 几何命中不受浮层遮挡影响，与浏览器 pointer-events 放行无关。
const svListEl = ref(null);
let shellDragCleanup = null;

function setupShellDrag() {
  shellDragCleanup?.();
  shellDragCleanup = null;
  const el = svListEl.value;
  if (!el || !inNativeShell()) return;
  shellDragCleanup = setupShellRowDrag({
    listEl: el,
    rowSelector: ".sv-item",
    handleSelector: ".sv-drag",
    getCanDrag: () => true,
    getCanReorder: () => false,
    isPlaylistView: () => false,
    onQueueReorder: () => {},
    onPlaylistReorder: () => {},
  });
}

function measure() {
  const el = document.querySelector(".main .playlist");
  if (!el) {
    panelStyle.value = null;
    return;
  }
  const r = el.getBoundingClientRect();
  panelStyle.value = {
    left: `${r.left}px`,
    top: `${r.top}px`,
    width: `${r.width}px`,
    height: `${r.height}px`,
  };
}

function setupMeasure() {
  ro?.disconnect();
  const el = document.querySelector(".main .playlist");
  if (!el) return;
  ro = new ResizeObserver(measure);
  ro.observe(el);
}

// 布局变化（侧栏开关/控制区收起/窗口缩放）后重新对齐
function remeasure() {
  requestAnimationFrame(measure);
}

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
  close();
}

watch(() => state.musicLibOpen, remeasure);
watch(() => state.controlsHidden, remeasure);
// 面板浮层渲染后才存在 .sv-list → panelStyle 变化时（重）挂壳内拖拽（含初次渲染）
watch(panelStyle, () => nextTick(setupShellDrag), { immediate: true });
watch(
  () => props.kind,
  (k) => loadSmartView(k),
  { flush: "post" },
);

onMounted(() => {
  measure();
  setupMeasure();
  window.addEventListener("resize", remeasure);
  window.addEventListener("keydown", onKeydown);
  bindCtxEvents(); // 壳右键菜单动作（浏览器内事件永不派发，无副作用）
  loadSmartView(props.kind); // 进入视图时拉取数据
});
onBeforeUnmount(() => {
  shellDragCleanup?.();
  ro?.disconnect();
  window.removeEventListener("resize", remeasure);
  window.removeEventListener("keydown", onKeydown);
  unbindCtxEvents();
});

// ============ 封面错误缓存 ============
const coverErrors = ref(new Set());
function coverOk(path) {
  return !coverErrors.value.has(path);
}
function markCoverError(path) {
  coverErrors.value.add(path);
}
function coverUrl(path) {
  return "/api/cover?path=" + encodeURIComponent(path);
}
</script>

<style scoped>
.sv-panel {
  position: fixed;
  z-index: 40;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(160deg, var(--bg), var(--bg2)); /* 与 body 底色一致，覆盖原列 */
}
.sv-head {
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
.sv-back {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.12s;
  flex-shrink: 0;
}
@media (hover: hover) {
  .sv-back:hover {
    background: var(--border);
    color: var(--text);
  }
}
.sv-back:active {
  transform: scale(0.92);
}
.sv-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-count {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.sv-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.sv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s;
}
@media (hover: hover) {
  .sv-item:hover {
    background: var(--card2);
  }
}
.sv-item.active {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 22%, transparent),
    color-mix(in srgb, var(--accent2) 12%, transparent)
  );
}
/* 拖拽手柄（与 Playlist .pl-drag 同款视觉） */
.sv-drag {
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
  .sv-drag:hover {
    opacity: 1;
    color: var(--text2);
  }
}
.sv-drag:active {
  cursor: grabbing;
}
/* 壳内拖拽（pointer 模拟）：源行幽灵样式（与 Playlist 同款） */
.sv-item.pl-drag-source {
  opacity: 0.45;
  background: var(--card2);
  cursor: grabbing;
  position: relative;
  z-index: 2;
  transition: none;
}
.sv-cover {
  width: 40px;
  height: 40px;
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  font-size: 0;
}
.sv-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.sv-info {
  flex: 1;
  min-width: 0;
}
.sv-name {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-sub {
  display: block;
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sv-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.sv-eq .eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: sv-eq-bounce 1s ease-in-out infinite;
}
.sv-eq .eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.sv-eq .eq-bar:nth-child(3) {
  animation-delay: -0.66s;
}
@keyframes sv-eq-bounce {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
.sv-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
/* 加歌浮层（与 Playlist 同款视觉） */
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
/* 移到废纸篓确认弹窗（与 Playlist 同款视觉） */
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
