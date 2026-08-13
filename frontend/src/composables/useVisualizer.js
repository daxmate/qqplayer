// ============ 频谱可视化（Web Audio AnalyserNode）============
// 挂载点：现有音频图尾部（playerCore 懒创建：source → 10×EQ biquad → destination）。
// 首次需要时把 analyser 插入图尾：lastFilter.disconnect() → lastFilter.connect(analyser) →
// analyser.connect(destination)。analyser 是纯直通节点，不改音频路径，EQ 开关/增益行为完全不变；
// createMediaElementSource 一个 audio 元素只能接管一次 → 图常驻，这里只在图内插一个只读节点。
// 降级：无 AudioContext / 图未建 / 创建失败 → 返回 null，调用方画平线，不抛错。
// 测试钩子 _resetVisualizer 与 playerCore 的 _resetEqGraph 配套使用（用例隔离）。
import { getEqGraph } from "./playerCore.js";

export const FFT_SIZE = 256; // frequencyBinCount = 128（低频分辨率足够，成本低）
export const SMOOTHING = 0.8; // 时间平滑：频谱跳动更柔和

let analyser = null;
let attached = false; // 已尝试挂载（成功或失败都不再重试，除非 _resetVisualizer）
let failed = false; // 挂载失败标记（避免反复抛错）

// 确保 analyser 挂进音频图（幂等）；图未建（首次播放前/无 AudioContext）时返回 null，
// 调用方在播放中会再次调用（首次播放 audio.play() 同步建图，播放事件后必然就绪）
export function ensureAnalyser() {
  if (attached) return failed ? null : analyser;
  if (typeof window === "undefined") return null; // SSR 静默降级
  const graph = getEqGraph();
  const ctx = graph && graph.audioCtx;
  const filters = graph && graph.eqFilters;
  if (!ctx || !filters || filters.length === 0) return null; // 图未建 → 稍后重试
  const last = filters[filters.length - 1];
  try {
    const a = ctx.createAnalyser();
    a.fftSize = FFT_SIZE;
    a.smoothingTimeConstant = SMOOTHING;
    last.disconnect(); // 摘掉到 destination 的直连
    last.connect(a); // 图尾插入 analyser
    a.connect(ctx.destination);
    analyser = a;
    attached = true;
    return a;
  } catch {
    attached = true;
    failed = true;
    return null;
  }
}

// 当前 analyser（未挂载/失败返回 null）
export function getAnalyser() {
  return attached && !failed ? analyser : null;
}

// 读取频谱数据：fftSize 256 → 128 bins，跳过 DC(0)，按 bars 数均分取均值，归一化 0~1
export function readBarData(a, bars) {
  const n = a.frequencyBinCount;
  const data = new Uint8Array(n);
  a.getByteFrequencyData(data);
  const count = Math.max(4, Math.min(bars, n - 1));
  const per = (n - 1) / count;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const from = Math.max(1, Math.floor(i * per));
    const to = Math.max(from + 1, Math.floor((i + 1) * per));
    let sum = 0;
    for (let j = from; j < to; j++) sum += data[j];
    out[i] = sum / (to - from) / 255;
  }
  return out;
}

// ---- 颜色工具（hex → rgba/混白；Canvas 不用 CSS color-mix，手动算）----
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 255, g: 126, b: 95 }; // 默认强调色兜底（与 style.css :root 一致）
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
function withAlpha(hex, a) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}
function mixWhite(hex, t) {
  const { r, g, b } = hexToRgb(hex);
  return `rgb(${Math.round(r + (255 - r) * t)},${Math.round(g + (255 - g) * t)},${Math.round(
    b + (255 - b) * t,
  )})`;
}

// 画一帧频谱。values 为 null（未播放/降级）→ 底部一条低透明度基准平线。
// accent/accent2 为主题强调色（组件读取 CSS 变量 --accent/--accent2 传入）。
export function drawSpectrum(ctx, width, height, values, accent, accent2) {
  ctx.clearRect(0, 0, width, height);
  const n = values ? values.length : 0;
  if (!n) {
    ctx.fillStyle = withAlpha(accent, 0.35);
    ctx.fillRect(0, height - 2, width, 2);
    return;
  }
  const gap = Math.max(1, Math.round(width / n / 6)); // 条间距 ≈ 条宽 1/6
  const bw = Math.max(1, width / n - gap);
  const grad = ctx.createLinearGradient(0, height, 0, 0);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, accent2);
  ctx.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, Math.pow(values[i], 1.4) * (height - 4));
    ctx.fillRect(i * (bw + gap), height - h, bw, h);
  }
  // 峰顶亮帽（参考歌词高亮亮色逻辑：强调色混白提亮）
  ctx.fillStyle = mixWhite(accent, 0.55);
  for (let i = 0; i < n; i++) {
    const h = Math.max(2, Math.pow(values[i], 1.4) * (height - 4));
    if (h > 4) ctx.fillRect(i * (bw + gap), height - h, bw, 2);
  }
}

// 仅供测试：重置挂载状态（与 playerCore._resetEqGraph 配套）
export function _resetVisualizer() {
  analyser = null;
  attached = false;
  failed = false;
}
