// ============ 智能视图（最近添加 / 最近播放 / 常听排行）============
// 数据源：
//   - 最近添加：GET /api/songs（歌曲对象无 addTime/mtime 字段，用库数组顺序兜底，取前 N）
//   - 最近播放：GET /api/playback（记录按 ts 倒序，按 path 去重取最新一条，映射到当前库歌曲）
//   - 常听排行：GET /api/playback/stats（聚合 songs 按播放次数降序，并列按累计时长）
// 视图进入时拉取一次，不常驻轮询。行点击走全局 selectSong + play 播放链路。
import { reactive } from "vue";
import { state, selectSong, play } from "./usePlayer.js";

export const SMART_VIEW_LIMIT = 50;

// 视图定义：kind → 标题 / 空态文案（UI 文案集中在组件内，明天 i18n 抽离）
export const SMART_VIEWS = {
  recentAdded: { title: "最近添加", empty: "暂无歌曲" },
  recentPlayed: { title: "最近播放", empty: "暂无播放记录" },
  topPlayed: { title: "常听排行", empty: "暂无播放记录" },
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

// 最近添加：歌曲无 addTime/mtime，用库数组顺序兜底，取前 N
export function mapRecentAdded(library, limit = SMART_VIEW_LIMIT) {
  return (library || []).slice(0, limit).map((song) => ({ song }));
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
      if (!res.ok) throw new Error("加载播放记录失败");
      const data = await res.json();
      smartViewState.rows = mapRecentPlayed(data && data.records, libById);
    } else if (kind === "topPlayed") {
      const res = await fetch("/api/playback/stats", { cache: "no-store" });
      if (!res.ok) throw new Error("加载播放统计失败");
      const data = await res.json();
      smartViewState.rows = mapTopPlayed(data && data.songs, libById);
    }
  } catch (e) {
    smartViewState.error = (e && e.message) || "加载失败";
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

// ============ 播放 ============
// 点击行：定位到全局队列（state.songs）并播放，与 Playlist/MobileShell 同一链路
export function playSmartRow(row) {
  const path = row && row.song && row.song.path;
  const idx = state.songs.findIndex((s) => s.path === path);
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
    parts.push(`播放 ${row.stat.plays} 次`);
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
  if (s < 60) return `${Math.round(s)} 秒`;
  if (s < 3600) return `${Math.round(s / 60)} 分钟`;
  return `${(s / 3600).toFixed(1)} 小时`;
}
