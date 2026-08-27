<!-- 播放设置面板（SettingsModal 拆分 · P3）：播放 / AB 循环 / 睡眠定时
  注册表条目由 entriesByCategory + pickIds 计算（与拆分前 SettingsModal 完全一致），
  复合控件（EQ 矩阵 / 滑块+预设 / 子开关）为面板内部实现；
  通用样式（.setting-item/.toggle-row/.switch/.slider/.ext-chip 等）由 SettingsModal :deep 穿透继承。 -->
<template>
  <div class="group">
    <template v-for="e in playbackMain" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 切歌淡入淡出：开关联动滑杆（fadeSec > 0 才显示） -->
      <div v-else-if="e.id === 'fadeSec'" class="setting-item">
        <div class="toggle-row" @click="toggleFade">
          <div>
            <div class="setting-label">{{ t("settings.fade") }}</div>
            <div class="setting-desc">{{ t("settings.fadeDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: playbackSettings.fadeSec > 0 }"><i /></span>
        </div>
        <div v-if="playbackSettings.fadeSec > 0" class="fade-row">
          <span class="setting-desc">{{ t("settings.duration") }}</span>
          <input
            v-model.number="playbackSettings.fadeSec"
            class="slider"
            type="range"
            min="0.5"
            max="5"
            step="0.5"
          />
          <span class="val-badge">{{ playbackSettings.fadeSec }}s</span>
        </div>
      </div>
      <!-- EQ 面板：开关 + 预设 chips + 十段滑杆（eqEnabled 联动） -->
      <div v-else-if="e.id === 'eqEnabled'" class="setting-item">
        <div class="toggle-row" @click="playbackSettings.eqEnabled = !playbackSettings.eqEnabled">
          <div>
            <div class="setting-label">{{ t("settings.eq") }}</div>
            <div class="setting-desc">{{ t("settings.eqDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: playbackSettings.eqEnabled }"><i /></span>
        </div>
        <template v-if="playbackSettings.eqEnabled">
          <div class="eq-presets">
            <button
              v-for="(p, key) in EQ_PRESETS"
              :key="key"
              class="ext-chip"
              :class="{ on: playbackSettings.eqPreset === key }"
              @click="setEqPreset(key)"
            >
              {{ t(p.labelKey) }}
            </button>
          </div>
          <div class="eq-grid">
            <div v-for="(f, i) in EQ_BANDS" :key="f" class="eq-cell">
              <span class="eq-val"
                >{{ playbackSettings.eqGains[i] > 0 ? "+" : ""
                }}{{ playbackSettings.eqGains[i] }}</span
              >
              <input
                class="eq-slider"
                type="range"
                min="-12"
                max="12"
                step="1"
                :value="playbackSettings.eqGains[i]"
                @input="setEqGain(i, ($event.target as HTMLInputElement).value)"
              />
              <span class="eq-band">{{ fmtBand(f) }}</span>
            </div>
          </div>
        </template>
      </div>
      <!-- 视觉样式：总开关 + 氛围背景/迷你频谱子开关 + 样式 chips（visualizerEnabled 联动） -->
      <div v-else-if="e.id === 'visualizerEnabled'" class="setting-item">
        <div
          class="toggle-row"
          @click="playbackSettings.visualizerEnabled = !playbackSettings.visualizerEnabled"
        >
          <div>
            <div class="setting-label">{{ t("settings.visualizer") }}</div>
            <div class="setting-desc">{{ t("settings.visualizerDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: playbackSettings.visualizerEnabled }"><i /></span>
        </div>
        <template v-if="playbackSettings.visualizerEnabled">
          <!-- 主区域：封面取色氛围背景（任务 C 混合方案） -->
          <div
            class="sub-toggle-row"
            @click="playbackSettings.ambientEnabled = !playbackSettings.ambientEnabled"
          >
            <div>
              <div class="setting-label sub">{{ t("settings.ambient") }}</div>
              <div class="setting-desc sub">{{ t("settings.ambientDesc") }}</div>
            </div>
            <span class="switch sm" :class="{ on: playbackSettings.ambientEnabled }"> <i /></span>
          </div>
          <!-- ControlBar：迷你频谱条 -->
          <div
            class="sub-toggle-row"
            @click="playbackSettings.miniSpectrumEnabled = !playbackSettings.miniSpectrumEnabled"
          >
            <div>
              <div class="setting-label sub">{{ t("settings.miniSpectrum") }}</div>
              <div class="setting-desc sub">{{ t("settings.miniSpectrumDesc") }}</div>
            </div>
            <span class="switch sm" :class="{ on: playbackSettings.miniSpectrumEnabled }">
              <i
            /></span>
          </div>
          <!-- 6 样式 chips：现在语义 = ControlBar 迷你频谱样式（主区域已是氛围背景，不再有样式） -->
          <div v-if="playbackSettings.miniSpectrumEnabled" class="ext-grid viz-style-grid">
            <button
              v-for="s in VISUALIZER_STYLES"
              :key="s.id"
              class="ext-chip"
              :class="{ on: playbackSettings.visualizerStyle === s.id }"
              @click="playbackSettings.visualizerStyle = s.id"
            >
              {{ t(s.labelKey) }}
            </button>
          </div>
        </template>
      </div>
    </template>
  </div>

  <div class="group">
    <div class="group-title">
      <Repeat2 :size="13" />
      {{ t("settings.abLoop") }}
    </div>
    <template v-for="e in playbackAb" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- AB 循环计数：开关 + 次数滑杆/步进器（abLoopCountOn 联动） -->
      <div v-else-if="e.id === 'abLoopCountOn'" class="setting-item">
        <div
          class="toggle-row"
          @click="playbackSettings.abLoopCountOn = !playbackSettings.abLoopCountOn"
        >
          <div>
            <div class="setting-label">{{ t("settings.abLoopCount") }}</div>
            <div class="setting-desc">{{ t("settings.abLoopCountDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: playbackSettings.abLoopCountOn }"><i /></span>
        </div>
        <div v-if="playbackSettings.abLoopCountOn" class="fade-row">
          <span class="setting-desc">{{ t("settings.count") }}</span>
          <input
            v-model.number="playbackSettings.abLoopMaxCount"
            class="slider"
            type="range"
            min="1"
            max="20"
            step="1"
          />
          <div class="stepper">
            <button class="step-btn" :title="t('settings.minusOne')" @click="stepAbMax(-1)">
              −
            </button>
            <span class="val-badge">{{
              t("settings.loopTimes", { n: playbackSettings.abLoopMaxCount })
            }}</span>
            <button class="step-btn" :title="t('settings.plusOne')" @click="stepAbMax(1)">
              ＋
            </button>
          </div>
        </div>
      </div>
    </template>
  </div>

  <div class="group">
    <div class="group-title">
      <Timer :size="13" />
      {{ t("settings.sleepTimer") }}
    </div>
    <template v-for="e in playbackSleep" :key="e.id">
      <SettingRow v-if="!e.render" :entry="e" />
      <!-- 睡眠定时器：开关启动/取消倒计时 + 时长 chips（sleepTimerOn 联动） -->
      <div v-else-if="e.id === 'sleepTimerOn'" class="setting-item">
        <div class="toggle-row" @click="toggleSleepTimer">
          <div>
            <div class="setting-label">{{ t("settings.sleepTimer") }}</div>
            <div class="setting-desc">{{ t("settings.sleepTimerDesc") }}</div>
          </div>
          <span class="switch" :class="{ on: playbackSettings.sleepTimerOn }"><i /></span>
        </div>
      </div>
      <div v-if="e.id === 'sleepTimerOn' && playbackSettings.sleepTimerOn" class="setting-item">
        <div class="setting-label">{{ t("settings.duration") }}</div>
        <div class="ext-grid">
          <button
            v-for="m in SLEEP_TIMER_OPTIONS"
            :key="m"
            class="ext-chip"
            :class="{ on: playbackSettings.sleepTimerMinutes === m }"
            @click="setSleepTimerMinutes(m)"
          >
            {{ t("settings.minutes", { n: m }) }}
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { useI18n } from "vue-i18n";
import { Repeat2, Timer } from "@lucide/vue";
import {
  playbackSettings,
  EQ_PRESETS,
  EQ_BANDS,
  setEqPreset,
  setEqGain,
  VISUALIZER_STYLES,
} from "../../composables/usePlayer.js";
import {
  SLEEP_TIMER_OPTIONS,
  toggleSleepTimer,
  setSleepTimerMinutes,
} from "../../composables/useSleepTimer.js";
import SettingRow from "../SettingRow.vue";
import { entriesByCategory, type SettingEntry } from "../../settingsIndex";

const { t } = useI18n();

// 分组：注册表顺序渲染（与拆分前 SettingsModal 一致）；render 标记的复合项按 id 分发手写块
const pickIds = (arr: SettingEntry[], ids: string[]) => arr.filter((e) => ids.includes(e.id));
const playbackEntries = entriesByCategory("playback");
const playbackMain = pickIds(playbackEntries, [
  "playMode",
  "resumeLast",
  "rememberVolume",
  "fadeSec",
  "eqEnabled",
  "eqPreset",
  "eqGains",
  "visualizerEnabled",
  "ambientEnabled",
  "miniSpectrumEnabled",
  "visualizerStyle",
  "streamStats",
]);
const playbackAb = pickIds(playbackEntries, ["abVisual", "abLoopCountOn", "abLoopMaxCount"]);
const playbackSleep = pickIds(playbackEntries, ["sleepTimerOn", "sleepTimerMinutes"]);

function toggleFade() {
  playbackSettings.fadeSec = playbackSettings.fadeSec > 0 ? 0 : 1.5;
}
// AB 循环次数步进（范围 1-20 钳制）
function stepAbMax(delta: number) {
  const cur = Math.floor(Number(playbackSettings.abLoopMaxCount));
  playbackSettings.abLoopMaxCount = Math.min(
    20,
    Math.max(1, (Number.isFinite(cur) ? cur : 10) + delta),
  );
}
// 频点显示：1000 及以上缩写为 K（31/62/125/250/500/1K/2K/4K/8K/16K）
function fmtBand(f: number) {
  return f >= 1000 ? `${f / 1000}K` : String(f);
}
</script>

<style scoped>
/* 滑杆联动行（淡入淡出 / AB 计数） */
.fade-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 2px;
}
.fade-row .slider {
  flex: 1;
}

/* AB 循环次数步进器 */
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.step-btn {
  width: 24px;
  height: 24px;
  border-radius: 7px;
  border: 1px solid var(--border);
  background: var(--card2);
  color: var(--text2);
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s;
  line-height: 1;
}
@media (hover: hover) {
  .step-btn:hover {
    border-color: var(--accent);
    color: var(--accent-text);
    background: var(--accent-soft);
  }
}

/* 均衡器 */
.eq-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 4px;
}
.eq-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px 12px;
  margin-top: 14px;
  padding: 12px 10px;
  border-radius: 10px;
  background: var(--bg2);
  border: 1px solid var(--border);
}
.eq-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.eq-val {
  font-size: 10.5px;
  font-weight: 700;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.eq-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 5px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--bg3), var(--bg3));
  outline: none;
  cursor: pointer;
}
.eq-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 1px 4px var(--accent-glow2);
  border: none;
}
.eq-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border: none;
}
.eq-band {
  font-size: 10px;
  color: var(--text3);
  font-variant-numeric: tabular-nums;
}

/* 子开关（任务 C：氛围背景 / 迷你频谱）：缩进、小号字号、小号 switch */
.sub-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  cursor: pointer;
  padding: 3px 0 3px 14px;
  border-left: 2px solid var(--border);
  margin-left: 2px;
}
.setting-label.sub {
  font-size: 13px;
}
.setting-desc.sub {
  font-size: 11.5px;
}
.switch.sm {
  width: 40px;
  height: 22px;
  border-radius: 11px;
}
.switch.sm i {
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
}
.switch.sm.on i {
  transform: translateX(18px);
}
</style>
