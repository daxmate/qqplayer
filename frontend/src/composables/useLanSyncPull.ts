// 局域网同步（S2 · web Host 侧）**从设备取回**：对端内容浏览（帧 15/16 的 HTTP 面）。
//
// 契约（冻结）：
//   POST /api/lansync/pull/preview {peer_id, scope:"tracks"|"playlists"|null, query, offset, limit}
//        → {request_id, scope, offset, limit}     ← 只是**受理**，结果异步回来
//   清单经既有事件轮询 GET /api/lansync/events 返回：
//        {"type":"pull","action":"preview", "requestID", "scope", "offset", "limit",
//         "total", "items", "hasMore", "libraryTrackCount", "librarySizeBytes",
//         "truncated", "playlistCount", "trackCount"}
//        items 条目：{"kind":"playlist","playlist":{...}} / {"kind":"track","track":{...}}
//        另有 action "preview_error"（提示）/ "preview_unmatched"（忽略）
//
// 语义：**拉取 = 对端曲库的点名集合，不是全库镜像**——不勾选就什么都不取；
// 勾选只在当前会话内累积（翻页 / 搜索不丢已选）。`relativePath` 是对端相对路径，
// 取回后由后端按本端曲库落位入库。
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { apiPost } from "../utils/apiClient.js";
import { onLanSyncEvents } from "./useLanSync.js";

/** 对端清单每页条数（懒加载；不在本端一次性拉全量） */
export const PEER_PAGE_SIZE = 100;

/** 搜索去抖（ms）：与 Swift `SyncUIContentLimits.searchDebounce` 同量级 */
export const PEER_SEARCH_DEBOUNCE_MS = 300;

/** 清单请求超时（ms）：对端不回 preview 事件时给出可读错误，不无限转圈 */
export const PEER_PREVIEW_TIMEOUT_MS = 10000;

/** 浏览范围（歌单摘要 / 曲目明细） */
export type PeerScope = "playlists" | "tracks";

/** 对端曲目条目 */
export interface LanSyncPeerTrack {
  relativePath: string;
  title: string;
  artistName: string;
  sizeBytes: number;
  contentHash: string;
}

/** 对端歌单条目 */
export interface LanSyncPeerPlaylist {
  id: string;
  name: string;
  trackCount: number;
}

/** 对端曲库摘要（顶部事实行） */
export interface LanSyncPeerFacts {
  libraryTrackCount: number;
  librarySizeBytes: number;
  playlistCount: number;
  trackCount: number;
  truncated: boolean;
}

export interface LanSyncPullApi {
  peerId: Ref<string | null>;
  opened: Ref<boolean>;
  scope: Ref<PeerScope>;
  playlists: Ref<LanSyncPeerPlaylist[]>;
  tracks: Ref<LanSyncPeerTrack[]>;
  facts: Ref<LanSyncPeerFacts>;
  total: Ref<number>;
  hasMore: Ref<boolean>;
  offset: Ref<number>;
  query: Ref<string>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** 对端未回执（超时 / 回执无文案）→ UI 显示统一「设备未响应」提示 */
  noResponse: Ref<boolean>;
  selectedPaths: Ref<string[]>;
  selectedSet: ComputedRef<Set<string>>;
  selectedCount: ComputedRef<number>;
  pageLabel: ComputedRef<string>;
  /** 打开对端浏览（幂等：同一 peer 重复调用只刷新，不重置已选） */
  open: (peerId: string) => Promise<void>;
  refresh: () => Promise<void>;
  close: () => void;
  setScope: (scope: PeerScope) => Promise<void>;
  setQuery: (query: string) => void;
  setOffset: (offset: number) => Promise<void>;
  nextPage: () => Promise<void>;
  prevPage: () => Promise<void>;
  toggleTrack: (relativePath: string) => void;
  isSelected: (relativePath: string) => boolean;
  togglePage: (select: boolean) => void;
  clearSelection: () => void;
}

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
}

const emptyFacts = (): LanSyncPeerFacts => ({
  libraryTrackCount: 0,
  librarySizeBytes: 0,
  playlistCount: 0,
  trackCount: 0,
  truncated: false,
});

function asInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * 对端内容浏览 + 取回选择集（组件级 composable）。
 *
 * 事件订阅在创建时挂上（模块级事件总线，`onLanSyncEvents`），卸载时由组件 `stop()`
 * 或自身 `close()` 释放；`applyPreview` 只认与 `pending` 匹配的 `requestID`，
 * 过期响应（用户已翻页 / 换范围）一律丢弃。
 */
export function useLanSyncPull(): LanSyncPullApi & { stop: () => void } {
  const peerId = ref<string | null>(null);
  const opened = ref(false);
  const scope = ref<PeerScope>("playlists");
  const playlists = ref<LanSyncPeerPlaylist[]>([]);
  const tracks = ref<LanSyncPeerTrack[]>([]);
  const facts = ref<LanSyncPeerFacts>(emptyFacts());
  const total = ref(0);
  const hasMore = ref(false);
  const offset = ref(0);
  const query = ref("");
  const loading = ref(false);
  const error = ref<string | null>(null);
  const noResponse = ref(false);
  const selectedPaths = ref<string[]>([]);

  const selectedSet = computed<Set<string>>(() => new Set(selectedPaths.value));
  const selectedCount = computed<number>(() => selectedPaths.value.length);
  const pageLabel = computed<string>(() => {
    const start = total.value === 0 ? 0 : offset.value + 1;
    const end = Math.min(offset.value + PEER_PAGE_SIZE, total.value);
    return `${start}-${end} / ${total.value}`;
  });

  /** 在途请求（只认它的响应；新的请求会作废旧请求） */
  let pending: { requestId: string; scope: PeerScope; offset: number } | null = null;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;

  function clearPending(): void {
    pending = null;
    if (timeout !== null) {
      clearTimeout(timeout);
      timeout = null;
    }
  }

  function fail(message: string): void {
    error.value = message;
    loading.value = false;
  }

  /** 发一次清单请求（结果经事件回来） */
  async function request(scopeValue: PeerScope, offsetValue: number): Promise<void> {
    const peer = peerId.value;
    if (!peer) return;
    clearPending();
    loading.value = true;
    error.value = null;
    noResponse.value = false;
    const res = (await apiPost("/api/lansync/pull/preview", {
      peer_id: peer,
      scope: scopeValue,
      query: query.value,
      offset: Math.max(0, offsetValue),
      limit: PEER_PAGE_SIZE,
    })) as ApiResult<{ request_id?: string }>;
    if (!res.ok) {
      fail(res.message || "");
      return;
    }
    const requestId = String(res.data?.request_id ?? "");
    if (!requestId) {
      fail(res.message || "");
      return;
    }
    pending = { requestId, scope: scopeValue, offset: Math.max(0, offsetValue) };
    timeout = setTimeout(() => {
      if (pending?.requestId === requestId) {
        clearPending();
        noResponse.value = true;
        loading.value = false;
      }
    }, PEER_PREVIEW_TIMEOUT_MS);
  }

  /** 应用一条 preview 事件（只认在途请求） */
  function applyPreview(payload: Record<string, unknown>): void {
    const requestId = String(payload.requestID ?? "");
    if (!pending || !requestId || pending.requestId !== requestId) return; // 过期 / 无在途 → 丢弃
    const requestScope = pending.scope;
    clearPending();
    const items = Array.isArray(payload.items) ? payload.items : [];
    if (requestScope === "playlists") {
      playlists.value = items
        .map((item) => (item as { kind?: string; playlist?: unknown }).playlist)
        .filter((p): p is Record<string, unknown> => Boolean(p) && typeof p === "object")
        .map((p) => ({
          id: String(p.id ?? ""),
          name: String(p.name ?? ""),
          trackCount: asInt(p.trackCount),
        }));
    } else {
      tracks.value = items
        .map((item) => (item as { kind?: string; track?: unknown }).track)
        .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === "object")
        .map((t) => ({
          relativePath: String(t.relativePath ?? ""),
          title: String(t.title ?? ""),
          artistName: String(t.artistName ?? ""),
          sizeBytes: asInt(t.sizeBytes),
          contentHash: String(t.contentHash ?? ""),
        }));
    }
    offset.value = asInt(payload.offset);
    total.value = asInt(payload.total);
    hasMore.value = Boolean(payload.hasMore);
    facts.value = {
      libraryTrackCount: asInt(payload.libraryTrackCount),
      librarySizeBytes: asInt(payload.librarySizeBytes),
      playlistCount: asInt(payload.playlistCount),
      trackCount: asInt(payload.trackCount),
      truncated: Boolean(payload.truncated),
    };
    loading.value = false;
    error.value = null;
    noResponse.value = false;
  }

  /** 事件分发（模块级总线回调） */
  function handleEvents(events: unknown[]): void {
    for (const raw of events) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as Record<string, unknown>;
      if (event.type !== "pull") continue;
      const action = String(event.action ?? "");
      if (action === "preview") applyPreview(event);
      else if (action === "preview_error") {
        if (pending) {
          clearPending();
          const message = String(event.message ?? event.error ?? "");
          if (message) fail(message);
          else {
            noResponse.value = true;
            loading.value = false;
          }
        }
      }
      // preview_unmatched：对端没匹配到内容 → 按任务要求忽略（保持上一次结果）
    }
  }

  const unsubscribe = onLanSyncEvents(handleEvents);

  async function open(peer: string): Promise<void> {
    const same = peerId.value === peer && opened.value;
    peerId.value = peer;
    opened.value = true;
    if (same) return;
    // 换设备 → 清空对端内容与选择（标识空间不同，跨设备保留选择会取错东西）
    playlists.value = [];
    tracks.value = [];
    facts.value = emptyFacts();
    total.value = 0;
    hasMore.value = false;
    offset.value = 0;
    query.value = "";
    selectedPaths.value = [];
    scope.value = "playlists";
    clearPending();
    await request("playlists", 0);
  }

  function close(): void {
    clearPending();
    if (debounce !== null) {
      clearTimeout(debounce);
      debounce = null;
    }
    opened.value = false;
    peerId.value = null;
    selectedPaths.value = [];
    playlists.value = [];
    tracks.value = [];
    facts.value = emptyFacts();
    total.value = 0;
    hasMore.value = false;
    offset.value = 0;
    query.value = "";
  }

  async function refresh(): Promise<void> {
    if (!peerId.value) return;
    await request(scope.value, offset.value);
  }

  async function setScope(next: PeerScope): Promise<void> {
    if (scope.value === next && opened.value) return;
    scope.value = next;
    offset.value = 0;
    if (opened.value) await request(next, 0);
  }

  /** 搜索：去抖后带 query 请求对端（**不在本端过滤**，与 Swift 同口径） */
  function setQuery(next: string): void {
    query.value = next;
    if (debounce !== null) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      // 搜索是「换条件」而不是「翻页」：即使已在第一页也必须重发（offset 相同不代表条件相同）
      offset.value = 0;
      if (opened.value) void request(scope.value, 0);
    }, PEER_SEARCH_DEBOUNCE_MS);
  }

  async function setOffset(next: number): Promise<void> {
    if (!opened.value) return;
    const target = Math.max(0, Math.floor(next) || 0);
    if (target === offset.value && !loading.value) return;
    await request(scope.value, target);
  }

  async function nextPage(): Promise<void> {
    if (!hasMore.value) return;
    await setOffset(offset.value + PEER_PAGE_SIZE);
  }

  async function prevPage(): Promise<void> {
    if (offset.value <= 0) return;
    await setOffset(Math.max(0, offset.value - PEER_PAGE_SIZE));
  }

  function toggleTrack(relativePath: string): void {
    const set = new Set(selectedPaths.value);
    if (set.has(relativePath)) set.delete(relativePath);
    else set.add(relativePath);
    selectedPaths.value = [...set];
  }

  function isSelected(relativePath: string): boolean {
    return selectedSet.value.has(relativePath);
  }

  function togglePage(select: boolean): void {
    const set = new Set(selectedPaths.value);
    for (const track of tracks.value) {
      if (!track.relativePath) continue;
      if (select) set.add(track.relativePath);
      else set.delete(track.relativePath);
    }
    selectedPaths.value = [...set];
  }

  function clearSelection(): void {
    selectedPaths.value = [];
  }

  return {
    peerId,
    opened,
    scope,
    playlists,
    tracks,
    facts,
    total,
    hasMore,
    offset,
    query,
    loading,
    error,
    noResponse,
    selectedPaths,
    selectedSet,
    selectedCount,
    pageLabel,
    open,
    refresh,
    close,
    setScope,
    setQuery,
    setOffset,
    nextPage,
    prevPage,
    toggleTrack,
    isSelected,
    togglePage,
    clearSelection,
    stop: () => unsubscribe(),
  };
}
