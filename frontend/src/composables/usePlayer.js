import { reactive, computed, watch } from "vue";

// 全局唯一 audio 元素
const audio = new Audio();
audio.preload = "auto";

export const state = reactive({
  songs: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  mode: "continuous", // 'continuous' 连播 | 'karaoke' 跟唱
  playMode: "order", // 连播播放模式：'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
  karaokeOn: true, // 跟唱开关：开=每句播完自动停
  karaokeLoop: false, // 单句循环：跟唱开启时生效，句末自动回到句首重播
  abLoop: null, // AB 区间循环：null 关闭 | { a, b } 起点/终点（行索引，b 为 null 表示等选终点）
  speed: 1.0,
  zhVisible: true,
  lyric: [], // [{type:'sec',name} | {type:'line',s,e,text:[jp,roma,zh]}]
  lyricFormat: null, // 'srt' | 'lrc' | null
  libraryPath: "",
  loading: false,
  error: "",
  volume: 1.0, // 音量 0~1
  muted: false,
  favorites: [], // 收藏歌曲 path 列表（后端持久化）
  playlists: [], // 歌单列表（后端持久化）
  activePlaylistId: null, // 当前浏览的歌单 id；null = 全部歌曲
  libraryVersion: null, // 歌曲库变动版本号（轮询对比，变化则自动刷新列表）
  musicLibOpen: true, // 音乐库面板开关（左侧 tab 栏控制，localStorage 持久化）
  playlistOpen: true, // 播放列表面板开关
  controlsHidden: false, // 播放控制区收起（向下隐藏，localStorage 持久化）（左侧 tab 栏控制，localStorage 持久化）
  lastSource: "manual", // 最近一次选歌来源：manual | auto | media（播放统计用）
});

// ============ 歌词显示设置（localStorage 持久化）============
export const LYRIC_SETTINGS_KEY = "qqplayer.lyricSettings.v1";

export const lyricSettings = reactive({
  fontFamily: "system", // 'system' 系统默认 | 'serif' 衬线 | 'rounded' 圆体
  fontSize: 20, // 当前句基准字号（px），其他层级按比例缩放
  align: "left", // 'left' | 'center' | 'right'
  showRoma: true, // 显示罗马音
  showZh: true, // 显示中文翻译
  showSec: true, // 显示段落标题
  focusPos: 0.33, // 焦点句停靠位置（可视区高度比例）：0.33 | 0.5
  fadeMask: true, // 上下渐隐遮罩
  autoScroll: true, // 切句自动跟随滚动
});

// ============ 界面偏好（localStorage 持久化）============
export const UI_SETTINGS_KEY = "qqplayer.uiSettings.v1";

export const uiSettings = reactive({
  showSongInfo: false, // 跟唱模式歌词面板顶部显示当前歌曲信息（歌名/歌手）
  karaokeShowTime: false, // 跟唱模式每句显示起止时间戳
  karaokeShowNum: true, // 跟唱模式每句左侧显示行号（默认显示，用户可关）
});

