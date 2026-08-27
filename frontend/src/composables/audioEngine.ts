// 音频域（P1-2 批次2：从 playerCore.js 拆出）
//
// audioEq/audioBare/audio 元素、均衡器音频图（Web Audio）、音量、切歌淡入淡出、
// 音频事件绑定。
// 依赖方向：仅 playerState / useEq / nativeAudioBridge（单向，无循环）。
//
// 循环依赖处理（与原始 playerCore.js 的行为零变化）：
//   - 音频事件回调涉及播放会话/跟唱/媒体键同步 → 经 registerAudioEventHooks 由
//     playbackEngine / mediaSession / useAbLoop 在模块求值期注入（audioEngine 不反向
//     import 它们，避免 audioEngine ↔ playbackEngine/mediaSession 成环）。
//   - useEq 的 setEqPreset/setEqGain 需要即时应用音频图 → registerEqGraphApplier
//     把 applyEqToGraph 注入 useEq（避免 audioEngine ↔ useEq 成环）。
import { watch } from "vue";
import { state, playbackSettings } from "./playerState.ts";
import { EQ_BANDS, EQ_PRESETS, registerEqGraphApplier } from "./useEq.js";
import { isNativePlayback, createNativeAudioProxy } from "./nativeAudioBridge.js";

// 音频元素统一视图（HTMLAudioElement 与 iOS 原生 Audio 语义代理的共同形状；
// 事件回调参数一律 unknown，需要字段时最小化 as）
export interface PlayerAudioLike {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  preload: string;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, fn: (e: unknown) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  removeAttribute(attr: string): void;
}

export type AudioEventListener = (e: unknown) => void;

// 全局唯一 audio 元素
// 导出供 useLyric/useAbLoop/useEq 等模块直接操作播放原语
// 双元素设计（2026-08-19，WebKit 变速缺陷）：
// audioEq 接 Web Audio 图（EQ/频谱，常态 1.0 播放）；audioBare 永不接图（变速用）。
// WebKit 中 createMediaElementSource 接管后变速（尤其 0.75 减速）走缺陷链路会卡顿，
// 且元素被接管后无法归还（规范限制）→ 变速时切到裸元素走原生媒体管线（流畅），
// 回 1.0 切回图元素（EQ 照常）。audio 为当前活动元素引用（live binding，其他模块自动跟随）。
// iOS 原生壳（window.qqplayerIosBridge 存在）：audio = Audio 语义代理（转发 AVPlayer），
// 双元素/Web Audio 图均不参与（原生管线），桌面浏览器行为完全不变。
export const audioEq: PlayerAudioLike = new Audio() as unknown as PlayerAudioLike;
export const audioBare: PlayerAudioLike = new Audio() as unknown as PlayerAudioLike;
export let audio: PlayerAudioLike = isNativePlayback()
  ? (createNativeAudioProxy() as unknown as PlayerAudioLike)
  : audioEq;
audio.preload = "auto";
audioBare.preload = "auto";
// 包装 play：每次播放前确保 Web Audio 图就绪（懒创建 + resume，autoplay policy 需要用户手势）
// 均衡器常驻音频图后，audio 元素的声音只经过 AudioContext 输出，context suspended 时会无声，
// 所以必须在 play 前 resume。注意：图创建与 resume 发起是同步的（在手势栈内生效），
// 但 play() 的返回不受异步 resume 阻塞——否则自动切歌等场景的播放状态更新会延迟。
// 图元素 play 时懒建图；裸元素（变速）不建图（原生管线）
const origEqPlay = audioEq.play.bind(audioEq);
audioEq.play = () => {
  ensureAudioGraph();
  return origEqPlay();
};

// ============ 均衡器音频图（Web Audio API 生命周期）============
// 10 段经典频点（foobar2000/网易云同款），±12dB
// 技术要点：createMediaElementSource 一个 audio 元素只能接管一次，
// 所以音频图常驻（首次播放懒创建），开关关闭 = 增益全 0（0dB peaking 近似直通），不做动态路由切换。
// 对外 API（EQ_BANDS/EQ_PRESETS/setEqPreset/setEqGain）在 useEq.js；audio 与图强耦合，生命周期留这里。
let audioCtx: AudioContext | null = null; // AudioContext 实例（懒初始化，常驻）
let eqFilters: BiquadFilterNode[] = []; // 10 个 BiquadFilter（peaking），与 EQ_BANDS 对齐
let eqGraphFailed = false; // 创建失败标记（降级为直通，不再重试）
// 音量主控 GainNode（2026-08-27 新增）：macOS WKWebView 中 createMediaElementSource
// 接管后元素 volume 失效（实测 volume=0 输出 RMS 不变）→ 图接管路径的音量改由 masterGain
// 控制，audioEq.volume 固定 1；未接管路径（audioBare 变速 / 图未建 / iOS 原生）仍走元素音量。
let masterGain: GainNode | null = null;

