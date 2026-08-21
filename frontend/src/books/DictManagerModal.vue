<template>
  <div class="dictmgr-mask" @mousedown.self="emit('close')">
    <div class="dictmgr">
      <header class="dictmgr-head">
        <h3 class="dictmgr-title">
          <BookMarked :size="17" />
          {{ t("books.dictManage") }}
        </h3>
        <button class="dictmgr-close" :title="t('books.close')" @click="emit('close')">
          <X :size="18" />
        </button>
      </header>

      <div class="dictmgr-scroll">
        <p class="dictmgr-hint">{{ t("books.dictIcloudHint") }}</p>

        <!-- 已添加词典 -->
        <p class="dictmgr-section-title">{{ t("books.dict") }}</p>
        <div v-if="dicts.length" class="dictmgr-list">
          <div v-for="d in dicts" :key="d.id" class="dictmgr-item">
            <div class="dictmgr-item-main">
              <span class="dictmgr-item-name">
                {{ d.name }}
                <span
                  class="dictmgr-role"
                  :class="d.role"
                  :title="
                    d.role === 'frequency'
                      ? t('books.dictRoleFrequency')
                      : t('books.dictRoleDefine')
                  "
                >
                  {{
                    d.role === "frequency"
                      ? t("books.dictRoleFrequency")
                      : t("books.dictRoleDefine")
                  }}
                </span>
              </span>
              <span class="dictmgr-item-path" :title="d.path">{{ d.path }}</span>
            </div>
            <div class="dictmgr-item-actions">
              <button
                class="dictmgr-btn"
                :class="{ on: d.id === activeDictId }"
                :disabled="d.id === activeDictId"
                :title="t('books.dictSetDefault')"
                @click="setActive(d)"
              >
                {{ d.id === activeDictId ? t("books.dictDefault") : t("books.dictSetDefault") }}
              </button>
              <button
                class="dictmgr-switch"
                :class="{ on: d.enabled }"
                :title="d.enabled ? t('books.dictEnabled') : t('books.dictDisabled')"
                @click="toggleEnabled(d)"
              >
                <span class="dictmgr-switch-knob" />
              </button>
              <button class="dictmgr-btn danger" :title="t('books.delete')" @click="remove(d)">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>
        </div>
        <div v-else class="dictmgr-empty">
          <BookMarked :size="30" class="dictmgr-empty-icon" />
          <p>{{ t("books.dictEmpty") }}</p>
          <p class="dictmgr-empty-hint">{{ t("books.dictAddHint") }}</p>
        </div>

        <!-- 添加词典：复制到应用 / 链接原路径 -->
        <p class="dictmgr-section-title">{{ t("books.dictAddTitle") }}</p>
        <div class="dictmgr-mode-row">
          <label class="dictmgr-mode" :class="{ on: mode === 'copy' }">
            <input v-model="mode" type="radio" value="copy" />
            📋 {{ t("books.dictModeCopy") }}
          </label>
          <label class="dictmgr-mode" :class="{ on: mode === 'link' }">
            <input v-model="mode" type="radio" value="link" />
            🔗 {{ t("books.dictModeLink") }}
          </label>
        </div>

        <!-- 复制模式：多选批量上传 -->
        <div v-if="mode === 'copy'" class="dictmgr-copy">
          <p class="dictmgr-hint small">{{ t("books.dictSelectFilesHint") }}</p>
          <label class="dictmgr-upload">
            <Loader2 v-if="uploading" :size="15" class="dictmgr-spin" />
            <Upload v-else :size="15" />
            {{ uploading ? t("books.dictUploading") : t("books.dictSelectFiles") }}
            <input
              type="file"
              multiple
              accept=".mdx,.mdd,.css,.js,.jpg,.jpeg,.png,.gif,.svg,.mp3,.woff,.woff2"
              :disabled="uploading"
              @change="onFilesPicked"
            />
          </label>
          <div v-if="uploading" class="dictmgr-progress">
            <div class="dictmgr-progress-bar">
              <div class="dictmgr-progress-fill" :style="{ width: uploadProgress + '%' }" />
            </div>
            <span class="dictmgr-progress-text">{{ uploadName }} {{ uploadProgress }}%</span>
          </div>
        </div>

        <!-- 链接模式：壳内原生选文件 + 路径扫描（多选批量添加） -->
        <div v-else class="dictmgr-link">
          <button
            v-if="isNative"
            class="dictmgr-btn primary"
            :disabled="adding"
            @click="pickNativeFiles"
          >
            <FolderSearch :size="14" />
            {{ t("books.dictPickFiles") }}
          </button>
          <div class="dictmgr-path-row">
            <input
              v-model="pathInput"
              class="dictmgr-input"
              :placeholder="t('books.dictPathPlaceholder')"
              @keydown.enter="scan()"
            />
            <button
              class="dictmgr-btn primary"
              :disabled="scanning || !pathInput.trim()"
              @click="scan"
            >
              <Loader2 v-if="scanning" :size="14" class="dictmgr-spin" />
              <FolderSearch v-else :size="14" />
              {{ scanning ? t("books.dictScanning") : t("books.dictScan") }}
            </button>
            <button
              class="dictmgr-btn"
              :disabled="adding || !pathInput.trim().toLowerCase().endsWith('.mdx')"
              @click="addByPath"
            >
              {{ t("books.dictAdd") }}
            </button>
          </div>
          <div v-if="scanCandidates.length" class="dictmgr-candidates">
            <div v-for="c in scanCandidates" :key="c.path" class="dictmgr-candidate">
              <input
                v-model="selectedPaths"
                type="checkbox"
                class="dictmgr-candidate-check"
                :value="c.path"
                :disabled="adding"
              />
              <span class="dictmgr-candidate-name">{{ c.name }}</span>
              <span class="dictmgr-candidate-meta">
                {{ fmtSize(c.size) }}{{ c.mddExists ? " +mdd" : "" }}
              </span>
            </div>
            <button
              class="dictmgr-btn primary dictmgr-add-selected"
              :disabled="adding || !selectedPaths.length"
              @click="addSelected"
            >
              {{ t("books.dictAddSelected", { n: selectedPaths.length }) }}
            </button>
          </div>
          <p v-else-if="scanned && !scanning" class="dictmgr-scan-empty">
            {{ t("books.dictScanEmpty") }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { useI18n } from "vue-i18n";
import { BookMarked, FolderSearch, Loader2, Trash2, Upload, X } from "@lucide/vue";
import type { DictConfig, DictScanCandidate } from "./types";
import { useShellBridge } from "../composables/useShellBridge.js";
import {
  activateDict,
  addDict,
  addDictBatch,
  deleteDict,
  fetchDictSettings,
  scanDictPath,
  setDictEnabled,
  uploadDictFiles,
} from "./annotations";
import { showToast, toastError } from "../composables/useToast.js";

const emit = defineEmits<{ close: []; changed: [] }>();

const { t } = useI18n();

// 壳环境（Swift 壳 atDocumentStart 注入 window.qqplayerNative === true）
const isNative =
  typeof window !== "undefined" && (window as { qqplayerNative?: boolean }).qqplayerNative === true;

const dicts = ref<DictConfig[]>([]);
const activeDictId = ref("");
const mode = ref<"copy" | "link">("copy");
const pathInput = ref("");
const scanCandidates = ref<DictScanCandidate[]>([]);
const selectedPaths = ref<string[]>([]);
const scanned = ref(false);
const scanning = ref(false);
const adding = ref(false);
const uploading = ref(false);
const uploadProgress = ref(0);
const uploadName = ref("");

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function refresh() {
  try {
    const s = await fetchDictSettings();
    dicts.value = s.dictionaries;
    activeDictId.value = s.activeDictId;
  } catch {
    toastError(t("books.dictLoadFailed"));
  }
}

async function scan() {
  const p = pathInput.value.trim();
  if (!p) return;
  scanning.value = true;
  scanned.value = true;
  scanCandidates.value = [];
  selectedPaths.value = [];
  try {
    scanCandidates.value = await scanDictPath(p);
    if (!scanCandidates.value.length) showToast(t("books.dictScanEmpty"));
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictScanFailed"));
  } finally {
    scanning.value = false;
  }
}

async function addByPath() {
  const p = pathInput.value.trim();
  if (!p.toLowerCase().endsWith(".mdx")) {
    toastError(t("books.dictPathInvalid"));
    return;
  }
  adding.value = true;
  try {
    await addDict(p);
    showToast(t("books.dictAdded"));
    await refresh();
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictLoadFailed"));
  } finally {
    adding.value = false;
  }
}

/** 批量添加路径（壳内选文件 / 候选多选共用）；成功/跳过分别 toast */
async function addPaths(paths: string[]) {
  adding.value = true;
  try {
    const r = await addDictBatch(paths);
    if (r.added.length) showToast(t("books.dictImportDone", { n: r.added.length }));
    if (r.skipped.length) showToast(t("books.dictImportSkipped", { n: r.skipped.length }));
    await refresh();
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictLoadFailed"));
  } finally {
    adding.value = false;
  }
}

/** 候选多选批量添加 */
async function addSelected() {
  const paths = selectedPaths.value.slice();
  if (!paths.length) return;
  await addPaths(paths);
  selectedPaths.value = [];
}

/** 壳内：触发原生文件选择（统一壳桥：webkit 走 postMessage / tauri 走 invoke / 浏览器 noop） */
function pickNativeFiles() {
  useShellBridge().pickDictFiles();
}

/** 壳内：原生选文件结果（e.detail.paths，取消为空数组） */
function onNativeDictFiles(e: Event) {
  const detail = (e as CustomEvent<{ paths?: string[] }>).detail;
  const paths = Array.isArray(detail?.paths) ? detail.paths : [];
  if (!paths.length) return; // 用户取消
  void addPaths(paths);
}

async function toggleEnabled(d: DictConfig) {
  try {
    await setDictEnabled(d.id, !d.enabled);
    d.enabled = !d.enabled;
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictLoadFailed"));
  }
}

async function setActive(d: DictConfig) {
  if (d.id === activeDictId.value) return;
  try {
    await activateDict(d.id);
    activeDictId.value = d.id;
    showToast(t("books.dictActivated"));
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictLoadFailed"));
  }
}

async function remove(d: DictConfig) {
  try {
    await deleteDict(d.id);
    dicts.value = dicts.value.filter((x) => x.id !== d.id);
    if (activeDictId.value === d.id) activeDictId.value = "";
    showToast(t("books.dictDeleteDone"));
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictLoadFailed"));
  }
}

async function onFilesPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = ""; // 允许重复选择同一批文件
  if (!files.length) return;
  uploading.value = true;
  uploadProgress.value = 0;
  uploadName.value =
    files.length > 1 ? t("books.dictFileCount", { n: files.length }) : files[0].name;
  try {
    const r = await uploadDictFiles(files, (p) => {
      uploadProgress.value = p;
    });
    if (r.added.length) showToast(t("books.dictImportDone", { n: r.added.length }));
    if (r.ignored.length) showToast(t("books.dictUploadIgnored", { m: r.ignored.length }));
    await refresh();
  } catch (err) {
    toastError(t("books.dictUploadFailed", { msg: err instanceof Error ? err.message : "" }));
  } finally {
    uploading.value = false;
  }
}

