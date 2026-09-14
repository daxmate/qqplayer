// 局域网同步（S2 · web Host 侧）运行层：一次推送 / 拉取的启动、状态轮询与取消。
//
// 契约（冻结，见 `backend/app/routers/lansync.py` 同批路由）：
//   POST /api/lansync/push            {peer_id, selection}      → {run_id}
//   GET  /api/lansync/push/{run_id}                             → 状态字典（未知 → 404）
//   POST /api/lansync/push/{run_id}/cancel                      → {cancelled}
//   POST /api/lansync/pull            {peer_id, relative_paths} → {run_id}
//   GET  /api/lansync/pull/{run_id}                             → 状态字典；取消同构
//
// **运行视图以轮询 status 为准**（事件只用于触发刷新，见 useLanSync 的事件总线）：
// 状态字典经 `normalizeRunStatus` 归一成同一套 `LanSyncRunView`，推送 / 拉取共用一套 UI。
// 轮询用 setTimeout 串行链（上一轮回来才排下一轮），避免慢网络下请求堆积。
import { ref, type Ref } from "vue";
import { apiGet, apiPost } from "../utils/apiClient.js";
import {
  normalizeRunStatus,
  type LanSyncRunView,
  type LanSyncSelection,
} from "./lanSyncContent.js";

/** 运行状态轮询间隔（ms） */
export const RUN_POLL_INTERVAL_MS = 800;

/** 轮询兜底上限（ms）：后端异常导致永不进终态时，避免无限轮询 */
export const RUN_POLL_MAX_MS = 30 * 60 * 1000;

export interface LanSyncRunApi {
  /** 当前运行（null = 还没跑过） */
  view: Ref<LanSyncRunView | null>;
  /** 启动 / 取消在途 */
  busy: Ref<boolean>;
  /** 启动或轮询错误（后端 detail 原样展示） */
  error: Ref<string | null>;
  /** 起一次推送；返回是否已受理 */
  startPush: (peerId: string, selection: LanSyncSelection) => Promise<boolean>;
  /** 起一次拉取（relativePaths = 对端点名集合，非空） */
  startPull: (peerId: string, relativePaths: string[]) => Promise<boolean>;
  /** 取消当前运行（终态后无效，后端返回 cancelled=false） */
  cancel: () => Promise<boolean>;
  /** 停轮询并清空运行视图（切设备 / 切面板时调用） */
  reset: () => void;
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
}

/** 运行状态端点（推送 / 拉取同构） */
function runEndpoint(kind: "push" | "pull", runId: string): string {
  return `/api/lansync/${kind}/${encodeURIComponent(runId)}`;
}

/**
 * 推送 / 拉取运行状态（组件级 composable：每个内容面板一个实例）。
 *
 * 生命周期：`startPush`/`startPull` 起跑 → 轮询到终态自动停；组件卸载调 `stopPolling`
 * （面板里由 `onBeforeUnmount` 调用），避免后台空转。
 */
export function useLanSyncRun(): LanSyncRunApi & { stopPolling: () => void } {
  const view = ref<LanSyncRunView | null>(null);
  const busy = ref(false);
  const error = ref<string | null>(null);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let startedAt = 0;

  function stopPolling(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    stopPolling();
    timer = setTimeout(() => {
      void tick();
    }, RUN_POLL_INTERVAL_MS);
  }

  /** 拉一次状态；终态 / 404 / 超时 → 停轮询 */
  async function tick(): Promise<void> {
    timer = null;
    const current = view.value;
    if (!current || current.terminal) return;
    if (Date.now() - startedAt > RUN_POLL_MAX_MS) {
      error.value = current.error || "";
      return;
    }
    const res = (await apiGet(runEndpoint(current.kind, current.runId))) as ApiResult<unknown>;
    if (!res.ok) {
      // 运行记录不在了（后端重启 / 已过期）：停止轮询，保留最后一次视图由 UI 提示
      error.value = res.message || "";
      return;
    }
    // 轮询回来时可能在途被 reset() 清掉 → 结果丢弃
    if (!view.value || view.value.runId !== current.runId) return;
    view.value = normalizeRunStatus(current.kind, res.data);
    if (!view.value.terminal) schedule();
  }

  /** 起跑公共路径：受理后建运行视图并开始轮询 */
  function accept(
    kind: "push" | "pull",
    peerId: string,
    res: ApiResult<{ run_id?: string }>,
    selection: LanSyncSelection | null,
  ): boolean {
    if (!res.ok) {
      error.value = res.message || "";
      return false;
    }
    const runId = String(res.data?.run_id ?? "");
    if (!runId) {
      error.value = res.message || "";
      return false;
    }
    error.value = null;
    view.value = normalizeRunStatus(kind, {
      run_id: runId,
      peer_id: peerId,
      state: "idle",
      selection: selection ?? undefined,
    });
    startedAt = Date.now();
    schedule();
    return true;
  }

  async function startPush(peerId: string, selection: LanSyncSelection): Promise<boolean> {
    busy.value = true;
    const res = (await apiPost("/api/lansync/push", {
      peer_id: peerId,
      selection,
    })) as ApiResult<{ run_id?: string }>;
    busy.value = false;
    return accept("push", peerId, res, selection);
  }

  async function startPull(peerId: string, relativePaths: string[]): Promise<boolean> {
    const paths = (relativePaths || []).map((p) => String(p)).filter((p) => p.length > 0);
    if (!paths.length) {
      error.value = null;
      return false;
    }
    busy.value = true;
    const res = (await apiPost("/api/lansync/pull", {
      peer_id: peerId,
      relative_paths: paths,
    })) as ApiResult<{ run_id?: string }>;
    busy.value = false;
    return accept("pull", peerId, res, { kind: "tracks", ids: paths });
  }

  async function cancel(): Promise<boolean> {
    const current = view.value;
    if (!current || current.terminal) return false;
    busy.value = true;
    const res = (await apiPost(`${runEndpoint(current.kind, current.runId)}/cancel`)) as ApiResult<{
      cancelled?: boolean;
    }>;
    busy.value = false;
    if (!res.ok) {
      error.value = res.message || "";
      return false;
    }
    await tick();
    return true;
  }

  function reset(): void {
    stopPolling();
    view.value = null;
    error.value = null;
    busy.value = false;
  }

  return { view, busy, error, startPush, startPull, cancel, reset, stopPolling };
}
