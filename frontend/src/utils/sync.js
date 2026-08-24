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

/** 逐项下载状态（同步管理页下载面板数据源）：
 *  { [path]: {name, status:'queued'|'downloading'|'done'|'failed', received, total,
 *             error, url, sha256, size} }
 *  done/failed 条目保留（供重试 / 清除）；url/sha256/size 留存供 retryFailed 重建消息。 */
export const syncDownloads = reactive({});

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

/** 资产标识的稳定哈希：优先 SHA-256（crypto.subtle），不可用时回落确定性 FNV-1a 64 位。
 * 注意：WKWebView 个别场景 crypto.subtle.digest 的 Promise 可能永不 resolve（而非 reject），
 * 用 Promise.race 500ms 超时兜底，避免调用方（如批量下载 buildSongItems）永久挂起。 */
async function assetHash(identity) {
  const input = String(identity || "");
  try {
    if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
      const buf = await Promise.race([
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
        new Promise((_, reject) => setTimeout(() => reject(new Error("digest timeout")), 500)),
      ]);
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
 * @param {{download?:boolean}} [opts] 显式 download:true → 未下载时无条件发起下载
 *   （阅读器等既有「打开即后台下载」链路用）；默认行为 = autoPrefetchEnabled() 决定：
 *   开启才下载，关闭只查不下载（播放本地优先：已下载切本地、未下载保持远程）
 * @returns {Promise<string|null>} 已存在 → resolve(localURL)；不存在 → resolve(null)
 *   （不阻塞、不等待下载完成；调用方保持远程播放即可）
 */
export function ensureAsset({ path, url, sha256, size } = {}, opts = {}) {
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
        // 本地没有：仅显式 download:true 或「自动预取」开关开启时才批量发起下载
        // （同 tick 内多条请求合并成一次 syncDownload）；默认关 = 只查不下载，
        // 调用方（播放器）保持远程播放，下载由同步管理页显式触发。
        if (opts.download === true || autoPrefetchEnabled()) {
          queueDownload({ url, path, sha256: sha256 || "", size: size || 0 });
        }
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

// ---------- 本地资产 HTTP 映射（离线阅读/词典资产读取） ----------

/** 壳内 MiniHTTPServer 固定端口（对齐 Swift MiniHTTPServer.fixedPort = 17888） */
export const LOCAL_SERVER_ORIGIN = "http://127.0.0.1:17888";

/**
 * 本地资产 file:// URL → 本地 HTTP URL（WKWebView 可 fetch 读取）。
 * 壳内 MiniHTTPServer 以 /native-assets/ 路由 serve 沙盒 qqplayer-assets/ 目录：
 *   file:///.../Documents/qqplayer-assets/books/<hash>.epub
 *     → http://127.0.0.1:17888/native-assets/books/<hash>.epub
 * 解析失败返回 null（调用方回退远程加载）。
 */
export function localAssetHTTPURL(localURL) {
  if (!localURL || typeof localURL !== "string") return null;
  const m = String(localURL).match(/qqplayer-assets\/(.+)$/);
  if (!m) return null;
  return LOCAL_SERVER_ORIGIN + "/native-assets/" + m[1];
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
  // 同步管理面板：条目状态流转（queued → downloading）；done/failed 后不再回退
  const entry = syncDownloads[path];
  if (entry) {
    if (typeof payload.received === "number") entry.received = payload.received;
    if (typeof payload.total === "number" && payload.total > 0) entry.total = payload.total;
    if (entry.status !== "done" && entry.status !== "failed") entry.status = "downloading";
  }
  refreshSyncState();
}

function handleAssetDone(payload) {
  if (payload && payload.path) {
    activeDownloads.delete(payload.path);
    const entry = syncDownloads[payload.path];
    if (entry) {
      entry.status = payload.ok ? "done" : "failed";
      entry.error = payload.error || "";
      if (payload.ok && entry.total > 0) entry.received = entry.total;
    }
  }
  refreshSyncState();
}

// ---------- 资产占用回执（fetchAssetsSize） ----------
let assetsSizeWaiters = new Set(); // Set<resolve>；原生回执/超时二者先到先结算

function handleAssetsSize(payload) {
  const total = payload && typeof payload.total === "number" ? payload.total : null;
  for (const resolve of [...assetsSizeWaiters]) {
    assetsSizeWaiters.delete(resolve);
    resolve(total);
  }
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
  unsubs.push(onNativeEvent("assetsSize", handleAssetsSize));
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

// ---------- 批量资产下载（同步管理页 · 阶段3） ----------

/** 歌曲列表 → 下载项数组（批量复用 assetForSong；path 缺失的流媒体条目自动跳过） */
export async function buildSongItems(songs) {
  if (!Array.isArray(songs)) return [];
  const items = await Promise.all(songs.map((s) => assetForSong(s)));
  return items.filter(Boolean);
}

/** 图书列表 → 下载项数组（批量复用 assetForBook；缺 id 条目自动跳过） */
export async function buildBookItems(books) {
  if (!Array.isArray(books)) return [];
  const items = await Promise.all(books.map((b) => assetForBook(b)));
  return items.filter(Boolean);
}

/** 下载项展示名：path 去类型前缀（audio/<hash>.m4a → <hash>.m4a） */
function displayNameOf(path) {
  return String(path || "").replace(/^(audio|books|dicts)\/+/, "");
}

/**
 * 批量下载：items=[{url,path,sha256,size}] → 一次 syncDownload 消息
 * （原生串行队列 + 断点续传已有；条目先登记到 syncDownloads 供面板追踪）。
 * 返回是否已发出（非原生环境 / 空列表 → false，静默 no-op）。
 */
export function syncAssets(items) {
  if (!Array.isArray(items) || !items.length) return false;
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  ensureSubscribed();
  const valid = [];
  for (const item of items) {
    if (!item || !item.path || !item.url) continue;
    valid.push(item);
    syncDownloads[item.path] = {
      name: displayNameOf(item.path),
      status: "queued",
      received: 0,
      total: item.size || 0,
      error: "",
      url: item.url,
      sha256: item.sha256 || "",
      size: item.size || 0,
    };
  }
  if (!valid.length) return false;
  nativePost({
    cmd: "syncDownload",
    items: valid.map(({ url, path, sha256, size }) => ({
      url,
      path,
      sha256: sha256 || "",
      size: size || 0,
    })),
  });
  return true;
}

/** 清除已完成（done/failed）的下载状态条目（不影响原生已下载文件） */
export function clearFinished() {
  for (const path of Object.keys(syncDownloads)) {
    const st = syncDownloads[path].status;
    if (st === "done" || st === "failed") delete syncDownloads[path];
  }
}

/** 重新下载失败项（条目内保留 url/sha256/size，直接重建消息；非失败态 no-op） */
export function retryFailed(path) {
  const entry = syncDownloads[path];
  if (!entry || entry.status !== "failed") return false;
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  ensureSubscribed();
  entry.status = "queued";
  entry.received = 0;
  entry.error = "";
  nativePost({
    cmd: "syncDownload",
    items: [{ url: entry.url, path, sha256: entry.sha256 || "", size: entry.size || 0 }],
  });
  return true;
}

/** 清理原生侧资产文件（scope: 'all'|'audio'|'books'|'dicts'；原生命令由 iOS 侧实现） */
export function clearAssets(scope) {
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  nativePost({ cmd: "deleteAssets", scope: scope || "all" });
  return true;
}

/** 资产占用查询超时（ms）：原生无回执不挂起调用方 */
export const ASSETS_SIZE_TIMEOUT_MS = 8000;

/**
 * 查询原生侧资产占用：发 assetsSize 命令，原生回执 push('assetsSize', {total}) →
 * resolve(bytes)；超时 / 非原生环境 → resolve(null)。
 */
export function fetchAssetsSize() {
  if (!syncEnabled() || !iosBridgeAvailable()) return Promise.resolve(null);
  ensureSubscribed();
  return new Promise((resolve) => {
    setTimeout(() => {
      assetsSizeWaiters.delete(resolve);
      resolve(null);
    }, ASSETS_SIZE_TIMEOUT_MS);
    assetsSizeWaiters.add(resolve);
    nativePost({ cmd: "assetsSize" });
  });
}

// ---------- 自动预取开关（localStorage 持久化；默认关） ----------
const AUTO_PREFETCH_KEY = "qqplayer.autoPrefetch";

/** 播放时自动预取是否开启（默认关；'qqplayer.autoPrefetch' === 'on'） */
export function autoPrefetchEnabled() {
  try {
    return localStorage.getItem(AUTO_PREFETCH_KEY) === "on";
  } catch {
    return false;
  }
}

/** 设置自动预取开关（持久化 localStorage；返回生效值） */
export function setAutoPrefetch(on) {
  try {
    if (on) localStorage.setItem(AUTO_PREFETCH_KEY, "on");
    else localStorage.removeItem(AUTO_PREFETCH_KEY);
  } catch {
    /* 忽略 */
  }
  return autoPrefetchEnabled();
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
  for (const k of Object.keys(syncDownloads)) delete syncDownloads[k];
  assetsSizeWaiters.clear();
}
