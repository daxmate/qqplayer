<template>
  <div v-show="enabled" class="visualizer" :class="{ small }" data-testid="visualizer">
    <canvas ref="canvasEl" class="viz-canvas" data-testid="viz-canvas" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { state, playbackSettings } from "../composables/usePlayer.js";
import {
  ensureAnalyser,
  getAnalyser,
  readBarData,
  drawSpectrum,
} from "../composables/useVisualizer.js";

const props = defineProps({
  small: { type: Boolean, default: false },
});

const canvasEl = ref(null);
const enabled = computed(() => !!playbackSettings.visualizerEnabled);

let rafId = 0;
let running = false;
let ro = null;

// 画布实际像素 = CSS 尺寸 × dpr（≤2），保证频谱条清晰
function resize() {
  const cv = canvasEl.value;
  if (!cv) return;
  const parent = cv.parentElement;
  const w = parent ? parent.clientWidth : 300;
  const h = props.small ? 44 : 64;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(h * dpr));
  if (cv.width !== pw) cv.width = pw;
  if (cv.height !== ph) cv.height = ph;
}

// 主题强调色：跟随 CSS 变量（--accent/--accent2），取不到（测试/SSR）用默认橙
function accentColors() {
  let a = "";
  let b = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    a = cs.getPropertyValue("--accent").trim();
    b = cs.getPropertyValue("--accent2").trim();
  } catch {
    /* 无 getComputedStyle（SSR）降级默认色 */
  }
  return { accent: a || "#ff7e5f", accent2: b || "#feb47b" };
}

function paint() {
  const cv = canvasEl.value;
  if (!cv) return;
  const g = cv.getContext("2d");
  if (!g) return;
  // 播放中读真实频谱；暂停/降级 → 平线。analyser 图内常驻，切歌换源不受影响。
  const a = ensureAnalyser() || getAnalyser();
  const values =
    a && state.isPlaying
      ? readBarData(a, Math.max(16, Math.min(64, Math.floor(cv.width / 5))))
      : null;
  const { accent, accent2 } = accentColors();
  drawSpectrum(g, cv.width, cv.height, values, accent, accent2);
}

function tick() {
  rafId = requestAnimationFrame(tick);
  paint();
}

// 开关 + 播放状态驱动：播放中跑 rAF；暂停/关闭停掉并画一帧静止平线（避免空转）
watch(
  () => [enabled.value, state.isPlaying],
  () => {
    if (enabled.value && state.isPlaying) {
      if (!running) {
        running = true;
        rafId = requestAnimationFrame(tick);
      }
    } else if (running) {
      running = false;
      cancelAnimationFrame(rafId);
      paint();
    }
  },
  { flush: "sync" },
);

onMounted(() => {
  resize();
  ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (ro && canvasEl.value && canvasEl.value.parentElement) {
    ro.observe(canvasEl.value.parentElement);
  }
  paint(); // 首帧静态（未播放时画平线，避免画布空白闪烁）
});

onBeforeUnmount(() => {
  running = false;
  cancelAnimationFrame(rafId);
  if (ro) ro.disconnect();
});
</script>

<style scoped>
.visualizer {
  flex-shrink: 0;
  width: 100%;
  display: flex;
  justify-content: center;
}
.viz-canvas {
  display: block;
  width: 100%;
  height: 64px;
}
.visualizer.small .viz-canvas {
  height: 44px;
}
</style>
