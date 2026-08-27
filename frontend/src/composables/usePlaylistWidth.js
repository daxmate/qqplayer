// 列表面板宽度（桌面）：拖拽调整 + localStorage 记忆（Bug 3+4）
//
// 尺寸模型：
//   宽度通过 CSS 变量 --pl-w 作用到 .main 的 grid-template-columns（App.vue 默认回退 340px）。
//   本模块在 documentElement 上设置/更新 --pl-w（:root 级变量对 grid 生效，无需逐组件传参）。
//   持久化：localStorage 新 key qqplayer.playlistWidth.v1（前端本地即可，不进后端白名单——
//   参照 coverSize 的「仅前端本地持久化」模式，跨设备不同步）。
//
// 拖拽：手柄 pointerdown → 窗口级 pointermove/pointerup；拖动中实时更新 --pl-w（clamp 240~560），
//   松手（pointerup）才写入 localStorage。仅桌面端（isMobile 时禁用；移动布局不引用 --pl-w，零影响）。
import { ref } from "vue";
import { isMobile } from "./useMobileViewport.js";

export const PL_W_MIN = 240; // 拖拽范围下限（px）
export const PL_W_MAX = 560; // 拖拽范围上限（px）
export const PL_W_DEFAULT = 340; // CSS 默认宽度（与 App.vue var(--pl-w, 340px) 一致）
const LS_KEY = "qqplayer.playlistWidth.v1";

// 拖拽中（手柄高亮）
export const dragging = ref(false);

let dragStartX = 0;
let dragStartW = 0;

// 启动恢复：localStorage 有合法记录 → 立即应用
if (typeof window !== "undefined") {
  try {
    const v = Number(window.localStorage.getItem(LS_KEY));
    if (Number.isFinite(v) && v >= PL_W_MIN && v <= PL_W_MAX) {
      applyPlW(Math.round(v));
    }
  } catch {
    /* localStorage 不可用（隐私模式等）忽略，用 CSS 默认宽度 */
  }
}

function applyPlW(px) {
  const w = Math.round(Math.max(PL_W_MIN, Math.min(px, PL_W_MAX)));
  if (typeof document !== "undefined") {
    document.documentElement.style.setProperty("--pl-w", `${w}px`);
  }
  return w;
}

function currentPlW() {
  const v = Number.parseFloat(
    typeof document !== "undefined"
      ? document.documentElement.style.getPropertyValue("--pl-w")
      : "",
  );
  return Number.isFinite(v) ? v : PL_W_DEFAULT;
}

function onPointerMove(e) {
  // 向右拖 = 面板变宽
  applyPlW(dragStartW + (e.clientX - dragStartX));
}

function endDrag() {
  dragging.value = false;
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", endDrag);
  window.removeEventListener("pointercancel", endDrag);
  if (typeof document !== "undefined") {
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
  // 松手才持久化：把当前生效宽度写入 localStorage
  try {
    window.localStorage.setItem(LS_KEY, String(Math.round(currentPlW())));
  } catch {
    /* 忽略 */
  }
}

export function startPlWidthDrag(e) {
  if (isMobile.value || dragging.value) return;
  dragging.value = true;
  dragStartX = e.clientX;
  dragStartW = currentPlW(); // 从当前生效宽度起步（已持久化值或 CSS 默认）
  applyPlW(dragStartW);
  e.preventDefault();
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  if (typeof document !== "undefined") {
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }
}
