<template>
  <div class="cover-wrap" :class="{ small, 'no-cover': !showCover }">
    <div class="cover-box" :style="boxStyle">
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
import { state } from "../composables/usePlayer.js";
import { coverVisible } from "../composables/useCoverGuard.ts";
import { resolveServerUrl } from "../utils/apiClient.js";

const { t } = useI18n();

// 显示封面开关（设置 → 界面）：关闭时封面完全不占位（display:none），歌词区/氛围背景自动扩充铺满。
// 2026-08-16（任务 E）由 visibility:hidden 改为 display:none——旧方案保留占位会把封面区空一块；
// 用户明确要「歌词区自动扩充封面区」。Cover 当前仅两处使用（桌面主区 / 移动端全屏播放器），
// 均无固定高度容器依赖，display:none 不破坏其他布局（small 变体为预留，暂无调用方）。
//
// 封面解析策略（M1 审计结论）：保留组件内直出，不迁移 useCoverURL composable——
// ① 本组件实际唯一调用方是 App.vue 桌面主区（移动端播放页用 MobilePlayer 自带封面，不经过 Cover）；
//    桌面/非壳环境下 useCoverURL 也只是同步远程直出，迁移后行为零差异；
// ② 本组件同时处理流媒体歌（song.coverUrl 直用、不走 /api/cover），useCoverURL 仅支持
//    path 型 /api/cover 解析，强行迁移需特判流媒体分支，复杂度不成比例；
// ③ 已有 path→URL 缓存 + 错误回退缓存，与 useCoverURL 的覆盖需求相同。
const showCover = computed(() => coverVisible("large"));

const props = defineProps({
  song: { type: Object, default: null },
  small: { type: Boolean, default: false },
  // 显式尺寸 px（0/缺省 = 走 CSS 默认：桌面 min(46vh,340px)）
  // 桌面传入 coverSizePx（自适应计算/拖拽值）；本组件仅桌面使用（移动端播放页自带封面）
  size: { type: Number, default: 0 },
});

// 封面方形：只设宽，aspect-ratio:1 带出高
const boxStyle = computed(() => (props.size > 0 ? { width: `${props.size}px` } : null));

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
    coverUrl.value = resolveServerUrl("/api/cover?path=" + encodeURIComponent(key));
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
  display: none; /* 封面关闭 → 完全不占位（歌词/氛围背景自动扩充；见 showCover 注释） */
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
