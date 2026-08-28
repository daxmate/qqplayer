<template>
  <div class="mp-wrap">
    <!-- 横滑分页容器：4 屏（音乐 / 图书 / 有声书 / 视频），水平滑动翻页，每屏独立垂直滚动 -->
    <div
      ref="pagerEl"
      class="mp-pager"
      :class="{ 'pager-dragging': swipe.dragging.value }"
      :style="pagerStyle"
    >
      <section class="mp-screen">
        <MobileHome @open="$emit('open', $event)" @open-settings="$emit('open-settings')" />
      </section>
      <section class="mp-screen">
        <MobileBooks :standalone="false" @overlay="onOverlay" />
      </section>
      <section class="mp-screen">
        <MobileAudiobooks />
      </section>
      <section class="mp-screen">
        <MobileVideos :standalone="false" @overlay="onOverlay" />
      </section>
    </div>

    <!-- 底部小圆点指示器（当前页高亮） -->
    <div class="mp-dots">
      <span v-for="i in PAGE_COUNT" :key="i" class="mp-dot" :class="{ on: page === i - 1 }" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { useHorizontalSwipe } from "../../composables/useSwipe.js";
import MobileHome from "./MobileHome.vue";
import MobileBooks from "../../books/MobileBooks.vue";
import MobileAudiobooks from "./MobileAudiobooks.vue";
import MobileVideos from "../../videos/MobileVideos.vue";

const props = defineProps({
  // 当前分页下标（壳层 v-model 控制：边缘滑动翻页/KeepAlive 恢复用；缺省时内部自管）
  pageIndex: { type: Number, default: 0 },
});
const emit = defineEmits(["open", "open-settings", "overlay", "update:page-index"]);

const PAGE_COUNT = 4;
// 内部当前页（与 props 双向同步：props 变化（壳层 goToPage）→ 跟随；内部变化 → 上报）
const page = ref(props.pageIndex);
watch(
  () => props.pageIndex,
  (v) => {
    if (v !== page.value) page.value = v;
  },
);
function setPage(i: number) {
  const v = Math.max(0, Math.min(PAGE_COUNT - 1, i));
  if (v === page.value) return;
  page.value = v;
  emit("update:page-index", v);
}

// 分页屏内全屏浮层（阅读器/视频播放器）打开中：禁用手势翻页（外层 MobileShell 也据此禁用边缘滑动）
const overlayOpen = ref(false);
const pagerEl = ref(null);

// 横滑翻页：左滑下一页 / 右滑上一页；左缘 24px 让位 useEdgeSwipe（负一屏/翻上一屏由壳层处理）。
// 边界：第 0 屏右滑、末屏左滑无动作（位移交给 reset 回弹）。
const swipe = useHorizontalSwipe({
  enabled: () => !overlayOpen.value,
  direction: "both",
  excludeEdgeZone: true,
  onTrigger: (dir) => {
    if (dir === "left") setPage(page.value + 1);
    else setPage(page.value - 1);
    swipe.reset();
  },
});

const pagerStyle = computed(() => ({
  transform: `translateX(calc(${swipe.shift.value}px - ${page.value * 100}%))`,
}));

function onOverlay(open: boolean) {
  overlayOpen.value = open;
  emit("overlay", open);
}

onMounted(() => swipe.bind(pagerEl.value));
onBeforeUnmount(() => swipe.unbind());
</script>

<style scoped>
.mp-wrap {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
}
.mp-pager {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
  /* 纵向滚动交给页面（touch-action: pan-y），横向翻页由 JS 手势接管 */
  touch-action: pan-y;
  transition: transform 0.32s cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}
.mp-pager.pager-dragging {
  transition: none; /* 跟手时禁用过渡，位移直跟手指 */
}
.mp-screen {
  flex: 0 0 100%;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  /* 底部让位小圆点指示器 */
  padding-bottom: 26px;
}
.mp-dots {
  position: absolute;
  bottom: 8px;
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  gap: 7px;
  z-index: 5;
  pointer-events: none;
}
.mp-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--text3);
  opacity: 0.4;
  transition: all 0.25s ease;
}
.mp-dot.on {
  opacity: 1;
  width: 18px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
}
</style>
