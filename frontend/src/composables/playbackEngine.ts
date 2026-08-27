// 播放域（P1-2 批次2：从 playerCore.js 拆出）
//
// 播放设置归一化（eqGains/_normalizeEqPreset/playMode watch）、模式记忆、playerToast、
// 播放会话、播放控制、恢复上次播放、跟唱 ticker、页面标题、播放统计兜底。
// 依赖方向：playerState、audioEngine、queueEngine、useEq、useLyric、useAbLoop、
// settingsSync、uiState（单向，无循环）。
//
// 循环依赖处理（与原始 playerCore.js 的行为零变化）：
//   - playbackSettings 本体 + loadPlaybackSettings 在 playerState（低层共享数据）。
//   - 本模块在模块求值期把播放会话/toast 回调注入 queueEngine（registerPlaybackHooks）、
//     把播放事件回调注入 audioEngine（registerAudioEventHooks），避免双向 import。
//   - 跟唱句末处理（handleKaraokeTick）在 useAbLoop；useAbLoop 只依赖
//     playerState/audioEngine/useLyric，故 playbackEngine → useAbLoop 单向无环。
import { reactive, watch } from "vue";
import {
  state,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  PLAYBACK_SETTINGS_DEFAULTS,
  type Song,
  type PlaybackSession,
} from "./playerState.ts";
import { audio, applySpeed, VOLUME_KEY, registerAudioEventHooks } from "./audioEngine.ts";
import {
  selectSong,
  nextShuffle,
  SPEEDS,
  playHistory,
  dbgLog,
  ensureShuffleQueue,
  registerPlaybackHooks,
  isStreamSong,
  isPreviewSong,
  type SelectSongOpts,
} from "./queueEngine.ts";
import { _normalizeEqPreset } from "./useEq.js";
import { reanchorKaraoke } from "./useLyric.js";
import { handleKaraokeTick } from "./useAbLoop.js";
import { registerPlayerBridge, settingsLoadPromise } from "./settingsSync.js";
import { UI_STATE_KEY } from "./uiState.ts";
import { apiPost, scheduleFlush } from "../utils/apiClient.js";
import { enqueuePendingOp } from "../utils/cacheDb.js";

// 播放记录（POST /api/playback 载荷）
export interface PlaybackRecord {
  ts: string;
  path: string | null;
  name: string;
  artist: string;
  album: string;
  played: number;
  duration: number;
  ratio: number;
  completed: boolean;
  source: string;
  mode: string;
  device: string;
}

// ============ 播放设置脏数据归一化 + 播放模式 watch ============
// 注：loadPlaybackSettings 本体 + playMode 启动恢复在 playerState（与 playbackSettings 同模块）；
// 这里补做需要跨域数据的归一化与联动（eqGains/_normalizeEqPreset 需 useEq；
// playMode watch 需 queueEngine.ensureShuffleQueue——放 playerState 会成环）。
// 脏数据归一化：eqGains 必须是长度 10 的数组，值 clamp 到 ±12
if (!Array.isArray(playbackSettings.eqGains) || playbackSettings.eqGains.length !== 10) {
  playbackSettings.eqGains = [...PLAYBACK_SETTINGS_DEFAULTS.eqGains];
} else {
  playbackSettings.eqGains = playbackSettings.eqGains.map((g) =>
    Math.min(12, Math.max(-12, Number(g) || 0)),
  );
}
// eqPreset 非法值回落 flat（EQ_PRESETS 定义后执行；校验逻辑在 useEq.js）
_normalizeEqPreset();

// 设置弹窗里改播放模式 → 立即生效（含洗牌队列初始化）
watch(
  () => playbackSettings.playMode,
  (m) => {
    state.playMode = m;
    if (m === "shuffle") ensureShuffleQueue();
  },
  { flush: "sync" },
);

// ============ 模式记忆（localStorage 启动缓存；统一 Settings 层为真源）============
export const MODE_KEY = "qqplayer.mode.v1";