function loadUiSettings() {
  try {
    const raw = localStorage.getItem(UI_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(uiSettings)) {
      if (k in saved) uiSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadUiSettings();

watch(
  uiSettings,
  () => {
    try {
      localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify(uiSettings));
    } catch {
      /* 忽略写入失败 */
    }
  },
  { deep: true },
);

function loadLyricSettings() {
  try {
    const raw = localStorage.getItem(LYRIC_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(lyricSettings)) {
      if (k in saved) lyricSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadLyricSettings();

watch(
  lyricSettings,
  () => {
    try {
      localStorage.setItem(LYRIC_SETTINGS_KEY, JSON.stringify(lyricSettings));
    } catch {
      /* 忽略写入失败 */
    }
  },
  { deep: true },
);

// ============ 音量（localStorage 持久化）============
export const VOLUME_KEY = "qqplayer.volume.v1";

function loadVolume() {
  try {
    const v = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (!isNaN(v) && v >= 0 && v <= 1) {
      state.volume = v;
      audio.volume = v;
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadVolume();

function persistVolume() {
  try {
    localStorage.setItem(VOLUME_KEY, String(state.volume));
  } catch {
    /* 忽略写入失败 */
  }
}

export function setVolume(v) {
  state.volume = Math.min(1, Math.max(0, v));
  state.muted = false; // 手动调音量自动取消静音
  audio.volume = state.volume;
  persistVolume();
}

export function toggleMute() {
  state.muted = !state.muted;
  audio.volume = state.muted ? 0 : state.volume;
}

// ============ 收藏（后端持久化 ~/Library/Application Support/qqplayer）============
export async function loadFavorites() {
  try {
    const res = await fetch("/api/favorites", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.favorites = data.paths || [];
    }
  } catch {
    /* 忽略 */
  }
}

export function isFavorite(path) {
  return state.favorites.includes(path);
}

export async function toggleFavorite(path) {
  // 乐观更新：先改 UI，失败回滚
  const wasFav = state.favorites.includes(path);
  if (wasFav) {
    state.favorites.splice(state.favorites.indexOf(path), 1);
  } else {
    state.favorites.push(path);
  }
  try {
    await fetch("/api/favorites/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
  } catch {
    // 回滚
    if (wasFav) {
      state.favorites.push(path);
    } else {
      state.favorites.splice(state.favorites.indexOf(path), 1);
    }
  }
}

// ============ 歌单（后端持久化 ~/Library/Application Support/qqplayer/playlists.json）============
export async function loadPlaylists() {
  try {
    const res = await fetch("/api/playlists", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      state.playlists = data.playlists || [];
      // 当前激活的歌单被删了 → 退回全部歌曲
      if (state.activePlaylistId && !state.playlists.some((p) => p.id === state.activePlaylistId)) {
        state.activePlaylistId = null;
      }
    }
  } catch {
    /* 忽略 */
  }
}

export const activePlaylist = computed(
  () => state.playlists.find((p) => p.id === state.activePlaylistId) || null,
);

function _playlistById(pid) {
  return state.playlists.find((p) => p.id === pid) || null;
}

export function isInPlaylist(pid, path) {
  const p = _playlistById(pid);
  return !!p && (p.songPaths || []).includes(path);
}

export async function createPlaylist(name) {
  const res = await fetch("/api/playlists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: name.trim() }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "创建歌单失败");
  }
  const p = await res.json();
  state.playlists.push(p);
  return p;
}

export async function renamePlaylist(pid, name) {
  const p = _playlistById(pid);
  if (!p) return;
  const old = p.name;
  p.name = name.trim(); // 乐观更新
  try {
    const res = await fetch(`/api/playlists/${pid}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!res.ok) throw new Error();
  } catch {
    p.name = old; // 回滚
    throw new Error("改名失败");
  }
}

export async function deletePlaylist(pid) {
  const idx = state.playlists.findIndex((p) => p.id === pid);
  if (idx < 0) return;
  const [removed] = state.playlists.splice(idx, 1);
  if (state.activePlaylistId === pid) state.activePlaylistId = null;
  try {
    const res = await fetch(`/api/playlists/${pid}`, { method: "DELETE" });
    if (!res.ok) throw new Error();
  } catch {
    state.playlists.splice(idx, 0, removed); // 回滚
    throw new Error("删除失败");
  }
}

export async function addToPlaylist(pid, path) {
  const p = _playlistById(pid);
  if (!p || isInPlaylist(pid, path)) return;
  p.songPaths.push(path); // 乐观更新
  try {
    const res = await fetch(`/api/playlists/${pid}/songs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) throw new Error();
  } catch {
    p.songPaths = p.songPaths.filter((x) => x !== path); // 回滚
    throw new Error("加入歌单失败");
  }
}

export async function removeFromPlaylist(pid, path) {
  const p = _playlistById(pid);
  if (!p) return;
  const removed = p.songPaths.filter((x) => x === path);
  p.songPaths = p.songPaths.filter((x) => x !== path); // 乐观更新
  try {
    const res = await fetch(`/api/playlists/${pid}/songs/${encodeURIComponent(path)}`, {
      method: "DELETE",
    });
    if (!res.ok) throw new Error();
  } catch {
    p.songPaths.push(...removed); // 回滚
    throw new Error("移出歌单失败");
  }
}

export async function setPlaylistOrder(pid, paths) {
  const p = _playlistById(pid);
  if (!p) return;
  const old = p.songPaths;
  p.songPaths = paths; // 乐观更新
  try {
    const res = await fetch(`/api/playlists/${pid}/order`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    });
    if (!res.ok) throw new Error();
  } catch {
    p.songPaths = old; // 回滚
    throw new Error("排序保存失败");
  }
}

// ============ 队列操作 ============
export function removeFromQueue(index) {
  if (index < 0 || index >= state.songs.length) return;
  state.songs.splice(index, 1);
  if (index < state.currentIndex) {
    state.currentIndex -= 1;
  } else if (index === state.currentIndex) {
    if (state.songs.length) {
      // 移除当前歌：切到原位置的新歌（索引已自然顺延）
      const next = Math.min(index, state.songs.length - 1);
      selectSong(next);
    } else {
      state.currentIndex = -1;
      state.currentSong = null;
      state.isPlaying = false;
      state.lyric = [];
      state.lyricFormat = null;
      audio.pause();
      audio.removeAttribute("src");
    }
  }
  // 歌曲列表变了：洗牌队列失效，下次自动重建
  _resetPlayMode();
}

// ============ 播放会话跟踪（上报播放统计）============
// 每次完整播放会话（选歌→播放→切走/暂停/播完）结束后上报一条记录到 /api/playback
// 细节：记录实际播放秒数/总时长/完成度/来源/模式；少于 3 秒的误触不记

let playbackSession = null; // { path,name,artist,album,startedAt,lastTickAt }

function currentPlaybackSource() {
  // 播放来源：媒体键/自动切歌/手动选歌（后续可扩展）
  return state.lastSource || "manual";
}

// 上报一条播放记录（POST /api/playback；失败静默，不影响播放）
async function reportPlayback(rec) {
  try {
    await fetch("/api/playback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec),
    });
  } catch {
    /* 忽略 */
  }
}

// 结束当前播放会话并上报（播放不足 3 秒视为误触不记）
// 返回生成的记录（未达阈值返回 null）；由调用方决定发送方式（fetch/sendBeacon）
export function flushPlaybackSession() {
  const s = playbackSession;
  if (!s) return null;
  playbackSession = null;
  const played = (Date.now() - s.startedAt) / 1000;
  if (played < 3) return null; // 误触/短切
  const rec = {
    ts: new Date().toISOString(),
    path: s.path,
    name: s.name,
    artist: s.artist,
    album: s.album,
    played: Math.round(played * 10) / 10,
    duration: s.duration || 0,
    ratio: s.duration ? Math.min(1, Math.round((played / s.duration) * 100) / 100) : 0,
    completed: s.completed || false,
    source: s.source || "manual",
    mode: s.mode || "continuous",
    device: s.device || "mac",
  };
  reportPlayback(rec);
  return rec;
}

// 开始跟踪当前歌曲的播放会话（歌曲变化时由 selectSong 调用；audio play 事件里建）
function startPlaybackSession() {
  const song = state.currentSong;
  if (!song) return;
  playbackSession = {
    path: song.path,
    name: song.name || "",
    artist: song.artist || "",
    album: song.album || "",
    duration: state.duration || audio.duration || 0,
    startedAt: Date.now(),
    completed: false,
    source: currentPlaybackSource(),
    mode: state.mode,
    device: "mac",
  };
}

// 仅供测试：重置播放会话跟踪状态
// 注意：模块级 playbackSession 会跨测试残留，beforeEach 必须调用
export function _resetPlaybackSession() {
  playbackSession = null;
}

// ============ 键盘快捷键 ============
// 空格播放/暂停，←/→ 快退/快进 10s，↑/↓ 音量 ±10%
// 媒体键（MediaPlayPause 等）仅在无 MediaSession 的环境兜底处理（键盘事件），
// 有 MediaSession 时交给系统（避免双重触发）
const HAS_MEDIA_SESSION = typeof navigator !== "undefined" && "mediaSession" in navigator;
const MEDIA_KEY_CODES = ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaStop"];

// 输入框/文本域聚焦时不拦截（媒体键除外：即使输入框聚焦也应全局响应）
const SHORTCUT_HANDLER = (e) => {
  const el = e.target;
  const isMediaKey = !HAS_MEDIA_SESSION && MEDIA_KEY_CODES.includes(e.code);
  if (
    !isMediaKey &&
    el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  ) {
    return;
  }
  switch (e.code) {
    case "Space":
      e.preventDefault();
      togglePlay();
      break;
    case "MediaPlayPause":
      e.preventDefault();
      togglePlay();
      break;
    case "MediaTrackNext":
      e.preventDefault();
      nextSong({ autoPlay: true, source: "media" });
      break;
    case "MediaTrackPrevious":
      e.preventDefault();
      prevSong({ autoPlay: true, source: "media" });
      break;
    case "MediaStop":
      e.preventDefault();
      pause();
      break;
    case "ArrowLeft":
      e.preventDefault();
      seek(Math.max(0, (audio.currentTime || 0) - 10));
      break;
    case "ArrowRight":
      e.preventDefault();
      seek(Math.min(audio.duration || 0, (audio.currentTime || 0) + 10));
      break;
    case "ArrowUp":
      e.preventDefault();
      setVolume(state.volume + 0.1);
      break;
    case "ArrowDown":
      e.preventDefault();
      setVolume(state.volume - 0.1);
      break;
  }
};

// 安装快捷键监听（App onMounted 调用）；返回卸载函数
export function setupKeyboardShortcuts() {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("keydown", SHORTCUT_HANDLER);
  return () => window.removeEventListener("keydown", SHORTCUT_HANDLER);
}

// ============ 系统媒体键（MediaSession）============
// Mac 键盘媒体键 / 控制中心 / 锁屏：播放暂停、上下曲、进度 seek、歌名/歌手/封面
// 全部 feature-detect：环境无 MediaSession 时零副作用（测试/旧浏览器）

let mediaSessionPosSync = 0; // setPositionState 节流时间戳

// 相对路径 → 绝对 URL（artwork 要求绝对地址；无 window 环境原样返回）
function absoluteUrl(path) {
  if (typeof window === "undefined") return path;
  try {
    return new URL(path, window.location.href).href;
  } catch {
    return path;
  }
}

function updateMediaMetadata() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  if (!ms) return;
  const song = state.currentSong;
  if (!song) {
    ms.metadata = null;
    return;
  }
  const artwork = song.path
    ? [
        {
          src: absoluteUrl("/api/cover?path=" + encodeURIComponent(song.path)),
          sizes: "512x512",
        },
      ]
    : [];
  ms.metadata = new MediaMetadata({
    title: song.name || "未知歌曲",
    artist: song.artist || "",
    album: song.album || "",
    artwork,
  });
}

function syncMediaPlaybackState() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  if (!ms) return;
  ms.playbackState = state.isPlaying ? "playing" : "paused";
}

function syncMediaPosition() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
  const ms = navigator.mediaSession;
  if (!ms || !audio.src) return;
  const now = Date.now();
  if (now - mediaSessionPosSync < 1000) return; // 节流 1s
  mediaSessionPosSync = now;
  try {
    ms.setPositionState({
      duration: audio.duration || 0,
      playbackRate: audio.playbackRate,
      position: audio.currentTime || 0,
    });
  } catch {
    /* 部分浏览器 duration 未就绪时抛错，忽略 */
  }
}

// 安装媒体键监听（App onMounted 调用）；返回卸载函数
// 每次调用注册独立 watch，卸载时一并停止
let mediaSessionStop = null;

export function setupMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return () => {};
  }
  const ms = navigator.mediaSession;
  // 初始化为 paused（而非默认 none）：Chrome/系统媒体键只路由给 playbackState
  // 非 none 的页面，否则未播放过时按播放键无响应
  ms.playbackState = state.isPlaying ? "playing" : "paused";
  const handlers = {
    play: () => play(),
    pause: () => pause(),
    previoustrack: () => prevSong({ autoPlay: true, source: "media" }),
    nexttrack: () => nextSong({ autoPlay: true, source: "media" }),
    seekto: (details) => {
      if (details && typeof details.seekTime === "number") seek(details.seekTime);
    },
    seekbackward: (details) => {
      const offset = details?.seekOffset || 10;
      seek(Math.max(0, (audio.currentTime || 0) - offset));
    },
    seekforward: (details) => {
      const offset = details?.seekOffset || 10;
      seek(Math.min(audio.duration || 0, (audio.currentTime || 0) + offset));
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* 不支持的 action 忽略 */
    }
  }
  // 切歌 → 更新控制中心/锁屏信息（卸载时停止监听）
  mediaSessionStop?.();
  mediaSessionStop = watch(() => state.currentSong, updateMediaMetadata, { immediate: true });
  return () => {
    mediaSessionStop?.();
    mediaSessionStop = null;
    for (const action of Object.keys(handlers)) {
      try {
        ms.setActionHandler(action, null);
      } catch {
        /* 忽略 */
      }
    }
  };
}

const SPEEDS = [0.75, 1.0, 1.25];

// ============ 连播播放模式（列表循环/随机/单曲循环）============
let shuffleQueue = []; // 洗牌队列：歌曲索引排列（随机模式用）
let shufflePos = -1; // 当前歌曲在队列中的位置
let playHistory = []; // 播放历史栈（歌曲索引），随机模式"上一首"回退用

// 生成洗牌队列：leader（通常为当前歌）固定队首，其余 Fisher-Yates 随机
function buildShuffleQueue(leader) {
  const n = state.songs.length;
  if (!n) {
    shuffleQueue = [];
    shufflePos = -1;
    return;
  }
  const rest = [];
  for (let i = 0; i < n; i++) if (i !== leader) rest.push(i);
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  shuffleQueue = leader >= 0 ? [leader, ...rest] : rest;
  shufflePos = leader >= 0 ? 0 : -1;
}

// 队列失效（歌曲列表变化 / 当前歌不在队列）时重建
function ensureShuffleQueue() {
  if (
    shuffleQueue.length !== state.songs.length ||
    (state.currentIndex >= 0 && !shuffleQueue.includes(state.currentIndex))
  ) {
    buildShuffleQueue(state.currentIndex);
  }
}

// 随机模式下一首：队列顺序推进，一轮播完以当前歌为队首重新洗牌
// opts.autoPlay=true 时（播完自动切歌）切到新歌后继续播放
function nextShuffle(opts = {}) {
  ensureShuffleQueue();
  if (shufflePos >= shuffleQueue.length - 1) {
    buildShuffleQueue(state.currentIndex);
    if (shuffleQueue.length > 1) {
      selectSong(shuffleQueue[1], opts);
      return;
    }
    // 只有一首歌：无法推进 → 重播本首
    if (state.currentIndex >= 0 && audio.src) {
      audio.currentTime = 0;
      state.currentTime = 0;
      if (opts.autoPlay) audio.play().catch(() => {});
    }
    return;
  }
  selectSong(shuffleQueue[shufflePos + 1], opts);
}

// 三态循环：列表循环 → 随机 → 单曲循环 → 列表循环
// 注意与跟唱模式的"单句循环/AB 循环"（歌词行级）区分：这是歌曲级播放模式
export function cyclePlayMode() {
  const order = ["order", "shuffle", "repeatOne"];
  state.playMode = order[(order.indexOf(state.playMode) + 1) % order.length];
  if (state.playMode === "shuffle") ensureShuffleQueue();
}

// 仅供测试：重置播放模式内部状态（洗牌队列/播放历史）
export function _resetPlayMode() {
  shuffleQueue = [];
  shufflePos = -1;
  playHistory = [];
}

// ============ 侧栏面板开关（左侧 tab 栏，localStorage 持久化）============
export const PANEL_KEY = "qqplay…p.v1";
export const CONTROLS_KEY = "qqplayer.controls.v1";

function loadPanels() {
  try {
    const raw = localStorage.getItem(PANEL_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved.musicLib === "boolean") state.musicLibOpen = saved.musicLib;
      if (typeof saved.playlist === "boolean") state.playlistOpen = saved.playlist;
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
  try {
    state.controlsHidden = localStorage.getItem(CONTROLS_KEY) === "1";
  } catch {
    /* 忽略 */
  }
}
loadPanels();

function persistPanels() {
  try {
    localStorage.setItem(
      PANEL_KEY,
      JSON.stringify({ musicLib: state.musicLibOpen, playlist: state.playlistOpen }),
    );
  } catch {
    /* 忽略 */
  }
}

export function toggleMusicLib() {
  state.musicLibOpen = !state.musicLibOpen;
  persistPanels();
}

export function togglePlaylist() {
  state.playlistOpen = !state.playlistOpen;
  persistPanels();
}

export function toggleControls() {
  state.controlsHidden = !state.controlsHidden;
  try {
    localStorage.setItem(CONTROLS_KEY, state.controlsHidden ? "1" : "0");
  } catch {
    /* 忽略 */
  }
}

// ============ 歌曲列表 ============
export async function loadLibrary() {
  try {
    const res = await fetch("/api/library", { cache: "no-store" });
    const data = await res.json();
    state.libraryPath = data.path;
  } catch {
    /* 忽略 */
  }
}

export async function setLibrary(path) {
  const res = await fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || "设置失败");
  }
  await loadSongs();
}

export async function loadSongs() {
  state.loading = true;
  state.error = "";
  try {
    const res = await fetch("/api/songs", { cache: "no-store" });
    const songs = await res.json();
    state.songs = songs;
    if (songs.length && state.currentIndex < 0) {
      state.currentIndex = 0;
      await selectSong(0);
    } else if (songs.length && state.currentSong) {
      // 刷新后保持当前选中
      const idx = songs.findIndex((s) => s.path === state.currentSong.path);
      if (idx >= 0) state.currentIndex = idx;
    }
  } catch (e) {
    state.error = "加载歌曲列表失败：" + e.message;
  } finally {
    state.loading = false;
  }
}

// ============ 歌曲库自动刷新（iCloud 文件夹变动） ============
let refreshTimer = null;

export function setupAutoRefresh(intervalMs = 3000) {
  // 幂等：重复调用不叠加 timer
  if (refreshTimer) return;
  refreshTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/library/version", { cache: "no-store" });
      const { version } = await res.json();
      if (state.libraryVersion == null) {
        state.libraryVersion = version;
      } else if (version !== state.libraryVersion) {
        state.libraryVersion = version;
        await loadSongs(); // 刷新后保持当前选中/播放（loadSongs 已处理）
      }
    } catch {
      // 后端暂不可用：静默，下轮重试
    }
  }, intervalMs);
}

