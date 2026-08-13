<template>
  <aside class="sidebar">
    <div class="sb-head">
      <Library :size="14" />
      音乐库
    </div>

    <div class="sb-list">
      <!-- 全部歌曲 -->
      <div
        class="sb-item"
        :class="{ on: !state.activePlaylistId }"
        title="全部歌曲"
        @click="activate(null)"
      >
        <Music2 :size="15" />
        <span class="sb-name">全部歌曲</span>
        <span class="sb-count">{{ state.songs.length }}</span>
      </div>

      <!-- 歌单列表 -->
      <template v-for="p in state.playlists" :key="p.id">
        <div
          v-if="editingId !== p.id"
          class="sb-item"
          :class="{ on: p.id === state.activePlaylistId }"
          :title="p.name"
          @click="activate(p.id)"
        >
          <ListMusic :size="15" />
          <span class="sb-name">{{ p.name }}</span>
          <span class="sb-count">{{ (p.songPaths || []).length }}</span>
          <span class="sb-actions" @click.stop>
            <button class="sb-act" title="重命名" @click="startRename(p)">
              <Pencil :size="12" />
            </button>
            <button class="sb-act danger" title="删除歌单" @click="askDelete(p)">
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
            placeholder="歌单名称"
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
          placeholder="输入歌单名称，回车创建"
          @keydown.enter="commitCreate"
          @keydown.esc="creating = false"
          @blur="commitCreate"
        />
      </div>

      <div v-if="!state.playlists.length && !creating" class="sb-empty">还没有歌单</div>
    </div>

    <button class="sb-new" @click="startCreate">
      <Plus :size="14" />
      新建歌单
    </button>
  </aside>
</template>

<script setup>
import { ref, nextTick } from "vue";
import { Library, Music2, ListMusic, Plus, Pencil, Trash2 } from "@lucide/vue";
import { state, createPlaylist, renamePlaylist, deletePlaylist } from "../composables/usePlayer.js";

function activate(pid) {
  state.activePlaylistId = pid;
  state.playlistOpen = true; // 点击曲库条目时自动打开播放列表面板
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
    alert(e.message);
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
    alert(e.message);
  }
}

function cancelEdit() {
  editingId.value = null;
}

// ============ 删除 ============
function askDelete(p) {
  if (window.confirm(`删除歌单「${p.name}」？歌曲本身不会删除。`)) {
    deletePlaylist(p.id).catch((e) => alert(e.message));
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
