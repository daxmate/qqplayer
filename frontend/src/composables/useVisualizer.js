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

// ---- 颜色工具（hex / rgb() → rgba/混白/插值；Canvas 不用 CSS color-mix，手动算）----
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return { r: 255, g: 126, b: 95 }; // 默认强调色兜底（与 style.css :root 一致）
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}
// hex 或 "rgb(r,g,b)" 都解析（粒子混色结果可直接转 rgba）
function toRgb(c) {
  const m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(String(c).trim());
  if (m) return { r: +m[1], g: +m[2], b: +m[3] };
  return hexToRgb(c);
}
function withAlpha(c, a) {
  const { r, g, b } = toRgb(c);
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
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// ---- 通用绘图工具 ----
// roundRect 兼容：新浏览器用原生；旧浏览器 arcTo 手工圆角路径（不抛错）
function roundRectPath(ctx, x, y, w, h, r) {
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---- 峰值保持状态（bars 顶部亮帽延迟下落，参考 foobar/网易云）----
let peaks = [];
let peaksCount = 0;
const PEAK_FALL = 0.006; // 每帧下落量 = 高度比例（64px 下 ≈0.38px/帧 ≈ 23px/s @60fps）

function ensurePeaks(n) {
  if (peaksCount !== n || peaks.length !== n) {
    peaksCount = n;
    peaks = new Array(n).fill(0);
  }
}
export function _resetPeaks() {
  peaks = [];
  peaksCount = 0;
}

// 全局帧时钟：idle 呼吸动画相位（暂停态也由 rAF 驱动，避免"死掉"）
let vizClock = 0;

// ============ 6 种视觉化样式渲染器（任务 C 全面重做）============
// 统一签名：drawXxx(ctx, width, height, data, opts)；data 为 null（暂停/无 analyser）时画设计感静态态，不抛错。
// opts = { accent, accent2, small, dpr }——颜色由组件读取 CSS 变量传入，small/dpr 供粒子性能降级。
// 通用质感：accent→accent2 渐变 + 半透明叠加 + 发光/辉光（不过曝）+ 圆角/round 线帽 + 平滑插值。

// 底部微光舞台（bars 类样式共用：低透明度渐变底，增加层次）
function groundGlow(ctx, w, h, accent, a) {
  const ground = ctx.createLinearGradient(0, h, 0, h * 0.35);
  ground.addColorStop(0, withAlpha(accent, a));
  ground.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = ground;
  ctx.fillRect(0, 0, w, h);
}

// 暂停/无数据：高斯鼓包频谱骨架（两侧渐隐）+ 行进波纹 + 呼吸，保留波形语义，不抛错
function idleBars(ctx, w, h, accent, accent2) {
  groundGlow(ctx, w, h, accent, 0.12);
  const breathe = 1 + 0.14 * Math.sin(vizClock * 0.045);
  const n = Math.max(12, Math.min(48, Math.round(w / 8)));
  const gap = Math.max(1, Math.round(w / n / 4));
  const bw = Math.max(1.5, w / n - gap);
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, withAlpha(accent, 0.5 * breathe));
  grad.addColorStop(1, withAlpha(accent2, 0.2));
  ctx.fillStyle = grad;
  ctx.shadowColor = withAlpha(accent, 0.35);
  ctx.shadowBlur = 5;
  ctx.beginPath();
  const amp = h * 0.36 * breathe;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    const ripple = 1 + 0.14 * Math.sin(vizClock * 0.09 + i * 0.85); // 行进波纹（活感）
    const bh = Math.max(2, amp * (0.22 + 0.78 * Math.exp(-t * t * 8)) * ripple);
    roundRectPath(ctx, i * (bw + gap), h - bh, bw, bh, Math.min(bw / 2, 3));
  }
  ctx.fill();
  ctx.shadowBlur = 0;
}

