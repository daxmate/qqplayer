// ============ 智能视图（最近添加 / 最近播放 / 常听排行）============
// 数据源：
//   - 最近添加：按歌曲 mtime（毫秒，后端 scan 时取 birthtime/mtime；网络歌=添加时刻）降序，最新在前
//   - 最近播放：GET /api/playback（记录按 ts 倒序，按 path 去重取最新一条，映射到当前库歌曲）
//   - 常听排行：GET /api/playback/stats（聚合 songs 按播放次数降序，并列按累计时长）
// 视图进入时拉取一次；recentAdded 为纯前端计算，曲库变化（添加/删除）时自动重算。
import { reactive, watch } from "vue";
import { state, selectSong, play, findSongIndex } from "./usePlayer.js";
import i18n from "../locales/i18n.js";

export const SMART_VIEW_LIMIT = 50;

// 视图定义：kind → 标题 / 空态文案 key（文案在 smart.js，组件内 t(titleKey) 渲染）
export const SMART_VIEWS = {
  recentAdded: { titleKey: "smart.recentAdded.title", emptyKey: "smart.recentAdded.empty" },
  recentPlayed: { titleKey: "smart.recentPlayed.title", emptyKey: "smart.recentPlayed.empty" },
  topPlayed: { titleKey: "smart.topPlayed.title", emptyKey: "smart.topPlayed.empty" },
};

export const smartViewState = reactive({
  active: null, // 'recentAdded' | 'recentPlayed' | 'topPlayed' | null
  loading: false,
  error: "",
  rows: [], // [{ song, record?, stat? }]（song 为当前库歌曲对象）
  prevPlaylistOpen: null, // 桌面进入视图前的播放列表面板开关，退出时恢复
});

// ============ 纯映射函数（可单测） ============

// 播放记录 → 行：按 ts 倒序（后端已排），按 path 去重（保留最新），映射到当前库歌曲（已删除跳过）
export function mapRecentPlayed(records, libraryById, limit = SMART_VIEW_LIMIT) {
  const rows = [];
  const seen = new Set();
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
export function mapTopPlayed(stats, libraryById, limit = SMART_VIEW_LIMIT) {
  return (stats || [])
    .filter((s) => s && libraryById.has(s.path))
    .sort((a, b) => (b.plays ?? 0) - (a.plays ?? 0) || (b.totalPlayed ?? 0) - (a.totalPlayed ?? 0))
    .slice(0, limit)
    .map((s) => ({ song: libraryById.get(s.path), stat: s }));
}

// 最近添加：按添加时间（mtime 毫秒）降序，最新在前；mtime 缺失（旧数据）保持库数组顺序
// （Array.prototype.sort 稳定：全 0 时维持原序）
export function mapRecentAdded(library, limit = SMART_VIEW_LIMIT) {
  return [...(library || [])]
    .sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0))
    .slice(0, limit)
    .map((song) => ({ song }));
}

// 库数组 → path 索引 Map
export function byPath(songs) {
  return new Map((songs || []).map((s) => [s.path, s]));
}

// ============ 视图加载（进入时拉取一次） ============
export async function loadSmartView(kind) {
  smartViewState.active = kind;
  smartViewState.loading = true;
  smartViewState.error = "";
  smartViewState.rows = [];
  try {
    const libById = byPath(state.songs);
    if (kind === "recentAdded") {
      smartViewState.rows = mapRecentAdded(state.songs);
    } else if (kind === "recentPlayed") {
      const res = await fetch("/api/playback", { cache: "no-store" });
      if (!res.ok) throw new Error(i18n.global.t("errors.loadPlayback"));
      const data = await res.json();
      smartViewState.rows = mapRecentPlayed(data && data.records, libById);
    } else if (kind === "topPlayed") {
      const res = await fetch("/api/playback/stats", { cache: "no-store" });
      if (!res.ok) throw new Error(i18n.global.t("errors.loadPlaybackStats"));
      const data = await res.json();
      smartViewState.rows = mapTopPlayed(data && data.songs, libById);
    }
  } catch (e) {
    smartViewState.error = (e && e.message) || i18n.global.t("errors.loadFailed");
  } finally {
    smartViewState.loading = false;
  }
}

export function closeSmartView() {
  smartViewState.active = null;
  smartViewState.loading = false;
  smartViewState.error = "";
  smartViewState.rows = [];
}

// 曲库变化（下载/导入/删除后 loadSongs 整体替换 state.songs）→ 正在看"最近添加"时自动重算，
// 新添加的歌实时排到最上。recentPlayed/topPlayed 依赖后端统计，保持进入时拉取一次（避免轮询风暴）。
watch(
  () => state.songs,
  () => {
    if (smartViewState.active === "recentAdded") {
      smartViewState.rows = mapRecentAdded(state.songs);
    }
  },
);

// ============ 播放 ============
// 点击行：定位到全局队列（state.songs）并播放，与 Playlist/MobileShell 同一链路
// 网络歌（path=null）按 streamId 定位（findSongIndex），本地歌按 path
export function playSmartRow(row) {
  const idx = findSongIndex(row && row.song);
  if (idx < 0) return false;
  selectSong(idx);
  play();
  return true;
}

// ============ 副信息格式化 ============
// 常听排行：播放次数 + 累计时长；最近播放：播放时间；最近添加：专辑
export function fmtSmartSub(row) {
  const song = row && row.song;
  if (!song) return "";
  const parts = [];
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

export function fmtTs(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtDuration(sec) {
  const s = Number(sec) || 0;
  if (s <= 0) return "";
  if (s < 60) return i18n.global.t("smart.seconds", { n: Math.round(s) });
  if (s < 3600) return i18n.global.t("smart.minutes", { n: Math.round(s / 60) });
  return i18n.global.t("smart.hours", { n: (s / 3600).toFixed(1) });
}
