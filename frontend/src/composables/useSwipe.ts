// 移动端手势工具（任务 I）
//   1) useEdgeSwipe —— 屏幕左缘右滑返回（iOS 式边缘滑动，供 MobileShell 页面栈用）
//   2) useSwipeReveal —— 列表行左滑露出操作区（swipe-reveal，供 MobileList/MobileSmartList 用）
// 共同要点：
//   - 只监听 touch 事件（移动端），jsdom 测试里用原生 Event + 手写 touches 模拟
//   - preventDefault 只在手势判定为「横向」后执行（e.cancelable 守卫 + passive: false 挂载），
//     未判定前让位纵向滚动，避免抢列表滚动
import { reactive, ref, onMounted, onBeforeUnmount, type Ref } from "vue";

// ============ 横向跟手手势（通用：封面切歌 / 歌词进入全歌词 / 全歌词右划返回） ============
// 与 useEdgeSwipe 的分工：edge = 屏幕左缘专属（iOS 式页面返回）；本手势 = 任意起点横向拖动。
// 要点：
//   - 方向锁定：约 lockDx px 横向主导后才接管（未锁定前让位纵向滚动/下拉）；
//     direction 只允许单方向时，反向手势直接放弃（不跟手、不触发）。
//   - 触发判定 = 位移过阈值 且（释放速度快 或 慢速拖够大位移兜底）——与 edge 同一口径。
//   - 触发后不自动归零：位移留给 onTrigger 做滑出/切歌/滑入编排，最后调 reset()；
//     未触发自动归零（CSS transition 回弹）。
//   - 监听生命周期由调用方控制：bind(el)/unbind()（元素可能随 v-if 出现）；
//     封面与纵向下拉仲裁组合时，组件在自己的统一手势机里直接调 handleStart/Move/End，不 bind。
export const SWIPE_LOCK_DX = 10; // 方向锁定阈值（px）：超过且横向主导才锁定
// 触发判定常量（与 useEdgeSwipe 口径一致）
export const SWIPE_THRESHOLD = 80; // 触发位移阈值（px）
export const SWIPE_MIN_VELOCITY = 0.25; // 最低释放速度（px/ms）
export const SWIPE_BIG_RATIO = 0.4; // 慢速大位移兜底：拖过 屏宽*比例 直接触发（不要求速度）

/** 横向手势允许方向 */
export type SwipeDirection = "left" | "right";

/** useHorizontalSwipe 选项（全可选，默认值见函数内解构） */
export interface HorizontalSwipeOptions {
  enabled?: () => boolean;
  direction?: "both" | SwipeDirection; // 'both' | 'left' | 'right'：允许的滑动方向
  threshold?: number; // 触发位移阈值（px）
  minVelocity?: number; // 最低释放速度（px/ms）
  bigRatio?: number; // 慢速大位移兜底：拖过 屏宽*比例 直接触发（不要求速度）
  lockDx?: number; // 方向锁定阈值（px）
  maxShiftRatio?: number; // 跟手最大位移 = 屏宽 * 比例（两侧同限）
  excludeEdgeZone?: boolean; // 左缘起点不横向接管（让位 useEdgeSwipe 页面返回，封面用）
  onTrigger?: (dir: SwipeDirection) => void; // 触发时调用
}

/** 横向手势内部状态 */
interface HorizontalGesture {
  startX: number;
  startY: number;
  lastDx: number;
  lastT: number;
  lastV: number;
  locked: boolean;
  dir: SwipeDirection | null;
}