export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}

// ============ 选歌 ============
export async function selectSong(index, opts = {}) {
  if (index < 0 || index >= state.songs.length) return;
  // 切歌：先上报旧歌的播放会话（若正在播放）
  // 自然播完（ended 触发自动切歌）时 audio.ended=true → 标记 completed
  if (playbackSession) playbackSession.completed = audio.ended;
  flushPlaybackSession();
  // 记录本次选歌来源（播放事件建会话时使用）
  state.lastSource = opts.source || "manual";
  // 播放历史：记录旧歌（随机模式"上一首"回退）；回退本身不记录
  if (opts.record !== false && state.currentIndex >= 0 && state.currentIndex !== index) {
    playHistory.push(state.currentIndex);
    if (playHistory.length > 100) playHistory.shift();
  }
  // 洗牌队列定位：手动选了队列外的歌 → 以它为队首重建队列
  const qIdx = shuffleQueue.indexOf(index);
  if (qIdx >= 0) {
    shufflePos = qIdx;
  } else {
    buildShuffleQueue(index);
  }
  state.currentIndex = index;
  state.currentSong = state.songs[index];
  state.isPlaying = false;
  audio.pause();
  audio.src = "/api/audio?path=" + encodeURIComponent(state.songs[index].path);
  audio.playbackRate = state.speed;
  state.currentTime = 0;
  state.duration = 0;
  state.lyric = [];
  state.lyricFormat = null;
  state.abLoop = null; // 切歌重置 AB 循环
  // 自动播放（播完自动切歌场景）：上一首结束切到新歌后继续播放
  if (opts.autoPlay) {
    audio.play().catch(() => {});
  }
  // 加载歌词
  try {
    const res = await fetch("/api/lyric?path=" + encodeURIComponent(state.songs[index].path), {
      cache: "no-store",
    });
    if (res.ok) {
      const data = await res.json();
      state.lyric = data.lines || [];
      state.lyricFormat = data.format || null;
    }
  } catch {
    state.lyric = [];
    state.lyricFormat = null;
  }
  // 预取时长
  audio.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = audio.duration || 0;
    },
    { once: true },
  );
}

