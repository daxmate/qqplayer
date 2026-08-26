<template>
  <Teleport to="body">
    <div v-if="state.specLyricOpen" class="modal-mask" @click.self="close">
      <div class="modal">
        <div class="modal-head">
          <FileMusic :size="16" />
          <span class="spec-title">{{ t("spec.title") }}</span>
          <span class="head-sub">{{ songName }}</span>
          <span class="src-badge" :class="{ manual: manualSpecified }">
            {{ manualSpecified ? t("spec.manual") : t("spec.auto") }}
          </span>
          <button class="modal-close" :title="t('common.close')" @click="close">
            <X :size="16" />
          </button>
        </div>

        <div class="spec-body">
          <!-- 当前状态 -->
          <div v-if="manualSpecified" class="spec-status">
            <span class="status-dot" />
            <span class="status-text">
              {{
                t("spec.statusUsing", { source: manualSource, format: manualFormat.toUpperCase() })
              }}
            </span>
            <button class="clear-link" @click="clearSpec">{{ t("spec.clear") }}</button>
          </div>

          <!-- tab 切换 -->
          <div class="spec-tabs">
            <button
              v-for="tabItem in tabs"
              :key="tabItem.value"
              class="spec-tab"
              :class="{ on: tab === tabItem.value }"
              @click="tab = tabItem.value"
            >
              <component :is="tabItem.icon" :size="14" />
              {{ tabItem.label }}
            </button>
          </div>

          <!-- 上传文件 -->
          <div v-if="tab === 'upload'" class="spec-pane">
            <label class="drop-zone" :class="{ has: file }">
              <input type="file" accept=".lrc,.srt,.json,.txt" @change="onFile" />
              <FileUp :size="26" />
              <div class="dz-main">{{ file ? file.name : t("spec.clickToSelect") }}</div>
              <div class="dz-sub">
                {{
                  file
                    ? t("spec.formatLabel", {
                        format: detectedFormat
                          ? detectedFormat.toUpperCase()
                          : t("spec.unrecognized"),
                      })
                    : t("spec.supportedFormats")
                }}
              </div>
            </label>
            <div v-if="file && !detectedFormat" class="spec-error">
              {{ t("spec.unrecognizedDetail") }}
            </div>
            <pre v-if="file && detectedFormat" class="spec-preview">{{ preview }}</pre>
          </div>

          <!-- 在线搜索 -->
          <div v-else-if="tab === 'search'" class="spec-pane">
            <div class="search-row">
              <input
                v-model="searchTitle"
                class="search-input"
                :placeholder="t('spec.placeholderTitle')"
                @keyup.enter="doSearch"
              />
              <input
                v-model="searchArtist"
                class="search-input"
                :placeholder="t('spec.placeholderArtist')"
                @keyup.enter="doSearch"
              />
              <button class="search-btn" :disabled="searching" @click="doSearch">
                <Loader2 v-if="searching" :size="14" class="spin" />
                {{ searching ? t("spec.searching") : t("common.search") }}
              </button>
            </div>
            <div v-if="searchError" class="spec-error">{{ searchError }}</div>
            <div v-if="results.length" class="result-list">
              <button
                v-for="(r, i) in results"
                :key="i"
                class="result-item"
                :disabled="savingIdx === i"
                @click="pickResult(r, i)"
              >
                <span class="src-tag" :class="r.source">
                  {{ r.source === "netease" ? t("spec.sourceNetease") : "lrclib" }}
                </span>
                <span class="ri-title">{{ r.title }}</span>
                <span v-if="r.artist" class="ri-artist">{{ r.artist }}</span>
                <span v-if="r.tlyric" class="ri-zh" :title="t('spec.hasZhTitle')">{{
                  t("control.zh")
                }}</span>
                <Loader2 v-if="savingIdx === i" :size="13" class="spin" />
              </button>
            </div>
            <div v-else-if="searched && !searching" class="spec-empty">
              {{ t("spec.searchEmpty") }}
            </div>
          </div>

          <!-- 粘贴文本 -->
          <div v-else class="spec-pane">
            <textarea
              v-model="pasteText"
              class="paste-area"
              :placeholder="t('spec.pastePlaceholder')"
              spellcheck="false"
            />
            <div v-if="pasteText.trim()" class="paste-meta">
              {{ t("spec.detectFormatLabel")
              }}<b>{{ pasteFormat ? pasteFormat.toUpperCase() : t("spec.unrecognized") }}</b>
              <span v-if="!pasteFormat" class="spec-error inline">{{
                t("spec.pasteNeedTimeline")
              }}</span>
            </div>
          </div>
        </div>

        <div class="modal-foot">
          <div class="foot-hint">
            <template v-if="alignSourceText.trim() && !pasteText.trim()">
              {{ t("spec.alignUsesCurrent", { lines: currentLyricLineCount }) }}
            </template>
            <template v-else>{{ t("spec.footHint") }}</template>
          </div>
          <div class="foot-actions">
            <!-- AI 对齐（通用区）：自动用当前已加载歌词；无歌词时用粘贴文本 -->
            <button
              class="align-btn"
              :disabled="aligning || !alignSourceText.trim()"
              :title="t('spec.alignExperimentalHint')"
              @click="doAlign"
            >
              <Loader2 v-if="aligning" :size="14" class="spin" />
              <Sparkles v-else :size="14" />
              {{ aligning ? t("spec.aligning") : t("spec.align") }}
            </button>
            <button v-if="manualSpecified" class="btn-danger" @click="clearSpec">
              <Trash2 :size="13" />{{ t("spec.clear") }}
            </button>
            <button
              v-if="tab !== 'search'"
              class="btn-primary"
              :disabled="!canSave || saving"
              @click="save"
            >
              <Loader2 v-if="saving" :size="14" class="spin" />
              {{ t("common.save") }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ClipboardPaste,
  FileMusic,
  FileUp,
  Loader2,
  Search,
  Sparkles,
  Trash2,
  X,
} from "@lucide/vue";
import {
  alignLyric,
  deleteManualLyric,
  fetchManualLyric,
  loadLyric,
  saveManualLyric,
  searchLyricCandidates,
  state,
} from "../composables/usePlayer.js";
import { toastError, showToast } from "../composables/useToast.js";

