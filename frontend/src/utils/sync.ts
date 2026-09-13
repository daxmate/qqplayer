// QQPlayer 同步数据层（原 iOS 伴侣壳的设备端客户端；壳 2026-09-13 退役）
//
// 职责（主机端 / 伴侣端共用的数据层）：
//   - syncNow()：拉取 /api/sync/manifest 全量清单（不缓存），version 变化时全量写入
//     IndexedDB（key: sync:songs / sync:playlists / sync:favorites / sync:books /
//     sync:dicts，经 cacheDb.setCache，ttl=0 不自动过期）
//   - 资产标识 → 沙盒路径（内容寻址）：assetForSong / assetForDict / assetForBook /
//     coverItemFor / lyricKindKey，供下载项构造（buildSongItems / buildSongSyncItems /
//     buildBookItems）与差量计算（computeUpdateList / computeOrphanAssets）使用
//   - 合并：mergeAnnotations / mergeVocab（annotations 按书 LWW / vocab 按 id merge）
//   - 设置：仅 Wi-Fi / 自动更新 / 自动预取（localStorage 持久化）
//
// 设备端链路（原生桥 postMessage 与事件回执、资产下载与回执、指令轮询、Keychain
// 设备标识、assetIndex/存储管理、元数据文件兜底）随 iOS 壳退役一并移除；
// 环境判定 syncEnabled() 仍以 window.qqplayerNative（Tauri 壳）为准。
//
// 资产寻址：沙盒路径按「内容寻址」命名（audio/<sha256>.m4a 等）。manifest 不含文件
// 内容哈希，前端以资产标识（桌面路径/词典相对路径/书 id）的 SHA-256 作稳定文件名与
// sha256 字段——跨会话确定、同文件同地址；真实内容校验由原生侧下载后自行计算。

import { reactive } from "vue";
import { apiGet, isOffline, resolveServerUrl } from "./apiClient.js";
import { getCache, setCache } from "./cacheDb.js";

// ---------- 类型（TS 化；宽松边界：原生回执/API 数据按 any 处理，行为零变化） ----------
interface ApiResultLoose {
  ok: boolean;
  status?: unknown;
  data?: Record<string, unknown>;
  message?: string;
  response?: unknown;
}

/** 下载项（沙盒相对路径 + 桌面绝对 URL + 内容哈希/大小） */
interface DownloadItem {
  url: string;
  path: string;
  sha256: string;
  size: number;
  /** 展示名（同步面板显示用）：歌曲「歌手 - 歌名」/ 词典真实名 / 书名；缺省回退 path */
  name?: string;
}

/** 歌曲（manifest songs 条目宽松视图；字段来自桌面端，缺省容忍） */
interface SongLike {
  path?: string;
  name?: string;
  artist?: string;
  sha256?: string;
  size?: number;
  coverUrl?: string;
  cover_source?: string;
  cover_size?: number;
  lyric_mtime?: unknown;
}

/** 图书（manifest books 条目宽松视图） */
interface BookLike {
  id?: string;
  title?: string;
  sha256?: string;
  size?: number;
}

/** 词典（manifest dicts 条目宽松视图） */
interface DictLike {
  path?: string;
  name?: string;
  /** 真实词典名（后端 manifest title：配置里用户添加/上传时的名字；hash 文件名场景必需） */
  title?: string;
  sha256?: string;
  size?: number;
}

/** 可更新项（computeUpdateList 产物） */
interface UpdateItem {
  path: string;
  name: string;
  kind: "audio" | "cover";
  song: SongLike;
  coverStale?: boolean;
}

interface ManifestResult {
  ok: boolean;
  changed?: boolean;
  version?: string;
  manifest?: Record<string, unknown>;
  counts?: Record<string, number>;
  message?: string;
  status?: unknown;
}

interface SyncNowResult {
  ok: boolean;
  enabled?: boolean;
  changed?: boolean;
  version?: string;
  counts?: Record<string, number>;
  message?: string;
  status?: unknown;
}

// ---------- 环境判定 ----------

/** 是否处于原生壳环境（Tauri 壳注入 window.qqplayerNative=true；桌面浏览器没有） */
export function syncEnabled() {
  try {
    return typeof window !== "undefined" && !!window.qqplayerNative;
  } catch {
    return false;
  }
}

// ---------- 同步状态（设置页 UI 读） ----------
export const syncState = reactive({
  lastSyncAt: null as number | null, // 上次成功同步时间戳（ms）
  syncing: false, // 同步进行中（设置页按钮 loading 态）
  lastError: "", // 最近一次同步失败信息（成功清空）
});