export function useHorizontalSwipe(opts: HorizontalSwipeOptions = {}) {
  const {
    enabled = () => true,
    direction = "both", // 'both' | 'left' | 'right'：允许的滑动方向
    threshold = SWIPE_THRESHOLD,
    minVelocity = SWIPE_MIN_VELOCITY,
    bigRatio = SWIPE_BIG_RATIO,
    lockDx = SWIPE_LOCK_DX,
    maxShiftRatio = 0.6, // 跟手最大位移 = 屏宽 * 比例（两侧同限）
    excludeEdgeZone = false, // 左缘起点不横向接管（让位 useEdgeSwipe 页面返回，封面用）
    onTrigger = () => {}, // (dir: 'left'|'right') => void，触发时调用
  } = opts;

  const shift = ref(0); // 跟手位移（px，带符号：负=左）
  const dragging = ref(false); // 跟手中（true 时组件应关闭 transform transition）
  let gesture: HorizontalGesture | null = null; // 当前手势状态（无手势 = null）
  let el: HTMLElement | null = null; // 当前绑定的元素

  function setShift(v: number) {
    shift.value = v;
  }

  function reset() {
    shift.value = 0;
  }

  function handleStart(e: TouchEvent) {
    if (!enabled()) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    gesture = {
      startX: t.clientX,
      startY: t.clientY,
      lastDx: 0,
      lastT: Date.now(),
      lastV: 0,
      locked: false,
      dir: null,
    };
  }

  function handleMove(e: TouchEvent) {
    const g = gesture;
    if (!g) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = t.clientX - g.startX;
    const dy = t.clientY - g.startY;
    if (!g.locked) {
      // 未过锁定线 / 纵向主导 → 让位滚动；横向意图明确（且起点不在左缘返回区）才锁定接管
      if (Math.abs(dx) > lockDx && Math.abs(dx) > Math.abs(dy)) {
        if (excludeEdgeZone && g.startX < EDGE_ZONE) return; // 左缘让位 useEdgeSwipe
        const dir: SwipeDirection = dx < 0 ? "left" : "right";
        if (direction === "both" || direction === dir) {
          g.locked = true;
          g.dir = dir;
        } else {
          gesture = null; // 方向不符：放弃本次手势（不跟手、不触发）
          return;
        }
      } else {
        return;
      }
    }
    if (e.cancelable) e.preventDefault(); // 锁定后禁止浏览器横向手势/滚动
    const now = Date.now();
    const segV = (dx - g.lastDx) / Math.max(1, now - g.lastT);
    g.lastDx = dx;
    g.lastT = now;
    if (segV !== 0) g.lastV = segV; // 带符号速度（回拉不计入本次段速）
    const maxShift = window.innerWidth * maxShiftRatio;
    shift.value = Math.max(-maxShift, Math.min(maxShift, dx));
    dragging.value = true;
  }

  function handleEnd() {
    const g = gesture;
    gesture = null;
    if (!g) return;
    dragging.value = false;
    const bigDrag = Math.abs(g.lastDx) >= window.innerWidth * bigRatio;
    const triggered =
      g.locked && Math.abs(g.lastDx) >= threshold && (Math.abs(g.lastV) >= minVelocity || bigDrag);
    if (triggered) {
      onTrigger(g.dir!); // 触发时必已锁定，dir 已赋值
      return; // 位移留给 onTrigger 编排（滑出），编排结束调 reset()
    }
    reset(); // 未触发：回弹（CSS transition 动画）
  }

  function handleCancel() {
    if (!gesture) return;
    gesture = null;
    dragging.value = false;
    reset();
  }

  function bind(target: HTMLElement | null) {
    unbind();
    el = target;
    if (!el) return;
    el.addEventListener("touchstart", handleStart, { passive: true });
    el.addEventListener("touchmove", handleMove, { passive: false });
    el.addEventListener("touchend", handleEnd);
    el.addEventListener("touchcancel", handleCancel);
  }

  function unbind() {
    if (!el) return;
    el.removeEventListener("touchstart", handleStart);
    el.removeEventListener("touchmove", handleMove);
    el.removeEventListener("touchend", handleEnd);
    el.removeEventListener("touchcancel", handleCancel);
    el = null;
  }

  return {
    shift,
    dragging,
    handleStart,
    handleMove,
    handleEnd,
    handleCancel,
    bind,
    unbind,
    setShift,
    reset,
  };
}

// ============ 边缘滑动返回 ============
export const EDGE_ZONE = 24; // 左缘判定区（px）：touchstart 必须落在此区间内
export const EDGE_THRESHOLD = 80; // 触发返回的最小位移（px）
export const EDGE_MAX_RATIO = 0.8; // 跟手最大位移 = 屏宽 * 比例
export const EDGE_BIG_RATIO = 0.4; // 慢速大位移兜底：拖过 屏宽*比例 直接触发（不要求速度）
export const EDGE_MIN_VELOCITY = 0.25; // 最低释放速度（px/ms）：位移够但拖得慢不触发
const EDGE_LOCK_DX = 12; // 判定为横向手势的最小 dx（避免抢纵向滚动）

/** useEdgeSwipe 选项（全可选，默认值见函数内解构） */
export interface EdgeSwipeOptions {
  enabled?: () => boolean;
  onTrigger?: () => void;
}

/** 边缘手势内部状态 */
interface EdgeGesture {
  startX: number;
  startY: number;
  startT: number;
  lastT: number;
  lastDx: number;
  lastV: number;
  locked: boolean;
}

