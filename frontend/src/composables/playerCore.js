import { reactive, watch, ref } from "vue";
import { uiSettings, ACCENT_OPTIONS } from "./useSettings.js";
import { EQ_BANDS, EQ_PRESETS, _normalizeEqPreset } from "./useEq.js";
import {
  loadLyric,
  loadOnlineLyricForSong,
  reanchorKaraoke,
  currentLineIndex,
  nextLine,
  prevLine,
  toggleZh,
} from "./useLyric.js";
import { handleKaraokeTick, resetAbLoopCount, setAbPointA, setAbPointB } from "./useAbLoop.js";
import { toggleFavorite } from "./useLibrary.js";
import { registerPlayerBridge, settingsLoadPromise } from "./settingsSync.js";
import { isSearchOpen } from "./searchState.js";
import { showToast } from "./useToast.js";
import i18n from "../locales/i18n.js";

// 全局唯一 audio 元素
// 导出供 useLyric/useAbLoop/useEq 等模块直接操作播放原语
export const audio = new Audio();
audio.preload = "auto";
// 包装 play：每次播放前确保 Web Audio 图就绪（懒创建 + resume，autoplay policy 需要用户手势）
// 均衡器常驻音频图后，audio 元素的声音只经过 AudioContext 输出，context suspended 时会无声，
// 所以必须在 play 前 resume。注意：图创建与 resume 发起是同步的（在手势栈内生效），
// 但 play() 的返回不受异步 resume 阻塞——否则自动切歌等场景的播放状态更新会延迟。
const origPlay = audio.play.bind(audio);
audio.play = () => {
  ensureAudioGraph();
  return origPlay();
};

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
  lyricSource: null, // 当前歌词实际来源：'local' | 在线来源名（netease/lrclib）| null
  libraryPath: "",
  librarySettings: null, // 音乐库设置（后端 settings.json 持久化）
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
  specLyricOpen: false, // 手动指定歌词弹窗开关
});

// ============ 播放设置（localStorage 持久化）============
// 覆盖：播放模式记忆 / 恢复上次播放 / 记住音量 / 切歌淡入淡出
export const PLAYBACK_SETTINGS_KEY = "qqplayer.playbackSettings.v1";

export const PLAYBACK_SETTINGS_DEFAULTS = {
  playMode: "order", // 播放模式（启动时恢复）：'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
  resumeLast: true, // 启动时恢复上次播放的歌曲与进度
  rememberVolume: true, // 记住音量（关闭则每次启动回到默认音量）
  fadeSec: 0, // 切歌淡入淡出时长（秒）；0 = 关闭
  karaokeNextKey: "KeyN", // 跟唱：下一句快捷键（设置可改）
  karaokePrevKey: "KeyP", // 跟唱：上一句快捷键（设置可改）
  searchKey: "Meta+K", // 搜索：打开 search anything（Cmd+K；设置可改，存 e.code 风格）
  // 任务 G：快捷键全量可录制（默认值 e.code 风格；⌘ 组合存 "Meta+<code>"）
  shortcutPlayPause: "Space", // 播放 / 暂停
  shortcutRewind: "ArrowLeft", // 快退 10 秒
  shortcutForward: "ArrowRight", // 快进 10 秒
  shortcutVolUp: "ArrowUp", // 音量 +10%
  shortcutVolDown: "ArrowDown", // 音量 -10%
  shortcutPrevTrack: "Meta+ArrowLeft", // 上一首（⌘←）
  shortcutNextTrack: "Meta+ArrowRight", // 下一首（⌘→）
  shortcutMute: "KeyM", // 静音切换
  shortcutFav: "KeyF", // 收藏 / 取消收藏当前歌
  shortcutCycleMode: "KeyR", // 播放模式切换
  shortcutZhToggle: "KeyL", // 中文翻译显示开关
  shortcutKaraokeMode: "KeyG", // 连播 ↔ 跟唱模式切换
  shortcutAbA: "KeyA", // AB 循环：设起点
  shortcutAbB: "KeyB", // AB 循环：设终点
  shortcutSlower: "BracketLeft", // 变速 -（0.75 → 1.0 → 1.25）
  shortcutFaster: "BracketRight", // 变速 +
  shortcutVolStepUp: "Meta+ArrowUp", // 音量 +20%（⌘↑）
  shortcutVolStepDown: "Meta+ArrowDown", // 音量 -20%（⌘↓）
  eqEnabled: false, // 均衡器开关（false = 全部 0dB 直通）
  eqPreset: "flat", // 均衡器预设：EQ_PRESETS 的 key；'custom' = 用户自定义
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 自定义增益（dB，-12~12，10 段，与 EQ_BANDS 对齐）
  abVisual: true, // AB 循环区间可视化（起点 A / 终点 B 徽标 + 区间进度条）
  abLoopCountOn: true, // AB 循环计数（防走开安全阀）：B 句播完算一遍，满 N 遍停回 A 句首暂停
  abLoopMaxCount: 10, // AB 循环计数上限（1-20）
  visualizerEnabled: true, // 频谱可视化开关（默认开；仅播放中活跃，暂停静止平线）
  visualizerStyle: "bars", // 视觉化样式：'bars' 频谱条 | 'radial' 圆环 | 'wave' 波形 | 'pulse' 脉冲环 | 'mirror' 镜像 | 'particle' 粒子（见 VISUALIZER_STYLES）
  sleepTimerOn: false, // 睡眠定时器开关（统一层持久化；运行中的倒计时不持久化，页面刷新即取消）
  sleepTimerMinutes: 30, // 睡眠定时器时长（分钟，chip 单选）
  streamStats: false, // 流媒体统计开关：true = 试听 / URL 播放计入播放统计（曲库网络条目始终计入）
};

export const playbackSettings = reactive({ ...PLAYBACK_SETTINGS_DEFAULTS });

// 视觉化 6 样式（任务 K）：id 存 playbackSettings.visualizerStyle，labelKey 文案在 zh-CN settings.visualizerStyle.*
export const VISUALIZER_STYLES = [
  { id: "bars", labelKey: "settings.visualizerStyle.bars" },
  { id: "radial", labelKey: "settings.visualizerStyle.radial" },
  { id: "wave", labelKey: "settings.visualizerStyle.wave" },
  { id: "pulse", labelKey: "settings.visualizerStyle.pulse" },
  { id: "mirror", labelKey: "settings.visualizerStyle.mirror" },
  { id: "particle", labelKey: "settings.visualizerStyle.particle" },
];

