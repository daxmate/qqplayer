// QQPlayer 统一 API 出口（前端数据层 · 定案 ②）
//
// 职责：
//   - 统一 fetch 出口：baseURL 可配置（localStorage `qqplayer.server`，iOS 壳注入；默认同源）
//   - 自动携带 Authorization: Bearer <token>（localStorage `qqplayer.token`，有则带）
//   - 声明式缓存：读接口调用点标 {cache: {ttl, offline}} → IndexedDB 缓存（key `GET:{url}`）
//   - 失败降级：网络错误/超时 + 声明 offline + 缓存命中（含过期）→ 返回缓存并进入离线模式
//   - 401 特判：清 token + 触发重配对事件（skip401 可关闭——夸克登录 401 是另一语义）
//   - 在线状态事件：onOfflineChange（App.vue 挂监听弹轻提示）
//   - 写路径 dirty 队列：writeLocal（本地先写）→ flushPendingOps（成功清队、失败保留）
//
// 返回归一化对象：{ok, status, data, message, fromCache, offline, network, response?}
//   ok      请求是否成功（含缓存命中与离线降级）
//   status  HTTP 状态码；网络失败为 0
//   data    解析后的 JSON 体（成功响应体 / 错误体；解析失败为 null）
//   message 尽力提取的错误文案（body.detail || body.error || body.message || statusText）
//   fromCache 本次响应来自缓存（声明式缓存命中或离线降级）
//   network 网络级失败（fetch 抛错/超时）
//   response 仅 raw 模式：原始 Response（调用方自行消费 body）

import {
  getCache,
  setCache,
  delCache,
  enqueuePendingOp,
  getPendingOps,
  removePendingOps,
} from "./cacheDb.js";

const TOKEN_KEY = "qqplayer.token";
const SERVER_KEY = "qqplayer.server";

// ---------- 类型（宽松边界：data 为 unknown，调用方自行断言；字段与 JS 原实现一一对应） ----------
interface ApiResponse {
  ok: boolean;
  status: number;
  data?: unknown;
  message?: string;
  fromCache?: boolean;
  offline?: boolean;
  network?: boolean;
  response?: Response;
  /** 离线降级读缓存（旧数据优于无数据）标记 */
  degraded?: boolean;
}

interface ApiOptions {
  url: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  cache?: { ttl?: number; offline?: boolean };
  /** 跳过缓存读（仍写缓存）——库变更后的强制刷新用 */
  force?: boolean;
  /** 返回原始 Response（大文件/二进制下载，不解析 JSON、不缓存） */
  raw?: boolean;
  /** 关闭 401 特判（夸克登录 401 语义不同） */
  skip401?: boolean;
  /** 超时 ms（默认 10000） */
  timeout?: number;
  signal?: AbortSignal;
}

// ---------- 配置 ----------
// iOS 壳注入优先级：localStorage（② 定案）→ window.qqplayerIosBridge（file:// 下
// localStorage 不可靠，Swift 侧把 server/token 直接嵌入桥对象，见 WebShellView.injectServer）
function bridgeValue(key: string): string {
  try {
    const b = typeof window !== "undefined" ? window.qqplayerIosBridge : null;
    const v = b ? (b as Record<string, unknown>)[key] : null;
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

function baseURL(): string {
  try {
    return localStorage.getItem(SERVER_KEY) || bridgeValue("server") || "";
  } catch {
    return bridgeValue("server");
  }
}

function authToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || bridgeValue("token") || "";
  } catch {
    return bridgeValue("token");
  }
}

function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 相对 /api 路径 → 桌面服务器绝对 URL。
 * iOS 壳（file:// 加载前端）里 <img src="/api/cover…"> 等无法自动解析相对路径（会变成
 * file:///api/…），统一经此转换；桌面同源环境 qqplayer.server 未设置时原样返回，行为零变化。
 */
