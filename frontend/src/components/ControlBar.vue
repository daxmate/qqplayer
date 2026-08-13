<template>
  <div class="controls" :class="{ karaoke }">
    <button v-if="!hideCollapse" class="collapse-btn" title="收起控制区" @click="toggleControls()">
      <ChevronDown :size="16" />
    </button>
    <!-- 进度条 -->
    <div class="progress-row">
      <span class="time">{{ fmt(state.currentTime) }}</span>
      <input
        v-if="state.duration > 0"
        class="progress"
        type="range"
        min="0"
        :max="state.duration"
        :value="state.currentTime"
        step="0.1"
        @input="onSeek"
      />
      <div v-else class="progress progress-empty"></div>
      <span class="time">{{ fmt(state.duration) }}</span>
    </div>

    <!-- 按钮 -->
    <div class="btn-row">
      <template v-if="!karaoke">
        <button
          class="btn"
          :class="{ on: state.playMode !== 'order' }"
          :title="playModeTitle"
          @click="cyclePlayMode"
        >
          <Shuffle v-if="state.playMode === 'shuffle'" :size="15" />
          <Repeat1 v-else-if="state.playMode === 'repeatOne'" :size="15" />
          <Repeat v-else :size="15" />
        </button>
      </template>
      <button class="btn" title="上一首" @click="prevSong">
        <SkipBack :size="17" />
      </button>

      <template v-if="karaoke">
        <button class="btn" title="上一句" @click="prevLine">
          <StepBack :size="17" />
        </button>
        <button class="btn play" title="播放/暂停" @click="togglePlay">
          <Pause v-if="state.isPlaying" :size="21" />
          <Play v-else :size="21" />
        </button>
        <button class="btn" title="下一句" @click="nextLine">
          <StepForward :size="17" />
        </button>
        <button class="btn" :class="{ on: state.speed !== 1.0 }" title="变速" @click="cycleSpeed">
          <Gauge :size="15" />
          {{ state.speed }}x
        </button>
        <button
          class="btn"
          :class="{ on: state.karaokeOn }"
          title="跟唱开关"
          @click="toggleKaraoke"
        >
          <Mic :size="15" />
          跟唱
        </button>
        <button
          class="btn"
          :class="{ on: state.abLoop || state.karaokeLoop }"
          :disabled="!state.karaokeOn"
          :title="loopTitle"
          @pointerdown="onLoopPressStart"
          @pointerup="onLoopPressEnd"
          @pointerleave="onLoopPressEnd"
          @click="onLoopClick"
        >
          <Repeat2 v-if="state.abLoop" :size="15" />
          <Repeat1 v-else :size="15" />
          {{ state.abLoop ? "AB" : "单句" }}
        </button>
      </template>
      <template v-else>
        <button class="btn play" title="播放/暂停" @click="togglePlay">
          <Pause v-if="state.isPlaying" :size="21" />
          <Play v-else :size="21" />
        </button>
        <button class="btn" title="下一首" @click="nextSong">
          <SkipForward :size="17" />
        </button>
      </template>

      <button class="btn" :class="{ on: state.zhVisible }" title="显示/隐藏中文" @click="toggleZh">
        <Languages :size="15" />
        译
      </button>

      <!-- 音量 -->
      <div class="vol-group">
        <button
          class="btn vol-btn"
          :title="state.muted || state.volume === 0 ? '取消静音' : '静音'"
          @click="toggleMute"
        >
          <VolumeX v-if="state.muted || state.volume === 0" :size="15" />
          <Volume1 v-else-if="state.volume < 0.5" :size="15" />
          <Volume2 v-else :size="15" />
        </button>
        <input
          class="vol-slider"
          type="range"
          min="0"
          max="1"
          step="0.05"
          :value="state.muted ? 0 : state.volume"
          title="音量"
          @input="onVolume"
        />
      </div>
    </div>

    <!-- 当前歌曲信息 -->
    <div class="song-line">
      <span v-if="state.currentSong" class="song-line-text">
        {{ state.currentSong.name }}
        <template v-if="state.currentSong.artist"> · {{ state.currentSong.artist }}</template>
        <span v-if="state.lyricFormat" class="fmt-badge">{{ state.lyricFormat }}</span>
      </span>
      <span v-else class="song-line-text dim">未选择歌曲</span>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  StepBack,
  StepForward,
  Mic,
  Gauge,
  Repeat1,
  Repeat2,
  Repeat,
  Shuffle,
  Languages,
} from "@lucide/vue";
import { state, setVolume, toggleMute } from "../composables/usePlayer.js";
import {
  togglePlay,
  nextSong,
  prevSong,
  seek,
  prevLine,
  nextLine,
  cycleSpeed,
  toggleKaraoke,
  toggleKaraokeLoop,
  enterAbLoop,
  exitAbLoop,
  toggleZh,
  cyclePlayMode,
  toggleControls,
} from "../composables/usePlayer.js";
import { ChevronDown, Volume1, Volume2, VolumeX } from "@lucide/vue";