export function loadPlaybackSettings() {
  try {
    const raw = localStorage.getItem(PLAYBACK_SETTINGS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    for (const k of Object.keys(playbackSettings)) {
      if (k in saved) playbackSettings[k] = saved[k];
    }
  } catch {
    /* 忽略损坏的缓存 */
  }
  // 脏数据归一化：visualizerStyle 必须是合法枚举，否则回落默认 'bars'
  if (!VISUALIZER_STYLES.some((s) => s.id === playbackSettings.visualizerStyle)) {
    playbackSettings.visualizerStyle = PLAYBACK_SETTINGS_DEFAULTS.visualizerStyle;
  }
}
loadPlaybackSettings();
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
// 注：playbackSettings 的 localStorage 写透 + 后端 PUT 由统一 Settings 层负责（settingsSync.js）

// 播放模式随设置恢复（用户手动三态切换时也会同步回 playbackSettings，见 cyclePlayMode）
if (["order", "shuffle", "repeatOne"].includes(playbackSettings.playMode)) {
  state.playMode = playbackSettings.playMode;
}
// 设置弹窗里改播放模式 → 立即生效（含洗牌队列初始化）
watch(
  () => playbackSettings.playMode,
  (m) => {
    state.playMode = m;
    if (m === "shuffle") ensureShuffleQueue();
  },
  { flush: "sync" },
);

// ============ 均衡器音频图（Web Audio API 生命周期）============
// 10 段经典频点（foobar2000/网易云同款），±12dB
// 技术要点：createMediaElementSource 一个 audio 元素只能接管一次，
// 所以音频图常驻（首次播放懒创建），开关关闭 = 增益全 0（0dB peaking 近似直通），不做动态路由切换。
// 对外 API（EQ_BANDS/EQ_PRESETS/setEqPreset/setEqGain）在 useEq.js；audio 与图强耦合，生命周期留这里。
let audioCtx = null; // AudioContext 实例（懒初始化，常驻）
let eqFilters = []; // 10 个 BiquadFilter（peaking），与 EQ_BANDS 对齐
let eqGraphFailed = false; // 创建失败标记（降级为直通，不再重试）

// 确保音频图就绪（首次播放/用户手势时创建并 resume）。
// 无 AudioContext 环境（旧浏览器/测试）静默降级，不影响播放。
function ensureAudioGraph() {
  if (audioCtx || eqGraphFailed) return Promise.resolve();
  const AC = typeof window !== "undefined" && (window.AudioContext || window.webkitAudioContext);
  if (!AC) return Promise.resolve();
  try {
    const ctx = new AC();
    const src = ctx.createMediaElementSource(audio);
    let node = src;
    for (const f of EQ_BANDS) {
      const filter = ctx.createBiquadFilter();
      filter.type = "peaking";
      filter.frequency.value = f;
      filter.Q.value = 1.0;
      filter.gain.value = 0;
      node.connect(filter);
      node = filter;
      eqFilters.push(filter);
    }
    node.connect(ctx.destination);
    audioCtx = ctx;
    applyEqToGraph(); // 创建前可能已改过设置（恢复持久化值）
    return ctx.resume().catch(() => {});
  } catch {
    // 创建失败：清空半成品，标记降级（浏览器不支持等情况）
    audioCtx = null;
    eqFilters = [];
    eqGraphFailed = true;
    return Promise.resolve();
  }
}

// 频谱可视化：暴露音频图访问器（useVisualizer 懒挂 AnalyserNode 到图尾，纯直通不改音频路径）
// 返回 { audioCtx, eqFilters }；图未创建（首次播放前/无 AudioContext）时 audioCtx 为 null
// 图节点为模块私有（createMediaElementSource 一个 audio 元素只能接管一次，图必须常驻），
// 故只暴露只读引用，连接拓扑的改动由 useVisualizer 在拿到引用后完成。
export function getEqGraph() {
  return { audioCtx, eqFilters };
}

// 把当前均衡器设置应用到音频图（图未创建时无操作，创建时统一应用）
// 导出供 useEq.js 的 setEqPreset/setEqGain 同步应用
export function applyEqToGraph() {
  if (!audioCtx) return;
  const enabled = !!playbackSettings.eqEnabled;
  const preset = EQ_PRESETS[playbackSettings.eqPreset] || EQ_PRESETS.flat;
  // 关闭 → 全 0 直通；自定义 → eqGains；预设 → 预设值
  const gains = enabled ? preset.gains || playbackSettings.eqGains : EQ_PRESETS.flat.gains;
  eqFilters.forEach((f, i) => {
    f.gain.value = gains[i] ?? 0;
  });
}

// 测试钩子：重置音频图（用例隔离）
export function _resetEqGraph() {
  audioCtx = null;
  eqFilters = [];
  eqGraphFailed = false;
}

// 均衡器设置变化 → 实时应用到音频图（未创建时下次创建应用）
// 注：watch 注册必须在 playbackSettings 定义之后（playerCore 顶层顺序执行），
// 故放在这里而非 useEq.js（useEq 先于 playerCore 顶层执行完，此时 playbackSettings 未定义）。
watch(
  () => [playbackSettings.eqEnabled, playbackSettings.eqPreset, playbackSettings.eqGains],
  () => applyEqToGraph(),
  { deep: true },
);

// ============ 音量（localStorage 持久化）============
export const VOLUME_KEY = "qqplayer.volume.v1";

function loadVolume() {
  if (!playbackSettings.rememberVolume) return; // 不记住音量：保持默认 100%
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
  if (!playbackSettings.rememberVolume) return; // 关闭记住音量：不写入
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

// ============ 播放器级 toast（流媒体直链失败等播放错误）============
// 组件本地 toast 照旧各自维护；这里只处理播放器全局错误（stream 直链失败 / 非法 URL 等）
// App.vue 渲染；测试可直接断言 playerToast.msg
export const playerToast = reactive({ msg: "", err: false });

let playerToastTimer = null;

export function showPlayerToast(msg, isErr = true) {
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

// ============ 队列操作 ============
// 移除 + 撤销：缓存 {index, song} → toast「已移除 [撤销]」→ 插回原位（越界 clamp 到末尾，不丢歌）
// 多首依次移除各自独立撤销（各自 toast、各自原位）；撤销后若处于过滤/分组浏览可能不可见，但数据不丢
const UNDO_DURATION = 5000;

export function removeFromQueue(index) {
  if (index < 0 || index >= state.songs.length) return;
  const [song] = state.songs.splice(index, 1);
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

  const name = song?.name || i18n.global.t("errors.unknownSong");
  showToast(i18n.global.t("queue.removed", { name }), {
    duration: UNDO_DURATION,
    action: {
      label: i18n.global.t("queue.undo"),
      onClick: () => {
        // 插回原位；原 index 越界（期间又移除了前面的歌）→ clamp 到末尾
        state.songs.splice(Math.min(index, state.songs.length), 0, song);
        // 镜像移除时的索引前移：插回位置在当前歌之前 → 当前索引顺延（越界时当前索引为 -1，不动）
        if (state.currentIndex >= 0 && index <= state.currentIndex) state.currentIndex += 1;
        _resetPlayMode();
        showToast(i18n.global.t("queue.restored", { name }));
      },
    },
  });
}

// ============ 播放会话跟踪（上报播放统计）============
// 每次完整播放会话（选歌→播放→切走/暂停/播完）结束后上报一条记录到 /api/playback
// 细节：记录实际播放秒数/总时长/完成度/来源/模式；少于 3 秒的误触不记

let playbackSession = null; // { path,name,artist,album,startedAt,lastTickAt }

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
function songSessionKey(song) {
  if (!song) return null;
  if (song.path) return song.path;
  if (song.streamId) return "stream:" + song.streamId;
  return "song:" + song.name;
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
  // 试听 / URL 播放：streamStats 关闭时不上报（曲库网络条目 stream 歌始终正常上报）
  if (s.skipStats && !playbackSettings.streamStats) return null;
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

// ============ 键盘快捷键（配置表驱动，全量可录制） ============
// 空格播放/暂停，←/→ 快退/快进 10s，↑/↓ 音量 ±10%，⌘←/⌘→ 上下曲，M 静音，F 收藏，
// R 播放模式，L 翻译开关，G 连播↔跟唱，A/B AB 循环，[ ] 变速，⌘↑/⌘↓ 音量 ±20%
// 媒体键（MediaPlayPause 等）仅在无 MediaSession 的环境兜底处理（键盘事件），
// 有 MediaSession 时交给系统（避免双重触发）；媒体键不进配置表（不可录制，设置里仍展示说明）
const HAS_MEDIA_SESSION = typeof navigator !== "undefined" && "mediaSession" in navigator;
const MEDIA_KEY_CODES = ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaStop"];

// 快捷键分类（设置弹窗快捷键 tab 分组渲染顺序）
export const SHORTCUT_CATEGORIES = [
  { key: "playback", labelKey: "settings.shortcutCatPlayback" },
  { key: "track", labelKey: "settings.shortcutCatTrack" },
  { key: "volume", labelKey: "settings.shortcutCatVolume" },
  { key: "karaoke", labelKey: "settings.shortcutCatKaraoke" },
  { key: "search", labelKey: "settings.shortcutCatSearch" },
  { key: "other", labelKey: "settings.shortcutCatOther" },
];

// 快捷键配置表：{ id, labelKey, category, settingKey, defaultCode, meta, handler }
// - settingKey：playbackSettings 持久化字段（录制/加载均读写该字段；defaultCode 为出厂值）
// - defaultCode：默认组合（"Meta+<code>" = ⌘ 组合；否则纯键，e.code 风格）
// - meta：默认组合是否带 ⌘（展示/测试参考；实际匹配以当前 settingKey 值为准）
// - handler：null = 不进播放器处理（搜索快捷键由 SearchAnything 独占，避免双重触发）
export const SHORTCUTS = [
  // ---- 播放控制 ----
  {
    id: "playPause",
    labelKey: "settings.shortcutPlayPause",
    category: "playback",
    settingKey: "shortcutPlayPause",
    defaultCode: "Space",
    meta: false,
    handler: () => togglePlay(),
  },
  {
    id: "rewind",
    labelKey: "settings.shortcutRewind",
    category: "playback",
    settingKey: "shortcutRewind",
    defaultCode: "ArrowLeft",
    meta: false,
    handler: () => seek(Math.max(0, (audio.currentTime || 0) - 10)),
  },
  {
    id: "forward",
    labelKey: "settings.shortcutForward",
    category: "playback",
    settingKey: "shortcutForward",
    defaultCode: "ArrowRight",
    meta: false,
    handler: () => seek(Math.min(audio.duration || 0, (audio.currentTime || 0) + 10)),
  },
  {
    id: "cycleMode",
    labelKey: "settings.shortcutCycleMode",
    category: "playback",
    settingKey: "shortcutCycleMode",
    defaultCode: "KeyR",
    meta: false,
    handler: () => cyclePlayMode(),
  },
  {
    id: "abA",
    labelKey: "settings.shortcutAbA",
    category: "playback",
    settingKey: "shortcutAbA",
    defaultCode: "KeyA",
    meta: false,
    handler: () => setAbPointA(),
  },
  {
    id: "abB",
    labelKey: "settings.shortcutAbB",
    category: "playback",
    settingKey: "shortcutAbB",
    defaultCode: "KeyB",
    meta: false,
    handler: () => setAbPointB(),
  },
  // ---- 曲目 ----
  {
    id: "prevTrack",
    labelKey: "settings.shortcutPrevTrack",
    category: "track",
    settingKey: "shortcutPrevTrack",
    defaultCode: "Meta+ArrowLeft",
    meta: true,
    handler: () => prevSong({ autoPlay: true }),
  },
  {
    id: "nextTrack",
    labelKey: "settings.shortcutNextTrack",
    category: "track",
    settingKey: "shortcutNextTrack",
    defaultCode: "Meta+ArrowRight",
    meta: true,
    handler: () => nextSong({ autoPlay: true }),
  },
  {
    id: "fav",
    labelKey: "settings.shortcutFav",
    category: "track",
    settingKey: "shortcutFav",
    defaultCode: "KeyF",
    meta: false,
    handler: () => {
      const p = state.currentSong?.path;
      if (p) toggleFavorite(p);
    },
  },
  // ---- 音量 ----
  {
    id: "volUp",
    labelKey: "settings.shortcutVolUp",
    category: "volume",
    settingKey: "shortcutVolUp",
    defaultCode: "ArrowUp",
    meta: false,
    handler: () => setVolume(state.volume + 0.1),
  },
  {
    id: "volDown",
    labelKey: "settings.shortcutVolDown",
    category: "volume",
    settingKey: "shortcutVolDown",
    defaultCode: "ArrowDown",
    meta: false,
    handler: () => setVolume(state.volume - 0.1),
  },
  {
    id: "volStepUp",
    labelKey: "settings.shortcutVolStepUp",
    category: "volume",
    settingKey: "shortcutVolStepUp",
    defaultCode: "Meta+ArrowUp",
    meta: true,
    handler: () => setVolume(state.volume + 0.2),
  },
  {
    id: "volStepDown",
    labelKey: "settings.shortcutVolStepDown",
    category: "volume",
    settingKey: "shortcutVolStepDown",
    defaultCode: "Meta+ArrowDown",
    meta: true,
    handler: () => setVolume(state.volume - 0.2),
  },
  {
    id: "mute",
    labelKey: "settings.shortcutMute",
    category: "volume",
    settingKey: "shortcutMute",
    defaultCode: "KeyM",
    meta: false,
    handler: () => toggleMute(),
  },
  // ---- 跟唱 ----
  {
    id: "karaokeNext",
    labelKey: "settings.karaokeNext",
    category: "karaoke",
    settingKey: "karaokeNextKey",
    defaultCode: "KeyN",
    meta: false,
    handler: () => {
      if (state.mode === "karaoke") nextLine();
    },
  },
  {
    id: "karaokePrev",
    labelKey: "settings.karaokePrev",
    category: "karaoke",
    settingKey: "karaokePrevKey",
    defaultCode: "KeyP",
    meta: false,
    handler: () => {
      if (state.mode === "karaoke") prevLine();
    },
  },
  {
    id: "karaokeMode",
    labelKey: "settings.shortcutKaraokeMode",
    category: "karaoke",
    settingKey: "shortcutKaraokeMode",
    defaultCode: "KeyG",
    meta: false,
    handler: () => toggleMode(),
  },
  // ---- 搜索（handler 为空：SearchAnything 独占处理，播放器层不拦截）----
  {
    id: "search",
    labelKey: "settings.shortcutSearch",
    category: "search",
    settingKey: "searchKey",
    defaultCode: "Meta+K",
    meta: true,
    handler: null,
  },
  // ---- 其他 ----
  {
    id: "zhToggle",
    labelKey: "settings.shortcutZhToggle",
    category: "other",
    settingKey: "shortcutZhToggle",
    defaultCode: "KeyL",
    meta: false,
    handler: () => toggleZh(),
  },
  {
    id: "slower",
    labelKey: "settings.shortcutSlower",
    category: "other",
    settingKey: "shortcutSlower",
    defaultCode: "BracketLeft",
    meta: false,
    handler: () => stepSpeed(-1),
  },
  {
    id: "faster",
    labelKey: "settings.shortcutFaster",
    category: "other",
    settingKey: "shortcutFaster",
    defaultCode: "BracketRight",
    meta: false,
    handler: () => stepSpeed(1),
  },
];

// 组合解析："Meta+<code>" → { meta: true, code }；纯 <code> → { meta: false, code }
// 历史格式兼容：searchKey 默认 "Meta+K"（省略 Key 前缀）→ code 归一为 KeyK
// 导出供 SettingsModal 冲突检测 / SearchAnything 匹配复用
export function parseShortcutCombo(combo) {
  if (!combo) return null;
  const meta = combo.startsWith("Meta+");
  let code = meta ? combo.slice(5) : combo;
  if (meta && code.length === 1) code = "Key" + code;
  return { meta, code };
}

// 组合匹配：meta=true 要求 e.metaKey；meta=false 要求无 meta/ctrl/alt（避免修饰键误触发）
function matchShortcutCombo(e, combo) {
  const p = parseShortcutCombo(combo);
  if (!p) return false;
  if (e.code !== p.code) return false;
  if (p.meta) return !!e.metaKey;
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

// 组合 → 展示文本（⌘← / Space / M / [ 等）；设置弹窗与搜索层共用
export function fmtShortcutKey(code) {
  if (!code) return "—";
  const meta = code.startsWith("Meta+");
  const rest = meta ? code.slice(5) : code;
  const mod = meta ? "⌘" : "";
  const arrows = { ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓" };
  if (rest === "Space") return mod + "Space";
  if (arrows[rest]) return mod + arrows[rest];
  if (rest.startsWith("Key")) return mod + rest.slice(3);
  if (rest.startsWith("Digit")) return mod + rest.slice(5);
  if (rest === "BracketLeft") return mod + "[";
  if (rest === "BracketRight") return mod + "]";
  return mod + rest;
}

// 输入框/文本域聚焦时不拦截（媒体键除外：即使输入框聚焦也应全局响应）
// search anything 搜索层打开时屏蔽播放快捷键（isSearchOpen 来自零依赖 searchState，避免循环依赖）
const SHORTCUT_HANDLER = (e) => {
  // search anything 全屏搜索层打开时不响应播放快捷键（Space/←→/↑↓ 由搜索层消费）
  if (isSearchOpen.value) return;
  const el = e.target;
  const isMediaKey = !HAS_MEDIA_SESSION && MEDIA_KEY_CODES.includes(e.code);
  if (
    !isMediaKey &&
    el &&
    (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
  ) {
    return;
  }
  // 媒体键兜底（无 MediaSession 环境；不参与录制）
  if (isMediaKey) {
    e.preventDefault();
    switch (e.code) {
      case "MediaPlayPause":
        togglePlay();
        break;
      case "MediaTrackNext":
        nextSong({ autoPlay: true, source: "media" });
        break;
      case "MediaTrackPrevious":
        prevSong({ autoPlay: true, source: "media" });
        break;
      case "MediaStop":
        pause();
        break;
    }
    return;
  }
  // 配置表匹配：命中执行 handler + preventDefault（一次只处理一个快捷键）
  for (const s of SHORTCUTS) {
    if (!s.handler) continue;
    if (matchShortcutCombo(e, playbackSettings[s.settingKey] || s.defaultCode)) {
      e.preventDefault();
      s.handler();
      return;
    }
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
  const artwork = song.coverUrl
    ? [{ src: song.coverUrl, sizes: "512x512" }] // 流媒体歌：直接用网络图 URL
    : song.path
      ? [
          {
            src: absoluteUrl("/api/cover?path=" + encodeURIComponent(song.path)),
            sizes: "512x512",
          },
        ]
      : [];
  ms.metadata = new MediaMetadata({
    title: song.name || i18n.global.t("errors.unknownSong"),
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
  playbackSettings.playMode = state.playMode; // 同步持久化（启动时恢复）
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

// 音乐库设置：文件类型多选 / 忽略隐藏 / 自动刷新 / 启动自动扫描（后端持久化）
export async function loadLibrarySettings() {
  try {
    const res = await fetch("/api/library/settings", { cache: "no-store" });
    const data = await res.json();
    state.librarySettings = data.settings;
  } catch {
    /* 忽略 */
  }
}

export async function saveLibrarySettings(patch) {
  const res = await fetch("/api/library/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || i18n.global.t("errors.saveLibrarySettings"));
  }
  const data = await res.json();
  state.librarySettings = data.settings;
  return data;
}

export async function setLibrary(path) {
  const res = await fetch("/api/library", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail || i18n.global.t("errors.setLibrary"));
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
    // 拖拽排序持久化的队列顺序：刷新/启动时恢复（loadQueueOrder 需先于首次 loadSongs 完成，见 App.vue）
    applyQueueOrder();
    if (songs.length && state.currentIndex < 0) {
      state.currentIndex = 0;
      await selectSong(0);
    } else if (songs.length && state.currentSong) {
      // 刷新后保持当前选中：本地歌按 path；网络歌（path=null）按 streamId
      const cur = state.currentSong;
      const idx = cur.path
        ? state.songs.findIndex((s) => s.path === cur.path)
        : cur.streamId
          ? state.songs.findIndex((s) => s.type === "stream" && s.streamId === cur.streamId)
          : -1;
      if (idx >= 0) {
        state.currentIndex = idx;
        // 同步 currentSong 引用到新数组：刮削保存/曲库刷新后播放界面立即显示新信息
        // （不改 audio/不重播；mediaSession 元数据 watch 自动跟随更新）
        state.currentSong = state.songs[idx];
      }
    }
  } catch (e) {
    state.error = i18n.global.t("errors.loadSongs", { msg: e.message });
  } finally {
    state.loading = false;
  }
}

// ============ 播放队列顺序（后端持久化 /api/queue/order）============
// 队列 = state.songs 顺序（点击播放/切歌/列表渲染都按它走）。
// 拖拽排序后 PUT 到后端（不放 localStorage），启动/刷新时恢复；
// 只影响顺序——「最近添加」等智能视图是 computed 按 mtime/plays 字段排序，不受数组顺序影响。
// 顺序键：本地歌 = 文件路径；网络歌 path 为 null，用 'stream:<streamId>'。
let queueOrder = null; // 后端持久化的顺序键数组；null = 未加载

export function _resetQueueOrder() {
  queueOrder = null;
}

function queueKey(song) {
  return song?.type === "stream" && song.streamId
    ? "stream:" + song.streamId
    : (song?.path ?? null);
}

// 拉取持久化队列顺序（App 启动时先于 loadSongs 调用一次，之后走本地缓存）
export async function loadQueueOrder() {
  try {
    const res = await fetch("/api/queue/order", { cache: "no-store" });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.paths)) queueOrder = data.paths;
    }
  } catch {
    /* 后端暂不可用：保持默认顺序，下次重启再试 */
  }
}

// 保存当前队列顺序到后端（乐观更新本地缓存；失败抛错由调用方 toast）
export async function persistQueueOrder() {
  const paths = state.songs.map(queueKey).filter((k) => typeof k === "string");
  queueOrder = paths; // 本地缓存先行：刷新时立即恢复，不依赖后端往返
  const res = await fetch("/api/queue/order", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok) throw new Error(i18n.global.t("errors.reorderQueue"));
}

// 按持久化顺序重排 state.songs：匹配到的按保存顺序前置，其余（新歌/试听残留等）保持相对顺序补在末尾。
// 保存的顺序与当前曲库无交集（换库/清库）→ 不重排，保持曲库默认顺序。
function applyQueueOrder() {
  if (!Array.isArray(queueOrder) || !queueOrder.length) return;
  const byKey = new Map();
  for (const s of state.songs) {
    const k = queueKey(s);
    if (!byKey.has(k)) byKey.set(k, s);
  }
  const ordered = [];
  const seen = new Set();
  for (const key of queueOrder) {
    if (seen.has(key) || !byKey.has(key)) continue;
    ordered.push(byKey.get(key));
    seen.add(key);
  }
  if (!ordered.length) return; // 与当前曲库无交集 → 不动
  for (const s of state.songs) {
    const k = queueKey(s);
    if (seen.has(k)) continue;
    ordered.push(s);
    seen.add(k);
  }
  if (ordered.length !== state.songs.length) return; // 防御：长度不一致不重排
  state.songs = ordered;
}

// 队列拖拽排序：把 from 位置的歌挪到 to（全部歌曲视图 onEnd 调用）。
// 队列顺序变了 → 洗牌队列/播放历史失效（_resetPlayMode），下次自动重建。
export function reorderQueue(from, to) {
  if (from < 0 || to < 0 || from >= state.songs.length || to >= state.songs.length) return;
  if (from === to) return;
  const [song] = state.songs.splice(from, 1);
  state.songs.splice(to, 0, song);
  // 当前播放索引跟随：被移走的歌在原当前歌之前/之后决定偏移；移的就是当前歌 → 直接换到新位置
  if (from === state.currentIndex) {
    state.currentIndex = to;
  } else if (from < state.currentIndex && to >= state.currentIndex) {
    state.currentIndex -= 1;
  } else if (from > state.currentIndex && to <= state.currentIndex) {
    state.currentIndex += 1;
  }
  _resetPlayMode();
}

// 定位歌曲在队列（state.songs）中的索引：本地歌按 path；网络歌（type=stream, path=null）
// 按 streamId——旧写法 findIndex(s => s.path === song.path) 对网络歌会匹配到第一个
// stream 条目（path 全为 null）→ 播错歌/不播放（2026-08-16 用户反馈“最近添加有时点击不播放”）
export function findSongIndex(song) {
  if (!song) return -1;
  if (song.type === "stream" && song.streamId) {
    return state.songs.findIndex((s) => s.type === "stream" && s.streamId === song.streamId);
  }
  if (song.path) {
    return state.songs.findIndex((s) => s.path === song.path);
  }
  return -1;
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

// ============ 切歌淡入淡出 ============
let fadeSeq = 0; // 切歌序列号：快速连切时旧淡出让位（旧切换自动放弃）

// 当前音量淡出到 0（50ms 一步）。被更新的切歌取代时 resolve(false) → 放弃本次切换
// 注意：每个淡出用独立 timer——若共用全局 timer，新切歌清掉旧 timer 会让旧 promise 永不 resolve
function fadeOut(sec, seq) {
  return new Promise((resolve) => {
    const base = audio.volume;
    if (!(sec > 0) || base <= 0) {
      resolve(true);
      return;
    }
    const steps = Math.max(1, Math.round(sec * 20));
    const step = -base / steps;
    let i = 0;
    const timer = setInterval(() => {
      if (seq !== fadeSeq) {
        clearInterval(timer);
        resolve(false);
        return;
      }
      i += 1;
      audio.volume = Math.max(0, base + step * i);
      if (i >= steps) {
        clearInterval(timer);
        audio.volume = 0;
        resolve(true);
      }
    }, 50);
  });
}

// 从 0 淡入到目标音量（不阻塞；独立 timer，与淡出互不干扰）
function fadeIn(sec) {
  if (!(sec > 0)) return;
  const target = state.muted ? 0 : state.volume;
  if (target <= 0) return;
  const steps = Math.max(1, Math.round(sec * 20));
  const step = target / steps;
  let i = 0;
  const timer = setInterval(() => {
    i += 1;
    audio.volume = Math.min(target, step * i);
    if (i >= steps) {
      clearInterval(timer);
      audio.volume = target;
    }
  }, 50);
}

// ============ 流媒体歌（曲库网络条目 / 试听 / URL 播放）============
// 曲库网络条目：{type:'stream', streamId, provider, path:null, name, artist, album, duration, coverUrl}
// 试听歌：{type:'preview', ...}；URL 播放：{type:'url', url, ...}——两者都是「临时播放列表」语义
// （不改 state.songs / 不改 currentIndex，播完自然停，任何切歌操作回到主队列）

export function isStreamSong(song) {
  return !!song && (song.type === "stream" || (song.path === null && !!song.streamId));
}

export function isPreviewSong(song) {
  return !!song && (song.type === "preview" || song.type === "url");
}

// 实时获取流媒体直链（每次播放前请求，不缓存）。失败自动重试一次；仍失败返回 null（调用方 toast）
export async function fetchStreamUrl(provider, id, level = "exhigh") {
  if (!id && id !== 0) return null;
  const url =
    "/api/stream/url?provider=" +
    encodeURIComponent(provider || "netease") +
    "&id=" +
    encodeURIComponent(id) +
    "&level=" +
    encodeURIComponent(level);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        if (data && data.url) return data.url;
      }
    } catch {
      // 网络错误：重试一次
    }
  }
  return null;
}

// URL 播放 / 试听歌 → 内部歌对象（path: null，标记临时播放语义）
function toPreviewSong(desc) {
  if (desc.url) {
    return {
      type: "url",
      path: null,
      streamId: desc.url,
      provider: "http",
      name: desc.title || urlTitle(desc.url),
      artist: desc.artist || "",
      album: desc.album || "",
      coverUrl: desc.cover || "",
      duration: 0,
      url: desc.url,
    };
  }
  return {
    type: "preview",
    path: null,
    streamId: String(desc.id),
    provider: desc.provider || "netease",
    name: desc.title || "",
    artist: desc.artist || "",
    album: desc.album || "",
    coverUrl: desc.cover || "",
    duration: desc.duration || 0,
  };
}

// URL 默认标题：取文件名（pathname 最后一段）或域名
function urlTitle(url) {
  try {
    const u = new URL(url);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "");
    return last || u.hostname;
  } catch {
    return url;
  }
}

// 试听 = 临时播放列表（核心语义，用户 2026-08-16 拍板）：
// - 保存当前播放上下文（currentIndex / currentSong 不动；isPlaying 由 play 事件接管）
// - 不改 state.songs、不改 currentIndex
// - 播完（ended）自然停止，不自动 nextSong
// - nextSong / prevSong / selectSong → 走主队列正常逻辑（基于未动的 currentIndex，试听自然丢弃）
// - 试听中歌词 / 封面照常显示（在线匹配）；不上报播放统计（streamStats 关时）
// 返回 true = 已开始试听；false = 直链获取失败（已 toast）
export async function playPreview(desc, opts = {}) {
  const song = toPreviewSong(desc);
  // 取直链：URL 播放直接用 url；网络试听实时请求（失败重试一次，仍失败 toast）
  let src = song.url || null;
  if (!src) {
    src = await fetchStreamUrl(song.provider, song.streamId, opts.level);
    if (!src) {
      showPlayerToast(i18n.global.t("errors.streamUrlFailed", { name: song.name || "" }), true);
      return false;
    }
  }
  // 停止旧歌并上报旧会话（主队列正在播的歌是真实播放，照常上报）
  audio.pause();
  if (playbackSession) playbackSession.completed = audio.ended;
  flushPlaybackSession();
  // 挂载试听源：不动 state.songs / currentIndex
  state.currentSong = song;
  state.isPlaying = false;
  audio.src = src;
  audio.playbackRate = state.speed;
  audio.volume = state.muted ? 0 : state.volume;
  state.currentTime = 0;
  state.duration = 0;
  state.lyric = [];
  state.lyricFormat = null;
  state.lyricSource = null;
  state.abLoop = null;
  resetAbLoopCount();
  if (opts.autoPlay !== false) {
    audio.play().catch(() => {});
  }
  // 预取时长（电台流 duration=Infinity → 保持 0，进度条走空态不崩）
  audio.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = isFiniteNumber(audio.duration) ? audio.duration : 0;
    },
    { once: true },
  );
  // 试听歌词：在线匹配（歌名/歌手）
  const lr = await loadOnlineLyricForSong(song);
  state.lyric = lr.lines;
  state.lyricFormat = lr.format;
  state.lyricSource = lr.source;
  return true;
}

// 播放 URL（电台流 / 直链）：playPreview 语义（临时播放，不落库、默认不计统计）
export async function playUrl(url, opts = {}) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) {
    showPlayerToast(i18n.global.t("errors.urlInvalid"), true);
    return;
  }
  await playPreview({ url: url.trim(), title: opts.title || "" }, opts);
}

