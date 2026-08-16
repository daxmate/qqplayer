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

// 读取时域波形数据：getByteTimeDomainData 填满 fftSize 采样点（0~255，128 = 静音中线），
// 归一化 -1~1。供 wave（示波器）样式使用；count 为采样点数（均匀抽稀），返回 float 数组。
export function readWaveData(a, count) {
  const n = a.fftSize || FFT_SIZE;
  const data = new Uint8Array(n);
  a.getByteTimeDomainData(data);
  const out = new Array(count);
  const step = Math.max(1, Math.floor(n / count));
  for (let i = 0; i < count; i++) {
    out[i] = data[Math.min(n - 1, i * step)] / 128 - 1; // 0~255 → -1~1
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
// 两个主题色之间插值（环形渐变 / 粒子混色用），t ∈ [0,1]
function blendHex(a, b, t) {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  const r = Math.round(A.r + (B.r - A.r) * t);
  const g = Math.round(A.g + (B.g - A.g) * t);
  const bl = Math.round(A.b + (B.b - A.b) * t);
  return `rgb(${r},${g},${bl})`;
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

// ============ 6 种视觉化样式渲染器（任务 K）============
// 统一签名：drawXxx(ctx, width, height, data, opts)；data 为 null（暂停/无 analyser）时画静态/平线，不抛错。
// opts = { accent, accent2, small, dpr }——颜色由组件读取 CSS 变量传入，small/dpr 供粒子性能降级。

// 基准静态线（暂停/降级时各样式共用底部平线）
function idleLine(ctx, w, h, accent) {
  ctx.fillStyle = withAlpha(accent, 0.35);
  ctx.fillRect(0, h - 2, w, 2);
}

// radial：圆形频谱环——data 映射到 360° 圆环，每 bin 一段弧，半径随频谱，accent→accent2 渐变。
export function drawRadial(ctx, w, h, data, opts = {}) {
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 2;
  const baseR = maxR * 0.45;
  const n = data ? data.length : 0;
  if (!n) {
    // 静态：一圈低透明度基准环
    ctx.strokeStyle = withAlpha(accent, 0.35);
    ctx.lineWidth = Math.max(2, maxR / 18);
    ctx.beginPath();
    ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
    ctx.stroke();
    return;
  }
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, (maxR - baseR) / 14);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2; // 从 12 点方向顺时针
    const v = Math.pow(Math.min(1, Math.max(0, data[i])), 1.4);
    const r = baseR + v * (maxR - baseR);
    ctx.strokeStyle = blendHex(accent, accent2, i / n);
    ctx.beginPath();
    ctx.arc(cx, cy, r, ang - Math.PI / n, ang + Math.PI / n);
    ctx.stroke();
  }
}

// wave：示波器——时域波形折线（data 为 readWaveData 的 -1~1 数组），accent 渐变描边 + 下方柔光填充。
export function drawWave(ctx, w, h, data, opts = {}) {
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const n = data ? data.length : 0;
  if (!n) {
    // 静态：中线
    ctx.strokeStyle = withAlpha(accent, 0.35);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    return;
  }
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, accent2);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * w;
    const y = h / 2 + Math.max(-1, Math.min(1, data[i])) * (h / 2 - 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
  // 波形下方柔光填充（低透明度，增强节奏感）
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, withAlpha(accent2, 0.25));
  fill.addColorStop(1, withAlpha(accent, 0.02));
  ctx.fillStyle = fill;
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
}

// pulse：脉冲环——低频均值驱动中心圆半径脉动，外圈一圈频谱光环（数据映射 360°）。
export function drawPulse(ctx, w, h, data, opts = {}) {
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 2;
  const n = data ? data.length : 0;
  if (!n) {
    // 静态：外圈 + 中心小圆
    ctx.strokeStyle = withAlpha(accent, 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, maxR * 0.6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = withAlpha(accent, 0.35);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(5, maxR * 0.12), 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  // 低频均值（前 1/3 bins）→ 中心圆半径脉动
  const low = data.slice(0, Math.max(1, Math.floor(n / 3)));
  const mean = low.reduce((s, v) => s + v, 0) / low.length;
  const r = Math.max(5, maxR * 0.12 + Math.pow(mean, 1.2) * maxR * 0.55);
  const rg = ctx.createRadialGradient(cx, cy, 1, cx, cy, r);
  rg.addColorStop(0, withAlpha(accent2, 0.95));
  rg.addColorStop(1, withAlpha(accent, 0.2));
  ctx.fillStyle = rg;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // 外圈频谱光环
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(2, maxR / 26);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = Math.pow(Math.min(1, Math.max(0, data[i])), 1.4);
    const rr = maxR * 0.55 + v * (maxR * 0.4);
    ctx.strokeStyle = withAlpha(blendHex(accent, accent2, i / n), 0.85);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, ang - Math.PI / n, ang + Math.PI / n);
    ctx.stroke();
  }
}

