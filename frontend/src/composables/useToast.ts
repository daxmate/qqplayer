// 全局 toast 单例（跨组件共享，堆叠渲染）
// 用法：showToast("已删除", { type: "success", duration: 3200, action: { label: "撤销", onClick } })
//      toastError("出错了")
// ToastContainer.vue 挂载在 body 级容器（main.js），读取同一份 items 状态
import { reactive } from "vue";

const DEFAULT_DURATION = 3200;

/** toast action 按钮（{ label, onClick }；点击即执行 onClick 并移除该条） */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

/** toast 类型：成功 / 错误 */
export type ToastType = "success" | "error";

/** 单例状态条目：items = [{ id, type, text, action, duration }]（_timer 为内部自动消失定时器句柄） */
export interface ToastItem {
  id: number;
  type: ToastType;
  text: string;
  action: ToastAction | null;
  duration: number;
  _timer: ReturnType<typeof setTimeout>;
}

/** showToast/toastError 的 opts 参数 */
export interface ToastOptions {
  type?: ToastType;
  action?: ToastAction | null;
  duration?: number;
}

// 单例状态：items = [{ id, type: 'success'|'error', text, action: {label, onClick}|null, duration }]
const items = reactive<ToastItem[]>([]);

let nextId = 1;

function dismiss(id: number) {
  const idx = items.findIndex((i) => i.id === id);
  if (idx < 0) return;
  const [item] = items.splice(idx, 1);
  clearTimeout(item._timer);
}

export function showToast(text: string, opts: ToastOptions = {}): number {
  const { type = "success", action = null, duration = DEFAULT_DURATION } = opts;
  const id = nextId++;
  const item = reactive<ToastItem>({
    id,
    type,
    text,
    action,
    duration,
    _timer: setTimeout(() => dismiss(id), duration),
  });
  items.push(item);
  return id;
}

export function toastError(text: string, opts: ToastOptions = {}): number {
  return showToast(text, { type: "error", ...opts });
}

export function dismissToast(id: number): void {
  dismiss(id);
}

// action 按钮点击：先执行 onClick 再移除该条（点击即视为已处理，不再等 duration）
export function handleToastAction(id: number): void {
  const item = items.find((i) => i.id === id);
  if (!item) return;
  const onClick = item.action?.onClick;
  dismiss(id);
  onClick?.();
}

// 清理全部（测试用）
export function clearToasts(): void {
  items.forEach((i) => clearTimeout(i._timer));
  items.splice(0);
}

export function useToast() {
  return { items, showToast, toastError, dismissToast, handleToastAction, clearToasts };
}