// 画一帧频谱。values 为 null（未播放/降级）→ 设计感静态轮廓。
// accent/accent2 为主题强调色（组件读取 CSS 变量 --accent/--accent2 传入）。
// 技法：圆角条（roundRect）+ 垂直渐变（底 accent → 顶混白）+ 霓虹发光（shadowBlur）+
//       峰值保持亮帽（延迟下落 + 独立发光）+ 底部微光舞台。
export function drawSpectrum(ctx, w, h, values, accent, accent2) {
  vizClock++;
  ctx.clearRect(0, 0, w, h);
  const n = values ? values.length : 0;
  if (!n) {
    idleBars(ctx, w, h, accent, accent2);
    return;
  }
  groundGlow(ctx, w, h, accent, 0.08);
  const gap = Math.max(1, Math.round(w / n / 4));
  const bw = Math.max(1.5, w / n - gap);
  const r = Math.min(bw / 2, 4);
  // 垂直渐变：底 accent → 中 accent2 → 顶混白提亮（光泽感）
  const grad = ctx.createLinearGradient(0, h, 0, 0);
  grad.addColorStop(0, accent);
  grad.addColorStop(0.55, accent2);
  grad.addColorStop(1, mixWhite(accent2, 0.55));
  ctx.fillStyle = grad;
  // 整体发光：一次 shadowBlur 填充 = 统一霓虹辉光（成本低、不过曝）
  ctx.shadowColor = withAlpha(accent, 0.42);
  ctx.shadowBlur = Math.min(7, Math.max(2, bw * 0.5));
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const bh = Math.pow(clamp01(values[i]), 1.35) * (h - 6);
    roundRectPath(ctx, i * (bw + gap), h - bh, bw, bh, r);
  }
  ctx.fill();
  ctx.shadowBlur = 0;
  // 峰值保持亮帽：延迟下落 + 独立发光
  ensurePeaks(n);
  const capR = Math.max(1.5, Math.min(3.5, bw * 0.34));
  ctx.fillStyle = mixWhite(accent2, 0.8);
  ctx.shadowColor = withAlpha(accent, 0.9);
  ctx.shadowBlur = Math.min(6, capR * 2.2);
  for (let i = 0; i < n; i++) {
    const target = Math.pow(clamp01(values[i]), 1.35) * (h - 6);
    if (target > peaks[i]) peaks[i] = target;
    else peaks[i] = Math.max(0, peaks[i] - h * PEAK_FALL);
    if (peaks[i] < 2) continue;
    ctx.beginPath();
    ctx.arc(i * (bw + gap) + bw / 2, h - peaks[i], capR, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.shadowBlur = 0;
}

// radial：圆形频谱环——数据映射 360° 圆环，每 bin 一段弧，半径随频谱。
// 技法：分段渐变（accent→accent2 绕环插值）+ 外发光（宽描边统一光晕）+ 粗细节奏（线宽随能量）+ 底环/中心点层次。
export function drawRadial(ctx, w, h, data, opts = {}) {
  vizClock++;
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.max(4, Math.min(w, h) / 2 - 2); // 钳制：极窄画布下不产生负半径
  const baseR = maxR * 0.4;
  const n = data ? data.length : 0;
  if (!n) {
    idleRadial(ctx, cx, cy, maxR, accent, accent2);
    return;
  }
  ctx.lineCap = "round";
  // 结构底环（半透明，层次感）
  ctx.strokeStyle = withAlpha(accent, 0.16);
  ctx.lineWidth = Math.max(1, maxR / 40);
  ctx.beginPath();
  ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
  ctx.stroke();
  // 外发光：全部弧线一次宽描边（统一光晕，低透明度，不过曝）
  ctx.strokeStyle = withAlpha(accent, 0.13);
  ctx.lineWidth = Math.max(3, maxR * 0.1);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2; // 从 12 点方向顺时针
    const v = Math.pow(clamp01(data[i]), 1.35);
    const rr = baseR + v * (maxR - baseR) * 0.95;
    ctx.arc(cx, cy, rr, ang - Math.PI / n, ang + Math.PI / n);
  }
  ctx.stroke();
  // 分段渐变主环（粗细节奏感：线宽随能量）
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = Math.pow(clamp01(data[i]), 1.35);
    const rr = baseR + v * (maxR - baseR) * 0.95;
    ctx.strokeStyle = blendHex(accent, accent2, i / n);
    ctx.lineWidth = Math.max(1.5, maxR * 0.06 + v * maxR * 0.14);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, ang - Math.PI / n, ang + Math.PI / n);
    ctx.stroke();
  }
  // 中心亮点
  ctx.fillStyle = withAlpha(mixWhite(accent2, 0.4), 0.5);
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, maxR * 0.03), 0, Math.PI * 2);
  ctx.fill();
}

