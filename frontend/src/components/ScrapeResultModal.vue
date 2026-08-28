<template>
  <Teleport to="body">
    <div v-if="open" class="modal-mask" @click.self="close">
      <div class="modal sr-modal">
        <div class="modal-head">
          <Sparkles :size="16" />
          <span class="sr-title">{{ t("scrape.resultTitle") }}</span>
          <span v-if="!error && enabled" class="head-sub">{{
            t("scrape.resultCount", { n: summary.total })
          }}</span>
          <button class="modal-close" :title="t('common.close')" @click="close">
            <X :size="16" />
          </button>
        </div>

        <div class="sr-body">
          <!-- 请求级错误（网络失败 / 后端 5xx） -->
          <div v-if="error" class="sr-error" data-testid="sr-error">{{ error }}</div>

          <!-- 后端防御：批量刮削未启用 -->
          <div v-else-if="!enabled" class="sr-not-enabled" data-testid="sr-not-enabled">
            {{ t("scrape.notEnabled") }}
          </div>

          <template v-else>
            <!-- summary 计数 -->
            <div class="sr-summary">
              <span class="sr-stat ok">
                <span class="sr-stat-n">{{ summary.written }}</span>
                {{ t("scrape.summary.written") }}
              </span>
              <span class="sr-stat skip">
                <span class="sr-stat-n">{{ summary.skipped }}</span>
                {{ t("scrape.summary.skipped") }}
              </span>
              <span class="sr-stat fail">
                <span class="sr-stat-n">{{ summary.failed }}</span>
                {{ t("scrape.summary.failed") }}
              </span>
            </div>
            <div v-if="truncated" class="sr-truncated">{{ t("scrape.truncated") }}</div>

            <!-- 明细：成功 / 跳过（按 reason 分组）/ 失败（按 reason 分组）；行可展开看 reason + written -->
            <div class="sr-groups">
              <div
                v-for="group in groups"
                :key="group.key"
                class="sr-group"
                :data-testid="'sr-group-' + group.key"
              >
                <div class="sr-group-title">
                  <span class="sr-group-label">{{ group.label }}</span>
                  <span class="sr-group-count">{{ group.items.length }}</span>
                </div>
                <div
                  v-for="item in group.items"
                  :key="item.path"
                  class="sr-item"
                  :class="{ open: isOpen(item) }"
                  @click="toggle(item)"
                >
                  <span class="sr-status" :class="item.status">
                    {{ statusLabel(item.status) }}
                  </span>
                  <span class="sr-path" :title="item.path">{{ item.path }}</span>
                  <ChevronDown :size="12" class="sr-chevron" />
                  <div v-if="isOpen(item)" class="sr-detail">
                    <div v-if="item.reason" class="sr-detail-row">
                      <span class="sr-detail-label">{{ t("scrape.detail.reason") }}</span>
                      <span class="sr-detail-val">{{ item.reason }}</span>
                    </div>
                    <div v-if="writtenFields(item).length" class="sr-detail-row">
                      <span class="sr-detail-label">{{ t("scrape.detail.written") }}</span>
                      <span class="sr-detail-val">{{ writtenFields(item).join("、") }}</span>
                    </div>
                    <div v-if="item.candidates != null" class="sr-detail-row">
                      <span class="sr-detail-label">{{ t("scrape.detail.candidates") }}</span>
                      <span class="sr-detail-val">{{ item.candidates }}</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronDown, Sparkles, X } from "@lucide/vue";
import {
  scrapeBatchState,
  closeScrapeResult,
  type ScrapeBatchResult,
} from "../composables/useScrapeBatch.js";

const { t } = useI18n();

const open = computed(() => scrapeBatchState.open);
const error = computed(() => scrapeBatchState.error);
const enabled = computed(() => scrapeBatchState.enabled);
const truncated = computed(() => scrapeBatchState.truncated);
const results = computed(() => scrapeBatchState.results);
const summary = computed(() => scrapeBatchState.summary);

function close() {
  closeScrapeResult();
}

