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
      <!-- 主按钮：同步全部（一键拉全：音乐音频+封面+歌词、图书、有声书=图书、词典） -->
      <section class="msc-hero">
        <button class="msc-sync-all" :disabled="syncState.syncing || syncBusy" @click="onSyncAll">
          <RefreshCw :size="18" :class="{ spinning: syncState.syncing }" />
          <span>{{ t("mobile.syncCenter.syncAll") }}</span>
          <span v-if="badgeCount" class="msc-badge">{{ badgeCount }}</span>
        </button>
        <p class="msc-desc">{{ t("mobile.syncCenter.syncAllDesc") }}</p>
        <p v-if="syncState.lastError" class="msc-error">
          {{ t("settings.syncFailed", { msg: syncState.lastError }) }}
        </p>
      </section>

      <!-- 🎵 音乐 -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <Music2 :size="14" />
          {{ t("settings.syncMusic") }}
        </h2>
        <div class="msc-item">
          <div class="msc-label">{{ t("settings.syncAllSongs") }}</div>
          <div class="msc-desc">{{ t("settings.syncAllSongsDesc") }}</div>
          <button class="msc-btn primary" :disabled="syncBusy" @click="syncAllSongs">
            {{ t("settings.syncStart") }}
          </button>
        </div>
        <div class="msc-item">
          <div class="msc-label">{{ t("settings.syncPlaylist") }}</div>
          <div class="msc-desc">{{ t("settings.syncPlaylistDesc") }}</div>
          <div class="msc-row">
            <select v-model="syncPlaylistId" class="msc-select" :disabled="syncBusy">
              <option value="">{{ t("settings.syncPlaylistPlaceholder") }}</option>
              <option v-for="p in playlists" :key="p.id" :value="p.id">{{ p.name }}</option>
            </select>
            <button
              class="msc-btn primary"
              :disabled="syncBusy || !syncPlaylistId"
              @click="syncSelectedPlaylist"
            >
              {{ t("settings.syncStart") }}
            </button>
          </div>
        </div>
        <div class="msc-item">
          <div class="msc-label">{{ t("settings.syncPickSongs") }}</div>
          <div class="msc-desc">{{ t("settings.syncPickDesc") }}</div>
          <button class="msc-btn" :disabled="syncBusy" @click="openPicker('songs')">
            {{ t("settings.syncPickOpen") }}
          </button>
          <div v-if="picker === 'songs'" class="sync-picker">
            <div class="sync-picker-toolbar">
              <input
                v-model="pickerSearch"
                class="msc-input"
                :placeholder="t('settings.syncSearch')"
                spellcheck="false"
              />
              <button class="mini-btn" @click="togglePickerAll">
                {{ t("settings.syncPickAll") }}
              </button>
              <button class="mini-btn" @click="picker = ''">
                {{ t("settings.syncPickCancel") }}
              </button>
            </div>
            <div class="sync-picker-list">
              <label v-for="s in filteredSongs" :key="s.path" class="sync-picker-item">
                <input v-model="pickerSelected" type="checkbox" :value="s.path" />
                <span class="sync-picker-name">{{ s.name }}</span>
                <span class="sync-picker-meta">{{ s.artist }}</span>
              </label>
              <div v-if="!filteredSongs.length" class="msc-desc">
                {{ t("settings.syncPickEmpty") }}
              </div>
            </div>
            <div class="sync-picker-footer">
              <span class="msc-desc">{{
                t("settings.syncPickCount", { n: pickerSelected.length })
              }}</span>
              <button
                class="msc-btn primary"
                :disabled="!pickerSelected.length || syncBusy"
                @click="downloadPickedSongs"
              >
                {{ t("settings.syncPickConfirm") }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 📖 图书（含有声书：同一离线链路） -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <BookOpen :size="14" />
          {{ t("settings.syncBooks") }}
        </h2>
        <div class="msc-item">
          <div class="msc-label">{{ t("settings.syncAllBooks") }}</div>
          <div class="msc-desc">{{ t("settings.syncAllBooksDesc") }}</div>
          <button class="msc-btn primary" :disabled="syncBusy" @click="syncAllBooks">
            {{ t("settings.syncStart") }}
          </button>
        </div>
        <div class="msc-item">
          <div class="msc-label">{{ t("settings.syncPickBooks") }}</div>
          <div class="msc-desc">{{ t("settings.syncPickDesc") }}</div>
          <button class="msc-btn" :disabled="syncBusy" @click="openPicker('books')">
            {{ t("settings.syncPickOpen") }}
          </button>
          <div v-if="picker === 'books'" class="sync-picker">
            <div class="sync-picker-toolbar">
              <input
                v-model="pickerSearch"
                class="msc-input"
                :placeholder="t('settings.syncSearch')"
                spellcheck="false"
              />
              <button class="mini-btn" @click="togglePickerAll">
                {{ t("settings.syncPickAll") }}
              </button>
              <button class="mini-btn" @click="picker = ''">
                {{ t("settings.syncPickCancel") }}
              </button>
            </div>
            <div class="sync-picker-list">
              <label v-for="b in filteredBooks" :key="b.id" class="sync-picker-item">
                <input v-model="pickerSelected" type="checkbox" :value="b.id" />
                <span class="sync-picker-name">{{ b.title }}</span>
                <span class="sync-picker-meta">{{ b.author }}</span>
              </label>
              <div v-if="!filteredBooks.length" class="msc-desc">
                {{ t("settings.syncPickEmpty") }}
              </div>
            </div>
            <div class="sync-picker-footer">
              <span class="msc-desc">{{
                t("settings.syncPickCount", { n: pickerSelected.length })
              }}</span>
              <button
                class="msc-btn primary"
                :disabled="!pickerSelected.length || syncBusy"
                @click="downloadPickedBooks"
              >
                {{ t("settings.syncPickConfirm") }}
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 📚 词典（manifest dicts） -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <BookMarked :size="14" />
          {{ t("mobile.syncCenter.dicts") }}
        </h2>
        <div class="msc-item">
          <div class="msc-desc">{{ t("mobile.syncCenter.dictsDesc") }}</div>
          <button
            class="msc-btn primary"
            :disabled="syncBusy || !dictItems.length"
            @click="downloadAllDicts"
          >
            {{ t("mobile.syncCenter.dictAll") }}
          </button>
        </div>
        <div v-if="dictRows.length" class="msc-dict-list">
          <div v-for="row in dictRows" :key="row.item.path" class="msc-dict-row">
            <div class="msc-dict-info">
              <span class="sync-dl-name" :title="row.item.path">{{
                row.dict.title || row.dict.name || row.item.path
              }}</span>
              <span
                v-if="dictStatus(row.item)"
                class="sync-dl-status"
                :class="'st-' + dictStatus(row.item)"
                >{{ statusLabel(dictStatus(row.item)) }}</span
              >
            </div>
            <button class="msc-btn danger" :disabled="syncBusy" @click="deleteDict(row.item)">
              {{ t("mobile.syncCenter.dictDelete") }}
            </button>
          </div>
        </div>
        <div v-else class="msc-item">
          <div class="msc-desc">{{ t("mobile.syncCenter.dictEmpty") }}</div>
        </div>
      </section>

      <!-- 下载状态面板（聚合视图：hash 文件名无意义，汇总进度 + 活跃项 + 失败重试） -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <Download :size="14" />
          {{ t("settings.syncDownloads") }}
        </h2>
        <template v-if="downloadSummary.total">
          <div class="msc-item">
            <div class="msc-desc sync-dl-progress-text">
              {{
                t("settings.syncDlProgress", {
                  done: downloadSummary.done,
                  total: downloadSummary.total,
                })
              }}
            </div>
            <div class="progress-bar">
              <div class="progress-fill" :style="{ width: downloadSummary.pct + '%' }" />
            </div>
          </div>
          <div class="msc-item">
            <div class="msc-desc sync-stats">
              <span>{{ t("settings.syncDlActive", { n: downloadStats.active }) }}</span>
              <span>·</span>
              <span>{{ t("settings.syncDlQueued", { n: downloadStats.queued }) }}</span>
              <span>·</span>
              <span>{{ t("settings.syncDlFailed", { n: downloadStats.failed }) }}</span>
            </div>
            <button class="msc-btn" :disabled="!downloadStats.finished" @click="clearFinished">
              {{ t("settings.syncClearFinished") }}
            </button>
          </div>
          <!-- 活跃下载（原生并发 ≤3，逐个实时进度） -->
          <div v-if="activeList.length" class="sync-dl-list">
            <div v-for="d in activeList" :key="d.path" class="sync-dl-item">
              <div class="sync-dl-head">
                <span class="sync-dl-name" :title="d.path">{{ d.name }}</span>
                <span class="sync-dl-status" :class="'st-' + d.status">{{
                  statusLabel(d.status)
                }}</span>
              </div>
              <div class="progress-bar">
                <div class="progress-fill" :style="{ width: dlPercent(d) + '%' }" />
              </div>
            </div>
          </div>
          <!-- 失败：计数 + 全部重试 -->
          <div v-if="downloadStats.failed" class="msc-item">
            <div class="msc-desc">
              {{ t("settings.syncDlFailedDesc", { n: downloadStats.failed }) }}
            </div>
            <button class="msc-btn" :disabled="syncBusy" @click="retryAllFailed">
              {{ t("settings.syncRetryAll") }}
            </button>
          </div>
        </template>
        <div v-else class="msc-item">
          <div class="msc-desc">{{ t("settings.syncDlEmpty") }}</div>
        </div>
      </section>

      <!-- 存储管理：按类型占用 + 清理（assetIndex 前缀过滤 → deleteAssets {paths}）+ 全清 -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <Database :size="14" />
          {{ t("settings.syncStorage") }}
        </h2>
        <div v-if="storageRows.length" class="msc-item">
          <div v-for="row in storageRows" :key="row.key" class="msc-storage-row">
            <div class="msc-storage-info">
              <span class="msc-storage-name">{{ t(row.labelKey) }}</span>
              <span class="msc-storage-bytes">{{ formatBytes(row.bytes) }}</span>
            </div>
            <button
              class="msc-btn danger"
              :disabled="!row.bytes || syncBusy"
              @click="clearType(row)"
            >
              {{ t("mobile.syncCenter.clearType") }}
            </button>
          </div>
          <div class="msc-storage-row">
            <div class="msc-storage-info">
              <span class="msc-storage-name">{{ t("mobile.syncCenter.typeOther") }}</span>
              <span class="msc-storage-bytes">{{ formatBytes(otherBytes) }}</span>
            </div>
          </div>
          <div class="msc-storage-row">
            <div class="msc-storage-info">
              <span class="msc-storage-name">{{ t("settings.syncStorageUsed") }}</span>
              <span class="msc-storage-bytes">{{ formatBytes(storageTotal) }}</span>
            </div>
            <button class="msc-btn" @click="refreshStorage">
              {{ t("settings.syncStorageRefresh") }}
            </button>
          </div>
        </div>
        <div v-else class="msc-item">
          <div class="msc-desc">{{ t("settings.syncStorageUnknown") }}</div>
        </div>
        <div class="msc-item">
          <div class="msc-label">{{ t("settings.syncClearAll") }}</div>
          <div class="msc-desc">{{ t("settings.syncClearAllDesc") }}</div>
          <button class="msc-btn danger" @click="toggleClearAll">
            {{ clearAllArmed ? t("settings.syncClearAllConfirmGo") : t("settings.syncClearAllGo") }}
          </button>
        </div>
      </section>

      <!-- 清理未引用（清单中已不存在的本地残留资产） -->
      <section class="msc-group">
        <h2 class="msc-group-title">
          <Trash2 :size="14" />
          {{ t("mobile.syncCenter.orphans") }}
        </h2>
        <div class="msc-item">
          <div class="msc-desc">{{ t("mobile.syncCenter.orphansDesc") }}</div>
          <div class="msc-desc">
            {{
              orphanSize
                ? t("mobile.syncCenter.orphansFree", { size: formatBytes(orphanSize) })
                : t("mobile.syncCenter.orphansEmpty")
            }}
          </div>
          <button class="msc-btn danger" :disabled="!orphanSize || syncBusy" @click="cleanOrphans">
            {{
              orphanArmed
                ? t("mobile.syncCenter.orphansConfirmGo")
                : t("mobile.syncCenter.orphansGo")
            }}
          </button>
        </div>
      </section>

      <!-- 开关组：仅 Wi-Fi / 自动更新 / 自动预取 -->
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

<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  ChevronLeft,
  RefreshCw,
  Music2,
  BookOpen,
  BookMarked,
  Download,
  Database,
  Trash2,
} from "@lucide/vue";
import { apiGet } from "../../utils/apiClient.js";
import { getCache } from "../../utils/cacheDb.js";
import { showToast } from "../../composables/useToast.js";
import {
  syncState,
  syncDownloads,
  syncNow,
  syncAssets,
  buildSongSyncItems,
  syncLyricsForSongs,
  buildBookItems,
  assetForDict,
  clearFinished,
  retryFailed,
  clearAssets,
  clearAssetsByType,
  deleteOrphanAssets,
  waitAssetsDeleted,
  fetchAssetsSizeDetailed,
  computeSyncOverview,
  syncAll,
  autoPrefetchEnabled,
  setAutoPrefetch,
  wifiOnlyEnabled,
  setWifiOnly,
  autoUpdateEnabled,
  setAutoUpdate,
} from "../../utils/sync.js";