export function useEdgeSwipe(
  elRef: Ref<HTMLElement | null>,
  { enabled = () => true, onTrigger = () => {} }: EdgeSwipeOptions = {},
) {
  // 对外状态：shift（px 位移）/ progress（阴影强度 0..1）/ dragging（跟手中）
  const state = reactive({ shift: 0, progress: 0, dragging: false });
  let gesture: EdgeGesture | null = null; // 当前手势状态（无手势 = null）

  function apply() {
    const el = elRef.value;
    if (!el) return;
    el.style.setProperty("--edge-shift", `${state.shift}px`);
    el.style.setProperty("--edge-progress", String(state.progress));
  }

  function handleStart(e: TouchEvent) {
    if (!enabled()) return;
    const t = e.touches && e.touches[0];
    if (!t || t.clientX > EDGE_ZONE) return; // 只响应左缘起点
    gesture = {
      startX: t.clientX,
      startY: t.clientY,
      startT: Date.now(),
      lastT: Date.now(),
      lastDx: 0,
      lastV: 0,
      locked: false,
    };
  }

  function handleMove(e: TouchEvent) {
    if (!gesture) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = t.clientX - gesture.startX;
    const dy = t.clientY - gesture.startY;
    if (!gesture.locked) {
      // 未明显右滑前让位纵向滚动；一旦横向意图明确则锁定手势并接管
      if (dx > EDGE_LOCK_DX && dx > Math.abs(dy)) gesture.locked = true;
      else return;
    }
    if (e.cancelable) e.preventDefault(); // 锁定后禁止页面滚动（iOS Safari：非 passive 监听）
    const now = Date.now();
    const segV = (dx - gesture.lastDx) / Math.max(1, now - gesture.lastT);
    gesture.lastDx = Math.max(0, dx);
    gesture.lastT = now;
    if (segV >= 0) gesture.lastV = segV; // 只保留正向速度（回拉不计）
    const maxShift = window.innerWidth * EDGE_MAX_RATIO;
    state.shift = Math.min(gesture.lastDx, maxShift);
    state.progress = Math.min(1, state.shift / (window.innerWidth * EDGE_BIG_RATIO));
    state.dragging = true;
    apply();
  }

  function handleEnd() {
    if (!gesture) return;
    const g = gesture;
    gesture = null;
    state.dragging = false;
    const bigDrag = g.lastDx >= window.innerWidth * EDGE_BIG_RATIO;
    const shouldPop =
      g.locked && g.lastDx >= EDGE_THRESHOLD && (g.lastV >= EDGE_MIN_VELOCITY || bigDrag);
    state.shift = 0;
    state.progress = 0;
    apply(); // 回弹走 CSS transition；触发返回则由 onTrigger 出栈
    if (shouldPop) onTrigger();
  }

  onMounted(() => {
    const el = elRef.value;
    if (!el) return;
    el.addEventListener("touchstart", handleStart, { passive: true });
    el.addEventListener("touchmove", handleMove, { passive: false });
    el.addEventListener("touchend", handleEnd);
    el.addEventListener("touchcancel", handleEnd);
  });
  onBeforeUnmount(() => {
    const el = elRef.value;
    if (!el) return;
    el.removeEventListener("touchstart", handleStart);
    el.removeEventListener("touchmove", handleMove);
    el.removeEventListener("touchend", handleEnd);
    el.removeEventListener("touchcancel", handleEnd);
  });

  return state;
}

// ============ 列表左滑操作（swipe-reveal） ============
export const REVEAL_WIDTH = 168; // 操作区宽度（px）
const REVEAL_LOCK_DX = 20; // 横向判定阈值（px）：点击抖动容差（原 12 太小，真机点击误判左滑）
const REVEAL_LOCK_VELOCITY = 0.35; // 锁定最小速度（px/ms）：慢速小位移视为点击不锁定
const REVEAL_LOCK_FAR = 60; // 大位移慢速也算滑动（用户明显拖拽）
const REVEAL_OPEN_RATIO = 0.5; // 位移超过操作区一半 → 展开
const REVEAL_TAP_SLOP = 6; // 小于该位移视为点击（不抑制 tap）

/** useSwipeReveal 选项（全可选，默认值见函数内解构） */
export interface SwipeRevealOptions {
  rowSelector?: string; // 行选择器（事件委托定位行元素）
  actionWidth?: number; // 操作区宽度（px）
}

/** 行拖动内部状态 */
interface RevealDrag {
  startX: number;
  startY: number;
  lastX: number;
  startT: number;
  base: number;
  locked: boolean;
}

