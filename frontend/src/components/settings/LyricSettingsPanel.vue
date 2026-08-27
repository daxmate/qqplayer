<!-- 歌词设置面板（SettingsModal 拆分 · P3）：APP 歌词 6 组（外观/显示/效果/校准/来源/颜色）
  子 tab 切换器与 lyricSubTab 状态保留在 SettingsModal 容器（与桌面歌词面板共用）；
  注册表条目由 entriesByCategory + pickIds 计算（与拆分前 SettingsModal 完全一致）；
  通用样式由 SettingsModal :deep 穿透继承，面板专属样式（amll-*/配色方案等）scoped。 -->
<template>
  <!-- 外观排版 -->
  <div class="group">
    <div class="group-title">
      <Type :size="13" />
      {{ t("settings.lyricAppearance") }}
    </div>
    <SettingRow v-for="e in lyricAppearance" :key="e.id" :entry="e" />
  </div>

  <!-- 显示内容 -->
  <div class="group">
    <div class="group-title">
      <Eye :size="13" />
      {{ t("settings.lyricDisplay") }}
    </div>
    <SettingRow v-for="e in lyricDisplay" :key="e.id" :entry="e" />
  </div>

  <!-- 效果行为 -->
  <div class="group">
    <div class="group-title">
      <Sparkles :size="13" />
      {{ t("settings.lyricEffects") }}
    </div>
    <SettingRow v-for="e in lyricEffects" :key="e.id" :entry="e" />
    <!-- AMLL 三特效（仅 amll 引擎生效）：壳内默认开 = 满血；浏览器默认关防 CPU 高占用 -->
    <div class="amll-head">
      <span class="amll-head-label">{{ t("settings.amllEffects") }}</span>
      <button
        class="amll-info-btn"
        :class="{ on: amllPerfHintOpen }"
        :title="t('settings.amllPerfHint')"
        :aria-expanded="amllPerfHintOpen ? 'true' : 'false'"
        @click="amllPerfHintOpen = !amllPerfHintOpen"
      >
        <Info :size="13" />
      </button>
    </div>
    <div v-if="amllPerfHintOpen" class="setting-desc hint amll-perf-hint">
      {{ t("settings.amllPerfHint") }}
    </div>
    <SettingRow v-for="e in lyricAmll" :key="e.id" :entry="e" />
  </div>

  <!-- 时间校准 -->
  <div class="group">
    <div class="group-title">
      <Timer :size="13" />
      {{ t("settings.lyricCalib") }}
    </div>
    <template v-for="e in lyricCalib" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 歌词延迟：徽标 + 一键归零 + 滑杆（offset 特殊显示） -->
      <div v-else-if="e.id === 'offset'" class="setting-item">
        <div class="setting-label">
          {{ t("settings.lyricOffset") }}
          <span class="val-badge">{{ fmtOffset }}</span>
          <button
            v-if="lyricSettings.offset !== 0"
            class="mini-btn"
            @click="lyricSettings.offset = 0"
          >
            {{ t("settings.reset") }}
          </button>
        </div>
        <div class="setting-desc">
          {{ t("settings.lyricOffsetDesc") }}
        </div>
        <input
          v-model.number="lyricSettings.offset"
          class="slider"
          type="range"
          min="-2"
          max="2"
          step="0.1"
        />
      </div>
    </template>
  </div>

  <!-- 歌词来源 -->
  <div class="group">
    <div class="group-title">
      <Database :size="13" />
      {{ t("settings.lyricSource") }}
    </div>
    <SettingRow v-for="e in lyricSource" :key="e.id" :entry="e" />
  </div>

  <!-- APP 歌词配色（参照桌面歌词） -->
  <div class="group">
    <div class="group-title">
      <Palette :size="13" />
      {{ t("settings.colorSchemeGroup") }}
    </div>
    <template v-for="e in lyricColors" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 配色方案 swatches（applyLyricScheme 联动清除自定义色） -->
      <div v-else-if="e.id === 'colorScheme'" class="setting-item">
        <div class="setting-label">{{ t("settings.colorScheme") }}</div>
        <div class="desktop-schemes">
          <button
            v-for="sc in LYRIC_SCHEMES"
            :key="sc.key"
            class="scheme-swatch"
            :class="{ on: lyricSettings.colorScheme === sc.key }"
            :title="t(sc.labelKey)"
            @click="applyLyricScheme(sc)"
          >
            <span class="scheme-dot" :style="{ background: sc.jp || 'var(--accent)' }" />
            <span class="scheme-dot" :style="{ background: sc.zh || 'var(--text2)' }" />
            <span class="scheme-name">{{ t(sc.labelKey) }}</span>
          </button>
        </div>
      </div>
      <!-- 字体颜色（主行/翻译两个色块 + 清除自定义） -->
      <div v-else-if="e.id === 'jpColor'" class="setting-item">
        <div class="setting-label">{{ t("settings.fontColor") }}</div>
        <div class="desktop-colors">
          <label class="color-field">
            <span>{{ t("settings.mainLine") }}</span>
            <input v-model="lyricSettings.jpColor" type="color" class="color-input" />
          </label>
          <label class="color-field">
            <span>{{ t("settings.translation") }}</span>
            <input v-model="lyricSettings.zhColor" type="color" class="color-input" />
          </label>
          <button
            v-if="lyricSettings.jpColor || lyricSettings.zhColor"
            class="mini-btn"
            @click="
              lyricSettings.jpColor = '';
              lyricSettings.zhColor = '';
            "
          >
            {{ t("settings.clearCustom") }}
          </button>
        </div>
        <div class="setting-desc">
          {{ t("settings.fontColorDesc") }}
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from "vue";
import { useI18n } from "vue-i18n";
import { Type, Eye, Sparkles, Timer, Database, Palette, Info } from "@lucide/vue";
import { lyricSettings, LYRIC_SCHEMES } from "../../composables/usePlayer.js";
import SettingRow from "../SettingRow.vue";
import { entriesByCategory, type SettingEntry } from "../../settingsIndex";

