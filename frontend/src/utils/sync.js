// QQPlayer iOS 前端同步模块（阶段3 · E1）
//
// 职责：
//   - syncNow()：拉取桌面 /api/sync/manifest 全量清单（不缓存），version 变化时
//     全量写入 IndexedDB（key: sync:songs / sync:playlists / sync:favorites /
//     sync:books / sync:dicts，经 cacheDb.setCache，ttl=0 不自动过期）
//   - ensureAsset()：本地资产查询（hasAsset → assetStatus 回执，Promise 化）→
//     存在返回 localURL；不存在且「自动预取」开启（或调用方显式 download:true）
//     才发 syncDownload 后台下载并 resolve(null)——默认关 = 只查不下载
//   - nativeMetaSave / nativeMetaLoad：元数据文件持久化兜底桥（Documents/meta/
//     {kind}.json；iOS 壳 IndexedDB 重启不可靠，播放列表/收藏落文件双写）
//   - pollCommands()：指令轮询执行器（T2）——桌面写指令（pushDownload 推送下载 /
//     remoteDelete 远程删除）→ iOS 轮询拉取执行 + 回执 ack；60s interval 随 appState
//     启停；getDeviceId() 经原生桥取 Keychain 持久设备标识（超时回落 null）。
//   - reportAssets()：资产清单上报（触发式）——assetIndex + assetsSize 回执 →
//     POST /api/sync/device/assets（桌面端存储面板数据源）。
//   - initSync()：经 nativeAudioBridge.onNativeEvent 订阅（syncAssetProgress /
//     syncAssetDone / assetStatus / appState / metaLoaded / deviceId），并执行首次
//     syncNow()。注意：window.qqplayerOnNativeEvent 全局入口由 nativeAudioBridge
//     独占安装，本模块只订阅不分发，避免双处理。
//
// 桥契约（与 iOS 壳 Swift 侧对齐）：
//   Web→Native：window.qqplayerIosBridge.postMessage(msg)
//     {cmd:"syncDownload", items:[{url,path,sha256,size}]}  批量下载请求
//     {cmd:"hasAsset", path, requestId}                     本地资产查询
//     {cmd:"cancelDownloads"}                               取消全部下载
//     {cmd:"metaSave", kind, json}                          元数据写文件（fire-and-forget）
//     {cmd:"metaLoad", kind, requestId}                     元数据读文件（回执 metaLoaded）
//     {cmd:"getDeviceId", requestId}                        设备标识查询（回执 deviceId）
//   Native→Web：window.qqplayerOnNativeEvent(name, payload)
//     {name:"syncAssetProgress", path, received, total}     total 未知为 0
//     {name:"syncAssetDone", path, ok, sha256, localURL, error?}
//     {name:"assetStatus", requestId, path, exists, localURL}
//     {name:"metaLoaded", requestId, kind, json?}           元数据文件读取回执
//     {name:"deviceId", requestId, deviceId}                getDeviceId 回执（Keychain）
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
import { apiGet, apiPost, resolveServerUrl } from "./apiClient.js";
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
 * 拉取桌面 manifest 并缓存元数据集合（syncNow / syncAll 共用）。
 * @returns {Promise<{ok:boolean, changed?:boolean, version?:string, manifest?:object, message?:string}>}
 */
async function fetchAndCacheManifest() {
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
  return { ok: true, changed, version, manifest };
}

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
    const mr = await fetchAndCacheManifest();
    if (!mr.ok) {
      return { ok: false, message: mr.message, status: mr.status };
    }
    syncState.lastSyncAt = Date.now();
    syncState.lastError = "";
    const counts = {};
    for (const key of COLLECTION_KEYS) {
      counts[key] = Array.isArray(mr.manifest[key]) ? mr.manifest[key].length : 0;
    }
    // 自动更新（默认关）：同步成功后异步拉 assetIndex → 对比 sha256 → 应用可更新项
    // （fire-and-forget，不阻塞 syncNow 返回；失败静默，下次同步再试）
    if (autoUpdateEnabled()) {
      runAutoUpdate(mr.manifest.songs).catch(() => {});
    }
    // T2：同步成功后顺带拉一次指令 + 上报资产清单（fire-and-forget，不阻塞）——
    // 覆盖负一屏同步中心手动同步「顺带拉指令」的语义
    pollCommands().catch(() => {});
    reportAssets().catch(() => {});
    return { ok: true, changed: mr.changed, version: mr.version, counts };
  } catch (e) {
    syncState.lastError = (e && e.message) || "同步失败";
    return { ok: false, message: syncState.lastError };
  } finally {
    syncInFlight = false;
    syncState.syncing = false;
  }
}

/** 自动更新：对比本地注册表 → 对 sha256 变化的资产应用更新（失败静默） */
async function runAutoUpdate(songs) {
  const local = await fetchAssetIndex();
  const updates = await computeUpdateList(Array.isArray(songs) ? songs : [], local);
  if (updates.length) await applyUpdates(updates);
}

// ---------- 资产标识 → 沙盒路径（内容寻址） ----------

/** 扩展名（含点，小写；无扩展名返回 ""） */
function extOf(name) {
  const m = String(name || "").match(/\.([A-Za-z0-9]+)$/);
  return m ? "." + m[1].toLowerCase() : "";
}

/** 资产标识的稳定哈希：优先 SHA-256（crypto.subtle），不可用时回落确定性 FNV-1a 64 位。
 * 注意：WKWebView 个别场景 crypto.subtle.digest 的 Promise 可能永不 resolve（而非 reject），
 * 用 Promise.race 500ms 超时兜底，避免调用方（如批量下载 buildSongItems）永久挂起。
 * 导出供封面缓存（coverAssetKey）与歌词文件兜底（lyricKindKey）共用同一哈希函数。 */
