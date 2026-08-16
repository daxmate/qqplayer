<template>
  <div class="books-view">
    <!-- 阅读器 ↔ 书架切换 -->
    <Reader v-if="activeBook" :key="activeBook.id" :book="activeBook" @close="onClose" />
    <Bookshelf v-else @open="onOpen" />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import Bookshelf from "./Bookshelf.vue";
import Reader from "./Reader.vue";
import { fetchBooks, getLastReadBookId, setLastReadBookId } from "./api";
import type { BookView } from "./types";

const activeBook = ref<BookView | null>(null);

function onOpen(book: BookView) {
  activeBook.value = book;
  // 记住上次读的书（统一 Settings 层，重进阅读模式自动恢复）
  setLastReadBookId(book.id);
}

function onClose() {
  activeBook.value = null;
}

// 重进阅读模式：自动打开上次读的书（进度恢复由 Reader 按 book.progress.cfi 定位）
onMounted(async () => {
  try {
    const [books, lastReadId] = await Promise.all([fetchBooks(), getLastReadBookId()]);
    if (lastReadId) {
      const last = books.find((b) => b.id === lastReadId);
      if (last) activeBook.value = last;
    }
  } catch {
    /* 拉取失败留在书架，不阻塞阅读 */
  }
});
</script>

<style scoped>
.books-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
