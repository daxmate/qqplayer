<template>
  <aside class="sidebar">
    <div class="sb-head">
      <Library :size="14" />
      {{ t("sidebar.musicLib") }}
    </div>

    <div class="sb-list">
      <!-- 全部歌曲 -->
      <div
        class="sb-item"
        :class="{ on: !state.activePlaylistId && !smartViewState.active }"
        :title="t('sidebar.allSongs')"
        @click="activate(null)"
      >
        <Music2 :size="15" />
        <span class="sb-name">{{ t("sidebar.allSongs") }}</span>
        <span class="sb-count">{{ state.songs.length }}</span>
      </div>

      <!-- 智能视图：最近添加 / 最近播放 / 常听排行 -->
      <div class="sb-group">{{ t("sidebar.smartViews") }}</div>
      <template v-for="v in smartViewEntries" :key="v.kind">
        <div
          class="sb-item"
          :class="{ on: smartViewState.active === v.kind }"
          :title="t(v.titleKey)"
          @click="openSmartView(v.kind)"
        >
          <component :is="v.icon" :size="15" />
          <span class="sb-name">{{ t(v.titleKey) }}</span>
        </div>
      </template>

      <!-- 年代分类（Apple Music Decades 粒度，纯前端按 song.year 聚合） -->
      <div class="sb-group">{{ t("sidebar.decades") }}</div>
      <template v-for="b in decadeEntries" :key="b.key">
        <div
          class="sb-item"
          :class="{
            on: smartViewState.active === 'decades' && smartViewState.decade === b.key,
          }"
          :title="decadeLabel(b)"
          :data-testid="'sb-decade-' + b.key"
          @click="openSmartView('decades', b.key)"
        >
          <Calendar :size="15" />
          <span class="sb-name">{{ decadeLabel(b) }}</span>
          <span class="sb-count">{{ decadeCounts[b.key] ?? 0 }}</span>
        </div>
      </template>

      <!-- 歌单列表（拖拽目标：歌曲行拖进来加歌） -->
      <template v-for="p in state.playlists" :key="p.id">
        <div
          v-if="editingId !== p.id"
          class="sb-item"
          :class="{ on: p.id === state.activePlaylistId, 'sb-drop': dropOverId === p.id }"
          :title="p.name"
          :data-playlist-id="p.id"
          @click="activate(p.id)"
          @dragover="onPlaylistDragOver(p, $event)"
          @dragleave="onPlaylistDragLeave(p, $event)"
          @drop="onPlaylistDrop(p, $event)"
        >
          <ListMusic :size="15" />
          <span class="sb-name">{{ p.name }}</span>
          <span class="sb-count">{{ (p.songPaths || []).length }}</span>
          <span class="sb-actions" @click.stop>
            <button class="sb-act" :title="t('sidebar.rename')" @click="startRename(p)">
              <Pencil :size="12" />
            </button>
            <button
              class="sb-act danger"
              :title="t('sidebar.deletePlaylist')"
              @click="askDelete(p)"
            >
              <Trash2 :size="12" />
            </button>
            <!-- 推送到设备（歌单全部歌曲 → DevicePickerModal） -->
            <button class="sb-act" :title="t('sidebar.pushToDevice')" @click="openPlaylistPush(p)">
              <Send :size="12" />
            </button>
          </span>
        </div>
        <!-- 行内改名输入 -->
        <div v-else class="sb-item sb-editing">
          <input
            ref="editInput"
            v-model="editName"
            class="sb-input"
            type="text"
            maxlength="40"
            spellcheck="false"
            :placeholder="t('sidebar.playlistName')"
            @keydown.enter="commitEdit"
            @keydown.esc="cancelEdit"
            @blur="commitEdit"
          />
        </div>
      </template>

      <!-- 新建歌单输入行 -->
      <div v-if="creating" class="sb-item sb-editing">
        <input
          ref="createInput"
          v-model="createName"
          class="sb-input"
          type="text"
          maxlength="40"
          spellcheck="false"
          :placeholder="t('sidebar.createPlaceholder')"
          @keydown.enter="commitCreate"
          @keydown.esc="creating = false"
          @blur="commitCreate"
        />
      </div>

      <div v-if="!state.playlists.length && !creating" class="sb-empty">
        {{ t("sidebar.noPlaylists") }}
      </div>
    </div>

    <button class="sb-new" @click="startCreate">
      <Plus :size="14" />
      {{ t("sidebar.newPlaylist") }}
    </button>

    <!-- 智能视图面板：覆盖播放列表列 -->
    <SmartViewPanel
      v-if="smartViewState.active"
      :kind="smartViewState.active"
      @close="closeSmartViewPanel"
    />

    <!-- 设备选择浮层（歌单推送到设备，与 Playlist 同款） -->
    <DevicePickerModal
      :open="pushPickerOpen"
      :devices="pushPickerDevices"
      @close="pushPickerOpen = false"
      @select="onPlaylistPushPicked"
    />
  </aside>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import {
  Library,
  Music2,
  ListMusic,
  Plus,
  Pencil,
  Trash2,
  Send,
  Sparkles,
  History,
  TrendingUp,
  Calendar,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import {
  state,
  uiState,
  selectSong,
  play,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  isInPlaylist,
  DRAG_SONG_TYPE,
} from "../composables/usePlayer.js";
import { showToast, toastError } from "../composables/useToast.js";
import {
  SMART_VIEWS,
  DECADE_BUCKETS,
  smartViewState,
  loadSmartView,
  closeSmartView,
  countByDecade,
} from "../composables/useSmartViews.js";
import SmartViewPanel from "./SmartViewPanel.vue";
import DevicePickerModal from "./DevicePickerModal.vue";
import { fetchDevices, pushSongsToDevice } from "../utils/deviceCommands.js";

const { t } = useI18n();

// 智能视图入口定义（图标组件在模板里用 <component :is> 渲染）
const smartViewEntries = [
  { kind: "recentAdded", titleKey: SMART_VIEWS.recentAdded.titleKey, icon: Sparkles },
  { kind: "recentPlayed", titleKey: SMART_VIEWS.recentPlayed.titleKey, icon: History },
  { kind: "topPlayed", titleKey: SMART_VIEWS.topPlayed.titleKey, icon: TrendingUp },
];

// 年代入口（Apple Music Decades：更早 / 60s~20s / 未知）
const decadeEntries = DECADE_BUCKETS;
const decadeCounts = computed(() => countByDecade(state.songs));

function decadeLabel(b) {
  return b.labelParams ? t(b.labelKey, b.labelParams) : t(b.labelKey);
}

function activate(pid) {
  if (smartViewState.active) closeSmartViewPanel(); // 切回常规视图时关闭智能视图
  state.activePlaylistId = pid;
  uiState.playlistOpen = true; // 点击曲库条目时自动打开播放列表面板
}

// ============ 智能视图 ============
function openSmartView(kind, decade) {
  // 再点同一项 = 关闭（年代视图：同 kind + 同 decade）
  const same =
    smartViewState.active === kind && (kind !== "decades" || smartViewState.decade === decade);
  if (same) {
    closeSmartViewPanel();
    return;
  }
  smartViewState.prevPlaylistOpen = uiState.playlistOpen; // 记住进入前的面板开关，退出时恢复
  uiState.playlistOpen = true; // 挂载 Playlist 作为智能视图定位锚点（面板覆盖其上）
  if (kind === "decades") smartViewState.decade = decade;
  loadSmartView(kind);
}

function closeSmartViewPanel() {
  const prev = smartViewState.prevPlaylistOpen;
  closeSmartView();
  if (typeof prev === "boolean") uiState.playlistOpen = prev;
  smartViewState.prevPlaylistOpen = null;
}

// 侧栏被关闭（音乐库面板收起）时同步退出智能视图，避免残留覆盖层
onBeforeUnmount(() => {
  window.removeEventListener("dragend", clearDropHighlight);
  unbindCtxEvents(); // 壳右键菜单动作监听
  if (smartViewState.active) {
    const prev = smartViewState.prevPlaylistOpen;
    closeSmartView();
    if (typeof prev === "boolean") uiState.playlistOpen = prev;
    smartViewState.prevPlaylistOpen = null;
  }
});

// ============ 拖拽加歌单（歌曲行 → 歌单项） ============
// 只响应歌曲行拖拽（Playlist 用自定义 MIME 写入路径）；文件拖拽导入（Files 类型）不受影响
const dropOverId = ref(null);

function dragHasSong(e) {
  return Array.from(e?.dataTransfer?.types || []).includes(DRAG_SONG_TYPE);
}

function onPlaylistDragOver(p, e) {
  if (!dragHasSong(e)) return;
  e.preventDefault(); // 允许 drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  dropOverId.value = p.id; // 高亮歌单项
}

function onPlaylistDragLeave(p, e) {
  // 移入子元素也会触发 dragleave：relatedTarget 仍在歌单项内 → 不取消高亮
  if (e.currentTarget.contains(e.relatedTarget)) return;
  if (dropOverId.value === p.id) dropOverId.value = null;
}

async function onPlaylistDrop(p, e) {
  if (!dragHasSong(e)) return;
  e.preventDefault();
  dropOverId.value = null;
  const path = e.dataTransfer?.getData(DRAG_SONG_TYPE);
  if (!path) return;
  await addSongToPlaylist(p, path);
}

// 加歌到歌单（幂等 + toast）：浏览器 drop / 壳内拖拽（useShellDrag 派发）共用，语义完全一致
async function addSongToPlaylist(p, path) {
  if (isInPlaylist(p.id, path)) {
    showToast(t("sidebar.drag.alreadyIn", { name: p.name }));
    return;
  }
  try {
    await addToPlaylist(p.id, path); // 幂等：先查再调，toast 区分「已加入」/「已在」
    showToast(t("sidebar.drag.added", { name: p.name }));
  } catch (err) {
    toastError(err.message);
  }
}

function clearDropHighlight() {
  dropOverId.value = null;
}
onMounted(() => {
  window.addEventListener("dragend", clearDropHighlight);
  bindCtxEvents(); // 壳右键菜单动作（浏览器内事件永不派发，无副作用）
});

// ============ Swift 壳右键菜单动作（useNativeCtxMenu 上报上下文 → 壳注入 NSMenu → 点击调 __qqCtxMenu → 事件派发到这里） ============
// 复用侧边栏既有实现（activate/startRename/askDelete）；事件只在原生壳内派发，浏览器永不触发。
function playlistFromEvent(e) {
  return state.playlists.find((x) => x.id === e.detail?.id) ?? null;
}

// 播放：打开该歌单视图；有歌则从第一首开始播（与点击歌单 + 点歌行为等价）
function onCtxPlayPlaylist(e) {
  const p = playlistFromEvent(e);
  if (!p) return;
  activate(p.id);
  const first = (p.songPaths || [])[0];
  if (first) {
    const idx = state.songs.findIndex((s) => s.path === first);
    if (idx >= 0) {
      selectSong(idx);
      play();
    }
  }
}

// 重命名：行内输入（startRename 内部聚焦并全选）
function onCtxRenamePlaylist(e) {
  const p = playlistFromEvent(e);
  if (p) startRename(p);
}

// 删除：Gmail 式删除 + 撤销 toast（askDelete）
function onCtxDeletePlaylist(e) {
  const p = playlistFromEvent(e);
  if (p) askDelete(p);
}

const CTX_EVENTS = [
  ["qqplayer:ctx-playplaylist", onCtxPlayPlaylist],
  ["qqplayer:ctx-renameplaylist", onCtxRenamePlaylist],
  ["qqplayer:ctx-deleteplaylist", onCtxDeletePlaylist],
];

// 壳内拖拽加歌单（useShellDrag 派发，无 dataTransfer）：与右键菜单一样走 window 事件，
// 复用浏览器 drop 同一套幂等加歌 + toast（addSongToPlaylist）
function onShellDragDrop(e) {
  const p = playlistFromEvent(e); // e.detail.id
  const path = e.detail?.path;
  if (!p || !path) return;
  addSongToPlaylist(p, path);
}

const SHELL_DRAG_EVENTS = [["qqplayer:shell-drag-drop", onShellDragDrop]];

function bindCtxEvents() {
  for (const [name, fn] of CTX_EVENTS) window.addEventListener(name, fn);
  for (const [name, fn] of SHELL_DRAG_EVENTS) window.addEventListener(name, fn);
}

function unbindCtxEvents() {
  for (const [name, fn] of CTX_EVENTS) window.removeEventListener(name, fn);
  for (const [name, fn] of SHELL_DRAG_EVENTS) window.removeEventListener(name, fn);
}

// ============ 新建 ============
const creating = ref(false);
const createName = ref("");
const createInput = ref(null);

async function startCreate() {
  creating.value = true;
  createName.value = "";
  await nextTick();
  createInput.value?.focus();
}

async function commitCreate() {
  if (!creating.value) return;
  creating.value = false;
  const name = createName.value.trim();
  if (!name) return;
  try {
    const p = await createPlaylist(name);
    state.activePlaylistId = p.id; // 建完直接进入该歌单
  } catch (e) {
    toastError(e.message);
  }
}

// ============ 改名 ============
const editingId = ref(null);
const editName = ref("");
const editInput = ref(null);

async function startRename(p) {
  editingId.value = p.id;
  editName.value = p.name;
  await nextTick();
  // editInput 在 v-for 内（<template v-for="p in state.playlists">），Vue 3 对 v-for 内 ref 收集为数组 → 取 [0]
  editInput.value?.[0]?.focus();
  editInput.value?.[0]?.select();
}

async function commitEdit() {
  if (!editingId.value) return;
  const pid = editingId.value;
  editingId.value = null;
  const name = editName.value.trim();
  if (!name) return;
  try {
    await renamePlaylist(pid, name);
  } catch (e) {
    toastError(e.message);
  }
}

function cancelEdit() {
  editingId.value = null;
}

// ============ 推送到设备（歌单行按钮 → DevicePickerModal） ============
// 与 Playlist.openDevicePicker 同一链路：歌单歌曲路径反查曲库对象（流媒体/已删歌曲被过滤）
// → 拉设备清单 → 无设备 toast 提示 → 弹 DevicePickerModal → 确认后推送
const pushPickerOpen = ref(false);
const pushPickerDevices = ref([]);
const pushPickerSongs = ref([]); // 待推送的曲库歌曲对象数组（含 path）

async function openPlaylistPush(p) {
  // p = 歌单对象 {id, songPaths: [...]}
  const paths = (p.songPaths || []).filter(Boolean);
  if (!paths.length) {
    showToast(t("playlist.pushFailed"), { type: "error" });
    return;
  }
  const songs = state.songs.filter((s) => s && paths.includes(s.path)); // 路径反查歌曲对象
  if (!songs.length) {
    showToast(t("playlist.pushFailed"), { type: "error" });
    return;
  }
  const r = await fetchDevices();
  if (!r.ok || !r.devices.length) {
    showToast(t("playlist.noDevicesToast"), { type: "error" });
    return;
  }
  pushPickerSongs.value = songs;
  pushPickerDevices.value = r.devices;
  pushPickerOpen.value = true;
}

async function onPlaylistPushPicked(device) {
  pushPickerOpen.value = false;
  const songs = pushPickerSongs.value;
  pushPickerSongs.value = [];
  const r = await pushSongsToDevice(songs, device.device_id);
  if (r.ok) {
    const n = songs.length - (Array.isArray(r.skipped) ? r.skipped.length : 0);
    showToast(t("playlist.pushSuccess", { n: Math.max(0, n) }));
  } else {
    showToast(t("playlist.pushFailedReason", { reason: r.error || r.reason || "" }), {
      type: "error",
    });
  }
}

// ============ 删除 ============
// Gmail 式：删除直接执行 + toast 带撤销按钮（duration 窗口期内可恢复）
const UNDO_DURATION = 5000;

async function askDelete(p) {
  // 删除前缓存完整歌单数据，供撤销恢复
  const cached = {
    id: p.id,
    name: p.name,
    songPaths: [...(p.songPaths || [])],
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  try {
    await deletePlaylist(p.id);
  } catch (e) {
    // 删除失败：不弹撤销
    toastError(e.message);
    return;
  }
  showToast(t("sidebar.deletedPlaylist", { name: p.name }), {
    duration: UNDO_DURATION,
    action: {
      label: t("sidebar.undo"),
      onClick: () => restorePlaylist(cached),
    },
  });
}

// 撤销恢复：后端 POST /api/playlists 不支持指定 id → 重建拿新 id + 批量加回歌曲
async function restorePlaylist(cached) {
  try {
    const p = await createPlaylist(cached.name);
    for (const path of cached.songPaths || []) {
      await addToPlaylist(p.id, path);
    }
    showToast(t("sidebar.restoredPlaylist", { name: cached.name }));
  } catch (e) {
    toastError(e.message || t("errors.restorePlaylist"));
  }
}
</script>

<style scoped>
.sidebar {
  width: 200px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.sb-head {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text2);
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 6px;
}
.sb-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.sb-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 10px;
  border-radius: 9px;
  cursor: pointer;
  color: var(--text2);
  font-size: 12.5px;
  transition: all 0.12s;
  min-width: 0;
}
.sb-item:hover {
  background: var(--card2);
  color: var(--text);
}
.sb-item.on {
  background: linear-gradient(
    135deg,
    color-mix(in srgb, var(--accent) 20%, transparent),
    color-mix(in srgb, var(--accent2) 10%, transparent)
  );
  color: var(--text);
  font-weight: 600;
}
/* 拖拽悬停高亮（歌曲行拖到歌单） */
.sb-item.sb-drop {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
  color: var(--text);
}
.sb-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb-count {
  font-size: 11px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.sb-actions {
  display: none;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
}
.sb-item:hover .sb-actions {
  display: inline-flex;
}
.sb-act {
  width: 20px;
  height: 20px;
  border-radius: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  background: transparent;
  transition: all 0.12s;
}
.sb-act:hover {
  background: var(--border);
  color: var(--text);
}
.sb-act.danger:hover {
  color: var(--red);
}
.sb-empty {
  text-align: center;
  color: var(--text3);
  font-size: 12px;
  padding: 20px 0;
}
.sb-group {
  padding: 10px 10px 2px;
  font-size: 11px;
  font-weight: 700;
  color: var(--text3);
  letter-spacing: 0.5px;
}
.sb-editing {
  padding: 3px;
  cursor: default;
}
.sb-input {
  flex: 1;
  min-width: 0;
  height: 28px;
  background: var(--card2);
  border: 1px solid var(--accent);
  border-radius: 8px;
  color: var(--text);
  font-size: 12.5px;
  padding: 0 8px;
  outline: none;
}
.sb-new {
  margin: 8px;
  height: 32px;
  border-radius: 9px;
  border: 1px dashed var(--border);
  background: transparent;
  color: var(--text2);
  font-size: 12.5px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  cursor: pointer;
  transition: all 0.15s;
  flex-shrink: 0;
}
.sb-new:hover {
  background: var(--card2);
  color: var(--text);
  border-color: var(--accent);
}
</style>
