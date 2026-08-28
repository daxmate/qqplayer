// transform 平移滚动（弹簧物理版）
//
// 为什么 translateY：WKWebView 里 scrollTop 写入走异步滚动协调（主线程同步开销大），
// 加上 font-size 过渡每帧 layout → 掉帧一顿一顿；Chromium 对两者都有优化所以流畅。
// translateY 平移只改合成属性，不触发 layout、不碰原生滚动，两引擎一致顺滑。
//
// 为什么弹簧：借鉴 applemusic-like-lyrics (amll) 的 Apple Music 歌词滚动——固定缓动
// 曲线（easeInOutCubic）是"匀速补间"，弹簧物理是"跟手又带弹性"的真实手感：
//   - 位置由弹簧驱动（解析解，见 spring.js），参数随行间隔动态调整（快歌更硬更跟手，
//     慢歌更软更从容；Seek/首尾行过阻尼不弹）
//   - 滚轮/触摸手动接管：动画中用户滚动立即让位，滚动方向由手势决定
//   - 松手惯性：按松手速度衰减滚动（amll ScrollInteractionEngine 同款衰减率）
//   - 5 秒无操作自动恢复跟随当前行（amll onAutoAlignResume 同款）
//
// 结构：scrollEl(overflow:hidden, mask) > trackEl(translateY) > [spacer, 行…, spacer]
//   - 顶部/底部 spacer 高度 = 视口一半 → 第一句/最后一句都能滚到焦点停靠位（默认居中）
//   - 滚动量 = clamp(focusPos*H - lineTop - lineH/2, [-max, 0])
import { onBeforeUnmount, onMounted, watch, type Ref, type WatchStopHandle } from "vue";
import { Spring, getLyricSpringPolicy } from "./spring.js";

const INERTIA_DECAY = 0.95; // 每帧(16ms)速度衰减率，与 amll 一致
const AUTO_ALIGN_DELAY = 5000; // 手动滚动停止后多久恢复自动跟随（ms）
const WHEEL_END_DELAY = 150; // 滚轮停止判定（ms）

function reducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** useLyricScroll 选项 */
interface LyricScrollOptions {
  /** 焦点句停靠位置（可视区高度比例，默认 0.5 居中） */
  getFocusPos?: () => number;
  /** 启用开关：null = 始终启用；传 ref 时（多引擎切换场景）按值动态绑定/解绑事件 */
  enabled?: Ref<boolean> | null;
  /** 5s 后自动恢复跟随（默认 true；显式 false 关闭自动对齐恢复） */
  autoScroll?: boolean;
}

/** scrollTo 目标行选项 */
interface ScrollToOptions {
  animate?: boolean; // false = 瞬间定位（Seek/首尾行）
  intervalMs?: number; // 与上一句的时间间隔（弹簧参数随行间隔动态调整）
  isSeeking?: boolean; // seek 场景：强制过阻尼不弹
}

/** useLyricScroll 返回的滚动控制器 */
interface LyricScrollController {
  scrollTo: (el: HTMLElement | null, opts?: ScrollToOptions) => void;
  relayout: () => void;
  cancel: () => void;
}