const { t } = useI18n();

const tabs = [
  { value: "upload", label: t("spec.tabUpload"), icon: FileUp },
  { value: "search", label: t("spec.tabSearch"), icon: Search },
  { value: "paste", label: t("spec.tabPaste"), icon: ClipboardPaste },
];

const tab = ref("upload");
const manual = ref(null); // {format, text, source, created_at} | null
const manualSpecified = computed(() => !!manual.value);
const manualFormat = computed(() => manual.value?.format || "");
const manualSource = computed(() => manual.value?.source || "");

const song = computed(() => state.currentSong);
const songName = computed(() =>
  song.value ? song.value.name + (song.value.artist ? " · " + song.value.artist : "") : "",
);

// ---- 上传文件 ----
const file = ref(null);
const fileText = ref("");
const detectedFormat = computed(() => (fileText.value ? detectFormat(fileText.value) : null));
const preview = computed(() => {
  const text = fileText.value;
  if (detectedFormat.value === "json") {
    try {
      return JSON.parse(text).lrc.split("\n").slice(0, 6).join("\n");
    } catch {
      return text.slice(0, 300);
    }
  }
  return text.split("\n").slice(0, 6).join("\n");
});

function onFile(e) {
  const f = e.target.files?.[0];
  if (!f) return;
  file.value = f;
  const reader = new FileReader();
  reader.onload = () => {
    fileText.value = String(reader.result || "");
  };
  reader.readAsText(f, "utf-8");
}

// ---- 在线搜索 ----
const searchTitle = ref("");
const searchArtist = ref("");
const searching = ref(false);
const searched = ref(false);
const searchError = ref("");
const results = ref([]);
const savingIdx = ref(-1);

