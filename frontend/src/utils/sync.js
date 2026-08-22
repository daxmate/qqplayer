// QQPlayer iOS 前端同步模块（阶段3 · E1）
//
// 职责：
//   - syncNow()：拉取桌面 /api/sync/manifest 全量清单（不缓存），version 变化时
//     全量写入 IndexedDB（key: sync:songs / sync:playlists / sync:favorites /
//     sync:books / sync:dicts，经 cacheDb.setCache，ttl=0 不自动过期）
//   - ensureAsset()：本地资产查询（hasAsset → assetStatus 回执，Promise 化）→
//     存在返回 localURL；不存在发 syncDownload 后台下载并 resolve(null)
//   - initSync()：经 nativeAudioBridge.onNativeEvent 订阅（syncAssetProgress /
//     syncAssetDone / assetStatus / appState），并执行首次 syncNow()。
//     注意：window.qqplayerOnNativeEvent 全局入口由 nativeAudioBridge 独占安装，
//     本模块只订阅不分发，避免双处理。
//
// 桥契约（与 iOS 壳 Swift 侧对齐）：
//   Web→Native：window.qqplayerIosBridge.postMessage(msg)
//     {cmd:"syncDownload", items:[{url,path,sha256,size}]}  批量下载请求
//     {cmd:"hasAsset", path, requestId}                     本地资产查询
//     {cmd:"cancelDownloads"}                               取消全部下载
//   Native→Web：window.qqplayerOnNativeEvent(name, payload)
//     {name:"syncAssetProgress", path, received, total}     total 未知为 0
//     {name:"syncAssetDone", path, ok, sha256, localURL, error?}
//     {name:"assetStatus", requestId, path, exists, localURL}
//     {name:"appState", state:"active"|"inactive"|"background"}
//
// 环境：桌面浏览器（window.qqplayerNative 未定义）→ 全部静默 no-op，桌面行为零变化；
// macOS 壳（qqplayerNative=true 但无 qqplayerIosBridge）→ 元数据同步可用、资产消息不发送。
//
// 资产寻址：沙盒路径按「内容寻址」命名（audio/<sha256>.m4a 等）。manifest 不含文件
// 内容哈希，前端以资产标识（桌面路径/词典相对路径/书 id）的 SHA-256 作稳定文件名与
// sha256 字段——跨会话确定、同文件同地址；真实内容校验由原生侧下载后自行计算。

import { reactive } from "vue";
import { onNativeEvent, nativePost } from "../composables/nativeAudioBridge.js";
import { apiGet, resolveServerUrl } from "./apiClient.js";
import { getCache, setCache } from "./cacheDb.js";

// ---------- 环境判定 ----------

/** 是否处于原生壳环境（iOS 壳注入 window.qqplayerNative=true；桌面浏览器没有） */
export function syncEnabled() {
  try {
    return typeof window !== "undefined" && !!window.qqplayerNative;
  } catch {
    return false;
  }
}

/** iOS 资产桥是否可用（postMessage 可调用）——macOS 壳无此桥，资产消息不发 */
function iosBridgeAvailable() {
  try {
    return (
      typeof window !== "undefined" &&
      !!window.qqplayerIosBridge &&
      typeof window.qqplayerIosBridge.postMessage === "function"
    );
  } catch {
    return false;
  }
}

// ---------- 同步状态（设置页 UI 读） ----------
export const syncState = reactive({
  lastSyncAt: null, // 上次成功同步时间戳（ms）
  syncing: false, // 同步进行中（设置页按钮 loading 态）
  lastError: "", // 最近一次同步失败信息（成功清空）
  pendingCount: 0, // 进行中的下载数（syncAssetProgress/Done 聚合）
  progress: { received: 0, total: 0 }, // 聚合下载进度；total 为 0 = 未知（不可算百分比）
});

/** 同步状态快照引用（设置页 UI 响应式读取；同 syncState） */
export function getSyncState() {
  return syncState;
}

// ---------- manifest 同步 ----------
const MANIFEST_URL = "/api/sync/manifest";
const COLLECTION_KEYS = ["songs", "playlists", "favorites", "books", "dicts"];

let syncInFlight = false;

/**
 * 拉取桌面 manifest 并缓存元数据集合。
 * @returns {Promise<{ok:boolean, enabled?:boolean, changed?:boolean, version?:string,
 *   counts?:object, message?:string}>}
 *   enabled=false → 桌面浏览器（未启用）；ok=false → 拉取失败（message 为原因）；
 *   成功 → {ok:true, changed, version, counts:{songs,playlists,favorites,books,dicts}}
 */