export function resolveServerUrl(path: string): string {
  if (!path || typeof path !== "string") return path;
  if (/^https?:\/\//i.test(path) || path.startsWith("data:")) return path;
  const base = baseURL();
  if (!base) return path;
  let url = base.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
  // 浏览器/原生资源（<img>/<link>/AVPlayer/URLSession 下载）带不了 Authorization header
  // → token 附加 query（后端中间件支持 ?token=；2026-08-23 真机资源 401 根因）
  const token = authToken();
  if (token) {
    url += (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
  return url;
}

// ---------- 在线状态（离线模式事件） ----------
let offline = false;
const offlineListeners = new Set<(offline: boolean) => void>();
const unauthorizedListeners = new Set<() => void>();

/** 设备级断网（navigator.onLine=false：Wi-Fi/蜂窝全断）——WKWebView 反映系统网络状态 */
function deviceOffline(): boolean {
  try {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  } catch {
    return false;
  }
}

/** 当前是否处于离线模式（设备断网 或 网络请求失败降级；恢复在线自动退出）。
 *  断网时所有主机请求都应跳过（本地优先原则，2026-08-27 用户明确）：
 *  歌词/封面/同步等不再发起网络请求，直接走本地。 */
export function isOffline(): boolean {
  return offline || deviceOffline();
}

/** 订阅离线/恢复在线切换：cb(offline: boolean)；返回取消订阅函数 */
export function onOfflineChange(cb: (offline: boolean) => void): () => void {
  offlineListeners.add(cb);
  return () => offlineListeners.delete(cb);
}

/** 订阅配对失效事件（401 清 token 后触发）；返回取消订阅函数 */
export function onUnauthorized(cb: () => void): () => void {
  unauthorizedListeners.add(cb);
  return () => unauthorizedListeners.delete(cb);
}

function setOffline(v: boolean): void {
  if (offline === v) return;
  offline = v;
  // 离线 → 启动恢复探测（30s 定时 + window online 事件）；恢复 → 停止。
  // 保证「离线后不永远离线」：恢复探测无条件定期执行，成功即自动解除。
  if (v) startRecoveryProbe();
  else stopRecoveryProbe();
  for (const cb of offlineListeners) {
    try {
      cb(v);
    } catch {
      /* 监听器异常不影响请求 */
    }
  }
}

/** 测试用：复位模块级状态（离线标志 + 监听器 + 挂起定时器 + 探测状态） */
export function resetApiClientState(): void {
  offline = false;
  offlineListeners.clear();
  unauthorizedListeners.clear();
  hostReachable = "unknown";
  probeInFlight = null;
  stopRecoveryProbe();
  if (onlineHandler && typeof window !== "undefined") {
    window.removeEventListener("online", onlineHandler);
    onlineHandler = null;
  }
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

// ---------- 主机可达性（hostReachable · 契约 docs/host-reachability.md） ----------
// 可达性 = 实时探测结果（GET /api/ping），不是历史配对记录。启动探测（App onMounted
// 最先 await）+ 恢复探测（offline 期间每 30s 定时 + window online 事件，成功即停）。
// hostReachable 是「探测状态」，offline 是「结果状态」：探测失败 → offline=true 全局
// 短路（请求不发、不挂起）；探测成功 → setOffline(false) 自动恢复。

let hostReachable: "unknown" | "online" | "offline" = "unknown"; // "unknown" | "online" | "offline"
let probeInFlight: Promise<boolean> | null = null; // 并发探测合并（复用同一 Promise）
let recoveryTimer: ReturnType<typeof setInterval> | null = null; // offline 期间 30s 恢复探测 interval
let onlineHandler: (() => void) | null = null; // window online 事件句柄（设备网络恢复 → 立即重探）

/** 探测超时（ms）：快速失败，绝不等待系统 TCP 超时 */
export const HOST_PROBE_TIMEOUT_MS = 2500;

/** 恢复探测间隔（ms）：offline 期间每 30s 无条件探测一次（成功即停） */
export const HOST_RECOVERY_PROBE_MS = 30000;

/** 当前主机可达性状态：'unknown' | 'online' | 'offline' */
export function getHostReachable(): "unknown" | "online" | "offline" {
  return hostReachable;
}

function startRecoveryProbe(): void {
  // window online 事件（设备网络恢复 → 立即探测；浏览器环境，测试无 window 跳过）
  if (typeof window !== "undefined" && !onlineHandler) {
    onlineHandler = () => {
      if (!deviceOffline()) probeHost(); // 设备网络确实恢复才探测（避免无意义请求）
    };
    window.addEventListener("online", onlineHandler);
  }
  if (recoveryTimer) return;
  recoveryTimer = setInterval(() => {
    probeHost(); // 幂等（inFlight 合并）；成功会自动 setOffline(false) 停表
  }, HOST_RECOVERY_PROBE_MS);
}

function stopRecoveryProbe(): void {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
}

/**
 * 主机可达性探测：GET /api/ping（快速超时）。
 * 走原始 fetch（nativeHttpFetch/fetchWithTimeout）绕过 api() 短路——离线时请求已
 * 短路发不出去，探测本身必须永远真实发请求。
 * 任何 HTTP 响应（含 401/404/500，只要主机回了话）都证明主机可达；
 * 仅无响应 / 超时 / 网络错误判离线。
 * 幂等：并发探测合并（inFlight 复用同一 Promise）。
 * @returns 探测是否成功
 */
export async function probeHost(): Promise<boolean> {
  if (probeInFlight) return probeInFlight;
  probeInFlight = (async () => {
    let ok = false;
    try {
      const res = nativeHttpAvailable()
        ? await nativeHttpFetch(baseURL() + "/api/ping", { method: "GET" }, HOST_PROBE_TIMEOUT_MS)
        : await fetchWithTimeout(baseURL() + "/api/ping", { method: "GET" }, HOST_PROBE_TIMEOUT_MS);
      // 任何合法 Response（ok boolean / status number）都算主机在线
      ok = !!res && (typeof res.ok === "boolean" || typeof res.status === "number");
    } catch {
      // 网络错误 / 超时 → 保持 ok=false（主机不可达）；catch 进入时 ok 必为初始 false
    }
    hostReachable = ok ? "online" : "offline";
    if (ok) setOffline(false);
    else setOffline(true);
    return ok;
  })();
  try {
    return await probeInFlight;
  } finally {
    probeInFlight = null;
  }
}

// ---------- 请求核心 ----------
// iOS 原生网络桥：WKWebView 的 file:// 页面禁止 fetch http://（跨 scheme 跨源硬限制），
// 壳环境（window.qqplayerIosBridge 存在）下请求改走 postMessage → 原生 URLSession → 回传。
// 返回结构对齐 fetch Response 子集（ok/status/text/json），下游 apiClient 逻辑零改动。
let nativeReqSeq = 0;
const nativePending = new Map<number, (status: number, bodyText: string) => void>();

/** iOS 原生网络桥响应（fetch Response 子集；仅 file:// 壳环境使用） */
interface NativeHttpResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}

function nativeHttpAvailable(): boolean {
  try {
    if (typeof window === "undefined") return false;
    // 仅 file:// 页面需要网络桥（http 页面 fetch 正常，走标准浏览器 + CORS）；
    // 2026-08-22 换路：壳改本地 http server 加载后，此分支不再触发
    if (window.location.protocol !== "file:") return false;
    return !!(window.qqplayerIosBridge && window.qqplayerIosBridge.postMessage);
  } catch {
    return false;
  }
}

function nativeHttpFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<NativeHttpResponse> {
  return new Promise((resolve, reject) => {
    const id = ++nativeReqSeq;
    const timer = setTimeout(() => {
      if (nativePending.has(id)) {
        nativePending.delete(id);
        reject(new TypeError("网络请求超时"));
      }
    }, timeoutMs || 30000);
    nativePending.set(id, (status, bodyText) => {
      clearTimeout(timer);
      const ok = status >= 200 && status < 300;
      resolve({
        ok,
        status,
        text: async () => bodyText,
        json: async () => {
          try {
            return JSON.parse(bodyText);
          } catch {
            return null;
          }
        },
      });
    });
    try {
      // 非空断言：nativeHttpAvailable() 已确认桥存在且 postMessage 可调；运行时若缺仍抛错走 catch
      window.qqplayerIosBridge!.postMessage!({
        cmd: "http",
        id,
        url,
        method: init.method || "GET",
        headers: init.headers || {},
        body: typeof init.body === "string" ? init.body : null,
      });
    } catch (e) {
      nativePending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function fetchWithTimeout(url: string, init: RequestInit, timeout: number): Promise<Response> {
  if (!timeout || timeout <= 0) return fetch(url, init);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

// 错误体尽力解析（res.json 可能不存在或非 JSON）
async function extractBody(
  res: { json?: () => Promise<unknown> } | null | undefined,
): Promise<unknown> {
  try {
    if (typeof res?.json !== "function") return null;
    return await res.json();
  } catch {
    return null;
  }
}

function errorMessage(
  data: unknown,
  res: { statusText?: string; status?: number } | null | undefined,
): string {
  if (typeof data === "string" && data) return data;
  const d = data as { detail?: string; error?: string; message?: string } | null | undefined;
  return (
    d?.detail ||
    d?.error ||
    d?.message ||
    res?.statusText ||
    (res?.status ? `HTTP ${res.status}` : "网络连接失败")
  );
}

/**
 * 统一请求入口。
 * @param opts.url 相对路径（如 /api/songs），baseURL 自动前缀
 * @param opts.method 默认 "GET"
 * @param opts.body JSON 对象（自动 stringify）或 FormData（原样透传）
 * @param opts.headers 附加请求头（覆盖默认）
 * @param opts.cache 声明式缓存：ttl 秒；offline 允许网络失败时降级读缓存
 * @param opts.force 跳过缓存读（仍写缓存）——库变更后的强制刷新用
 * @param opts.raw 返回原始 Response（大文件/二进制下载，不解析 JSON、不缓存）
 * @param opts.skip401 关闭 401 特判（夸克登录 401 语义不同）
 * @param opts.timeout 超时 ms（默认 10000——断网/服务器不可达时快速失败触发离线降级，
 *   避免歌词/封面/同步挂起等系统 TCP 超时（30s+）；局域网请求 10s 内足够）
 */
export async function api(
  {
    url,
    method = "GET",
    body,
    headers,
    cache,
    force,
    raw,
    skip401,
    timeout = 10000,
  }: ApiOptions = {} as ApiOptions,
): Promise<ApiResponse> {
  const isGet = method === "GET" || method === "HEAD";
  const cacheKey = "GET:" + url;

  // 1. 声明式缓存读（GET + 声明 + 未过期；force 跳过）
  if (isGet && cache && !force) {
    const hit = await getCache(cacheKey, { maxAge: cache.ttl });
    if (hit !== null && hit !== undefined) {
      return { ok: true, status: 200, data: hit, fromCache: true, offline: false, network: false };
    }
  }

  // 1.5 离线短路（设备断网 或 主机不可达/请求降级）→ 不发网络请求：GET 有 cache
  //     读缓存（含过期——离线时旧数据优于无）、无 cache 快速失败；写请求快速失败。
  //     绝不等待系统 TCP 超时（本地优先原则 2026-08-27；主机离线由恢复探测解除）
  if (isOffline()) {
    setOffline(true);
    if (isGet && cache) {
      const stale = await getCache(cacheKey);
      if (stale !== null && stale !== undefined) {
        return {
          ok: true,
          status: 200,
          data: stale,
          fromCache: true,
          offline: true,
          network: false,
          degraded: true,
        };
      }
    }
    return { ok: false, status: 0, data: null, message: "网络连接失败", network: true };
  }

  // 2. 组装请求
  const init: RequestInit = { method };
  const h: Record<string, string> = { ...(headers || {}) };
  if (body !== undefined && !(body instanceof FormData)) {
    h["Content-Type"] = "application/json";
  }
  const token = authToken();
  if (token) h.Authorization = "Bearer " + token;
  if (Object.keys(h).length) init.headers = h;
  if (body !== undefined) init.body = body instanceof FormData ? body : JSON.stringify(body);

  // 3. 网络请求（失败 → 离线降级）
  let res: Response | NativeHttpResponse | null | undefined;
  try {
    res = nativeHttpAvailable()
      ? await nativeHttpFetch(baseURL() + url, init, timeout)
      : await fetchWithTimeout(baseURL() + url, init, timeout);
  } catch (err) {
    if (isGet && cache?.offline) {
      // 网络失败：读缓存（含过期——离线时旧数据优于无数据）
      const stale = await getCache(cacheKey);
      if (stale !== null && stale !== undefined) {
        setOffline(true);
        return {
          ok: true,
          status: 200,
          data: stale,
          fromCache: true,
          offline: true,
          network: false,
          degraded: true,
        };
      }
    }
    return {
      ok: false,
      status: 0,
      data: null,
      message: (err as { message?: string } | null | undefined)?.message || "网络连接失败",
      network: true,
    };
  }

  // fetch 未返回合法 Response（异常 mock / 环境差异）：按网络失败处理，绝不抛穿调用方
  if (!res || typeof res.ok !== "boolean") {
    return { ok: false, status: 0, data: null, message: "无效响应", network: true };
  }

  // 4. 401 特判：清 token + 重配对事件（仅当请求确实带了配对 token 或未声明 skip401）
  if (res.status === 401 && !skip401) {
    const hadToken = !!token;
    clearToken();
    if (hadToken) {
      for (const cb of unauthorizedListeners) {
        try {
          cb();
        } catch {
          /* 监听器异常不影响请求 */
        }
      }
    }
  }

  // 5. 错误归一化
  if (!res.ok) {
    const data = await extractBody(res);
    return {
      ok: false,
      status: res.status,
      data,
      message: errorMessage(data, res),
      network: false,
    };
  }

  // 6. 成功：恢复在线 + 写缓存
  if (offline) setOffline(false);
  if (raw) return { ok: true, status: res.status, response: res as Response, network: false };
  const data = await extractBody(res);
  if (isGet && cache) {
    if (data !== null && data !== undefined) {
      await setCache(cacheKey, data, cache.ttl);
    }
  }
  return { ok: true, status: res.status, data, fromCache: false, offline: false, network: false };
}

// ---------- 便捷方法 ----------
export const apiGet = (
  url: string,
  opts: Omit<ApiOptions, "url" | "method"> = {},
): Promise<ApiResponse> => api({ url, ...opts });
// body 可选：运行时本就允许无请求体的 POST（如 /api/pairing/request/.../approve 无 body）
export const apiPost = (
  url: string,
  body?: unknown,
  opts: Omit<ApiOptions, "url" | "method" | "body"> = {},
): Promise<ApiResponse> => api({ url, method: "POST", body, ...opts });
export const apiPut = (
  url: string,
  body?: unknown,
  opts: Omit<ApiOptions, "url" | "method" | "body"> = {},
): Promise<ApiResponse> => api({ url, method: "PUT", body, ...opts });
export const apiPatch = (
  url: string,
  body?: unknown,
  opts: Omit<ApiOptions, "url" | "method" | "body"> = {},
): Promise<ApiResponse> => api({ url, method: "PATCH", body, ...opts });
export const apiDelete = (
  url: string,
  opts: Omit<ApiOptions, "url" | "method"> = {},
): Promise<ApiResponse> => api({ url, method: "DELETE", ...opts });

/** 失效某 URL 的 GET 缓存（写成功后调用，保证下次读新鲜） */
export function invalidate(url: string): Promise<void> {
  return delCache("GET:" + url);
}

// ---------- 写路径 dirty 队列（本地优先） ----------
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/** 防抖触发队列回放（多次入队合并；队列空时无操作） */
export function scheduleFlush(delay = 300): void {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushPendingOps();
  }, delay);
}

/**
 * 回放 dirty 队列到 apiClient：成功清队、失败保留（下次入队 / 启动时再试）。
 * 串行回放保证顺序（歌单增删等有先后依赖）。返回 {flushed, kept}。
 */
export async function flushPendingOps(): Promise<{ flushed: number; kept: number }> {
  const ops = await getPendingOps();
  if (!ops.length) return { flushed: 0, kept: 0 };
  let flushed = 0;
  const kept: number[] = [];
  for (const entry of ops) {
    try {
      const r = await api({ url: entry.op.url, method: entry.op.method, body: entry.payload });
      if (r.ok) {
        flushed++;
        await removePendingOps([entry.id]);
      } else {
        kept.push(entry.id);
      }
    } catch {
      kept.push(entry.id);
    }
  }
  return { flushed, kept: kept.length };
}

/**
 * 写路径本地优先核心：
 *   1. 先入队（IndexedDB pendingOps，本地持久化）
 *   2. 立即尝试同步
 *   3. 成功 → 清队；网络失败 → 保留队列（离线语义，本地状态不回滚）；
 *      HTTP 拒绝 → 清队（服务端为准，调用方自行回滚本地状态）
 * @returns "ok" | "queued" | "rejected"
 */
export async function writeLocal({
  url,
  method = "POST",
  body,
}: {
  url: string;
  method?: string;
  body?: unknown;
}): Promise<"ok" | "queued" | "rejected"> {
  const id = await enqueuePendingOp({ url, method }, body);
  const r = await api({ url, method, body });
  if (r.ok) {
    await removePendingOps([id]);
    return "ok";
  }
  if (r.network) {
    scheduleFlush(); // 离线：保留队列，稍后自动重试
    return "queued";
  }
  await removePendingOps([id]);
  return "rejected";
}