onMounted(() => {
  window.addEventListener("qqplayer:nativeDictFiles", onNativeDictFiles);
  void refresh();
});

onUnmounted(() => {
  window.removeEventListener("qqplayer:nativeDictFiles", onNativeDictFiles);
});
</script>

<style scoped>
.dictmgr-mask {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.4);
}
.dictmgr {
  width: min(560px, 92%);
  max-height: 82%;
  display: flex;
  flex-direction: column;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 14px;
  box-shadow: 0 16px 44px var(--shadow-strong);
  overflow: hidden;
}
.dictmgr-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 12px 18px;
  border-bottom: 1px solid var(--border);
}
.dictmgr-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
}
.dictmgr-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--text3);
  transition: all 0.12s;
}
.dictmgr-close:hover {
  background: var(--card2);
  color: var(--text);
}
.dictmgr-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px 18px 20px;
}
.dictmgr-hint {
  margin-bottom: 12px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 12px;
  line-height: 1.5;
}
.dictmgr-hint.small {
  margin: 4px 0 8px;
  background: none;
  padding: 0;
  color: var(--text3);
}
.dictmgr-section-title {
  margin: 14px 0 8px;
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text2);
}
.dictmgr-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.dictmgr-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 11px;
  border-radius: 10px;
  background: var(--card2);
  border: 1px solid var(--border);
}
.dictmgr-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.dictmgr-item-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dictmgr-role {
  flex-shrink: 0;
  padding: 1px 7px;
  border-radius: 6px;
  font-size: 10.5px;
  font-weight: 700;
  color: #fff;
}
.dictmgr-role.define {
  background: #3b82f6;
}
.dictmgr-role.frequency {
  background: #e6a817;
}
.dictmgr-item-path {
  font-size: 11px;
  color: var(--text3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl; /* 长路径：保留尾部文件名可见 */
  text-align: left;
}
.dictmgr-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.dictmgr-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text2);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  transition: all 0.12s;
}
.dictmgr-btn:hover {
  border-color: var(--accent);
  color: var(--text);
}
.dictmgr-btn.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
}
.dictmgr-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.dictmgr-btn.danger:hover {
  border-color: #ff6b6b;
  color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 10%, transparent);
}
.dictmgr-btn.primary {
  border: none;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.dictmgr-btn.primary:hover {
  filter: brightness(1.08);
}
.dictmgr-btn.primary:disabled {
  opacity: 0.6;
}
.dictmgr-btn.primary.small {
  padding: 4px 10px;
  font-size: 11.5px;
}
.dictmgr-switch {
  position: relative;
  width: 34px;
  height: 19px;
  border-radius: 10px;
  border: none;
  background: var(--border);
  transition: background 0.15s;
  flex-shrink: 0;
}
.dictmgr-switch.on {
  background: var(--accent);
}
.dictmgr-switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 15px;
  height: 15px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
}
.dictmgr-switch.on .dictmgr-switch-knob {
  left: 17px;
}
.dictmgr-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 18px;
  border: 1px dashed var(--border);
  border-radius: 10px;
  color: var(--text2);
  font-size: 13px;
  text-align: center;
}
.dictmgr-empty-icon {
  color: var(--text3);
  opacity: 0.6;
}
.dictmgr-empty-hint {
  font-size: 12px;
  color: var(--text3);
}
.dictmgr-mode-row {
  display: flex;
  gap: 8px;
  margin-bottom: 4px;
}
.dictmgr-mode {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  padding: 8px 10px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.12s;
}
.dictmgr-mode:hover {
  border-color: var(--accent);
}
.dictmgr-mode.on {
  border-color: var(--accent);
  background: var(--accent-soft);
  color: var(--accent-text);
}
.dictmgr-mode input {
  accent-color: var(--accent);
  margin: 0;
}
.dictmgr-copy .dictmgr-upload {
  margin-top: 4px;
}
.dictmgr-link > .dictmgr-btn.primary {
  width: 100%;
  justify-content: center;
  margin-bottom: 8px;
}
.dictmgr-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dictmgr-candidate-check {
  accent-color: var(--accent);
  flex-shrink: 0;
  margin: 0;
}
.dictmgr-add-selected {
  align-self: flex-end;
  margin-top: 2px;
}
.dictmgr-input {
  flex: 1;
  min-width: 0;
  padding: 8px 11px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  font-size: 12.5px;
  outline: none;
  transition: border-color 0.12s;
}
.dictmgr-input:focus {
  border-color: var(--accent);
}
.dictmgr-candidates {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 8px;
}
.dictmgr-candidate {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--card2);
}
.dictmgr-candidate-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dictmgr-candidate-meta {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
}
.dictmgr-scan-empty {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text3);
}
.dictmgr-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 12px;
  border: 1.5px dashed var(--border);
  border-radius: 10px;
  color: var(--text2);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.12s;
}
.dictmgr-upload:hover {
  border-color: var(--accent);
  color: var(--accent-text);
}
.dictmgr-upload input {
  display: none;
}
.dictmgr-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.dictmgr-progress-bar {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: var(--bg2);
  overflow: hidden;
}
.dictmgr-progress-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  transition: width 0.15s;
}
.dictmgr-progress-text {
  font-size: 11.5px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
  min-width: 36px;
  text-align: right;
}
.dictmgr-spin {
  animation: dictmgr-spin 1.1s linear infinite;
}
@keyframes dictmgr-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
