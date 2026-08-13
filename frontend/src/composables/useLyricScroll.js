// transform 平移滚动（替代原生 scrollTop 滚动）
//
// 为什么：WKWebView 里 scrollTop 写入走异步滚动协调（主线程同步开销大），
// 加上 font-size 过渡每帧 layout → 掉帧一顿一顿；Chromium 对两者都有优化所以流畅。
// translateY 平移只改合成属性，不触发 layout、不碰原生滚动，两引擎一致顺滑。
//
// 结构：scrollEl(overflow:hidden, mask) > trackEl(translateY) > [spacer, 行…, spacer]
//  - 顶部/底部 spacer 高度 = 视口一半 → 第一句/最后一句都能滚到焦点停靠位（默认居中）
//  - 滚动量 = clamp(focusPos*H - lineTop - lineH/2, [-max, 0])
//  - 滚轮手动接管（deltaY 直接映射），动画进行中用户滚动立即让位
import { onBeforeUnmount, onMounted } from "vue";

const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function reducedMotion() {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function useLyricScroll(scrollEl, trackEl, opts = {}) {
  const { getFocusPos = () => 0.5 } = opts;
  let offset = 0; // 当前 translateY
  let raf = null;
  let ro = null;

  // 可视内容区高度 = clientHeight - 上下 padding（歌词滚动基准，与 CSS padding 一致）
  function viewH() {
    const el = scrollEl.value;
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  }

  function cancelAnim() {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  }

  function clamp(o) {
    const max = Math.max(0, (trackEl.value?.scrollHeight || 0) - viewH());
    return Math.max(-max, Math.min(0, o));
  }

  function apply(o) {
    offset = o;
    trackEl.value.style.transform = `translateY(${o}px)`;
  }

  // 顶部/底部占位 = 内容区一半高度：第一句/最后一句可滚到中央（随视口变化，resize 时重算）
  function layoutSpacers() {
    const h = viewH() / 2;
    scrollEl.value
      ?.querySelectorAll(".lyric-spacer, .kp-spacer")
      .forEach((s) => {
        s.style.height = `${h}px`;
      });
  }

  /** 滚动到目标行（其中心停靠焦点位）；animate=false 或系统减弱动态效果时瞬间定位 */
  function scrollTo(el, animate = true) {
    if (!el || !trackEl.value) return;
    const target = clamp(viewH() * getFocusPos() - el.offsetTop - el.offsetHeight / 2);
    if (!animate || reducedMotion() || Math.abs(target - offset) < 1) {
      apply(target);
      return;
    }
    cancelAnim();
    const from = offset;
    const delta = target - from;
    const duration = Math.min(550, Math.max(300, Math.abs(delta) * 0.4));
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min((now - t0) / duration, 1);
      apply(from + delta * easeInOutCubic(p));
      if (p < 1) raf = requestAnimationFrame(step);
      else raf = null;
    };
    raf = requestAnimationFrame(step);
  }

  /** 用户滚轮：手动滚动并打断动画 */
  function onWheel(e) {
    e.preventDefault();
    cancelAnim();
    apply(clamp(offset - e.deltaY));
  }

  function onInterrupt() {
    cancelAnim();
  }

  /** 视口尺寸变化：重排占位 + 当前句重新停靠 */
  function relayout() {
    layoutSpacers();
    const active = scrollEl.value?.querySelector(".lyr.active, .kline.active");
    if (active) apply(clamp(viewH() * getFocusPos() - active.offsetTop - active.offsetHeight / 2));
  }

  onMounted(() => {
    layoutSpacers();
    const el = scrollEl.value;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onInterrupt, { passive: true });
    el.addEventListener("pointerdown", onInterrupt);
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(relayout);
      ro.observe(el);
    }
  });

  onBeforeUnmount(() => {
    cancelAnim();
    ro?.disconnect();
    const el = scrollEl.value;
    if (!el) return;
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onInterrupt);
    el.removeEventListener("pointerdown", onInterrupt);
  });

  return { scrollTo, relayout, cancel: cancelAnim };
}
