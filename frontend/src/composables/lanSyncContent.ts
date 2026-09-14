// 局域网同步（S2 · web Host 侧）内容选择 + 运行状态的**纯逻辑层**（无网络、无 reactive）。
//
// 分工：本文件只做计算（内容来源目录 / 来源内顺序 / 搜索过滤 / 分页 / 选择集载荷 /
// 推送·拉取运行状态归一），网络与 reactive 在 `useLanSyncPush.ts` / `useLanSyncPull.ts` /
// `useLanSyncRun.ts`；组件只渲染。
//
// 语义口径（对齐 Swift `SyncBrowseSourceCatalog` / `SyncUIContentLimits`，设计 docs §12c/§12c.1）：
// - **来源内顺序 = 来源自身顺序**：搜索只过滤、**绝不重排**（全部曲库 = 后端返回序，
//   收藏 / 歌单 = 成员序，自动歌单 = 播放数据序）；
// - 自动歌单（`@smart:*`）封顶 50 首（`SMART_VIEW_LIMIT`，与播放列表页同一数据层）；
// - 推送 = 本端选择集（对端已有的跳过，**不传播删除**）；
// - 拉取 = 对端曲库的**点名集合**，不是全库镜像（不选就不取）。
import type { Playlist, Song } from "./playerState.js";

/** 全部曲库来源标识（仅本端 UI 合成项，不出现在对端清单里） */
export const SOURCE_LIBRARY = "@library";
/** 收藏来源标识（既有保留标识） */
export const SOURCE_FAVORITES = "@favorites";
/** 自动歌单来源标识（`@smart:*` 命名空间；本期只做这三个） */
export const SMART_SOURCES = [
  "@smart:recentAdded",
  "@smart:recentPlayed",
  "@smart:topPlayed",
] as const;
export type SmartSourceId = (typeof SMART_SOURCES)[number];

/** 单曲列表每页条数（懒加载分页；与 Swift `SyncUIContentLimits.pageSize` 同量级） */
export const TRACKS_PAGE_SIZE = 50;

/** 选择集三级（与协议 `collection.kind` 一一对应） */
export type SelectionKind = "all" | "playlists" | "tracks";

/** 推送选择集（POST /api/lansync/push 的 `selection`） */
export interface LanSyncSelection {
  kind: SelectionKind;
  ids: string[];
}

/** 内容来源行（来源下拉 / 歌单列表共用；名称由 UI 按 `sourceLabelKey` 本地化） */
export interface LanSyncSourceRow {
  id: string;
  /** 真实歌单的显示名；`@` 命名空间的名称走 i18n（见 `sourceLabelKey`） */
  name: string;
  trackCount: number;
  smart: boolean;
}

/** 本端内容事实（一次装配，供来源目录与来源内曲目复用） */
export interface LocalContentFacts {
  /** GET /api/songs（未过滤，含网络歌） */
  songs: Song[];
  /** GET /api/favorites 的 paths（收藏顺序） */
  favorites: string[];
  /** GET /api/playlists 的 playlists（成员顺序 = songPaths 顺序） */
  playlists: Playlist[];
  /** 自动歌单的有序成员（@smart:* → 曲目；未加载时缺省空表） */
  smartTracks: Record<string, Song[]>;
}

/** 空事实（未加载时的安全默认） */
export function emptyFacts(): LocalContentFacts {
  return { songs: [], favorites: [], playlists: [], smartTracks: {} };
}

/** 来源标识 → i18n key（真实歌单返回 null = 用后端给的歌单名） */
export function sourceLabelKey(id: string): string | null {
  if (id === SOURCE_LIBRARY) return "lansync.source.library";
  if (id === SOURCE_FAVORITES) return "lansync.source.favorites";
  if (id === (SMART_SOURCES[0] as string)) return "lansync.source.recentAdded";
  if (id === (SMART_SOURCES[1] as string)) return "lansync.source.recentPlayed";
  if (id === (SMART_SOURCES[2] as string)) return "lansync.source.topPlayed";
  return null;
}

/** 可推送 / 可取回的本地曲目（网络歌 path=null，没有文件可传 → 排除） */
export function localSongs(songs: Song[] | null | undefined): Song[] {
  return (songs || []).filter((s) => typeof s?.path === "string" && s.path.length > 0);
}

/** path → 曲目索引 */
export function songsByPath(songs: Song[] | null | undefined): Map<string, Song> {
  const map = new Map<string, Song>();
  for (const song of songs || []) {
    if (typeof song?.path === "string" && song.path) map.set(song.path, song);
  }
  return map;
}