defineEmits(["back"]);
defineProps({
  // 嵌入式面板模式（负一屏设置区）：隐藏自身头部（返回/标题/上次同步时间），由 MobileSettings 统一头部提供
  embedded: { type: Boolean, default: false },
});
const { t } = useI18n();
// ---------- 头部 ----------
const lastSyncText = computed(() => {
  if (!syncState.lastSyncAt) return t("settings.syncLastTimeNever");
  return new Date(syncState.lastSyncAt).toLocaleString();
});

// ---------- 主按钮 / 总览（缺失 + 可更新徽标 / 孤儿 / 存储） ----------
const syncBusy = ref(false); // 批量下载动作进行中（按钮禁用，防重复提交）
const overview = ref(null); // computeSyncOverview 结果
const missingTotal = computed(() => {
  const m = overview.value?.missing;
  if (!m) return 0;
  return m.audio + m.covers + m.books + m.dicts;
});
const badgeCount = computed(() => missingTotal.value + (overview.value?.updateCount || 0));
const orphanSize = computed(() => overview.value?.orphanSize || 0);

async function refreshOverview() {
  overview.value = await computeSyncOverview();
}

async function onSyncAll() {
  if (syncBusy.value || syncState.syncing) return;
  syncBusy.value = true;
  try {
    const r = await syncAll();
    if (r && r.ok) {
      const m = r.missing || { audio: 0, covers: 0, books: 0, dicts: 0 };
      const n = m.audio + m.covers + m.books + m.dicts;
      showToast(t("mobile.syncCenter.syncAllDone", { n }));
    }
  } finally {
    syncBusy.value = false;
    await Promise.all([refreshOverview(), refreshStorage(), refreshDicts()]);
  }
}

