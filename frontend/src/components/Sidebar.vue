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

      <!-- 歌单列表（拖拽目标：歌曲行拖进来加歌） -->
      <template v-for="p in state.playlists" :key="p.id">
        <div
          v-if="editingId !== p.id"
          class="sb-item"
          :class="{ on: p.id === state.activePlaylistId, 'sb-drop': dropOverId === p.id }"
          :title="p.name"
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
  </aside>
</template>

<script setup>
import { ref, nextTick, onMounted, onBeforeUnmount } from "vue";
import {
  Library,
  Music2,
  ListMusic,
  Plus,
  Pencil,
  Trash2,
  Sparkles,
  History,
  TrendingUp,
} from "@lucide/vue";
import { useI18n } from "vue-i18n";
import {
  state,
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
  smartViewState,
  loadSmartView,
  closeSmartView,
} from "../composables/useSmartViews.js";
import SmartViewPanel from "./SmartViewPanel.vue";

const { t } = useI18n();

// 智能视图入口定义（图标组件在模板里用 <component :is> 渲染）
const smartViewEntries = [
  { kind: "recentAdded", titleKey: SMART_VIEWS.recentAdded.titleKey, icon: Sparkles },
  { kind: "recentPlayed", titleKey: SMART_VIEWS.recentPlayed.titleKey, icon: History },
  { kind: "topPlayed", titleKey: SMART_VIEWS.topPlayed.titleKey, icon: TrendingUp },
];

function activate(pid) {
  if (smartViewState.active) closeSmartViewPanel(); // 切回常规视图时关闭智能视图
  state.activePlaylistId = pid;
  state.playlistOpen = true; // 点击曲库条目时自动打开播放列表面板
}

// ============ 智能视图 ============
function openSmartView(kind) {
  if (smartViewState.active === kind) {
    closeSmartViewPanel(); // 再点同一项 = 关闭
    return;
  }
  smartViewState.prevPlaylistOpen = state.playlistOpen; // 记住进入前的面板开关，退出时恢复
  state.playlistOpen = true; // 挂载 Playlist 作为智能视图定位锚点（面板覆盖其上）
  loadSmartView(kind);
}

function closeSmartViewPanel() {
  const prev = smartViewState.prevPlaylistOpen;
  closeSmartView();
  if (typeof prev === "boolean") state.playlistOpen = prev;
  smartViewState.prevPlaylistOpen = null;
}

// 侧栏被关闭（音乐库面板收起）时同步退出智能视图，避免残留覆盖层
onBeforeUnmount(() => {
  window.removeEventListener("dragend", clearDropHighlight);
  if (smartViewState.active) {
    const prev = smartViewState.prevPlaylistOpen;
    closeSmartView();
    if (typeof prev === "boolean") state.playlistOpen = prev;
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
onMounted(() => window.addEventListener("dragend", clearDropHighlight));

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
  editInput.value?.focus();
  editInput.value?.select();
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
