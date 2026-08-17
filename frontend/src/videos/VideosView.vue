<template>
  <div class="videos-view">
    <!-- 播放器 ↔ 视频库切换（仿 books：BooksView 的 Reader/Bookshelf 切换） -->
    <VideoPlayer v-if="active" :key="activeKey" :video="active" @close="onClose" />
    <VideoLibrary v-else @open="onOpen" />
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted } from "vue";
import VideoLibrary from "./VideoLibrary.vue";
import VideoPlayer from "./VideoPlayer.vue";
import type { VideoSource } from "./types";

const active = ref<VideoSource | null>(null);
// 每开一个新视频重建播放器（重置状态 + 重新拉字幕）
const activeKey = ref(0);

function onOpen(video: VideoSource) {
  active.value = video;
  activeKey.value += 1;
}

function onClose() {
  active.value = null;
}

// 本地加载的 object URL 生命周期由 VideoPlayer 卸载时释放；这里兜底（如组件被销毁）
onUnmounted(() => {
  if (active.value?.localUrl) URL.revokeObjectURL(active.value.localUrl);
});
</script>

<style scoped>
.videos-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
</style>
