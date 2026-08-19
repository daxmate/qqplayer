<template>
  <div class="dict-modal-mask" @mousedown.self="emit('close')">
    <div class="dict-modal">
      <!-- 头部：词 + 词频徽标 + 词典切换 + 发音（占位）+ 关闭 -->
      <header class="dict-modal-head">
        <div class="dict-modal-wordbox">
          <span class="dict-modal-word">{{ word }}</span>
          <span
            v-if="result?.frequency?.rank"
            class="dict-modal-freq"
            :title="
              t('books.lookupFreq', { rank: result.frequency.rank, total: result.frequency.total })
            "
          >
            {{ stars(result.frequency.rank) }}
          </span>
        </div>
        <div class="dict-modal-tools">
          <select
            v-if="defineDicts.length > 1"
            class="dict-modal-select"
            :title="t('books.lookupSwitchDict')"
            :value="activeDictId"
            @change="onDictChange"
          >
            <option v-for="d in defineDicts" :key="d.id" :value="d.id">{{ d.name }}</option>
          </select>
          <button class="dict-modal-btn icon" disabled :title="t('books.lookupPronounce')">
            <Lock :size="15" />
          </button>
          <button class="dict-modal-btn icon" :title="t('books.close')" @click="emit('close')">
            <X :size="16" />
          </button>
        </div>
      </header>

      <!-- 正文：srcdoc iframe 渲染词条 / 空态 -->
      <div class="dict-modal-body">
        <div v-if="loading" class="dict-modal-status">
          <Loader2 :size="24" class="dict-modal-spin" />
        </div>
        <template v-else-if="result?.found && result.html">
          <iframe
            class="dict-modal-frame"
            sandbox="allow-same-origin allow-scripts"
            :srcdoc="srcdoc"
          />
        </template>
        <div v-else class="dict-modal-status">
          <template v-if="!defineDicts.length">
            <BookMarked :size="34" class="dict-modal-status-icon" />
            <p class="dict-modal-status-title">{{ t("books.lookupNoDict") }}</p>
            <p class="dict-modal-status-hint">{{ t("books.lookupNoDictHint") }}</p>
            <button class="dict-modal-btn primary" @click="emit('openDictManager')">
              <BookMarked :size="14" />
              {{ t("books.lookupOpenDict") }}
            </button>
          </template>
          <template v-else>
            <SearchX :size="34" class="dict-modal-status-icon" />
            <p class="dict-modal-status-title">
              {{ result?.error ? t("books.lookupFailed") : t("books.lookupEmpty") }}
            </p>
            <p v-if="result?.error" class="dict-modal-status-hint">{{ result.error }}</p>
          </template>
        </div>
      </div>

      <!-- 底部：加入生词本 -->
      <footer class="dict-modal-foot">
        <span v-if="sourceText" class="dict-modal-source">{{ sourceText }}</span>
        <button
          class="dict-modal-btn primary vocab"
          :class="{ added }"
          :disabled="added || adding"
          @click="addToVocab"
        >
          <Check v-if="added" :size="14" />
          <BookPlus v-else :size="14" />
          {{ added ? t("books.vocabAdded") : t("books.vocabAdd") }}
        </button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { BookMarked, BookPlus, Check, Loader2, Lock, SearchX, X } from "@lucide/vue";
import type { DictConfig, DictQueryResult } from "./types";
import { fetchDictSettings, queryDict, addVocab, rewriteDictHtml } from "./annotations";
import { showToast, toastError } from "../composables/useToast.js";

const props = defineProps<{
  word: string;
  context: string;
  bookId: string;
  bookTitle: string;
  cfi: string;
  /** 当前阅读主题色（Reader 传入；dark=true 时注入覆盖层适配词典自带浅色样式） */
  themeColors?: { text: string; bg: string; dark: boolean };
}>();
const emit = defineEmits<{ close: []; openDictManager: [] }>();

const { t } = useI18n();

const dicts = ref<DictConfig[]>([]);
const activeDictId = ref("");
const result = ref<DictQueryResult | null>(null);
const loading = ref(true);
const adding = ref(false);
const added = ref(false);

/** 可查词词典：enabled 的 define 词典 */
const defineDicts = computed(() => dicts.value.filter((d) => d.enabled && d.role === "define"));

const sourceText = computed(() => (result.value?.found ? result.value.source : ""));

/** 词条 HTML → srcdoc 完整文档（资源 URL 重写 + 基础排版 + 音频点击播放脚本）
 *
 * 注入脚本：拦截 a[href^="/api/dict/resource/"] 点击——音频扩展名就地播放，其余
 * preventDefault（避免 iframe 导航走）；同时拦截 a[href^="entry://"]（LDOCE 跨词条
 * 链接，未知协议导航同样会让 iframe 空白）。rewriteDictHtml 已剔除词典自带 script，
 * 无外部脚本风险。srcdoc 里 script 结束标签用 SCRIPT_CLOSE 拼接生成：@vue/compiler-sfc
 * 的 tokenizer 对 script 块做字节序列匹配，源文件里出现字面量结束标签会提前截断。
 */
const SCRIPT_CLOSE = "<" + "/script>";

/** 词条链接色：按背景亮度选（暗底→亮蓝，米黄/浅底→深蓝） */
function linkColorFor(bg: string): string {
  const m = bg.match(/^#([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    const luma = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
    return luma < 140 ? "#7ab8ff" : "#1a5aa8";
  }
  return "#1a5aa8";
}