// ---------- 音乐 / 图书（自 SettingsModal 同步 tab 迁移） ----------
const playlists = ref([]); // /api/playlists 列表（歌单下拉）
const syncPlaylistId = ref("");
const allSongs = ref([]); // /api/songs 本地歌曲（手动选择面板数据）
const allBooks = ref([]); // /api/books 列表（手动选择面板数据）
const picker = ref(""); // '' | 'songs' | 'books'（内联多选面板）
const pickerSearch = ref("");
const pickerSelected = ref([]); // songs: path[]；books: id[]

const filteredSongs = computed(() => {
  const q = pickerSearch.value.trim().toLowerCase();
  if (!q) return allSongs.value;
  return allSongs.value.filter((s) => (s.name || "").toLowerCase().includes(q));
});
const filteredBooks = computed(() => {
  const q = pickerSearch.value.trim().toLowerCase();
  if (!q) return allBooks.value;
  return allBooks.value.filter((b) => (b.title || "").toLowerCase().includes(q));
});

function toastFetchFailed() {
  showToast(t("settings.syncFetchFailed"), { type: "error" });
}

async function loadPlaylists() {
  try {
    const r = await apiGet("/api/playlists");
    if (r.ok && r.data && Array.isArray(r.data.playlists)) playlists.value = r.data.playlists;
  } catch {
    /* 静默（下拉留空） */
  }
}

