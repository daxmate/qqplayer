<template>
  <div class="app">
    <div v-if="blurCoverUrl" class="bg-blur" :style="{ backgroundImage: `url(${blurCoverUrl})` }" />
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
      <button class="gear-btn" title="设置" @click="settingsOpen = true">
        <Settings :size="18" />
      </button>
    </header>

    <!-- 主体：连播模式 -->
    <main v-if="state.mode === 'continuous'" class="main continuous" :class="panelClass">
      <ActivityBar v-if="panelsActive" class="activity-bar" />
      <button
        v-if="!panelsActive"
        class="floating-panel-btn"
        title="展开面板"
        @click="toggleMusicLib()"
      >
        <PanelLeftOpen :size="16" />
      </button>
      <Sidebar v-if="state.musicLibOpen" class="panel sidebar" />
      <Playlist v-if="state.playlistOpen" class="panel playlist" />
      <section class="center">
        <Cover :song="state.currentSong" />
        <LyricPanel v-if="state.lyric.length" :lyric="state.lyric" :current="currentLineIndex" />
        <div v-else class="no-lyric">
          <Music2 :size="40" class="no-lyric-icon" />
          <span>暂无歌词（可放置同名 .srt / .lrc）</span>
        </div>
      </section>
      <ControlBar v-show="!state.controlsHidden" class="panel controls" />
      <button
        v-if="state.controlsHidden"
        class="expand-controls-btn"
        title="展开控制区"
        @click="toggleControls()"
      >
        <ChevronUp :size="18" />
      </button>
    </main>

    <!-- 主体：跟唱模式 -->
    <main v-else class="main karaoke" :class="panelClass">
      <ActivityBar v-if="panelsActive" class="activity-bar" />
      <Sidebar v-if="state.musicLibOpen" class="panel sidebar" />
      <Playlist v-if="state.playlistOpen" class="panel playlist" />
      <KaraokePanel
        class="panel karaoke-panel"
        :lyric="state.lyric"
        :current="currentLineIndex"
        :expand-btn="!panelsActive"
      />
      <ControlBar v-show="!state.controlsHidden" class="panel controls" karaoke />
      <button
        v-if="state.controlsHidden"
        class="expand-controls-btn"
        title="展开控制区"
        @click="toggleControls()"
      >
        <ChevronUp :size="18" />
      </button>
    </main>

    <div v-if="state.error" class="error-bar">{{ state.error }}</div>

    <SettingsModal :open="settingsOpen" @close="settingsOpen = false" />
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { Music2, Mic, Play, Settings, PanelLeftOpen, ChevronUp } from "@lucide/vue";
import Playlist from "./components/Playlist.vue";
import Sidebar from "./components/Sidebar.vue";
import ActivityBar from "./components/ActivityBar.vue";
import Cover from "./components/Cover.vue";
import LyricPanel from "./components/LyricPanel.vue";
import KaraokePanel from "./components/KaraokePanel.vue";
import ControlBar from "./components/ControlBar.vue";
import SettingsModal from "./components/SettingsModal.vue";
import {
  state,
  loadSongs,
  loadFavorites,
  loadPlaylists,
  setupKeyboardShortcuts,
  setupMediaSession,
  setupPlaybackFlush,
  setupAutoRefresh,
  restoreLastPlayed,
  toggleControls,
  toggleMusicLib,
  currentLineIndex,
  uiSettings,
} from "./composables/usePlayer.js";

const settingsOpen = ref(false);

// 封面模糊背景：当前歌曲封面 URL（开关 + 有歌时显示）
const blurCoverUrl = computed(() => {
  if (!uiSettings.coverBlur || !state.currentSong) return "";
  return "/api/cover?path=" + encodeURIComponent(state.currentSong.path);
});

// 面板组合 class：控制 grid 列数/区域（4 种状态）
const panelsActive = computed(() => state.musicLibOpen || state.playlistOpen);
const panelClass = computed(() => {
  const c = [];
  if (panelsActive.value) c.push("has-tabbar");
  if (state.musicLibOpen) c.push("has-music");
  if (state.playlistOpen) c.push("has-playlist");
  if (state.controlsHidden) c.push("no-controls");
  return c;
});

