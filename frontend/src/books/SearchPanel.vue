<template>
  <!-- 书内搜索面板：右侧抽屉（无遮罩——跳转后阅读区保持可见，可连续点击多条结果） -->
  <aside class="search-panel">
    <header class="search-panel-head">
      <h3 class="search-panel-title">{{ t("books.searchInBook") }}</h3>
      <span v-if="searchedQuery && !searching" class="search-panel-count">
        {{ t("books.searchResultsCount", { count: results.length }) }}
      </span>
      <button class="search-panel-close" :title="t('books.close')" @click="emit('close')">
        <X :size="18" />
      </button>
    </header>

    <!-- 输入 + 搜索按钮（回车触发；搜索中禁用防重复提交） -->
    <form class="search-panel-form" @submit.prevent="runSearch">
      <input
        ref="inputRef"
        v-model="query"
        class="search-panel-input"
        type="text"
        :placeholder="t('books.searchPlaceholder')"
        :disabled="searching"
        @keydown.enter.prevent="runSearch"
        @keydown.esc="emit('close')"
      />
      <button class="search-panel-btn" type="submit" :disabled="!canSearch">
        <Loader2 v-if="searching" :size="15" class="search-panel-spin" />
        <Search v-else :size="15" />
        {{ t("books.searchButton") }}
      </button>
    </form>

    <!-- 结果列表 / 空态 / 加载态 / 错误态 -->
    <div class="search-panel-body">
      <p v-if="searching" class="search-panel-status">
        <Loader2 :size="22" class="search-panel-spin" />
        {{ t("books.searchSearching") }}
      </p>
      <p v-else-if="error" class="search-panel-status err">
        <SearchX :size="26" class="search-panel-status-icon" />
        {{ error }}
      </p>
      <p v-else-if="searchedQuery && !resultsWithParts.length" class="search-panel-status">
        <SearchX :size="26" class="search-panel-status-icon" />
        {{ t("books.searchEmpty", { query: searchedQuery }) }}
      </p>
      <ul v-else-if="resultsWithParts.length" class="search-panel-list">
        <li
          v-for="(r, i) in resultsWithParts"
          :key="`${r.cfi}:${i}`"
          class="search-panel-item"
          :title="t('books.jump')"
          @click="emit('jump', r.cfi, r.matchStart, r.matchEnd, r.sentence)"
        >
          <p class="search-panel-chapter">{{ r.chapterTitle }}</p>
          <p class="search-panel-sentence">
            <span v-if="r.parts.before">{{ r.parts.before }}</span
            ><mark v-if="r.parts.word" class="search-panel-mark">{{ r.parts.word }}</mark
            ><span v-if="r.parts.after">{{ r.parts.after }}</span>
          </p>
        </li>
      </ul>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Loader2, Search, SearchX, X } from "@lucide/vue";
import type { BookSearchResult } from "./types";
import { searchBook } from "./annotations";
import { highlightParts } from "./searchHighlight";

const props = defineProps<{
  bookId: string;
  /** 打开时预填并自动搜索的词（null = 空输入，用户手动搜） */
  initialQuery: string | null;
}>();
const emit = defineEmits<{
  close: [];
  jump: [cfi: string, matchStart: number, matchEnd: number, sentence: string];
}>();

const { t } = useI18n();

const query = ref(props.initialQuery ?? "");
const searching = ref(false);
const error = ref("");
const results = ref<BookSearchResult[]>([]);
const searchedQuery = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

/** 搜索按钮可用：非空 + 不在搜索中（防重复提交） */
const canSearch = computed(() => !searching.value && query.value.trim().length > 0);

/** 结果 + 切片后的命中词高亮（sentence 首尾空白已由 highlightParts 对齐偏移） */
const resultsWithParts = computed(() =>
  results.value.map((r) => ({ ...r, parts: highlightParts(r.sentence, r.matchStart, r.matchEnd) })),
);

async function runSearch() {
  const q = query.value.trim();
  if (!q || searching.value) return;
  searching.value = true;
  error.value = "";
  try {
    const resp = await searchBook(props.bookId, q);
    results.value = resp.results ?? [];
    searchedQuery.value = q;
  } catch (e) {
    // 后端 400 / 网络错误 → 面板内错误态（不弹 toast，面板自身即提示面）
    results.value = [];
    searchedQuery.value = q;
    error.value = t("books.searchFailed", { msg: e instanceof Error ? e.message : String(e) });
  } finally {
    searching.value = false;
  }
}

// 打开时预填词非空 → 自动搜索一次（回车/按钮仍可重新搜）
onMounted(() => {
  if (props.initialQuery) {
    query.value = props.initialQuery;
    void runSearch();
  }
  try {
    inputRef.value?.focus();
  } catch {
    /* 焦点失败不影响 */
  }
});

// 面板已打开时收到新预填词（菜单「搜索」再次触发）→ 换词自动重搜
watch(
  () => props.initialQuery,
  (q) => {
    if (q) {
      query.value = q;
      void runSearch();
    }
  },
);
</script>

<style scoped>
.search-panel {
  position: absolute;
  top: 0;
  bottom: 0;
  right: 0;
  z-index: 8;
  width: min(400px, 92%);
  display: flex;
  flex-direction: column;
  background: var(--card);
  border-left: 1px solid var(--border);
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.18);
}
.search-panel-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--border);
}
.search-panel-title {
  font-size: 15px;
  font-weight: 700;
}
.search-panel-count {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text3);
}
.search-panel-close {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--text3);
  transition: all 0.12s;
}
.search-panel-close:hover {
  background: var(--card2);
  color: var(--text);
}
.search-panel-form {
  flex-shrink: 0;
  display: flex;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.search-panel-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text);
  font-size: 13.5px;
  outline: none;
  transition: border-color 0.15s;
}
.search-panel-input:focus {
  border-color: var(--accent);
}
.search-panel-input:disabled {
  opacity: 0.6;
}
.search-panel-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 14px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: all 0.15s;
}
.search-panel-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.search-panel-btn:not(:disabled):hover {
  filter: brightness(1.08);
}
.search-panel-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 8px 0 18px;
}
.search-panel-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 34px 16px;
  color: var(--text3);
  font-size: 13px;
  text-align: center;
  line-height: 1.6;
}
.search-panel-status.err {
  color: var(--text2);
}
.search-panel-status-icon {
  opacity: 0.7;
}
.search-panel-spin {
  animation: search-panel-spin 1.1s linear infinite;
  opacity: 0.7;
}
@keyframes search-panel-spin {
  to {
    transform: rotate(360deg);
  }
}
.search-panel-list {
  list-style: none;
  padding: 0 12px;
}
.search-panel-item {
  padding: 9px 10px;
  margin-bottom: 6px;
  border-radius: 10px;
  background: var(--card2);
  cursor: pointer;
  transition: background 0.12s;
}
.search-panel-item:hover {
  background: color-mix(in srgb, var(--card2) 60%, var(--accent-soft));
}
.search-panel-chapter {
  font-size: 11px;
  font-weight: 700;
  color: var(--accent-text);
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.search-panel-sentence {
  font-size: 13px;
  color: var(--text2);
  line-height: 1.55;
  word-break: break-word;
}
.search-panel-mark {
  background: #f6d32d;
  color: #1f2430;
  border-radius: 2px;
  padding: 0 1px;
}
</style>
