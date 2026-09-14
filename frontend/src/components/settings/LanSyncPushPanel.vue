<!-- 局域网同步（S2 · web）推送面板：选择集（全库 / 歌单与收藏 / 单曲）+ 起跑 + 运行视图。
     逻辑在 composables/useLanSyncPush.ts（选择集与来源数据）、useLanSyncRun.ts（运行与轮询）。 -->
<template>
  <div class="group">
    <div class="group-title">
      <Upload :size="13" />
      {{ t("lansync.contentPushTab") }}
    </div>
    <div class="setting-item">
      <div class="lansync-seg" role="tablist">
        <button
          v-for="option in kindOptions"
          :key="option.value"
          class="lansync-seg-btn"
          :class="{ on: push.kind.value === option.value }"
          :data-testid="'lansync-push-kind-' + option.value"
          @click="push.setKind(option.value)"
        >
          {{ t(option.labelKey) }}
        </button>
      </div>

      <!-- 全库 -->
      <template v-if="push.kind.value === 'all'">
        <div class="setting-desc" data-testid="lansync-push-all-desc">
          {{ t("lansync.push.allDesc", { n: push.libraryCount.value }) }}
        </div>
        <div
          v-if="!push.libraryCount.value && !push.loading.value"
          class="setting-desc lansync-muted"
        >
          {{ t("lansync.push.allEmpty") }}
        </div>
      </template>

      <!-- 歌单与收藏 -->
      <template v-else-if="push.kind.value === 'playlists'">
        <div class="setting-desc">{{ t("lansync.push.playlistsDesc") }}</div>
        <div v-if="push.playlistRows.value.length" class="lansync-list">
          <label
            v-for="row in push.playlistRows.value"
            :key="row.id"
            class="lansync-row"
            :data-testid="'lansync-push-playlist-' + row.id"
          >
            <input
              type="checkbox"
              class="lansync-check"
              :checked="push.playlistIdSet.value.has(row.id)"
              @change="push.togglePlaylist(row.id)"
            />
            <span class="lansync-row-name">{{ sourceName(row) }}</span>
            <span class="lansync-row-meta">{{
              t("lansync.trackCount", { n: row.trackCount })
            }}</span>
          </label>
        </div>
        <div v-else class="setting-desc lansync-muted">{{ t("lansync.push.playlistsEmpty") }}</div>
        <div class="setting-desc lansync-muted" data-testid="lansync-push-selected-sources">
          {{ t("lansync.push.selectedSources", { n: push.selectedSourceCount.value }) }}
        </div>
      </template>

      <!-- 单曲 -->
      <template v-else>
        <div class="setting-desc">{{ t("lansync.push.tracksDesc") }}</div>
        <div class="lansync-tools">
          <select
            class="lansync-select"
            data-testid="lansync-push-source"
            :value="push.currentSource.value"
            @change="onSourceChange"
          >
            <option v-for="row in push.sources.value" :key="row.id" :value="row.id">
              {{ sourceName(row) }}
            </option>
          </select>
          <input
            class="lansync-input"
            type="search"
            data-testid="lansync-push-search"
            :placeholder="t('lansync.push.searchPlaceholder')"
            :value="push.query.value"
            @input="onQueryInput"
          />
          <button
            class="btn lansync-btn-sm"
            data-testid="lansync-push-select-page"
            @click="togglePage(true)"
          >
            {{ t("lansync.push.selectPage") }}
          </button>
          <button
            class="btn lansync-btn-sm"
            data-testid="lansync-push-unselect-page"
            @click="togglePage(false)"
          >
            {{ t("lansync.push.unselectPage") }}
          </button>
        </div>

        <div v-if="push.pageTracks.value.length" class="lansync-list">
          <label
            v-for="song in push.pageTracks.value"
            :key="String(song.path ?? '')"
            class="lansync-row"
            data-testid="lansync-push-track"
          >
            <input
              type="checkbox"
              class="lansync-check"
              :data-path="song.path"
              :checked="push.trackPathSet.value.has(song.path as string)"
              @change="push.toggleTrack(song.path as string)"
            />
            <span class="lansync-row-name">{{ song.name || song.path }}</span>
            <span class="lansync-row-meta">{{ song.artist || "—" }}</span>
          </label>
        </div>
        <div v-else class="setting-desc lansync-muted" data-testid="lansync-push-tracks-empty">
          {{ push.query.value ? t("lansync.push.searchEmpty") : t("lansync.push.empty") }}
        </div>

        <div class="lansync-pager" data-testid="lansync-push-page">
          <button
            class="btn lansync-btn-sm"
            :disabled="push.pageInfo.value.offset <= 0"
            @click="prevPage"
          >
            {{ t("lansync.push.prev") }}
          </button>
          <span class="lansync-row-meta">{{ pageLabel }}</span>
          <button
            class="btn lansync-btn-sm"
            :disabled="!push.pageInfo.value.hasMore"
            @click="nextPage"
          >
            {{ t("lansync.push.next") }}
          </button>
        </div>
      </template>

      <div v-if="push.loading.value" class="setting-desc lansync-muted">
        {{ t("lansync.push.loading") }}
      </div>
      <div v-if="push.error.value" class="setting-desc lansync-error">{{ push.error.value }}</div>

      <div class="setting-control">
        <button
          class="btn primary"
          data-testid="lansync-push-start"
          :disabled="!canStart"
          @click="startPush"
        >
          <Upload :size="13" />
          {{ run.busy.value ? t("lansync.push.running") : t("lansync.push.start") }}
        </button>
        <span class="lansync-row-meta" data-testid="lansync-push-selected">
          {{ t("lansync.push.selectedTracks", { n: push.selectedTrackCount.value }) }}
        </span>
      </div>
      <div v-if="!deviceOnline" class="setting-desc lansync-muted">
        {{ t("lansync.push.deviceOffline") }}
      </div>
      <div v-else-if="!push.canSubmit.value" class="setting-desc lansync-muted">
        {{ t("lansync.push.noneSelected") }}
      </div>
    </div>
  </div>

  <LanSyncRunPanel
    kind="push"
    :view="run.view.value"
    :busy="run.busy.value"
    :error="run.error.value"
    @cancel="onCancel"
  />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Upload } from "@lucide/vue";