export function useSwipeReveal(
  containerRef: Ref<HTMLElement | null>,
  { rowSelector = ".ml-item", actionWidth = REVEAL_WIDTH }: SwipeRevealOptions = {},
) {
  const openPath = ref<string | null>(null); // 当前展开的行（同一时间只展开一行）
  const drags = reactive(new Map<string, RevealDrag>()); // path -> 拖动状态
  let activePath: string | null = null; // 正在拖动的行 path（touchend 的 target 可能已滑出行，不能靠它定位）
  let swipedPath: string | null = null; // 最近真实滑动过的行：抑制其后的 click（防误触播放）

  function isOpen(path: string) {
    return openPath.value === path;
  }

  function isDragging(path: string) {
    const d = drags.get(path);
    return !!d && d.locked;
  }

  function close() {
    openPath.value = null;
  }

  // 行当前位移（px，>0 表示向左露出操作区；0 = 收起）
  function rowShift(path: string) {
    const d = drags.get(path);
    if (d) return d.base + (d.startX - d.lastX);
    return isOpen(path) ? actionWidth : 0;
  }

  function rowTransform(path: string) {
    const s = rowShift(path);
    return s > 0 ? `translateX(${-Math.min(s, actionWidth)}px)` : "";
  }

  // 消费「滑动后伴随的 click」标记；返回 true 表示本次点击应忽略
  function consumeSwipe(path: string) {
    if (swipedPath === path) {
      swipedPath = null;
      return true;
    }
    return false;
  }

  function rowElFrom(e: TouchEvent): HTMLElement | null {
    const target = e.target as HTMLElement | null;
    return target && target.closest ? (target.closest(rowSelector) as HTMLElement | null) : null;
  }

  function handleStart(e: TouchEvent) {
    const rowEl = rowElFrom(e);
    const path = rowEl && rowEl.dataset.path;
    if (!path) {
      if (openPath.value) openPath.value = null; // 点空白 → 收起
      return;
    }
    if ((e.target as HTMLElement).closest(".ml-drag")) return; // 歌单拖拽手柄交给 Sortable
    const t = e.touches && e.touches[0];
    if (!t) return;
    const wasOpen = openPath.value === path;
    if (openPath.value && openPath.value !== path) openPath.value = null; // 切行收起上一行
    activePath = path;
    drags.set(path, {
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      startT: Date.now(),
      base: wasOpen ? actionWidth : 0,
      locked: false,
    });
  }

  function handleMove(e: TouchEvent) {
    const d = activePath && drags.get(activePath);
    if (!d) return;
    const t = e.touches && e.touches[0];
    if (!t) return;
    const dx = d.startX - t.clientX; // 左滑为正
    const dy = t.clientY - d.startY;
    if (!d.locked) {
      // 横向主导 + 位移够 +（快速滑动 或 大位移慢拖）才算左滑手势；
      // 点击的慢速微小抖动（<20px 或 <0.35px/ms）不锁定 → 行不动、无闪现、点击正常
      const dxAbs = Math.abs(dx);
      const elapsed = Math.max(1, Date.now() - (d.startT ?? Date.now()));
      const fast = dxAbs / elapsed >= REVEAL_LOCK_VELOCITY;
      const far = dxAbs > REVEAL_LOCK_FAR;
      if (dxAbs > REVEAL_LOCK_DX && dxAbs > Math.abs(dy) && (fast || far)) d.locked = true;
      else return; // 纵向意图 / 点击抖动：让位列表滚动或保持原位
    }
    if (e.cancelable) e.preventDefault();
    d.lastX = t.clientX;
  }

  function handleEnd(e: TouchEvent) {
    const path = activePath;
    activePath = null;
    const d = path && drags.get(path);
    if (!d) return;
    const t = e.changedTouches && e.changedTouches[0];
    const raw = d.base + (d.startX - (t ? t.clientX : d.lastX));
    drags.delete(path);
    if (d.locked && Math.abs(raw - d.base) > REVEAL_TAP_SLOP) swipedPath = path; // 真滑过 → 抑制点击
    if (raw >= actionWidth * REVEAL_OPEN_RATIO) openPath.value = path;
    else if (openPath.value === path) openPath.value = null; // 右滑/回弹收起
  }

  onMounted(() => {
    const el = containerRef.value;
    if (!el) return;
    el.addEventListener("touchstart", handleStart, { passive: true });
    el.addEventListener("touchmove", handleMove, { passive: false });
    el.addEventListener("touchend", handleEnd);
    el.addEventListener("touchcancel", handleEnd);
  });
  onBeforeUnmount(() => {
    const el = containerRef.value;
    if (!el) return;
    el.removeEventListener("touchstart", handleStart);
    el.removeEventListener("touchmove", handleMove);
    el.removeEventListener("touchend", handleEnd);
    el.removeEventListener("touchcancel", handleEnd);
  });

  return { openPath, isOpen, isDragging, close, rowTransform, consumeSwipe };
}