// 暂停/无数据：加粗基准环 + 均匀点环（罗盘/齿轮感）+ 中心点，呼吸；与 pulse（涟漪）区分，不抛错
function idleRadial(ctx, cx, cy, maxR, accent, accent2) {
  const breathe = 0.9 + 0.1 * Math.sin(vizClock * 0.04);
  const ringR = maxR * 0.52; // 比 active 底环大一圈，静止也醒目
  const n = 24;
  ctx.lineCap = "round";
  ctx.strokeStyle = withAlpha(accent, 0.32);
  ctx.lineWidth = Math.max(1.5, maxR / 26);
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();
  // 均匀分布的点（随呼吸微胀缩）
  ctx.fillStyle = withAlpha(accent2, 0.65 * breathe);
  const dotR = Math.max(1.5, maxR * 0.055);
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const rr = ringR * breathe;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * rr, cy + Math.sin(ang) * rr, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
  // 中心点
  ctx.fillStyle = withAlpha(accent2, 0.7);
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(1.5, maxR * 0.05), 0, Math.PI * 2);
  ctx.fill();
}

// wave：示波器——时域波形（readWaveData -1~1）平滑曲线。
// 技法：中点二次贝塞尔平滑（非生硬折线）+ 水平渐变描边 + 辉光（shadowBlur）+
//       曲线下方渐变填充 + 微弱中线参考。
let waveXs = new Float32Array(256);
let waveYs = new Float32Array(256);

export function drawWave(ctx, w, h, data, opts = {}) {
  vizClock++;
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const n = data ? data.length : 0;
  if (n < 2) {
    idleWave(ctx, w, h, accent, accent2);
    return;
  }
  if (n > waveXs.length) {
    waveXs = new Float32Array(n);
    waveYs = new Float32Array(n);
  }
  for (let i = 0; i < n; i++) {
    waveXs[i] = (i / (n - 1)) * w;
    waveYs[i] = h / 2 + Math.max(-1, Math.min(1, data[i])) * (h / 2 - 3);
  }
  const trace = (close) => {
    ctx.moveTo(waveXs[0], waveYs[0]);
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(
        waveXs[i],
        waveYs[i],
        (waveXs[i] + waveXs[i + 1]) / 2,
        (waveYs[i] + waveYs[i + 1]) / 2,
      );
    }
    ctx.lineTo(waveXs[n - 1], waveYs[n - 1]);
    if (close) {
      ctx.lineTo(w, h);
      ctx.lineTo(0, h);
      ctx.closePath();
    }
  };
  // 波形下方柔光填充（渐变，随曲线形状）
  const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
  fillGrad.addColorStop(0, withAlpha(accent2, 0.22));
  fillGrad.addColorStop(1, withAlpha(accent, 0));
  ctx.beginPath();
  trace(true);
  ctx.fillStyle = fillGrad;
  ctx.fill();
  // 平滑描边 + 辉光
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, accent);
  grad.addColorStop(1, accent2);
  ctx.beginPath();
  trace(false);
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = withAlpha(accent2, 0.6);
  ctx.shadowBlur = 6;
  ctx.stroke();
  ctx.shadowBlur = 0;
  // 微弱中线（示波器参考）
  ctx.strokeStyle = withAlpha(accent, 0.08);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();
}

// 暂停/无数据：柔和静态正弦 + 渐变填充带 + 辉光 + 呼吸，不抛错
function idleWave(ctx, w, h, accent, accent2) {
  const breathe = 0.8 + 0.2 * Math.sin(vizClock * 0.04);
  const amp = h * 0.16 * breathe;
  const period = Math.max(1, Math.round(w / 90));
  const pts = Math.max(2, Math.min(64, Math.round(w / 6)));
  const sample = (fn) => {
    for (let i = 0; i < pts; i++) {
      const x = (i / (pts - 1)) * w;
      const y = h / 2 + Math.sin((i / (pts - 1)) * Math.PI * 2 * period) * amp;
      if (i === 0) fn.moveTo(x, y);
      else fn.lineTo(x, y);
    }
  };
  // 曲线下方渐变填充带（让波形"挂"得住，不再是一根孤线）
  const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
  fillGrad.addColorStop(0, withAlpha(accent2, 0.14));
  fillGrad.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = fillGrad;
  ctx.beginPath();
  sample(ctx);
  ctx.lineTo(w, h);
  ctx.lineTo(0, h);
  ctx.closePath();
  ctx.fill();
  // 描边 + 辉光
  const grad = ctx.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, withAlpha(accent, 0.7));
  grad.addColorStop(1, withAlpha(accent2, 0.55));
  ctx.strokeStyle = grad;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  ctx.shadowColor = withAlpha(accent2, 0.5);
  ctx.shadowBlur = 6;
  ctx.beginPath();
  sample(ctx);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

