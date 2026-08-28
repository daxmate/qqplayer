// ============ 智能视图（最近添加 / 最近播放 / 常听排行）============
// 数据源：
//   - 最近添加：按歌曲 mtime（毫秒，后端 scan 时取 birthtime/mtime；网络歌=添加时刻）降序，最新在前
//   - 最近播放：GET /api/playback（记录按 ts 倒序，按 path 去重取最新一条，映射到当前库歌曲）
//   - 常听排行：GET /api/playback/stats（聚合 songs 按播放次数降序，并列按累计时长）
// 视图进入时拉取一次；recentAdded 为纯前端计算，曲库变化（添加/删除）时自动重算。
import { reactive, watch } from "vue";
import { state, selectSong, play, findSongIndex, type Song } from "./usePlayer.js";
import { apiGet } from "../utils/apiClient.js";
import i18n from "../locales/i18n.js";

export const SMART_VIEW_LIMIT = 50;

/** 智能视图种类（SMART_VIEWS 的键；decades 带 decade 参数） */
export type SmartViewKind = "recentAdded" | "recentPlayed" | "topPlayed" | "decades";

/** 视图定义：kind → 标题 / 空态文案 key（文案在 smart.js，组件内 t(titleKey) 渲染） */
export interface SmartViewDef {
  titleKey: string;
  emptyKey: string;
}

export const SMART_VIEWS: Record<SmartViewKind, SmartViewDef> = {
  recentAdded: { titleKey: "smart.recentAdded.title", emptyKey: "smart.recentAdded.empty" },
  recentPlayed: { titleKey: "smart.recentPlayed.title", emptyKey: "smart.recentPlayed.empty" },
  topPlayed: { titleKey: "smart.topPlayed.title", emptyKey: "smart.topPlayed.empty" },
  // 年代视图：kind=decades + 参数 decade（DECADE_BUCKETS 的 key）；标题按具体年代显示（SmartViewPanel 内处理）
  decades: { titleKey: "smart.decades.title", emptyKey: "smart.decades.empty" },
};

/** 年代 bucket 定义（DECADE_BUCKETS 条目） */
export interface DecadeBucket {
  key: string;
  min: number | null;
  max: number | null;
  labelKey: string;
  labelParams?: Record<string, number>;
}

// 年代划分（Apple Music Decades 粒度：10 年一段 + 未知；纯前端按 song.year 聚合）
// min/max 闭区间；1950s 含更早（min=null），2020s 含以后（max=null）
export const DECADE_BUCKETS: DecadeBucket[] = [
  { key: "1950s", min: null, max: 1959, labelKey: "smart.decadeEarly" },
  { key: "1960s", min: 1960, max: 1969, labelKey: "smart.decadeLabel", labelParams: { n: 6 } },
  { key: "1970s", min: 1970, max: 1979, labelKey: "smart.decadeLabel", labelParams: { n: 7 } },
  { key: "1980s", min: 1980, max: 1989, labelKey: "smart.decadeLabel", labelParams: { n: 8 } },
  { key: "1990s", min: 1990, max: 1999, labelKey: "smart.decadeLabel", labelParams: { n: 9 } },
  { key: "2000s", min: 2000, max: 2009, labelKey: "smart.decade2000s" },
  { key: "2010s", min: 2010, max: 2019, labelKey: "smart.decade2010s" },
  { key: "2020s", min: 2020, max: null, labelKey: "smart.decade2020s" },
  { key: "unknown", min: null, max: null, labelKey: "smart.decadeUnknown" },
];

/** 智能视图行：{ song, record?, stat? }（song 为当前库歌曲对象） */
export interface SmartViewRow {
  song: Song;
  record?: PlaybackRecord;
  stat?: PlaybackStat;
}

/** 播放记录（GET /api/playback 条目；宽松键值视图） */
interface PlaybackRecord {
  path?: string | null;
  ts?: number | string;
  [key: string]: unknown;
}

/** 播放统计（GET /api/playback/stats 条目；宽松键值视图） */
interface PlaybackStat {
  path: string;
  plays?: number;
  totalPlayed?: number;
  [key: string]: unknown;
}