// ============ 播放控制 ============
export function togglePlay() {
  if (!state.currentSong) return;
  if (audio.paused) {
    play(); // 带跟唱锚点重定位（句末暂停后再播 → 锚定下一句）
  } else {
    audio.pause();
  }
}

export function play() {
  // 没选歌时：自动选第一首播放（媒体键/播放键直接开播）
  if (!state.currentSong) {
    if (state.songs.length) {
      selectSong(0, { autoPlay: true, source: "auto" });
    }
    return;
  }
  // 播完停在末尾（ended）→ 归零重播；否则 audio.play() 停在末尾不响
  if (audio.ended || (audio.duration && audio.currentTime >= audio.duration - 0.1)) {
    audio.currentTime = 0;
    state.currentTime = 0;
  }
  // 重新锚定当前时间所在句（-1 = 前奏/间隙，播到下一句时自动锚定）
  karaokeLine = locateLine(audio.currentTime);
  audio.play().catch(() => {});
}

export function pause() {
  audio.pause();
}

export function nextSong(opts = {}) {
  if (state.songs.length === 0) return;
  if (state.playMode === "shuffle") {
    nextShuffle(opts);
    return;
  }
  selectSong((state.currentIndex + 1) % state.songs.length, opts);
}

export function prevSong(opts = {}) {
  if (state.songs.length === 0) return;
  if (state.playMode === "shuffle" && playHistory.length) {
    // 随机模式：按播放历史回退到上一首（不重复记录）
    selectSong(playHistory.pop(), { record: false, ...opts });
    return;
  }
  selectSong((state.currentIndex - 1 + state.songs.length) % state.songs.length, opts);
}

