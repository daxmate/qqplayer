<template>
  <div class="mv-page">
    <!-- 页头：返回 + 标题 -->
    <header class="mv-head">
      <button class="mv-back" :title="t('videos.back')" @click="$emit('back')">
        <ChevronLeft :size="22" />
      </button>
      <h1 class="mv-title">{{ t("videos.title") }}</h1>
      <span class="mv-head-spacer" />
    </header>

    <!-- 视频库（复用 VideoLibrary：列表 + 本地加载） -->
    <div class="mv-body">
      <VideoLibrary @open="onOpen" />
    </div>

    <!-- 全屏播放（覆盖迷你播放条） -->
    <div v-if="activeVideo" class="mv-player-overlay">
      <VideoPlayer :key="playerKey" :video="activeVideo" @close="activeVideo = null" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronLeft } from "@lucide/vue";
import VideoLibrary from "./VideoLibrary.vue";
import VideoPlayer from "./VideoPlayer.vue";
import type { VideoSource } from "./types";

defineEmits<{ back: [] }>();
const { t } = useI18n();

const activeVideo = ref<VideoSource | null>(null);
const playerKey = ref(0);

function onOpen(video: VideoSource) {
  activeVideo.value = video;
  playerKey.value += 1;
}
</script>

<style scoped>
.mv-page {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}
.mv-head {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px 12px 4px;
  padding-top: calc(12px + env(safe-area-inset-top));
}
.mv-back {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text2);
  background: var(--card);
  border: 1px solid var(--border);
  transition: all 0.15s;
  touch-action: manipulation;
  flex-shrink: 0;
}
.mv-back:active {
  background: var(--card2);
  color: var(--text);
  transform: scale(0.92);
}
.mv-title {
  flex: 1;
  min-width: 0;
  font-size: 20px;
  font-weight: 700;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: center;
}
.mv-head-spacer {
  width: 38px;
  flex-shrink: 0;
}
.mv-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 8px 14px 14px;
}
/* 全屏播放层：盖过页面栈与迷你播放条（仿 MobileBooks） */
.mv-player-overlay {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: var(--bg);
  padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom)
    env(safe-area-inset-left);
}
</style>