export function useLyricScroll(
  scrollEl: Ref<HTMLElement | null>,
  trackEl: Ref<HTMLElement | null>,
  opts: LyricScrollOptions = {},
): LyricScrollController {
  const { getFocusPos = () => 0.5, enabled = null } = opts;
  // enabled：ref 或 null。null = 始终启用；传 ref 时（多引擎切换场景）按值动态绑定/解绑事件
  const isEnabled = (): boolean => (enabled ? enabled.value : true);

  let offset = 0; // 当前 translateY
  let raf: number | null = null;
  let ro: ResizeObserver | null = null;
  let watchEnabled: WatchStopHandle | null = null; // enabled ref 的 watcher（多引擎切换场景）

  // 弹簧：驱动自动滚动（scrollTo 时设目标）
  const spring = new Spring(0);

  // 手势/惯性状态
  let touching = false;
  let touchStartY = 0;
  let touchStartOffset = 0;
  let lastTouchY = 0;
  let lastTouchTime = 0;
  let touchSpeed = 0;
  let inertiaRaf: number | null = null;
  let alignTimer: number | null = null; // 5s 自动恢复定时器
  let wheelEndTimer: number | null = null;
  let isInteracting = false; // 用户手动滚动中 → 冻结自动跟随

  // 最近一次自动滚动的目标行（供 5s 后恢复跟随）
  let lastActive: HTMLElement | null = null;

  // 可视内容区高度 = clientHeight - 上下 padding（歌词滚动基准，与 CSS padding 一致）
  function viewH(): number {
    const el = scrollEl.value;
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return el.clientHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0);
  }

  function cancelAnim(): void {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    if (inertiaRaf) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = null;
    }
  }

  function clearTimers(): void {
    if (alignTimer) {
      clearTimeout(alignTimer);
      alignTimer = null;
    }
    if (wheelEndTimer) {
      clearTimeout(wheelEndTimer);
      wheelEndTimer = null;
    }
  }

  function clamp(o: number): number {
    const max = Math.max(0, (trackEl.value?.scrollHeight || 0) - viewH());
    return Math.max(-max, Math.min(0, o));
  }

  function apply(o: number): void {
    offset = o;
    trackEl.value!.style.transform = `translateY(${o}px)`;
  }

  // 顶部/底部占位 = 内容区一半高度：第一句/最后一句可滚到中央（随视口变化，resize 时重算）
  function layoutSpacers(): void {
    const h = viewH() / 2;
    scrollEl.value?.querySelectorAll<HTMLElement>(".lyric-spacer, .kp-spacer").forEach((s) => {
      s.style.height = `${h}px`;
    });
  }

  // 计算某行滚到焦点停靠位需要的偏移
  function targetFor(el: HTMLElement): number {
    return clamp(viewH() * getFocusPos() - el.offsetTop - el.offsetHeight / 2);
  }

  /** 自动滚动到目标行（弹簧驱动）；animate=false 或系统减弱动态效果时瞬间定位 */
  function scrollTo(
    el: HTMLElement | null,
    { animate = true, intervalMs, isSeeking = false }: ScrollToOptions = {},
  ): void {
    if (!el || !trackEl.value) return;
    const target = targetFor(el);
    if (!animate || reducedMotion() || Math.abs(target - offset) < 1) {
      spring.setPosition(target);
      cancelAnim();
      apply(target);
      return;
    }
    lastActive = el; // 记住目标行：5s 无操作后恢复跟随它
    cancelAnim();
    const params = getLyricSpringPolicy({ isSeeking, intervalMs });
    spring.setTarget(target, params);
    // 弹簧从当前位置起跳（setTarget 会保留当前速度 → 连续切句不顿挫）
    const t0 = performance.now();
    let lastT = t0;
    const step = (now: number): void => {
      const dt = Math.min((now - lastT) / 1000, 0.05); // 钳制大间隔（后台标签页恢复）
      lastT = now;
      const pos = spring.update(dt);
      apply(clamp(pos));
      if (spring.arrived()) {
        raf = null;
        return;
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }

  // ---- 手势接管（借鉴 amll ScrollInteractionEngine）----

  /** 动态绑定/解绑事件（多引擎切换时按 enabled 控制，避免与原生滚动冲突） */
  function bindEvents(): void {
    const el = scrollEl.value;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("touchstart", onTouchStart, { passive: false });
    el.addEventListener("touchmove", onTouchMove, { passive: false });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    el.addEventListener("touchcancel", onTouchCancel, { passive: true });
    el.addEventListener("pointerdown", onInterrupt);
  }

  function unbindEvents(): void {
    const el = scrollEl.value;
    if (!el) return;
    el.removeEventListener("wheel", onWheel);
    el.removeEventListener("touchstart", onTouchStart);
    el.removeEventListener("touchmove", onTouchMove);
    el.removeEventListener("touchend", onTouchEnd);
    el.removeEventListener("touchcancel", onTouchCancel);
    el.removeEventListener("pointerdown", onInterrupt);
  }

  /** 进入交互态：暂停自动恢复跟随，取消进行中的动画/惯性 */
  function startInteraction(): void {
    if (!isInteracting) {
      isInteracting = true;
      clearTimers();
      cancelAnim();
      spring.setPosition(offset); // 冻结弹簧在当前偏移
    }
  }

  /** 交互停止：启动 5s 计时，到期后若还有自动跟随需求则滚回当前行 */
  function endInteraction(): void {
    if (isInteracting) {
      isInteracting = false;
      cancelAnim();
      clearTimers();
      alignTimer = setTimeout(() => {
        alignTimer = null;
        // 自动跟随仍开启 + 有目标行 → 恢复对齐（amll: onAutoAlignResume）
        const active = scrollEl.value?.querySelector(".lyr.active, .kline.active") || lastActive;
        if (active && opts.autoScroll !== false)
          scrollTo(active as HTMLElement, { isSeeking: false });
      }, AUTO_ALIGN_DELAY);
    }
  }

  function onWheel(e: WheelEvent): void {
    e.preventDefault();
    startInteraction();
    const factor = e.deltaMode === 1 ? 50 : 1; // line 模式换算像素
    apply(clamp(offset - e.deltaY * factor));
    clearTimers();
    wheelEndTimer = setTimeout(() => {
      wheelEndTimer = null;
      endInteraction();
    }, WHEEL_END_DELAY);
  }

  function onTouchStart(e: TouchEvent): void {
    startInteraction();
    touching = true;
    touchStartY = e.touches[0].screenY;
    lastTouchY = touchStartY;
    touchStartOffset = offset;
    lastTouchTime = performance.now();
    touchSpeed = 0;
  }

  function onTouchMove(e: TouchEvent): void {
    if (!touching) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches[0].screenY;
    const now = performance.now();
    const dt = Math.max(now - lastTouchTime, 1);
    // 本次移动增量速度：上滑(y 减小) → 正速度（内容上移，与滚轮上滑同向）
    touchSpeed = (lastTouchY - y) / dt;
    lastTouchY = y;
    lastTouchTime = now;
    // 相对起始基准的增量位移（手指拖动多少，内容就跟多少）
    apply(clamp(touchStartOffset - (y - touchStartY)));
  }

  function onTouchEnd(): void {
    if (!touching) return;
    touching = false;
    // 松手惯性：速度衰减滚动（amll 同款 0.95^(dt/16)）
    if (Math.abs(touchSpeed) > 0.05) {
      cancelAnim();
      let last = performance.now();
      const inertia = (now: number): void => {
        const dt = now - last;
        last = now;
        if (dt <= 0 || dt > 100) {
          inertiaRaf = requestAnimationFrame(inertia);
          return;
        }
        apply(clamp(offset - touchSpeed * dt));
        touchSpeed *= INERTIA_DECAY ** (dt / 16);
        if (Math.abs(touchSpeed) > 0.05) {
          inertiaRaf = requestAnimationFrame(inertia);
        } else {
          inertiaRaf = null;
          endInteraction();
        }
      };
      inertiaRaf = requestAnimationFrame(inertia);
    } else {
      endInteraction();
    }
  }

  function onTouchCancel(): void {
    touching = false;
    endInteraction();
  }

  function onInterrupt(): void {
    // 非滚轮/触摸的干扰（点击等）：只取消动画不进入交互态
    cancelAnim();
  }

  /** 视口尺寸变化：重排占位 + 当前句重新停靠 */
  function relayout(): void {
    layoutSpacers();
    const active = scrollEl.value?.querySelector(".lyr.active, .kline.active");
    if (active) apply(clamp(targetFor(active as HTMLElement)));
  }

  onMounted(() => {
    layoutSpacers();
    const el = scrollEl.value;
    if (!el) return;
    if (isEnabled()) bindEvents();
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(relayout);
      ro.observe(el);
    }
    // enabled ref 变化：切换事件绑定（多引擎场景）
    if (enabled) {
      watchEnabled = watch(enabled, (v: boolean) => {
        if (v) {
          layoutSpacers();
          bindEvents();
        } else {
          cancelAnim();
          clearTimers();
          unbindEvents();
          // 切回原生滚动：释放 transform，让 scrollTop 生效
          if (trackEl.value) trackEl.value.style.transform = "";
        }
      });
    }
  });

  onBeforeUnmount(() => {
    cancelAnim();
    clearTimers();
    watchEnabled?.();
    ro?.disconnect();
    unbindEvents();
  });

  return { scrollTo, relayout, cancel: cancelAnim };
}