const srcdoc = computed(() => {
  if (!result.value?.found || !result.value.html) return "";
  const body = rewriteDictHtml(result.value.html, activeDictId.value);
  const c = props.themeColors;
  // 基础样式：浅色（或未传）用默认；非浅色主题用主题色 + !important 覆盖词典内联样式
  const themeCss = c?.dark
    ? `body{margin:8px 10px;font-size:14px;line-height:1.55;color:${c.text};background:${c.bg};word-wrap:break-word}
body, body *{color:${c.text} !important}
a, a *{color:${linkColorFor(c.bg)} !important}
[style*="background"]{background-color:transparent !important}`
    : `body{margin:8px 10px;font-size:14px;line-height:1.55;color:#1f2328;word-wrap:break-word}
a{color:#1a66d6}`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
${themeCss}
</style>
<script>
try {
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest
      ? e.target.closest('a[href^="/api/dict/resource/"], a[href^="entry://"]')
      : null;
    if (!a) return;
    e.preventDefault();
    var href = a.getAttribute('href') || '';
    if (/[.](mp3|m4a|wav|ogg|aac)([?#]|$)/i.test(href)) {
      var audio = new Audio(href);
      var p = audio.play();
      if (p && p.catch) p.catch(function () {});
    }
  }, true);
  // 禁浏览器默认右键菜单（词条正文只读；输入框保留系统菜单）
  document.addEventListener('contextmenu', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('input, textarea, [contenteditable]') : null;
    if (!t) e.preventDefault();
  }, true);
} catch (err) { /* 脚本失败不影响词条显示 */ }
${SCRIPT_CLOSE}
</head><body>${body}</body></html>`;
});

/** COCA 词频星级：≤1000 ★★★★★ / ≤5000 ★★★★ / ≤15000 ★★★ / ≤30000 ★★ / 其余 ★ */
function stars(rank: number): string {
  const n = rank <= 1000 ? 5 : rank <= 5000 ? 4 : rank <= 15000 ? 3 : rank <= 30000 ? 2 : 1;
  return "★".repeat(n);
}

async function lookup(dictId: string) {
  loading.value = true;
  result.value = null;
  try {
    result.value = await queryDict(props.word, dictId || undefined);
  } catch {
    result.value = null;
    toastError(t("books.lookupFailed"));
  } finally {
    loading.value = false;
  }
}

function onDictChange(e: Event) {
  const id = (e.target as HTMLSelectElement).value;
  activeDictId.value = id;
  void lookup(id);
}

async function addToVocab() {
  if (added.value || adding.value) return;
  adding.value = true;
  try {
    await addVocab({
      word: props.word,
      context: props.context,
      bookId: props.bookId,
      bookTitle: props.bookTitle,
      cfi: props.cfi,
    });
    added.value = true;
    showToast(t("books.vocabAddedDone"));
  } catch {
    toastError(t("books.vocabAddFailed"));
  } finally {
    adding.value = false;
  }
}

onMounted(async () => {
  try {
    const s = await fetchDictSettings();
    dicts.value = s.dictionaries;
    // 默认词典：activeDictId（必须是 enabled define）→ 否则第一个 enabled define
    const active = defineDicts.value.find((d) => d.id === s.activeDictId);
    const first = defineDicts.value[0];
    activeDictId.value = active?.id ?? first?.id ?? "";
  } catch {
    dicts.value = [];
    activeDictId.value = "";
  }
  if (activeDictId.value) {
    void lookup(activeDictId.value);
  } else {
    loading.value = false; // 无可用词典 → 空态
  }
});
</script>

<style scoped>
.dict-modal-mask {
  position: absolute;
  inset: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}
.dict-modal {
  width: min(480px, 92%);
  height: min(60vh, 520px);
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 16px 44px var(--shadow-strong);
  overflow: hidden;
}
.dict-modal-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 12px 10px 16px;
  border-bottom: 1px solid var(--border);
}
.dict-modal-wordbox {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.dict-modal-word {
  font-size: 17px;
  font-weight: 800;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dict-modal-freq {
  flex-shrink: 0;
  font-size: 13px;
  letter-spacing: 1px;
  color: #e6a817;
}
.dict-modal-tools {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.dict-modal-select {
  max-width: 160px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text);
  font-size: 12px;
  outline: none;
}
.dict-modal-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.12s;
}
.dict-modal-btn.icon {
  padding: 6px;
}
.dict-modal-btn:hover {
  background: var(--card2);
  color: var(--text);
}
.dict-modal-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.dict-modal-btn.primary {
  border: none;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.dict-modal-btn.primary:hover {
  filter: brightness(1.08);
}
.dict-modal-btn.primary.vocab.added {
  background: var(--card2);
  color: var(--accent-text);
  filter: none;
}
.dict-modal-body {
  flex: 1;
  min-height: 0;
  background: #fff;
}
.dict-modal-frame {
  width: 100%;
  height: 100%;
  border: none;
  background: #fff;
}
.dict-modal-status {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 20px;
  text-align: center;
  color: var(--text3);
}
.dict-modal-status-icon {
  opacity: 0.55;
}
.dict-modal-status-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text2);
}
.dict-modal-status-hint {
  font-size: 12.5px;
  max-width: 320px;
  line-height: 1.5;
  word-break: break-all;
}
.dict-modal-spin {
  animation: dict-modal-spin 1.1s linear infinite;
  opacity: 0.7;
}
@keyframes dict-modal-spin {
  to {
    transform: rotate(360deg);
  }
}
.dict-modal-foot {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 10px 14px 10px 16px;
  border-top: 1px solid var(--border);
}
.dict-modal-source {
  font-size: 12px;
  color: var(--text3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