defineProps({
  karaoke: { type: Boolean, default: false },
  // 全屏播放器等场景：不显示“收起控制区”按钮（移动端控制条始终展开）
  hideCollapse: { type: Boolean, default: false },
});

function onSeek(e) {
  seek(parseFloat(e.target.value));
}

function onVolume(e) {
  setVolume(parseFloat(e.target.value));
}

// 循环按钮：单击切换单句循环 / 退出 AB；长按 500ms 进入 AB 循环
let pressTimer = null;
let longPressFired = false;

const loopTitle = computed(() => {
  const ab = state.abLoop;
  if (ab) {
    return ab.b === null
      ? `AB 循环：起点第 ${ab.a + 1} 句，请点击歌词选终点（单击退出）`
      : `AB 循环：第 ${ab.a + 1} ~ ${ab.b + 1} 句（单击退出）`;
  }
  return "单击：单句循环；长按：AB 区间循环（需开启跟唱）";
});

// 连播播放模式：三态循环切换（列表循环 → 随机 → 单曲循环）
const playModeTitle = computed(() => {
  if (state.playMode === "shuffle") return "随机播放（点击切换）";
  if (state.playMode === "repeatOne") return "单曲循环（点击切换）";
  return "列表循环（点击切换）";
});

function onLoopPressStart() {
  if (!state.karaokeOn) return;
  longPressFired = false;
  pressTimer = setTimeout(() => {
    longPressFired = true;
    enterAbLoop();
  }, 500);
}

function onLoopPressEnd() {
  clearTimeout(pressTimer);
}

function onLoopClick() {
  if (longPressFired) {
    // 长按已触发 AB 循环，吞掉本次 click
    longPressFired = false;
    return;
  }
  if (state.abLoop) {
    exitAbLoop(); // AB 循环中：单击退出
  } else {
    toggleKaraokeLoop(); // 单句循环开关
  }
}

function fmt(t) {
  if (!t || isNaN(t)) return "0:00";
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return m + ":" + String(s).padStart(2, "0");
}
</script>

<style scoped>
.controls {
  position: relative;
  background: var(--card);
  border-radius: 16px;
  border: 1px solid var(--border);
  padding: 30px 20px 12px; /* 顶部留白容纳居中收起按钮 */
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.collapse-btn {
  position: absolute;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  width: 26px;
  height: 22px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
  opacity: 0.55;
  transition: all 0.15s;
}
.collapse-btn:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
}
.progress-row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.time {
  font-size: 12px;
  color: var(--text2);
  font-variant-numeric: tabular-nums;
  min-width: 38px;
  text-align: center;
}
.progress {
  flex: 1;
  -webkit-appearance: none;
  appearance: none;
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  outline: none;
  cursor: pointer;
}
.progress::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 2px 6px var(--accent-glow);
}
.progress-empty {
  cursor: default;
}
.btn-row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex-wrap: wrap;
}
.btn {
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--card2);
  color: var(--text);
  font-size: 14px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  transition: all 0.15s;
  white-space: nowrap;
}
.btn:hover {
  background: var(--border);
}
.btn:active {
  transform: scale(0.94);
}
.btn.play {
  width: 56px;
  height: 56px;
  font-size: 22px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  box-shadow: 0 4px 14px var(--accent-glow2);
}
.btn.on {
  background: var(--accent-on);
  color: var(--accent-ink);
  box-shadow: inset 0 0 0 1px var(--accent);
}
/* 带文字的按钮（变速/跟唱/译） */
.btn:has(span),
.btn:not(:has(> span)):not(.play) {
  padding: 0 16px;
}
.btn-row .btn {
  width: auto;
  min-width: 44px;
  padding: 0 14px;
  font-size: 13.5px;
}
.btn-row .btn.play {
  width: 56px;
  font-size: 22px;
  padding: 0;
}
.vol-group {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-left: 6px;
  padding-left: 14px;
  border-left: 1px solid var(--border);
}
.vol-btn {
  min-width: 36px !important;
  padding: 0 10px !important;
}
.vol-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 80px;
  height: 5px;
  border-radius: 3px;
  background: var(--border);
  outline: none;
  cursor: pointer;
}
.vol-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  box-shadow: 0 2px 6px var(--accent-glow);
}
.btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
  pointer-events: none;
}
.song-line {
  text-align: center;
  font-size: 12.5px;
  color: var(--text2);
}
.song-line-text.dim {
  color: var(--text3);
}
.fmt-badge {
  display: inline-block;
  margin-left: 8px;
  padding: 1px 8px;
  border-radius: 8px;
  background: var(--card2);
  color: var(--text2);
  font-size: 10.5px;
  text-transform: uppercase;
  vertical-align: 1px;
}
</style>