// pulse：脉冲环——中心光晕随低频均值脉动 + 外圈频谱环（spokes 辐射），层次分明。
// 技法：中心径向渐变双层（外晕 + 亮核）+ spokes 统一光晕 + 分段渐变粗细节奏 + 基准环锚定。
export function drawPulse(ctx, w, h, data, opts = {}) {
  vizClock++;
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.max(4, Math.min(w, h) / 2 - 2);
  const n = data ? data.length : 0;
  if (!n) {
    idlePulse(ctx, cx, cy, maxR, accent, accent2);
    return;
  }
  // 低频均值（前 1/3 bins）→ 中心圆半径脉动
  const lowN = Math.max(1, Math.floor(n / 3));
  let sum = 0;
  for (let i = 0; i < lowN; i++) sum += data[i];
  const pulse = Math.pow(sum / lowN, 1.2);
  // 外圈基准环（低透明度，锚定结构）
  const ringR = maxR * 0.6;
  ctx.lineCap = "round";
  ctx.strokeStyle = withAlpha(accent, 0.14);
  ctx.lineWidth = Math.max(1, maxR / 36);
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.stroke();
  // 频谱 spokes（基准环向外辐射）：统一光晕 + 分段渐变主画
  const spokeMax = maxR * 0.34;
  ctx.strokeStyle = withAlpha(accent, 0.12);
  ctx.lineWidth = Math.max(2, maxR * 0.09);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = Math.pow(clamp01(data[i]), 1.35);
    const r2 = ringR + v * spokeMax;
    ctx.moveTo(cx + Math.cos(ang) * ringR, cy + Math.sin(ang) * ringR);
    ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
  }
  ctx.stroke();
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2;
    const v = Math.pow(clamp01(data[i]), 1.35);
    const r2 = ringR + v * spokeMax;
    ctx.strokeStyle = blendHex(accent, accent2, i / n);
    ctx.lineWidth = Math.max(1.5, maxR * 0.045 + v * maxR * 0.06);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * ringR, cy + Math.sin(ang) * ringR);
    ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
    ctx.stroke();
  }
  // 中心光晕脉动（外晕 + 亮核）
  const cr = Math.max(5, maxR * 0.15 + pulse * maxR * 0.4);
  const halo = ctx.createRadialGradient(cx, cy, 1, cx, cy, cr * 2.1);
  halo.addColorStop(0, withAlpha(accent2, 0.4));
  halo.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = halo;
  ctx.beginPath();
  ctx.arc(cx, cy, cr * 2.1, 0, Math.PI * 2);
  ctx.fill();
  const core = ctx.createRadialGradient(cx, cy, 1, cx, cy, cr);
  core.addColorStop(0, mixWhite(accent2, 0.8));
  core.addColorStop(0.55, accent2);
  core.addColorStop(1, withAlpha(accent, 0.3));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.fill();
}