export const MODE_VALUES = ["continuous", "karaoke", "books", "videos"];

// 启动同步读取缓存种子：首帧即恢复上次模式（非法/缺失回落 continuous）
function loadMode() {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    if (MODE_VALUES.includes(raw as string)) state.mode = raw as string;
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadMode();

// ============ 播放器级 toast（流媒体直链失败等播放错误）============
// 组件本地 toast 照旧各自维护；这里只处理播放器全局错误（stream 直链失败 / 非法 URL 等）
// App.vue 渲染；测试可直接断言 playerToast.msg
export const playerToast = reactive({ msg: "", err: false });

let playerToastTimer: number | undefined;

export function showPlayerToast(msg: string, isErr = true) {
  playerToast.msg = msg;
  playerToast.err = !!isErr;
  clearTimeout(playerToastTimer);
  playerToastTimer = setTimeout(() => {
    playerToast.msg = "";
  }, 3200);
}

// 仅供测试：立即清除播放器 toast（避免用例间残留）
export function _resetPlayerToast() {
  clearTimeout(playerToastTimer);
  playerToast.msg = "";
  playerToast.err = false;
}

// ============ 播放会话跟踪（上报播放统计）============
// 每次完整播放会话（选歌→播放→切走/暂停/播完）结束后上报一条记录到 /api/playback
// 细节：记录实际播放秒数/总时长/完成度/来源/模式；少于 3 秒的误触不记
// 注：queueEngine 的 selectSong/playPreview 通过 registerPlaybackHooks 注入的回调
// 读取/冲刷本模块的会话状态（避免 queueEngine ↔ 本模块循环 import）。

let playbackSession: PlaybackSession | null = null; // { path,name,artist,album,startedAt,lastTickAt }

function currentPlaybackSource() {
  // 播放来源：媒体键/自动切歌/手动选歌（后续可扩展）
  const song = state.currentSong;
  if (!song) return state.lastSource || "manual";
  if (song.type === "url") return "url";
  if (song.type === "preview") return "preview";
  // 曲库网络条目（stream 歌）：source 标记 'stream'（享本地待遇，正常上报）
  if (isStreamSong(song)) return "stream";
  return state.lastSource || "manual";
}

// 播放会话标识（path 为 null 的流媒体歌用 streamId/url 区分，避免同 null 误判为同一首歌）
function songSessionKey(song: Song | null): string | null {
  if (!song) return null;
  if (song.path) return song.path;
  if (song.streamId) return "stream:" + song.streamId;
  return "song:" + song.name;
}

// 上报一条播放记录（POST /api/playback；失败进 dirty 队列，离线时本地积累、回网后重放）
async function reportPlayback(rec: PlaybackRecord) {
  try {
    const r = await apiPost("/api/playback", rec);
    if (!r.ok) throw new Error();
  } catch {
    // 失败（网络/HTTP）→ 进队列，稍后 flushPendingOps 重放
    await enqueuePendingOp({ url: "/api/playback", method: "POST" }, rec).catch(() => {});
    scheduleFlush();
  }
}

// 结束当前播放会话并上报（播放不足 3 秒视为误触不记）
// 返回生成的记录（未达阈值返回 null）；由调用方决定发送方式（fetch/sendBeacon）
export function flushPlaybackSession(): PlaybackRecord | null {
  const s = playbackSession;
  if (!s) return null;
  playbackSession = null;
  const played = (Date.now() - s.startedAt) / 1000;
  if (played < 3) return null; // 误触/短切
  // 试听 / URL 播放：streamStats 关闭时不上报（曲库网络条目 stream 歌始终正常上报）
  if (s.skipStats && !playbackSettings.streamStats) return null;
  const rec: PlaybackRecord = {
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
    key: songSessionKey(song),
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
    // 试听 / URL 播放标记：streamStats 关闭时 flush 丢弃（曲库网络条目 stream 歌不标记）
    skipStats: isPreviewSong(song),
  };
}

// 仅供测试：重置播放会话跟踪状态
// 注意：模块级 playbackSession 会跨测试残留，beforeEach 必须调用
export function _resetPlaybackSession() {
  playbackSession = null;
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
  reanchorKaraoke(audio.currentTime);
  audio.play().catch(() => {});
}

export function pause() {
  audio.pause();
}

export function nextSong(opts: SelectSongOpts = {}) {
  if (state.songs.length === 0) return;
  // 跟唱模式切歌：自动退出跟唱（回音乐模式）；句末自动暂停不阻止播放
  const wasKaraoke = state.mode === "karaoke";
  if (wasKaraoke) state.mode = "continuous";
  const merged = wasKaraoke ? { autoPlay: true, ...opts } : { autoPlay: !audio.paused, ...opts };
  if (state.playMode === "shuffle") {
    nextShuffle(merged);
    return;
  }
  selectSong((state.currentIndex + 1) % state.songs.length, merged);
}

export function prevSong(opts: SelectSongOpts = {}) {
  if (state.songs.length === 0) return;
  // 跟唱模式切歌：自动退出跟唱（同 nextSong）
  const wasKaraoke = state.mode === "karaoke";
  if (wasKaraoke) state.mode = "continuous";
  const merged = wasKaraoke ? { autoPlay: true, ...opts } : { autoPlay: !audio.paused, ...opts };
  if (state.playMode === "shuffle" && playHistory.length) {
    // 随机模式：按播放历史回退到上一首（不重复记录）
    selectSong(playHistory.pop() as number, { record: false, ...merged });
    return;
  }
  selectSong((state.currentIndex - 1 + state.songs.length) % state.songs.length, merged);
}

export function seek(t: number) {
  if (!audio.src) return;
  dbgLog("seek", { t });
  audio.currentTime = t;
  state.currentTime = t;
  // 跳转后重定位跟唱锚点，避免旧锚点立刻触发暂停/漏停
  reanchorKaraoke(t);
}

export function cycleSpeed() {
  const i = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(i + 1) % SPEEDS.length];
  applySpeed();
}