/** 同步状态快照引用（设置页 UI 响应式读取；同 syncState） */
export function getSyncState() {
  return syncState;
}

// ---------- manifest 同步 ----------
const MANIFEST_URL = "/api/sync/manifest";
const COLLECTION_KEYS = [
  "songs",
  "playlists",
  "favorites",
  "books",
  "dicts",
  "annotations", // 阅读标注（manifest annotations：按书全量，LWW 合并）
  "vocab", // 生词本（manifest vocab：全量，按 id 逐条 merge）
];

/** 同步缓存结构版本：manifest 缓存（sync:meta / sync:* 集合）的 schema 变更时 +1，
 *  强制旧缓存失效重拉——manifest version 只随数据变化（mtime/ops/scan），
 *  后端给字段加结构（如 dicts.title 真实词典名）时 version 不变，旧缓存永远不刷新
 *  （2026-08-27：词典区显示 hash 文件名根因）。
 *  历史：v1 无该字段（首版）；v2 = dicts 条目含 title；v3 = 新增 sync:annotations /
 *  sync:vocab 集合（结构变更，旧缓存必须重拉才会写入新集合）。 */
const CACHE_SCHEMA_VERSION = 3;

let syncInFlight = false;

/**
 * 拉取桌面 manifest 并缓存元数据集合（syncNow / syncAll 共用）。
 * @returns {Promise<{ok:boolean, changed?:boolean, version?:string, manifest?:object, message?:string}>}
 */
async function fetchAndCacheManifest(): Promise<ManifestResult> {
  const r = (await apiGet(MANIFEST_URL)) as ApiResultLoose;
  if (!r.ok) {
    syncState.lastError = r.message || `HTTP ${r.status || 0}`;
    return { ok: false, message: syncState.lastError, status: r.status };
  }
  const manifest = r.data || {};
  const version = String(manifest.version || "");
  const meta = await getCache("sync:meta");
  const changed = !meta || meta.version !== version || meta.schemaVersion !== CACHE_SCHEMA_VERSION;
  if (changed) {
    const counts: Record<string, number> = {};
    for (const key of COLLECTION_KEYS) {
      const list = Array.isArray(manifest[key]) ? manifest[key] : [];
      counts[key] = list.length;
      if (key === "annotations") {
        // 按书 LWW：与已有缓存合并（本地有、远端无的书保留；同书 version 大者胜）
        const prev = await getCache("sync:annotations");
        await setCache("sync:annotations", mergeAnnotations(prev, list));
      } else if (key === "vocab") {
        // 按 id 逐条 merge：本地/远端各自独有条目都保留，共有 id 取 addedAt 大者胜
        const prev = await getCache("sync:vocab");
        await setCache("sync:vocab", mergeVocab(prev, list));
      } else {
        await setCache("sync:" + key, list);
      }
    }
    await setCache("sync:meta", {
      version,
      schemaVersion: CACHE_SCHEMA_VERSION,
      generatedAt: manifest.generated_at || "",
      syncedAt: Date.now(),
    });
  }
  return { ok: true, changed, version, manifest };
}

/** 书标注条目 → 该书最新改动时间（ms）：全部条目 createdAt/updatedAt 最大值。
 *  与后端 _annotations_version 同构（manifest annotations[].version）。 */
function annotationsBookVersion(book: unknown): number {
  if (!book || typeof book !== "object") return 0;
  const b = book as Record<string, unknown>;
  let ts = 0;
  for (const kind of ["highlights", "bookmarks", "notes"]) {
    const arr = Array.isArray(b[kind]) ? b[kind] : [];
    for (const item of arr) {
      if (!item || typeof item !== "object") continue;
      const it = item as Record<string, unknown>;
      for (const f of ["createdAt", "updatedAt"]) {
        const v = it[f];
        if (typeof v === "number" && Number.isFinite(v)) ts = Math.max(ts, Math.floor(v));
      }
    }
  }
  return ts;
}

/**
 * 标注合并（按书 LWW）：remote（manifest 新拉取）与 local（已有缓存）按书合并，
 * 该书 version（最新改动 ts）大者胜；仅本地有的书保留（不丢本地数据）。
 * 用于写入 sync:annotations 缓存，避免整表覆盖丢对端标注。
 * @returns 合并后的 annotations 数组（manifest 条目形状 {bookId, version, highlights, bookmarks, notes}）
 */
