// 局域网同步（S2 · web Host 侧）**推送选择集**状态机：内容来源目录 / 来源内分页搜索 /
// 三级选择（全库 · 歌单与收藏 · 单曲）。
//
// 数据来源（既有接口，不新增后端依赖）：
//   - 曲库：GET /api/songs（与播放列表页同一份数据；网络歌 path=null 不参与推送）
//   - 收藏：GET /api/favorites（paths 顺序 = 收藏顺序）
//   - 歌单：GET /api/playlists（songPaths 顺序 = 歌单成员序）
//   - 自动歌单：本端复用播放列表页的同一套纯映射（useSmartViews 的
//     mapRecentAdded / mapRecentPlayed / mapTopPlayed，上限同为 50）——
//     「自动歌单成员口径与播放列表页同一数据层」（设计 §12c）
//
// 纯逻辑（来源序 / 过滤 / 分页 / 载荷）在 lanSyncContent.ts；本文件只做 IO 与 reactive 装配。
import { computed, ref, type ComputedRef, type Ref } from "vue";
import { apiGet } from "../utils/apiClient.js";
import type { Playlist, Song } from "./playerState.js";
import {
  mapRecentAdded,
  mapRecentPlayed,
  mapTopPlayed,
  SMART_VIEW_LIMIT,
} from "./useSmartViews.js";
import {
  buildSourceCatalog,
  canSubmitSelection,
  emptyFacts,
  filterTracks,
  localSongs,
  paginate,
  selectionPayload,
  SMART_SOURCES,
  songsByPath,
  sourceTracks,
  TRACKS_PAGE_SIZE,
  type LanSyncSelection,
  type LanSyncSourceRow,
  type LocalContentFacts,
  type SelectionKind,
} from "./lanSyncContent.js";

interface ApiResult<T> {
  ok: boolean;
  status: number;
  data?: T;
  message?: string;
}

/** 分页信息（当前来源 + 搜索词下的可见页） */
export interface TrackPageInfo {
  offset: number;
  total: number;
  hasMore: boolean;
}

export interface LanSyncPushApi {
  /** 三级选择：全库 / 歌单与收藏 / 单曲 */
  kind: Ref<SelectionKind>;
  /** 已勾选来源标识（收藏 `@favorites` / 歌单 slug / `@smart:*`） */
  playlistIds: Ref<string[]>;
  /** 已勾选单曲（本端绝对路径；后端两种路径口径都接受） */
  trackPaths: Ref<string[]>;
  playlistIdSet: ComputedRef<Set<string>>;
  trackPathSet: ComputedRef<Set<string>>;
  /** 全部来源（含 `@library`，顺序冻结） */
  sources: Ref<LanSyncSourceRow[]>;
  /** 歌单 tab 的行（去掉「全部曲库」） */
  playlistRows: ComputedRef<LanSyncSourceRow[]>;
  /** 本端可推送曲目数（全库 tab 的说明用） */
  libraryCount: ComputedRef<number>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  /** 单曲 tab 当前来源（`@library` 默认） */
  currentSource: Ref<string>;
  /** 单曲 tab 搜索词 */
  query: Ref<string>;
  /** 单曲 tab 当前页曲目（来源序 → 过滤 → 分页，**不重排**） */
  pageTracks: ComputedRef<Song[]>;
  pageInfo: ComputedRef<TrackPageInfo>;
  /** 当前来源（过滤前）曲目总数 */
  sourceTrackCount: ComputedRef<number>;
  /** 选择集载荷（POST push 的 `selection`） */
  selection: ComputedRef<LanSyncSelection>;
  canSubmit: ComputedRef<boolean>;
  /** 已选单曲数 / 已选来源数 */
  selectedTrackCount: ComputedRef<number>;
  selectedSourceCount: ComputedRef<number>;
  load: (force?: boolean) => Promise<void>;
  setKind: (kind: SelectionKind) => void;
  setSource: (id: string) => void;
  setQuery: (query: string) => void;
  setOffset: (offset: number) => void;
  togglePlaylist: (id: string) => void;
  toggleTrack: (path: string) => void;
  isTrackSelected: (path: string) => boolean;
  /** 当前页全选 / 全不选（`select=false` 时只移除当前页已选项） */
  togglePage: (select: boolean) => void;
  /** 清空选择集（切设备 / 起跑后调用） */
  clearSelection: () => void;
}

/**
 * 推送选择集（组件级 composable：一个推送面板一个实例）。
 *
 * `load()` 幂等（首个 `loaded` 后直接返回），失败只置 `error` 不清空既有数据。
 */
