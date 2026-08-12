<template>
  <nav class="activity-bar" aria-label="面板切换">
    <button
      class="ab-btn"
      :class="{ on: state.musicLibOpen }"
      :title="state.musicLibOpen ? '收起音乐库' : '展开音乐库'"
      @click="toggleMusicLib()"
    >
      <Music2 :size="18" />
    </button>
    <button
      class="ab-btn"
      :class="{ on: state.playlistOpen }"
      :title="state.playlistOpen ? '收起播放列表' : '展开播放列表'"
      @click="togglePlaylist()"
    >
      <ListMusic :size="18" />
    </button>
  </nav>
</template>

<script setup>
import { Music2, ListMusic } from "@lucide/vue";
import { state, toggleMusicLib, togglePlaylist } from "../composables/usePlayer.js";
</script>

<style scoped>
.activity-bar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 10px;
  overflow-y: auto;
}
.ab-btn {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  color: var(--text3);
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
  flex-shrink: 0;
}
.ab-btn:hover {
  background: var(--card2);
  color: var(--text);
}
.ab-btn.on {
  color: var(--accent);
  background: var(--card2);
}
/* 激活指示条：左侧竖线 */
.ab-btn.on::before {
  content: "";
  position: absolute;
  left: -4px;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 16px;
  border-radius: 2px;
  background: var(--accent);
}
</style>
