<template>
  <!-- 标注侧栏（右侧滑出抽屉；遮罩/过渡在 Reader.vue，与设置抽屉同模式） -->
  <aside class="anno-panel">
    <header class="anno-panel-head">
      <h3 class="anno-panel-title">{{ t("books.annotations") }}</h3>
      <button class="anno-panel-close" :title="t('books.close')" @click="emit('close')">
        <X :size="18" />
      </button>
    </header>

    <!-- tab：标注 / 生词本 -->
    <div class="anno-panel-tabs">
      <button class="anno-panel-tab" :class="{ on: tab === 'anno' }" @click="tab = 'anno'">
        <Highlighter :size="14" />
        {{ t("books.tabAnno") }}
      </button>
      <button class="anno-panel-tab" :class="{ on: tab === 'vocab' }" @click="tab = 'vocab'">
        <BookPlus :size="14" />
        {{ t("books.tabVocab") }}
        <span v-if="vocab.length" class="anno-panel-count">{{ vocab.length }}</span>
      </button>
    </div>

    <!-- 标注 tab -->
    <div v-if="tab === 'anno'" class="anno-panel-scroll">
      <template v-if="hasAnnotations">
        <!-- 高亮 -->
        <section v-if="annotations.highlights.length" class="anno-panel-group">
          <p class="anno-panel-group-title">
            <Highlighter :size="13" />
            {{ t("books.highlight") }}
            <span class="anno-panel-group-count">{{ annotations.highlights.length }}</span>
          </p>
          <div
            v-for="h in annotations.highlights"
            :key="h.id"
            class="anno-panel-item"
            :title="h.text"
          >
            <span
              v-if="h.style === 'underline'"
              class="anno-panel-dot ul"
              :title="t('books.underline')"
            >
              <Underline :size="11" />
            </span>
            <span
              v-else
              class="anno-panel-dot"
              :style="{ background: HIGHLIGHT_COLOR_HEX[h.color] ?? '#e5484d' }"
            />
            <span class="anno-panel-text">{{ h.text }}</span>
            <button class="anno-panel-action" :title="t('books.jump')" @click="emit('jump', h.cfi)">
              <CornerDownRight :size="14" />
            </button>
            <button
              class="anno-panel-action danger"
              :title="t('books.delete')"
              @click="emit('delete-highlight', h.id)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </section>

        <!-- 书签 -->
        <section v-if="annotations.bookmarks.length" class="anno-panel-group">
          <p class="anno-panel-group-title">
            <Bookmark :size="13" />
            {{ t("books.bookmark") }}
            <span class="anno-panel-group-count">{{ annotations.bookmarks.length }}</span>
          </p>
          <div
            v-for="m in annotations.bookmarks"
            :key="m.id"
            class="anno-panel-item"
            :title="m.text"
          >
            <Bookmark :size="14" class="anno-panel-type-icon" />
            <span class="anno-panel-text">{{ m.text }}</span>
            <button class="anno-panel-action" :title="t('books.jump')" @click="emit('jump', m.cfi)">
              <CornerDownRight :size="14" />
            </button>
            <button
              class="anno-panel-action danger"
              :title="t('books.delete')"
              @click="emit('delete-bookmark', m.id)"
            >
              <Trash2 :size="14" />
            </button>
          </div>
        </section>

        <!-- 笔记 -->
        <section v-if="annotations.notes.length" class="anno-panel-group">
          <p class="anno-panel-group-title">
            <StickyNote :size="13" />
            {{ t("books.note") }}
            <span class="anno-panel-group-count">{{ annotations.notes.length }}</span>
          </p>
          <div v-for="n in annotations.notes" :key="n.id" class="anno-panel-note">
            <p v-if="n.excerpt" class="anno-panel-note-excerpt">{{ n.excerpt }}</p>
            <p v-if="n.text" class="anno-panel-note-text">{{ n.text }}</p>
            <div class="anno-panel-note-actions">
              <button
                class="anno-panel-action"
                :title="t('books.jump')"
                @click="emit('jump', n.cfi)"
              >
                <CornerDownRight :size="14" />
              </button>
              <button
                class="anno-panel-action"
                :title="t('books.noteEdit')"
                @click="emit('edit-note', n)"
              >
                <Pencil :size="14" />
              </button>
              <button
                class="anno-panel-action danger"
                :title="t('books.delete')"
                @click="emit('delete-note', n.id)"
              >
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </section>
      </template>
      <p v-else class="anno-panel-empty">
        {{ t("books.annotationsEmpty") }}
      </p>
    </div>

    <!-- 生词本 tab -->
    <div v-else class="anno-panel-scroll">
      <div class="anno-panel-vocab-tools">
        <button class="anno-panel-export" :title="t('books.vocabExportHint')" @click="exportVocab">
          <Download :size="14" />
          {{ t("books.vocabExport") }}
        </button>
      </div>
      <template v-if="vocab.length">
        <div v-for="v in vocab" :key="v.id" class="anno-panel-item vocab">
          <span class="anno-panel-vocab-word">{{ v.word }}</span>
          <span class="anno-panel-vocab-meta">
            <span v-if="v.bookTitle" class="anno-panel-vocab-book">{{ v.bookTitle }}</span>
            <span v-if="v.context" class="anno-panel-vocab-context">{{ v.context }}</span>
          </span>
          <button
            class="anno-panel-action danger"
            :title="t('books.delete')"
            @click="emit('delete-vocab', v.id)"
          >
            <Trash2 :size="14" />
          </button>
        </div>
      </template>
      <p v-else class="anno-panel-empty">{{ t("books.vocabEmpty") }}</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Bookmark,
  BookPlus,
  CornerDownRight,
  Download,
  Highlighter,
  Pencil,
  StickyNote,
  Trash2,
  Underline,
  X,
} from "@lucide/vue";
import type { BookAnnotations, NoteAnnotation, VocabEntry } from "./types";
import { HIGHLIGHT_COLOR_HEX, VOCAB_EXPORT_URL } from "./annotations";

