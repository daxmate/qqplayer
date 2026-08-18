<template>
  <!-- iBooks 式选中工具栏：顶行五色点 + U 下划线（常驻），下方功能列表（slot 内容） -->
  <HighlightMenu
    :x="x"
    :y="y"
    :visible="visible"
    :color="null"
    :underline-active="false"
    @color="(c) => emit('highlight', text, c)"
    @underline="() => emit('highlight', text, UNDERLINE_EMIT_COLOR, 'underline')"
  >
    <button class="hl-menu-action" :title="t('books.note')" @click="emit('note', text)">
      <StickyNote :size="14" />
      <span>{{ t("books.note") }}</span>
    </button>
    <!-- 移除：仅当选中 cfi 已有高亮时显示（Reader 计算 hasHighlight 传入） -->
    <button
      v-if="hasHighlight"
      class="hl-menu-action danger"
      :title="t('books.removeHighlight')"
      @click="emit('remove')"
    >
      <Trash2 :size="14" />
      <span>{{ t("books.removeHighlight") }}</span>
    </button>
    <!-- 查询「词」：仅当选中是单词（无空白字符且 ≤40 字符）时显示，文案带选中词 -->
    <button
      v-if="isWord"
      class="hl-menu-action"
      :title="t('books.lookup')"
      @click="emit('lookup', text)"
    >
      <BookOpen :size="14" />
      <span>{{ t("books.lookupWord", { word: wordDisplay }) }}</span>
    </button>
    <button class="hl-menu-action" :title="t('books.search')" @click="emit('search', text)">
      <Search :size="14" />
      <span>{{ t("books.search") }}</span>
    </button>
    <button class="hl-menu-action" :title="t('books.copy')" @click="onCopy">
      <Copy :size="14" />
      <span>{{ t("books.copy") }}</span>
    </button>
  </HighlightMenu>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { BookOpen, Copy, Search, StickyNote, Trash2 } from "@lucide/vue";
import type { HighlightColor, HighlightStyle } from "./types";
import { showToast, toastError } from "../composables/useToast.js";
import HighlightMenu from "./HighlightMenu.vue";

const props = defineProps<{
  x: number;
  y: number;
  visible: boolean;
  text: string;
  /** 选中 cfi 是否已有高亮（Reader 计算传入，控制"移除"项显示） */
  hasHighlight: boolean;
}>();
const emit = defineEmits<{
  lookup: [text: string];
  highlight: [text: string, color: HighlightColor, style?: HighlightStyle];
  note: [text: string];
  search: [text: string];
  remove: [];
}>();

const { t } = useI18n();

/** U 按钮 emit 的占位色（Reader 对 style=underline 一律按红色落库渲染，忽略该值） */
const UNDERLINE_EMIT_COLOR: HighlightColor = "yellow";
const WORD_MAX_LEN = 40;
const WORD_DISPLAY_MAX = 24;

/** 查询「词」仅单词显示：无空白字符且长度 ≤ 40（过长不是词，交给搜索） */
const isWord = computed(
  () => props.text.length > 0 && !/\s/.test(props.text) && props.text.length <= WORD_MAX_LEN,
);
/** 文案里的选中词，过长截断显示 */
const wordDisplay = computed(() =>
  props.text.length > WORD_DISPLAY_MAX ? `${props.text.slice(0, WORD_DISPLAY_MAX)}…` : props.text,
);

/** 拷贝：组件内直接写剪贴板 + toast，不 emit（Reader 无动作）；失败降级 execCommand */
function onCopy() {
  const text = props.text;
  const done = () => showToast(t("books.copyDone"));
  if (navigator.clipboard?.writeText) {
    navigator.clipboard
      .writeText(text)
      .then(done)
      .catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

function fallbackCopy(text: string, done: () => void) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    if (ok) done();
    else toastError(t("books.copyFailed"));
  } catch {
    toastError(t("books.copyFailed"));
  }
}
</script>