async function syncAllSongs() {
  if (syncBusy.value) return;
  syncBusy.value = true;
  try {
    const r = await apiGet("/api/songs");
    const songs = (r.ok && Array.isArray(r.data) ? r.data : []).filter((s) => s && s.path);
    if (!songs.length) {
      toastFetchFailed();
      return;
    }
    // 音频+封面下载项（封面随歌一起同步；items.length 含封面，面板计数自动覆盖）
    const items = await buildSongSyncItems(songs);
    if (syncAssets(items)) showToast(t("settings.syncStarted", { n: items.length }));
    // 歌词落文件（fire-and-forget）：与音频下载并行不阻塞；完成后 toast 一次
    syncLyricsForSongs(songs).then((r) => {
      if (r && r.ok > 0) showToast(t("settings.syncLyricsDone", { n: r.ok }));
    });
  } catch {
    toastFetchFailed();
  } finally {
    syncBusy.value = false;
  }
}

async function syncSelectedPlaylist() {
  const pid = syncPlaylistId.value;
  if (!pid || syncBusy.value) return;
  syncBusy.value = true;
  try {
    const [pr, sr] = await Promise.all([apiGet("/api/playlists"), apiGet("/api/songs")]);
    const pl = ((pr.ok && pr.data && pr.data.playlists) || []).find((p) => p.id === pid);
    if (!pl) {
      toastFetchFailed();
      return;
    }
    const paths = new Set(pl.songPaths || []);
    const songs = (sr.ok && Array.isArray(sr.data) ? sr.data : []).filter(
      (s) => s && s.path && paths.has(s.path),
    );
    if (!songs.length) {
      toastFetchFailed();
      return;
    }
    const items = await buildSongSyncItems(songs);
    if (syncAssets(items)) showToast(t("settings.syncStarted", { n: items.length }));
    syncLyricsForSongs(songs).then((r) => {
      if (r && r.ok > 0) showToast(t("settings.syncLyricsDone", { n: r.ok }));
    });
  } catch {
    toastFetchFailed();
  } finally {
    syncBusy.value = false;
  }
}

