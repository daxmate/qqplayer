<!-- 局域网同步（S2 · web）运行视图（推送 / 拉取共用）：
     计划 / 已完成 / 跳过 / 失败计数 + 字节进度 + 取消 + 失败明细。
     数据形状由 composables/lanSyncContent.ts 的 normalizeRunStatus 归一（两套后端键名同一套 UI）。 -->
<template>
  <div v-if="view" class="group" data-testid="lansync-run">
    <div class="group-title">
      <Activity :size="13" />
      {{ kind === "push" ? t("lansync.run.titlePush") : t("lansync.run.titlePull") }}
    </div>
    <div class="setting-item">
      <div class="lansync-run-head">
        <span class="lansync-dot" :class="dotClass" />
        <span class="lansync-run-state" data-testid="lansync-run-state">{{ stateLabel }}</span>
        <span class="lansync-run-bytes" data-testid="lansync-run-bytes">
          {{
            t("lansync.run.bytes", {
              done: formatBytes(view.transferredBytes),
              total: formatBytes(view.totalBytes),
            })
          }}
        </span>
      </div>
      <div
        class="lansync-bar"
        role="progressbar"
        data-testid="lansync-run-bar"
        :aria-valuenow="percent"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="lansync-bar-fill" :style="{ width: percent + '%' }" />
      </div>
      <div class="lansync-counts">
        <span class="lansync-count" data-testid="lansync-run-planned">
          {{ t("lansync.run.planned") }}
          <b>{{ view.counts.planned }}</b>
        </span>
        <span class="lansync-count" data-testid="lansync-run-completed">
          {{ t("lansync.run.completed") }}
          <b>{{ view.counts.completed }}</b>
        </span>
        <span class="lansync-count" data-testid="lansync-run-skipped">
          {{ t("lansync.run.skipped") }}
          <b>{{ view.counts.skipped }}</b>
        </span>
        <span
          class="lansync-count"
          :class="{ danger: view.counts.failed > 0 }"
          data-testid="lansync-run-failed"
        >
          {{ t("lansync.run.failed") }}
          <b>{{ view.counts.failed }}</b>
        </span>
      </div>
      <div class="setting-desc lansync-muted">{{ skipHint }}</div>
      <div v-if="view.error" class="setting-desc lansync-error">{{ view.error }}</div>
      <div v-else-if="error" class="setting-desc lansync-error">{{ error }}</div>

      <div v-if="view.terminal" class="setting-desc" data-testid="lansync-run-summary">
        {{ view.succeeded ? t("lansync.run.finishOk") : t("lansync.run.finishFailed") }}
      </div>

      <div class="lansync-run-actions">
        <button
          v-if="!view.terminal"
          class="btn"
          data-testid="lansync-run-cancel"
          :disabled="busy"
          @click="emit('cancel')"
        >
          {{ busy ? t("lansync.run.cancelling") : t("lansync.run.cancel") }}
        </button>
        <button
          v-if="view.failures.length"
          class="btn"
          data-testid="lansync-run-failures"
          @click="showFailures = !showFailures"
        >
          {{ t("lansync.run.failuresTitle", { n: view.failures.length }) }}
          · {{ showFailures ? t("lansync.run.closeFailures") : t("lansync.run.openFailures") }}
        </button>
      </div>

      <div v-if="showFailures && view.failures.length" class="lansync-failures">
        <div
          v-for="(item, i) in view.failures"
          :key="i"
          class="lansync-failure"
          data-testid="lansync-run-failure"
        >
          <div class="lansync-failure-path">{{ item.path }}</div>
          <div class="lansync-failure-reason">
            {{ t(failureLabelKey(item.reason)) }}
            <span v-if="item.reason">· {{ item.reason }}</span>
            <span v-if="item.detail">· {{ item.detail }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Activity } from "@lucide/vue";
import {
  failureLabelKey,
  formatBytes,
  runPercent,
  type LanSyncRunView,
} from "../../composables/lanSyncContent.js";

const props = defineProps<{
  kind: "push" | "pull";
  view: LanSyncRunView | null;
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{ cancel: [] }>();

const { t } = useI18n();
const showFailures = ref(false);

const percent = computed(() => runPercent(props.view));
const stateLabel = computed(() => {
  const state = props.view?.state || "idle";
  const key = `lansync.state.${state}`;
  const text = t(key);
  return text === key ? state : text;
});
const dotClass = computed(() => {
  const view = props.view;
  if (!view) return "off";
  if (view.state === "failed") return "bad";
  if (view.terminal) return view.succeeded ? "on" : "bad";
  return "busy";
});
const skipHint = computed(() =>
  props.kind === "push" ? t("lansync.run.skippedPush") : t("lansync.run.skippedPull"),
);

// 新一轮运行（run_id 变化）→ 收起上一轮的失败明细
watch(
  () => props.view?.runId,
  () => {
    showFailures.value = false;
  },
);
</script>

<style scoped>
.lansync-run-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.lansync-run-state {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.lansync-run-bytes {
  margin-left: auto;
  font-size: 11px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text3);
}
.lansync-dot.busy {
  background: var(--accent);
}
.lansync-dot.bad {
  background: var(--red);
}
.lansync-bar {
  height: 6px;
  margin: 8px 0 6px;
  border-radius: 3px;
  background: var(--bg2);
  overflow: hidden;
}
.lansync-bar-fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.25s ease;
}
.lansync-counts {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.lansync-count {
  font-size: 12px;
  color: var(--text3);
}
.lansync-count b {
  color: var(--text);
  margin-left: 3px;
}
.lansync-count.danger b {
  color: var(--red);
}
.lansync-run-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.lansync-failures {
  margin-top: 8px;
  max-height: 220px;
  overflow: auto;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg2);
  padding: 8px;
}
.lansync-failure + .lansync-failure {
  margin-top: 6px;
}
.lansync-failure-path {
  font-size: 12px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  color: var(--text2);
  word-break: break-all;
}
.lansync-failure-reason {
  font-size: 11px;
  color: var(--text3);
  word-break: break-all;
}
.lansync-error {
  color: var(--red);
  word-break: break-all;
}
.lansync-muted {
  color: var(--text3);
}
</style>
