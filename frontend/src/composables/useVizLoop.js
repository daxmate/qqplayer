// ============ 可视化 rAF 循环（按环境差异化：Swift 壳满帧 vs 浏览器降级保流畅） ============
// 背景：Visualizer 氛围背景 / MiniSpectrum 迷你频谱每帧全量重绘 canvas（retina DPR 2x 约
// 190 万像素/帧 @60fps，暂停时也画"呼吸动画"从不停）。Chromium 的 canvas 合成链
// （Skia→GPU 进程）扛不住（Vivaldi 暂停时 GPU 进程 CPU 78%）；WebKit（壳）原生优化好，
// 满帧无压力 → 壳内效果必须完全不变，浏览器降级只为"运行正常"。
//
// 差异化策略：
//   - 壳（window.qqplayerNative 注入）：行为与历史完全一致——DPR ≤2、满帧（不节流）、
//     暂停继续呼吸动画（rAF 不停）、不处理页面隐藏
//   - 浏览器（无 qqplayerNative）：DPR=1（低分辨率光晕 CSS 放大无感，绘制像素减 4 倍）、
//     30fps 节流（rAF 回调里按时间戳 ≥33ms 才 paint，循环本身继续排帧）、暂停 → 只画一帧
//     静态并停 rAF（恢复播放再启动）、页面隐藏 → 停 rAF（visibilitychange 恢复）
import { watch } from "vue";

/** 是否运行在 Swift 原生壳内（壳注入 window.qqplayerNative；浏览器没有） */
export function isNativeShell() {
  return typeof window !== "undefined" && !!window.qqplayerNative;
}

/**
 * 可视化 rAF 循环（差异化封装）。两组件（Visualizer / MiniSpectrum）共用。
 * @param {object} opts
 * @param {() => void} opts.paint 每帧绘制（节流时跳过；暂停/关闭时补画一帧静态）
 * @param {() => boolean} opts.isEnabled 视觉化区域开关（computed 求值）
 * @param {() => boolean} opts.isPlaying 播放态（浏览器分支驱动循环启停）
 * @returns {{ dpr: number, dispose: () => void }}
 *   dpr：壳 = min(2, devicePixelRatio)（历史行为）；浏览器 = 1（降级）
 *   dispose：卸载清理（停 rAF + 摘 visibilitychange）
 */
export function useVizLoop({ paint, isEnabled, isPlaying }) {
  const shell = isNativeShell();
  const dpr = shell ? Math.min(2, window.devicePixelRatio || 1) : 1;
  const frameMs = shell ? 0 : 1000 / 30; // 0 = 不限（壳满帧）；浏览器 30fps

  let rafId = 0; // 始终指向"下一帧"的 pending id（tick 先排帧再画）
  let running = false;
  let lastPaintTs = null; // 节流基线；null = 首帧立即画（暂停恢复不吞帧）

  function start() {
    if (running) return;
    running = true;
    lastPaintTs = null;
    rafId = requestAnimationFrame(tick);
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function tick(ts) {
    if (!running) return; // 已在 stop 后（防御：排队的回调不再续排）
    rafId = requestAnimationFrame(tick); // 循环：先排下一帧，再决定本次是否画
    if (frameMs > 0 && lastPaintTs != null && ts - lastPaintTs < frameMs) return; // 节流跳过
    lastPaintTs = ts;
    paint();
  }

  function shouldRun() {
    if (!isEnabled()) return false;
    if (shell) return true; // 壳：暂停呼吸动画照旧（rAF 不停），不处理页面隐藏
    return !!isPlaying() && !document.hidden; // 浏览器：仅播放中且页面可见
  }

  /** 状态收敛：运行条件成立 → 启动循环；不成立 → 停 rAF +（可选）补画一帧静态 */
  function syncRun(paintOnStop) {
    if (shouldRun()) {
      if (!running) start();
    } else if (running) {
      stop();
      if (paintOnStop) paint();
    }
  }

  // 开关驱动（壳/浏览器一致：开启即跑，关闭停掉并画一帧静止）——历史行为保留
  const stopEnabledWatch = watch(isEnabled, () => syncRun(true), {
    flush: "sync",
    immediate: true,
  });

  let onVis = null;
  let stopPlayingWatch = null;
  if (!shell) {
    // 浏览器：暂停 → 停 rAF（画一帧静态）；恢复播放 → 重启
    stopPlayingWatch = watch(isPlaying, () => syncRun(true), { flush: "sync" });
    // 浏览器：页面隐藏 → 停 rAF；恢复可见 → 重启
    onVis = () => syncRun(false);
    document.addEventListener("visibilitychange", onVis);
  }

  function dispose() {
    stop();
    stopEnabledWatch();
    if (stopPlayingWatch) stopPlayingWatch();
    if (onVis) document.removeEventListener("visibilitychange", onVis);
  }

  return { dpr, dispose };
}