export function useLanSyncPush(): LanSyncPushApi {
  const kind = ref<SelectionKind>("all");
  const playlistIds = ref<string[]>([]);
  const trackPaths = ref<string[]>([]);
  const sources = ref<LanSyncSourceRow[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const currentSource = ref<string>("@library");
  const query = ref("");
  const offset = ref(0);
  const facts = ref<LocalContentFacts>(emptyFacts());
  let loaded = false;

  const playlistIdSet = computed<Set<string>>(() => new Set(playlistIds.value));
  const trackPathSet = computed<Set<string>>(() => new Set(trackPaths.value));

  const playlistRows = computed<LanSyncSourceRow[]>(() =>
    sources.value.filter((row) => row.id !== "@library"),
  );
  const libraryCount = computed<number>(() => localSongs(facts.value.songs).length);

  const sourceTracksList = computed<Song[]>(() => sourceTracks(currentSource.value, facts.value));
  const filteredTracks = computed<Song[]>(() => filterTracks(sourceTracksList.value, query.value));
  const pageInfo = computed<TrackPageInfo>(() => {
    const page = paginate(filteredTracks.value, offset.value, TRACKS_PAGE_SIZE);
    return { offset: page.offset, total: page.total, hasMore: page.hasMore };
  });
  const pageTracks = computed<Song[]>(
    () => paginate(filteredTracks.value, offset.value, TRACKS_PAGE_SIZE).items,
  );
  const sourceTrackCount = computed<number>(() => sourceTracksList.value.length);

  const selection = computed<LanSyncSelection>(() =>
    selectionPayload(kind.value, playlistIds.value, trackPaths.value),
  );
  const canSubmit = computed<boolean>(() => canSubmitSelection(selection.value));
  const selectedTrackCount = computed<number>(() => trackPaths.value.length);
  const selectedSourceCount = computed<number>(() => playlistIds.value.length);

  /** 拉取本端内容事实（曲库 / 收藏 / 歌单 / 自动歌单） */
  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    loading.value = true;
    error.value = null;
    try {
      const [songsRes, favRes, playlistRes, playbackRes, statsRes] = (await Promise.all([
        apiGet("/api/songs", { cache: { ttl: 60, offline: true } }),
        apiGet("/api/favorites", { cache: { ttl: 60, offline: true } }),
        apiGet("/api/playlists", { cache: { ttl: 60, offline: true } }),
        apiGet("/api/playback"),
        apiGet("/api/playback/stats"),
      ])) as Array<ApiResult<unknown>>;

      const songs: Song[] = Array.isArray(songsRes.data) ? (songsRes.data as Song[]) : [];
      const favorites = Array.isArray((favRes.data as { paths?: unknown })?.paths)
        ? ((favRes.data as { paths: string[] }).paths ?? [])
        : [];
      const playlists = Array.isArray((playlistRes.data as { playlists?: unknown })?.playlists)
        ? ((playlistRes.data as { playlists: Playlist[] }).playlists ?? [])
        : [];
      const byPath = songsByPath(songs);
      const records = (playbackRes.data as { records?: unknown[] })?.records;
      const stats = (statsRes.data as { songs?: unknown[] })?.songs;
      facts.value = {
        songs,
        favorites,
        playlists,
        smartTracks: {
          [SMART_SOURCES[0]]: mapRecentAdded(songs, SMART_VIEW_LIMIT).map((row) => row.song),
          [SMART_SOURCES[1]]: mapRecentPlayed(
            records as Parameters<typeof mapRecentPlayed>[0],
            byPath,
            SMART_VIEW_LIMIT,
          ).map((row) => row.song),
          [SMART_SOURCES[2]]: mapTopPlayed(
            stats as Parameters<typeof mapTopPlayed>[0],
            byPath,
            SMART_VIEW_LIMIT,
          ).map((row) => row.song),
        },
      };
      sources.value = buildSourceCatalog(facts.value);
      // 当前来源已不存在（歌单被删 / 换了库）→ 回落全部曲库
      if (!sources.value.some((row) => row.id === currentSource.value)) {
        currentSource.value = "@library";
      }
      if (!songsRes.ok && !favorites.length) error.value = songsRes.message || null;
      loaded = true;
    } catch (e) {
      error.value = (e as Error)?.message || null;
    } finally {
      loading.value = false;
    }
  }

  function setKind(next: SelectionKind): void {
    kind.value = next;
  }

  function setSource(id: string): void {
    currentSource.value = id;
    query.value = "";
    offset.value = 0;
  }

  function setQuery(next: string): void {
    query.value = next;
    offset.value = 0;
  }

  function setOffset(next: number): void {
    offset.value = Math.max(0, Math.floor(next) || 0);
  }

  function togglePlaylist(id: string): void {
    const set = new Set(playlistIds.value);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    playlistIds.value = [...set];
  }

  function toggleTrack(path: string): void {
    const set = new Set(trackPaths.value);
    if (set.has(path)) set.delete(path);
    else set.add(path);
    trackPaths.value = [...set];
  }

  function isTrackSelected(path: string): boolean {
    return trackPathSet.value.has(path);
  }

  function togglePage(select: boolean): void {
    const set = new Set(trackPaths.value);
    for (const song of pageTracks.value) {
      const path = song.path as string;
      if (!path) continue;
      if (select) set.add(path);
      else set.delete(path);
    }
    trackPaths.value = [...set];
  }

  function clearSelection(): void {
    playlistIds.value = [];
    trackPaths.value = [];
    kind.value = "all";
  }

  return {
    kind,
    playlistIds,
    trackPaths,
    playlistIdSet,
    trackPathSet,
    sources,
    playlistRows,
    libraryCount,
    loading,
    error,
    currentSource,
    query,
    pageTracks,
    pageInfo,
    sourceTrackCount,
    selection,
    canSubmit,
    selectedTrackCount,
    selectedSourceCount,
    load,
    setKind,
    setSource,
    setQuery,
    setOffset,
    togglePlaylist,
    toggleTrack,
    isTrackSelected,
    togglePage,
    clearSelection,
  };
}