// 暂停/无数据：中心亮核 + 两圈扩散涟漪（呼吸，放大版），与 radial（点环）区分，不抛错
function idlePulse(ctx, cx, cy, maxR, accent, accent2) {
  const ph = vizClock * 0.035;
  const cr = Math.max(5, maxR * 0.2);
  const core = ctx.createRadialGradient(cx, cy, 1, cx, cy, cr);
  core.addColorStop(0, mixWhite(accent2, 0.75));
  core.addColorStop(1, withAlpha(accent, 0.25));
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(cx, cy, cr, 0, Math.PI * 2);
  ctx.fill();
  // 两圈扩散涟漪（一帧帧向外扩散并淡出）
  ctx.lineCap = "round";
  for (let k = 0; k < 2; k++) {
    const t = (((ph + k * 0.5) % 1) + 1) % 1;
    const rr = maxR * (0.35 + 0.55 * t);
    const a = 0.42 * (1 - t) + 0.06;
    ctx.strokeStyle = withAlpha(accent2, a);
    ctx.lineWidth = Math.max(1.2, maxR * 0.05 * (1 - t) + 0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  }
}

// mirror：镜像频谱（Spotify 风格）——中轴对称：中心亮线 + 上下镜像圆角条。
// 技法：中心发光基线 + 上/下镜像分别渐变（中心混白亮 → 两端主题色）+ 发光 + 圆角。
export function drawMirror(ctx, w, h, data, opts = {}) {
  vizClock++;
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  const n = data ? data.length : 0;
  if (!n) {
    idleMirror(ctx, w, h, accent, accent2);
    return;
  }
  const half = h / 2;
  const maxH = half - 3;
  const gap = Math.max(1, Math.round(w / n / 5));
  const bw = Math.max(1.5, w / n - gap);
  const r = Math.min(bw / 2, 3);
  // 中心基线（发光亮线）
  ctx.fillStyle = withAlpha(mixWhite(accent2, 0.5), 0.8);
  ctx.shadowColor = withAlpha(accent, 0.7);
  ctx.shadowBlur = 5;
  ctx.fillRect(0, half - 1, w, 2);
  ctx.shadowBlur = 0;
  // 上镜像：中心 → 顶部渐变（主色，全亮）
  const gUp = ctx.createLinearGradient(0, half, 0, 0);
  gUp.addColorStop(0, mixWhite(accent2, 0.55));
  gUp.addColorStop(1, accent);
  ctx.fillStyle = gUp;
  ctx.shadowColor = withAlpha(accent, 0.35);
  ctx.shadowBlur = Math.min(6, bw * 0.4);
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1.5, Math.pow(clamp01(data[i]), 1.35) * maxH);
    roundRectPath(ctx, i * (bw + gap), half - bh, bw, bh, r);
  }
  ctx.fill();
  // 下镜像：中心 → 底部渐变（略降透明度，镜面层次）
  const gDown = ctx.createLinearGradient(0, half, 0, h);
  gDown.addColorStop(0, withAlpha(mixWhite(accent2, 0.4), 0.85));
  gDown.addColorStop(1, withAlpha(accent, 0.6));
  ctx.fillStyle = gDown;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const bh = Math.max(1.5, Math.pow(clamp01(data[i]), 1.35) * maxH);
    roundRectPath(ctx, i * (bw + gap), half, bw, bh, r);
  }
  ctx.fill();
  ctx.shadowBlur = 0;
}

// 暂停/无数据：中心亮线 + 上下对称高斯骨架（行进波纹 + 呼吸），保留 mirror 语义，不抛错
function idleMirror(ctx, w, h, accent, accent2) {
  const half = h / 2;
  const breathe = 0.8 + 0.2 * Math.sin(vizClock * 0.045);
  ctx.fillStyle = withAlpha(accent, 0.45);
  ctx.fillRect(0, half - 1, w, 2);
  const n = Math.max(10, Math.min(40, Math.round(w / 10)));
  const gap = Math.max(1, Math.round(w / n / 5));
  const bw = Math.max(1.5, w / n - gap);
  const grad = ctx.createLinearGradient(0, half - h * 0.35, 0, half + h * 0.35);
  grad.addColorStop(0, withAlpha(accent, 0.35));
  grad.addColorStop(0.5, withAlpha(accent2, 0.5));
  grad.addColorStop(1, withAlpha(accent, 0.35));
  ctx.fillStyle = grad;
  ctx.beginPath();
  const amp = h * 0.3 * breathe;
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1) - 0.5;
    const ripple = 1 + 0.12 * Math.sin(vizClock * 0.08 + i * 0.9);
    const bh = Math.max(1.5, amp * (0.25 + 0.75 * Math.exp(-t * t * 8)) * ripple);
    const x = i * (bw + gap);
    roundRectPath(ctx, x, half - bh, bw, bh, Math.min(bw / 2, 2));
    roundRectPath(ctx, x, half, bw, bh, Math.min(bw / 2, 2));
  }
  ctx.fill();
}