export function seek(t) {
  if (!audio.src) return;
  audio.currentTime = t;
  state.currentTime = t;
  // 跳转后重定位跟唱锚点，避免旧锚点立刻触发暂停/漏停
  karaokeLine = locateLine(t);
}

export function cycleSpeed() {
  const i = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(i + 1) % SPEEDS.length];
  audio.playbackRate = state.speed;
}

export function toggleKaraoke() {
  state.karaokeOn = !state.karaokeOn;
}

export function toggleKaraokeLoop() {
  state.karaokeLoop = !state.karaokeLoop;
}

// ============ AB 区间循环（长按循环按钮进入，单击退出）============
// 进入：当前句为起点 A，等待点击另一句作为终点 B
// 循环：A→B 区间句子连播，播到 B 句尾自动跳回 A 句首

export function enterAbLoop() {
  if (state.abLoop) return; // 已在 AB 循环中，忽略
  const cur = currentLineIndex.value;
  if (cur < 0) return; // 无当前句（前奏/间隙）→ 忽略
  state.abLoop = { a: cur, b: null }; // b=null 等待选终点
  playLine(cur); // 从起点句开始播
}

export function setAbEnd(lineIndex) {
  if (!state.abLoop) return;
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  if (lineIndex === state.abLoop.a) return; // 点起点本身 → 忽略
  let a = state.abLoop.a;
  let b = lineIndex;
  if (b < a) [a, b] = [b, a]; // 终点在起点前 → 自动交换
  state.abLoop = { a, b };
  playLine(a); // 从区间起点句首开始播
}

