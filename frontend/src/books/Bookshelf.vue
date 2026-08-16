<template>
  <div
    class="bookshelf"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <!-- 工具栏：导入入口 -->
    <div class="bs-toolbar">
      <h2 class="bs-title">{{ t("books.title") }}</h2>
      <button class="bs-import-btn" :disabled="importing" @click="openFilePicker">
        <Loader2 v-if="importing" :size="15" class="bs-spin" />
        <Upload v-else :size="15" />
        {{ importing ? t("books.importing") : t("books.import") }}
      </button>
    </div>

    <!-- 书架网格 -->
    <div v-if="books.length" class="bs-grid" :class="{ dragging }">
      <button
        v-for="book in books"
        :key="book.id"
        class="bs-card"
        :title="book.title"
        @click="emit('open', book)"
      >
        <span class="bs-cover">
          <img
            v-if="book.coverUrl && !failedCovers.has(book.id)"
            :src="book.coverUrl"
            :alt="book.title"
            loading="lazy"
            @error="onCoverError(book)"
          />
          <BookOpen v-else :size="30" class="bs-cover-fallback" />
        </span>
        <span class="bs-meta">
          <span class="bs-name">{{ book.title }}</span>
          <span class="bs-author">{{ book.author || t("books.unknownAuthor") }}</span>
        </span>
        <span v-if="book.progress" class="bs-progress">
          <span class="bs-progress-bar">
            <span class="bs-progress-fill" :style="{ width: progressPercent(book) + '%' }" />
          </span>
          <span class="bs-progress-text">
            {{ t("books.reading") }} {{ progressPercent(book) }}%
          </span>
        </span>
        <span class="bs-del" :title="t('books.delete')" @click.stop="pendingDelete = book">
          <Trash2 :size="14" />
        </span>
      </button>
    </div>

    <!-- 删除确认 -->
    <div v-if="pendingDelete" class="bs-confirm-mask" @click.self="pendingDelete = null">
      <div class="bs-confirm">
        <p class="bs-confirm-text">
          {{ t("books.deleteConfirm", { title: pendingDelete.title }) }}
        </p>
        <div class="bs-confirm-actions">
          <button class="bs-confirm-cancel" @click="pendingDelete = null">
            {{ t("books.back") }}
          </button>
          <button class="bs-confirm-ok" @click="onDelete(pendingDelete)">
            {{ t("books.delete") }}
          </button>
        </div>
      </div>
    </div>

    <!-- 空态引导 -->
    <div v-else class="bs-empty">
      <BookOpen :size="46" class="bs-empty-icon" />
      <p class="bs-empty-title">{{ t("books.empty") }}</p>
      <p class="bs-empty-hint">{{ t("books.emptyHint") }}</p>
      <button class="bs-import-btn" :disabled="importing" @click="openFilePicker">
        <Loader2 v-if="importing" :size="15" class="bs-spin" />
        <Upload v-else :size="15" />
        {{ importing ? t("books.importing") : t("books.import") }}
      </button>
    </div>

    <!-- 拖拽中高亮遮罩提示 -->
    <div v-if="dragging" class="bs-drop-hint">
      <Upload :size="40" />
      <span>{{ t("books.import") }}</span>
    </div>

    <!-- 隐藏文件选择 -->
    <input
      ref="fileInput"
      class="bs-file-input"
      type="file"
      accept=".epub,application/epub+zip"
      multiple
      @change="onFilePicked"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { BookOpen, Trash2, Upload, Loader2 } from "@lucide/vue";
import type { BookView } from "./types";
import { fetchBooks, importBook, deleteBook } from "./api";
import { showToast, toastError } from "../composables/useToast.js";

const emit = defineEmits<{ open: [book: BookView] }>();
const { t } = useI18n();

const books = ref<BookView[]>([]);
const importing = ref(false);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
// 待删除的书（确认弹窗）；null = 未在确认中
const pendingDelete = ref<BookView | null>(null);
// 封面加载失败的书籍 id（内存态，避免重复请求）
const failedCovers = new Set<string>();

function progressPercent(book: BookView): number {
  const loc = book.progress?.location;
  if (typeof loc !== "number" || !Number.isFinite(loc)) return 0;
  return Math.max(0, Math.min(100, Math.round(loc * 100)));
}

async function load() {
  try {
    books.value = await fetchBooks();
  } catch {
    toastError(t("books.loadError"));
  }
}

function openFilePicker() {
  fileInput.value?.click();
}

