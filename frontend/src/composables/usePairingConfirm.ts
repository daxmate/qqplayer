// 壳内配对确认（usePairingConfirm）
// 桌面壳（macOS Swift / Windows Tauri / 浏览器开发环境）轮询后端待确认配对请求，
// 发现新请求 → 弹确认框（PairingConfirmModal）；iOS 壳是发起方，不启用。
//
// 后端 API（白名单免鉴权，见 backend/app/routers/pairing.py）：
//   GET  /api/pairing/pending → {requests: [{request_id, device_name, device_type, created_at}]}
//   POST /api/pairing/request/{id}/approve
//   POST /api/pairing/request/{id}/reject
//
// 多请求策略：队列逐个弹——一次只确认一台设备（弹窗信息聚焦，用户逐个决策），
// 当前请求处理完（approve/reject/404 过期）后再弹下一台。
import { ref, onBeforeUnmount, type Ref } from "vue";
import { apiGet, apiPost } from "../utils/apiClient.js";
import { showToast, toastError } from "./useToast.js";
import i18n from "../locales/i18n.js";

const POLL_INTERVAL = 2000;

/** 后端待确认配对请求（/api/pairing/pending 条目） */
interface PairingRequest {
  request_id: string;
  device_name?: string;
  device_type?: string;
  created_at?: string;
}

/** apiClient 归一化返回（js 模块无类型；只取本模块用到的字段，raw 模式可能无 data） */
interface ApiResult {
  ok: boolean;
  status: number;
  data?: unknown;
}

/** usePairingConfirm() 返回值 */
interface PairingConfirmApi {
  visible: Ref<boolean>;
  current: Ref<PairingRequest | null>;
  busy: Ref<boolean>;
  approve: () => Promise<boolean>;
  reject: () => Promise<boolean>;
  enabled: boolean;
}

// 运行态（模块级单例；App.vue 挂载一次）
const visible = ref(false); // 确认框是否展示
const current = ref<PairingRequest | null>(null); // 当前待确认请求 {request_id, device_name, device_type, created_at}
const busy = ref(false); // approve/reject 请求中（防重复提交）

// 非响应式内部态
const queue: PairingRequest[] = []; // 待确认队列（逐个弹）
const seenIds = new Set<string>(); // 已见过（含已处理）的 request_id，防止重复弹
let timer: ReturnType<typeof setInterval> | null = null; // 轮询定时器

/**
 * 桌面壳判断：非 iOS 壳（无 window.qqplayerIosBridge）启用轮询。
 * 覆盖：macOS/Windows 壳（无该桥）+ 浏览器开发环境（方便联调，无桥也启用）。
 * iOS 壳（qqplayerIosBridge 存在）不启用——iOS 是发起方，不需要确认自己的请求。
 */
export function isPairingEnabled(): boolean {
  try {
    return typeof window === "undefined" || !window.qqplayerIosBridge;
  } catch {
    return true;
  }
}

/** 单次轮询：拉 pending → 新请求入队 → 空闲时弹下一个 */
export async function _pollOnce(): Promise<void> {
  const r: ApiResult = await apiGet("/api/pairing/pending");
  if (!r.ok || !r.data) return; // 失败不崩，下轮再试
  const body = r.data as { requests?: PairingRequest[] } | null;
  const list = Array.isArray(body?.requests) ? body.requests : [];
  for (const req of list) {
    const id = req && req.request_id;
    if (id && !seenIds.has(id)) {
      seenIds.add(id);
      queue.push(req);
    }
  }
  showNextIfIdle();
}

function showNextIfIdle(): void {
  if (visible.value || busy.value) return;
  const next = queue.shift();
  if (next) {
    current.value = next;
    visible.value = true;
  }
}

function closeCurrent(): void {
  visible.value = false;
  current.value = null;
  showNextIfIdle();
}

async function handleAction(approve: boolean): Promise<boolean> {
  if (!current.value || busy.value) return false;
  const req = current.value;
  busy.value = true;
  const action = approve ? "approve" : "reject";
  const r: ApiResult = await apiPost(
    `/api/pairing/request/${encodeURIComponent(req.request_id)}/${action}`,
  );
  busy.value = false;
  if (r.ok) {
    closeCurrent();
    showToast(i18n.global.t(approve ? "pairing.approved" : "pairing.rejected"));
    return true;
  }
  // 请求已过期/已被处理（404；approve 才有，reject 幂等恒 200）：关弹窗，下轮不会再出现
  if (r.status === 404) {
    closeCurrent();
  }
  toastError(i18n.global.t("pairing.actionFailed"));
  return false;
}

/** 批准当前请求 */
export function approvePairing(): Promise<boolean> {
  return handleAction(true);
}

/** 拒绝当前请求 */
export function rejectPairing(): Promise<boolean> {
  return handleAction(false);
}

/** 开始轮询（幂等；iOS 壳不启用） */
export function startPolling(): void {
  if (timer !== null || !isPairingEnabled()) return;
  timer = setInterval(_pollOnce, POLL_INTERVAL);
  _pollOnce(); // 立即查一次，不等第一个间隔
}

/** 停止轮询（组件卸载 / 测试复位用） */
export function stopPolling(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * 组件挂载钩子（App.vue setup 中调用一次）：
 * 返回响应式状态与操作；组件卸载时自动清理轮询定时器（onBeforeUnmount）。
 */
export function usePairingConfirm(): PairingConfirmApi {
  startPolling();
  onBeforeUnmount(stopPolling);
  return {
    visible,
    current,
    busy,
    approve: approvePairing,
    reject: rejectPairing,
    enabled: isPairingEnabled(),
  };
}

/** 测试用：读取当前 UI 态快照 */
export function _pairingUiState(): {
  visible: boolean;
  current: PairingRequest | null;
  busy: boolean;
} {
  return { visible: visible.value, current: current.value, busy: busy.value };
}

/** 测试用：复位模块状态（停轮询 + 清队列/已见集合/UI 态） */
export function _resetPairingConfirm(): void {
  stopPolling();
  visible.value = false;
  current.value = null;
  busy.value = false;
  queue.length = 0;
  seenIds.clear();
}