export function mergeAnnotations(local: unknown, remote: unknown): unknown[] {
  const loc = Array.isArray(local) ? local : [];
  const rem = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, unknown>();
  for (const b of loc) {
    if (b && typeof b === "object" && (b as Record<string, unknown>).bookId != null) {
      byId.set(String((b as Record<string, unknown>).bookId), b);
    }
  }
  for (const b of rem) {
    if (!b || typeof b !== "object") continue;
    const book = b as Record<string, unknown>;
    if (book.bookId == null) continue;
    const id = String(book.bookId);
    const prev = byId.get(id);
    if (prev && annotationsBookVersion(prev) > annotationsBookVersion(book)) {
      continue; // 本地该书更新 → 保留（LWW）
    }
    byId.set(id, book);
  }
  return [...byId.values()];
}

/**
 * 生词合并（按 id 逐条 merge）：本地/远端各自独有条目都保留，共有 id 取 addedAt 大者胜。
 * 用于写入 sync:vocab 缓存，避免整表覆盖丢对端新词（远端新增保留、本地新增也保留）。
 * @returns 合并后的 vocab 数组（manifest 条目形状 {id, word, context, bookId, bookTitle, cfi, addedAt}）
 */
export function mergeVocab(local: unknown, remote: unknown): unknown[] {
  const loc = Array.isArray(local) ? local : [];
  const rem = Array.isArray(remote) ? remote : [];
  const byId = new Map<string, unknown>();
  for (const v of loc) {
    if (v && typeof v === "object" && (v as Record<string, unknown>).id != null) {
      byId.set(String((v as Record<string, unknown>).id), v);
    }
  }
  for (const v of rem) {
    if (!v || typeof v !== "object") continue;
    const entry = v as Record<string, unknown>;
    if (entry.id == null) continue;
    const id = String(entry.id);
    const prev = byId.get(id);
    if (
      prev &&
      Number((prev as Record<string, unknown>).addedAt || 0) > Number(entry.addedAt || 0)
    ) {
      continue; // 本地条目更新 → 保留（LWW）
    }
    byId.set(id, entry);
  }
  return [...byId.values()];
}

/**
 * 拉取桌面 manifest 并缓存元数据集合。
 * @returns {Promise<{ok:boolean, enabled?:boolean, changed?:boolean, version?:string,
 *   counts?:object, message?:string}>}
 *   enabled=false → 桌面浏览器（未启用）；ok=false → 拉取失败（message 为原因）；
 *   成功 → {ok:true, changed, version, counts:{songs,playlists,favorites,books,dicts,annotations,vocab}}
 */
export async function syncNow(): Promise<SyncNowResult> {
  if (!syncEnabled()) return { enabled: false, ok: false };
  // 主机离线/设备断网：全局短路——不发请求、不设 syncing（杜绝动画转圈）；
  // 恢复在线由恢复探测触发（App.vue 补一次 syncNow）
  if (isOffline()) return { ok: false, message: "主机离线" };
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
    const manifest = mr.manifest || {};
    const counts: Record<string, number> = {};
    for (const key of COLLECTION_KEYS) {
      counts[key] = Array.isArray(manifest[key]) ? manifest[key].length : 0;
    }
    return { ok: true, changed: mr.changed, version: mr.version, counts };
  } catch (e) {
    syncState.lastError = (e as { message?: string } | null | undefined)?.message || "同步失败";
    return { ok: false, message: syncState.lastError };
  } finally {
    syncInFlight = false;
    syncState.syncing = false;
  }
}

// ---------- 资产标识 → 沙盒路径（内容寻址） ----------

/** 扩展名（含点，小写；无扩展名返回 ""） */
function extOf(name: string) {
  const m = String(name || "").match(/\.([A-Za-z0-9]+)$/);
  return m ? "." + m[1].toLowerCase() : "";
}

/** 资产标识的稳定哈希：优先 SHA-256（crypto.subtle），不可用时回落确定性 FNV-1a 64 位。
 * 注意：WKWebView 个别场景 crypto.subtle.digest 的 Promise 可能永不 resolve（而非 reject），
 * 用 Promise.race 500ms 超时兜底，避免调用方（如批量下载 buildSongItems）永久挂起。
 * 导出供封面缓存（coverAssetKey）与歌词文件兜底（lyricKindKey）共用同一哈希函数。 */
