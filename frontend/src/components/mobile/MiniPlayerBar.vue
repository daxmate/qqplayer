<template>
  <div class="mini-player" @click="$emit('open-player')">
    <!-- 封面 -->
    <div class="mp-cover">
      <img
        v-if="coverUrl && !coverError"
        :src="coverUrl"
        class="mp-cover-img"
        alt=""
        @error="coverError = true"
      />
      <Music2 v-else :size="20" />
    </div>
    <!-- 歌名 / 歌手 -->
    <div class="mp-info">
      <div class="mp-name">{{ state.currentSong?.name || t("control.noSong") }}</div>
      <div class="mp-artist">{{ state.currentSong?.artist || "" }}</div>
    </div>
    <!-- 控制：播放/暂停 + 下一首 -->
    <div class="mp-btns" @click.stop>
      <button
        class="mp-btn"
        :class="{ disabled: !state.currentSong }"
        :title="t('control.playPause')"
        @click="togglePlay"
      >
        <Pause v-if="state.isPlaying" :size="22" />
        <Play v-else :size="22" />
      </button>
      <button
        class="mp-btn"
        :class="{ disabled: !state.currentSong }"
        :title="t('control.nextSong')"
        @click="nextSong()"
      >
        <SkipForward :size="20" />
      </button>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from "vue";
import { Music2, Play, Pause, SkipForward } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { state, togglePlay, nextSong } from "../../composables/usePlayer.js";

const { t } = useI18n();

defineEmits(["open-player"]);

const coverUrl = ref("");
const coverError = ref(false);

// 封面路径变化 → 重取（错误缓存按路径重置）
watch(
  () => state.currentSong?.path,
  (p) => {
    coverError.value = false;
    coverUrl.value = p ? "/api/cover?path=" + encodeURIComponent(p) : "";
  },
  { immediate: true },
);
</script>

<style scoped>
.mini-player {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  padding-bottom: calc(8px + env(safe-area-inset-bottom));
  background: var(--card);
  border-top: 1px solid var(--border);
  cursor: pointer;
  min-height: 60px;
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
}
.mp-cover {
  width: 44px;
  height: 44px;
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--card2);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text3);
}
.mp-cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.mp-info {
  flex: 1;
  min-width: 0;
}
.mp-name {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-artist {
  font-size: 12px;
  color: var(--text3);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mp-btns {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}
.mp-btn {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  transition: all 0.15s;
  touch-action: manipulation;
}
.mp-btn:active {
  background: var(--card2);
  transform: scale(0.92);
}
.mp-btn.disabled {
  opacity: 0.35;
}
</style>
