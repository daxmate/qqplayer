<template>
  <div v-show="enabled" class="visualizer" :class="{ small }" data-testid="visualizer">
    <canvas ref="canvasEl" class="viz-canvas" data-testid="viz-canvas" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { state, playbackSettings, VISUALIZER_STYLES } from "../composables/usePlayer.js";
import {
  ensureAnalyser,
  getAnalyser,
  readBarData,
  readWaveData,
  drawSpectrum,
  drawRadial,
  drawWave,
  drawPulse,
  drawMirror,
  drawParticle,
} from "../composables/useVisualizer.js";

const props = defineProps({
  small: { type: Boolean, default: false },
});

const canvasEl = ref(null);
const enabled = computed(() => !!playbackSettings.visualizerEnabled);
// 视觉化样式（任务 K）：非法值（脏数据）回落默认 'bars'；持久化由设置层负责
const style = computed(() =>
  VISUALIZER_STYLES.some((s) => s.id === playbackSettings.visualizerStyle)
    ? playbackSettings.visualizerStyle
    : "bars",
);

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
  // 播放中读真实数据；暂停/降级 → 各样式画平线/静态（不抛错）。analyser 图内常驻，切歌换源不受影响。
  const a = ensureAnalyser() || getAnalyser();
  const active = !!(a && state.isPlaying);
  // small 变体（ControlBar 44px）：bar 数减半，圆形/粒子类渲染器按 opts.small 简化
  const barCount = props.small ? 32 : Math.max(16, Math.min(64, Math.floor(cv.width / 5)));
  const { accent, accent2 } = accentColors();
  const opts = {
    accent,
    accent2,
    small: props.small,
    dpr: Math.min(2, window.devicePixelRatio || 1),
  };
  const s = style.value;
  // 数据源：wave 用时域（readWaveData），其余用频谱（readBarData）
  const data = active
    ? s === "wave"
      ? readWaveData(a, barCount)
      : readBarData(a, barCount)
    : null;
  switch (s) {
    case "radial":
      drawRadial(g, cv.width, cv.height, data, opts);
      break;
    case "wave":
      drawWave(g, cv.width, cv.height, data, opts);
      break;
    case "pulse":
      drawPulse(g, cv.width, cv.height, data, opts);
      break;
    case "mirror":
      drawMirror(g, cv.width, cv.height, data, opts);
      break;
    case "particle":
      drawParticle(g, cv.width, cv.height, data, opts);
      break;
    default:
      drawSpectrum(g, cv.width, cv.height, data, accent, accent2);
  }
}

function tick() {
  rafId = requestAnimationFrame(tick);
  paint();
}

// 开关驱动：开启即跑 rAF（播放中画频谱，暂停画呼吸 idle，保持活感）；关闭停掉并画一帧静止
watch(
  () => enabled.value,
  () => {
    if (enabled.value) {
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
  { flush: "sync", immediate: true },
);

onMounted(() => {
  resize();
  ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (ro && canvasEl.value && canvasEl.value.parentElement) {
    ro.observe(canvasEl.value.parentElement);
  }
  paint(); // 首帧静态（未播放时画呼吸 idle，避免画布空白闪烁）
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
