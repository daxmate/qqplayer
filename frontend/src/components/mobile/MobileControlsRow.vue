<template>
  <div class="mp-controls-row">
    <button
      class="mp-cbtn mp-mode-btn"
      :class="{ on: state.playMode !== 'order' }"
      :title="playModeTitle"
      @click="cyclePlayMode"
    >
      <Shuffle v-if="state.playMode === 'shuffle'" :size="18" />
      <Repeat1 v-else-if="state.playMode === 'repeatOne'" :size="18" />
      <Repeat v-else :size="18" />
    </button>
    <button class="mp-cbtn" :title="t('control.prevSong')" @click="prevSong()">
      <SkipBack :size="20" />
    </button>
    <button class="mp-cbtn mp-play" :title="t('control.playPause')" @click="togglePlay">
      <Pause v-if="state.isPlaying" :size="26" />
      <Play v-else :size="26" />
    </button>
    <button class="mp-cbtn" :title="t('control.nextSong')" @click="nextSong()">
      <SkipForward :size="20" />
    </button>
    <button
      class="mp-cbtn mp-queue-btn"
      :class="{ on: queueOpen }"
      :title="t('mobile.player.queue')"
      @click="$emit('toggle-queue')"
    >
      <ListMusic :size="18" />
    </button>
    <div class="mp-moon-wrap">
      <button
        class="mp-cbtn mp-moon-btn"
        :class="{ on: sleepTimer.active }"
        :title="t('mobile.player.sleepTimer')"
        @click="$emit('open-sleep')"
      >
        <Moon :size="18" :fill="sleepTimer.active ? 'currentColor' : 'none'" />
      </button>
      <span v-if="sleepTimerText" class="mp-sleep-timer">{{ sleepTimerText }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
// 移动端播放页底部控制区（主播放页与全歌词界面共用同一份，保证视觉/行为一致）
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import {
  Shuffle,
  Repeat,
  Repeat1,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ListMusic,
  Moon,
} from "@lucide/vue";
import {
  state,
  cyclePlayMode,
  prevSong,
  nextSong,
  togglePlay,
} from "../../composables/usePlayer.js";
import { sleepTimer, sleepTimerText } from "../../composables/useSleepTimer.js";

defineProps({ queueOpen: { type: Boolean, default: false } });
defineEmits(["toggle-queue", "open-sleep"]);
const { t } = useI18n();

const playModeTitle = computed(() => {
  if (state.playMode === "shuffle") return t("control.modeShuffle");
  if (state.playMode === "repeatOne") return t("control.modeRepeatOne");
  return t("control.modeOrder");
});
</script>

<style scoped>
/* 底部控制区（从 MobilePlayer 原样搬移，视觉零变化） */
.mp-controls-row {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-around;
  gap: 4px;
  padding: 6px 20px calc(10px + env(safe-area-inset-bottom));
}
.mp-cbtn {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: transparent;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition:
    transform 0.12s,
    background 0.15s;
}
.mp-cbtn:active {
  transform: scale(0.92);
  background: var(--card2);
  color: var(--text);
}
.mp-cbtn.on {
  color: var(--accent);
}
.mp-play {
  width: 58px;
  height: 58px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 4px 16px var(--accent-glow2);
}
.mp-play:active {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
.mp-play svg {
  margin-left: 2px; /* 播放三角视觉居中 */
}
.mp-moon-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
}
/* 月亮附近小字：倒计时/已到点（连续模式） */
.mp-sleep-timer {
  position: absolute;
  top: calc(100% + 1px);
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  font-size: 9.5px;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}
</style>
