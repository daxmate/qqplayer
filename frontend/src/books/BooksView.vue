<template>
  <div class="books-view">
    <!-- 阅读器 ↔ 书架切换 -->
    <Reader v-if="activeBook" :key="activeBook.id" :book="activeBook" @close="onClose" />
    <Bookshelf v-else @open="onOpen" />
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import Bookshelf from "./Bookshelf.vue";
import Reader from "./Reader.vue";
import type { BookView } from "./types";

const activeBook = ref<BookView | null>(null);

function onOpen(book: BookView) {
  activeBook.value = book;
}

function onClose() {
  activeBook.value = null;
}
</script>

<style scoped>
.books-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
