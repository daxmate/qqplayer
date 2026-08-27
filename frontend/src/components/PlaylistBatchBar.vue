<template>
  <div v-if="multiMode" class="pl-multi">
    <span class="pl-multi-count">
      {{ t("playlist.multi.selected", { n: selectedPaths.length }) }}
    </span>
    <button class="pl-multi-btn" :title="t('playlist.multi.fav')" @click="batchFavorite">
      <Heart :size="13" fill="none" />
      {{ t("playlist.multi.fav") }}
    </button>
    <button
      class="pl-multi-btn"
      :title="t('playlist.multi.addToPlaylist')"
      @click="batchAddPlaylist"
    >
      <ListPlus :size="13" />
      {{ t("playlist.multi.addToPlaylist") }}
    </button>
    <!-- 批量刮削（仅开启批量刮削后显示） -->
    <button
      v-if="scrapingSettings.batch_enabled"
      class="pl-multi-btn"
      :disabled="scrapeBatchState.loading"
      :title="t('playlist.multi.scrape')"
      data-testid="pl-multi-scrape"
      @click="batchScrape"
    >
      <Loader2 v-if="scrapeBatchState.loading" :size="13" class="spin" />
      <Sparkles v-else :size="13" />
      {{
        scrapeBatchState.loading
          ? t("playlist.multi.scraping", { n: selectedPaths.length })
          : t("playlist.multi.scrape")
      }}
    </button>
    <button
      class="pl-multi-btn danger"
      :title="t('playlist.multi.deleteToTrash')"
      @click="batchDelete"
    >
      <Trash2 :size="13" />
      {{ t("playlist.multi.deleteToTrash") }}
    </button>
    <button class="pl-multi-btn" :title="t('playlist.multi.clear')" @click="clearSelection">
      <X :size="13" />
      {{ t("playlist.multi.clear") }}
    </button>
    <!-- 推送到设备（放在末尾：现有测试按位置索引 pl-multi-btn，插入中间会破坏索引） -->
    <button
      class="pl-multi-btn"
      :title="t('playlist.pushToDevice')"
      data-testid="pl-multi-push-device"
      @click="batchPushToDevice"
    >
      <Send :size="13" />
      {{ t("playlist.pushToDevice") }}
    </button>
  </div>
</template>

<script setup>
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Heart, ListPlus, Loader2, Sparkles, Trash2, X, Send } from "@lucide/vue";
import { isFavorite, toggleFavorite, loadSongs } from "../composables/usePlayer.js";
import { scrapingSettings } from "../composables/useScrapingSettings.js";
import { scrapeBatchState, runScrapeBatch } from "../composables/useScrapeBatch.js";
import { showToast } from "../composables/useToast.js";

const emit = defineEmits(["delete", "add-playlist", "push-device"]);

const { t } = useI18n();

// ============ 多选批量（桌面：⌘/Ctrl 点选进入多选态） ============
// 多选状态由本组件持有；主组件通过 defineExpose 读取（行 selected class / Esc 清理 / 点击切换）
const selectedPaths = ref([]);
const multiMode = computed(() => selectedPaths.value.length > 0);

function isSelected(path) {
  return path != null && selectedPaths.value.includes(path);
}

function toggleSelected(path) {
  const i = selectedPaths.value.indexOf(path);
  if (i >= 0) selectedPaths.value.splice(i, 1);
  else selectedPaths.value.push(path);
}

function clearSelection() {
  selectedPaths.value = [];
}

// 批量收藏：只加不删（幂等），新增数 toast
async function batchFavorite() {
  const paths = selectedPaths.value.filter((p) => p != null && !isFavorite(p));
  if (!paths.length) return;
  for (const p of paths) await toggleFavorite(p);
  showToast(t("playlist.fav.batchAdded", { n: paths.length }));
}

// 批量加歌单：复用 addMenu 浮层（批量模式 = 只加不删）
function batchAddPlaylist() {
  const paths = selectedPaths.value.filter((p) => p != null);
  if (!paths.length) return;
  emit("add-playlist", paths);
}

// 批量移到废纸篓（与单曲同一链路：确认弹窗 → DELETE → toast → loadSongs）
function batchDelete() {
  emit("delete", selectedPaths.value);
}

// ============ 批量刮削（多选 → POST /api/tags/scrape-batch） ============
// 按钮仅当设置里开启 batch_enabled 后显示（关闭时入口隐藏）；批量写入会改文件名，
// 完成后刷新曲库 + 清空多选；结果面板（ScrapeResultModal）展示 summary + 明细。
async function batchScrape() {
  if (!scrapingSettings.batch_enabled) return;
  const paths = selectedPaths.value.filter((p) => p != null);
  if (!paths.length) return;
  await runScrapeBatch({ paths });
  // 请求结束（成功/未启用/失败都收敛）：改没改名都刷一次保险，多选清空
  await loadSongs({ force: true });
  clearSelection();
}

// 批量推送到设备：选中路径 → 主组件按 path 映射曲库歌曲 → DevicePickerModal
function batchPushToDevice() {
  const paths = selectedPaths.value.filter((p) => p != null);
  if (!paths.length) return;
  emit("push-device", paths);
}

defineExpose({
  isMulti: () => multiMode.value,
  getSelectedPaths: () => selectedPaths.value,
  isSelected,
  toggleSelected,
  clearSelection,
});
</script>

<style scoped>
/* 多选批量操作条 */
.pl-multi {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--accent-soft);
  flex-shrink: 0;
  flex-wrap: wrap;
}
.pl-multi-count {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  margin-right: auto;
}
.pl-multi-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 9px;
  border-radius: 8px;
  background: var(--card);
  color: var(--text2);
  font-size: 11.5px;
  font-weight: 600;
  transition: all 0.12s;
}
.pl-multi-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
@media (hover: hover) {
  .pl-multi-btn:hover {
    background: var(--border);
    color: var(--text);
  }
}
.pl-multi-btn.danger {
  color: var(--red);
}
@media (hover: hover) {
  .pl-multi-btn.danger:hover {
    background: var(--red-soft);
    color: var(--red);
  }
}
.spin {
  animation: pl-dl-spin 0.9s linear infinite;
}
@keyframes pl-dl-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
</style>
