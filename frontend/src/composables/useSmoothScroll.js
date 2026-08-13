// 引擎无关的平滑滚动：rAF 插值替代 scrollTo({behavior:'smooth'})
//
// 为什么自控：WebKit/WKWebView 的程序化平滑滚动跑在主线程且实现与 Chromium 不一致
// （Chromium 走合成线程、WebKit 历史上支持晚/出过回归），同一套代码两引擎手感不同。
// rAF 逐帧插值让行为完全可控且两引擎一致，并支持：
//   - 每次调用取消上一次动画（连续切句不排队）
//   - 用户手势（滚轮/触摸/点击）打断时让位
//   - 尊重系统 prefers-reduced-motion（瞬间定位）
import { onBeforeUnmount, onMounted } from "vue";

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

// 柔和优先：起止都慢（easeInOut），不追求"快准狠"
const DEFAULT_EASING = easeInOutCubic;

function reducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function cancelSmoothScroll(el) {
  if (el && el.__smoothScroll) {
    cancelAnimationFrame(el.__smoothScroll.raf);
    el.__smoothScroll = null;
  }
}

/**
 * 平滑滚动到 target（自动 clamp 到合法范围）。
 * duration 随距离自适应：近句 ~200ms，远句最多 400ms。
 */
export function animateScroll(el, target, opts = {}) {
  if (!el) return;
  cancelSmoothScroll(el);
  const { easing = DEFAULT_EASING, maxDuration = 550, minDuration = 300 } = opts;
  const start = el.scrollTop;
  const maxTop = el.scrollHeight - el.clientHeight;
  const end = Math.max(0, Math.min(target, maxTop));
  const delta = end - start;
  if (Math.abs(delta) < 1 || reducedMotion()) {
    el.scrollTop = end; // 已在目标位置 / 系统减弱动态效果 → 瞬间定位
    return;
  }
  const duration = Math.min(maxDuration, Math.max(minDuration, Math.abs(delta) * 0.4));
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min((now - t0) / duration, 1);
    const expect = start + delta * easing(p);
    el.scrollTop = expect;
    // 外部干预（用户滚轮/触摸/拖滚动条）：实际位置与预期反向偏差 → 让位
    if (
      p < 1 &&
      Math.abs(el.scrollTop - expect) > 3 &&
      Math.sign(el.scrollTop - expect) !== Math.sign(delta)
    ) {
      cancelSmoothScroll(el);
      return;
    }
    if (p < 1) {
      el.__smoothScroll = { raf: requestAnimationFrame(step) };
    } else {
      el.__smoothScroll = null;
    }
  };
  el.__smoothScroll = { raf: requestAnimationFrame(step) };
}

/** 组件内使用：用户手势打断进行中的滚动动画 */
export function useScrollCancel(scrollEl) {
  const onUser = () => cancelSmoothScroll(scrollEl.value);
  onMounted(() => {
    const el = scrollEl.value;
    if (!el) return;
    el.addEventListener("wheel", onUser, { passive: true });
    el.addEventListener("touchstart", onUser, { passive: true });
    el.addEventListener("pointerdown", onUser);
  });
  onBeforeUnmount(() => {
    cancelSmoothScroll(scrollEl.value);
    const el = scrollEl.value;
    if (!el) return;
    el.removeEventListener("wheel", onUser);
    el.removeEventListener("touchstart", onUser);
    el.removeEventListener("pointerdown", onUser);
  });
}