export async function syncNow() {
  if (!syncEnabled()) return { enabled: false, ok: false };
  if (syncInFlight) return { ok: false, message: "sync in progress" };
  syncInFlight = true;
  syncState.syncing = true;
  try {
    const r = await apiGet(MANIFEST_URL);
    if (!r.ok) {
      syncState.lastError = r.message || `HTTP ${r.status || 0}`;
      return { ok: false, message: syncState.lastError, status: r.status };
    }
    const manifest = r.data || {};
    const version = String(manifest.version || "");
    const meta = await getCache("sync:meta");
    const changed = !meta || meta.version !== version;
    if (changed) {
      const counts = {};
      for (const key of COLLECTION_KEYS) {
        const list = Array.isArray(manifest[key]) ? manifest[key] : [];
        counts[key] = list.length;
        await setCache("sync:" + key, list);
      }
      await setCache("sync:meta", {
        version,
        generatedAt: manifest.generated_at || "",
        syncedAt: Date.now(),
      });
    }
    syncState.lastSyncAt = Date.now();
    syncState.lastError = "";
    const counts = {};
    for (const key of COLLECTION_KEYS) {
      counts[key] = Array.isArray(manifest[key]) ? manifest[key].length : 0;
    }
    return { ok: true, changed, version, counts };
  } catch (e) {
    syncState.lastError = (e && e.message) || "同步失败";
    return { ok: false, message: syncState.lastError };
  } finally {
    syncInFlight = false;
    syncState.syncing = false;
  }
}

// ---------- 资产标识 → 沙盒路径（内容寻址） ----------

/** 扩展名（含点，小写；无扩展名返回 ""） */
function extOf(name) {
  const m = String(name || "").match(/\.([A-Za-z0-9]+)$/);
  return m ? "." + m[1].toLowerCase() : "";
}

/** 资产标识的稳定哈希：优先 SHA-256（crypto.subtle），不可用时回落确定性 FNV-1a 64 位 */
async function assetHash(identity) {
  const input = String(identity || "");
  try {
    if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
      return Array.from(new Uint8Array(buf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    /* 回落确定性散列 */
  }
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < input.length; i++) {
    h ^= BigInt(input.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** 歌曲 → 下载项 {url, path, sha256, size}（url 为桌面服务器绝对 URL）
 *  sha256 暂为 ""（后端 manifest 未提供内容哈希；原生侧空值跳过内容校验，
 *  文件名仍用资产标识哈希做内容寻址） */
export async function assetForSong(song) {
  if (!song || !song.path) return null;
  const url = resolveServerUrl("/api/audio?path=" + encodeURIComponent(song.path));
  const hash = await assetHash(song.path);
  return {
    url,
    path: "audio/" + hash + (extOf(song.path) || ".m4a"),
    sha256: "",
    size: song.size || 0,
  };
}

/** 词典 → 下载项（manifest dicts 条目：{name, path, size, mtime}）；sha256 暂为空（同上） */
export async function assetForDict(dict) {
  if (!dict || !dict.path) return null;
  const url = resolveServerUrl("/api/sync/dicts/file?path=" + encodeURIComponent(dict.path));
  const hash = await assetHash(dict.path);
  return {
    url,
    path: "dicts/" + hash + (extOf(dict.path) || ".mdx"),
    sha256: "",
    size: dict.size || 0,
  };
}

/** 书 → 下载项（manifest books 条目：{id, title, progress}）；sha256 暂为空（同上） */
export async function assetForBook(book) {
  if (!book || !book.id) return null;
  const url = resolveServerUrl("/api/books/" + encodeURIComponent(book.id) + "/file");
  const hash = await assetHash(book.id);
  return { url, path: "books/" + hash + ".epub", sha256: "", size: book.size || 0 };
}

// ---------- 资产查询与下载（ensureAsset） ----------
let requestSeq = 0;
const pendingQueries = new Map(); // requestId → resolve(localURL|null)

/** hasAsset 回执等待超时（ms）：原生无回执时不挂起调用方 */
export const ASSET_QUERY_TIMEOUT_MS = 8000;

/**
 * 查询本地资产并（必要时）发起后台下载。
 * @param {{path:string, url:string, sha256?:string, size?:number}} item 沙盒相对路径 + 桌面绝对 URL
 * @returns {Promise<string|null>} 已存在 → resolve(localURL)；不存在/已发起下载 → resolve(null)
 *   （不阻塞、不等待下载完成；调用方保持远程播放即可）
 */
export function ensureAsset({ path, url, sha256, size } = {}) {
  if (!syncEnabled() || !iosBridgeAvailable() || !path || !url) {
    return Promise.resolve(null);
  }
  // 惰性注册事件订阅：不依赖 initSync 先行调用（幂等；桌面浏览器早退不注册）
  ensureSubscribed();
  const requestId = String(++requestSeq); // 字符串类型：与 Swift 侧 as? String 解析对齐（数字会被静默丢弃）
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingQueries.has(requestId)) {
        pendingQueries.delete(requestId);
        resolve(null);
      }
    }, ASSET_QUERY_TIMEOUT_MS);
    pendingQueries.set(requestId, (payload) => {
      clearTimeout(timer);
      pendingQueries.delete(requestId);
      if (payload && payload.exists && payload.localURL) {
        resolve(payload.localURL);
      } else {
        // 本地没有：批量发起下载（同 tick 内多条请求合并成一次 syncDownload）
        queueDownload({ url, path, sha256: sha256 || "", size: size || 0 });
        resolve(null);
      }
    });
    nativePost({ cmd: "hasAsset", path, requestId });
  });
}