export async function stableHash(identity) {
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
 *  sha256 = manifest 条目自带的内容哈希（T1 契约：manifest songs[].sha256）；
 *  老清单/缺字段 → ""（原生侧空值跳过内容校验，文件名仍用资产标识哈希做内容寻址）。
 *  下载项同时是「资产注册表路径」的权威来源：本地注册表按此 path 与 manifest 对照。 */
export async function assetForSong(song) {
  if (!song || !song.path) return null;
  const url = resolveServerUrl("/api/audio?path=" + encodeURIComponent(song.path));
  const hash = await stableHash(song.path);
  return {
    url,
    path: "audio/" + hash + (extOf(song.path) || ".m4a"),
    sha256: song.sha256 || "",
    size: song.size || 0,
  };
}

/** 词典 → 下载项（manifest dicts 条目：{name, path, size, mtime}）；sha256 暂为空（同上） */
export async function assetForDict(dict) {
  if (!dict || !dict.path) return null;
  const url = resolveServerUrl("/api/sync/dicts/file?path=" + encodeURIComponent(dict.path));
  const hash = await stableHash(dict.path);
  return {
    url,
    path: "dicts/" + hash + (extOf(dict.path) || ".mdx"),
    sha256: dict.sha256 || "",
    size: dict.size || 0,
  };
}

/** 书 → 下载项（manifest books 条目：{id, title, progress}）；sha256 暂为空（同上） */
export async function assetForBook(book) {
  if (!book || !book.id) return null;
  const url = resolveServerUrl("/api/books/" + encodeURIComponent(book.id) + "/file");
  const hash = await stableHash(book.id);
  return { url, path: "books/" + hash + ".epub", sha256: book.sha256 || "", size: book.size || 0 };
}

// ---------- 封面/歌词缓存 key（阶段 F1/F2：封面离线缓存 + 歌词文件兜底） ----------
// 两者共用 stableHash：跨会话确定、同 path 同 key；哈希为纯十六进制，无路径穿越风险
// （原生 MetaStore.fileURL 亦按 kind 净化，双保险）。

/** 封面资产沙盒路径：covers/<path 哈希>.jpg（前端不知封面实际格式，统一按 JPEG 命名；
 *  MiniHTTPServer 按扩展名回 Content-Type，WKWebView 图片解码器按魔数嗅探，PNG 内容也能显示） */
export async function coverAssetKey(path) {
  if (!path) return null;
  const hash = await stableHash(path);
  return "covers/" + hash + ".jpg";
}

/** 封面下载项 {url, path, sha256, size}（url 为桌面 cover 端点；sha256 空 → 原生跳过内容校验）
 *  @param {number} [size] 可选：manifest 封面文件大小（cover_source=file 时原生 size 校验用） */
export async function coverItemFor(path, size = 0) {
  if (!path) return null;
  return {
    url: resolveServerUrl("/api/cover?path=" + encodeURIComponent(path)),
    path: await coverAssetKey(path),
    sha256: "",
    size: size || 0,
  };
}

/** 歌词文件兜底 kind：lyric:<path 哈希>（Documents/meta/lyric:<hash>.json） */
export async function lyricKindKey(path) {
  if (!path) return null;
  const hash = await stableHash(path);
  return "lyric:" + hash;
}

// ---------- 资产查询与下载（ensureAsset） ----------
let requestSeq = 0;
const pendingQueries = new Map(); // requestId → resolve(localURL|null)

/** hasAsset 回执等待超时（ms）：原生无回执时不挂起调用方 */
export const ASSET_QUERY_TIMEOUT_MS = 8000;

/**
 * 查询本地资产并（必要时）发起后台下载。
 * @param {{path:string, url:string, sha256?:string, size?:number}} item 沙盒相对路径 + 桌面绝对 URL
 * @param {{download?:boolean, skipAutoDownload?:boolean}} [opts]
 *   download:true → 未下载时无条件发起下载（阅读器等既有「打开即后台下载」链路用）
 *   skipAutoDownload:true → 未下载也不下载（即使 autoPrefetch 开启；封面查询用——
 *     查询路径只回「有没有」，下载决策交给调用方显式 cacheCover 节流）
 *   默认行为 = autoPrefetchEnabled() 决定：开启才下载，关闭只查不下载
 *   （播放本地优先：已下载切本地、未下载保持远程）
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
        // 本地没有：仅显式 download:true 或「自动预取」开关开启（skipAutoDownload 可强制只查）
        // 时才批量发起下载（同 tick 内多条请求合并成一次 syncDownload）；默认关 = 只查不下载，
        // 调用方（播放器）保持远程播放，下载由同步管理页显式触发。
        if (opts.download === true || (autoPrefetchEnabled() && !opts.skipAutoDownload)) {
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

// ---------- 封面离线缓存（阶段 F1：iOS 壳封面本地优先） ----------
// 模式对齐 maybePrefetchAsset：播放/列表展示时先查沙盒，命中切本地 URL；未命中保持远程
// 并（由调用方按节流策略）后台缓存。桌面/非壳 → 全部 no-op，行为零变化。

/**
 * 查询封面本地缓存：iOS 壳内 hasAsset 查询 → 命中返回本地 HTTP URL；未命中返回 null。
 * 只查不下载（skipAutoDownload：即使 autoPrefetch 开启也不在这里触发下载——
 * 列表可见行全部查询时不能刷爆原生串行下载队列，下载由调用方 cacheCover 显式节流）。
 * 非 iOS 壳 / path 非法 → resolve(null)（静默 no-op）。
 */
export async function cachedCoverURL(path) {
  if (!path || !syncEnabled() || !iosBridgeAvailable()) return null; // 非 iOS 壳：静默 no-op
  const item = await coverItemFor(path);
  if (!item) return null;
  const localURL = await ensureAsset(item, { skipAutoDownload: true });
  if (!localURL) return null;
  return localAssetHTTPURL(localURL);
}

/**
 * 封面后台缓存（fire-and-forget）：未下载时无条件发 syncDownload（已存在则自动跳过下载）。
 * 调用方负责节流（useCoverURL：播放中 + 列表前 N 行），避免几百首封面同时灌入下载队列。
 * 失败静默（下载失败不影响远程封面展示）。非 iOS 壳 no-op。
 */
export function cacheCover(path) {
  if (!path || !syncEnabled() || !iosBridgeAvailable()) return; // 非 iOS 壳：静默 no-op
  coverItemFor(path)
    .then((item) => {
      if (item) ensureAsset(item, { download: true });
    })
    .catch(() => {
      /* 静默 */
    });
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

// ---------- 资产占用回执（fetchAssetsSize / fetchAssetsSizeDetailed 共用 waiter） ----------
let assetsSizeWaiters = new Set(); // Set<fn(payload|null)>；原生回执/超时先到先结算

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
// T2：前台 active 时同步 + 轮询指令 + 启动轮询 interval；后台/失活停止轮询
//（WKWebView 后台 JS 定时器本就挂起，stopCommandPolling 防止回前台时堆积 tick）。
// appActive 默认 true：initSync 即启动轮询（壳在 webReady 后会补推真实 appState，
// 首个非 active 事件到达即停止），保证前台启动第一轮指令不被漏掉。
let appActive = true;

function handleAppState(payload) {
  const state = payload && payload.state;
  if (state === "active") {
    appActive = true;
    syncNow(); // 前台恢复：重新拉取 manifest（元数据可能已变）
    pollCommands().catch(() => {}); // 顺带拉指令（fire-and-forget；失败静默下轮再试）
    ensureCommandPolling();
  } else {
    appActive = false;
    stopCommandPolling();
  }
}

// ---------- T2：设备标识（getDeviceId 原生桥） ----------
// Keychain 持久 deviceId：nativePost getDeviceId → 等 deviceId 事件回执
//（pendingQueries 模式同 assetStatus/metaLoaded）。结果缓存模块级 Promise（并发共享）；
// 非原生环境 / 超时（3s）→ resolve(null)——指令轮询拿不到 deviceId 仍可拉广播指令
//（GET pending 的 device_id 参数可选，拿不到就传空）。

/** getDeviceId 回执等待超时（ms）：原生无回执不挂起轮询 */
export const DEVICE_ID_TIMEOUT_MS = 3000;

let deviceIdSeq = 0;
let deviceIdPromise = null; // 结果缓存（Promise；null=未查询过）
let deviceIdTimer = null; // 当前查询超时句柄（测试复位时取消，防挂起 promise 跨用例续跑）
const deviceIdWaiters = new Map(); // requestId → resolve(deviceId|null)

/** deviceId 回执分发：按 requestId 结算挂起的 getDeviceId 查询 */
function handleDeviceId(payload) {
  if (!payload || payload.requestId == null) return;
  const resolve = deviceIdWaiters.get(payload.requestId);
  if (!resolve) return; // 已超时/已消费的回执：忽略
  resolve(payload.deviceId);
}

/**
 * 获取设备标识（Keychain 持久 deviceId）。结果缓存模块变量（首次查询后复用）；
 * 非原生环境 / 原生无回执（超时 3s）→ resolve(null)。
 * @returns {Promise<string|null>}
 */
export function getDeviceId() {
  if (!syncEnabled() || !iosBridgeAvailable()) return Promise.resolve(null);
  if (deviceIdPromise) return deviceIdPromise;
  ensureSubscribed(); // 需要 deviceId 事件订阅
  const requestId = String(++deviceIdSeq); // 字符串：与 Swift 侧 as? String 解析对齐
  deviceIdPromise = new Promise((resolve) => {
    deviceIdTimer = setTimeout(() => {
      if (deviceIdWaiters.has(requestId)) {
        deviceIdWaiters.delete(requestId);
        resolve(null);
      }
    }, DEVICE_ID_TIMEOUT_MS);
    deviceIdWaiters.set(requestId, (deviceId) => {
      clearTimeout(deviceIdTimer);
      deviceIdTimer = null;
      deviceIdWaiters.delete(requestId);
      resolve(typeof deviceId === "string" && deviceId ? deviceId : null);
    });
    nativePost({ cmd: "getDeviceId", requestId });
  });
  return deviceIdPromise;
}

// ---------- T2：指令轮询调度（60s interval + appState 启停） ----------

/** 指令轮询间隔（ms） */
export const COMMAND_POLL_MS = 60000;

let commandPollTimer = null; // setInterval 句柄（仅 appState active 时存在）

/** 启动指令轮询 interval（仅 active 时；已启动不重复；幂等） */
export function ensureCommandPolling() {
  if (!appActive) return;
  if (commandPollTimer) return;
  commandPollTimer = setInterval(() => {
    pollCommands().catch(() => {});
  }, COMMAND_POLL_MS);
}

/** 停止指令轮询 interval（inactive/background/stopSync 调用；幂等） */
export function stopCommandPolling() {
  if (commandPollTimer) {
    clearInterval(commandPollTimer);
    commandPollTimer = null;
  }
}

// ---------- T2：指令轮询执行器（pollCommands） ----------
// 纯拉模型（iOS 不开端口）：GET pending（拉取即标记 executing 防重复）→ 逐条执行
//（串行：避免下载队列爆炸）→ 每条回执 ack（失败静默——后端 executing 超时 10 分钟
// 可重拉兜底）。

/**
 * 轮询拉取并执行桌面待办指令（pushDownload / remoteDelete），逐条回执 ack。
 * @returns {Promise<{ok:boolean, executed:number}>} executed=已处理指令数
 *   （含执行失败的——ok 细节在各自 ack 里；拉取失败 → {ok:false, executed:0} 静默）
 */
export async function pollCommands() {
  if (!syncEnabled() || !iosBridgeAvailable()) return { ok: false, executed: 0 };
  const deviceId = await getDeviceId();
  const url =
    "/api/sync/commands/pending" + (deviceId ? "?device_id=" + encodeURIComponent(deviceId) : "");
  let r;
  try {
    r = await apiGet(url);
  } catch {
    return { ok: false, executed: 0 }; // 网络失败静默（下轮再试）
  }
  if (!r || !r.ok) return { ok: false, executed: 0 };
  const commands = Array.isArray(r.data && r.data.commands) ? r.data.commands : [];
  if (!commands.length) return { ok: true, executed: 0 };
  let executed = 0;
  for (const cmd of commands) {
    try {
      await executeCommand(cmd, deviceId); // 串行：逐条执行 + 回执
      executed += 1;
    } catch {
      executed += 1; // 单条异常也视为已处理（executeCommand 内部已兜底 ack）
    }
  }
  // 执行过指令 → 顺带上报资产清单（fire-and-forget；失败静默）
  reportAssets().catch(() => {});
  return { ok: true, executed };
}

/**
 * 执行单条指令并回执 ack（pushDownload / remoteDelete / 未知类型）。
 * 回执网络失败静默（后端 executing 超时重拉兜底）。
 */
async function executeCommand(cmd, deviceId) {
  const id = cmd && cmd.id;
  const type = cmd && cmd.type;
  let ok = true;
  let error = "";
  let detail = null;
  try {
    if (type === "pushDownload") {
      const res = await handlePushDownload(cmd.payload);
      ok = res.ok;
      error = res.error || "";
      detail = res.detail || null;
    } else if (type === "remoteDelete") {
      const paths = Array.isArray(cmd.payload && cmd.payload.paths) ? cmd.payload.paths : [];
      nativePost({ cmd: "deleteAssets", paths }); // fire-and-forget：发出即视为提交
      detail = { deleted: paths.length };
    } else {
      ok = false;
      error = "unknown command type: " + type;
    }
  } catch (e) {
    ok = false;
    error = (e && e.message) || "command failed";
  }
  if (id != null) {
    const body = { device_id: deviceId || "", ok: !!ok };
    if (error) body.error = error;
    if (detail) body.detail = detail;
    try {
      await apiPost("/api/sync/commands/" + encodeURIComponent(String(id)) + "/ack", body);
    } catch {
      /* 回执网络失败静默 */
    }
  }
}

/**
 * pushDownload：payload.items[].path 是曲库歌曲路径（music/xxx.mp3）→ 从本地
 * manifest 缓存（sync:songs）反查歌曲对象（严格相等匹配）→ buildSongItems 构造
 * 下载项（url 走 resolveServerUrl、本地资产路径走 stableHash，与现有同步完全一致）
 * → syncAssets 登记并发出 syncDownload。未匹配的 path 记入 skipped，不阻塞整体。
 * @returns {Promise<{ok:boolean, error?:string, detail?:{skipped:string[]}}>}
 */
async function handlePushDownload(payload) {
  const items = Array.isArray(payload && payload.items) ? payload.items : [];
  const paths = items.map((i) => i && i.path).filter((p) => typeof p === "string" && p);
  if (!paths.length) return { ok: false, error: "no valid items" }; // items 空/全非法
  const cached = await getCache("sync:songs");
  const list = Array.isArray(cached) ? cached : [];
  const byPath = new Map();
  for (const s of list) {
    if (s && s.path) byPath.set(s.path, s);
  }
  const matched = [];
  const skipped = [];
  for (const p of paths) {
    const song = byPath.get(p);
    if (song) matched.push(song);
    else skipped.push(p);
  }
  if (!matched.length) {
    // 全部反查失败：ok=false（detail 附 skipped 便于桌面端对账）
    return { ok: false, error: "no valid items", detail: { skipped } };
  }
  const downloadItems = await buildSongItems(matched);
  if (!downloadItems.length) {
    return { ok: false, error: "no valid items", detail: skipped.length ? { skipped } : null };
  }
  syncAssets(downloadItems);
  return { ok: true, detail: skipped.length ? { skipped } : null }; // 部分跳过：ok=true + skipped
}

// ---------- T2：资产清单上报（reportAssets，触发式） ----------
// syncNow() 成功后 + pollCommands() 执行过指令后（fire-and-forget）触发；
// deviceId 拿不到（非 iOS/超时）→ 静默跳过。

/**
 * 资产清单上报：assetIndex 回执 {assets} + assetsSize 回执 {total, byType} →
 * POST /api/sync/device/assets。失败静默（下轮同步再报）。
 * @returns {Promise<boolean>} 是否成功上报
 */
export async function reportAssets() {
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  const deviceId = await getDeviceId();
  if (!deviceId) return false; // 拿不到设备标识：静默跳过上报
  const [assets, sizeData] = await Promise.all([fetchAssetIndex(), fetchAssetsSizeDetailed()]);
  if (!assets.length) return false; // 注册表空（老版本升级）→ 跳过
  const body = {
    device_id: deviceId,
    assets,
    total: sizeData && typeof sizeData.total === "number" ? sizeData.total : null,
    byType: sizeData && sizeData.byType ? sizeData.byType : {},
  };
  try {
    const r = await apiPost("/api/sync/device/assets", body);
    return !!(r && r.ok);
  } catch {
    return false; // 上报失败静默
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
  unsubs.push(onNativeEvent("assetIndex", handleAssetIndex));
  unsubs.push(onNativeEvent("assetsDeleted", handleAssetsDeleted));
  unsubs.push(onNativeEvent("metaLoaded", handleMetaLoaded));
  unsubs.push(onNativeEvent("deviceId", handleDeviceId));
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
  ensureCommandPolling(); // T2：initSync 后启动指令轮询 interval（仅 appState active 时运行）
}

/** 卸载：取消订阅 + 清下载进度 + 停指令轮询（App onUnmounted 调用） */
export function stopSync() {
  stopCommandPolling(); // T2：清理轮询 interval
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

// ---------- 内部：metaLoaded 回执分发（nativeMetaLoad 挂起的读取） ----------
function handleMetaLoaded(payload) {
  if (!payload || payload.requestId == null) return;
  const resolve = pendingMetaLoads.get(payload.requestId);
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

/**
 * 歌曲列表 → 音频+封面下载项数组（任务 G：封面随歌一起同步）。
 * 每首歌生成两个下载项：音频（assetForSong）+ 封面（coverItemFor，封面本地
 * 优先链路共用同一下载项格式）；path 缺失的流媒体条目整首跳过——它没有本地
 * 封面/歌词语义。返回拍平 items（音频+封面交错）；空/全跳过 → []。
 * 同步面板计数 items.length 自动含封面（面板文案为「N 个文件」，无需区分）。
 */
export async function buildSongSyncItems(songs) {
  if (!Array.isArray(songs)) return [];
  const lists = await Promise.all(
    songs.map(async (s) => {
      if (!s || !s.path) return []; // 流媒体/缺 path：整首跳过
      const [audio, cover] = await Promise.all([assetForSong(s), coverItemFor(s.path)]);
      return [audio, cover].filter(Boolean); // 防御：理论上两者均非空
    }),
  );
  return lists.flat();
}

/** 图书列表 → 下载项数组（批量复用 assetForBook；缺 id 条目自动跳过） */
export async function buildBookItems(books) {
  if (!Array.isArray(books)) return [];
  const items = await Promise.all(books.map((b) => assetForBook(b)));
  return items.filter(Boolean);
}

/** 下载项展示名：path 去类型前缀（audio/<hash>.m4a → <hash>.m4a；covers/ 同里去前缀） */
function displayNameOf(path) {
  return String(path || "").replace(/^(audio|books|dicts|covers)\/+/, "");
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
      wifiOnly: wifiOnlyEnabled(), // T3：仅 Wi-Fi 开关，原生侧蜂窝下挂起
    })),
  });
  return true;
}