async function syncAllBooks() {
  if (syncBusy.value) return;
  syncBusy.value = true;
  try {
    const r = await apiGet("/api/books");
    const books = r.ok && Array.isArray(r.data) ? r.data : [];
    if (!books.length) {
      toastFetchFailed();
      return;
    }
    const items = await buildBookItems(books);
    if (syncAssets(items)) showToast(t("settings.syncStarted", { n: items.length }));
  } catch {
    toastFetchFailed();
  } finally {
    syncBusy.value = false;
  }
}

async function openPicker(which) {
  if (picker.value === which) {
    picker.value = "";
    return;
  }
  picker.value = which;
  pickerSearch.value = "";
  if (which === "songs" && !allSongs.value.length) {
    try {
      const r = await apiGet("/api/songs");
      if (r.ok && Array.isArray(r.data)) allSongs.value = r.data.filter((s) => s && s.path);
    } catch {
      /* 面板留空 */
    }
  } else if (which === "books" && !allBooks.value.length) {
    try {
      const r = await apiGet("/api/books");
      if (r.ok && Array.isArray(r.data)) allBooks.value = r.data;
    } catch {
      /* 面板留空 */
    }
  }
}

function togglePickerAll() {
  const isSongs = picker.value === "songs";
  const list = isSongs ? filteredSongs.value : filteredBooks.value;
  const key = isSongs ? "path" : "id";
  const ids = list.map((x) => x[key]);
  if (!ids.length) return;
  const hasAll = ids.every((x) => pickerSelected.value.includes(x));
  if (hasAll) {
    pickerSelected.value = pickerSelected.value.filter((x) => !ids.includes(x));
  } else {
    pickerSelected.value = [...new Set([...pickerSelected.value, ...ids])];
  }
}