async function doSearch() {
  if (!searchTitle.value.trim()) {
    searchError.value = t("spec.searchTitleRequired");
    return;
  }
  searching.value = true;
  searched.value = false;
  searchError.value = "";
  results.value = [];
  savingIdx.value = -1;
  try {
    results.value = await searchLyricCandidates(
      searchTitle.value.trim(),
      searchArtist.value.trim(),
    );
    searched.value = true;
  } catch (err) {
    searchError.value = err.message || t("spec.searchFailed");
  } finally {
    searching.value = false;
  }
}

async function pickResult(r, i) {
  if (!song.value) return;
  savingIdx.value = i;
  searchError.value = "";
  try {
    await saveManualLyric({
      path: song.value.path,
      format: "lrc",
      text: r.text,
      source: t("spec.sourceOnline", {
        source: r.source === "netease" ? t("spec.sourceNetease") : "lrclib",
        title: r.title,
        artist: r.artist ? " - " + r.artist : "",
      }),
    });
    await afterSaved();
  } catch (err) {
    searchError.value = err.message || t("spec.saveFailed");
    savingIdx.value = -1;
  }
}

// ---- 粘贴文本 ----
const pasteText = ref("");
const pasteFormat = computed(() => (pasteText.value ? detectFormat(pasteText.value) : null));

// ---- AI 对齐（通用区）：优先自动用当前已加载歌词（state.lyric），无歌词时用粘贴文本 ----
// state.lyric 行结构：[{type:'line', s, e, text:[日文, 罗马音, 中文]}]；只取日文原文（text[0]）
const currentLyricLineCount = computed(
  () => (state.lyric || []).filter((l) => l.type === "line" && l.text?.[0]).length,
);
const alignSourceText = computed(() => {
  if (pasteText.value.trim()) return pasteText.value; // 粘贴优先（用户主动粘的内容）
  const lines = state.lyric || [];
  return lines
    .filter((l) => l.type === "line" && l.text?.[0])
    .map((l) => l.text[0])
    .join("\n");
});

// ---- AI 对齐：本地 ForcedAligner 生成时间戳 → 填入 LRC ----
const aligning = ref(false);

async function doAlign() {
  const text = alignSourceText.value.trim();
  if (aligning.value || !song.value || !text) return;
  aligning.value = true;
  try {
    const data = await alignLyric({ path: song.value.path, text });
    // 对齐耗时较长，期间用户可能已关弹窗/切歌：结果只在弹窗仍打开时填入
    if (!state.specLyricOpen || !song.value) return;
    pasteText.value = data.lrc; // 填入后 detectFormat 自动识别为 lrc，canSave 通过
    tab.value = "paste"; // 切回粘贴 tab 展示结果（用户可能停在别的 tab）
    showToast(t("spec.alignDone"));
  } catch (err) {
    toastError(err.message || t("spec.alignFailed"));
  } finally {
    aligning.value = false;
  }
}

// ---- 保存 / 清除 ----
const saving = ref(false);
const canSave = computed(() => {
  if (!song.value) return false;
  if (tab.value === "upload") return !!fileText.value && !!detectedFormat.value;
  if (tab.value === "paste") return !!pasteText.value.trim() && !!pasteFormat.value;
  return false;
});

async function save() {
  if (!canSave.value || !song.value) return;
  let text = tab.value === "upload" ? fileText.value : pasteText.value;
  let format = tab.value === "upload" ? detectedFormat.value : pasteFormat.value;
  let tlyric = undefined;
  if (format === "json") {
    // JSON 歌词：提取 lrc 原文 + tlyric 翻译，按 LRC 保存
    const obj = JSON.parse(text);
    text = obj.lrc;
    format = "lrc";
    if (typeof obj.tlyric === "string" && obj.tlyric.trim()) tlyric = obj.tlyric;
  }
  saving.value = true;
  try {
    await saveManualLyric({
      path: song.value.path,
      format,
      text,
      source:
        tab.value === "upload"
          ? t("spec.sourceUpload", { name: file.value?.name || "" })
          : t("spec.sourcePaste"),
      tlyric,
    });
    await afterSaved();
  } catch (err) {
    saving.value = false;
    toastError(err.message || t("spec.saveFailed"));
  }
}