/** 歌词同步：小并发上限（同时最多 5 首在途；126 首全并发会瞬时打爆后端） */
export const LYRIC_SYNC_CONCURRENCY = 5;

/** 歌词同步总超时兜底（ms）：60s 内尽力，超时静默返回已完部分（不阻塞同步面板） */
export const LYRIC_SYNC_TOTAL_TIMEOUT_MS = 60000;

/**
 * 同步歌词落文件（任务 G）：逐首调 /api/lyric（prefer=local，构造与 useLyric.js
 * 的 lyricUrl 同构——该函数未导出，这里本地复制等价逻辑，改端点时两处需同步），
 * 成功且 lines 非空 → nativeMetaSave(lyricKindKey(path), {lines, format, source})。
 * 取舍：
 *   - 限流：固定小并发池（≤LYRIC_SYNC_CONCURRENCY 同时在途），避免批量歌词请求
 *     同时打后端；并发上限与音频下载原生队列（≤3）互不干扰（互不阻塞）
 *   - 总超时兜底：Promise.race 60s，超时返回已完部分（worker 仍在后台尽力跑完，
 *     写文件不中断——同步面板不因歌词拖住/报错）
 *   - 失败 / 无歌词（404 / 空 lines）→ 跳过：不写文件、不抛错、不计 ok
 *   - 非 iOS 壳（无桥）→ 不请求不写（与 syncAssets 同门控），返回 {ok:0, total:0}
 * @returns {Promise<{ok:number, total:number}>} ok=成功落文件数，total=尝试数（调用方可 toast）
 */
