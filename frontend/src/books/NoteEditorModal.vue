<template>
  <div class="note-modal-mask" @mousedown.self="emit('cancel')">
    <div class="note-modal">
      <header class="note-modal-head">
        <h3 class="note-modal-title">{{ t("books.noteTitle") }}</h3>
        <button class="note-modal-x" :title="t('books.close')" @click="emit('cancel')">
          <X :size="16" />
        </button>
      </header>
      <div class="note-modal-body">
        <p v-if="excerpt" class="note-modal-excerpt">
          <span class="note-modal-excerpt-label">{{ t("books.noteExcerpt") }}</span>
          <span class="note-modal-excerpt-text">{{ excerpt }}</span>
        </p>
        <textarea
          ref="textareaRef"
          v-model="draft"
          class="note-modal-textarea"
          :placeholder="t('books.notePlaceholder')"
          rows="5"
          @keydown.esc="emit('cancel')"
          @keydown.meta.enter="submit"
          @keydown.ctrl.enter="submit"
        />
      </div>
      <footer class="note-modal-foot">
        <button class="note-modal-btn ghost" @click="emit('cancel')">
          {{ t("books.noteCancel") }}
        </button>
        <button class="note-modal-btn primary" :disabled="saving" @click="submit">
          {{ saving ? t("books.loading") : t("books.noteSave") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { X } from "@lucide/vue";

const props = defineProps<{
  /** 原文摘录（只读展示） */
  excerpt?: string;
  /** 初始正文（编辑场景） */
  initialText?: string;
  saving?: boolean;
}>();
const emit = defineEmits<{ save: [text: string]; cancel: [] }>();

const { t } = useI18n();

const draft = ref(props.initialText ?? "");
const textareaRef = ref<HTMLTextAreaElement | null>(null);

function submit() {
  if (props.saving) return;
  emit("save", draft.value);
}

onMounted(() => {
  textareaRef.value?.focus();
});
</script>

<style scoped>
.note-modal-mask {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.note-modal {
  width: min(440px, 90%);
  max-height: 80%;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 16px 44px var(--shadow-strong);
  overflow: hidden;
}
.note-modal-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 12px 16px;
  border-bottom: 1px solid var(--border);
}
.note-modal-title {
  font-size: 14.5px;
  font-weight: 700;
}
.note-modal-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  color: var(--text3);
  transition: all 0.12s;
}
.note-modal-x:hover {
  background: var(--card2);
  color: var(--text);
}
.note-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  overflow-y: auto;
}
.note-modal-excerpt {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-left: 3px solid var(--accent);
  border-radius: 6px;
  background: var(--card2);
}
.note-modal-excerpt-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text3);
}
.note-modal-excerpt-text {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.5;
  max-height: 72px;
  overflow-y: auto;
  word-break: break-word;
}
.note-modal-textarea {
  flex: 1;
  min-height: 90px;
  resize: vertical;
  padding: 9px 11px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  font-size: 13.5px;
  line-height: 1.55;
  font-family: inherit;
  outline: none;
  transition: border-color 0.12s;
}
.note-modal-textarea:focus {
  border-color: var(--accent);
}
.note-modal-foot {
  flex-shrink: 0;
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
.note-modal-btn {
  padding: 7px 16px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.12s;
}
.note-modal-btn.ghost {
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text2);
}
.note-modal-btn.ghost:hover {
  background: var(--card2);
  color: var(--text);
}
.note-modal-btn.primary {
  border: none;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.note-modal-btn.primary:hover {
  filter: brightness(1.08);
}
.note-modal-btn.primary:disabled {
  opacity: 0.6;
  cursor: default;
}
</style>
