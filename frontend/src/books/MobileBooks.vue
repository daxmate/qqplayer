<template>
  <div class="mb-page">
    <!-- 页头：返回 + 标题 -->
    <header class="mb-head">
      <button class="mb-back" :title="t('books.back')" @click="$emit('back')">
        <ChevronLeft :size="22" />
      </button>
      <h1 class="mb-title">{{ t("books.title") }}</h1>
      <span class="mb-head-spacer" />
    </header>

    <!-- 书架（复用 Bookshelf） -->
    <div class="mb-body">
      <Bookshelf @open="activeBook = $event" />
    </div>

    <!-- 全屏阅读（覆盖迷你播放条） -->
    <div v-if="activeBook" class="mb-reader-overlay">
      <Reader :key="activeBook.id" :book="activeBook" @close="activeBook = null" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronLeft } from "@lucide/vue";
import Bookshelf from "./Bookshelf.vue";
import Reader from "./Reader.vue";
import type { BookView } from "./types";

defineEmits<{ back: [] }>();
const { t } = useI18n();

const activeBook = ref<BookView | null>(null);
</script>

<style scoped>
.mb-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.mb-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 4px;
  padding-top: calc(12px + env(safe-area-inset-top));
}
.mb-back {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card);
  border: 1px solid var(--border);
  transition: all 0.15s;
  touch-action: manipulation;
  flex-shrink: 0;
}
.mb-back:active {
  background: var(--card2);
  color: var(--text);
  transform: scale(0.92);
}
.mb-title {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.mb-head-spacer {
  width: 38px;
  flex-shrink: 0;
}
.mb-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px 14px 14px;
}
/* 全屏阅读层：盖过页面栈与迷你播放条 */
.mb-reader-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--bg);
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
    env(safe-area-inset-left);
}
</style>