// 变速切换中标志：抑制 pause 回调的播放会话 flush（避免变速产生断裂的播放记录）
let swappingAudio = false;

// 切换活动音频元素（变速 ↔ 常速）：状态迁移到目标元素后接管播放。
// 变速（0.75/1.25）→ audioBare（原生媒体管线，WebKit 变速流畅）；
// 1.0 → audioEq（Web Audio 图，EQ/频谱生效）。
// 切换瞬间有短暂中断（~100ms：pause → src/seek → play），变速是主动操作，可接受。
function swapAudioElement(next: PlayerAudioLike) {
  // iOS 原生播放：双元素切换不参与（变速走 AVPlayer rate），保持 audio=代理不变
  if (isNativePlayback()) return;
  if (next === audio) return;
  const cur = audio;
  const wasPlaying = !cur.paused;
  const t = cur.currentTime || 0;
  const src = cur.src;
  swappingAudio = true;
  cur.pause();
  if (src) {
    next.src = src; // 同源（本地/代理 URL）浏览器缓存秒开
    // 音量不直接复制元素值：图接管时 audioEq.volume 恒 1（音量在 masterGain），
    // 目标元素音量由下面 applyVolume 按状态重设（audioBare 未接管 → 元素音量 = 当前音量）
    next.muted = false;
    next.playbackRate = state.speed;
    if (t > 0) next.currentTime = t; // src 未就绪时设 currentTime：浏览器排队到可 seek 后生效
  }
  audio = next;
  applyVolume(); // 切换后按目标元素类型重设音量（图元素→masterGain；裸元素→元素音量）
  swappingAudio = false;
  if (wasPlaying && src) next.play().catch(() => {});
}

// 统一变速入口（4 处赋值共用）：变速时切到裸元素（原生管线流畅），1.0 切回图元素（EQ）
// 导出供 queueEngine（selectSong/playPreview 换源后恢复变速）与 playbackEngine（cycleSpeed/stepSpeed）调用
export function applySpeed() {
  swapAudioElement(state.speed === 1.0 ? audioEq : audioBare);
  audio.playbackRate = state.speed;
}

// 音量应用统一入口（2026-08-27 WKWebKit 接管失效修复）：
// - 图已创建且活动元素是 audioEq → 音量走 masterGain（WebKit 中元素 volume 接管后失效）
// - 其余（图未建 / audioBare 变速走原生管线 / iOS 原生代理）→ 元素 volume（未接管，元素音量有效）
export function applyVolumeTo(targetVol: number) {
  const v = Math.min(1, Math.max(0, Number(targetVol) || 0));
  if (audioCtx && masterGain && audio === audioEq) {
    masterGain.gain.value = v;
    audioEq.volume = 1;
  } else {
    audio.volume = v;
  }
}

// 音量应用（按状态重设当前活动元素音量；queueEngine/playbackEngine 跨域调用）
export function applyVolume() {
  applyVolumeTo(state.muted ? 0 : state.volume);
}

// 确保音频图就绪（首次播放/用户手势时创建并 resume）。
// 只接管 audioEq（图元素）；audioBare（变速）永不接管。
// 无 AudioContext 环境（旧浏览器/测试）静默降级，不影响播放。
function ensureAudioGraph(): Promise<void> {
  if (audioCtx || eqGraphFailed) return Promise.resolve();
  // webkitAudioContext 不在 DOM 类型里，用宽松键值视图取
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const AC = typeof window !== "undefined" && (w.AudioContext || w.webkitAudioContext);
  if (!AC) return Promise.resolve();
  try {
    const ctx = new AC();
    const src = ctx.createMediaElementSource(audioEq as unknown as HTMLAudioElement);
    // 音量主控节点：置于滤波器链前（WebKit 接管后元素 volume 失效 → 音量由 gain 承担）。
    // 放 filters 前 → useVisualizer 的 analyser 插在 filters 后，看到的信号已含音量（与原行为一致）。
    const gainNode = ctx.createGain();
    gainNode.gain.value = state.muted ? 0 : state.volume;
    src.connect(gainNode);
    masterGain = gainNode;
    let node: AudioNode = gainNode;
    audioEq.volume = 1; // 接管后元素音量归一（音量由 masterGain 控制）
    for (const f of EQ_BANDS) {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = f;
      filter.Q.value = 1.0;
      filter.gain.value = 0;
      node.connect(filter);
      node = filter;
      eqFilters.push(filter);
    }
    node.connect(ctx.destination);
    audioCtx = ctx;
    applyEqToGraph(); // 创建前可能已改过设置（恢复持久化值）
    return ctx.resume().catch(() => {});
  } catch {
    // 创建失败：清空半成品，标记降级（浏览器不支持等情况）
    audioCtx = null;
    eqFilters = [];
    masterGain = null;
    eqGraphFailed = true;
    return Promise.resolve();
  }
}

