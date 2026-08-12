<template>
  <div class="cover-wrap" :class="{ small }">
    <div class="cover-box">
      <img
        v-if="coverUrl"
        :src="coverUrl"
        class="cover-img"
        :class="{ spinning: state.isPlaying && !small }"
        alt="封面"
        @error="onCoverError"
      />
      <div v-else class="cover-fallback">
        <Music :size="props.small ? 26 : 64" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch } from "vue";
import { Music } from "@lucide/vue";
import { state } from "../composables/usePlayer.js";

const props = defineProps({
  song: { type: Object, default: null },
  small: { type: Boolean, default: false },
});

const coverUrl = ref("");
const cache = new Map(); // path -> url

watch(
  () => props.song?.path,
  (p) => {
    if (!p) {
      coverUrl.value = "";
      return;
    }
    if (cache.has(p)) {
      coverUrl.value = cache.get(p);
      return;
    }
    coverUrl.value = "/api/cover?path=" + encodeURIComponent(p);
  },
  { immediate: true },
);

function onCoverError() {
  // 404/加载失败：回退占位并缓存，避免反复请求
  const p = props.song?.path;
  if (p) cache.set(p, "");
  coverUrl.value = "";
}
</script>

<style scoped>
.cover-wrap {
  display: flex;
  justify-content: center;
  align-items: center;
  flex-shrink: 0;
}
.cover-box {
  width: min(46vh, 340px);
  aspect-ratio: 1;
  border-radius: 18px;
  overflow: hidden;
  background: var(--card);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cover-wrap.small .cover-box {
  width: 64px;
  border-radius: 12px;
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.35);
}
.cover-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.cover-img.spinning {
  animation: spin 24s linear infinite;
}
@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.cover-fallback {
  color: var(--text3);
  opacity: 0.7;
}
</style>
