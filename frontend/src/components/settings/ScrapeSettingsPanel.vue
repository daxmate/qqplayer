<!-- 刮削设置面板（SettingsModal 拆分 · P3）：刮削字段 / 重命名规则 / 源优先级 / 批量刮削 / 插件占位
  面板挂载（进入刮削 tab）时拉取最新设置，与拆分前容器 watch(tab) 语义一致；
  保存防抖 scheduleScrapeSave、两段式批量确认（batchArmed）为面板内部实现；
  通用样式由 SettingsModal :deep 穿透继承，scrape-*/source-* 专属样式 scoped。 -->
<template>
  <!-- 刮削字段 -->
  <div class="group">
    <div class="group-title">
      <Tags :size="13" />
      {{ t("settings.scrapeFields") }}
    </div>
    <div class="setting-item">
      <div class="setting-desc">{{ t("settings.scrapeFieldsDesc") }}</div>
      <div class="scrape-fields">
        <label v-for="f in scrapeFieldOptions" :key="f.key" class="scrape-field">
          <input
            type="checkbox"
            :checked="scrapingSettings.enabled_fields.includes(f.key)"
            :data-testid="'scrape-field-' + f.key"
            @change="toggleScrapeField(f.key)"
          />
          <span>{{ t(f.labelKey) }}</span>
        </label>
      </div>
    </div>
  </div>

  <!-- 重命名规则 -->
  <div class="group">
    <div class="group-title">
      <Type :size="13" />
      {{ t("settings.renameTemplate") }}
    </div>
    <div class="setting-item">
      <div class="setting-desc">{{ t("settings.renameTemplateDesc") }}</div>
      <div class="setting-control">
        <input
          v-model="scrapingSettings.rename_template"
          class="lib-input"
          type="text"
          spellcheck="false"
          :placeholder="'{artist} - {title}'"
          data-testid="rename-template-input"
          @change="scheduleScrapeSave"
        />
      </div>
      <div class="setting-desc scrape-tokens">{{ t("settings.renameTokens") }}</div>
      <div class="setting-desc scrape-tokens">{{ t("settings.renameSlashHint") }}</div>
      <div class="scrape-preview">
        <span class="setting-desc">{{ t("settings.renamePreview") }}</span>
        <span class="scrape-preview-val" data-testid="rename-preview">{{ renamePreview }}</span>
      </div>
    </div>
  </div>

  <!-- 源优先级 -->
  <div class="group">
    <div class="group-title">
      <RefreshCw :size="13" />
      {{ t("settings.sourceOrder") }}
    </div>
    <div class="setting-item">
      <div class="setting-desc">{{ t("settings.sourceOrderDesc") }}</div>
      <div class="source-order">
        <div v-for="(src, i) in scrapingSettings.source_order" :key="src" class="source-row">
          <span class="source-name">{{ t("settings.sourceName." + src) }}</span>
          <span class="source-rank">{{ i + 1 }}</span>
          <div class="source-arrows">
            <button
              class="mini-btn"
              :disabled="i === 0"
              :title="t('settings.sourceUp')"
              data-testid="source-up"
              @click="moveSource(src, -1)"
            >
              <ChevronUp :size="13" />
            </button>
            <button
              class="mini-btn"
              :disabled="i === scrapingSettings.source_order.length - 1"
              :title="t('settings.sourceDown')"
              data-testid="source-down"
              @click="moveSource(src, 1)"
            >
              <ChevronDown :size="13" />
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 批量刮削 -->
  <div class="group">
    <div class="group-title">
      <Sparkles :size="13" />
      {{ t("settings.batchScrape") }}
    </div>
    <div class="setting-item">
      <div class="toggle-row" @click="toggleBatchEnabled">
        <div>
          <div class="setting-label">{{ t("settings.batchScrape") }}</div>
          <div class="setting-desc">{{ t("settings.batchScrapeDesc") }}</div>
        </div>
        <span class="switch" :class="{ on: scrapingSettings.batch_enabled }"><i /></span>
      </div>
      <div v-if="scrapingSettings.batch_enabled" class="setting-control">
        <button
          class="btn primary"
          :disabled="scrapeBatchState.loading"
          data-testid="batch-library-btn"
          @click="onBatchLibrary"
        >
          <Loader2 v-if="scrapeBatchState.loading" :size="13" class="spin" />
          {{ batchArmed ? t("settings.batchArmed") : t("settings.batchLibraryGo") }}
        </button>
      </div>
      <div v-if="scrapeError" class="setting-error" data-testid="scrape-error">
        {{ scrapeError }}
      </div>
    </div>
  </div>

  <!-- 插件占位 -->
  <div class="group">
    <div class="group-title">
      <Zap :size="13" />
      {{ t("settings.plugin") }}
    </div>
    <div class="setting-item disabled">
      <div class="setting-label">{{ t("settings.pluginScrapeSource") }}</div>
      <div class="setting-desc">{{ t("settings.pluginScrapeSourceDesc") }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import { Tags, Type, RefreshCw, Sparkles, Zap, ChevronUp, ChevronDown, Loader2 } from "@lucide/vue";
import { state } from "../../composables/usePlayer.js";
import {
  scrapingSettings,
  SCRAPING_FIELDS,
  loadScrapingSettings,
  saveScrapingSettings,
  renderRenamePreview,
} from "../../composables/useScrapingSettings.js";
import { scrapeBatchState, runScrapeBatch } from "../../composables/useScrapeBatch.js";

const { t } = useI18n();

// ============ 刮削设置（scraping · /api/library/settings 持久化） ============
// 保存防抖：连续改动合并成一次 PUT；GET 完成前由 useScrapingSettings 门闩拦截
const scrapeError = ref("");
let scrapeSaveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScrapeSave() {
  scrapeError.value = "";
  if (scrapeSaveTimer) clearTimeout(scrapeSaveTimer);
  scrapeSaveTimer = setTimeout(async () => {
    scrapeSaveTimer = null;
    const r = await saveScrapingSettings();
    if (!r.ok) scrapeError.value = r.error;
  }, 300);
}

// 刮削字段选项（labelKey 在 settings.js：settings.scrapeField.*）
const scrapeFieldOptions = SCRAPING_FIELDS.map((key) => ({
  key,
  labelKey: `settings.scrapeField.${key}`,
}));

function toggleScrapeField(key: string) {
  const cur = scrapingSettings.enabled_fields;
  scrapingSettings.enabled_fields = cur.includes(key)
    ? cur.filter((k) => k !== key)
    : [...cur, key];
  scheduleScrapeSave();
}

function toggleBatchEnabled() {
  scrapingSettings.batch_enabled = !scrapingSettings.batch_enabled;
  scheduleScrapeSave();
}

// 源优先级：上下移（简单实现，不引拖拽库）
function moveSource(key: string, dir: number) {
  const cur = [...scrapingSettings.source_order];
  const i = cur.indexOf(key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= cur.length) return;
  [cur[i], cur[j]] = [cur[j], cur[i]];
  scrapingSettings.source_order = cur;
  scheduleScrapeSave();
}

// 重命名模板实时预览：取曲库第一首有 artist+title 的歌渲染；无示例/渲染为空显示 "—"
const renamePreview = computed(() => {
  const song = state.songs.find(
    (s: any) => s && String(s.artist || "").trim() && String(s.name || "").trim(),
  );
  if (!song) return "—";
  const out = renderRenamePreview(scrapingSettings.rename_template, song);
  return out || "—";
});

// 一键整库：两段式确认（WKWebView 不支持 window.confirm，沿用内联确认模式）
const batchArmed = ref(false);
let batchArmTimer: ReturnType<typeof setTimeout> | null = null;

function onBatchLibrary() {
  if (!scrapingSettings.batch_enabled) return;
  if (!batchArmed.value) {
    batchArmed.value = true;
    batchArmTimer = setTimeout(() => (batchArmed.value = false), 4000);
    return;
  }
  batchArmed.value = false;
  if (batchArmTimer) clearTimeout(batchArmTimer);
  runScrapeBatch({ mode: "library" });
}

onMounted(loadScrapingSettings);
</script>

<style scoped>
/* ============ 刮削 tab ============ */
/* 刮削字段 checkbox 列表 */
.scrape-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 16px;
  margin-top: 8px;
}
.scrape-field {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text2);
  cursor: pointer;
  transition: all 0.12s;
}
@media (hover: hover) {
  .scrape-field:hover {
    color: var(--text);
    border-color: var(--text3);
  }
}
.scrape-field input {
  accent-color: var(--accent);
  margin: 0;
}
/* 重命名模板：占位符说明 + 实时预览 */
.scrape-tokens {
  margin-top: 6px;
  font-variant-numeric: tabular-nums;
}
.scrape-preview {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.scrape-preview-val {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
  background: var(--bg2);
  border: 1px dashed var(--border);
  border-radius: 9px;
  padding: 7px 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 源优先级排序 */
.source-order {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}
.source-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 9px;
  background: var(--bg2);
  border: 1px solid var(--border);
}
.source-name {
  flex: 1;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text2);
}
.source-rank {
  font-size: 11px;
  color: var(--text3);
  background: var(--card2);
  border-radius: 8px;
  padding: 1px 8px;
  font-variant-numeric: tabular-nums;
}
.source-arrows {
  display: flex;
  gap: 4px;
}
.source-arrows .mini-btn {
  margin-left: 0;
  padding: 3px 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.source-arrows .mini-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
/* 插件占位（禁用态） */
.setting-item.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.setting-item.disabled .setting-label {
  color: var(--text3);
}
/* 按钮内 spinner（Loader2） */
.spin {
  animation: sr-spin 0.9s linear infinite;
}
@keyframes sr-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