// 频谱可视化：暴露音频图访问器（useVisualizer 懒挂 AnalyserNode 到图尾，纯直通不改音频路径）
// 返回 { audioCtx, eqFilters }；图未创建（首次播放前/无 AudioContext）时 audioCtx 为 null
// 图节点为模块私有（createMediaElementSource 一个 audio 元素只能接管一次，图必须常驻），
// 故只暴露只读引用，连接拓扑的改动由 useVisualizer 在拿到引用后完成。
export function getEqGraph() {
  return { audioCtx, eqFilters };
}

// 音量/图调试钩子（2026-08-27 WKWebKit 音量排故用：验证图接管后音量链路）
export function getVolumeDebugInfo() {
  return {
    hasGraph: !!audioCtx,
    masterGain: masterGain ? masterGain.gain.value : null,
    audioEqVolume: audioEq.volume,
    audioVolume: audio.volume,
    stateVolume: state.volume,
    stateMuted: state.muted,
    audioIsEq: audio === audioEq,
    isNative: isNativePlayback(),
  };
}
// 验收/自动化钩子：window.__qqVolDebug()（壳内或 Playwright 验证音量链路）
if (typeof window !== "undefined") {
  (window as unknown as { __qqVolDebug: () => unknown }).__qqVolDebug = getVolumeDebugInfo;
}

// 把当前均衡器设置应用到音频图（图未创建时无操作，创建时统一应用）
// 导出供 useEq.js 的 setEqPreset/setEqGain 同步应用（经 registerEqGraphApplier 注入）
export function applyEqToGraph() {
  if (!audioCtx) return;
  const enabled = !!playbackSettings.eqEnabled;
  // EQ_PRESETS 来自 useEq.js（JS 推断出具体字面量类型），按宽松键值视图索引
  const eqPresets = EQ_PRESETS as unknown as Record<
    string,
    { labelKey: string; gains: number[] | null }
  >;
  const preset = eqPresets[playbackSettings.eqPreset] || eqPresets.flat;
  // 关闭 → 全 0 直通；自定义 → eqGains；预设 → 预设值（运行期 gains 必为数组）
  const gains = (
    enabled ? preset.gains || playbackSettings.eqGains : eqPresets.flat.gains
  ) as number[];
  eqFilters.forEach((f, i) => {
    f.gain.value = gains[i] ?? 0;
  });
}

// 注入 applyEqToGraph 到 useEq（setEqPreset/setEqGain 即时应用；避免 useEq ↔ 本模块循环 import）
registerEqGraphApplier(applyEqToGraph);

// 测试钩子：重置音频图（用例隔离）
export function _resetEqGraph() {
  audioCtx = null;
  eqFilters = [];
  masterGain = null;
  eqGraphFailed = false;
  swappingAudio = false;
  audio = audioEq; // 活动元素复位（测试用例隔离）
}

// 均衡器设置变化 → 实时应用到音频图（未创建时下次创建应用）
// 注：playbackSettings 在 playerState（先于本模块求值），此处注册 watch 无求值期依赖
watch(
  () => [playbackSettings.eqEnabled, playbackSettings.eqPreset, playbackSettings.eqGains],
  () => applyEqToGraph(),
  { deep: true },
);

// ============ 音量（localStorage 持久化）============
export const VOLUME_KEY = "qqplayer.volume.v1";