function isFiniteNumber(v) {
  return typeof v === "number" && Number.isFinite(v);
}

// ============ 选歌 ============
export async function selectSong(index, opts = {}) {
  if (index < 0 || index >= state.songs.length) return;
  const seq = ++fadeSeq;
  // 切歌淡入淡出：正在播放且开启淡出 → 先淡出旧歌再换源
  const fade = opts.fade === false ? 0 : playbackSettings.fadeSec;
  const wasPlaying = !audio.paused && !!audio.src;
  if (fade > 0 && wasPlaying) {
    const ok = await fadeOut(fade, seq);
    if (!ok) return; // 淡出期间又被切歌：放弃本次（新切歌接管）
  }
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
  // 曲库网络条目（stream 歌）：实时取直链（失败重试一次，仍失败 toast）；本地歌走 /api/audio
  let src;
  if (isStreamSong(state.currentSong)) {
    const { provider, streamId } = state.currentSong;
    src = await fetchStreamUrl(provider, streamId, opts.level);
    if (!src) {
      // 保持已选歌曲状态（UI 可见），但不播放；清掉旧源避免播放键续播上一首
      audio.removeAttribute("src");
      state.currentTime = 0;
      state.duration = 0;
      showPlayerToast(
        i18n.global.t("errors.streamUrlFailed", { name: state.currentSong.name || "" }),
        true,
      );
      return;
    }
  } else {
    src = "/api/audio?path=" + encodeURIComponent(state.currentSong.path);
  }
  audio.src = src;
  audio.playbackRate = state.speed;
  // 换源后恢复目标音量（淡出可能把音量降到 0；自动播放时由 fadeIn 平滑回升）
  audio.volume = state.muted ? 0 : state.volume;
  state.currentTime = 0;
  state.duration = 0;
  state.lyric = [];
  state.lyricFormat = null;
  state.lyricSource = null;
  state.abLoop = null; // 切歌重置 AB 循环
  resetAbLoopCount(); // 切歌重置 AB 循环计数（防走开安全阀）
  // 自动播放（播完自动切歌场景）：上一首结束切到新歌后继续播放
  if (opts.autoPlay) {
    audio.play().catch(() => {});
    if (fade > 0) fadeIn(fade);
  }
  // 加载歌词
  await loadLyric(index);
  // 预取时长；恢复上次播放时在这里 seek 到断点
  // （电台流 duration=Infinity → 保持 0，进度条走空态不崩）
  audio.addEventListener(
    "loadedmetadata",
    () => {
      state.duration = isFiniteNumber(audio.duration) ? audio.duration : 0;
      if (opts.resumeAt != null && audio.duration) {
        const t = Math.min(opts.resumeAt, Math.max(0, audio.duration - 0.5));
        audio.currentTime = t;
        state.currentTime = t;
      }
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
  reanchorKaraoke(audio.currentTime);
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
  reanchorKaraoke(t);
}

export function cycleSpeed() {
  const i = SPEEDS.indexOf(state.speed);
  state.speed = SPEEDS[(i + 1) % SPEEDS.length];
  audio.playbackRate = state.speed;
}

// 变速步进（任务 G 快捷键 [ / ]）：delta=-1 减速 / +1 加速；边界（0.75 最低 / 1.25 最高）不动作
// cycleSpeed 保持循环语义兼容（ControlBar 按钮仍用循环）
export function stepSpeed(delta) {
  const i = SPEEDS.indexOf(state.speed);
  const next = i + delta;
  if (next < 0 || next >= SPEEDS.length) return;
  state.speed = SPEEDS[next];
  audio.playbackRate = state.speed;
}

// 连播 ↔ 跟唱模式切换（任务 G 快捷键 G；模式切换触发现有 watch → 上报播放会话）
export function toggleMode() {
  state.mode = state.mode === "continuous" ? "karaoke" : "continuous";
}

// ============ 桌面歌词/迷你窗：当前播放状态上报（悬浮窗轮询读取）============
// 节流 250ms 合并；切歌/seek/句切换/播放状态变化都会触发，只报最新值
let nowPlayingTimer = null;
let nowPlayingPending = null;

// 当前播放快照（桌面歌词 + 迷你窗共用的完整状态）
function nowPlayingSnapshot() {
  const song = state.currentSong;
  return {
    path: song?.path || null,
    name: song?.name || null,
    artist: song?.artist || null,
    duration: state.duration || 0,
    currentTime: state.currentTime || 0,
    isPlaying: state.isPlaying,
    volume: state.muted ? 0 : state.volume,
  };
}

function flushNowPlaying() {
  nowPlayingTimer = null;
  const p = nowPlayingPending;
  nowPlayingPending = null;
  if (!p) return;
  // 带上强调色（桌面歌词「跟随主题」配色用）
  const accent = ACCENT_OPTIONS.find((a) => a.key === uiSettings.accent)?.color || "";
  fetch("/api/now-playing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...nowPlayingSnapshot(), ...p, accent }),
  }).catch(() => {});
}

function scheduleNowPlaying(extra = {}) {
  nowPlayingPending = { ...extra };
  if (nowPlayingTimer) return; // 节流中，等定时器触发上报最新值
  nowPlayingTimer = setTimeout(flushNowPlaying, 250);
}

watch([() => songKeyOf(state.currentSong), currentLineIndex], ([path, line]) => {
  if (!path || line < 0) return;
  scheduleNowPlaying({ path, lineIndex: line });
});

// 当前播放歌曲的稳定标识（path 为 null 的流媒体歌用 streamId 兜底，桌面歌词/迷你窗照常上报）
function songKeyOf(song) {
  if (!song) return null;
  return song.path || (song.streamId ? "stream:" + song.streamId : null);
}

// 播放状态/音量/时长变化 → 上报（迷你窗进度条与播放键状态实时跟随）
watch([() => state.isPlaying, () => state.volume, () => state.muted, () => state.duration], () => {
  if (!state.currentSong) return;
  scheduleNowPlaying({ lineIndex: currentLineIndex.value });
});

// 强调色变化 → 立即上报（桌面歌词「跟随主题」配色实时跟随）
watch(
  () => uiSettings.accent,
  () => {
    const path = songKeyOf(state.currentSong);
    const line = currentLineIndex.value;
    if (!path || line < 0) return;
    scheduleNowPlaying({ path, lineIndex: line });
  },
);

// ============ 迷你窗控制指令消费（主页面轮询取走执行）============
let playerActionsTimer = null;

function executePlayerAction(a) {
  switch (a.action) {
    case "togglePlay":
      togglePlay();
      break;
    case "play":
      play();
      break;
    case "pause":
      pause();
      break;
    case "next":
      nextSong();
      break;
    case "prev":
      prevSong();
      break;
    case "seek":
      seek(a.value);
      break;
    case "volume":
      setVolume(a.value);
      break;
    default:
      break; // 未知指令忽略
  }
}

export function setupPlayerActions(intervalMs = 800) {
  // 幂等：重复调用不叠加 timer
  if (playerActionsTimer) return;
  playerActionsTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/player/actions", { cache: "no-store" });
      const { actions } = await res.json();
      for (const a of actions || []) executePlayerAction(a);
    } catch {
      // 后端暂不可用：静默，下轮重试
    }
  }, intervalMs);
}