function switchMode(m) {
  state.mode = m;
}

onMounted(() => {
  loadSongs().then(() => restoreLastPlayed());
  loadFavorites();
  loadPlaylists();
  setupKeyboardShortcuts();
  setupMediaSession();
  setupPlaybackFlush();
  setupAutoRefresh();
});
</script>

<style scoped>
.app {
  position: relative;
  height: 100vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
/* 封面模糊背景层（fixed 全屏垫底，面板半透明后透出） */
.bg-blur {
  position: fixed;
  inset: 0;
  z-index: 0;
  background-size: cover;
  background-position: center;
  filter: blur(64px) saturate(1.5);
  transform: scale(1.2); /* 模糊后边缘不留黑 */
  opacity: 0.55;
  pointer-events: none;
  transition: opacity 0.5s;
}
.bg-blur::after {
  content: "";
  position: absolute;
  inset: 0;
  background: var(--blur-mask);
}
.app > *:not(.bg-blur) {
  position: relative;
  z-index: 1;
}
/* 顶栏 */
.topbar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 12px 20px;
  background: var(--topbar-bg);
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
  box-shadow: 0 3px 8px var(--shadow-sm);
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
.main.continuous,
.main.karaoke {
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: 1fr auto;
  grid-template-areas:
    "center"
    "controls";
  position: relative;
}
.main.continuous.has-tabbar,
.main.karaoke.has-tabbar {
  grid-template-columns: 44px 1fr;
  grid-template-areas:
    "activity center"
    "activity controls";
}
.main.continuous.has-tabbar.has-music,
.main.karaoke.has-tabbar.has-music {
  grid-template-columns: 44px 200px 1fr;
  grid-template-areas:
    "activity sidebar center"
    "activity controls controls";
}
.main.continuous.has-tabbar.has-playlist,
.main.karaoke.has-tabbar.has-playlist {
  grid-template-columns: 44px 280px 1fr;
  grid-template-areas:
    "activity playlist center"
    "activity controls controls";
}
.main.continuous.has-tabbar.has-music.has-playlist,
.main.karaoke.has-tabbar.has-music.has-playlist {
  grid-template-columns: 44px 200px 280px 1fr;
  grid-template-areas:
    "activity sidebar playlist center"
    "activity controls controls controls";
}
/* 控制区收起：去掉 controls 行，内容区占满 */
.main.continuous.no-controls,
.main.karaoke.no-controls {
  grid-template-rows: 1fr;
  grid-template-areas: "center";
}
.main.continuous.has-tabbar.no-controls,
.main.karaoke.has-tabbar.no-controls {
  grid-template-areas: "activity center";
}
.main.continuous.has-tabbar.has-music.no-controls,
.main.karaoke.has-tabbar.has-music.no-controls {
  grid-template-areas: "activity sidebar center";
}
.main.continuous.has-tabbar.has-playlist.no-controls,
.main.karaoke.has-tabbar.has-playlist.no-controls {
  grid-template-areas: "activity playlist center";
}
.main.continuous.has-tabbar.has-music.has-playlist.no-controls,
.main.karaoke.has-tabbar.has-music.has-playlist.no-controls {
  grid-template-areas: "activity sidebar playlist center";
}
.activity-bar {
  grid-area: activity;
  border-right: 1px solid var(--border);
  background: var(--bg2);
  border-radius: 16px 0 0 16px;
}
.sidebar {
  grid-area: sidebar;
}
.playlist {
  grid-area: playlist;
}
/* 都关时：内容区左上角悬浮展开按钮（不占布局，logo 不移位） */
.floating-panel-btn {
  position: absolute;
  top: 14px;
  left: 20px;
  z-index: 10;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  opacity: 0.6;
  transition: all 0.15s;
}
.floating-panel-btn:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
}
.expand-controls-btn {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  opacity: 0.6;
  transition: all 0.15s;
}
.expand-controls-btn:hover {
  opacity: 1;
  color: var(--text);
  background: var(--border);
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
/* 跟唱模式：复用连播的面板 grid（选择器在上方成对共用），karaoke-panel 占中央区域 */
.karaoke-panel {
  grid-area: center;
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