// mirror：镜像频谱——复用 bars 逻辑：下半部频谱条从底部向上，上半部镜像从顶部向下（低透明度），中线亮线。
export function drawMirror(ctx, w, h, data, opts = {}) {
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const n = data ? data.length : 0;
  if (!n) {
    idleLine(ctx, w, h, accent);
    return;
  }
  const gap = Math.max(1, Math.round(w / n / 6));
  const bw = Math.max(1, w / n - gap);
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, accent2);
  ctx.fillStyle = grad;
  for (let i = 0; i < n; i++) {
    const v = Math.pow(Math.min(1, Math.max(0, data[i])), 1.4);
    const bh = Math.max(2, v * (h / 2 - 3));
    // 下镜像：底部向上（主色渐变）
    ctx.fillRect(i * (bw + gap), h - bh, bw, bh);
    // 上镜像：顶部向下（低透明度）
    ctx.fillStyle = withAlpha(accent2, 0.35);
    ctx.fillRect(i * (bw + gap), 0, bw, bh);
    ctx.fillStyle = grad;
  }
  // 中线亮线
  ctx.fillStyle = withAlpha(accent, 0.5);
  ctx.fillRect(0, h / 2 - 1, w, 2);
}

// ---- 粒子流（drawParticle）----
// 性能降级：粒子数 = 基准 80 × 面积占比（≤1，面积越小越少）；small 再减 40%；dpr ≤ 2 由 Visualizer 侧限制。
// 无数据（暂停/降级）：粒子低速漂移（静态感），不抛错。粒子状态模块级常驻（帧间连续），_resetParticles 供测试隔离。
let particles = [];
let particlesKey = "";
let particleTime = 0;

function ensureParticles(count, w, h) {
  const key = `${count}x${Math.round(w)}x${Math.round(h)}`;
  if (particlesKey === key && particles.length === count) return;
  particlesKey = key;
  particles = new Array(count);
  for (let i = 0; i < count; i++) {
    const ang = Math.random() * Math.PI * 2;
    const spd = 0.2 + Math.random() * 0.5;
    particles[i] = {
      x: Math.random() * w,
      y: Math.random() * h,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      r: 1 + Math.random() * 2.5,
      t: Math.random(), // 混色位置（accent→accent2）
    };
  }
}

export function drawParticle(ctx, w, h, data, opts = {}) {
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  // 粒子数按面积缩减：360×64 ≈ 基准面积 → 80 粒子；small 再减
  const area = w * h;
  let count = Math.round(80 * Math.min(1, area / (360 * 64)));
  if (opts.small) count = Math.round(count * 0.6);
  count = Math.max(12, Math.min(80, count));
  ensureParticles(count, w, h);
  const n = data ? data.length : 0;
  const avg = n ? data.reduce((s, v) => s + v, 0) / n : 0.06; // 无数据：低速漂移
  particleTime += 1;
  for (const p of particles) {
    // 速度随频谱均值增强；大小随随机 bin 值脉动
    const drive = n ? data[Math.floor(Math.random() * n)] : 0;
    const speed = 0.3 + avg * 2.2;
    p.x += p.vx * speed;
    p.y += p.vy * speed;
    // 环绕边界
    if (p.x < -6) p.x = w + 6;
    else if (p.x > w + 6) p.x = -6;
    if (p.y < -6) p.y = h + 6;
    else if (p.y > h + 6) p.y = -6;
    const pr = p.r * (0.6 + 1.6 * drive);
    ctx.fillStyle = withAlpha(blendHex(accent, accent2, p.t), 0.35 + 0.55 * drive);
    ctx.beginPath();
    ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function _resetParticles() {
  particles = [];
  particlesKey = "";
  particleTime = 0;
}

// 仅供测试：重置挂载状态（与 playerCore._resetEqGraph 配套）
export function _resetVisualizer() {
  analyser = null;
  attached = false;
  failed = false;
}