// 变速步进（任务 G 快捷键 [ / ]）：delta=-1 减速 / +1 加速；边界（0.75 最低 / 1.25 最高）不动作
// cycleSpeed 保持循环语义兼容（ControlBar 按钮仍用循环）
export function stepSpeed(delta: number) {
  const i = SPEEDS.indexOf(state.speed);
  const next = i + delta;
  if (next < 0 || next >= SPEEDS.length) return;
  state.speed = SPEEDS[next];
  applySpeed();
}

// 连播 ↔ 跟唱模式切换（任务 G 快捷键 G；模式切换触发现有 watch → 上报播放会话）
export function toggleMode() {
  state.mode = state.mode === "continuous" ? "karaoke" : "continuous";
}

// ============ 恢复上次播放（统一层 player.lastPlayed；受 playbackSettings.resumeLast 控制）============
export const LAST_PLAYED_KEY = "qqplayer.lastPlayed.v1";
let lastSaveAt = 0;

// 内存态 lastPlayed（统一层 GET 应用 / saveLastPlayed 写入；写透缓存到 localStorage）
export const lastPlayedState = reactive<{ path: string | null; position: number; ts: number }>({
  path: null,
  position: 0,
  ts: 0,
});

// 启动缓存种子（同步读 localStorage；后端 GET 返回后由统一层覆盖）
function loadLastPlayedCache() {
  try {
    const raw = localStorage.getItem(LAST_PLAYED_KEY);
    if (raw) Object.assign(lastPlayedState, JSON.parse(raw));
  } catch {
    /* 忽略损坏的缓存 */
  }
}
loadLastPlayedCache();