export async function stableHash(identity: unknown): Promise<string> {
  const input = String(identity || "");
  try {
    if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
      const buf = await Promise.race([
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("digest timeout")), 500),
        ),
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

/** 歌曲展示名：歌手 - 歌名 → 歌名 → 真实文件名（去扩展名）→ path 原文 */
function songDisplayName(song: SongLike): string {
  const name = String(song?.name || "").trim();
  const artist = String(song?.artist || "").trim();
  if (name && artist) return `${artist} - ${name}`;
  if (name) return name;
  const p = String(song?.path || "");
  const base = String(p.split("/").pop() || p);
  const stem = base.replace(/\.[A-Za-z0-9]+$/, "");
  return stem || p;
}

/** 文件路径的展示名：末段文件名（同步面板对非歌曲资产（词典/图书）的回退显示名） */
function fileDisplayName(path: string): string {
  const base =
    String(path || "")
      .split("/")
      .pop() || String(path || "");
  return base.replace(/\.[A-Za-z0-9]+$/, "") || base;
}

/** 歌曲 → 下载项 {url, path, sha256, size}（url 为桌面服务器绝对 URL）
 *  sha256 = manifest 条目自带的内容哈希（T1 契约：manifest songs[].sha256）；
 *  老清单/缺字段 → ""（原生侧空值跳过内容校验，文件名仍用资产标识哈希做内容寻址）。
 *  下载项同时是「资产注册表路径」的权威来源：本地注册表按此 path 与 manifest 对照。 */
export async function assetForSong(song: SongLike): Promise<DownloadItem | null> {
  if (!song || !song.path) return null;
  const url = resolveServerUrl("/api/audio?path=" + encodeURIComponent(song.path));
  const hash = await stableHash(song.path);
  return {
    url,
    path: "audio/" + hash + (extOf(song.path) || ".m4a"),
    sha256: song.sha256 || "",
    size: song.size || 0,
    name: songDisplayName(song),
  };
}

/** 词典 → 下载项（manifest dicts 条目：{name, path, size, mtime}）；sha256 暂为空（同上） */
export async function assetForDict(dict: DictLike): Promise<DownloadItem | null> {
  if (!dict || !dict.path) return null;
  const url = resolveServerUrl("/api/sync/dicts/file?path=" + encodeURIComponent(dict.path));
  const hash = await stableHash(dict.path);
  return {
    url,
    path: "dicts/" + hash + (extOf(dict.path) || ".mdx"),
    sha256: dict.sha256 || "",
    size: dict.size || 0,
    // 真实词典名优先（后端 manifest title：配置里用户添加/上传时的名字）；回退文件名（去扩展名）
    name: String(dict.title || "").trim() || fileDisplayName(String(dict.name || dict.path || "")),
  };
}

/** 书 → 下载项（manifest books 条目：{id, title, progress}）；sha256 暂为空（同上） */
export async function assetForBook(book: BookLike): Promise<DownloadItem | null> {
  if (!book || !book.id) return null;
  const url = resolveServerUrl("/api/books/" + encodeURIComponent(book.id) + "/file");
  const hash = await stableHash(book.id);
  return {
    url,
    path: "books/" + hash + ".epub",
    sha256: book.sha256 || "",
    size: book.size || 0,
    name: String(book.title || "").trim() || fileDisplayName(String(book.id || "")),
  };
}

// ---------- 封面/歌词缓存 key（阶段 F1/F2：封面离线缓存 + 歌词文件兜底） ----------
// 两者共用 stableHash：跨会话确定、同 path 同 key；哈希为纯十六进制，无路径穿越风险
// （原生 MetaStore.fileURL 亦按 kind 净化，双保险）。

/** 封面资产沙盒路径：covers/<path 哈希>.jpg（前端不知封面实际格式，统一按 JPEG 命名；
 *  MiniHTTPServer 按扩展名回 Content-Type，WKWebView 图片解码器按魔数嗅探，PNG 内容也能显示） */
export async function coverAssetKey(path: string): Promise<string | null> {
  if (!path) return null;
  const hash = await stableHash(path);
  return "covers/" + hash + ".jpg";
}

/** 封面下载项 {url, path, sha256, size}（url 为桌面 cover 端点；sha256 空 → 原生跳过内容校验）
 *  @param {number} [size] 可选：manifest 封面文件大小（cover_source=file 时原生 size 校验用）
 *  @param {string} [name] 可选：对应歌曲展示名（同步面板区分封面条目） */
export async function coverItemFor(
  path: string,
  size = 0,
  name = "",
): Promise<DownloadItem | null> {
  if (!path) return null;
  return {
    url: resolveServerUrl("/api/cover?path=" + encodeURIComponent(path)),
    path: (await coverAssetKey(path))!,
    sha256: "",
    size: size || 0,
    name: name || undefined,
  };
}

/** 歌词文件兜底 kind：lyric:<path 哈希>（Documents/meta/lyric:<hash>.json） */
export async function lyricKindKey(path: string): Promise<string | null> {
  if (!path) return null;
  const hash = await stableHash(path);
  return "lyric:" + hash;
}

// ---------- 批量资产下载（下载项构造） ----------

/** 歌曲列表 → 下载项数组（批量复用 assetForSong；path 缺失的流媒体条目自动跳过） */
export async function buildSongItems(songs: unknown): Promise<DownloadItem[]> {
  if (!Array.isArray(songs)) return [];
  const items = await Promise.all(songs.map((s) => assetForSong(s)));
  return items.filter((x): x is DownloadItem => !!x);
}

/**
 * 歌曲列表 → 音频+封面下载项数组（封面随歌一起同步）。
 * 每首歌生成两个下载项：音频（assetForSong）+ 封面（coverItemFor，共用同一下载项格式）；
 * path 缺失的流媒体条目整首跳过（没有本地资产寻址）。
 */
export async function buildSongSyncItems(songs: unknown): Promise<DownloadItem[]> {
  if (!Array.isArray(songs)) return [];
  const lists = await Promise.all(
    songs.map(async (s) => {
      if (!s || !s.path) return []; // 流媒体/缺 path：整首跳过
      const display = songDisplayName(s);
      const [audio, cover] = await Promise.all([
        assetForSong(s),
        coverItemFor(s.path, Number(s.cover_size) || 0, display),
      ]);
      return [audio, cover].filter((x): x is DownloadItem => !!x); // 防御：理论上两者均非空
    }),
  );
  return lists.flat();
}

/** 图书列表 → 下载项数组（批量复用 assetForBook；缺 id 条目自动跳过） */
export async function buildBookItems(books: unknown): Promise<DownloadItem[]> {
  if (!Array.isArray(books)) return [];
  const items = await Promise.all(books.map((b) => assetForBook(b)));
  return items.filter((x): x is DownloadItem => !!x);
}

// ---------- 更新 / 孤儿计算（T3：sha256 对比） ----------

/**
 * 可更新项计算：manifest songs（带 sha256）vs 本地资产注册表。
 * 判定 = 本地注册有该资产 && 本地 sha256 ≠ manifest sha256 → {path, name, kind, song}。
 * 首次升级策略：注册表不存在/为空（老版本升级，assets.json 未建）→ 全部视为最新，
 * 不标记可更新（避免误报全量更新）；注册表存在后严格对比。
 * @returns {Promise<Array<{path:string, name:string, kind:'audio', song:object}>>}
 */
export async function computeUpdateList(
  manifestSongs: unknown,
  localAssets: unknown,
): Promise<UpdateItem[]> {
  const local = Array.isArray(localAssets) ? localAssets : [];
  if (!local.length) return []; // 首次升级/注册表为空：全部视为最新
  const byPath = new Map();
  for (const a of local) {
    if (a && a.path) byPath.set(a.path, a);
  }
  const out: UpdateItem[] = [];
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
  manifestSongs: unknown,
  manifestDicts: unknown,
  manifestBooks: unknown,
  localAssets: unknown,
): Promise<{ orphans: { path: string; size: number }[]; totalSize: number }> {
  const local = Array.isArray(localAssets) ? localAssets : [];
  if (!local.length) return { orphans: [], totalSize: 0 };
  const expected = new Set<string>();
  // 泛型：fn/arg 同一类型参数（assetForSong(SongLike)/assetForBook(BookLike)/
  // assetForDict(DictLike)/coverItemFor(string) 各不相同；调用点实参为宽松对象，
  // 由 TS 按各自签名推断）
  const addExpected = async <T>(fn: (arg: T) => Promise<DownloadItem | null>, arg: T) => {
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
  const orphans: { path: string; size: number }[] = [];
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

/** 设置仅 Wi-Fi 开关（localStorage 持久化；返回生效值） */
export function setWifiOnly(on: boolean) {
  try {
    localStorage.setItem(WIFI_ONLY_KEY, on ? "on" : "off");
  } catch {
    /* 忽略 */
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
export function setAutoUpdate(on: boolean) {
  try {
    if (on) localStorage.setItem(AUTO_UPDATE_KEY, "on");
    else localStorage.removeItem(AUTO_UPDATE_KEY);
  } catch {
    /* 忽略 */
  }
  return autoUpdateEnabled();
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
export function setAutoPrefetch(on: boolean) {
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
  syncInFlight = false;
  syncState.lastSyncAt = null;
  syncState.syncing = false;
  syncState.lastError = "";
}