// 明细行展开状态（按 path 记忆；path 即唯一键）
const expanded = ref(new Set());
function isOpen(item: ScrapeBatchResult) {
  return expanded.value.has(item.path);
}
function toggle(item: ScrapeBatchResult) {
  const next = new Set(expanded.value);
  if (next.has(item.path)) next.delete(item.path);
  else next.add(item.path);
  expanded.value = new Set(next); // 触发响应式
}
function writtenFields(item: ScrapeBatchResult) {
  return Array.isArray(item.written) ? item.written : [];
}

function statusLabel(status: string) {
  const key =
    status === "written"
      ? "scrape.status.written"
      : status === "skipped"
        ? "scrape.status.skipped"
        : "scrape.status.failed";
  return t(key);
}

// 明细分组：成功一组；跳过/失败按 reason 分组（reason 缺失归入「其他」）
function groupKeyOf(item: ScrapeBatchResult) {
  return item.reason && String(item.reason).trim()
    ? String(item.reason).trim()
    : t("scrape.detail.other");
}

const groups = computed(() => {
  const out = [];
  const written = results.value.filter((r) => r.status === "written");
  if (written.length) {
    out.push({ key: "written", label: t("scrape.status.written"), items: written });
  }
  for (const status of ["skipped", "failed"]) {
    const items = results.value.filter((r) => r.status === status);
    // 按 reason 分组（保持出现顺序）
    const byReason = new Map();
    for (const item of items) {
      const k = groupKeyOf(item);
      if (!byReason.has(k)) byReason.set(k, []);
      byReason.get(k).push(item);
    }
    for (const [reason, list] of byReason) {
      out.push({
        key: `${status}-${reason}`,
        label: `${statusLabel(status)} · ${reason}`,
        items: list,
      });
    }
  }
  return out;
});
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
.sr-title {
  white-space: nowrap;
}
.head-sub {
  font-size: 12px;
  font-weight: 500;
  color: var(--text2);
  margin-left: 2px;
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

.sr-body {
  padding: 14px 18px 18px;
  overflow-y: auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.sr-error {
  color: var(--red);
  font-size: 13px;
  line-height: 1.6;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--red) 10%, transparent);
  border-radius: 10px;
}
.sr-not-enabled {
  color: var(--text2);
  font-size: 13px;
  line-height: 1.6;
  padding: 10px 12px;
  background: var(--card2);
  border-radius: 10px;
}
.sr-summary {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
}
.sr-stat {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  font-size: 12px;
  color: var(--text2);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 12px;
}
.sr-stat-n {
  font-size: 18px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.sr-stat.ok .sr-stat-n {
  color: var(--green, #34d399);
}
.sr-stat.skip .sr-stat-n {
  color: var(--text2);
}
.sr-stat.fail .sr-stat-n {
  color: var(--red);
}
.sr-truncated {
  font-size: 11.5px;
  color: var(--text3);
}
.sr-groups {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.sr-group-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: var(--text2);
  padding: 4px 2px 2px;
}
.sr-group-count {
  font-size: 11px;
  color: var(--text3);
  background: var(--card2);
  border-radius: 8px;
  padding: 1px 7px;
  font-variant-numeric: tabular-nums;
}
.sr-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 9px;
  font-size: 12.5px;
  color: var(--text2);
  cursor: pointer;
  transition: background 0.12s;
  flex-wrap: wrap;
}
@media (hover: hover) {
  .sr-item:hover {
    background: var(--card2);
  }
}
.sr-status {
  flex-shrink: 0;
  font-size: 10.5px;
  font-weight: 600;
  border-radius: 6px;
  padding: 1px 6px;
}
.sr-status.written {
  color: var(--green, #34d399);
  background: color-mix(in srgb, var(--green, #34d399) 14%, transparent);
}
.sr-status.skipped {
  color: var(--text2);
  background: var(--card2);
}
.sr-status.failed {
  color: var(--red);
  background: color-mix(in srgb, var(--red) 14%, transparent);
}
.sr-path {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
.sr-chevron {
  flex-shrink: 0;
  color: var(--text3);
  transition: transform 0.15s;
}
.sr-item.open .sr-chevron {
  transform: rotate(180deg);
}
.sr-detail {
  flex-basis: 100%;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 8px 2px;
  font-size: 12px;
}
.sr-detail-row {
  display: flex;
  gap: 6px;
}
.sr-detail-label {
  flex-shrink: 0;
  color: var(--text3);
}
.sr-detail-val {
  color: var(--text2);
  word-break: break-all;
}
</style>
