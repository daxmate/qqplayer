<!-- 桌面歌词设置面板（SettingsModal 拆分 · P3）：桌面歌词 + 桌面主题色
  子 tab 切换器与 lyricSubTab 状态保留在 SettingsModal 容器（与 APP 歌词面板共用，
  容器侧守卫 lyricSubTab === 'desktop' && !isMobile）；配色方案/字体颜色样式为
  Lyric/Desktop 两面板共用，由 SettingsModal :deep 穿透；desktop-reset-btn 专属。 -->
<template>
  <div class="group">
    <div class="group-title">
      <MonitorPlay :size="13" />
      {{ t("settings.lyricDesktop") }}
    </div>
    <template v-for="e in desktopEntries" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 配色方案 swatches（applyScheme 联动清除自定义色） -->
      <div v-else-if="e.id === 'desktopColorScheme'" class="setting-item">
        <div class="setting-label">{{ t("settings.colorScheme") }}</div>
        <div class="desktop-schemes">
          <button
            v-for="sc in DESKTOP_LYRIC_SCHEMES"
            :key="sc.key"
            class="scheme-swatch"
            :class="{ on: desktopLyricSettings.colorScheme === sc.key }"
            :title="t(sc.labelKey)"
            @click="applyScheme(sc)"
          >
            <span class="scheme-dot" :style="{ background: sc.jp }" />
            <span class="scheme-dot" :style="{ background: sc.zh }" />
            <span class="scheme-name">{{ t(sc.labelKey) }}</span>
          </button>
        </div>
      </div>
      <!-- 字体颜色（主行/翻译两个色块，桌面版无清除按钮） -->
      <div v-else-if="e.id === 'desktopJpColor'" class="setting-item">
        <div class="setting-label">{{ t("settings.fontColor") }}</div>
        <div class="desktop-colors">
          <label class="color-field">
            <span>{{ t("settings.mainLine") }}</span>
            <input v-model="desktopLyricSettings.jpColor" type="color" class="color-input" />
          </label>
          <label class="color-field">
            <span>{{ t("settings.translation") }}</span>
            <input v-model="desktopLyricSettings.zhColor" type="color" class="color-input" />
          </label>
        </div>
      </div>
    </template>
    <div class="setting-item">
      <button class="desktop-reset-btn" @click="resetDesktopLyric">
        <RotateCcw :size="13" />
        {{ t("settings.resetDesktopLyric") }}
      </button>
    </div>
    <div class="setting-item">
      <div class="setting-label">{{ t("settings.openMethod") }}</div>
      <div class="setting-desc">
        {{ t("settings.openMethodDesc") }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { MonitorPlay, RotateCcw } from "@lucide/vue";
import {
  desktopLyricSettings,
  DESKTOP_LYRIC_SCHEMES,
  DESKTOP_LYRIC_DEFAULTS,
} from "../../composables/usePlayer.js";
import SettingRow from "../SettingRow.vue";
import { entriesByCategory, type SettingEntry } from "../../settingsIndex";

const { t } = useI18n();

// 注册表顺序渲染（与拆分前 SettingsModal 一致）；render 标记的复合项按 id 分发手写块
const pickIds = (arr: SettingEntry[], ids: string[]) => arr.filter((e) => ids.includes(e.id));
const desktopEntries = pickIds(
  entriesByCategory("lyric").filter((e) => e.subTab === "desktop"),
  [
    "desktopShowZh",
    "desktopFontFamily",
    "desktopFontSize",
    "desktopZhSize",
    "desktopAlign",
    "desktopWidth",
    "desktopHeight",
    "desktopColorScheme",
    "desktopJpColor",
    "desktopZhColor",
  ],
);

// 桌面歌词：应用配色方案（'theme' 跟随主题 → 清空自定义颜色）；一键恢复默认
function applyScheme(sc: any) {
  desktopLyricSettings.colorScheme = sc.key;
  if (sc.key === "theme") {
    desktopLyricSettings.jpColor = "";
    desktopLyricSettings.zhColor = "";
  } else {
    desktopLyricSettings.jpColor = sc.jp;
    desktopLyricSettings.zhColor = sc.zh;
  }
}

function resetDesktopLyric() {
  Object.assign(desktopLyricSettings, DESKTOP_LYRIC_DEFAULTS);
}
</script>

<style scoped>
/* 桌面歌词一键恢复默认 */
.desktop-reset-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 9px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
}
@media (hover: hover) {
  .desktop-reset-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-soft);
  }
}
</style>
