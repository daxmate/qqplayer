<template>
  <div class="app">
    <!-- 顶栏 -->
    <header class="topbar">
      <h1 class="logo">🎵 Music Player</h1>
      <div class="mode-tabs">
        <button
          class="tab"
          :class="{ on: state.mode === 'continuous' }"
          @click="switchMode('continuous')"
        >
          ▶ 连播
        </button>
        <button
          class="tab"
          :class="{ on: state.mode === 'karaoke' }"
          @click="switchMode('karaoke')"
        >
          🎤 跟唱
        </button>
      </div>
      <div class="lib">
        <span class="lib-label">📂 歌曲库</span>
        <input
          v-model="libInput"
          class="lib-input"
          placeholder="文件夹路径"
          @keyup.enter="applyLibrary"
        />
        <button class="btn small" @click="applyLibrary">设置</button>
        <button class="btn small" @click="refreshSongs" title="重新扫描">⟳</button>
      </div>
    </header>

    <!-- 主体：连播模式 -->
    <main v-if="state.mode === 'continuous'" class="main continuous">
      <Playlist class="panel playlist" />
      <section class="center">
        <Cover :song="state.currentSong" />
        <LyricPanel v-if="state.lyric.length" :lyric="state.lyric" :current="currentLineIndex" />
        <div v-else class="no-lyric">🎶 暂无歌词（可放置同名 .srt / .lrc）</div>
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
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import Playlist from "./components/Playlist.vue";
import Cover from "./components/Cover.vue";
import LyricPanel from "./components/LyricPanel.vue";
import KaraokePanel from "./components/KaraokePanel.vue";
import ControlBar from "./components/ControlBar.vue";
import {
  state,
  loadSongs,
  loadLibrary,
  setLibrary,
  currentLineIndex,
} from "./composables/usePlayer.js";

const libInput = ref("");

function switchMode(m) {
  state.mode = m;
}

async function applyLibrary() {
  const p = libInput.value.trim();
  if (!p) return;
  try {
    await setLibrary(p);
    libInput.value = "";
  } catch (e) {
    state.error = e.message;
    setTimeout(() => (state.error = ""), 3000);
  }
}

async function refreshSongs() {
  await loadSongs();
}

onMounted(async () => {
  await loadLibrary();
  libInput.value = state.libraryPath;
  await loadSongs();
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
}
.tab.on {
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
}
.lib {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.lib-label {
  font-size: 13px;
  color: var(--text2);
  white-space: nowrap;
}
.lib-input {
  flex: 1;
  min-width: 120px;
  background: var(--bg2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 7px 12px;
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.lib-input:focus {
  border-color: var(--accent);
}
.btn {
  border-radius: 10px;
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  background: var(--card2);
  color: var(--text);
  transition: all 0.15s;
}
.btn:hover {
  background: var(--border);
}
.btn.small {
  padding: 7px 12px;
  font-size: 12px;
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
  color: var(--text3);
  font-size: 14px;
  min-height: 80px;
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
