<!-- 界面偏好设置面板（SettingsModal 拆分 · P3）：界面偏好 + 封面 + 主题/强调色
  注册表条目由 entriesByCategory + pickIds 计算（与拆分前 SettingsModal 完全一致）；
  卡拉OK跟唱为播放器状态（非设置字段）保留手写；封面大小滑块 + 强调色色板为面板内部实现；
  通用样式由 SettingsModal :deep 穿透继承，accent-* 专属样式 scoped。 -->
<template>
  <div class="group">
    <div class="group-title">
      <LayoutGrid :size="13" />
      {{ t("settings.uiPrefs") }}
    </div>
    <SettingRow v-for="e in uiPrefs" :key="e.id" :entry="e" :mobile="isMobile" />
    <!-- 卡拉OK跟唱模式：播放器状态（非设置字段），保留手写 -->
    <div class="setting-item">
      <div class="toggle-row" @click="state.karaokeOn = !state.karaokeOn">
        <div>
          <div class="setting-label">{{ t("settings.karaokeOn") }}</div>
          <div class="setting-desc">{{ t("settings.karaokeOnDesc") }}</div>
        </div>
        <span class="switch" :class="{ on: state.karaokeOn }"><i /></span>
      </div>
    </div>
    <template v-for="e in uiCover" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" :mobile="isMobile" />
      <!-- 封面区域大小：自适应（0）或手动固定值（140~420）；滑块联动 + 恢复默认回自适应 -->
      <div
        v-else-if="e.id === 'coverSize' && coverVisible('large') && !isMobile"
        class="setting-item"
      >
        <div class="setting-label">
          {{ t("settings.coverSize") }}
          <span class="val-badge">
            {{ coverSizeLabel }}
          </span>
          <button v-if="uiSettings.coverSize !== 0" class="mini-btn" @click="resetCoverSize()">
            {{ t("settings.resetCoverSize") }}
          </button>
        </div>
        <div class="setting-desc">{{ t("settings.coverSizeDesc") }}</div>
        <input
          v-model.number="coverSizeSlider"
          class="slider"
          type="range"
          :min="COVER_MIN"
          :max="COVER_MAX"
          step="10"
        />
      </div>
    </template>
  </div>

  <!-- 主题与强调色 -->
  <div class="group">
    <div class="group-title">
      <Palette :size="13" />
      {{ t("settings.themeAccent") }}
    </div>
    <template v-for="e in uiTheme" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 强调色预设（色板） -->
      <div v-else-if="e.id === 'accent'" class="setting-item">
        <div class="setting-label">{{ t("settings.accent") }}</div>
        <div class="accent-grid">
          <button
            v-for="a in ACCENT_OPTIONS"
            :key="a.key"
            class="accent-swatch"
            :class="{ on: uiSettings.accent === a.key }"
            :style="{ '--swatch': a.color, '--swatch2': a.color2 }"
            :title="a.key"
            @click="uiSettings.accent = a.key"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { LayoutGrid, Palette } from "@lucide/vue";
import { state, uiSettings, ACCENT_OPTIONS } from "../../composables/usePlayer.js";
import { coverVisible } from "../../composables/useCoverGuard.ts";
import {
  COVER_MIN,
  COVER_MAX,
  COVER_DEFAULT,
  resetCoverSize,
} from "../../composables/useCoverSize.js";
import { isMobile } from "../../composables/useMobileViewport.js";
import SettingRow from "../SettingRow.vue";
import { entriesByCategory, type SettingEntry } from "../../settingsIndex";

const { t } = useI18n();

// 分组：注册表顺序渲染（与拆分前 SettingsModal 一致）；render 标记的复合项按 id 分发手写块
const pickIds = (arr: SettingEntry[], ids: string[]) => arr.filter((e) => ids.includes(e.id));
const uiEntries = entriesByCategory("ui");
const uiPrefs = pickIds(uiEntries, ["showSongInfo", "karaokeShowTime", "karaokeShowNum"]);
const uiCover = pickIds(uiEntries, [
  "coverBlur",
  "glassCover",
  "showCover",
  "showListCover",
  "coverSize",
  "compact",
]);
const uiTheme = pickIds(uiEntries, ["theme", "miniTheme", "accent"]);

// 封面区域大小：0 = 自适应（显示「自适应」），固定值显示 px
const coverSizeLabel = computed(() =>
  uiSettings.coverSize === 0 ? t("settings.coverSizeAuto") : `${uiSettings.coverSize}px`,
);
// 滑块 v-model：0 时落滑块到默认锚点（340），拖动立即写固定值
const coverSizeSlider = computed({
  get: () => (uiSettings.coverSize === 0 ? COVER_DEFAULT : uiSettings.coverSize),
  set: (v) => {
    uiSettings.coverSize = Math.round(v);
  },
});
</script>

<style scoped>
/* 强调色预设（色板） */
.accent-grid {
  display: flex;
  gap: 10px;
  margin-top: 8px;
}
.accent-swatch {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--swatch), var(--swatch2));
  border: 2px solid transparent;
  transition: all 0.15s;
  position: relative;
}
@media (hover: hover) {
  .accent-swatch:hover {
    transform: scale(1.12);
  }
}
.accent-swatch.on {
  border-color: var(--text);
  box-shadow: 0 0 0 2px var(--bg);
  transform: scale(1.1);
}
.accent-swatch.on::after {
  content: "✓";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 13px;
  font-weight: 800;
  color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.45);
}
</style>
