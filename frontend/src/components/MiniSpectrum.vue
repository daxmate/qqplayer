<template>
  <div
    v-show="enabled"
    class="mini-spectrum"
    data-testid="mini-spectrum"
    :aria-label="t('settings.miniSpectrum')"
  >
    <canvas ref="canvasEl" class="ms-canvas" data-testid="ms-canvas" />
  </div>
</template>

<script setup>
// ControlBar 迷你频谱条（任务 C 混合方案：频谱从主区域移到这里）。
// 沿用 6 样式渲染器（bars/radial/wave/pulse/mirror/particle，small 变体），
// 半透明低调，作为「正在播放」的节奏指示；开关 = visualizerEnabled && miniSpectrumEnabled。
import { ref, computed, onMounted, onBeforeUnmount } from "vue";
import { useI18n } from "vue-i18n";
import { state, playbackSettings, VISUALIZER_STYLES } from "../composables/usePlayer.js";
import { useVizLoop } from "../composables/useVizLoop.js";
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

const { t } = useI18n();

const canvasEl = ref(null);
const enabled = computed(
  () => !!playbackSettings.visualizerEnabled && !!playbackSettings.miniSpectrumEnabled,
);
// 非法样式值（脏数据）回落默认 'bars'
const style = computed(() =>
  VISUALIZER_STYLES.some((s) => s.id === playbackSettings.visualizerStyle)
    ? playbackSettings.visualizerStyle
    : "bars",
);

let ro = null;

function resize() {
  const cv = canvasEl.value;
  if (!cv) return;
  const parent = cv.parentElement;
  const w = parent ? parent.clientWidth : 150;
  const pw = Math.max(1, Math.round(w * dpr));
  const ph = Math.max(1, Math.round(36 * dpr));
  if (cv.width !== pw) cv.width = pw;
  if (cv.height !== ph) cv.height = ph;
}

function accentColors() {
  let a = "";
  let b = "";
  try {
    const cs = getComputedStyle(document.documentElement);
    a = cs.getPropertyValue("--accent").trim();
    b = cs.getPropertyValue("--accent2").trim();
  } catch {
    /* SSR/测试无 getComputedStyle 降级默认色 */
  }
  return { accent: a || "#ff7e5f", accent2: b || "#feb47b" };
}

function paint() {
  const cv = canvasEl.value;
  if (!cv) return;
  const g = cv.getContext("2d");
  if (!g) return;
  const a = ensureAnalyser() || getAnalyser();
  const active = !!(a && state.isPlaying);
  const { accent, accent2 } = accentColors();
  const opts = { accent, accent2, small: true, dpr };
  const s = style.value;
  // 播放中读真实数据；暂停/降级 → 各样式画静态轮廓（呼吸，不抛错）
  const data = active ? (s === "wave" ? readWaveData(a, 24) : readBarData(a, 24)) : null;
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

// rAF 循环按环境差异化：壳满帧/暂停呼吸照旧；浏览器 30fps 节流、暂停停 rAF、隐藏停 rAF
// （循环启停与 paint 的协作全部收敛在 useVizLoop 内，组件只负责 paint 与开关/播放态来源）
const { dpr, dispose: disposeVizLoop } = useVizLoop({
  paint,
  isEnabled: () => enabled.value,
  isPlaying: () => !!state.isPlaying,
});

onMounted(() => {
  resize();
  ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
  if (ro && canvasEl.value && canvasEl.value.parentElement) {
    ro.observe(canvasEl.value.parentElement);
  }
  paint();
});

onBeforeUnmount(() => {
  disposeVizLoop();
  if (ro) ro.disconnect();
});
</script>

<style scoped>
.mini-spectrum {
  width: 150px;
  height: 36px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  opacity: 0.92;
}
.ms-canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
