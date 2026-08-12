<template>
  <div class="playlist" :class="{ compact }">
    <div class="pl-head">🎵 播放列表 ({{ state.songs.length }})</div>
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
            <span v-if="s.has_lyric" class="pl-lyric">🎤</span>
          </div>
        </div>
        <span v-if="i === state.currentIndex" class="pl-eq">♪</span>
      </div>
      <div v-if="!state.songs.length" class="pl-empty">
        {{ state.loading ? "扫描中…" : "没有歌曲，请设置歌曲库" }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { state, selectSong } from "../composables/usePlayer.js";

defineProps({
  compact: { type: Boolean, default: false },
});

function pick(i) {
  selectSong(i);
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
  font-size: 11px;
}
.pl-eq {
  color: var(--accent);
  font-weight: 700;
  animation: eq 1s infinite alternate;
  flex-shrink: 0;
}
@keyframes eq {
  from {
    opacity: 0.4;
  }
  to {
    opacity: 1;
  }
}
.pl-empty {
  text-align: center;
  color: var(--text3);
  font-size: 13px;
  padding: 30px 0;
}
</style>