/** 取消全部进行中的下载（清进度状态） */
export function cancelDownloads() {
  nativePost({ cmd: "cancelDownloads" });
  activeDownloads.clear();
  refreshSyncState();
}

// ---------- syncDownload 批量发送（微任务合并） ----------
let downloadBatch = [];
let downloadBatchTimer = null;

function queueDownload(item) {
  downloadBatch.push(item);
  if (downloadBatchTimer) return;
  downloadBatchTimer = Promise.resolve()
    .then(flushDownloads)
    .catch(() => {});
}

function flushDownloads() {
  downloadBatchTimer = null;
  if (!downloadBatch.length) return;
  const items = downloadBatch;
  downloadBatch = [];
  nativePost({ cmd: "syncDownload", items });
}

// ---------- 下载进度聚合（Native→Web 事件驱动） ----------
const activeDownloads = new Map(); // path → {received, total}

function handleAssetProgress(payload) {
  const path = payload && payload.path;
  if (!path) return;
  const cur = activeDownloads.get(path) || { received: 0, total: 0 };
  if (typeof payload.received === "number") cur.received = payload.received;
  if (typeof payload.total === "number" && payload.total > 0) cur.total = payload.total;
  activeDownloads.set(path, cur);
  refreshSyncState();
}

function handleAssetDone(payload) {
  if (payload && payload.path) activeDownloads.delete(payload.path);
  refreshSyncState();
}

function refreshSyncState() {
  syncState.pendingCount = activeDownloads.size;
  let received = 0;
  let total = 0;
  for (const d of activeDownloads.values()) {
    received += d.received;
    total += d.total;
  }
  syncState.progress = { received, total };
}

// ---------- 生命周期（appState） ----------
function handleAppState(payload) {
  // 前台恢复：重新拉取 manifest（元数据可能已变）；后台/失活不动作
  if (payload && payload.state === "active") {
    syncNow();
  }
}

// ---------- 安装（initSync / stopSync；事件订阅惰性幂等） ----------
let initialized = false;
let subscribed = false;
let unsubs = [];

/** 注册原生事件订阅（幂等；initSync 与 ensureAsset 共用，重复调用不叠加） */
function ensureSubscribed() {
  if (subscribed) return;
  subscribed = true;
  unsubs.push(onNativeEvent("syncAssetProgress", handleAssetProgress));
  unsubs.push(onNativeEvent("syncAssetDone", handleAssetDone));
  unsubs.push(onNativeEvent("assetStatus", handleAssetStatus));
  unsubs.push(onNativeEvent("appState", handleAppState));
}

/**
 * 初始化同步模块：订阅原生事件 + 首次 syncNow()。
 * 在 App onMounted（前端就绪后）调用一次；桌面浏览器静默 no-op。
 * 事件经 nativeAudioBridge 的全局入口分发（本模块只订阅，不另装 qqplayerOnNativeEvent）。
 */
export function initSync() {
  if (initialized) return;
  initialized = true;
  if (!syncEnabled()) return;
  ensureSubscribed();
  syncNow();
}

/** 卸载：取消订阅 + 清下载进度（App onUnmounted 调用） */
export function stopSync() {
  for (const unsub of unsubs) {
    try {
      unsub();
    } catch {
      /* 忽略 */
    }
  }
  unsubs = [];
  initialized = false;
  subscribed = false;
  activeDownloads.clear();
  refreshSyncState();
}

// ---------- 内部：assetStatus 回执分发（ensureAsset 挂起的查询） ----------
function handleAssetStatus(payload) {
  if (!payload || payload.requestId == null) return;
  const resolve = pendingQueries.get(payload.requestId);
  if (!resolve) return; // 已超时/已消费的回执：忽略
  resolve(payload);
}

// ---------- 测试复位 ----------
export function _resetSyncForTests() {
  for (const unsub of unsubs) {
    try {
      unsub();
    } catch {
      /* 忽略 */
    }
  }
  unsubs = [];
  initialized = false;
  subscribed = false;
  requestSeq = 0;
  pendingQueries.clear();
  activeDownloads.clear();
  downloadBatch.length = 0;
  downloadBatchTimer = null;
  syncInFlight = false;
  syncState.lastSyncAt = null;
  syncState.syncing = false;
  syncState.lastError = "";
  syncState.pendingCount = 0;
  syncState.progress = { received: 0, total: 0 };
}
