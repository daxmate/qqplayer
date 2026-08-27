<template>
  <div class="cover-wrap" :class="{ small, 'no-cover': !showCover }">
    <div class="cover-box" :style="boxStyle">
      <img
        v-if="coverUrl && !coverFailed"
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
import { ref, watch, computed, onBeforeUnmount } from "vue";
import { Music } from "@lucide/vue";
import { useI18n } from "vue-i18n";
import { state } from "../composables/usePlayer.js";
import { coverVisible } from "../composables/useCoverGuard.ts";
import { useCoverURL } from "../composables/useCoverURL.js";

const { t } = useI18n();

// 显示封面开关（设置 → 界面）：关闭时封面完全不占位（display:none），歌词区/氛围背景自动扩充铺满。
// 2026-08-16（任务 E）由 visibility:hidden 改为 display:none——旧方案保留占位会把封面区空一块；
// 用户明确要「歌词区自动扩充封面区」。Cover 当前仅两处使用（桌面主区 / 移动端全屏播放器），
// 均无固定高度容器依赖，display:none 不破坏其他布局（small 变体为预留，暂无调用方）。
//
// 封面解析策略（契约 2026-08-27 更新，推翻旧「保留组件内直出」决策）：接入 useCoverURL 唯一入口——
// 桌面/非壳环境 resolveCover 同步远程直出（行为零变化）；iOS 壳环境自动本地优先
// （covers 缓存 → 内嵌 APIC（断网）→ 远程 /api/cover；@error → markCoverError 兑底）。
// 流媒体歌（song.coverUrl && !song.path）仍直用网络图 URL，不走 /api/cover。
const showCover = computed(() => coverVisible("large"));
const { coverSrc, coverOk, markCoverError, resolveCover, dispose } = useCoverURL();

const streamFailed = ref(false); // 流媒体直用图加载失败 → 占位（与旧 onCoverError 缓存空串同语义）

const coverUrl = computed(() => {
  const s = props.song;
  if (!s || streamFailed.value) return "";
  if (s.coverUrl && !s.path) return s.coverUrl; // 流媒体歌（stream/试听/URL）：网络图直用
  return coverSrc(s.path || "");
});

const coverFailed = computed(() => {
  const s = props.song;
  if (!s) return false;
  if (s.coverUrl && !s.path) return streamFailed.value;
  return s.path ? !coverOk(s.path) : false;
});

const props = defineProps({
  song: { type: Object, default: null },
  small: { type: Boolean, default: false },
  // 显式尺寸 px（0/缺省 = 走 CSS 默认：桌面 min(46vh,340px)）
  // 桌面传入 coverSizePx（自适应计算/拖拽值）；本组件仅桌面使用（移动端播放页自带封面）
  size: { type: Number, default: 0 },
});

// 封面方形：只设宽，aspect-ratio:1 带出高
const boxStyle = computed(() => (props.size > 0 ? { width: `${props.size}px` } : null));

watch(
  () => {
    const s = props.song;
    return s ? s.path || s.coverUrl || "" : "";
  },
  (key) => {
    streamFailed.value = false;
    if (key && props.song?.path) resolveCover(props.song.path, { download: true });
  },
  { immediate: true },
);

function onCoverError() {
  if (props.song?.coverUrl && !props.song?.path) {
    streamFailed.value = true; // 流媒体直用图失败：占位（与旧行为一致）
    return;
  }
  if (props.song?.path) markCoverError(props.song.path);
}

onBeforeUnmount(() => dispose()); // 契约：组件卸载取消恢复在线订阅
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
