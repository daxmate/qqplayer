<template>
  <div class="mobile-player">
    <!-- 顶栏：收起 + 连播/跟唱切换 + 收藏 -->
    <header class="mp-head">
      <button class="mp-btn-round" title="收起播放器" @click="$emit('back')">
        <ChevronDown :size="22" />
      </button>

      <div class="mp-tabs">
        <button
          class="mp-tab"
          :class="{ on: state.mode === 'continuous' }"
          @click="switchMode('continuous')"
        >
          <Play :size="13" />
          连播
        </button>
        <button
          class="mp-tab"
          :class="{ on: state.mode === 'karaoke' }"
          @click="switchMode('karaoke')"
        >
          <Mic :size="13" />
          跟唱
        </button>
      </div>

      <button
        v-if="state.currentSong"
        class="mp-btn-round"
        :class="{ on: isFavorite(state.currentSong.path) }"
        :title="isFavorite(state.currentSong.path) ? '取消收藏' : '收藏'"
        @click="toggleFavorite(state.currentSong.path)"
      >
        <Heart :size="20" :fill="isFavorite(state.currentSong.path) ? 'currentColor' : 'none'" />
      </button>
      <span v-else class="mp-btn-round"></span>
    </header>

    <!-- 主体 -->
    <div class="mp-body">
      <!-- 连播模式：封面大图 + 歌名/歌手（控制条在底部） -->
      <template v-if="state.mode === 'continuous'">
        <div class="mp-cover-area">
          <Cover :song="state.currentSong" />
        </div>
        <Visualizer small />
        <div class="mp-song-info">
          <div class="mp-song-name">{{ state.currentSong?.name || "未选择歌曲" }}</div>
          <div class="mp-song-artist">
            {{ state.currentSong?.artist || "" }}
            <template v-if="state.currentSong?.album"> · {{ state.currentSong.album }}</template>
          </div>
        </div>
      </template>

      <!-- 跟唱模式：全屏歌词页（复用 KaraokePanel：点句播放/AB 循环/单句循环） -->
      <div v-else class="mp-karaoke">
        <KaraokePanel :lyric="state.lyric" :current="currentLineIndex" :expand-btn="false" />
      </div>
    </div>

    <!-- 控制条（复用 ControlBar：进度/播放模式三态/循环/音量/译 等） -->
    <!-- 睡眠定时器倒计时（从简小字） -->
    <div v-if="sleepTimerText" class="mp-sleep-timer">{{ sleepTimerText }}</div>
    <ControlBar :karaoke="state.mode === 'karaoke'" hide-collapse class="mp-controls" />
  </div>
</template>

<script setup>
import { Play, Mic, Heart, ChevronDown } from "@lucide/vue";
import {
  state,
  isFavorite,
  toggleFavorite,
  currentLineIndex,
} from "../../composables/usePlayer.js";
import Cover from "../Cover.vue";
import Visualizer from "../Visualizer.vue";
import KaraokePanel from "../KaraokePanel.vue";
import ControlBar from "../ControlBar.vue";
import { sleepTimerText } from "../../composables/useSleepTimer.js";

defineEmits(["back"]);

function switchMode(m) {
  state.mode = m;
}
</script>

<style scoped>
.mobile-player {
  position: absolute;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: linear-gradient(160deg, var(--bg), var(--bg2));
}
.mp-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
  padding-top: calc(8px + env(safe-area-inset-top));
}
.mp-btn-round {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  flex-shrink: 0;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
}
.mp-btn-round:active {
  background: var(--card2);
  color: var(--text);
}
.mp-btn-round.on {
  color: var(--red);
}
.mp-tabs {
  display: flex;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 3px;
  flex-shrink: 0;
}
.mp-tab {
  padding: 7px 16px;
  border-radius: 9px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text2);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  transition: all 0.15s;
}
.mp-tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.mp-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 8px 16px 0;
}
.mp-cover-area {
  display: flex;
  justify-content: center;
}
.mp-body :deep(.visualizer) {
  margin-top: 14px;
}
.mp-song-info {
  text-align: center;
  margin-top: 18px;
  min-width: 0;
  padding: 0 12px;
}
.mp-song-name {
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-song-artist {
  font-size: 13.5px;
  color: var(--text3);
  margin-top: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-karaoke {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.mp-karaoke > * {
  flex: 1;
  min-height: 0;
}
.mp-sleep-timer {
  flex-shrink: 0;
  text-align: center;
  font-size: 12px;
  color: var(--text3);
  padding: 2px 0 0;
  font-variant-numeric: tabular-nums;
}
.mp-controls {
  flex-shrink: 0;
}
</style>
