<template>
  <Teleport to="body">
    <div v-if="visible" class="ctx-backdrop" @mousedown="close"></div>
    <div v-if="visible" ref="menuEl" class="ctx-menu" :style="menuStyle">
      <button class="ctx-item" @click="emit('play')">
        <Play :size="14" />
        {{ t("playlist.ctx.play") }}
      </button>
      <button class="ctx-item" @click="emit('play-next')">
        <SkipForward :size="14" />
        {{ t("playlist.ctx.playNext") }}
      </button>
      <button class="ctx-item" @click="emit('toggle-fav')">
        <Heart :size="14" :fill="fav ? 'currentColor' : 'none'" :class="{ on: fav }" />
        {{ fav ? t("playlist.ctx.unfav") : t("playlist.ctx.fav") }}
      </button>
      <button class="ctx-item" @click="emit('add-playlist')">
        <ListPlus :size="14" />
        {{ t("playlist.ctx.addToPlaylist") }}
      </button>
      <template v-if="canGoArtist || canGoAlbum">
        <div class="ctx-sep"></div>
        <button v-if="canGoArtist" class="ctx-item" @click="emit('go-artist')">
          <Mic :size="14" />
          {{ t("playlist.ctx.goArtist") }}
        </button>
        <button v-if="canGoAlbum" class="ctx-item" @click="emit('go-album')">
          <Disc :size="14" />
          {{ t("playlist.ctx.goAlbum") }}
        </button>
      </template>
      <template v-if="hasPath">
        <div class="ctx-sep"></div>
        <button class="ctx-item" @click="emit('edit-tags')">
          <Tags :size="14" />
          {{ t("playlist.ctx.editTags") }}
        </button>
        <button class="ctx-item danger" @click="emit('delete')">
          <Trash2 :size="14" />
          {{ t("playlist.ctx.deleteToTrash") }}
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, computed, watch, nextTick, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Play, SkipForward, Heart, ListPlus, Mic, Disc, Tags, Trash2 } from "@lucide/vue";

const props = defineProps({
  visible: { type: Boolean, default: false },
  x: { type: Number, default: 0 },
  y: { type: Number, default: 0 },
  fav: { type: Boolean, default: false },
  canGoArtist: { type: Boolean, default: false },
  canGoAlbum: { type: Boolean, default: false },
  hasPath: { type: Boolean, default: false }, // 本地歌（path 非 null）才可移到废纸篓
});

const emit = defineEmits([
  "play",
  "play-next",
  "toggle-fav",
  "add-playlist",
  "go-artist",
  "go-album",
  "edit-tags",
  "delete",
  "close",
]);

const { t } = useI18n();

const MENU_WIDTH = 200; // 与 .ctx-menu width 一致
const MENU_MARGIN = 8; // 视口边缘留白

const menuEl = ref(null);
const pos = ref({ top: 0, left: 0 });

// 菜单位于鼠标位置，超出视口右/下边缘时 clamp（宽度固定，高度渲染后实测）
function applyPos() {
  const h = menuEl.value ? menuEl.value.getBoundingClientRect().height : 0;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  pos.value = {
    top: Math.max(MENU_MARGIN, Math.min(props.y, vh - h - MENU_MARGIN)),
    left: Math.max(MENU_MARGIN, Math.min(props.x, vw - MENU_WIDTH - MENU_MARGIN)),
  };
}

onMounted(() => nextTick(applyPos));
// 菜单已开时右键另一行 → x/y 变化，重新定位
watch([() => props.x, () => props.y], () => nextTick(applyPos));

const menuStyle = computed(() => ({
  top: pos.value.top + "px",
  left: pos.value.left + "px",
}));

function close() {
  emit("close");
}
</script>

<style scoped>
.ctx-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
}
.ctx-menu {
  position: fixed;
  z-index: 91;
  width: 200px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 12px 32px var(--shadow-strong);
  padding: 6px;
}
.ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  color: var(--text2);
  cursor: pointer;
  transition: background 0.12s;
  text-align: left;
}
@media (hover: hover) {
  .ctx-item:hover {
    background: var(--card2);
    color: var(--text);
  }
}
.ctx-item svg {
  flex-shrink: 0;
}
.ctx-item .on {
  color: var(--red);
}
.ctx-item.danger {
  color: var(--red);
}
@media (hover: hover) {
  .ctx-item.danger:hover {
    background: var(--red-soft);
    color: var(--red);
  }
}
.ctx-sep {
  height: 1px;
  background: var(--border);
  margin: 5px 8px;
}
</style>
