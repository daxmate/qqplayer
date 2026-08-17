<template>
  <Transition name="sel-toolbar-pop">
    <div
      v-if="visible"
      class="sel-toolbar"
      :class="{ flip: flip }"
      :style="{ left: x + 'px', top: (flip ? y + 14 : y - 10) + 'px' }"
      @mousedown.stop
      @mouseup.stop
    >
      <div class="sel-toolbar-row">
        <button class="sel-toolbar-btn" :title="t('books.lookup')" @click="emit('lookup', text)">
          <BookOpen :size="15" />
          <span>{{ t("books.lookup") }}</span>
        </button>
        <button
          class="sel-toolbar-btn"
          :class="{ on: colorOpen }"
          :title="t('books.highlightColors')"
          @click="colorOpen = !colorOpen"
        >
          <Highlighter :size="15" />
          <span>{{ t("books.highlight") }}</span>
        </button>
        <button class="sel-toolbar-btn" :title="t('books.note')" @click="emit('note', text)">
          <StickyNote :size="15" />
          <span>{{ t("books.note") }}</span>
        </button>
      </div>
      <div v-if="colorOpen" class="sel-toolbar-colors">
        <button
          v-for="c in COLOR_ORDER"
          :key="c"
          class="sel-toolbar-dot"
          :style="{ background: HIGHLIGHT_COLOR_HEX[c] }"
          :title="t(COLOR_LABELS[c])"
          @click="emit('highlight', text, c)"
        />
      </div>
    </div>
  </Transition>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { BookOpen, Highlighter, StickyNote } from "@lucide/vue";
import type { HighlightColor } from "./types";
import { HIGHLIGHT_COLOR_HEX } from "./annotations";

const props = defineProps<{ x: number; y: number; visible: boolean; text: string }>();
const emit = defineEmits<{
  lookup: [text: string];
  highlight: [text: string, color: HighlightColor];
  note: [text: string];
}>();

const { t } = useI18n();

const COLOR_ORDER: HighlightColor[] = ["yellow", "green", "blue", "pink"];
const COLOR_LABELS: Record<HighlightColor, string> = {
  yellow: "books.highlightColorYellow",
  green: "books.highlightColorGreen",
  blue: "books.highlightColorBlue",
  pink: "books.highlightColorPink",
};
const colorOpen = ref(false);

// 位置：默认在选区上方；y 太靠上（<64px）则翻到选区下方
const flip = computed(() => props.y < 64);
</script>

<style scoped>
.sel-toolbar {
  position: absolute;
  z-index: 10;
  transform: translate(-50%, -100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 10px;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: 0 6px 20px var(--shadow-strong);
  pointer-events: auto;
}
.sel-toolbar.flip {
  transform: translate(-50%, 0);
}
.sel-toolbar-row {
  display: flex;
  align-items: center;
  gap: 2px;
}
.sel-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  white-space: nowrap;
  transition: all 0.12s;
}
.sel-toolbar-btn:hover,
.sel-toolbar-btn.on {
  background: var(--card2);
  color: var(--accent-text);
}
.sel-toolbar-colors {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 6px;
}
.sel-toolbar-dot {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid var(--card);
  box-shadow: 0 0 0 1px var(--border);
  transition: transform 0.12s;
}
.sel-toolbar-dot:hover {
  transform: scale(1.2);
}
.sel-toolbar-pop-enter-active,
.sel-toolbar-pop-leave-active {
  transition:
    opacity 0.12s,
    transform 0.12s;
}
.sel-toolbar-pop-enter-from,
.sel-toolbar-pop-leave-to {
  opacity: 0;
  transform: translate(-50%, -100%) scale(0.95);
}
.sel-toolbar.flip.sel-toolbar-pop-enter-from,
.sel-toolbar.flip.sel-toolbar-pop-leave-to {
  transform: translate(-50%, 0) scale(0.95);
}
</style>