/**
 * 内容来源目录（顺序冻结：全部曲库 → 收藏 → 真实歌单 → 自动歌单）。
 *
 * - 真实歌单：跳过标识以 `@` 开头的（保留命名空间，与后端 `local_sources` 同判据）；
 * - 自动歌单：恒列三行（成员未加载时计数 0，加载后更新）；
 * - 计数口径 = 该来源**当前可见**的曲目数（不含网络歌、不含不在库内的成员）。
 */
export function buildSourceCatalog(facts: LocalContentFacts): LanSyncSourceRow[] {
  const byPath = songsByPath(facts.songs);
  const rows: LanSyncSourceRow[] = [
    {
      id: SOURCE_LIBRARY,
      name: SOURCE_LIBRARY,
      trackCount: localSongs(facts.songs).length,
      smart: false,
    },
  ];
  const favorites = (facts.favorites || []).filter((p) => byPath.has(p));
  rows.push({
    id: SOURCE_FAVORITES,
    name: SOURCE_FAVORITES,
    trackCount: favorites.length,
    smart: false,
  });
  for (const playlist of facts.playlists || []) {
    const id = String(playlist?.id ?? "").trim();
    if (!id || id.startsWith("@")) continue;
    const members = (playlist.songPaths || []).filter((p) => byPath.has(p));
    rows.push({
      id,
      name: String(playlist.name ?? "").trim() || id,
      trackCount: members.length,
      smart: false,
    });
  }
  for (const id of SMART_SOURCES) {
    rows.push({
      id,
      name: id,
      trackCount: (facts.smartTracks?.[id] || []).length,
      smart: true,
    });
  }
  return rows;
}

/**
 * 某个来源的曲目（**来源自身顺序**，不排序不重排）。
 *
 * 未知 / 非法来源标识 → 空表（**绝不回落全库**，与后端 `source_member_paths` 同语义）。
 */
export function sourceTracks(id: string, facts: LocalContentFacts): Song[] {
  const byPath = songsByPath(facts.songs);
  if (id === SOURCE_LIBRARY) return localSongs(facts.songs);
  if (id === SOURCE_FAVORITES) {
    return (facts.favorites || []).map((p) => byPath.get(p)).filter((s): s is Song => Boolean(s));
  }
  if ((SMART_SOURCES as readonly string[]).includes(id)) {
    return facts.smartTracks?.[id] || [];
  }
  // `@` 命名空间的未知标识 = 空集（与后端 `source_member_paths` 同口径：绝不回落全库）
  if (id.startsWith("@")) return [];
  const playlist = (facts.playlists || []).find((p) => p?.id === id);
  if (!playlist) return [];
  return (playlist.songPaths || []).map((p) => byPath.get(p)).filter((s): s is Song => Boolean(s));
}

/** 关键词过滤（曲名 / 歌手 / 专辑，大小写不敏感；**只过滤不重排**） */
export function filterTracks(tracks: Song[] | null | undefined, query: string): Song[] {
  const text = String(query || "")
    .trim()
    .toLowerCase();
  if (!text) return [...(tracks || [])];
  return (tracks || []).filter((song) => {
    const haystack = [song?.name, song?.artist, song?.album]
      .map((v) => String(v ?? "").toLowerCase())
      .join("\n");
    return haystack.includes(text);
  });
}

/** 分页（越界 offset 收成合法值；total = 过滤后的总数） */
export function paginate<T>(
  items: T[] | null | undefined,
  offset: number,
  limit: number = TRACKS_PAGE_SIZE,
): { items: T[]; hasMore: boolean; total: number; offset: number } {
  const all = items || [];
  const size = Math.max(1, Math.floor(limit) || TRACKS_PAGE_SIZE);
  const start = Math.max(0, Math.min(Math.floor(offset) || 0, all.length));
  const page = all.slice(start, start + size);
  return {
    items: page,
    hasMore: start + page.length < all.length,
    total: all.length,
    offset: start,
  };
}

/** 选择集载荷（POST push 的 `selection`；空 ids 的选择性集合 = 不选任何文件） */
export function selectionPayload(
  kind: SelectionKind,
  playlistIds: Iterable<string>,
  trackPaths: Iterable<string>,
): LanSyncSelection {
  if (kind === "all") return { kind: "all", ids: [] };
  if (kind === "playlists") return { kind: "playlists", ids: [...playlistIds] };
  return { kind: "tracks", ids: [...trackPaths] };
}

/** 选择集是否可提交（全库恒可；选择性集合必须至少选一项） */
export function canSubmitSelection(selection: LanSyncSelection | null | undefined): boolean {
  if (!selection) return false;
  return selection.kind === "all" || selection.ids.length > 0;
}

// ============ 运行状态归一（推送 / 拉取两套键名 → 同一运行视图） ============