export function stopPlayerActions() {
  if (playerActionsTimer) {
    clearInterval(playerActionsTimer);
    playerActionsTimer = null;
  }
}

// ============ 迷你窗运行状态（顶栏开关点亮/熄灭） ============
export const miniRunning = ref(false);
let miniStatusTimer = null;

export async function refreshMiniStatus() {
  try {
    const res = await fetch("/api/mini/status", { cache: "no-store" });
    const { running } = await res.json();
    miniRunning.value = !!running;
  } catch {
    // 后端暂不可达：保持现状
  }
}

export function setupMiniStatus(intervalMs = 2000) {
  // 幂等：重复调用不叠加 timer
  if (miniStatusTimer) return;
  refreshMiniStatus(); // 立即查一次（页面加载/点开迷你窗后快速点亮）
  miniStatusTimer = setInterval(refreshMiniStatus, intervalMs);
}

export function stopMiniStatus() {
  if (miniStatusTimer) {
    clearInterval(miniStatusTimer);
    miniStatusTimer = null;
  }
}

// ============ 恢复上次播放（统一层 player.lastPlayed；受 playbackSettings.resumeLast 控制）============
export const LAST_PLAYED_KEY = "qqplayer.lastPlayed.v1";
let lastSaveAt = 0;

// 内存态 lastPlayed（统一层 GET 应用 / saveLastPlayed 写入；写透缓存到 localStorage）
export const lastPlayedState = reactive({ path: null, position: 0, ts: 0 });

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
  if (!saved.path) return;
  const idx = state.songs.findIndex((s) => s.path === saved.path);
  if (idx < 0) return;
  await selectSong(idx, { record: false, resumeAt: saved.position });
}