async function downloadPickedSongs() {
  if (syncBusy.value) return;
  const picked = allSongs.value.filter((s) => pickerSelected.value.includes(s.path));
  if (!picked.length) return;
  syncBusy.value = true;
  try {
    const items = await buildSongSyncItems(picked);
    if (syncAssets(items)) showToast(t("settings.syncStarted", { n: items.length }));
    syncLyricsForSongs(picked).then((r) => {
      if (r && r.ok > 0) showToast(t("settings.syncLyricsDone", { n: r.ok }));
    });
    pickerSelected.value = [];
  } finally {
    syncBusy.value = false;
  }
}

async function downloadPickedBooks() {
  if (syncBusy.value) return;
  const picked = allBooks.value.filter((b) => pickerSelected.value.includes(b.id));
  if (!picked.length) return;
  syncBusy.value = true;
  try {
    const items = await buildBookItems(picked);
    if (syncAssets(items)) showToast(t("settings.syncStarted", { n: items.length }));
    pickerSelected.value = [];
  } finally {
    syncBusy.value = false;
  }
}

// ---------- 词典区 ----------
const dicts = ref([]); // manifest dicts 条目
const dictItems = ref([]); // assetForDict 产物 [{path,url,sha256,size}]

// dict 条目与下载项按下标配对（assetForDict 过滤 null 时同步过滤）
const dictRows = computed(() => {
  const rows = [];
  const ds = dicts.value;
  for (let i = 0; i < ds.length; i++) {
    const item = dictItems.value[i];
    if (item) rows.push({ dict: ds[i], item });
  }
  return rows;
});

async function loadDicts() {
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
  dictItems.value = (await Promise.all(ds.map((d) => assetForDict(d)))).filter(Boolean);
}

function dictStatus(item) {
  const e = syncDownloads[item.path];
  return e ? e.status : "";
}

async function downloadAllDicts() {
  if (syncBusy.value) return;
  const items = dictItems.value.filter(
    (it) => !syncDownloads[it.path] || syncDownloads[it.path].status === "failed",
  );
  if (!items.length) {
    showToast(t("mobile.syncCenter.dictsUpToDate"));
    return;
  }
  syncBusy.value = true;
  try {
    if (syncAssets(items)) showToast(t("settings.syncStarted", { n: items.length }));
  } finally {
    syncBusy.value = false;
  }
}

async function deleteDict(item) {
  if (syncBusy.value) return;
  const n = clearAssetsByType("dicts", [{ path: item.path }]);
  if (!n) {
    showToast(t("mobile.syncCenter.nothingToClear"));
    return;
  }
  delete syncDownloads[item.path];
  showToast(t("mobile.syncCenter.dictDeleted"));
  await waitAssetsDeleted();
  await Promise.all([refreshStorage(), refreshOverview()]);
}

// ---------- 下载状态面板（迁移） ----------
const downloadStats = computed(() => {
  let active = 0;
  let done = 0;
  let failed = 0;
  let queued = 0;
  for (const d of Object.values(syncDownloads)) {
    if (d.status === "done") done++;
    else if (d.status === "failed") failed++;
    else if (d.status === "queued") queued++;
    else active++;
  }
  return { active, done, failed, queued, finished: done + failed };
});
const downloadSummary = computed(() => {
  const total = Object.keys(syncDownloads).length;
  const done = downloadStats.value.done;
  return { total, done, pct: total ? Math.min(100, Math.round((done / total) * 100)) : 0 };
});
const activeList = computed(() =>
  Object.values(syncDownloads).filter((d) => d.status === "downloading"),
);

function retryAllFailed() {
  for (const path of Object.keys(syncDownloads)) {
    if (syncDownloads[path].status === "failed") retryFailed(path);
  }
}

function statusLabel(status) {
  const key = "settings.syncStatus" + status.charAt(0).toUpperCase() + status.slice(1);
  const text = t(key);
  return text === key ? status : text;
}

function dlPercent(d) {
  if (!d.total) return 0;
  return Math.min(100, Math.round((d.received / d.total) * 100));
}