/** 一条失败记录（推送 / 拉取同形：`{relativePath, reason, detail?}`） */
export interface LanSyncRunFailure {
  path: string;
  reason: string;
  detail: string;
}

/** 运行视图（推送与拉取归一后，UI 只认这一套） */
export interface LanSyncRunView {
  kind: "push" | "pull";
  runId: string;
  peerId: string;
  /** 后端状态机原值（idle / requestingManifest / pushing / fetching / done / failed） */
  state: string;
  /** 已传输 / 总字节（推送 = sentBytes，拉取 = receivedBytes） */
  transferredBytes: number;
  totalBytes: number;
  /** 计划 / 已完成 / 跳过（推送 skipped = 对端已有；拉取 skipped = 内容一致）/ 失败 */
  counts: { planned: number; completed: number; skipped: number; failed: number };
  failures: LanSyncRunFailure[];
  error: string;
  /** 终态（done / failed）：轮询可停 */
  terminal: boolean;
  /** 正常结束且无失败 */
  succeeded: boolean;
  /** 本轮选择集（后端回显；`tracks` 的 ids 为相对路径或绝对路径） */
  selection: LanSyncSelection | null;
}

/** 终态判定（done / failed 后不再变化） */
export function isTerminalState(state: string): boolean {
  return state === "done" || state === "failed";
}

/** 失败原因 → i18n key（未知原因回落 `lansync.failure.unknown`，原因原值另附 detail 展示） */
export function failureLabelKey(reason: string): string {
  const known = [
    "local_file_unavailable",
    "send_failed",
    "session_closed",
    "cancelled",
    "invalid_path",
    "receive_failed",
    "write_failed",
  ];
  return known.includes(reason) ? `lansync.failure.${reason}` : "lansync.failure.unknown";
}

function asCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function parseFailures(raw: unknown): LanSyncRunFailure[] {
  if (!Array.isArray(raw)) return [];
  const out: LanSyncRunFailure[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    out.push({
      path: String(record.relativePath ?? ""),
      reason: String(record.reason ?? ""),
      detail: String(record.detail ?? ""),
    });
  }
  return out;
}

function parseSelection(raw: unknown): LanSyncSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const kind = String(record.kind ?? "");
  if (kind !== "all" && kind !== "playlists" && kind !== "tracks") return null;
  const ids = Array.isArray(record.ids) ? record.ids.map((v) => String(v)) : [];
  return { kind, ids };
}

/**
 * 状态字典 → 运行视图。
 *
 * 推送键（`LibraryPushRun.status()`）：`sentBytes`/`totalBytes` + `plannedCount`/`skippedCount`/
 * `completedCount`/`failedCount`；拉取键（`LibraryPullRun.status()`）：`receivedBytes`/`totalBytes` +
 * `requestedCount`/`unchangedCount`/`completedCount`/`failedCount`。
 * 未知 / 缺字段一律按 0 / 空表处理（UI 不因后端字段缺失而崩）。
 */
export function normalizeRunStatus(kind: "push" | "pull", raw: unknown): LanSyncRunView {
  const record = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const state = String(record.state ?? "");
  const counts =
    kind === "push"
      ? {
          planned: asCount(record.plannedCount),
          completed: asCount(record.completedCount),
          skipped: asCount(record.skippedCount),
          failed: asCount(record.failedCount),
        }
      : {
          planned: asCount(record.requestedCount),
          completed: asCount(record.completedCount),
          skipped: asCount(record.unchangedCount),
          failed: asCount(record.failedCount),
        };
  const transferred = kind === "push" ? record.sentBytes : record.receivedBytes;
  return {
    kind,
    runId: String(record.run_id ?? ""),
    peerId: String(record.peer_id ?? ""),
    state,
    transferredBytes: asCount(transferred),
    totalBytes: asCount(record.totalBytes),
    counts,
    failures: parseFailures(record.failed),
    error: String(record.error ?? ""),
    terminal: isTerminalState(state),
    succeeded: state === "done" && counts.failed === 0,
    selection: parseSelection(record.selection),
  };
}

/** 进度百分比（总量未知时：终态按 100、运行中按 0） */
export function runPercent(view: LanSyncRunView | null | undefined): number {
  if (!view) return 0;
  if (view.totalBytes > 0) {
    return Math.max(0, Math.min(100, Math.round((view.transferredBytes / view.totalBytes) * 100)));
  }
  return view.terminal ? 100 : 0;
}

/** 字节数人性化（B / KB / MB / GB，一位小数） */
export function formatBytes(value: number): string {
  const n = Number(value) || 0;
  if (n < 1024) return `${Math.max(0, Math.floor(n))} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(1)} ${units[index]}`;
}
