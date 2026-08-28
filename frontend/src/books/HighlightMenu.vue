<template>
  <Transition name="hl-menu-pop">
    <div
      v-if="visible"
      class="hl-menu"
      :class="{ flip }"
      :style="{ left: x + 'px', top: (flip ? y + 14 : y - 10) + 'px' }"
      @mousedown.stop
      @mouseup.stop
    >
      <!-- 顶行：五色点 + U 下划线（iBooks 式，常驻） -->
      <div class="hl-menu-colors">
        <button
          v-for="c in COLOR_ORDER"
          :key="c"
          class="hl-menu-dot"
          :class="{ on: color === c }"
          :style="{ background: HIGHLIGHT_COLOR_HEX[c] }"
          :title="t(COLOR_LABELS[c])"
          @click="emit('color', c)"
        />
        <button
          class="hl-menu-underline"
          :class="{ on: underlineActive }"
          :title="t('books.underline')"
          @click="emit('underline')"
        >
          <Underline :size="15" />
        </button>
      </div>
      <div class="hl-menu-divider" />
      <!-- 功能列表（slot 由调用方填充：选中工具栏 5 项 / 点击高亮菜单 2 项，见 Reader.vue） -->
      <div class="hl-menu-actions">
        <slot />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Underline } from "@lucide/vue";
import type { HighlightColor } from "./types";
import { HIGHLIGHT_COLOR_HEX } from "./annotations";

const props = defineProps<{
  x: number;
  y: number;
  visible: boolean;
  /** 当前激活色点（点击高亮菜单用；选中工具栏传 null）；"red" 为下划线条目色 */
  color: HighlightColor | "red" | null;
  /** U 下划线 active（当前条目 style 是 underline 时） */
  underlineActive: boolean;
}>();
const emit = defineEmits<{
  color: [color: HighlightColor];
  underline: [];
}>();

const { t } = useI18n();

const COLOR_ORDER: HighlightColor[] = ["yellow", "green", "blue", "pink", "purple"];
const COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "books.highlightColorYellow",
  green: "books.highlightColorGreen",
  blue: "books.highlightColorBlue",
  pink: "books.highlightColorPink",
  purple: "books.highlightColorPurple",
};

// 位置：默认在选区/高亮上方；y 太靠上（<64px）则翻到下方（与旧 SelectionToolbar 一致）
const flip = computed(() => props.y < 64);
</script>

<style scoped>
.hl-menu {
  position: absolute;
  z-index: 10;
  transform: translate(-50%, -100%);
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 148px;
  padding: 6px;
  border-radius: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: 0 6px 20px var(--shadow-strong);
  pointer-events: auto;
}
.hl-menu.flip {
  transform: translate(-50%, 0);
}
.hl-menu-colors {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 2px 6px 4px;
}
.hl-menu-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--card);
  box-shadow: 0 0 0 1px var(--border);
  transition: transform 0.12s;
}
.hl-menu-dot:hover {
  transform: scale(1.2);
}
.hl-menu-dot.on {
  box-shadow: 0 0 0 2px var(--accent);
}
.hl-menu-underline {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  margin-left: 2px;
  color: var(--text2);
  transition: all 0.12s;
}
.hl-menu-underline:hover,
.hl-menu-underline.on {
  background: var(--card2);
  color: var(--accent-text);
}
.hl-menu-divider {
  height: 1px;
  margin: 2px 4px;
  background: var(--border);
}
.hl-menu-pop-enter-active,
.hl-menu-pop-leave-active {
  transition:
    opacity 0.12s,
    transform 0.12s;
}
.hl-menu-pop-enter-from,
.hl-menu-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -100%) scale(0.95);
}
.hl-menu.flip.hl-menu-pop-enter-from,
.hl-menu.flip.hl-menu-pop-leave-to {
  transform: translate(-50%, 0) scale(0.95);
}
</style>

<style>
/* 功能列表：slot 内容由父组件（SelectionToolbar/Reader）定义，scoped 规则够不到 slot 内容，
   故用全局类名（hl-menu- 前缀防冲突），两个菜单共用同一套视觉 */
.hl-menu-actions {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 0;
}
.hl-menu-action {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  white-space: nowrap;
  text-align: left;
  transition: all 0.12s;
}
.hl-menu-action:hover {
  background: var(--card2);
  color: var(--text);
}
.hl-menu-action.danger:hover {
  color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}
.hl-menu-action span {
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