export async function syncLyricsForSongs(songs) {
  const list = (Array.isArray(songs) ? songs : []).filter(
    (s) => s && typeof s.path === "string" && s.path,
  );
  if (!list.length) return { ok: 0, total: 0 };
  if (!syncEnabled() || !iosBridgeAvailable()) return { ok: 0, total: 0 };
  let ok = 0;
  let next = 0; // 共享游标：worker 逐首取任务（同步自增，无竞态）
  const worker = async () => {
    while (next < list.length) {
      const song = list[next++];
      try {
        const r = await apiGet(
          "/api/lyric?path=" + encodeURIComponent(song.path) + "&prefer=local",
        );
        const data = r && r.ok ? r.data || {} : null;
        const lines = data && Array.isArray(data.lines) ? data.lines : [];
        if (!lines.length) continue; // 无歌词：跳过（不写文件、不报错）
        const kind = await lyricKindKey(song.path);
        if (!kind) continue;
        // 失败静默：nativeMetaSave 参数非法/非壳内会自降级，这里 try 兜底不抛
        nativeMetaSave(
          kind,
          JSON.stringify({
            lines,
            format: typeof data.format === "string" ? data.format : null,
            source: typeof data.source === "string" ? data.source : null,
          }),
        );
        ok += 1;
      } catch {
        /* 单首失败静默：不影响其余歌词同步 */
      }
    }
  };
  const n = Math.min(LYRIC_SYNC_CONCURRENCY, list.length);
  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(resolve, LYRIC_SYNC_TOTAL_TIMEOUT_MS);
  });
  await Promise.race([Promise.all(Array.from({ length: n }, () => worker())), timeout]);
  clearTimeout(timeoutId); // worker 先跑完：及时清掉兜底定时器（超时分支已触发，clear 无害）
  return { ok, total: list.length };
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

