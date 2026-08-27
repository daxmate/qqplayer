<template>
  <div class="mv-page">
    <!-- 页头：返回 + 标题（分页屏模式 standalone=false：书架态隐藏返回按钮，仅播放器打开时显示用于关闭） -->
    <header class="mv-head">
      <button
        v-if="standalone || activeVideo"
        class="mv-back"
        :title="t('videos.back')"
        @click="onBack"
      >
        <ChevronLeft :size="22" />
      </button>
      <h1 class="mv-title">{{ t("videos.title") }}</h1>
      <span v-if="standalone || activeVideo" class="mv-head-spacer" />
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
import { ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChevronLeft } from "@lucide/vue";
import VideoLibrary from "./VideoLibrary.vue";
import VideoPlayer from "./VideoPlayer.vue";
import type { VideoSource } from "./types";

const props = withDefaults(defineProps<{ standalone?: boolean }>(), { standalone: true });
// back：独立页模式（壳层页面栈）向上 pop；overlay：全屏播放器浮层开关（分页屏模式供壳层禁用手势）
const emit = defineEmits<{ back: []; overlay: [open: boolean] }>();
const { t } = useI18n();

const activeVideo = ref<VideoSource | null>(null);
const playerKey = ref(0);

function onOpen(video: VideoSource) {
  activeVideo.value = video;
  playerKey.value += 1;
}

// 播放器浮层状态上报（分页屏模式：壳层据此禁用边缘滑动/横滑翻页）
watch(activeVideo, (v) => emit("overlay", !!v));

// 返回：播放器打开时先关播放器；列表态（独立页模式）才向上 pop
function onBack() {
  if (activeVideo.value) {
    activeVideo.value = null;
    return;
  }
  if (!props.standalone) return;
  emit("back");
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