export function exitAbLoop() {
  state.abLoop = null;
}

// 歌词点击统一入口（跟唱面板）
// 无 AB → 直接播放该句；等选终点（b=null）→ 点击设为终点；
// 区间内 → 跳到该句播放（区间不变）；区间外 → 退出 AB 循环并播放该句
// （2026-08-12 用户拍板：区间外点击 = 退出 AB + 播放当前句；区间内 = 跳转播放）
export function clickLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ab = state.abLoop;
  if (!ab) {
    playLine(lineIndex);
    return;
  }
  if (ab.b === null) {
    setAbEnd(lineIndex); // 等选终点：点击 = 设置终点
    return;
  }
  if (lineIndex < ab.a || lineIndex > ab.b) {
    // 区间外：退出 AB 循环，恢复正常跟唱并播放该句
    state.abLoop = null;
    playLine(lineIndex);
    return;
  }
  // 区间内：跳到该句句首播放，AB 区间保持不变
  playLine(lineIndex);
}

export function toggleZh() {
  state.zhVisible = !state.zhVisible;
}

// ============ 跟唱模式：点句跳转 ============
const lineItems = computed(() => state.lyric.filter((x) => x.type === "line"));

// 跟唱模式锚点：正在唱的句子索引（-1 = 未锚定，如前奏/间隙）
// 不靠每次 timeupdate 反推当前句——句末 e 一过 currentLineIndex 就指向下一句，
// "反推"永远判断不出该停，导致一句唱完不停
let karaokeLine = -1;