function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])].filter((f) => /\.epub$/i.test(f.name));
  input.value = ""; // 允许重复选择同一文件
  if (files.length) void doImport(files);
  else if ((input.files?.length ?? 0) > 0) toastError(t("books.importInvalid"));
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.epub$/i.test(f.name));
  if (files.length) void doImport(files);
  else if ((e.dataTransfer?.files?.length ?? 0) > 0) toastError(t("books.importInvalid"));
}

async function doImport(files: File[]) {
  importing.value = true;
  try {
    for (const file of files) {
      try {
        const result = await importBook(file);
        showToast(t("books.importDone", { title: result.title }));
      } catch {
        toastError(t("books.importInvalid"));
      }
    }
    await load();
  } finally {
    importing.value = false;
  }
}

function onDelete(book: BookView) {
  pendingDelete.value = null;
  deleteBook(book.id)
    .then(() => {
      showToast(t("books.deleteDone", { title: book.title }));
      return load();
    })
    .catch(() => toastError(t("books.loadError")));
}

function onCoverError(book: BookView) {
  // 封面加载失败 → 退回图标占位（记录到内存，避免重复请求）
  failedCovers.add(book.id);
}

function onDragOver() {
  dragging.value = true;
}

function onDragLeave(e: DragEvent) {
  // dragleave 在子元素间也会触发：仅当离开整个区域时收起
  const related = e.relatedTarget as Node | null;
  const self = e.currentTarget as HTMLElement;
  if (!related || !self.contains(related)) dragging.value = false;
}

onMounted(load);
</script>

<style scoped>
.bookshelf {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.bs-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 4px 2px 12px;
}
.bs-title {
  font-size: 16px;
  font-weight: 700;
}
.bs-import-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
  flex-shrink: 0;
}
.bs-import-btn:hover {
  filter: brightness(1.08);
}
.bs-import-btn:disabled {
  opacity: 0.65;
  cursor: default;
}
.bs-spin {
  animation: bs-spin 1.1s linear infinite;
}
@keyframes bs-spin {
  to {
    transform: rotate(360deg);
  }
}
.bs-grid {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 14px;
  align-content: start;
  padding: 2px;
}
.bs-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.15s;
  overflow: hidden;
}
.bs-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, var(--border));
  transform: translateY(-2px);
  box-shadow: 0 6px 16px var(--shadow-sm);
}
.bs-cover {
  position: relative;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 9px;
  background: var(--bg2);
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.bs-cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.bs-cover-fallback {
  color: var(--text3);
  opacity: 0.65;
}
.bs-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.bs-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bs-author {
  font-size: 12px;
  color: var(--text3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bs-progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bs-progress-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--bg2);
  overflow: hidden;
}
.bs-progress-fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  transition: width 0.3s;
}
.bs-progress-text {
  font-size: 11px;
  color: var(--accent-text);
}
.bs-del {
  position: absolute;
  top: 14px;
  right: 14px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  color: var(--text3);
  opacity: 0;
  transition: all 0.15s;
  backdrop-filter: blur(4px);
}
.bs-card:hover .bs-del {
  opacity: 1;
}
.bs-del:hover {
  color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 14%, transparent);
}
.bs-empty {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--text3);
}
.bs-empty-icon {
  opacity: 0.55;
}
.bs-empty-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text2);
}
.bs-empty-hint {
  font-size: 12.5px;
  margin-bottom: 8px;
}
/* 删除确认弹窗 */
.bs-confirm-mask {
  position: absolute;
  inset: 0;
  z-index: 7;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.bs-confirm {
  width: min(300px, 84%);
  padding: 18px 20px;
  border-radius: 14px;
  background: var(--card);
  border: 1px solid var(--border);
  box-shadow: 0 12px 32px var(--shadow-strong);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.bs-confirm-text {
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
  word-break: break-all;
}
.bs-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.bs-confirm-cancel {
  padding: 7px 14px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text2);
  font-size: 13px;
  font-weight: 600;
}
.bs-confirm-cancel:hover {
  color: var(--text);
  background: var(--card2);
}
.bs-confirm-ok {
  padding: 7px 14px;
  border-radius: 9px;
  border: none;
  background: #ff6b6b;
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.bs-confirm-ok:hover {
  filter: brightness(1.08);
}
.bs-drop-hint {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: color-mix(in srgb, var(--bg) 80%, transparent);
  border: 3px dashed var(--accent);
  border-radius: 16px;
  color: var(--accent-text);
  font-size: 16px;
  font-weight: 700;
  pointer-events: none;
}
.bs-file-input {
  display: none;
}
</style>