/** 资产占用回执分发：waiter 统一收完整 payload（{total, byType}），由各查询函数取用 */
function handleAssetsSize(payload) {
  const data = payload && typeof payload === "object" ? payload : null;
  for (const resolve of [...assetsSizeWaiters]) {
    assetsSizeWaiters.delete(resolve);
    resolve(data);
  }
}

/** 发起 assetsSize 查询（pending promise + 回执 + 超时）；非原生环境立即 resolve(null) */
function requestAssetsSize() {
  if (!syncEnabled() || !iosBridgeAvailable()) return Promise.resolve(null);
  ensureSubscribed();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      assetsSizeWaiters.delete(settle);
      settle(null);
    }, ASSETS_SIZE_TIMEOUT_MS);
    const settle = (data) => {
      clearTimeout(timer);
      resolve(data);
    };
    assetsSizeWaiters.add(settle);
    nativePost({ cmd: "assetsSize" });
  });
}

/**
 * 查询原生侧资产占用：回执 {total} → resolve(bytes)；超时 / 非原生环境 → resolve(null)。
 * 兼容旧壳（只回 total 数字）。
 */
export async function fetchAssetsSize() {
  const data = await requestAssetsSize();
  return data && typeof data.total === "number" ? data.total : null;
}

/**
 * 查询原生侧资产占用明细：resolve({total, byType:{audio,covers,lyric,books,dicts,meta,other}})
 * （T3 契约：assetsSize 回执扩展）；超时 / 非原生环境 / 旧壳无 byType → resolve(null)。
 */
export async function fetchAssetsSizeDetailed() {
  const data = await requestAssetsSize();
  if (!data || typeof data.total !== "number") return null;
  const byType = data.byType && typeof data.byType === "object" ? data.byType : null;
  return byType ? { total: data.total, byType } : { total: data.total, byType: {} };
}

// ---------- 资产注册表（T3：assetIndex）与存储细分 ----------
let assetIndexWaiters = new Set(); // Set<fn(assets|null)>：原生回执/超时先到先结算

function handleAssetIndex(payload) {
  const assets = payload && Array.isArray(payload.assets) ? payload.assets : [];
  for (const cb of [...assetIndexWaiters]) {
    assetIndexWaiters.delete(cb);
    try {
      cb(assets);
    } catch {
      /* 忽略 */
    }
  }
}

/** 资产注册表查询超时（ms）：与 ASSET_QUERY_TIMEOUT_MS 同级，原生无回执不挂起调用方 */
export const ASSET_INDEX_TIMEOUT_MS = 8000;

/**
 * 查询原生侧资产注册表：发 assetIndex 命令，原生回执 push('assetIndex',
 * {assets: [{path, sha256, size}]}) → resolve(assets)。
 * 失败/超时/非原生环境 → resolve([])（空注册表 = 老版本升级场景，按「全部最新」处理，
 * 避免误报全量更新；缺失统计在空注册表下会全量补齐——一键拉全的语义）。
 */
export function fetchAssetIndex() {
  if (!syncEnabled() || !iosBridgeAvailable()) return Promise.resolve([]);
  ensureSubscribed();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      assetIndexWaiters.delete(settle);
      settle([]);
    }, ASSET_INDEX_TIMEOUT_MS);
    const settle = (assets) => {
      clearTimeout(timer);
      resolve(assets);
    };
    assetIndexWaiters.add(settle);
    nativePost({ cmd: "assetIndex" });
  });
}

// ---------- 更新 / 孤儿计算（T3：sha256 对比） ----------

/**
 * 可更新项计算：manifest songs（带 sha256）vs 本地资产注册表。
 * 判定 = 本地注册有该资产 && 本地 sha256 ≠ manifest sha256 → {path, name, kind, song}。
 * 首次升级策略：注册表不存在/为空（老版本升级，assets.json 未建）→ 全部视为最新，
 * 不标记可更新（避免误报全量更新）；注册表存在后严格对比。
 * @returns {Promise<Array<{path:string, name:string, kind:'audio', song:object}>>}
 */
