<template>
  <div class="msc-page">
    <!-- 头部：返回 + 标题 + 上次同步时间（嵌入式模式隐藏：头部由 MobileSettings 提供） -->
    <header v-if="!embedded" class="msc-head">
      <button class="msc-back" :title="t('mobile.list.back')" @click="$emit('back')">
        <ChevronLeft :size="24" />
      </button>
      <div class="msc-head-main">
        <h1 class="msc-title">{{ t("mobile.syncCenter.title") }}</h1>
        <span class="msc-last">{{ lastSyncText }}</span>
      </div>
    </header>

    <div class="msc-scroll">
      <!-- ✒️ 阅读标注 + 生词（manifest annotations/vocab：随同步自动拉取，非文件下载） -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <PenLine :size="14" />
          {{ t("mobile.syncCenter.readerData") }}
        </h2>
        <div class="msc-item">
          <div class="msc-label">{{ t("mobile.syncCenter.readerDataLabel") }}</div>
          <div class="msc-desc">{{ t("mobile.syncCenter.readerDataDesc") }}</div>
          <button class="msc-btn primary" :disabled="syncBusy" @click="refreshReaderData(true)">
            {{ t("mobile.syncCenter.readerDataGo") }}
          </button>
        </div>
        <div v-if="readerDataSummary" class="msc-item">
          <div class="msc-desc">{{ readerDataSummary }}</div>
        </div>
        <div v-else class="msc-item">
          <div class="msc-desc">{{ t("mobile.syncCenter.readerDataEmpty") }}</div>
        </div>
      </section>

      <!-- 📚 词典（manifest dicts：清单来自主机端，文件下载由伴侣端自行处理） -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <BookMarked :size="14" />
          {{ t("mobile.syncCenter.dicts") }}
        </h2>
        <div v-if="dictRows.length" class="msc-dict-list">
          <div v-for="row in dictRows" :key="row.item.path" class="msc-dict-row">
            <div class="msc-dict-info">
              <span class="sync-dl-name" :title="row.item.path">{{
                row.dict.title || row.dict.name || row.item.path
              }}</span>
            </div>
          </div>
        </div>
        <div v-else class="msc-item">
          <div class="msc-desc">{{ t("mobile.syncCenter.dictEmpty") }}</div>
        </div>
      </section>

      <!-- 开关组：仅 Wi-Fi / 自动更新 / 自动预取（同步偏好，主机端与伴侣端共用） -->
      <section class="msc-group">
        <div class="msc-item msc-toggle-row" @click="toggleWifiOnly">
          <div>
            <div class="msc-label">{{ t("mobile.syncCenter.wifiOnly") }}</div>
            <div class="msc-desc">{{ t("mobile.syncCenter.wifiOnlyDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: wifiOnlyOn }"><i /></span>
        </div>
        <div class="msc-item msc-toggle-row" @click="toggleAutoUpdate">
          <div>
            <div class="msc-label">{{ t("mobile.syncCenter.autoUpdate") }}</div>
            <div class="msc-desc">{{ t("mobile.syncCenter.autoUpdateDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: autoUpdateOn }"><i /></span>
        </div>
        <div class="msc-item msc-toggle-row" @click="togglePrefetch">
          <div>
            <div class="msc-label">{{ t("settings.syncPrefetch") }}</div>
            <div class="msc-desc">{{ t("settings.syncPrefetchDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: autoPrefetchOn }"><i /></span>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
// 同步面板（负一屏 / 移动设置区）——数据层部分。
// 设备端链路（资产下载/回执、指令轮询、本地文件与 assetIndex 管理）随 iOS 壳 2026-09-13
// 退役一并移除；此面板保留主机端清单相关能力：阅读标注/生词状态、词典清单、同步偏好开关。
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronLeft, PenLine, BookMarked } from "@lucide/vue";
import { apiGet } from "../../utils/apiClient.js";
import { getCache } from "../../utils/cacheDb.js";
import {
  syncNow,
  syncState,
  assetForDict,
  wifiOnlyEnabled,
  setWifiOnly,
  autoUpdateEnabled,
  setAutoUpdate,
  autoPrefetchEnabled,
  setAutoPrefetch,
} from "../../utils/sync.js";

defineEmits(["back"]);
defineProps({
  // 嵌入式面板模式（负一屏设置区）：隐藏自身头部（返回/标题/上次同步时间），由 MobileSettings 统一头部提供
  embedded: { type: Boolean, default: false },
});
const { t } = useI18n();

/** manifest dicts 条目（宽松视图，运行时零变化） */
interface DictLike {
  path?: string;
  name?: string;
  title?: string;
  url?: string;
  sha256?: string;
  size?: number;
}
/** 词典下载项（assetForDict 产物；字段与 sync.ts 的 DownloadItem 对齐） */
interface DownloadItemLike {
  path: string;
  url: string;
  sha256: string;
  size: number;
}
interface DictRow {
  dict: DictLike;
  item: DownloadItemLike;
}

// ---------- 头部 ----------
const lastSyncText = computed(() => {
  if (!syncState.lastSyncAt) return t("settings.syncLastTimeNever");
  return new Date(syncState.lastSyncAt).toLocaleString();
});

// 拉清单/刷新阅读数据期间禁用按钮（防重复提交）
const syncBusy = ref(false);

// ---------- 词典区 ----------
const dicts = ref<DictLike[]>([]); // manifest dicts 条目
const dictItems = ref<DownloadItemLike[]>([]); // assetForDict 产物

// dict 条目与下载项按下标配对（assetForDict 过滤 null 时同步过滤）
const dictRows = computed<DictRow[]>(() => {
  const rows: DictRow[] = [];
  const ds = dicts.value;
  for (let i = 0; i < ds.length; i++) {
    const item = dictItems.value[i];
    if (item) rows.push({ dict: ds[i], item });
  }
  return rows;
});

async function loadDicts(): Promise<DictLike[]> {
  let dictsCache = await getCache("sync:dicts");
  if (!Array.isArray(dictsCache) || !dictsCache.length) {
    try {
      const r = await apiGet("/api/sync/manifest");
      if (r.ok && r.data && Array.isArray(r.data.dicts)) dictsCache = r.data.dicts;
    } catch {
      /* 留空 */
    }
  }
  return Array.isArray(dictsCache) ? dictsCache : [];
}

async function refreshDicts() {
  const ds = await loadDicts();
  dicts.value = ds;
  dictItems.value = (await Promise.all(ds.map((d) => assetForDict(d)))).filter(
    (it): it is DownloadItemLike => !!it,
  );
}

// ---------- 阅读标注 + 生词（manifest annotations/vocab：数据随同步拉取，非文件下载） ----------
const readerData = ref({ books: 0, vocab: 0 }); // 有标注的书数 / 生词数

/** 汇总文案：有数据时展示「N 本书标注 · M 个生词」；都空时返回空串（UI 显空态文案） */
const readerDataSummary = computed(() => {
  const { books, vocab } = readerData.value;
  if (!books && !vocab) return "";
  return t("mobile.syncCenter.readerDataSynced", { books, vocab });
});

/** 刷新标注/生词状态；reSync=true 时先拉最新 manifest（annotations/vocab 自动合并进缓存） */
async function refreshReaderData(reSync = false) {
  if (reSync && !syncBusy.value) {
    syncBusy.value = true;
    try {
      await syncNow();
    } finally {
      syncBusy.value = false;
    }
  }
  const [ann, voc] = await Promise.all([getCache("sync:annotations"), getCache("sync:vocab")]);
  readerData.value = {
    books: Array.isArray(ann) ? ann.length : 0,
    vocab: Array.isArray(voc) ? voc.length : 0,
  };
}

// ---------- 开关组 ----------
const wifiOnlyOn = ref(wifiOnlyEnabled());
const autoUpdateOn = ref(autoUpdateEnabled());
const autoPrefetchOn = ref(autoPrefetchEnabled());

function toggleWifiOnly() {
  wifiOnlyOn.value = setWifiOnly(!wifiOnlyOn.value);
}
function toggleAutoUpdate() {
  autoUpdateOn.value = setAutoUpdate(!autoUpdateOn.value);
}
function togglePrefetch() {
  autoPrefetchOn.value = setAutoPrefetch(!autoPrefetchOn.value);
}

// ---------- 挂载：拉清单（含词典缓存）+ 阅读数据 ----------
onMounted(() => {
  syncNow().catch(() => {});
  refreshDicts();
  refreshReaderData();
});

// 供测试/调试：强制刷新词典清单与阅读数据
defineExpose({ refreshDicts, refreshReaderData });
</script>

<style scoped>
.msc-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  background: var(--bg);
}
.msc-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 4px;
  padding-top: calc(12px + env(safe-area-inset-top));
}
.msc-back {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card);
  border: 1px solid var(--border);
  transition: all 0.15s;
  touch-action: manipulation;
  flex-shrink: 0;
}
.msc-back:active {
  background: var(--card2);
  color: var(--text);
  transform: scale(0.92);
}
.msc-head-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.msc-title {
  font-size: 20px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msc-last {
  font-size: 12px;
  color: var(--text3);
}
.msc-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px 14px 24px;
  -webkit-overflow-scrolling: touch;
}
/* 主按钮 */
.msc-hero {
  margin-bottom: 14px;
}
.msc-sync-all {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 14px;
  border-radius: 16px;
  border: none;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 4px 16px var(--accent-glow2);
  transition: all 0.15s;
  touch-action: manipulation;
}
.msc-sync-all:active {
  transform: scale(0.98);
}
.msc-sync-all:disabled {
  opacity: 0.6;
}
.msc-sync-all .spinning {
  animation: msc-spin 0.9s linear infinite;
}
@keyframes msc-spin {
  to {
    transform: rotate(360deg);
  }
}
.msc-badge {
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  border-radius: 999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 800;
  color: var(--accent);
  background: #fff;
}
.msc-desc {
  font-size: 12px;
  color: var(--text3);
  margin-top: 6px;
  line-height: 1.5;
}
.msc-error {
  font-size: 12px;
  color: #ff6b6b;
  margin-top: 8px;
}
/* 分组 */
.msc-group {
  border: 1px solid var(--border);
  border-radius: 16px;
  background: var(--card);
  padding: 4px 14px 12px;
  margin-bottom: 14px;
}
.msc-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 700;
  color: var(--text2);
  padding: 12px 0 4px;
}
.msc-item {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.msc-label {
  font-size: 13px;
  font-weight: 600;
}
.msc-row {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-top: 8px;
}
.msc-select {
  flex: 1;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  font-size: 13px;
}
.msc-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
  font-size: 12px;
}
.msc-btn {
  margin-top: 8px;
  padding: 8px 14px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  transition: all 0.15s;
  touch-action: manipulation;
}
.msc-btn.primary {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  border-color: transparent;
}
.msc-btn.danger {
  color: #ff6b6b;
  border-color: color-mix(in srgb, #ff6b6b 40%, var(--border));
}
.msc-btn:disabled {
  opacity: 0.5;
}
/* 词典列表 */
.msc-dict-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 4px;
}
.msc-dict-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2);
}
.msc-dict-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.msc-dict-row .msc-btn {
  margin-top: 0;
  padding: 6px 10px;
  flex-shrink: 0;
}
/* 下载面板（迁移自 SettingsModal） */
.progress-bar {
  width: 100%;
  height: 6px;
  border-radius: 3px;
  background: var(--border);
  overflow: hidden;
  margin-top: 8px;
}
.progress-fill {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  transition: width 0.2s ease;
}
.sync-stats {
  display: flex;
  gap: 6px;
  align-items: center;
}
.sync-dl-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0;
}
.sync-dl-item {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
  background: var(--bg2);
}
.sync-dl-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sync-dl-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-dl-status {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.sync-dl-status.st-queued {
  color: var(--text2);
  background: var(--border);
}
.sync-dl-status.st-downloading {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 15%, transparent);
}
.sync-dl-status.st-done {
  color: #2e9e5b;
  background: color-mix(in srgb, #2e9e5b 15%, transparent);
}
.sync-dl-status.st-failed {
  color: #ff6b6b;
  background: color-mix(in srgb, #ff6b6b 15%, transparent);
}
/* 多选面板（迁移） */
.sync-picker {
  margin-top: 10px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px;
  background: var(--bg2);
}
.sync-picker-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 6px;
}
.sync-picker-toolbar .msc-input {
  padding: 4px 8px;
  font-size: 12px;
}
.sync-picker-list {
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
}
.sync-picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
}
.sync-picker-item + .sync-picker-item {
  border-top: 1px solid var(--border);
}
.sync-picker-item input {
  accent-color: var(--accent);
}
.sync-picker-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-picker-meta {
  color: var(--text3);
  font-size: 11px;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-picker-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
.mini-btn {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--text2);
  background: var(--bg);
  border: 1px solid var(--border);
  transition: all 0.15s;
  flex-shrink: 0;
}
/* 存储管理 */
.msc-storage-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
}
.msc-storage-row:first-child {
  border-top: none;
}
.msc-storage-info {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.msc-storage-name {
  font-size: 13px;
  font-weight: 600;
}
.msc-storage-bytes {
  font-size: 12px;
  color: var(--text3);
}
.msc-storage-row .msc-btn {
  margin-top: 0;
  padding: 6px 10px;
  flex-shrink: 0;
}
/* 开关组 */
.msc-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
}
.msc-toggle-row .msc-desc {
  margin-top: 2px;
}
.switch {
  flex-shrink: 0;
  width: 46px;
  height: 28px;
  border-radius: 999px;
  background: var(--border);
  position: relative;
  transition: background 0.2s;
  display: inline-block;
}
.switch i {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 2px 6px var(--shadow-sm);
  transition: left 0.2s;
}
.switch.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.switch.on i {
  left: 20px;
}
</style>