const props = defineProps<{
  annotations: BookAnnotations;
  vocab: VocabEntry[];
}>();
const emit = defineEmits<{
  close: [];
  jump: [cfi: string];
  "delete-highlight": [id: string];
  "delete-bookmark": [id: string];
  "delete-note": [id: string];
  "edit-note": [note: NoteAnnotation];
  "delete-vocab": [id: string];
}>();

const { t } = useI18n();

const tab = ref<"anno" | "vocab">("anno");

const hasAnnotations = computed(
  () =>
    props.annotations.highlights.length > 0 ||
    props.annotations.bookmarks.length > 0 ||
    props.annotations.notes.length > 0,
);

/** 导出 txt：a[download] 触发（window.open 在部分环境被拦，anchor 更稳） */
function exportVocab() {
  const a = document.createElement("a");
  a.href = VOCAB_EXPORT_URL;
  a.download = "vocab.txt";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
</script>

<style scoped>
.anno-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  width: min(320px, 88%);
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}
.anno-panel-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--border);
}
.anno-panel-title {
  font-size: 15px;
  font-weight: 700;
}
.anno-panel-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--text3);
  transition: all 0.12s;
}
.anno-panel-close:hover {
  background: var(--card2);
  color: var(--text);
}
.anno-panel-tabs {
  flex-shrink: 0;
  display: flex;
  gap: 4px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
.anno-panel-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  justify-content: center;
  padding: 7px 0;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.12s;
}
.anno-panel-tab:hover {
  background: var(--card2);
  color: var(--text);
}
.anno-panel-tab.on {
  background: var(--accent-soft);
  color: var(--accent-text);
}
.anno-panel-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--accent);
  color: #fff;
  font-size: 10.5px;
  line-height: 16px;
  text-align: center;
}
.anno-panel-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 12px 18px;
}
.anno-panel-group {
  margin-bottom: 14px;
}
.anno-panel-group-title {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text2);
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
.anno-panel-group-count {
  font-weight: 600;
  color: var(--text3);
}
.anno-panel-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  margin-bottom: 4px;
  border-radius: 9px;
  background: var(--card2);
  transition: background 0.12s;
}
.anno-panel-item:hover {
  background: color-mix(in srgb, var(--card2) 60%, var(--accent-soft));
}
.anno-panel-dot {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  box-shadow: 0 0 0 1px var(--border);
}
/* 下划线条目：色点换下划线图标（红色，与渲染色一致） */
.anno-panel-dot.ul {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 14px;
  background: transparent;
  box-shadow: none;
  color: #e5484d;
}
.anno-panel-type-icon {
  flex-shrink: 0;
  color: var(--accent-text);
}
.anno-panel-text {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: var(--text2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.anno-panel-action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--text3);
  transition: all 0.12s;
}
.anno-panel-action:hover {
  background: var(--card);
  color: var(--text);
}
.anno-panel-action.danger:hover {
  color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 12%, transparent);
}
.anno-panel-note {
  padding: 8px 10px;
  margin-bottom: 4px;
  border-radius: 9px;
  background: var(--card2);
}
.anno-panel-note-excerpt {
  font-size: 12px;
  color: var(--text3);
  line-height: 1.45;
  margin-bottom: 4px;
  padding-left: 8px;
  border-left: 2px solid var(--accent);
  max-height: 60px;
  overflow: hidden;
  word-break: break-word;
}
.anno-panel-note-text {
  font-size: 12.5px;
  color: var(--text2);
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}
.anno-panel-note-actions {
  display: flex;
  justify-content: flex-end;
  gap: 2px;
  margin-top: 6px;
}
.anno-panel-empty {
  padding: 26px 12px;
  text-align: center;
  font-size: 12.5px;
  color: var(--text3);
  line-height: 1.7;
  white-space: pre-line;
}
.anno-panel-vocab-tools {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 8px;
}
.anno-panel-export {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 12px;
  font-weight: 600;
  transition: all 0.12s;
}
.anno-panel-export:hover {
  border-color: var(--accent);
  color: var(--accent-text);
}
.anno-panel-item.vocab {
  align-items: flex-start;
  flex-wrap: wrap;
}
.anno-panel-vocab-word {
  flex: 1;
  min-width: 0;
  font-size: 13.5px;
  font-weight: 700;
}
.anno-panel-vocab-meta {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.anno-panel-vocab-book {
  font-size: 11px;
  color: var(--accent-text);
}
.anno-panel-vocab-context {
  font-size: 12px;
  color: var(--text3);
  line-height: 1.4;
  max-height: 42px;
  overflow: hidden;
  word-break: break-word;
}
</style>