// 清除指定歌词：缓存原数据 → toast「已清除 [撤销]」→ 撤销 = PUT 原样恢复
// 清除失败 → toastError（不弹撤销）
const UNDO_DURATION = 5000;

async function restoreManualLyric(cached) {
  if (!cached) return;
  try {
    await saveManualLyric({
      path: cached.path,
      format: cached.format,
      text: cached.text,
      source: cached.source,
      tlyric: cached.tlyric,
    });
    manual.value = await fetchManualLyric(cached.path);
    await loadLyric();
    showToast(t("lyric.manualRestored"));
  } catch (err) {
    toastError(err.message || t("spec.saveFailed"));
  }
}

async function clearSpec() {
  if (!song.value) return;
  // 清除前缓存当前手动歌词数据（供撤销 PUT 恢复；manual 为打开弹窗时 GET 的当前内容）
  const cached = manual.value ? { ...manual.value, path: song.value.path } : null;
  const ok = await deleteManualLyric(song.value.path);
  if (!ok) {
    toastError(t("spec.clearFailed"));
    return;
  }
  manual.value = null;
  await loadLyric();
  showToast(t("lyric.manualCleared"), {
    duration: UNDO_DURATION,
    action: {
      label: t("queue.undo"),
      onClick: () => restoreManualLyric(cached),
    },
  });
}

// 保存成功：刷新状态与歌词 → 关闭
async function afterSaved() {
  if (!song.value) return;
  manual.value = await fetchManualLyric(song.value.path);
  await loadLyric();
  close();
}

function close() {
  state.specLyricOpen = false;
}

function detectFormat(text) {
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj?.lrc === "string" && obj.lrc.trim()) return "json";
      return null; // 是 JSON 但没有 lrc 字段 → 不支持的歌词结构
    } catch {
      /* 不是 JSON，继续按 srt/lrc 判断 */
    }
  }
  if (/\d{2}:\d{2}:\d{2}[,.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(text)) return "srt";
  if (/\[\d{1,2}:\d{2}([:.]\d{1,3})?\]/.test(text)) return "lrc";
  return null;
}

watch(
  () => state.specLyricOpen,
  async (open) => {
    if (open && song.value) {
      tab.value = "upload";
      file.value = null;
      fileText.value = "";
      pasteText.value = "";
      results.value = [];
      searched.value = false;
      searchError.value = "";
      savingIdx.value = -1;
      searchTitle.value = song.value.name || "";
      searchArtist.value = song.value.artist || "";
      aligning.value = false;
      const st = await fetchManualLyric(song.value.path);
      manual.value = st?.specified ? st : null;
    }
  },
);
</script>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: var(--mask);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.modal {
  width: min(560px, calc(100vw - 40px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 16px;
  box-shadow:
    0 24px 80px var(--shadow-strong),
    0 4px 16px var(--shadow-sm);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  max-height: min(640px, calc(100vh - 60px));
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 700;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
/* 标题固定不换行（窄屏下由 head-sub 收缩省略号让位） */
.spec-title {
  white-space: nowrap;
  flex-shrink: 0;
}
.modal-head svg {
  color: var(--accent);
}
.head-sub {
  font-size: 12px;
  font-weight: 500;
  color: var(--text2);
  margin-left: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}
.src-badge {
  font-size: 11px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 20px;
  background: var(--accent-soft);
  color: var(--text2);
  flex-shrink: 0;
}
.src-badge.manual {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--accent-text);
}
.modal-close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
@media (hover: hover) {
  .modal-close:hover {
    background: var(--card2);
    color: var(--text);
  }
}

.spec-body {
  padding: 14px 18px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: auto;
}
.spec-status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  color: var(--text2);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-radius: 10px;
  padding: 8px 12px;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  flex-shrink: 0;
}
.status-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.clear-link {
  margin-left: auto;
  font-size: 12px;
  font-weight: 600;
  color: #ff6b6b;
  flex-shrink: 0;
}
@media (hover: hover) {
  .clear-link:hover {
    text-decoration: underline;
  }
}

.spec-tabs {
  display: flex;
  gap: 4px;
  background: var(--card);
  border-radius: 10px;
  padding: 3px;
  flex-shrink: 0;
}
.spec-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 7px 0;
  border-radius: 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
}
@media (hover: hover) {
  .spec-tab:hover {
    color: var(--text);
  }
}
.spec-tab.on {
  background: var(--accent-on);
  color: var(--accent-text);
}