// 严格区间匹配：t 落在哪一句内（不含间隙/前奏/尾声）
function locateLine(t) {
  const lines = lineItems.value;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].s && t < lines[i].e) return i;
  }
  return -1;
}

// 仅供测试：重置跟唱锚点
export function _resetKaraokeAnchor() {
  karaokeLine = -1;
}

// 跳到某句句首；keepPlaying=true 时若暂停中则继续播
function jumpToLine(lineIndex, keepPlaying) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  karaokeLine = lineIndex;
  audio.currentTime = lines[lineIndex].s;
  state.currentTime = lines[lineIndex].s;
  if (keepPlaying && audio.paused) audio.play().catch(() => {});
}

export function playLine(lineIndex) {
  const lines = lineItems.value;
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const ln = lines[lineIndex];
  karaokeLine = lineIndex;
  audio.currentTime = ln.s;
  audio.play().catch(() => {});
}

export function prevLine() {
  const cur = currentLineIndex.value;
  if (cur > 0) playLine(cur - 1);
}

export function nextLine() {
  const lines = lineItems.value;
  const cur = currentLineIndex.value;
  if (cur >= 0 && cur < lines.length - 1) playLine(cur + 1);
}

// 当前高亮句（按时间戳定位）
// 取「最后一条已开始的句子」：句间间隙（上一句 e ~ 下一句 s）中保持上一句，
// 播放结束后保持最后一句；这样跟唱模式 timeupdate 才能识别「该停了」
export const currentLineIndex = computed(() => {
  const lines = lineItems.value;
  if (!lines.length) return -1;
  // 跟唱模式暂停（含句末自动停）时保持锚点句：句尾边界 e == 下一句 s 时，
  // 时间反推（t >= s）会把停在句尾的音频判进下一句 → 视觉上"播完自动跳下一句"；
  // 跟唱要反复练同一句，暂停时应该始终停留在刚唱完的那句
  if (state.mode === "karaoke" && karaokeLine >= 0 && !state.isPlaying) {
    return karaokeLine;
  }
  const t = state.currentTime;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (t >= lines[i].s) idx = i;
    else break;
  }
  return idx;
});