// 保存当前播放位置（timeupdate 节流 + 页面关闭兑底调用）
export function saveLastPlayed() {
  const song = state.currentSong;
  if (!playbackSettings.resumeLast || !song || !audio.src) return;
  // 流媒体歌（试听 / URL / 曲库网络条目）没有本地 path：不记入恢复播放
  // （恢复按 path 匹配，null 会误匹配曲库首个 stream 条目）
  if (!song.path) return;
  const pos = audio.currentTime || 0;
  if (!(pos > 0)) return;
  const rec = { path: song.path, position: pos, ts: Date.now() };
  Object.assign(lastPlayedState, rec); // 统一层 watch → PUT player.lastPlayed
  try {
    localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(rec)); // 写透缓存（同步）
  } catch {
    /* 忽略写入失败 */
  }
}

// 启动时恢复上次播放的歌曲与进度（需在歌曲列表加载完成后调用；不自动播放，避免浏览器拦截）
export async function restoreLastPlayed() {
  if (!playbackSettings.resumeLast || !state.songs.length) return;
  // 等待统一层初始加载完成（GET 成功或失败），确保数据源为后端值而非本地缓存
  if (settingsLoadPromise) await settingsLoadPromise;
  const saved = { path: lastPlayedState.path, position: lastPlayedState.position };
  dbgLog("restore", {
    path: saved.path,
    pos: saved.position,
    resumeLast: playbackSettings.resumeLast,
  });
  if (!saved.path) return;
  const idx = state.songs.findIndex((s) => s.path === saved.path);
  if (idx < 0) return;
  await selectSong(idx, { record: false, resumeAt: saved.position });
}

// 统一 Settings 层写透 player 侧缓存（playbackSettings + volume/lastPlayed；UI 开关由 uiState 自管）
export function persistPlayerCache() {
  try {
    localStorage.setItem(PLAYBACK_SETTINGS_KEY, JSON.stringify(playbackSettings));
    // 开关语义：rememberVolume=false 不写音量缓存
    if (playbackSettings.rememberVolume) {
      localStorage.setItem(VOLUME_KEY, String(state.volume));
    }
    // UI 开关（panel/controls）由 uiState 模块自己持久化（toggle 同步写 + watch 兜底）
    // 模式记忆：始终写透（不受 rememberVolume/resumeLast 开关影响）
    localStorage.setItem(MODE_KEY, state.mode);
    // 从未播放过（path 为空）时不写，避免用空记录覆盖有效缓存
    if (lastPlayedState.path) {
      localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(lastPlayedState));
    }
  } catch {
    /* 忽略写入失败 */
  }
}

// ============ 跟唱句末高频检测（变速精度，2026-08-19） ============
// timeupdate 粒度约 250ms 媒体时间：变速 0.75 后墙钟间隔被拉长到 ~333ms，
// 句末越过截止时间戳（lines[i].e）后还要等这么久才跳转 → 单句/AB 循环
// "多播一截尾巴 + 突然跳回句首" = 节律性抖动；普通跟唱则"停不准"。
// 跟唱模式播放中额外 50ms 轮询 currentTime 做句末判定（与 timeupdate 并存、
// 幂等；句末判定始终实时读当前时间与当前句截止时间戳比较，变速不改媒体时间轴）。
const KARAOKE_TICK_MS = 50;
let karaokeTicker: number | null = null;

export function startKaraokeTicker() {
  if (karaokeTicker) return;
  karaokeTicker = setInterval(() => {
    // 非跟唱/跟读关：空转（切模式后由 stop 兜底，这里防御）
    if (state.mode === "karaoke" && state.karaokeOn) {
      handleKaraokeTick(audio.currentTime);
    }
  }, KARAOKE_TICK_MS);
}

export function stopKaraokeTicker() {
  if (karaokeTicker) {
    clearInterval(karaokeTicker);
    karaokeTicker = null;
  }
}