.spec-pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 220px;
}
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 26px 16px;
  border: 1.5px dashed var(--border);
  border-radius: 12px;
  color: var(--text2);
  cursor: pointer;
  transition: all 0.15s;
  text-align: center;
}
@media (hover: hover) {
  .drop-zone:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}
.drop-zone.has {
  border-style: solid;
  border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  background: var(--accent-soft);
}
.drop-zone input {
  display: none;
}
.dz-main {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.dz-sub {
  font-size: 12px;
  color: var(--text3);
}
.spec-preview {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text2);
  max-height: 150px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.search-row {
  display: flex;
  gap: 8px;
}
.search-input {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  font-size: 13px;
  transition: all 0.15s;
}
.search-input:focus {
  border-color: var(--accent);
  outline: none;
}
.search-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  transition: opacity 0.15s;
  flex-shrink: 0;
}
.search-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.result-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
  max-height: 260px;
}
.result-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border-radius: 9px;
  background: var(--card);
  border: 1px solid var(--border);
  text-align: left;
  transition: all 0.15s;
  font-size: 13px;
}
@media (hover: hover) {
  .result-item:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}
.result-item:disabled {
  opacity: 0.6;
}
.src-tag {
  font-size: 10.5px;
  font-weight: 700;
  padding: 1.5px 7px;
  border-radius: 6px;
  flex-shrink: 0;
}
.src-tag.netease {
  background: color-mix(in srgb, #e60026 16%, transparent);
  color: #ff7d8e;
}
.src-tag.lrclib {
  background: color-mix(in srgb, #4a9eff 16%, transparent);
  color: #7db8ff;
}
.ri-title {
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ri-artist {
  color: var(--text3);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}
.ri-zh {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent-text);
  background: var(--accent-soft);
  padding: 1px 6px;
  border-radius: 6px;
  flex-shrink: 0;
}
.spec-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 40px 0;
}

.paste-area {
  width: 100%;
  height: 200px;
  resize: vertical;
  padding: 12px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.6;
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  transition: border-color 0.15s;
}
.paste-area:focus {
  border-color: var(--accent);
  outline: none;
}
.align-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 7px 14px;
  border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
}
@media (hover: hover) {
  .align-btn:hover:not(:disabled) {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
  }
}
.align-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.paste-meta {
  font-size: 12.5px;
  color: var(--text2);
}
.spec-error {
  font-size: 12.5px;
  color: #ff6b6b;
}
.spec-error.inline {
  margin-left: 8px;
}

.modal-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  border-top: 1px solid var(--border);
  background: var(--bg2);
  flex-shrink: 0;
}
.foot-hint {
  font-size: 11.5px;
  color: var(--text3);
}
.foot-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.btn-danger {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 8px 14px;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 600;
  color: #ff6b6b;
  border: 1px solid color-mix(in srgb, #ff6b6b 40%, transparent);
  transition: all 0.15s;
}
@media (hover: hover) {
  .btn-danger:hover {
    background: rgba(255, 107, 107, 0.12);
  }
}
.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 20px;
  border-radius: 9px;
  background: var(--accent);
  color: #fff;
  font-size: 12.5px;
  font-weight: 600;
  transition: opacity 0.15s;
}
.btn-primary:disabled {
  opacity: 0.5;
  cursor: default;
}
.spin {
  animation: lsm-spin 0.9s linear infinite;
}
@keyframes lsm-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
