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

        <!-- 添加方式 1：本地路径扫描 -->
        <p class="dictmgr-section-title">{{ t("books.dictPath") }}</p>
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
            <span class="dictmgr-candidate-name">{{ c.name }}</span>
            <span class="dictmgr-candidate-meta">
              {{ fmtSize(c.size) }}{{ c.mddExists ? " +mdd" : "" }}
            </span>
            <button class="dictmgr-btn primary small" :disabled="adding" @click="addByCandidate(c)">
              {{ t("books.dictAdd") }}
            </button>
          </div>
        </div>
        <p v-else-if="scanned && !scanning" class="dictmgr-scan-empty">
          {{ t("books.dictScanEmpty") }}
        </p>

        <!-- 添加方式 2：上传 -->
        <p class="dictmgr-section-title">{{ t("books.dictUpload") }}</p>
        <p class="dictmgr-hint small">{{ t("books.dictUploadHint") }}</p>
        <label class="dictmgr-upload">
          <Loader2 v-if="uploading" :size="15" class="dictmgr-spin" />
          <Upload v-else :size="15" />
          {{ uploading ? t("books.dictUploading") : t("books.dictUpload") }}
          <input type="file" accept=".mdx,.mdd" :disabled="uploading" @change="onFilePicked" />
        </label>
        <div v-if="uploading" class="dictmgr-progress">
          <div class="dictmgr-progress-bar">
            <div class="dictmgr-progress-fill" :style="{ width: uploadProgress + '%' }" />
          </div>
          <span class="dictmgr-progress-text">{{ uploadName }} {{ uploadProgress }}%</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { BookMarked, FolderSearch, Loader2, Trash2, Upload, X } from "@lucide/vue";
import type { DictConfig, DictScanCandidate } from "./types";
import {
  activateDict,
  addDict,
  deleteDict,
  fetchDictSettings,
  scanDictPath,
  setDictEnabled,
  uploadDictFile,
} from "./annotations";
import { showToast, toastError } from "../composables/useToast.js";

const emit = defineEmits<{ close: []; changed: [] }>();

const { t } = useI18n();

const dicts = ref<DictConfig[]>([]);
const activeDictId = ref("");
const pathInput = ref("");
const scanCandidates = ref<DictScanCandidate[]>([]);
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

async function addByCandidate(c: DictScanCandidate) {
  adding.value = true;
  try {
    await addDict(c.path);
    showToast(t("books.dictAdded"));
    await refresh();
  } catch (e) {
    toastError(e instanceof Error ? e.message : t("books.dictLoadFailed"));
  } finally {
    adding.value = false;
  }
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

async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ""; // 允许重复选择同一文件
  if (!file) return;
  uploading.value = true;
  uploadProgress.value = 0;
  uploadName.value = file.name;
  try {
    await uploadDictFile(file, (p) => {
      uploadProgress.value = p;
    });
    showToast(t("books.dictUploadDone"));
    await refresh();
  } catch (err) {
    toastError(t("books.dictUploadFailed", { msg: err instanceof Error ? err.message : "" }));
  } finally {
    uploading.value = false;
  }
}

onMounted(refresh);
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
.dictmgr-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
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
