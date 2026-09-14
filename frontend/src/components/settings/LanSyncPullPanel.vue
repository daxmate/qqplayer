<!-- 局域网同步（S2 · web）取回面板：对端内容浏览（歌单 / 曲目 + 摘要 + 分页搜索）→ 勾选 → 取回入库 + 运行视图。
     逻辑在 composables/useLanSyncPull.ts（preview 请求 + 事件回执）、useLanSyncRun.ts（运行与轮询）。
     拉取语义：**点位对端点名勾选的歌曲，不做全库镜像**（不勾选就不取）。 -->
<template>
  <div class="group">
    <div class="group-title">
      <Download :size="13" />
      {{ t("lansync.contentPullTab") }}
    </div>
    <div class="setting-item">
      <div class="setting-desc">{{ t("lansync.pull.browseHint") }}</div>
      <div class="setting-control">
        <button
          class="btn"
          data-testid="lansync-pull-browse"
          :disabled="!deviceOnline || pull.loading.value"
          @click="browse"
        >
          <Download :size="13" />
          {{ pull.opened.value ? t("lansync.pull.rebrowse") : t("lansync.pull.browse") }}
        </button>
      </div>
      <div v-if="!deviceOnline" class="setting-desc lansync-muted">
        {{ t("lansync.push.deviceOffline") }}
      </div>
    </div>
  </div>

  <template v-if="pull.opened.value">
    <div class="group">
      <div class="group-title">
        <ListMusic :size="13" />
        {{ t("lansync.contentPullTab") }}
      </div>
      <div class="setting-item">
        <div class="setting-desc" data-testid="lansync-pull-summary">
          {{
            t("lansync.pull.summary", {
              tracks: pull.facts.value.libraryTrackCount,
              size: formatBytes(pull.facts.value.librarySizeBytes),
              playlists: pull.facts.value.playlistCount,
            })
          }}
        </div>
        <div v-if="pull.facts.value.truncated" class="setting-desc lansync-muted">
          {{ t("lansync.pull.truncated") }}
        </div>

        <div class="lansync-seg" role="tablist">
          <button
            class="lansync-seg-btn"
            :class="{ on: pull.scope.value === 'playlists' }"
            data-testid="lansync-pull-scope-playlists"
            @click="pull.setScope('playlists')"
          >
            {{ t("lansync.pull.scopePlaylists") }}
          </button>
          <button
            class="lansync-seg-btn"
            :class="{ on: pull.scope.value === 'tracks' }"
            data-testid="lansync-pull-scope-tracks"
            @click="pull.setScope('tracks')"
          >
            {{ t("lansync.pull.scopeTracks") }}
          </button>
        </div>

        <div class="lansync-tools">
          <input
            class="lansync-input"
            type="search"
            data-testid="lansync-pull-search"
            :placeholder="t('lansync.push.searchPlaceholder')"
            :value="pull.query.value"
            @input="onQueryInput"
          />
          <button
            class="btn lansync-btn-sm"
            data-testid="lansync-pull-select-page"
            :disabled="pull.scope.value !== 'tracks'"
            @click="pull.togglePage(true)"
          >
            {{ t("lansync.pull.selectPage") }}
          </button>
          <button
            class="btn lansync-btn-sm"
            data-testid="lansync-pull-unselect-page"
            :disabled="pull.scope.value !== 'tracks'"
            @click="pull.togglePage(false)"
          >
            {{ t("lansync.pull.unselectPage") }}
          </button>
        </div>

        <!-- 设备歌单（摘要，仅供浏览） -->
        <div v-if="pull.scope.value === 'playlists'" class="lansync-list">
          <div v-if="pull.playlists.value.length">
            <div
              v-for="row in pull.playlists.value"
              :key="row.id"
              class="lansync-row"
              data-testid="lansync-pull-playlist"
            >
              <span class="lansync-row-name">{{ row.name || row.id }}</span>
              <span class="lansync-row-meta">{{
                t("lansync.trackCount", { n: row.trackCount })
              }}</span>
            </div>
          </div>
          <div v-else class="setting-desc lansync-muted" data-testid="lansync-pull-playlists-empty">
            {{ t("lansync.pull.playlistsEmpty") }}
          </div>
        </div>

        <!-- 设备曲目（可勾选取回） -->
        <div v-else class="lansync-list">
          <div v-if="pull.tracks.value.length">
            <label
              v-for="row in pull.tracks.value"
              :key="row.relativePath"
              class="lansync-row"
              data-testid="lansync-pull-track"
            >
              <input
                type="checkbox"
                class="lansync-check"
                :data-path="row.relativePath"
                :checked="pull.selectedSet.value.has(row.relativePath)"
                @change="pull.toggleTrack(row.relativePath)"
              />
              <span class="lansync-row-name">{{ row.title || row.relativePath }}</span>
              <span class="lansync-row-meta">{{ row.artistName || "—" }}</span>
            </label>
          </div>
          <div v-else class="setting-desc lansync-muted" data-testid="lansync-pull-tracks-empty">
            {{ pull.query.value ? t("lansync.pull.tracksEmpty") : t("lansync.pull.tracksEmpty") }}
          </div>
        </div>

        <div class="lansync-pager" data-testid="lansync-pull-page">
          <button
            class="btn lansync-btn-sm"
            :disabled="pull.offset.value <= 0"
            data-testid="lansync-pull-prev"
            @click="pull.prevPage()"
          >
            {{ t("lansync.pull.prev") }}
          </button>
          <span class="lansync-row-meta">{{ pull.pageLabel.value }}</span>
          <button
            class="btn lansync-btn-sm"
            :disabled="!pull.hasMore.value"
            data-testid="lansync-pull-next"
            @click="pull.nextPage()"
          >
            {{ t("lansync.pull.next") }}
          </button>
        </div>

        <div v-if="pull.loading.value" class="setting-desc lansync-muted">
          {{ t("lansync.pull.loading") }}
        </div>
        <div v-if="pull.error.value" class="setting-desc lansync-error">{{ pull.error.value }}</div>
        <div
          v-else-if="pull.noResponse.value"
          class="setting-desc lansync-error"
          data-testid="lansync-pull-timeout"
        >
          {{ t("lansync.pull.timeout") }}
        </div>

        <div class="setting-desc lansync-muted">{{ t("lansync.pull.selectionHint") }}</div>
        <div class="setting-control">
          <button
            class="btn primary"
            data-testid="lansync-pull-start"
            :disabled="!canStart"
            @click="startPull"
          >
            <Download :size="13" />
            {{ run.busy.value ? t("lansync.pull.running") : t("lansync.pull.start") }}
          </button>
          <span class="lansync-row-meta" data-testid="lansync-pull-selected">
            {{ t("lansync.pull.selectedTracks", { n: pull.selectedCount.value }) }}
          </span>
        </div>
        <div v-if="deviceOnline && !pull.selectedCount.value" class="setting-desc lansync-muted">
          {{ t("lansync.pull.noneSelected") }}
        </div>
      </div>
    </div>

    <LanSyncRunPanel
      kind="pull"
      :view="run.view.value"
      :busy="run.busy.value"
      :error="run.error.value"
      @cancel="onCancel"
    />
  </template>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Download, ListMusic } from "@lucide/vue";
