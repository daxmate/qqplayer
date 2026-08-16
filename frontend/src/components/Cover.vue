<template>
  <div class="cover-wrap" :class="{ small, 'no-cover': !showCover }">
    <div class="cover-box">
      <img
        v-if="coverUrl"
        :src="coverUrl"
        class="cover-img"
        :class="{ spinning: state.isPlaying && !small }"
        :alt="t('app.coverAlt')"
        @error="onCoverError"
      />
      <div v-else class="cover-fallback">
        <Music :size="props.small ? 26 : 64" />
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, computed } from "vue";
import { Music } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { state, uiSettings } from "../composables/usePlayer.js";

const { t } = useI18n();

// 显示封面开关（设置 → 界面）：关闭时隐藏封面图片但保留占位。
// 选 visibility:hidden 而非 v-if/v-show：v-if 会换成 v-else 的回退图标（不是想要的效果），
// v-show（display:none）会折叠掉固定尺寸的 cover-box，破坏父级 flex 布局（列表行高/播放器封面区）；
// visibility:hidden 保留盒子尺寸与占位，small/大图两种变体都不影响布局。
const showCover = computed(() => !!uiSettings.showCover);

const props = defineProps({
  song: { type: Object, default: null },
  small: { type: Boolean, default: false },
});

const coverUrl = ref("");
const cache = new Map(); // path -> url

watch(
  () => {
    const s = props.song;
    return s ? s.path || s.coverUrl || "" : "";
  },
  (key) => {
    if (!key) {
      coverUrl.value = "";
      return;
    }
    if (cache.has(key)) {
      coverUrl.value = cache.get(key);
      return;
    }
    if (props.song?.coverUrl && !props.song?.path) {
      // 流媒体歌（stream / 试听 / URL）：网络图 URL 直用，不走 /api/cover
      coverUrl.value = props.song.coverUrl;
      cache.set(key, props.song.coverUrl);
      return;
    }
    coverUrl.value = "/api/cover?path=" + encodeURIComponent(key);
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
.cover-wrap.no-cover {
  visibility: hidden; /* 隐藏封面但保留占位（不折叠布局，见 showCover 注释） */
}
.cover-box {
  width: min(46vh, 340px);
  aspect-ratio: 1;
  border-radius: 50%;
  overflow: hidden;
  background: var(--card);
  box-shadow: 0 8px 30px var(--shadow);
  display: flex;
  align-items: center;
  justify-content: center;
}
.cover-wrap.small .cover-box {
  width: 64px;
  border-radius: 50%;
  box-shadow: 0 3px 10px var(--shadow-sm);
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
