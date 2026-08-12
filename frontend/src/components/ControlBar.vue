<template>
  <div class="controls" :class="{ karaoke }">
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
      <button class="btn" @click="prevSong" title="上一首">⏮</button>

      <template v-if="karaoke">
        <button class="btn" @click="prevLine" title="上一句">⏪</button>
        <button class="btn play" @click="togglePlay" title="播放/暂停">
          {{ state.isPlaying ? "⏸" : "▶" }}
        </button>
        <button class="btn" @click="nextLine" title="下一句">⏩</button>
        <button class="btn" :class="{ on: state.speed !== 1.0 }" @click="cycleSpeed" title="变速">
          🐢 {{ state.speed }}x
        </button>
        <button
          class="btn"
          :class="{ on: state.karaokeOn }"
          @click="toggleKaraoke"
          title="跟唱开关"
        >
          🎤 跟唱
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
          {{ state.abLoop ? "🔁 AB" : "🔁 单句" }}
        </button>
      </template>
      <template v-else>
        <button class="btn play" @click="togglePlay" title="播放/暂停">
          {{ state.isPlaying ? "⏸" : "▶" }}
        </button>
        <button class="btn" @click="nextSong" title="下一首">⏭</button>
      </template>

      <button class="btn" :class="{ on: state.zhVisible }" @click="toggleZh" title="显示/隐藏中文">
        译
      </button>
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
import { state } from "../composables/usePlayer.js";
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
} from "../composables/usePlayer.js";

defineProps({
  karaoke: { type: Boolean, default: false },
});

function onSeek(e) {
  seek(parseFloat(e.target.value));
}

// 🔁 按钮：单击切换单句循环 / 退出 AB；长按 500ms 进入 AB 循环
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
  background: var(--card);
  border-radius: 16px;
  border: 1px solid var(--border);
  padding: 14px 20px 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
  box-shadow: 0 2px 6px rgba(255, 126, 95, 0.4);
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
  font-size: 17px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
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
  box-shadow: 0 4px 14px rgba(255, 126, 95, 0.35);
}
.btn.on {
  background: rgba(255, 126, 95, 0.3);
  color: #ffb59d;
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
  font-size: 14px;
}
.btn-row .btn.play {
  width: 56px;
  font-size: 22px;
}
.btn-row .btn:has(🐢),
.btn-row .btn:has(🎤),
.btn-row .btn:has(🔁),
.btn-row .btn:has(译) {
  padding: 0 14px;
  font-size: 13.5px;
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
