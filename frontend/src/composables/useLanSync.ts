// 局域网同步（S2 · web Host 侧）状态装配：/api/lansync/* 封装 + 事件游标轮询
//
// 后端契约：`backend/app/routers/lansync.py`（冻结接口见 docs/lan-sync-web-host-plan.md §3）。
// 分工：网络/轮询逻辑全部集中在本文件（纯 TS，可独立单测），面板组件只做渲染与交互。
//
// 轮询用**事件游标**而不是反复拉全量列表：`GET /api/lansync/events?cursor=N` 返回
// `seq > N` 的新事件；只有真正出现了新事件（pair_request / pair_result / device / session）
// 才重拉 pending + devices，空转时每轮只有一次极小的 GET。
import { ref, type Ref } from "vue";
import { apiGet, apiPost, apiDelete } from "../utils/apiClient.js";

/** 事件轮询间隔（ms）：批准卡与设备在线状态的刷新时延 */
export const POLL_INTERVAL_MS = 1000;

/** 事件订阅者（模块级事件总线：内容同步的异步回执——如拉取清单 preview——也走这里） */
type LanSyncEventHandler = (events: unknown[]) => void;

const eventHandlers = new Set<LanSyncEventHandler>();

/**
 * 订阅 lansync 事件（返回退订函数）。
 *
 * 本文件是**唯一**轮询 `/api/lansync/events` 的地方（游标单点推进），其它模块
 * （拉取清单、运行进度）通过这里拿事件，不再各起一套轮询——多个轮询各自推进游标
 * 会互相漏事件。订阅者在组件卸载时必须退订。
 */
export function onLanSyncEvents(handler: LanSyncEventHandler): () => void {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
}

/** 分发一批事件到订阅者（单个订阅者异常不影响其它订阅者 / 轮询本身） */
function dispatchEvents(events: unknown[]): void {
  if (!events.length) return;
  for (const handler of [...eventHandlers]) {
    try {
      handler(events);
    } catch {
      /* 订阅者自身异常不上抛 */
    }
  }
}

/** 服务状态（GET /api/lansync/status；不可用时 available=false + error） */
export interface LanSyncStatus {
  available: boolean;
  running: boolean;
  port: number;
  device_name: string | null;
  protocol_version: number;
  error: string | null;
}

/** 本机身份（GET /api/lansync/identity） */
export interface LanSyncIdentity {
  device_id: string;
  device_id_formatted: string;
  device_id_groups?: string[];
  short_parts?: string[];
  public_key: string;
}

/** 待批准配对请求（GET /api/lansync/pairing/pending → requests[]） */
export interface LanSyncPairRequest {
  request_id: string;
  device_id: string;
  device_id_formatted?: string;
  display_name?: string;
  suggested_display_name?: string;
  received_at?: number;
}

/** 已配对设备（GET /api/lansync/devices → devices[]） */
export interface LanSyncDevice {
  peer_id: string;
  display_name: string;
  role?: string;
  paired_at?: number;
  last_seen_at?: number;
  online: boolean;
  phase?: string | null;
}

/** 归一化响应（apiClient 返回体，只取本文件需要的字段） */
interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
}

/** 取错误文案（后端 detail/error → message；超时/网络失败兜底） */
function errorText(res: ApiResult<unknown>, fallback: string): string {
  return res.message || fallback;
}

export interface LanSyncApi {
  status: Ref<LanSyncStatus | null>;
  identity: Ref<LanSyncIdentity | null>;
  pending: Ref<LanSyncPairRequest[]>;
  devices: Ref<LanSyncDevice[]>;
  qrImage: Ref<string | null>;
  qrPayload: Ref<string>;
  loading: Ref<boolean>;
  busy: Ref<boolean>;
  error: Ref<string | null>;
  refresh: () => Promise<void>;
  pollEvents: () => Promise<void>;
  startPairing: () => Promise<boolean>;
  stopPairing: () => Promise<void>;
  approve: (requestId: string, displayName?: string) => Promise<boolean>;
  reject: (requestId: string) => Promise<boolean>;
  removeDevice: (peerId: string) => Promise<boolean>;
  startPolling: () => void;
  stopPolling: () => void;
}

/**
 * 局域网同步状态与操作（组件挂载时 refresh + startPolling，卸载时 stopPolling）。
 *
 * 所有写操作返回 boolean（成功与否）：组件据此弹 toast，失败不抛异常。
 */