export async function computeUpdateList(manifestSongs, localAssets) {
  const local = Array.isArray(localAssets) ? localAssets : [];
  if (!local.length) return []; // 首次升级/注册表为空：全部视为最新
  const byPath = new Map();
  for (const a of local) {
    if (a && a.path) byPath.set(a.path, a);
  }
  const out = [];
  for (const song of Array.isArray(manifestSongs) ? manifestSongs : []) {
    if (!song || !song.path) continue;
    // 音频更新：内容哈希变化（内嵌封面随音频一起更新）
    if (song.sha256) {
      const item = await assetForSong(song);
      if (item) {
        const localAsset = byPath.get(item.path);
        if (localAsset && localAsset.sha256 !== song.sha256) {
          out.push({ path: item.path, name: song.name || song.path, kind: "audio", song });
        }
      }
    }
    // 封面更新：文件封面（cover_source=file）的封面文件 size 变化 → 封面过期
    // （本地注册表 cover 条目 size = 下载时实际大小；manifest.cover_size = 当前封面文件大小）
    if (song.cover_source === "file" && song.cover_size > 0) {
      const cover = await coverItemFor(song.path);
      if (cover) {
        const localCover = byPath.get(cover.path);
        if (localCover && localCover.size !== song.cover_size) {
          out.push({
            path: cover.path,
            name: song.name || song.path,
            kind: "cover",
            song,
            coverStale: true,
          });
        }
      }
    }
  }
  return out;
}

/**
 * 未引用资产计算：期望集 = 清单内全部音频/封面/图书/词典的沙盒路径
 * （assetForSong / coverItemFor / assetForBook / assetForDict 的 path；歌词 meta key 不算）；
 * 本地注册表中不在期望集内的 → 孤儿 [{path, size}] + 可释放总大小。
 * @returns {Promise<{orphans:Array<{path:string, size:number}>, totalSize:number}>}
 */
export async function computeOrphanAssets(
  manifestSongs,
  manifestDicts,
  manifestBooks,
  localAssets,
) {
  const local = Array.isArray(localAssets) ? localAssets : [];
  if (!local.length) return { orphans: [], totalSize: 0 };
  const expected = new Set();
  const addExpected = async (fn, arg) => {
    const item = await fn(arg);
    if (item && item.path) expected.add(item.path);
  };
  const songs = Array.isArray(manifestSongs) ? manifestSongs.filter((s) => s && s.path) : [];
  for (const s of songs) {
    await addExpected(assetForSong, s);
    await addExpected(coverItemFor, s.path);
  }
  for (const b of Array.isArray(manifestBooks) ? manifestBooks : []) {
    await addExpected(assetForBook, b);
  }
  for (const d of Array.isArray(manifestDicts) ? manifestDicts : []) {
    await addExpected(assetForDict, d);
  }
  const orphans = [];
  let totalSize = 0;
  for (const a of local) {
    if (!a || !a.path) continue;
    if (a.path.startsWith("lyric:")) continue; // 歌词 meta key 不算未引用（阅读兜底数据）
    if (!expected.has(a.path)) {
      orphans.push({ path: a.path, size: a.size || 0 });
      totalSize += a.size || 0;
    }
  }
  return { orphans, totalSize };
}

/**
 * 应用可更新项：对列表（computeUpdateList 产物）重新构建音频+封面下载项
 * （assetForSong 用 manifest 真实 sha256）→ syncAssets → 原生侧自动删旧重下。
 * @returns {Promise<boolean>} 是否发出了下载请求
 */
export async function applyUpdates(list) {
  const updates = (Array.isArray(list) ? list : []).filter((u) => u && u.song && u.song.path);
  if (!updates.length) return false;
  // 封面过期项：先删本地旧封面——不删则原生 hasAsset 命中旧文件直接 done，不会重下
  const staleCovers = updates.filter((u) => u.coverStale && u.path).map((u) => u.path);
  if (staleCovers.length && syncEnabled() && iosBridgeAvailable()) {
    nativePost({ cmd: "deleteAssets", paths: staleCovers });
  }
  const lists = await Promise.all(
    updates.map(async (u) => {
      // audio：manifest 真实 sha256 → 原生侧自动删旧重下（T2 期望哈希校验）
      const audio = await assetForSong(u.song);
      // cover：仅过期项重建（带 manifest cover_size 供原生 size 校验）；未过期不重下
      const cover = u.coverStale ? await coverItemFor(u.song.path, u.song.cover_size) : null;
      return [audio, cover].filter(Boolean);
    }),
  );
  const items = lists.flat();
  if (!items.length) return false;
  return syncAssets(items);
}

// ---------- 歌词失效检测（T3：manifest lyric_mtime vs 本地记录） ----------
// 记录：nativeMetaSave('syncMeta', {<song path>: lyric_mtime})；对比变了 → 清对应
// lyric:<hash> 缓存（nativeMetaSave 空 json 有 no-op 守卫——空串会被拒发，故用 "{}"
// 空对象哨兵覆盖；loadLyricFile 对无 lines 的 JSON 一律视为无缓存，等价于清空）。

/** syncMeta 记录 key（Documents/meta/syncMeta.json：song path → 上次 lyric_mtime） */
export const SYNC_META_KEY = "syncMeta";