/** 智能视图 UI 状态（smartViewState reactive 单例） */
export interface SmartViewState {
  active: SmartViewKind | null; // 'recentAdded' | 'recentPlayed' | 'topPlayed' | 'decades' | null
  decade: string | null; // 年代视图参数（active==='decades' 时：DECADE_BUCKETS key）
  loading: boolean;
  error: string;
  rows: SmartViewRow[]; // [{ song, record?, stat? }]（song 为当前库歌曲对象）
  prevPlaylistOpen: boolean | null; // 桌面进入视图前的播放列表面板开关，退出时恢复
}

export const smartViewState = reactive<SmartViewState>({
  active: null, // 'recentAdded' | 'recentPlayed' | 'topPlayed' | 'decades' | null
  decade: null, // 年代视图参数（active==='decades' 时：DECADE_BUCKETS key）
  loading: false,
  error: "",
  rows: [], // [{ song, record?, stat? }]（song 为当前库歌曲对象）
  prevPlaylistOpen: null, // 桌面进入视图前的播放列表面板开关，退出时恢复
});

// ============ 纯映射函数（可单测） ============

// 播放记录 → 行：按 ts 倒序（后端已排），按 path 去重（保留最新），映射到当前库歌曲（已删除跳过）
export function mapRecentPlayed(
  records: PlaybackRecord[] | null | undefined,
  libraryById: Map<string, Song>,
  limit: number = SMART_VIEW_LIMIT,
): SmartViewRow[] {
  const rows: SmartViewRow[] = [];
  const seen = new Set<string>();
  for (const r of records || []) {
    const path = r && r.path;
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const song = libraryById.get(path);
    if (!song) continue;
    rows.push({ song, record: r });
    if (rows.length >= limit) break;
  }
  return rows;
}

// 聚合统计 → 行：播放次数降序（并列按累计时长），只保留当前库歌曲
export function mapTopPlayed(
  stats: PlaybackStat[] | null | undefined,
  libraryById: Map<string, Song>,
  limit: number = SMART_VIEW_LIMIT,
): SmartViewRow[] {
  return (stats || [])
    .filter((s) => s && libraryById.has(s.path))
    .sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0) || (b.totalPlayed ?? 0) - (a.totalPlayed ?? 0))
    .slice(0, limit)
    .map((s) => ({ song: libraryById.get(s.path) as Song, stat: s }));
}

// 最近添加：按添加时间（mtime 毫秒）降序，最新在前；mtime 缺失（旧数据）保持库数组顺序
// （Array.prototype.sort 稳定：全 0 时维持原序）
export function mapRecentAdded(
  library: Song[] | null | undefined,
  limit: number = SMART_VIEW_LIMIT,
): SmartViewRow[] {
  return [...(library || [])]
    .sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0))
    .slice(0, limit)
    .map((song) => ({ song }));
}

// 歌曲 year → 年代 bucket key（纯函数）：year 缺失/非 4 位整数/越界 → unknown
// 边界：1959 → 1950s，1960 → 1960s（闭区间 [min, max]）
export function decadeOfYear(year: unknown): string {
  const n = Number(year);
  if (!Number.isInteger(n) || n < 1000 || n > 9999) return "unknown";
  if (n <= 1959) return "1950s";
  if (n <= 1969) return "1960s";
  if (n <= 1979) return "1970s";
  if (n <= 1989) return "1980s";
  if (n <= 1999) return "1990s";
  if (n <= 2009) return "2000s";
  if (n <= 2019) return "2010s";
  return "2020s";
}

// 年代视图行：按 year 聚合到指定 bucket，同年内按 year 降序（新在前），截断 limit
// 非法 bucket key 回落 unknown（与 DECADE_BUCKETS 尾项一致）
export function mapDecade(
  library: Song[] | null | undefined,
  bucketKey: string | null,
  limit: number = SMART_VIEW_LIMIT,
): SmartViewRow[] {
  const key = (DECADE_BUCKETS.some((b) => b.key === bucketKey) && bucketKey) || "unknown";
  return [...(library || [])]
    .filter((s) => decadeOfYear(s && s.year) === key)
    .sort((a, b) => (Number(b.year) || 0) - (Number(a.year) || 0))
    .slice(0, limit)
    .map((song) => ({ song }));
}

// 曲库 → 各年代数量（侧边栏徽标 / 未知年代入口计数）
export function countByDecade(library: Song[] | null | undefined): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of DECADE_BUCKETS) counts[b.key] = 0;
  for (const s of library || []) {
    const k = decadeOfYear(s && s.year);
    if (k in counts) counts[k] += 1;
  }
  return counts;
}

