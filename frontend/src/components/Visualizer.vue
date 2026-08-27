<template>
  <div
    v-show="enabled"
    class="visualizer"
    :class="{ small, ambient: !small }"
    data-testid="visualizer"
  >
    <canvas ref="canvasEl" class="viz-canvas" data-testid="viz-canvas" />
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import { state, playbackSettings, VISUALIZER_STYLES } from "../composables/usePlayer.js";
import { useCoverURL } from "../composables/useCoverURL.js";
import {
  ensureAnalyser,
  getAnalyser,
  readBarData,
  readWaveData,
  extractCoverColor,
  drawSpectrum,
  drawRadial,
  drawWave,
  drawPulse,
  drawMirror,
  drawParticle,
  drawAmbient,
} from "../composables/useVisualizer.js";

const props = defineProps({
  small: { type: Boolean, default: false },
});

const canvasEl = ref(null);
// 主区域（非 small）= 封面取色氛围背景；small（移动端）= 迷你频谱条。
// 视觉化总开关关闭 → 全部隐藏；子开关各自控制对应区域。
const enabled = computed(() => {
  if (!playbackSettings.visualizerEnabled) return false;
  if (props.small) return !!playbackSettings.miniSpectrumEnabled;
  return !!playbackSettings.ambientEnabled;
});
// 迷你频谱样式（small）：非法值（脏数据）回落默认 'bars'；持久化由设置层负责
const style = computed(() =>
  VISUALIZER_STYLES.some((s) => s.id === playbackSettings.visualizerStyle)
    ? playbackSettings.visualizerStyle
    : "bars",
);

let rafId = 0;
let running = false;
let ro = null;

// 画布实际像素 = CSS 尺寸 × dpr（≤2），保证清晰
function resize() {
  const cv = canvasEl.value;
  if (!cv) return;
  const parent = cv.parentElement;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (props.small) {
    // 小频谱：固定高度 44px，宽度跟随容器
    const w = parent ? parent.clientWidth : 300;
    const h = 44;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
  } else {
    // 氛围背景：铺满父级（.center 区域，absolute inset-0）；父级未布局（jsdom/首帧）用默认 300
    const w = parent ? parent.clientWidth || 300 : 300;
    const h = parent ? parent.clientHeight || 300 : 300;
    const pw = Math.max(1, Math.round(w * dpr));
    const ph = Math.max(1, Math.round(h * dpr));
    if (cv.width !== pw) cv.width = pw;
    if (cv.height !== ph) cv.height = ph;
  }
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

// 封面主色（缓存由 extractCoverColor 内部 Map 负责；取色失败 → null → 降级主题色）
const coverColor = ref(null);

// 封面 URL 统一入口（契约 2026-08-27）：本地歌经 useCoverURL 取同源 URL 供 canvas 读像素
const { coverSrc, resolveCover, dispose: disposeCoverURL } = useCoverURL();

function paint() {
  const cv = canvasEl.value;
  if (!cv) return;
  const g = cv.getContext("2d");
  if (!g) return;
  const a = ensureAnalyser() || getAnalyser();
  const active = !!(a && state.isPlaying);
  const { accent, accent2 } = accentColors();
  const opts = {
    accent,
    accent2,
    small: props.small,
    dpr: Math.min(2, window.devicePixelRatio || 1),
  };
  if (props.small) {
    // 小频谱：播放中读真实数据；暂停/降级 → 各样式画静态（不抛错）
    const barCount = 32;
    const s = style.value;
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
    return;
  }
  // 氛围背景：封面主色光晕 + 呼吸/能量律动（不画频谱条）
  const cc = coverColor.value;
  const color = cc ? `rgb(${cc.r},${cc.g},${cc.b})` : accent;
  // 能量：播放中读低频均值（前 1/3 bins），暂停为 0（仅呼吸）
  let energy = 0;
  if (active) {
    const vals = readBarData(a, 12);
    const lowN = Math.max(1, Math.floor(vals.length / 3));
    let sum = 0;
    for (let i = 0; i < lowN; i++) sum += vals[i];
    energy = sum / lowN;
  }
  drawAmbient(g, cv.width, cv.height, {
    color,
    color2: accent2,
    playing: active,
    energy,
  });
}

function tick() {
  rafId = requestAnimationFrame(tick);
  paint();
}

// 封面主色：随当前歌曲（path / coverUrl）变化重新取色
watch(
  () => {
    const s = state.currentSong;
    return s ? s.path || s.coverUrl || "" : "";
  },
  async (key) => {
    coverColor.value = null; // 切歌先清（新色未到前用主题色）
    if (!key) return; // 无封面（SSR/无歌）不取色
    const s = state.currentSong;
    // 流媒体歌：网络图 URL 直用；本地歌：useCoverURL 唯一入口（契约 2026-08-27：不手写
    // path→URL 映射）。桌面直出 = 同源 /api/cover，canvas 同源读像素不受影响；
    // 壳内异步解析中（coverSrc 为空）本次跳过取色（Visualizer 仅桌面使用，行为零变化）。
    const direct = s?.coverUrl && !s?.path ? s.coverUrl : "";
    let src = direct;
    if (!direct && s?.path) {
      resolveCover(s.path);
      src = coverSrc(s.path);
    }
    if (!src) return;
    const c = await extractCoverColor(src);
    if (
      c &&
      state.currentSong &&
      (state.currentSong.path || state.currentSong.coverUrl || "") === key
    ) {
      coverColor.value = c; // 防串歌：仅当仍是同一首时应用
    }
  },
  { immediate: true },
);

// 开关驱动：开启即跑 rAF（播放中画频谱/律动，暂停画呼吸 idle，保持活感）；关闭停掉并画一帧静止
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
  disposeCoverURL(); // 契约：组件卸载取消恢复在线订阅
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
/* 主区域氛围背景：absolute 铺满 .center（App.vue 需给 .center 设 position:relative），
   低层级不抢交互，Cover/LyricPanel 由 App.vue 抬到 z-index:1 之上 */
.visualizer.ambient {
  position: absolute;
  inset: 0;
  width: auto;
  z-index: 0;
  pointer-events: none;
}
.visualizer.ambient .viz-canvas {
  width: 100%;
  height: 100%;
}
</style>