function loadVolume() {
  if (!playbackSettings.rememberVolume) return; // 不记住音量：保持默认 100%
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY) || "");
    if (!isNaN(v) && v >= 0 && v <= 1) {
      state.volume = v;
      applyVolume();
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadVolume();

function persistVolume() {
  if (!playbackSettings.rememberVolume) return; // 关闭记住音量：不写入
  try {
    localStorage.setItem(VOLUME_KEY, String(state.volume));
  } catch {
    /* 忽略写入失败 */
  }
}

export function setVolume(v: number) {
  state.volume = Math.min(1, Math.max(0, v));
  state.muted = false; // 手动调音量自动取消静音
  applyVolume();
  persistVolume();
}

export function toggleMute() {
  state.muted = !state.muted;
  applyVolume();
}

// ============ 切歌淡入淡出 ============
let fadeSeq = 0; // 切歌序列号：快速连切时旧淡出让位（旧切换自动放弃）

// 取下一个切歌序列号（原 ++fadeSeq；queueEngine.selectSong 用它标识本次切歌）
export function beginFadeSequence() {
  return ++fadeSeq;
}

// 当前音量淡出到 0（50ms 一步）。被更新的切歌取代时 resolve(false) → 放弃本次切换
// 注意：每个淡出用独立 timer——若共用全局 timer，新切歌清掉旧 timer 会让旧 promise 永不 resolve
// 导出供 queueEngine.selectSong 使用
export function fadeOut(sec: number, seq: number): Promise<boolean> {
  return new Promise((resolve) => {
    // 基准音量读状态而非元素：图接管时 audioEq.volume 恒 1，元素值不能反映实际音量
    const base = state.muted ? 0 : state.volume;
    if (!(sec > 0) || base <= 0) {
      resolve(true);
      return;
    }
    const steps = Math.max(1, Math.round(sec * 20));
    const step = -base / steps;
    let i = 0;
    const timer = setInterval(() => {
      if (seq !== fadeSeq) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      i += 1;
      applyVolumeTo(Math.max(0, base + step * i));
      if (i >= steps) {
        clearInterval(timer);
        applyVolumeTo(0);
        resolve(true);
      }
    }, 50);
  });
}

// 从 0 淡入到目标音量（不阻塞；独立 timer，与淡出互不干扰）
// 导出供 queueEngine.selectSong 使用
export function fadeIn(sec: number) {
  if (!(sec > 0)) return;
  const target = state.muted ? 0 : state.volume;
  if (target <= 0) return;
  const steps = Math.max(1, Math.round(sec * 20));
  const step = target / steps;
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    applyVolumeTo(Math.min(target, step * i));
    if (i >= steps) {
      clearInterval(timer);
      applyVolumeTo(target);
    }
  }, 50);
}

// ============ 音频事件（双元素都绑：audioEq 常态 / audioBare 变速；audio 活动引用即触发元素）============
// 跨域回调注入（playbackEngine/mediaSession/useAbLoop 模块求值期注册，事件触发期调用）：
//   syncPosition / syncPlaybackState —— mediaSession（MediaSession 位置/播放态同步）
//   maybeSaveLastPlayed / onPlaybackStarted / onPlaybackPaused / onPlaybackEnded —— playbackEngine
//     （播放进度节流保存、播放会话跟踪、跟唱 ticker、播完自动切歌）
//   karaokeTick —— useAbLoop（跟唱句末处理 / AB 循环 / 单句循环）
export interface AudioEventHooks {
  syncPosition?: () => void;
  syncPlaybackState?: () => void;
  maybeSaveLastPlayed?: () => void;
  karaokeTick?: (t: number) => void;
  onPlaybackStarted?: () => void;
  onPlaybackPaused?: (swappingAudio: boolean) => void;
  onPlaybackEnded?: () => void;
}

const audioEventHooks: AudioEventHooks = {};

export function registerAudioEventHooks(hooks: AudioEventHooks) {
  Object.assign(audioEventHooks, hooks);
}

function bindAudioEvents(el: PlayerAudioLike) {
  el.addEventListener("timeupdate", () => {
    state.currentTime = audio.currentTime;
    audioEventHooks.syncPosition?.();
    // 恢复上次播放：节流保存进度（10s 一次；页面关闭由 setupPlaybackFlush 兑底）
    audioEventHooks.maybeSaveLastPlayed?.();
    // 跟唱模式：每句播完自动停 / AB 区间循环 / 单句循环（逻辑在 useAbLoop.js）
    audioEventHooks.karaokeTick?.(audio.currentTime);
  });

  el.addEventListener("play", () => {
    state.isPlaying = true;
    audioEventHooks.syncPlaybackState?.();
    // 真正开始出声才建播放会话：选歌但未播放不记；
    // 若已跟踪的歌不同（换歌后立即播放）→ 先上报旧会话（onPlaybackStarted 内处理）
    audioEventHooks.onPlaybackStarted?.();
  });

  el.addEventListener("pause", () => {
    state.isPlaying = false;
    audioEventHooks.syncPlaybackState?.();
    // 暂停：结束当前播放会话并上报（跟唱模式句间暂停不逐条上报——onPlaybackPaused 内处理；
    // 变速切换的假 pause 由 swappingAudio 抑制）
    audioEventHooks.onPlaybackPaused?.(swappingAudio);
  });

  el.addEventListener("ended", () => {
    state.isPlaying = false;
    audioEventHooks.syncPlaybackState?.();
    // 自然播完：标记 completed 后上报；试听自然停 / 跟唱停 / 单曲循环 / 自动切歌
    // （repeatOne 除外，同一首歌继续听）——完整逻辑在 onPlaybackEnded
    audioEventHooks.onPlaybackEnded?.();
  });
}
bindAudioEvents(audioEq);
bindAudioEvents(audioBare);
// iOS 原生播放：事件绑到 Audio 代理（原生 timeupdate/playing/paused/ended 驱动同一套 UI 逻辑）
if (isNativePlayback()) bindAudioEvents(audio);
