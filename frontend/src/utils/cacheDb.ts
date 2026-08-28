// QQPlayer IndexedDB 缓存层（轻量 Promise 封装，零第三方依赖）
//
// 两个表（db "qqplayer-cache" v1）：
//   cache      — 声明式 HTTP 缓存：{key, value, ts, ttl}（key 约定 "GET:{url}"）
//   pendingOps — 写路径 dirty 队列：{id, op, payload, ts}（id 自增，回放顺序 = 写入顺序）
//
// 环境降级：indexedDB 不可用（jsdom 测试 / 隐私模式 / 旧 WebView）→ 内存 Map 实现，
// 对外接口完全一致（测试与受限环境照常工作）；浏览器主环境走真实 IndexedDB。
//
// TS 化说明（2026-08-28）：缓存 value / pendingOps payload 按宽松类型处理
// （unknown / Record<string, unknown>），读取方自行收窄——与 .js 版按 any 处理的
// 宽松边界语义一致，行为零变化。IndexedDB request 结果类型各操作不同（get→行 /
// add→自增 id / 其余→undefined），tx 辅助按泛型 T 显式声明（内部宽松断言）。

const DB_NAME = "qqplayer-cache";
const DB_VERSION = 1;
const CACHE_STORE = "cache";
const OPS_STORE = "pendingOps";

// ---------- 类型（TS 化；宽松边界：缓存内容为任意 JSON，读取方自行收窄） ----------

/** cache 表条目：{key, value, ts, ttl}（value 为任意 JSON 数据） */
interface CacheRow {
  key: string;
  value: unknown;
  ts: number;
  ttl: number;
}

/** 待同步写操作描述 {url, method}（url 为 API 路径，method 为 HTTP 方法） */
interface PendingOp {
  url: string;
  method?: string;
}

/** pendingOps 表条目：{id, op, payload, ts}（id 自增；payload 为请求体 JSON） */
interface PendingOpRow {
  id?: number;
  op: PendingOp;
  payload: unknown;
  ts: number;
}

/** getCache 选项：maxAge 秒（传入时未过期才返回；不传 → 存在即返回，允许过期数据） */
interface GetCacheOpts {
  maxAge?: number;
}

// ---------- 内存降级实现（indexedDB 不可用时） ----------
const memCache = new Map<string, CacheRow>(); // key → {value, ts, ttl}
let memOpsSeq = 1;
const memOps: PendingOpRow[] = []; // [{id, op, payload, ts}]

function canUseIndexedDB(): boolean {
  return typeof indexedDB !== "undefined" && !!indexedDB;
}

// ---------- IndexedDB 连接（懒加载单例） ----------
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(OPS_STORE)) {
        db.createObjectStore(OPS_STORE, { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

// 事务辅助：store 操作完成后 resolve（request 结果或 undefined）。
// 结果类型随操作而异（get→行对象 / add→自增 id / delete/clear/块体→undefined），
// 由调用方按 T 显式声明；内部对 request 结果做宽松断言（各浏览器实现 result 类型不一致）。
function tx<T = unknown>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest | void,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(storeName, mode);
        const store = t.objectStore(storeName);
        const req = fn(store);
        t.oncomplete = () => resolve((req && req.result) as T);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

// ============ cache 表：get/set/del/clear ============

/**
 * 读缓存。maxAge 秒：传入时未过期才返回（过期视为 miss，但保留条目供离线降级读）；
 * 不传 maxAge（离线降级用）→ 存在即返回（允许过期数据）。
 * @returns 命中返回缓存 value（宽松对象视图），未命中返回 null
 */
export function getCache(
  key: string,
  { maxAge }: GetCacheOpts = {},
): Promise<Record<string, unknown> | null> {
  if (!canUseIndexedDB()) {
    const hit = memCache.get(key);
    if (hit === undefined) return Promise.resolve(null);
    if (maxAge !== undefined && Date.now() - hit.ts > maxAge * 1000) return Promise.resolve(null);
    return Promise.resolve(hit.value as Record<string, unknown>);
  }
  return tx<CacheRow | null>(CACHE_STORE, "readonly", (store) => store.get(key)).then((row) => {
    if (!row) return null;
    if (maxAge !== undefined && Date.now() - row.ts > maxAge * 1000) return null;
    return row.value as Record<string, unknown>;
  });
}

/** 写缓存。ttl 秒（>=0；0 表示不自动过期，仅按 maxAge 判定） */
export function setCache(key: string, value: unknown, ttl = 0): Promise<void> {
  const row: CacheRow = { key, value, ts: Date.now(), ttl };
  if (!canUseIndexedDB()) {
    memCache.set(key, row);
    return Promise.resolve();
  }
  return tx<void>(CACHE_STORE, "readwrite", (store) => store.put(row));
}

/** 删单个缓存条目 */
export function delCache(key: string): Promise<void> {
  if (!canUseIndexedDB()) {
    memCache.delete(key);
    return Promise.resolve();
  }
  return tx<void>(CACHE_STORE, "readwrite", (store) => store.delete(key));
}

/** 清空缓存表（测试隔离 / 手动清缓存用） */
export function clearCache(): Promise<void> {
  if (!canUseIndexedDB()) {
    memCache.clear();
    return Promise.resolve();
  }
  return tx<void>(CACHE_STORE, "readwrite", (store) => store.clear());
}

// ============ pendingOps 表：写路径 dirty 队列 ============

/** 入队写操作 → 返回队列 id。op 为 {url, method}，payload 为请求体（JSON 对象） */
export function enqueuePendingOp(op: PendingOp, payload: unknown): Promise<number | undefined> {
  const row: PendingOpRow = { op, payload, ts: Date.now() };
  if (!canUseIndexedDB()) {
    row.id = memOpsSeq++;
    memOps.push(row);
    return Promise.resolve(row.id);
  }
  // store.add 的 request.result 即自增生成的 id
  return tx<number | undefined>(OPS_STORE, "readwrite", (store) => store.add(row)).then((id) => {
    return id ?? undefined;
  });
}

/** 全部待同步操作（按入队顺序） */
export function getPendingOps(): Promise<PendingOpRow[]> {
  if (!canUseIndexedDB()) return Promise.resolve([...memOps]);
  return tx<PendingOpRow[] | null>(OPS_STORE, "readonly", (store) => store.getAll()).then(
    (rows) => rows || [],
  );
}

/** 按 id 批量移除（成功同步后清队） */
export function removePendingOps(ids: number | number[]): Promise<void> {
  const list = Array.isArray(ids) ? ids : [ids];
  if (!canUseIndexedDB()) {
    for (let i = memOps.length - 1; i >= 0; i--) {
      const opId = memOps[i].id;
      if (opId !== undefined && list.includes(opId)) memOps.splice(i, 1);
    }
    return Promise.resolve();
  }
  return tx<void>(OPS_STORE, "readwrite", (store) => {
    for (const id of list) store.delete(id);
  });
}

/** 清空队列（测试隔离 / 手动清空） */
export function clearPendingOps(): Promise<void> {
  if (!canUseIndexedDB()) {
    memOps.length = 0;
    return Promise.resolve();
  }
  return tx<void>(OPS_STORE, "readwrite", (store) => store.clear());
}