// 库数组 → path 索引 Map
export function byPath(songs: Song[] | null | undefined): Map<string, Song> {
  return new Map((songs || []).map((s): [string, Song] => [s.path as string, s]));
}

// ============ 视图加载（进入时拉取一次） ============
export async function loadSmartView(kind: SmartViewKind, decade?: string | null): Promise<void> {
  smartViewState.active = kind;
  smartViewState.loading = true;
  smartViewState.error = "";
  smartViewState.rows = [];
  try {
    const libById = byPath(state.songs);
    if (kind === "recentAdded") {
      smartViewState.decade = null;
      smartViewState.rows = mapRecentAdded(state.songs);
    } else if (kind === "decades") {
      // 参数优先，未传则用侧栏 openSmartView 已写入的 smartViewState.decade
      if (decade) smartViewState.decade = decade;
      if (!smartViewState.decade) smartViewState.decade = "unknown";
      smartViewState.rows = mapDecade(state.songs, smartViewState.decade);
    } else if (kind === "recentPlayed") {
      smartViewState.decade = null;
      // 播放记录是统计类数据，保持实时拉取（不走缓存）
      const r = await apiGet("/api/playback");
      if (!r.ok) throw new Error(i18n.global.t("errors.loadPlayback"));
      smartViewState.rows = mapRecentPlayed(r.data && r.data.records, libById);
    } else if (kind === "topPlayed") {
      smartViewState.decade = null;
      const r = await apiGet("/api/playback/stats");
      if (!r.ok) throw new Error(i18n.global.t("errors.loadPlaybackStats"));
      smartViewState.rows = mapTopPlayed(r.data && r.data.songs, libById);
    }
  } catch (e) {
    smartViewState.error = (e as Error)?.message || i18n.global.t("errors.loadFailed");
  } finally {
    smartViewState.loading = false;
  }
}

export function closeSmartView(): void {
  smartViewState.active = null;
  smartViewState.decade = null;
  smartViewState.loading = false;
  smartViewState.error = "";
  smartViewState.rows = [];
}

// 曲库变化（下载/导入/删除后 loadSongs 整体替换 state.songs）→ 正在看"最近添加"/"年代"时自动重算，
// 新添加的歌实时排到最上/新年代归位。recentPlayed/topPlayed 依赖后端统计，保持进入时拉取一次（避免轮询风暴）。
watch(
  () => state.songs,
  () => {
    if (smartViewState.active === "recentAdded") {
      smartViewState.rows = mapRecentAdded(state.songs);
    } else if (smartViewState.active === "decades") {
      smartViewState.rows = mapDecade(state.songs, smartViewState.decade);
    }
  },
);

// ============ 播放 ============
// 点击行：定位到全局队列（state.songs）并播放，与 Playlist/MobileShell 同一链路
// 网络歌（path=null）按 streamId 定位（findSongIndex），本地歌按 path
export function playSmartRow(row: SmartViewRow | null | undefined): boolean {
  const idx = findSongIndex(row && row.song);
  if (idx < 0) return false;
  selectSong(idx);
  play();
  return true;
}

// ============ 副信息格式化 ============
// 常听排行：播放次数 + 累计时长；最近播放：播放时间；最近添加：专辑
export function fmtSmartSub(row: SmartViewRow | null | undefined): string {
  const song = row && row.song;
  if (!row || !song) return "";
  const parts: string[] = [];
  if (row.stat) {
    parts.push(i18n.global.t("smart.playedTimes", { n: row.stat.plays }));
    const dur = fmtDuration(row.stat.totalPlayed);
    if (dur) parts.push(dur);
  } else if (row.record) {
    const t = fmtTs(row.record.ts);
    if (t) parts.push(t);
  } else if (song.album) {
    parts.push(song.album);
  }
  return parts.join(" · ");
}

export function fmtTs(ts: number | string | null | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(sec: number | string | null | undefined): string {
  const s = Number(sec) || 0;
  if (s <= 0) return "";
  if (s < 60) return i18n.global.t("smart.seconds", { n: Math.round(s) });
  if (s < 3600) return i18n.global.t("smart.minutes", { n: Math.round(s / 60) });
  return i18n.global.t("smart.hours", { n: (s / 3600).toFixed(1) });
}