export function useLanSync(): LanSyncApi {
  const status = ref<LanSyncStatus | null>(null);
  const identity = ref<LanSyncIdentity | null>(null);
  const pending = ref<LanSyncPairRequest[]>([]);
  const devices = ref<LanSyncDevice[]>([]);
  const qrImage = ref<string | null>(null);
  const qrPayload = ref("");
  const loading = ref(true);
  const busy = ref(false);
  const error = ref<string | null>(null);

  let cursor = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let polling = false;

  function fail(res: ApiResult<unknown>, fallback: string): false {
    error.value = errorText(res, fallback);
    return false;
  }

  /** 重拉 pending + devices（批准卡与设备列表） */
  async function loadLists(): Promise<void> {
    const [pr, dr] = await Promise.all([
      apiGet("/api/lansync/pairing/pending") as Promise<
        ApiResult<{ requests?: LanSyncPairRequest[] }>
      >,
      apiGet("/api/lansync/devices") as Promise<ApiResult<{ devices?: LanSyncDevice[] }>>,
    ]);
    pending.value = pr.ok && Array.isArray(pr.data?.requests) ? pr.data.requests : [];
    devices.value = dr.ok && Array.isArray(dr.data?.devices) ? dr.data.devices : [];
  }

  /** 全量刷新：服务状态 + 身份 + 列表（进面板 / 操作后调用） */
  async function refresh(): Promise<void> {
    loading.value = true;
    const [st, id] = await Promise.all([
      apiGet("/api/lansync/status") as Promise<ApiResult<LanSyncStatus>>,
      apiGet("/api/lansync/identity") as Promise<ApiResult<LanSyncIdentity>>,
    ]);
    status.value = st.ok && st.data ? st.data : null;
    identity.value = id.ok && id.data ? id.data : null;
    error.value = st.ok ? null : errorText(st, "");
    await loadLists();
    loading.value = false;
  }

  /** 事件轮询：有新事件才刷新列表；游标只在成功响应后推进（失败保持上次） */
  async function pollEvents(): Promise<void> {
    if (polling) return; // 上一轮未回来（慢网络）时跳过本轮，避免请求堆积
    polling = true;
    try {
      const res = (await apiGet(`/api/lansync/events?cursor=${cursor}`)) as ApiResult<{
        cursor?: number;
        events?: unknown[];
      }>;
      if (!res.ok || !res.data) return;
      const events = Array.isArray(res.data.events) ? res.data.events : [];
      const next = Number(res.data.cursor);
      if (Number.isFinite(next)) cursor = next;
      if (events.length) {
        await loadLists();
        dispatchEvents(events);
      }
    } finally {
      polling = false;
    }
  }

  /** 展示配对二维码（重复调用 = 换新码并作废旧码，由后端保证） */
  async function startPairing(): Promise<boolean> {
    busy.value = true;
    const res = (await apiPost("/api/lansync/pairing/start")) as ApiResult<{
      qr_payload?: string;
      qr_image?: string | null;
    }>;
    busy.value = false;
    if (!res.ok || !res.data) return fail(res, "");
    qrPayload.value = res.data.qr_payload || "";
    qrImage.value = res.data.qr_image || null;
    error.value = null;
    return true;
  }

  /** 停止展示（作废当前 nonce）；已配对设备的重连不受影响 */
  async function stopPairing(): Promise<void> {
    await apiPost("/api/lansync/pairing/stop");
    qrImage.value = null;
    qrPayload.value = "";
  }

  /** 批准配对（displayName 缺省 = 用后端建议名） */
  async function approve(requestId: string, displayName?: string): Promise<boolean> {
    busy.value = true;
    const body = displayName ? { display_name: displayName } : {};
    const res = (await apiPost(
      `/api/lansync/pairing/${encodeURIComponent(requestId)}/approve`,
      body,
    )) as ApiResult<unknown>;
    busy.value = false;
    await loadLists();
    if (!res.ok) return fail(res, "");
    error.value = null;
    return true;
  }

  /** 拒绝配对（对端收到 approved=false 后断连） */
  async function reject(requestId: string): Promise<boolean> {
    busy.value = true;
    const res = (await apiPost(
      `/api/lansync/pairing/${encodeURIComponent(requestId)}/reject`,
    )) as ApiResult<unknown>;
    busy.value = false;
    await loadLists();
    if (!res.ok) return fail(res, "");
    error.value = null;
    return true;
  }

  /** 撤销配对（断开该设备 + 删信任记录） */
  async function removeDevice(peerId: string): Promise<boolean> {
    busy.value = true;
    const res = (await apiDelete(
      `/api/lansync/devices/${encodeURIComponent(peerId)}`,
    )) as ApiResult<unknown>;
    busy.value = false;
    await loadLists();
    if (!res.ok) return fail(res, "");
    error.value = null;
    return true;
  }

  /** 起轮询（幂等） */
  function startPolling(): void {
    if (timer !== null) return;
    timer = setInterval(() => {
      void pollEvents();
    }, POLL_INTERVAL_MS);
  }

  /** 停轮询（幂等） */
  function stopPolling(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    status,
    identity,
    pending,
    devices,
    qrImage,
    qrPayload,
    loading,
    busy,
    error,
    refresh,
    pollEvents,
    startPairing,
    stopPairing,
    approve,
    reject,
    removeDevice,
    startPolling,
    stopPolling,
  };
}