/** 读取本地 syncMeta 记录（文件缺失/损坏 → {}） */
async function loadSyncMeta() {
  const json = await nativeMetaLoad(SYNC_META_KEY);
  if (!json) return {};
  try {
    const data = JSON.parse(json);
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/**
 * 歌词失效检测：manifest 条目 lyric_mtime 与本地记录对比，
 * 本地有记录且值不同 → 返回该歌曲（歌词文件缓存已过期）。
 * @returns {Promise<Array<object>>} 失效歌曲的 manifest 条目列表
 */
export async function detectStaleLyrics(songs) {
  if (!syncEnabled() || !iosBridgeAvailable()) return [];
  const list = (Array.isArray(songs) ? songs : []).filter(
    (s) => s && typeof s.path === "string" && s.path && s.lyric_mtime != null,
  );
  if (!list.length) return [];
  const record = await loadSyncMeta();
  return list.filter((s) => {
    const prev = record[s.path];
    return prev != null && String(prev) !== String(s.lyric_mtime);
  });
}

/** 清除单首歌的歌词文件缓存（覆盖为 {} 哨兵；loadLyric 空数据视为无缓存） */
export async function invalidateLyricForSong(song) {
  if (!syncEnabled() || !iosBridgeAvailable() || !song || !song.path) return false;
  const kind = await lyricKindKey(song.path);
  if (!kind) return false;
  nativeMetaSave(kind, "{}");
  return true;
}

/** 批量清除失效歌词缓存（fire-and-forget；失败静默） */
export async function invalidateStaleLyrics(songs) {
  for (const s of Array.isArray(songs) ? songs : []) {
    try {
      await invalidateLyricForSong(s);
    } catch {
      /* 单首失败静默 */
    }
  }
}

/** 记录当前歌词 mtime 到 syncMeta（与既有记录合并，只覆盖本次清单条目） */
export async function recordLyricMtimes(songs) {
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  const list = (Array.isArray(songs) ? songs : []).filter(
    (s) => s && typeof s.path === "string" && s.path && s.lyric_mtime != null,
  );
  if (!list.length) return false;
  const record = await loadSyncMeta();
  for (const s of list) record[s.path] = s.lyric_mtime;
  nativeMetaSave(SYNC_META_KEY, JSON.stringify(record));
  return true;
}

// ---------- 主按钮：syncAll（一键拉全 + 更新 + 歌词失效） ----------

/**
 * 同步总览（负一屏徽标/孤儿区/存储区数据源，不发起下载）：
 * 并行拉 manifest + assetIndex → 缺失统计 / 可更新列表 / 孤儿资产。
 * @returns {Promise<{ok:boolean, message?:string, missing?:{audio,covers,books,dicts},
 *   updateCount?:number, orphans?:Array, orphanSize?:number, songs?:Array, dicts?:Array,
 *   manifest?:object}>}
 */
export async function computeSyncOverview() {
  if (!syncEnabled()) return { ok: false, enabled: false };
  const [mr, assets] = await Promise.all([fetchAndCacheManifest(), fetchAssetIndex()]);
  if (!mr.ok) return { ok: false, message: mr.message };
  const manifest = mr.manifest || {};
  const songs = (Array.isArray(manifest.songs) ? manifest.songs : []).filter((s) => s && s.path);
  const books = Array.isArray(manifest.books) ? manifest.books : [];
  const dicts = Array.isArray(manifest.dicts) ? manifest.dicts : [];
  const local = Array.isArray(assets) ? assets : [];
  const localSet = new Set(local.map((a) => a.path).filter(Boolean));
  const [songItems, bookItems, dictItems] = await Promise.all([
    buildSongSyncItems(songs),
    buildBookItems(books),
    Promise.all(dicts.map((d) => assetForDict(d))).then((l) => l.filter(Boolean)),
  ]);
  const missing = [...songItems, ...bookItems, ...dictItems].filter(
    (it) => it && it.path && !localSet.has(it.path),
  );
  const missingStats = { audio: 0, covers: 0, books: 0, dicts: 0 };
  for (const it of missing) {
    if (it.path.startsWith("audio/")) missingStats.audio++;
    else if (it.path.startsWith("covers/")) missingStats.covers++;
    else if (it.path.startsWith("books/")) missingStats.books++;
    else if (it.path.startsWith("dicts/")) missingStats.dicts++;
  }
  const updates = await computeUpdateList(songs, local);
  const orphan = await computeOrphanAssets(songs, dicts, books, local);
  return {
    ok: true,
    missing: missingStats,
    updateCount: updates.length,
    orphans: orphan.orphans,
    orphanSize: orphan.totalSize,
    assets: local,
    songs,
    dicts,
    manifest,
  };
}

/**
 * 一键同步全部（负一屏主按钮）：并行拉 manifest + assetIndex →
 * 缺失的下载（音频/封面/图书/词典）→ 可更新的应用（自动更新开关开时）→
 * 歌词失效检测（清缓存 + 重新拉取 + 记录）→ 逐类进度汇总。
 * @returns {Promise<{ok:boolean, enabled?:boolean, message?:string,
 *   sent?:boolean, missing?:{audio,covers,books,dicts}, updateCount?:number, manifest?:object}>}
 */
export async function syncAll() {
  if (!syncEnabled()) return { enabled: false, ok: false };
  if (syncInFlight) return { ok: false, message: "sync in progress" };
  syncInFlight = true;
  syncState.syncing = true;
  try {
    const [mr, assets] = await Promise.all([fetchAndCacheManifest(), fetchAssetIndex()]);
    if (!mr.ok) {
      return { ok: false, message: mr.message, status: mr.status };
    }
    const manifest = mr.manifest || {};
    const songs = (Array.isArray(manifest.songs) ? manifest.songs : []).filter((s) => s && s.path);
    const books = Array.isArray(manifest.books) ? manifest.books : [];
    const dicts = Array.isArray(manifest.dicts) ? manifest.dicts : [];
    const local = Array.isArray(assets) ? assets : [];
    const localSet = new Set(local.map((a) => a.path).filter(Boolean));

    // 缺失项：音频+封面 / 图书 / 词典（本地注册表没有即缺失；空注册表 = 全量补齐）
    const [songItems, bookItems, dictItems] = await Promise.all([
      buildSongSyncItems(songs),
      buildBookItems(books),
      Promise.all(dicts.map((d) => assetForDict(d))).then((l) => l.filter(Boolean)),
    ]);
    const missing = [...songItems, ...bookItems, ...dictItems].filter(
      (it) => it && it.path && !localSet.has(it.path),
    );
    const missingStats = { audio: 0, covers: 0, books: 0, dicts: 0 };
    for (const it of missing) {
      if (it.path.startsWith("audio/")) missingStats.audio++;
      else if (it.path.startsWith("covers/")) missingStats.covers++;
      else if (it.path.startsWith("books/")) missingStats.books++;
      else if (it.path.startsWith("dicts/")) missingStats.dicts++;
    }
    const sent = syncAssets(missing);

    // 可更新（自动更新开才应用；关闭时仅统计，供徽标展示）
    const updates = await computeUpdateList(songs, local);
    if (autoUpdateEnabled() && updates.length) await applyUpdates(updates);

    // 歌词失效：变了 → 清缓存 + 重新拉取落文件 + 记录新 mtime（fire-and-forget）
    const stale = await detectStaleLyrics(songs);
    if (stale.length) {
      await invalidateStaleLyrics(stale);
      syncLyricsForSongs(stale).then(() => recordLyricMtimes(stale));
    }
    // 主按钮「一键拉全」含歌词：有新下载时顺带全部歌词落文件（fire-and-forget）
    if (missing.length) {
      syncLyricsForSongs(songs).then(() => recordLyricMtimes(songs));
    }
    recordLyricMtimes(songs); // 记录本次清单全部 mtime（后续对比基线）

    syncState.lastSyncAt = Date.now();
    syncState.lastError = "";
    return {
      ok: true,
      sent,
      missing: missingStats,
      updateCount: updates.length,
      manifest,
    };
  } catch (e) {
    syncState.lastError = (e && e.message) || "同步失败";
    return { ok: false, message: syncState.lastError };
  } finally {
    syncInFlight = false;
    syncState.syncing = false;
  }
}

// ---------- 精确删除（deleteAssets {paths}，T3 契约） ----------

/** 类型前缀（assetIndex path 过滤；lyric 为 meta 文件 kind 前缀） */
export const ASSET_TYPE_PREFIX = {
  audio: "audio/",
  covers: "covers/",
  lyric: "lyric:",
  books: "books/",
  dicts: "dicts/",
};

/**
 * 按类型清理：assetIndex 按前缀过滤出 paths → deleteAssets {paths}（精确删除）。
 * 注册表未覆盖该类型（空列表）→ 回退旧 scope 删除（audio/books/dicts）。
 * @returns {number} 匹配并提交删除的路径数（0 = 无可清理，UI 提示）
 */
export function clearAssetsByType(type, assets) {
  if (!syncEnabled() || !iosBridgeAvailable()) return 0;
  const prefix = ASSET_TYPE_PREFIX[type];
  const paths = (Array.isArray(assets) ? assets : [])
    .map((a) => a.path)
    .filter((p) => p && prefix && p.startsWith(prefix));
  if (paths.length) {
    nativePost({ cmd: "deleteAssets", paths });
    return paths.length;
  }
  if (type === "audio" || type === "books" || type === "dicts") {
    clearAssets(type); // 回退 scope 删除（旧壳无注册表也可用）
  }
  return 0;
}

/** 清理未引用资产（computeOrphanAssets 产物）→ deleteAssets {paths}；返回是否发出 */
export function deleteOrphanAssets(orphans) {
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  const paths = (Array.isArray(orphans) ? orphans : []).map((o) => o.path).filter(Boolean);
  if (!paths.length) return false;
  nativePost({ cmd: "deleteAssets", paths });
  return true;
}

// ---------- assetsDeleted 完成事件（删除后 UI 刷新用） ----------
let deletionWaiters = new Set(); // Set<fn(paths)>：原生完成回推后结算

function handleAssetsDeleted(payload) {
  const paths = payload && Array.isArray(payload.paths) ? payload.paths : [];
  for (const cb of [...deletionWaiters]) {
    deletionWaiters.delete(cb);
    try {
      cb(paths);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 等待一次资产删除完成回推（deleteAssets 后调用方刷新存储/孤儿统计）。
 * 旧壳不回推 → 超时 resolve([])（调用方照常刷新，不阻塞）。
 */
export function waitAssetsDeleted(timeout = ASSET_INDEX_TIMEOUT_MS) {
  if (!syncEnabled() || !iosBridgeAvailable()) return Promise.resolve([]);
  ensureSubscribed(); // 需要 assetsDeleted 事件订阅
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      deletionWaiters.delete(settle);
      settle([]);
    }, timeout);
    const settle = (paths) => {
      clearTimeout(timer);
      resolve(paths);
    };
    deletionWaiters.add(settle);
  });
}

// ---------- 仅 Wi-Fi / 自动更新开关（localStorage 持久化） ----------
const WIFI_ONLY_KEY = "qqplayer.syncWifiOnly";
const AUTO_UPDATE_KEY = "qqplayer.syncAutoUpdate";

/** 仅 Wi-Fi 下载是否开启（默认开；'off' 才视为关） */
export function wifiOnlyEnabled() {
  try {
    return localStorage.getItem(WIFI_ONLY_KEY) !== "off";
  } catch {
    return true;
  }
}

/**
 * 设置仅 Wi-Fi 开关：持久化 localStorage + 通知原生（setWifiOnly fire-and-forget）；
 * syncAssets 的下载项会携带当前值（wifiOnly: Bool，原生侧蜂窝下挂起）。
 */
export function setWifiOnly(on) {
  try {
    localStorage.setItem(WIFI_ONLY_KEY, on ? "on" : "off");
  } catch {
    /* 忽略 */
  }
  if (syncEnabled() && iosBridgeAvailable()) {
    nativePost({ cmd: "setWifiOnly", on: !!on });
  }
  return wifiOnlyEnabled();
}

/** 自动更新是否开启（默认关；'on' 才视为开） */
export function autoUpdateEnabled() {
  try {
    return localStorage.getItem(AUTO_UPDATE_KEY) === "on";
  } catch {
    return false;
  }
}

/** 设置自动更新开关（localStorage 持久化；返回生效值） */
export function setAutoUpdate(on) {
  try {
    if (on) localStorage.setItem(AUTO_UPDATE_KEY, "on");
    else localStorage.removeItem(AUTO_UPDATE_KEY);
  } catch {
    /* 忽略 */
  }
  return autoUpdateEnabled();
}

// ---------- 元数据文件持久化兜底（iOS 壳 IndexedDB 重启不可靠 → Documents/meta 文件双写） ----------
// 对齐 pairing「Keychain+文件双写」先例：歌曲/收藏/歌单元数据在原生侧落 JSON 文件，
// 启动时读回填；网络成功覆盖、失败保留文件数据（IndexedDB 丢了也能离线看列表）。
let metaSeq = 0;
const pendingMetaLoads = new Map(); // requestId → resolve(json|null)

/** metaLoad 回执等待超时（ms）：原生无回执时不挂起启动流程 */
export const META_LOAD_TIMEOUT_MS = 8000;

/**
 * 元数据写文件（fire-and-forget）：{cmd:"metaSave", kind, json} → 原生原子写
 * Documents/meta/{kind}.json。非 iOS 壳 / 参数非法 → 静默 no-op。
 * @param {"songs"|"favorites"|"playlists"} kind 文件种类
 * @param {string} json 序列化后的元数据 JSON 字符串
 */
export function nativeMetaSave(kind, json) {
  if (!syncEnabled() || !iosBridgeAvailable()) return false;
  if (typeof kind !== "string" || !kind || typeof json !== "string" || !json) return false;
  nativePost({ cmd: "metaSave", kind, json });
  return true;
}

/**
 * 元数据读文件（Promise 化）：{cmd:"metaLoad", kind, requestId} → 原生回推
 * metaLoaded {requestId, kind, json?} → resolve(json)；文件缺失/损坏/超时 → resolve(null)。
 */
export function nativeMetaLoad(kind) {
  if (!syncEnabled() || !iosBridgeAvailable()) return Promise.resolve(null);
  ensureSubscribed(); // 需要 metaLoaded 事件订阅
  const requestId = String(++metaSeq);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingMetaLoads.has(requestId)) {
        pendingMetaLoads.delete(requestId);
        resolve(null);
      }
    }, META_LOAD_TIMEOUT_MS);
    pendingMetaLoads.set(requestId, (payload) => {
      clearTimeout(timer);
      pendingMetaLoads.delete(requestId);
      resolve(payload && typeof payload.json === "string" ? payload.json : null);
    });
    nativePost({ cmd: "metaLoad", kind, requestId });
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
  metaSeq = 0;
  pendingMetaLoads.clear();
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
  assetIndexWaiters.clear();
  deletionWaiters.clear();
  // T2：指令轮询 / 设备标识复位（取消挂起超时定时器，防跨用例续跑）
  appActive = true;
  stopCommandPolling();
  if (deviceIdTimer) {
    clearTimeout(deviceIdTimer);
    deviceIdTimer = null;
  }
  deviceIdSeq = 0;
  deviceIdPromise = null;
  deviceIdWaiters.clear();
}
