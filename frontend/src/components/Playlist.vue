<template>
  <div class="playlist" :class="{ compact }">
    <div class="pl-head">
      <Music :size="13" />
      播放列表 ({{ state.songs.length }})
      <button
        class="pl-refresh"
        :class="{ spinning: state.loading }"
        title="重新扫描"
        @click="loadSongs()"
      >
        <RefreshCw :size="17" />
      </button>
    </div>
    <div class="pl-list">
      <div
        v-for="(s, i) in state.songs"
        :key="s.id"
        class="pl-item"
        :class="{ active: i === state.currentIndex }"
        @click="pick(i)"
      >
        <span class="pl-idx">{{ i + 1 }}</span>
        <div class="pl-info">
          <div class="pl-name">{{ s.name }}</div>
          <div class="pl-artist">
            {{ s.artist }}
            <span v-if="s.has_lyric" class="pl-lyric" title="有歌词">
              <Mic :size="11" />
            </span>
          </div>
        </div>
        <span v-if="i === state.currentIndex" class="pl-eq" title="播放中">
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
          <span class="eq-bar"></span>
        </span>
      </div>
      <div v-if="!state.songs.length" class="pl-empty">
        {{ state.loading ? "扫描中…" : "没有歌曲，请设置歌曲库" }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { Music, Mic, RefreshCw } from "@lucide/vue";
import { state, selectSong, loadSongs, play } from "../composables/usePlayer.js";

defineProps({
  compact: { type: Boolean, default: false },
});

function pick(i) {
  selectSong(i);
  play(); // 点击列表直接开始播放
}
</script>

<style scoped>
.playlist {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.pl-head {
  padding: 12px 14px;
  font-size: 13px;
  font-weight: 700;
  color: var(--text2);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.pl-refresh {
  margin-left: auto;
  width: 32px;
  height: 32px;
  border-radius: 9px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--card2);
  color: var(--text2);
  transition: all 0.15s;
  flex-shrink: 0;
}
.pl-refresh:hover {
  background: var(--border);
  color: var(--text);
}
.pl-refresh:active {
  transform: scale(0.92);
}
.pl-refresh.spinning svg {
  animation: refresh-spin 0.9s linear infinite;
}
@keyframes refresh-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.pl-list {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}
.pl-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 10px;
  cursor: pointer;
  transition: background 0.12s;
}
.pl-item:hover {
  background: var(--card2);
}
.pl-item.active {
  background: linear-gradient(135deg, rgba(255, 126, 95, 0.22), rgba(254, 180, 123, 0.12));
}
.pl-idx {
  width: 20px;
  font-size: 12px;
  color: var(--text3);
  text-align: right;
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.pl-info {
  flex: 1;
  min-width: 0;
}
.pl-name {
  font-size: 13.5px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-artist {
  font-size: 11.5px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pl-lyric {
  display: inline-flex;
  vertical-align: -2px;
  margin-left: 4px;
  color: var(--text2);
}
.pl-eq {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 13px;
  flex-shrink: 0;
  color: var(--accent);
}
.eq-bar {
  width: 3px;
  border-radius: 1.5px;
  background: currentColor;
  height: 100%;
  animation: eq-bounce 1s ease-in-out infinite;
}
.eq-bar:nth-child(2) {
  animation-delay: -0.33s;
}
.eq-bar:nth-child(3) {
  animation-delay: -0.66s;
}
@keyframes eq-bounce {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
</style>