// 统一 Settings 层写透 player 侧缓存（playbackSettings + volume/panel/controls/lastPlayed）
export function persistPlayerCache() {
  try {
    localStorage.setItem(PLAYBACK_SETTINGS_KEY, JSON.stringify(playbackSettings));
    // 开关语义：rememberVolume=false 不写音量缓存
    if (playbackSettings.rememberVolume) {
      localStorage.setItem(VOLUME_KEY, String(state.volume));
    }
    localStorage.setItem(
      PANEL_KEY,
      JSON.stringify({ musicLib: state.musicLibOpen, playlist: state.playlistOpen }),
    );
    localStorage.setItem(CONTROLS_KEY, state.controlsHidden ? "1" : "0");
    // 从未播放过（path 为空）时不写，避免用空记录覆盖有效缓存
    if (lastPlayedState.path) {
      localStorage.setItem(LAST_PLAYED_KEY, JSON.stringify(lastPlayedState));
    }
  } catch {
    /* 忽略写入失败 */
  }
}

// 注册统一 Settings 层桥（必须在本模块所有 player 状态定义之后执行）
registerPlayerBridge({
  state,
  audio,
  playbackSettings,
  lastPlayedState,
  keys: { PLAYBACK_SETTINGS_KEY, VOLUME_KEY, PANEL_KEY, CONTROLS_KEY, LAST_PLAYED_KEY },
  persistPlayerCache,
});

// ============ 音频事件 ============
audio.addEventListener("timeupdate", () => {
  state.currentTime = audio.currentTime;
  syncMediaPosition();
  // 恢复上次播放：节流保存进度（10s 一次；页面关闭由 setupPlaybackFlush 兑底）
  if (playbackSettings.resumeLast && Date.now() - lastSaveAt > 10000) {
    lastSaveAt = Date.now();
    saveLastPlayed();
  }
  // 跟唱模式：每句播完自动停 / AB 区间循环 / 单句循环（逻辑在 useAbLoop.js）
  handleKaraokeTick(audio.currentTime);
});

audio.addEventListener("play", () => {
  state.isPlaying = true;
  syncMediaPlaybackState();
  // 真正开始出声才建播放会话：选歌但未播放不记；
  // 若已跟踪的歌不同（换歌后立即播放）→ 先上报旧会话
  const song = state.currentSong;
  if (song && (!playbackSession || playbackSession.key !== songSessionKey(song))) {
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
  // 试听 / URL 播放：播完自然停止，不自动切歌（currentIndex 未动，next/prev 随时回主队列）
  if (isPreviewSong(state.currentSong)) return;
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