const { t } = useI18n();

const amllPerfHintOpen = ref(false); // AMLL 三特效性能提示（info 按钮）展开状态

// 分组：注册表顺序渲染（与拆分前 SettingsModal 一致）；render 标记的复合项按 id 分发手写块
const pickIds = (arr: SettingEntry[], ids: string[]) => arr.filter((e) => ids.includes(e.id));
const lyricAppEntries = entriesByCategory("lyric").filter((e) => e.subTab === "app");
const lyricAppearance = pickIds(lyricAppEntries, ["engine", "fontFamily", "fontSize", "align"]);
const lyricDisplay = pickIds(lyricAppEntries, ["showRoma", "showZh", "showSec"]);
const lyricEffects = pickIds(lyricAppEntries, ["focusPos", "fadeMask", "autoScroll"]);
const lyricAmll = pickIds(lyricAppEntries, ["amllBlur", "amllSpring", "amllScale"]);
const lyricCalib = pickIds(lyricAppEntries, ["offset"]);
const lyricSource = pickIds(lyricAppEntries, ["source"]);
const lyricColors = pickIds(lyricAppEntries, ["colorScheme", "jpColor", "zhColor"]);

// 歌词延迟徽标：+0.5s / -1.2s / 0.0s（正 = 歌词延后显示）
const fmtOffset = computed(() => {
  const v = lyricSettings.offset;
  return (v > 0 ? "+" : "") + v.toFixed(1) + "s";
});

// APP 歌词：应用配色方案（'theme' 跟随主题 → 清空自定义颜色）
function applyLyricScheme(sc: any) {
  lyricSettings.colorScheme = sc.key;
  if (sc.key === "theme") {
    lyricSettings.jpColor = "";
    lyricSettings.zhColor = "";
  } else {
    lyricSettings.jpColor = sc.jp;
    lyricSettings.zhColor = sc.zh;
  }
}
</script>

<style scoped>
/* AMLL 三特效：子标题 + info 按钮（点击展开/收起性能提示） */
.amll-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 0 6px;
}
.amll-head-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text2);
}
.amll-info-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--text3);
  background: var(--bg2);
  border: 1px solid var(--border);
  transition: all 0.15s;
  cursor: pointer;
  flex-shrink: 0;
}
@media (hover: hover) {
  .amll-info-btn:hover {
    color: var(--accent-text);
    border-color: var(--accent);
    background: var(--accent-soft);
  }
}
.amll-info-btn.on {
  color: var(--accent-text);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.amll-perf-hint {
  margin: 0 0 10px;
  font-size: 12px;
}
</style>
