<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <h1 class="logo">
        <span class="logo-bubbles" aria-hidden="true">
          <span class="qq q1">Q</span>
          <span class="qq q2"><span class="qq-face">Q</span></span>
        </span>
        <span class="logo-text">Player</span>
      </h1>
      <div class="mode-tabs">
        <button
          class="tab"
          :class="{ on: state.mode === 'continuous' }"
          @click="switchMode('continuous')"
        >
          <Play :size="13" />
          连播
        </button>
        <button
          class="tab"
          :class="{ on: state.mode === 'karaoke' }"
          @click="switchMode('karaoke')"
        >
          <Mic :size="13" />
          跟唱
        </button>
      </div>
      <button
        class="gear-btn"
        title="设置"
        @click="settingsOpen = true"
      >
        <Settings :size="18" />
      </button>
    </header>

    <!-- 主体：连播模式 -->
    <main v-if="state.mode === 'continuous'" class="main continuous">
      <Playlist class="panel playlist" />
      <section class="center">
        <Cover :song="state.currentSong" />
        <LyricPanel v-if="state.lyric.length" :lyric="state.lyric" :current="currentLineIndex" />
        <div v-else class="no-lyric">
          <Music2 :size="40" class="no-lyric-icon" />
          <span>暂无歌词（可放置同名 .srt / .lrc）</span>
        </div>
      </section>
      <ControlBar class="panel controls" />
    </main>

    <!-- 主体：跟唱模式 -->
    <main v-else class="main karaoke">
      <aside class="side">
        <Playlist class="panel playlist" compact />
        <div class="panel song-info">
          <Cover :song="state.currentSong" small />
          <div class="song-meta">
            <div class="song-name">{{ state.currentSong?.name || "未选择" }}</div>
            <div class="song-artist">{{ state.currentSong?.artist || "" }}</div>
            <div v-if="!state.lyric.length" class="no-lyric small">
              无歌词文件，跟唱需同名 .srt/.lrc
            </div>
          </div>
        </div>
      </aside>
      <KaraokePanel class="panel karaoke-panel" :lyric="state.lyric" :current="currentLineIndex" />
      <ControlBar class="panel controls" karaoke />
    </main>

    <div v-if="state.error" class="error-bar">{{ state.error }}</div>

    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { Music2, Mic, Play, Settings } from "@lucide/vue";
import Playlist from "./components/Playlist.vue";
import Cover from "./components/Cover.vue";
import LyricPanel from "./components/LyricPanel.vue";
import KaraokePanel from "./components/KaraokePanel.vue";
import ControlBar from "./components/ControlBar.vue";
import SettingsModal from "./components/SettingsModal.vue";
import {
  state,
  loadSongs,
  currentLineIndex,
} from "./composables/usePlayer.js";

const settingsOpen = ref(false);

function switchMode(m) {
  state.mode = m;
}

onMounted(() => {
  loadSongs();
});
</script>

<style scoped>
.app {
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 顶栏 */
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 20px;
  background: rgba(20, 22, 31, 0.9);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.logo {
  font-size: 18px;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 10px;
}
.logo-bubbles {
  display: inline-flex;
  align-items: center;
}
.qq {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: "Didot", "Baskerville", Georgia, serif;
  font-size: 24px;
  font-weight: 700;
  color: #fff;
  box-shadow: 0 3px 8px rgba(0, 0, 0, 0.25);
  flex-shrink: 0;
}
.q1 {
  background: linear-gradient(135deg, #ff9ab5, #ff7e6b);
  transform: rotate(-10deg);
  z-index: 1;
}
.q2 {
  background: linear-gradient(135deg, #ffc06b, #ff9a5c);
  transform: rotate(10deg);
  margin-left: -6px;
}
.qq-face {
  display: block;
  transform: scaleX(-1);
}
.logo-text {
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 18px;
  font-weight: 500;
  letter-spacing: 1.5px;
  color: var(--text);
}
.mode-tabs {
  display: flex;
  background: var(--bg2);
  border-radius: 12px;
  padding: 3px;
  flex-shrink: 0;
}
.tab {
  padding: 8px 18px;
  border-radius: 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text2);
  transition: all 0.15s;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.gear-btn {
  margin-left: auto;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.gear-btn:hover {
  background: var(--card2);
  color: var(--text);
}
.gear-btn svg {
  transition: transform 0.4s;
}
.gear-btn:hover svg {
  transform: rotate(60deg);
}

/* 主体 */
.main {
  flex: 1;
  display: flex;
  gap: 14px;
  padding: 14px 20px;
  min-height: 0;
}
.main.continuous {
  display: grid;
  grid-template-columns: 280px 1fr;
  grid-template-rows: 1fr auto;
  grid-template-areas:
    "playlist center"
    "controls controls";
}
.playlist {
  grid-area: playlist;
}
.center {
  grid-area: center;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}
.controls {
  grid-area: controls;
}
.no-lyric {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text3);
  font-size: 14px;
  min-height: 80px;
}
.no-lyric-icon {
  opacity: 0.6;
}
.no-lyric.small {
  flex: none;
  font-size: 12px;
  justify-content: flex-start;
  margin-top: 6px;
}

/* 跟唱模式布局 */
.main.karaoke {
  display: grid;
  grid-template-columns: 300px 1fr;
  grid-template-rows: 1fr auto;
  grid-template-areas:
    "side karaoke-panel"
    "controls controls";
}
.side {
  grid-area: side;
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  overflow: hidden;
}
.side .playlist {
  flex: 1;
  min-height: 0;
}
.song-info {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-shrink: 0;
}
.song-meta {
  min-width: 0;
}
.song-name {
  font-size: 15px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.song-artist {
  font-size: 12px;
  color: var(--text2);
  margin-top: 3px;
}
.karaoke-panel {
  grid-area: karaoke-panel;
}
.error-bar {
  position: fixed;
  left: 50%;
  bottom: 80px;
  transform: translateX(-50%);
  background: rgba(220, 60, 60, 0.92);
  color: #fff;
  padding: 10px 20px;
  border-radius: 20px;
  font-size: 13px;
  z-index: 99;
}
</style>