// ---- 粒子流（drawParticle）----
// 粒子锚定频谱槽位（x = 槽位中心，不再乱飘），y 随对应 bin 值律动（lerp 平滑），
// 拖尾（运动轨迹描边）+ 发光头点；无数据 → 轻柔浮游（呼吸感），不抛错。
// 性能：粒子数按面积缩减（基准 48），small 再减；dpr ≤ 2 由 Visualizer 侧限制。
let particles = [];
let particlesKey = "";
let pTime = 0; // 帧计数（呼吸/相位用）

function ensureParticles(count, w, h) {
  const key = `${count}x${Math.round(w)}x${Math.round(h)}`;
  if (particlesKey === key && particles.length === count) return;
  particlesKey = key;
  particles = new Array(count);
  for (let i = 0; i < count; i++) {
    const x = ((i + 0.5) / count) * w; // 均匀铺满宽度（频谱槽位）
    const y = Math.random() * h;
    particles[i] = {
      x,
      y,
      prevY: y,
      phase: Math.random() * Math.PI * 2, // 呼吸相位（个体错开）
      drift: (Math.random() - 0.5) * 0.4, // 轻微横向漂移
      r: 1 + Math.random() * 1.8, // 基础半径
      t: Math.random(), // 混色位置（accent→accent2）
      lerp: 0.08 + Math.random() * 0.1, // 跟随速度（各不相同）
    };
  }
}

export function drawParticle(ctx, w, h, data, opts = {}) {
  vizClock++;
  const accent = opts.accent || "#ff7e5f";
  const accent2 = opts.accent2 || "#feb47b";
  ctx.clearRect(0, 0, w, h);
  // 粒子数按面积缩减：360×64 ≈ 基准面积 → 48 粒子；small 再减
  const area = w * h;
  let count = Math.round(48 * Math.min(1, area / (360 * 64)));
  if (opts.small) count = Math.round(count * 0.6);
  count = Math.max(8, Math.min(48, count));
  ensureParticles(count, w, h);
  const n = data ? data.length : 0;
  pTime++;
  ctx.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const p = particles[i];
    const color = blendHex(accent, accent2, p.t);
    if (n) {
      // 槽位 bin：粒子 i → 频谱 bin i（均匀映射）
      const bin = Math.min(n - 1, Math.floor(((i + 0.5) / count) * n));
      const v = Math.pow(clamp01(data[bin]), 1.3);
      const target = h - 2 - v * (h - 6);
      p.prevY = p.y;
      p.y += (target - p.y) * p.lerp + Math.sin(pTime * 0.07 + p.phase) * 0.35;
      p.x += p.drift;
      if (p.x < 2) p.x = 2;
      else if (p.x > w - 2) p.x = w - 2;
      const pr = p.r * (0.8 + v * 1.6);
      const alpha = 0.25 + v * 0.7;
      // 拖尾：运动轨迹描边（惯性光尾，方向与运动相反）
      const streak = Math.min(14, Math.abs(p.y - p.prevY) + 2);
      const dir = p.y >= p.prevY ? 1 : -1;
      ctx.strokeStyle = withAlpha(color, alpha * 0.55);
      ctx.lineWidth = Math.max(1, pr * 0.8);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y - dir * streak);
      ctx.stroke();
      // 发光头点
      ctx.fillStyle = withAlpha(color, alpha);
      ctx.shadowColor = color;
      ctx.shadowBlur = Math.min(8, pr * 3);
      ctx.beginPath();
      ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // 暂停/无数据：轻柔浮游（原地呼吸），保持设计感
      p.prevY = p.y;
      p.y += Math.sin(pTime * 0.025 + p.phase) * 0.3;
      p.x += p.drift * 0.5;
      if (p.x < 2) p.x = 2;
      else if (p.x > w - 2) p.x = w - 2;
      const pr = p.r * (0.9 + 0.35 * Math.sin(pTime * 0.03 + p.phase));
      ctx.strokeStyle = withAlpha(color, 0.4);
      ctx.lineWidth = Math.max(1, pr * 0.7);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(p.x, p.y + 3);
      ctx.stroke();
      ctx.fillStyle = withAlpha(color, 0.55);
      ctx.shadowColor = color;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      ctx.arc(p.x, p.y, pr, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}

export function _resetParticles() {
  particles = [];
  particlesKey = "";
  pTime = 0;
}

// 仅供测试：重置挂载状态（与 playerCore._resetEqGraph 配套）
export function _resetVisualizer() {
  analyser = null;
  attached = false;
  failed = false;
}
