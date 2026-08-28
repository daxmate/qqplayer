// 封面/歌词区尺寸管理（任务 E：自适应保底 + 桌面拖拽调整 + 记忆 + 恢复默认）
//
// 尺寸模型：
//   uiSettings.coverSize —— 0 = 自适应（默认公式）；140~420 = 手动固定值（拖拽分隔条 / 设置滑块写入）
//   持久化：复用 uiSettings 现有通道（settingsSync deep watch → 写透 localStorage + 防抖 PUT）。
//   后端 settings 白名单未收录该字段：PUT 被 _norm_namespace 丢弃、GET 不返回，
//   applyNamespace 只应用「k in saved」→ 覆盖不到 → 仅前端本地生效（与 ambientEnabled 同款策略，跨设备不同步）。
//
// 自适应公式（默认）：cover = clamp( min(46vh, 340, centerH − 220 − 12), 140, … )
//   - 46vh / 340px：原有上限（大屏不超原尺寸）
//   - centerH − 220 − 12：保底歌词区 ≥220px（12 = .center 列 gap，与 App.vue 样式一致）
//   - 下限 140：与拖拽范围下限一致，封面保持可见（极端矮窗下歌词保底无法同时满足，封面优先）
//
// 手动模式硬保护：歌词区 ≥160px → 有效值 ≤ centerH − 160 − 12（窗口变矮后自动 clamp 生效值，存储值不动）
//
// 拖拽：分隔条 pointerdown → 窗口级 pointermove/pointerup；拖动中 dragSize 实时生效（封面跟随），
// 松手（pointerup）才提交 uiSettings.coverSize → settingsSync watch 持久化。
import { ref, computed } from "vue";
import { uiSettings } from "./useSettings.js";
import { coverVisible } from "./useCoverGuard.ts";

export const COVER_MIN = 140; // 拖拽/滑块范围下限（px）
export const COVER_MAX = 420; // 拖拽/滑块范围上限（px）
export const COVER_DEFAULT = 340; // 自适应默认等价尺寸（未测量首帧降级 / 设置滑块锚点）
export const LYRIC_MIN_ADAPTIVE = 220; // 自适应保底歌词高度（px）
export const LYRIC_MIN_HARD = 160; // 手动模式歌词硬保护（px，拖不没）
export const CENTER_GAP = 12; // .center 列 gap（px，与 App.vue 样式保持同步）

// 测量值：center 容器高度（ResizeObserver）+ 视口高度（window resize）
export const centerH = ref<number>(0);
export const vh = ref<number>(0);

// 手动模式（有记忆固定值）？
export const isManual = computed<boolean>(() => uiSettings.coverSize > 0);

// 自适应尺寸：保底歌词 ≥220px；未测量（首帧/测试/无布局）→ 340 兜底 ≈ CSS 默认 min(46vh,340px)
export const adaptiveSize = computed<number>(() => {
  if (vh.value <= 0 || centerH.value <= 0) return COVER_DEFAULT;
  const cap = Math.min(vh.value * 0.46, COVER_DEFAULT);
  const lyricCap = centerH.value - LYRIC_MIN_ADAPTIVE - CENTER_GAP;
  return Math.max(COVER_MIN, Math.min(cap, lyricCap));
});

// 手动模式硬保护上限：歌词区 ≥160px（centerH 未测量时不限制，首帧 CSS 兜底）
const manualCap = computed<number>(() => {
  if (centerH.value <= 0) return COVER_MAX;
  return Math.max(COVER_MIN, Math.min(COVER_MAX, centerH.value - LYRIC_MIN_HARD - CENTER_GAP));
});

// ---------- 拖拽状态 ----------
export const dragging = ref<boolean>(false);
export const dragSize = ref<number | null>(null); // 拖拽中实时尺寸（null = 非拖拽）
let dragStartY = 0;
let dragStartSize = 0;

function onPointerMove(e: PointerEvent): void {
  const delta = dragStartY - e.clientY; // 向上拖 = 封面变大
  dragSize.value = Math.round(
    Math.max(COVER_MIN, Math.min(dragStartSize + delta, manualCap.value)),
  );
}

function endDrag(): void {
  // 松手才提交：dragSize 落进 uiSettings → settingsSync watch 写透 localStorage + 防抖 PUT
  if (dragSize.value != null) uiSettings.coverSize = dragSize.value;
  dragSize.value = null;
  dragging.value = false;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
  if (typeof document !== "undefined") {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
}

export function startCoverDrag(e: { clientY: number; preventDefault: () => void }): void {
  if (!coverVisible("large") || dragging.value) return;
  dragging.value = true;
  dragStartY = e.clientY;
  dragStartSize = coverSizePx.value; // 从当前有效尺寸起步（自适应值或已 clamp 的手动值）
  dragSize.value = dragStartSize;
  e.preventDefault();
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  if (typeof document !== "undefined") {
    document.body.style.cursor = "ns-resize";
    document.body.style.userSelect = "none";
  }
}

// 渲染用有效封面尺寸（px）：拖拽中实时值 > 手动固定（含硬保护 clamp）> 自适应
export const coverSizePx = computed<number>(() => {
  if (dragging.value && dragSize.value != null) return dragSize.value;
  if (isManual.value) {
    return Math.max(COVER_MIN, Math.min(uiSettings.coverSize, manualCap.value));
  }
  return adaptiveSize.value;
});

// 恢复默认：清记忆值 → 回自适应模式
export function resetCoverSize(): void {
  uiSettings.coverSize = 0;
}

// 测量挂载：RO 量 center 高度 + resize 量视口；返回卸载函数
export function observeCoverArea(el: HTMLElement | null): () => void {
  if (!el || typeof window === "undefined") return () => {};
  vh.value = window.innerHeight;
  const updateVh = () => {
    vh.value = window.innerHeight;
  };
  window.addEventListener("resize", updateVh);
  let ro: ResizeObserver | null = null;
  const measure = () => {
    centerH.value = el.clientHeight;
  };
  measure();
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(measure);
    ro.observe(el);
  }
  return () => {
    window.removeEventListener("resize", updateVh);
    ro?.disconnect();
  };
}