// ============ 跨域回调注入（audioEngine 音频事件 / queueEngine 选歌） ============
// audioEngine.bindAudioEvents 的事件回调里需要播放会话/跟唱/进度保存/播完切歌；
// queueEngine.selectSong/playPreview 需要播放会话与 toast。都在模块求值期注入，
// 事件触发期（用户交互后）必然已就绪，行为与 playerCore 单文件时代完全一致。
registerPlaybackHooks({
  getSession: () => playbackSession,
  flushSession: () => {
    flushPlaybackSession();
  },
  showToast: (msg, isErr) => showPlayerToast(msg, isErr),
});

registerAudioEventHooks({
  // timeupdate：恢复上次播放节流保存进度（10s 一次；页面关闭由 setupPlaybackFlush 兑底）
  maybeSaveLastPlayed: () => {
    if (playbackSettings.resumeLast && Date.now() - lastSaveAt > 10000) {
      lastSaveAt = Date.now();
      saveLastPlayed();
    }
  },
  // play：跟唱高频检测启动 + 播放会话建立（真正开始出声才记；换歌立即播放先上报旧会话）
  onPlaybackStarted: () => {
    startKaraokeTicker(); // 跟唱句末高频检测（变速 0.75 时 timeupdate 太粗）
    const song = state.currentSong;
    if (song && (!playbackSession || playbackSession.key !== songSessionKey(song))) {
      flushPlaybackSession();
      startPlaybackSession();
    }
  },
  // pause：停掉高频检测；非跟唱模式的主动暂停上报会话（跟唱模式句间暂停交还给时间锚点逻辑）
  onPlaybackPaused: (swappingAudio) => {
    stopKaraokeTicker(); // 暂停/句末自动停：停掉高频检测
    if (!swappingAudio && state.mode !== "karaoke" && playbackSession) {
      flushPlaybackSession();
    }
  },
  // ended：自然播完标记 completed 上报；试听自然停 / 跟唱停 / 单曲循环重播 / 自动切歌
  onPlaybackEnded: () => {
    // 自然播完：标记 completed 后上报（repeatOne 除外，同一首歌继续听）
    if (playbackSession && state.playMode !== "repeatOne") {
      playbackSession.completed = true;
      flushPlaybackSession();
    }
    // 试听 / URL 播放：播完自然停止，不自动切歌（currentIndex 未动，next/prev 随时回主队列）
    if (isPreviewSong(state.currentSong)) return;
    // 跟唱模式播完自然停（句间暂停由时间锚点接管）；连播/图书等模式自动切歌继续
    if (state.mode === "karaoke") return;
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
  },
});

// 注册统一 Settings 层桥（必须在本模块所有 player 状态定义之后执行）
registerPlayerBridge({
  state,
  audio,
  playbackSettings,
  lastPlayedState,
  keys: {
    PLAYBACK_SETTINGS_KEY,
    VOLUME_KEY,
    UI_STATE_KEY,
    LAST_PLAYED_KEY,
    MODE_KEY,
  },
  persistPlayerCache,
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
    stopKaraokeTicker(); // 退出跟唱模式：停掉高频检测（切回跟唱后由 play 事件重启）
  },
);

// 页面关闭/刷新：sendBeacon 兜底上报未结束的会话（fetch 在卸载时不可靠）
export function setupPlaybackFlush() {
  if (typeof window === "undefined") return () => {};
  const handler = () => {
    saveLastPlayed(); // 恢复上次播放：页面关闭/刷新前保存当前进度
    // 直接构造并 beacon：不能用 flushPlaybackSession（它走 fetch，卸载时会被取消）
    const s = playbackSession;
    if (!s) return;
    playbackSession = null;
    const played = (Date.now() - s.startedAt) / 1000;
    if (played < 3) return;
    // 试听 / URL 播放：streamStats 关闭时不上报（与 flushPlaybackSession 同规则）
    if (s.skipStats && !playbackSettings.streamStats) return;
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