import LanSyncRunPanel from "./LanSyncRunPanel.vue";
import { useLanSyncPull } from "../../composables/useLanSyncPull.js";
import { useLanSyncRun } from "../../composables/useLanSyncRun.js";
import { showToast, toastError } from "../../composables/useToast.js";
import { formatBytes } from "../../composables/lanSyncContent.js";

const props = defineProps<{ peerId: string; deviceOnline: boolean }>();

const { t } = useI18n();
const pull = useLanSyncPull();
const run = useLanSyncRun();

const canStart = computed(
  () => props.deviceOnline && pull.selectedCount.value > 0 && !run.busy.value,
);

async function browse(): Promise<void> {
  await pull.open(props.peerId);
}

function onQueryInput(event: Event): void {
  pull.setQuery((event.target as HTMLInputElement).value);
}

async function startPull(): Promise<void> {
  if (!canStart.value) return;
  const ok = await run.startPull(props.peerId, pull.selectedPaths.value);
  if (ok) showToast(t("lansync.pull.started"));
  else toastError(run.error.value || t("lansync.pull.startFailed"));
}

async function onCancel(): Promise<void> {
  if (!(await run.cancel())) toastError(t("lansync.run.failedToCancel"));
}

watch(
  () => run.view.value?.terminal,
  (terminal, wasTerminal) => {
    if (!terminal || wasTerminal) return;
    const view = run.view.value;
    if (!view) return;
    if (view.succeeded) showToast(t("lansync.pull.done"));
    else toastError(t("lansync.pull.doneWithFailures", { n: view.counts.failed }));
  },
);

// 换设备：对端内容与选择、运行视图全部作废（对端相对路径只在该设备上有意义）
watch(
  () => props.peerId,
  () => {
    pull.close();
    run.reset();
  },
);

onBeforeUnmount(() => {
  pull.stop();
  run.stopPolling();
});
</script>

<style scoped>
.lansync-seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
  margin: 8px 0;
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
.lansync-input {
  flex: 1;
  min-width: 120px;
  font-size: 12px;
  padding: 5px 8px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--bg2);
  color: var(--text);
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