// ============ 音频事件 ============
audio.addEventListener("timeupdate", () => {
  state.currentTime = audio.currentTime;
  syncMediaPosition();
  // 跟唱模式：每句播完自动停（锚点方案）
  if (state.mode === "karaoke" && state.karaokeOn) {
    const lines = lineItems.value;
    if (!lines.length) return;
    const t = audio.currentTime;
    // 锚点失效（前奏/间隙未锚定，或 seek/回退到锚点句之前）→ 重新定位
    if (karaokeLine < 0 || t < lines[karaokeLine].s) {
      karaokeLine = locateLine(t);
    }
    if (karaokeLine >= 0 && t >= lines[karaokeLine].e) {
      // 循环处理句末：一次跳变可能跨多个短句，逐句推进直到落在句内或触发跳转（guard 防死循环）
      let guard = 0;
      while (karaokeLine >= 0 && t >= lines[karaokeLine].e && guard++ < 20) {
        const ab = state.abLoop;
        if (ab && karaokeLine >= ab.a) {
          if (ab.b !== null && karaokeLine === ab.b) {
            // AB 终点句播完 → 跳回起点句首重播
            jumpToLine(ab.a, true);
            break;
          }
          if (ab.b === null || karaokeLine < ab.b) {
            if (ab.b === null) {
              // 等选终点：起点句循环
              jumpToLine(ab.a, true);
              break;
            }
            // 起点/区间中间句播完 → 锚点推进下一句，继续播放
            karaokeLine += 1;
            continue;
          }
          // seek 跳出区间到终点之后：按单句循环/暂停处理
        }
        if (state.karaokeLoop) {
          // 单句循环：回到句首重播（不暂停）
          jumpToLine(karaokeLine, true);
        } else {
          audio.pause();
        }
        break;
      }
    }
  }
});

audio.addEventListener("play", () => {
  state.isPlaying = true;
  syncMediaPlaybackState();
  // 真正开始出声才建播放会话：选歌但未播放不记；
  // 若已跟踪的歌不同（换歌后立即播放）→ 先上报旧会话
  const song = state.currentSong;
  if (song && (!playbackSession || playbackSession.path !== song.path)) {
    flushPlaybackSession();
    startPlaybackSession();
  }
});
audio.addEventListener("pause", () => {
  state.isPlaying = false;
  syncMediaPlaybackState();
  // 暂停：结束当前播放会话并上报（跟唱模式句间自动暂停也会触发——
  // 但因每句间隔很短，连续跟唱会被下一句 play 合并？不会——pause 即 flush，
  // 跟唱模式每句暂停都会产生一条短记录。处理：跟唱模式下不因句间暂停 flush，
  // 而是等切歌/播完/退出模式时再报。
  // 这里仅对连播模式的主动暂停 flush；跟唱模式交还给时间锚点逻辑。
  if (state.mode === "continuous" && playbackSession) {
    flushPlaybackSession();
  }
});
audio.addEventListener("ended", () => {
  state.isPlaying = false;
  syncMediaPlaybackState();
  // 自然播完：标记 completed 后上报（repeatOne 除外，同一首歌继续听）
  if (playbackSession && state.playMode !== "repeatOne") {
    playbackSession.completed = true;
    flushPlaybackSession();
  }
  if (state.mode !== "continuous") return;
  if (state.playMode === "repeatOne") {
    // 单曲循环：重播本首
    audio.currentTime = 0;
    state.currentTime = 0;
    audio.play().catch(() => {});
    return;
  }
  if (state.playMode === "shuffle") {
    nextShuffle({ autoPlay: true, source: "auto" });
    return;
  }
  // 列表循环：顺序下一首并自动播放（连播 bug：只切歌不播放）
  nextSong({ autoPlay: true, source: "auto" });
});

// ============ 页面标题 ============
watch(
  () => state.currentSong?.name,
  (name) => {
    document.title = name ? `QQ Player - ${name}` : "🎵 QQ Player";
  },
);

// ============ 播放统计：模式切换/页面关闭兜底 ============
// 切到跟唱/连播：当前会话结束上报（跟唱模式句间暂停不逐条上报，切歌/切模式/播完才记）
watch(
  () => state.mode,
  () => {
    flushPlaybackSession();
  },
);

// 页面关闭/刷新：sendBeacon 兜底上报未结束的会话（fetch 在卸载时不可靠）
export function setupPlaybackFlush() {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    // 直接构造并 beacon：不能用 flushPlaybackSession（它走 fetch，卸载时会被取消）
    const s = playbackSession;
    if (!s) return;
    playbackSession = null;
    const played = (Date.now() - s.startedAt) / 1000;
    if (played < 3) return;
    const rec = {
      ts: new Date().toISOString(),
      path: s.path,
      name: s.name,
      artist: s.artist,
      album: s.album,
      played: Math.round(played * 10) / 10,
      duration: s.duration || 0,
      ratio: s.duration ? Math.min(1, Math.round((played / s.duration) * 100) / 100) : 0,
      completed: s.completed || false,
      source: s.source || "manual",
      mode: s.mode || "continuous",
      device: s.device || "mac",
    };
    try {
      navigator.sendBeacon(
        "/api/playback",
        new Blob([JSON.stringify(rec)], { type: "application/json" }),
      );
    } catch {
      /* 忽略 */
    }
  };
  window.addEventListener("pagehide", handler);
  window.addEventListener("beforeunload", handler);
  return () => {
    window.removeEventListener("pagehide", handler);
    window.removeEventListener("beforeunload", handler);
  };
}