// ---------- 存储管理（按类型细分 + 清理） ----------
const storage = ref(null); // fetchAssetsSizeDetailed 结果
const STORAGE_TYPES = [
  { key: "audio", labelKey: "mobile.syncCenter.typeAudio" },
  { key: "covers", labelKey: "mobile.syncCenter.typeCovers" },
  { key: "lyric", labelKey: "mobile.syncCenter.typeLyric" },
  { key: "books", labelKey: "mobile.syncCenter.typeBooks" },
  { key: "dicts", labelKey: "mobile.syncCenter.typeDicts" },
];
const storageRows = computed(() => {
  const byType = storage.value?.byType || {};
  return STORAGE_TYPES.map((s) => ({ ...s, bytes: byType[s.key] || 0 }));
});
const otherBytes = computed(() => {
  const byType = storage.value?.byType || {};
  return (byType.meta || 0) + (byType.other || 0);
});
const storageTotal = computed(() => storage.value?.total || 0);

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(1)) + " " + units[i];
}

async function refreshStorage() {
  storage.value = await fetchAssetsSizeDetailed();
}

async function clearType(row) {
  if (syncBusy.value) return;
  const assets = overview.value?.assets || [];
  const n = clearAssetsByType(row.key, assets);
  if (n) showToast(t("mobile.syncCenter.cleared", { n }));
  else showToast(t("mobile.syncCenter.nothingToClear"));
  await waitAssetsDeleted();
  await Promise.all([refreshStorage(), refreshOverview()]);
}

const clearAllArmed = ref(false); // 两段式确认（WKWebView 不支持 window.confirm，沿用内联确认态）
let clearAllArmTimer = null;
function toggleClearAll() {
  if (!clearAllArmed.value) {
    clearAllArmed.value = true;
    clearAllArmTimer = setTimeout(() => (clearAllArmed.value = false), 4000); // 4s 未确认自动复位
    return;
  }
  clearAllArmed.value = false;
  if (clearAllArmTimer) clearTimeout(clearAllArmTimer);
  clearAssets("all");
  showToast(t("mobile.syncCenter.clearedAll"));
  waitAssetsDeleted().then(() => Promise.all([refreshStorage(), refreshOverview()]));
}

// ---------- 清理未引用 ----------
const orphanArmed = ref(false);
let orphanArmTimer = null;
async function cleanOrphans() {
  if (!orphanArmed.value) {
    orphanArmed.value = true;
    orphanArmTimer = setTimeout(() => (orphanArmed.value = false), 4000);
    return;
  }
  orphanArmed.value = false;
  if (orphanArmTimer) clearTimeout(orphanArmTimer);
  const size = orphanSize.value;
  const orphans = overview.value?.orphans || [];
  if (deleteOrphanAssets(orphans)) {
    showToast(t("mobile.syncCenter.orphansCleared", { size: formatBytes(size) }));
  }
  await waitAssetsDeleted();
  await Promise.all([refreshStorage(), refreshOverview()]);
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

// ---------- 下载完成 → 自动刷新存储占用 ----------
// 存储区在进入页面/手动刷新时取值；下载中的 .part 不计入（完成才显示）。
// 监听状态变化：有条目 done/failed（终态）→ 防抖刷新存储区，下载完用户立即可见占用。
let storageRefreshTimer = null;
watch(
  () =>
    Object.values(syncDownloads)
      .map((d) => d.status)
      .join(","),
  (statuses) => {
    if (statuses.includes("done") || statuses.includes("failed")) {
      if (storageRefreshTimer) clearTimeout(storageRefreshTimer);
      storageRefreshTimer = setTimeout(() => {
        storageRefreshTimer = null;
        refreshStorage();
      }, 800);
    }
  },
);

// ---------- 挂载：拉歌单 + 元数据（含词典缓存）+ 总览/存储/词典 ----------
onMounted(() => {
  loadPlaylists();
  syncNow().catch(() => {});
  refreshOverview();
  refreshStorage();
  refreshDicts();
});

// 供测试/调试：强制刷新总览（断言徽标数据）
defineExpose({ refreshOverview, refreshStorage });
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
