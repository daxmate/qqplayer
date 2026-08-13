<template>
  <div v-if="state.specLyricOpen" class="modal-mask" @click.self="close">
    <div class="modal">
      <div class="modal-head">
        <FileMusic :size="16" />
        指定歌词
        <span class="head-sub">{{ songName }}</span>
        <span class="src-badge" :class="{ manual: manualSpecified }">
          {{ manualSpecified ? "已手动指定" : "自动获取" }}
        </span>
        <button class="modal-close" title="关闭" @click="close">
          <X :size="16" />
        </button>
      </div>

      <div class="spec-body">
        <!-- 当前状态 -->
        <div v-if="manualSpecified" class="spec-status">
          <span class="status-dot" />
          <span class="status-text">
            当前使用手动指定歌词（{{ manualSource }} · {{ manualFormat.toUpperCase() }}）
          </span>
          <button class="clear-link" @click="clearSpec">清除指定</button>
        </div>

        <!-- tab 切换 -->
        <div class="spec-tabs">
          <button
            v-for="t in tabs"
            :key="t.value"
            class="spec-tab"
            :class="{ on: tab === t.value }"
            @click="tab = t.value"
          >
            <component :is="t.icon" :size="14" />
            {{ t.label }}
          </button>
        </div>

        <!-- 上传文件 -->
        <div v-if="tab === 'upload'" class="spec-pane">
          <label class="drop-zone" :class="{ has: file }">
            <input type="file" accept=".lrc,.srt,.txt" @change="onFile" />
            <FileUp :size="26" />
            <div class="dz-main">{{ file ? file.name : "点击选择歌词文件" }}</div>
            <div class="dz-sub">
              {{
                file
                  ? "格式：" + (detectedFormat ? detectedFormat.toUpperCase() : "未识别")
                  : "支持 .lrc / .srt（需包含时间戳）"
              }}
            </div>
          </label>
          <div v-if="file && !detectedFormat" class="spec-error">
            未识别到时间戳格式：LRC 需 [mm:ss]，SRT 需序号 + 时间轴
          </div>
          <pre v-if="file && detectedFormat" class="spec-preview">{{ preview }}</pre>
        </div>

        <!-- 在线搜索 -->
        <div v-else-if="tab === 'search'" class="spec-pane">
          <div class="search-row">
            <input
              v-model="searchTitle"
              class="search-input"
              placeholder="歌名"
              @keyup.enter="doSearch"
            />
            <input
              v-model="searchArtist"
              class="search-input"
              placeholder="歌手（可留空）"
              @keyup.enter="doSearch"
            />
            <button class="search-btn" :disabled="searching" @click="doSearch">
              <Loader2 v-if="searching" :size="14" class="spin" />
              {{ searching ? "搜索中" : "搜索" }}
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
                {{ r.source === "netease" ? "网易云" : "lrclib" }}
              </span>
              <span class="ri-title">{{ r.title }}</span>
              <span v-if="r.artist" class="ri-artist">{{ r.artist }}</span>
              <span v-if="r.tlyric" class="ri-zh" title="含中文翻译">译</span>
              <Loader2 v-if="savingIdx === i" :size="13" class="spin" />
            </button>
          </div>
          <div v-else-if="searched && !searching" class="spec-empty">
            没有找到带时间戳的歌词，试试其他关键词，或改用「上传文件 / 粘贴文本」
          </div>
        </div>

        <!-- 粘贴文本 -->
        <div v-else class="spec-pane">
          <textarea
            v-model="pasteText"
            class="paste-area"
            placeholder="粘贴 LRC / SRT 歌词文本…&#10;&#10;LRC 示例：&#10;[00:12.34]一行歌词&#10;&#10;SRT 示例：&#10;1&#10;00:00:12,340 --> 00:00:17,000&#10;一行歌词"
            spellcheck="false"
          />
          <div v-if="pasteText.trim()" class="paste-meta">
            检测格式：<b>{{ pasteFormat ? pasteFormat.toUpperCase() : "未识别" }}</b>
            <span v-if="!pasteFormat" class="spec-error inline"
              >需包含 [mm:ss]（LRC）或 序号+时间轴（SRT）</span
            >
          </div>
        </div>
      </div>

      <div class="modal-foot">
        <div class="foot-hint">指定后优先使用该歌词（不受来源优先级影响），可随时清除恢复自动</div>
        <div class="foot-actions">
          <button v-if="manualSpecified" class="btn-danger" @click="clearSpec">
            <Trash2 :size="13" />清除指定
          </button>
          <button
            v-if="tab !== 'search'"
            class="btn-primary"
            :disabled="!canSave || saving"
            @click="save"
          >
            <Loader2 v-if="saving" :size="14" class="spin" />
            保存
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from "vue";
import { ClipboardPaste, FileMusic, FileUp, Loader2, Search, Trash2, X } from "@lucide/vue";
import {
  deleteManualLyric,
  fetchManualLyric,
  loadLyric,
  saveManualLyric,
  searchLyricCandidates,
  state,
} from "../composables/usePlayer.js";

const tabs = [
  { value: "upload", label: "上传文件", icon: FileUp },
  { value: "search", label: "在线搜索", icon: Search },
  { value: "paste", label: "粘贴文本", icon: ClipboardPaste },
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
const preview = computed(() => fileText.value.split("\n").slice(0, 6).join("\n"));

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
    searchError.value = "请输入歌名";
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
    searchError.value = err.message || "搜索失败，请重试";
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
      source: `在线·${r.source === "netease" ? "网易云" : "lrclib"}·${r.title}${r.artist ? " - " + r.artist : ""}`,
    });
    await afterSaved();
  } catch (err) {
    searchError.value = err.message || "保存失败";
    savingIdx.value = -1;
  }
}

// ---- 粘贴文本 ----
const pasteText = ref("");
const pasteFormat = computed(() => (pasteText.value ? detectFormat(pasteText.value) : null));

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
  const text = tab.value === "upload" ? fileText.value : pasteText.value;
  const format = tab.value === "upload" ? detectedFormat.value : pasteFormat.value;
  saving.value = true;
  try {
    await saveManualLyric({
      path: song.value.path,
      format,
      text,
      source: tab.value === "upload" ? `上传·${file.value?.name || ""}` : "粘贴",
    });
    await afterSaved();
  } catch (err) {
    saving.value = false;
    window.alert(err.message || "保存失败");
  }
}

async function clearSpec() {
  if (!song.value) return;
  await deleteManualLyric(song.value.path);
  manual.value = null;
  await loadLyric();
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
.modal-close:hover {
  background: var(--card2);
  color: var(--text);
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
.clear-link:hover {
  text-decoration: underline;
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
.spec-tab:hover {
  color: var(--text);
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
.drop-zone:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
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
.result-item:hover:not(:disabled) {
  border-color: var(--accent);
  background: var(--accent-soft);
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
  height: 220px;
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
.btn-danger:hover {
  background: rgba(255, 107, 107, 0.12);
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