import LanSyncRunPanel from "./LanSyncRunPanel.vue";
import { useLanSyncPush } from "../../composables/useLanSyncPush.js";
import { useLanSyncRun } from "../../composables/useLanSyncRun.js";
import { showToast, toastError } from "../../composables/useToast.js";
import {
  sourceLabelKey,
  TRACKS_PAGE_SIZE,
  type LanSyncSourceRow,
  type SelectionKind,
} from "../../composables/lanSyncContent.js";

const props = defineProps<{ peerId: string; deviceOnline: boolean }>();

const { t } = useI18n();
const push = useLanSyncPush();
const run = useLanSyncRun();

const kindOptions: Array<{ value: SelectionKind; labelKey: string }> = [
  { value: "all", labelKey: "lansync.push.kindAll" },
  { value: "playlists", labelKey: "lansync.push.kindPlaylists" },
  { value: "tracks", labelKey: "lansync.push.kindTracks" },
];

/** 来源 / 歌单显示名：`@` 命名空间走 i18n，真实歌单用后端给的名字 */
function sourceName(row: LanSyncSourceRow): string {
  const key = sourceLabelKey(row.id);
  return key ? t(key) : row.name;
}

const pageLabel = computed(() => {
  const info = push.pageInfo.value;
  const size = TRACKS_PAGE_SIZE;
  const page = Math.floor(info.offset / size) + 1;
  const pages = Math.max(1, Math.ceil(info.total / size));
  return `${page} / ${pages}`;
});

const canStart = computed(() => props.deviceOnline && push.canSubmit.value && !run.busy.value);

function onSourceChange(event: Event): void {
  push.setSource((event.target as HTMLSelectElement).value);
}
function onQueryInput(event: Event): void {
  push.setQuery((event.target as HTMLInputElement).value);
}
function nextPage(): void {
  push.setOffset(push.pageInfo.value.offset + TRACKS_PAGE_SIZE);
}
function prevPage(): void {
  push.setOffset(Math.max(0, push.pageInfo.value.offset - TRACKS_PAGE_SIZE));
}
function togglePage(select: boolean): void {
  push.togglePage(select);
}

async function startPush(): Promise<void> {
  if (!canStart.value) return;
  const ok = await run.startPush(props.peerId, push.selection.value);
  if (ok) showToast(t("lansync.push.started"));
  else toastError(run.error.value || t("lansync.push.startFailed"));
}

async function onCancel(): Promise<void> {
  if (!(await run.cancel())) toastError(t("lansync.run.failedToCancel"));
}

// 运行结束（一次 toast；由轮询把状态推到终态触发）
watch(
  () => run.view.value?.terminal,
  (terminal, wasTerminal) => {
    if (!terminal || wasTerminal) return;
    const view = run.view.value;
    if (!view) return;
    if (view.succeeded) showToast(t("lansync.push.done"));
    else toastError(t("lansync.push.doneWithFailures", { n: view.counts.failed }));
  },
);

// 换设备：选择集与运行视图都作废（标识空间不同，跨设备保留会推错内容）
watch(
  () => props.peerId,
  () => {
    push.clearSelection();
    run.reset();
  },
);

onMounted(() => {
  void push.load();
});
onBeforeUnmount(() => run.stopPolling());
</script>

<style scoped>
.lansync-seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
  margin-bottom: 8px;
}
.lansync-seg-btn {
  flex: 1;
  font-size: 12px;
  padding: 5px 6px;
  border-radius: 7px;
  border: none;
  background: transparent;
  color: var(--text2);
  cursor: pointer;
}
.lansync-seg-btn.on {
  background: var(--card);
  color: var(--text);
  font-weight: 600;
}
.lansync-list {
  margin-top: 8px;
  max-height: 280px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2);
}
.lansync-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 9px;
  cursor: pointer;
}
.lansync-row + .lansync-row {
  border-top: 1px solid var(--border);
}
.lansync-row-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lansync-row-meta {
  font-size: 11px;
  color: var(--text3);
  flex-shrink: 0;
}
.lansync-check {
  flex-shrink: 0;
}
.lansync-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
  align-items: center;
}
.lansync-select,
.lansync-input {
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
}
.lansync-input {
  flex: 1;
  min-width: 120px;
}
.lansync-pager {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.lansync-btn-sm {
  flex-shrink: 0;
  font-size: 12px;
  padding: 6px 10px;
}
.lansync-btn-sm:disabled {
  opacity: 0.5;
  cursor: default;
}
.lansync-error {
  color: var(--red);
  word-break: break-all;
}
.lansync-muted {
  color: var(--text3);
}
</style>
