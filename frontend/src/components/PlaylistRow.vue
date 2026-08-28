<template>
  <div
    class="pl-item"
    :class="{ active, selected }"
    :data-path="song.path"
    @click="emit('click', vi, $event)"
    @contextmenu.prevent="emit('contextmenu', $event, vi)"
  >
    <span
      v-if="canDragOut"
      class="pl-drag"
      :title="canReorder ? t('playlist.dragSort') : t('playlist.dragOut')"
      draggable="true"
      @dragstart="emit('dragstart', $event, song.path)"
    >
      <GripVertical :size="14" />
    </span>
    <span v-if="coverVisible('list')" class="pl-cover">
      <img
        v-if="coverSrc(song.path!) && coverOk(song.path!)"
        :src="coverSrc(song.path!)"
        :alt="song.name"
        loading="lazy"
        @error="markCoverError(song.path!)"
      />
    </span>
    <span class="pl-idx">{{ vi + 1 }}</span>
    <div class="pl-info">
      <div class="pl-name">
        {{ song.name }}
        <span v-if="isFavorite(song.path!)" class="pl-fav-mark" :title="t('playlist.fav.faved')">
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
      v-if="active"
      class="pl-eq"
      :title="t('playlist.locate.title')"
      @click.stop="emit('locate')"
    >
      <span class="eq-bar"></span>
      <span class="eq-bar"></span>
      <span class="eq-bar"></span>
    </span>
    <!-- 行尾操作按钮：绝对定位不占布局空间（文字区参照自动歌单占满整行），hover 显示 -->
    <div class="pl-actions">
      <button
        class="pl-action heart"
        :class="{ on: isFavorite(song.path!) }"
        :title="isFavorite(song.path!) ? t('playlist.fav.remove') : t('playlist.fav.add')"
        @click.stop="emit('favorite', song.path)"
      >
        <Heart :size="14" :fill="isFavorite(song.path!) ? 'currentColor' : 'none'" />
      </button>
      <button
        class="pl-action"
        :title="t('playlist.addMenu.title')"
        @click.stop="emit('add-menu', $event, song.path)"
      >
        <ListPlus :size="14" />
      </button>
      <button
        v-if="isStreamSong(song)"
        class="pl-action dl"
        :class="{ busy: downloading[song.streamId!] }"
        :title="downloading[song.streamId!] ? t('playlist.downloading') : t('playlist.download')"
        @click.stop="emit('download', song)"
      >
        <Loader2 v-if="downloading[song.streamId!]" :size="14" class="pl-spin" />
        <Download v-else :size="14" />
      </button>
      <button
        class="pl-action remove"
        :title="inPlaylistView ? t('playlist.removeFromPlaylist') : t('playlist.removeFromQueue')"
        @click.stop="emit('remove', vi)"
      >
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import type { PropType } from "vue";
import { GripVertical, Heart, Mic, ListPlus, Loader2, Download, X } from "@lucide/vue";
import { isFavorite, isStreamSong } from "../composables/usePlayer.js";
import { coverVisible } from "../composables/useCoverGuard.ts";
import type { Song } from "../composables/playerState.js";

defineProps({
  song: { type: Object as PropType<Song>, required: true },
  vi: { type: Number, required: true },
  active: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  canDragOut: { type: Boolean, default: true },
  canReorder: { type: Boolean, default: false },
  // 下载中状态表（streamId → true，主组件维护）：驱动下载按钮 busy/旋转
  downloading: { type: Object, default: () => ({}) },
  inPlaylistView: { type: Boolean, default: false },
  // 封面解析函数（主组件 useCoverURL 实例传入：urlMap 每实例一份，解析与读取必须同源）
  coverSrc: { type: Function, required: true },
  coverOk: { type: Function, required: true },
  markCoverError: { type: Function, required: true },
});

const emit = defineEmits([
  "click",
  "contextmenu",
  "dragstart",
  "favorite",
  "add-menu",
  "download",
  "remove",
  "locate",
]);

const { t } = useI18n();

function fmtDur(d: number) {
  const m = Math.floor(d / 60);
  const s = Math.floor(d % 60);
  return m + ":" + String(s).padStart(2, "0");
}
</script>

<style scoped>
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
  /* 行尾操作按钮区宽：最多 4 钮（收藏/加歌单/下载/移除）×26 + 3 gap×10 + 右缘 10 */
  --pl-actions-w: 144px;
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  /* 预留按钮区：非 hover 时文字占满行内剩余宽度（参照自动歌单），hover 按钮浮出不重叠 */
  padding-right: var(--pl-actions-w);
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
/* 行操作按钮容器：绝对定位在行尾右缘，不占布局空间（hover 显示时文字区右侧已预留 padding，不重叠） */
.pl-actions {
  position: absolute;
  right: 10px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  gap: 10px;
  z-index: 2;
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
@keyframes pl-dl-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
