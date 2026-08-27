<script>
// 加歌浮层常量 + 位置计算纯函数（模块作用域：同时供 <script setup> 与外部命名导入使用）
export const ADD_MENU_WIDTH = 220; // 与 .add-menu width 一致
const ADD_MENU_GAP = 6; // 浮层与按钮间距
const ADD_MENU_EST_HEIGHT = 220; // 预估高度（标题 + 常见歌单数），渲染后用实际高度精修
const ADD_MENU_MARGIN = 8; // 视口边缘留白

// 纯函数：按钮 rect + 浮层高度 + 视口尺寸 → { top, left, flip }
// 右对齐按钮右缘（浮层宽 220 向左展开）：与旧视觉"右侧弹层"一致，且不盖住行内其他内容
export function computeAddMenuPos(
  btnRect,
  menuHeight,
  vw = window.innerWidth,
  vh = window.innerHeight,
) {
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
</script>

<script setup>
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { ListPlus, ListMusic, Check, Plus } from "@lucide/vue";
import {
  state,
  isInPlaylist,
  addToPlaylist,
  removeFromPlaylist,
} from "../composables/usePlayer.js";
import { toastError } from "../composables/useToast.js";

const { t } = useI18n();

// 加歌浮层：锚定触发按钮（getBoundingClientRect 动态定位，保留 Teleport 到 body 防裁剪）
const addMenuOpen = ref(false);
// 目标路径：单曲=[path]（切换收藏态）；批量=多 path（只加不删）
const addMenuPaths = ref([]);
const addMenuMode = ref("single"); // 'single' 切换 | 'batch' 只加
const addMenuEl = ref(null); // 浮层根元素（用于测量实际高度）
const addMenuAnchor = ref(null); // 触发按钮元素（resize/滚动时重取 rect）
const addMenuPos = ref({ top: 0, left: 0 });

function measureMenuHeight() {
  const h = addMenuEl.value ? addMenuEl.value.getBoundingClientRect().height : 0;
  return h > 0 ? h : ADD_MENU_EST_HEIGHT;
}

function applyAddMenuPos(rect) {
  addMenuPos.value = computeAddMenuPos(rect, measureMenuHeight());
}

// 统一入口：anchor 为带 getBoundingClientRect 的元素（行内按钮 / 右键菜单鼠标位置的假 rect）
function openForSingle(path, anchor) {
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

// 批量加歌单（多选批量条）：固定位置（右上角），只加不删
function openForBatch(paths) {
  addMenuMode.value = "batch";
  addMenuPaths.value = paths;
  addMenuPos.value = {
    top: ADD_MENU_MARGIN,
    left: Math.max(ADD_MENU_MARGIN, window.innerWidth - ADD_MENU_WIDTH - 340),
    flip: false,
  };
  addMenuOpen.value = true;
}

function close() {
  addMenuOpen.value = false;
}

function isOpen() {
  return addMenuOpen.value;
}

const addMenuStyle = computed(() => ({
  top: addMenuPos.value.top + "px",
  left: addMenuPos.value.left + "px",
}));

// resize/滚动重算（scroll 用捕获阶段，任意滚动容器都能触发；Esc 关闭由主组件统一协调）
function onViewportChange() {
  if (!addMenuOpen.value || !addMenuAnchor.value) return;
  applyAddMenuPos(addMenuAnchor.value.getBoundingClientRect());
}
onMounted(() => {
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onViewportChange);
  window.removeEventListener("scroll", onViewportChange, true);
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

defineExpose({ openForSingle, openForBatch, close, isOpen });
</script>

<template>
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
</template>

<style scoped>
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
