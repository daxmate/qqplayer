// 播放器核心状态（P1-2 批次2：从 playerCore.js 拆出）
//
// 本模块只承载「数据 + 类型」：state 单例、播放设置（playbackSettings）及其
// localStorage 启动恢复（loadPlaybackSettings）、跨域共享的类型定义。
// 零业务依赖（除 vue 的 reactive），保证被所有域模块单向引用（playerState ← 一切）。
//
// 与原始 playerCore.js 的差异（行为零变化，仅文件归属）：
//   - playbackSettings / PLAYBACK_SETTINGS_* / VISUALIZER_STYLES / loadPlaybackSettings
//     下沉到本模块（原计划归 playbackEngine，但 loadPlaybackSettings 的启动恢复与
//     state/playbackSettings 同模块才能被「模块重载恢复」测试以单 import 路径重载；
//     且 audioEngine/queueEngine 均需在模块求值期读 playbackSettings，放低层无循环）。
//   - eqGains 脏数据归一化 + _normalizeEqPreset + playMode watch 留在 playbackEngine
//     （前者需要 useEq，后者需要 queueEngine.ensureShuffleQueue，放这里会成环）。
//   - playMode 启动恢复（localStorage 值 → state.playMode）仍在本模块顶层执行。
import { reactive } from "vue";

// ============ 共享类型 ============

/** 歌词行：节标题 | 时间行（text: [日文, 罗马音, 中文]） */
export type LyricLine =
  { type: "sec"; name: string } | { type: "line"; s: number; e: number; text: string[] };

/** 歌曲条目（本地文件 / 曲库网络条目 / 试听 / URL 播放；宽松键值视图，字段可扩展） */
export interface Song {
  type?: string;
  path: string | null;
  streamId?: string | number;
  provider?: string;
  name?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
  url?: string;
  [key: string]: unknown;
}

/** 歌单（后端持久化） */
export interface Playlist {
  id: string;
  name: string;
  songPaths: string[];
  [key: string]: unknown;
}

/** 播放会话（播放统计上报；queueEngine 的 PlaybackHooks 与 playbackEngine 共用） */
export interface PlaybackSession {
  key: string | null;
  path: string | null;
  name: string;
  artist: string;
  album: string;
  duration: number;
  startedAt: number;
  completed: boolean;
  source: string;
  mode: string;
  device: string;
  skipStats: boolean;
}

/** 播放器 UI 状态（state reactive 单例） */
export interface State {
  songs: Song[];
  currentIndex: number;
  currentSong: Song | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  mode: string; // 'continuous' 连播 | 'karaoke' 跟唱 | 'books' 阅读 | 'videos' 视频（localStorage 启动缓存 + 统一层持久化，重启恢复）
  playMode: string; // 连播播放模式：'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
  karaokeOn: boolean; // 跟唱开关：开=每句播完自动停
  karaokeLoop: boolean; // 单句循环：跟唱开启时生效，句末自动回到句首重播
  abLoop: { a: number; b: number | null } | null; // AB 区间循环：null 关闭 | { a, b } 起点/终点（行索引，b 为 null 表示等选终点）
  speed: number;
  zhVisible: boolean;
  lyric: LyricLine[]; // [{type:'sec',name} | {type:'line',s,e,text:[jp,roma,zh]}]
  lyricFormat: string | null; // 'srt' | 'lrc' | null
  lyricSource: string | null; // 当前歌词实际来源：'local' | 在线来源名（netease/lrclib）| null
  libraryPath: string;
  librarySettings: Record<string, unknown> | null; // 音乐库设置（后端 settings.json 持久化）
  loading: boolean;
  error: string;
  volume: number; // 音量 0~1
  muted: boolean;
  favorites: string[]; // 收藏歌曲 path 列表（后端持久化）
  playlists: Playlist[]; // 歌单列表（后端持久化）
  activePlaylistId: string | null; // 当前浏览的歌单 id；null = 全部歌曲
  libraryVersion: unknown; // 歌曲库变动版本号（轮询对比，变化则自动刷新列表）
  lastSource: string; // 最近一次选歌来源：manual | auto | media（播放统计用）
}

/** 播放设置（localStorage 启动缓存 + 统一 Settings 层为真源） */
export interface PlaybackSettings {
  playMode: string; // 播放模式（启动时恢复）：'order' 列表循环 | 'shuffle' 随机 | 'repeatOne' 单曲循环
  resumeLast: boolean; // 启动时恢复上次播放的歌曲与进度
  rememberVolume: boolean; // 记住音量（关闭则每次启动回到默认音量）
  fadeSec: number; // 切歌淡入淡出时长（秒）；0 = 关闭
  karaokeNextKey: string; // 跟唱：下一句快捷键（设置可改）
  karaokePrevKey: string; // 跟唱：上一句快捷键（设置可改）
  searchKey: string; // 搜索：打开 search anything（Cmd+K；设置可改，存 e.code 风格）
  // 任务 G：快捷键全量可录制（默认值 e.code 风格；⌘ 组合存 "Meta+<code>"）
  shortcutPlayPause: string; // 播放 / 暂停
  shortcutRewind: string; // 快退 10 秒
  shortcutForward: string; // 快进 10 秒
  shortcutVolUp: string; // 音量 +10%
  shortcutVolDown: string; // 音量 -10%
  shortcutPrevTrack: string; // 上一首（⌘←）
  shortcutNextTrack: string; // 下一首（⌘→）
  shortcutMute: string; // 静音切换
  shortcutFav: string; // 收藏 / 取消收藏当前歌
  shortcutCycleMode: string; // 播放模式切换
  shortcutZhToggle: string; // 中文翻译显示开关
  shortcutKaraokeMode: string; // 连播 ↔ 跟唱模式切换
  shortcutAbA: string; // AB 循环：设起点
  shortcutAbB: string; // AB 循环：设终点
  shortcutSlower: string; // 变速 -（0.75 → 1.0 → 1.25）
  shortcutFaster: string; // 变速 +
  shortcutVolStepUp: string; // 音量 +20%（⌘↑）
  shortcutVolStepDown: string; // 音量 -20%（⌘↓）
  shortcutOpenSettings: string; // 打开设置（⌘，）
  eqEnabled: boolean; // 均衡器开关（false = 全部 0dB 直通）
  eqPreset: string; // 均衡器预设：EQ_PRESETS 的 key；'custom' = 用户自定义
  eqGains: number[]; // 自定义增益（dB，-12~12，10 段，与 EQ_BANDS 对齐）
  abVisual: boolean; // AB 循环区间可视化（起点 A / 终点 B 徽标 + 区间进度条）
  abLoopCountOn: boolean; // AB 循环计数（防走开安全阀）：B 句播完算一遍，满 N 遍停回 A 句首暂停
  abLoopMaxCount: number; // AB 循环计数上限（1-20）
  visualizerEnabled: boolean; // 视觉化总开关（主区域氛围背景 + ControlBar 迷你频谱；仅播放中活跃，暂停呼吸静止）
  visualizerStyle: string; // 迷你频谱样式：'bars' 频谱条 | 'radial' 圆环 | 'wave' 波形 | 'pulse' 脉冲环 | 'mirror' 镜像 | 'particle' 粒子（见 VISUALIZER_STYLES）
  // 任务 C（混合方案）：主区域改封面取色氛围背景、频谱移入 ControlBar 迷你条。
  // 注：ambientEnabled / miniSpectrumEnabled 为「前端本地持久化」字段——后端 settings 白名单未收录，
  // PUT /api/settings 时会被 _norm_namespace 丢弃，仅存 localStorage（PLAYBACK_SETTINGS_KEY），跨设备不同步。
  ambientEnabled: boolean; // 主区域氛围背景（封面取色光晕 + 呼吸/能量律动）
  miniSpectrumEnabled: boolean; // ControlBar 迷你频谱条（桌面端进度条左侧；移动端对应 MobilePlayer 中间小频谱）
  sleepTimerOn: boolean; // 睡眠定时器开关（统一层持久化；运行中的倒计时不持久化，页面刷新即取消）
  sleepTimerMinutes: number; // 睡眠定时器时长（分钟，chip 单选）
  streamStats: boolean; // 流媒体统计开关：true = 试听 / URL 播放计入播放统计（曲库网络条目始终计入）
}

// ============ 播放器 UI 状态 ============
export const state = reactive<State>({
  songs: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  mode: "continuous", // 'continuous' 连播 | 'karaoke' 跟唱 | 'books' 阅读 | 'videos' 视频（localStorage 启动缓存 + 统一层持久化，重启恢复）
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
  lastSource: "manual", // 最近一次选歌来源：manual | auto | media（播放统计用）
});

// ============ 播放设置（localStorage 持久化）============
// 覆盖：播放模式记忆 / 恢复上次播放 / 记住音量 / 切歌淡入淡出
export const PLAYBACK_SETTINGS_KEY = "qqplayer.playbackSettings.v1";

export const PLAYBACK_SETTINGS_DEFAULTS: PlaybackSettings = {
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
  shortcutOpenSettings: "Meta+Comma", // 打开设置（⌘，）
  eqEnabled: false, // 均衡器开关（false = 全部 0dB 直通）
  eqPreset: "flat", // 均衡器预设：EQ_PRESETS 的 key；'custom' = 用户自定义
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // 自定义增益（dB，-12~12，10 段，与 EQ_BANDS 对齐）
  abVisual: true, // AB 循环区间可视化（起点 A / 终点 B 徽标 + 区间进度条）
  abLoopCountOn: true, // AB 循环计数（防走开安全阀）：B 句播完算一遍，满 N 遍停回 A 句首暂停
  abLoopMaxCount: 10, // AB 循环计数上限（1-20）
  visualizerEnabled: true, // 视觉化总开关（主区域氛围背景 + ControlBar 迷你频谱；仅播放中活跃，暂停呼吸静止）
  visualizerStyle: "bars", // 迷你频谱样式：'bars' 频谱条 | 'radial' 圆环 | 'wave' 波形 | 'pulse' 脉冲环 | 'mirror' 镜像 | 'particle' 粒子（见 VISUALIZER_STYLES）
  // 任务 C（混合方案）：主区域改封面取色氛围背景、频谱移入 ControlBar 迷你条。
  // 注：ambientEnabled / miniSpectrumEnabled 为「前端本地持久化」字段——后端 settings 白名单未收录，
  // PUT /api/settings 时会被 _norm_namespace 丢弃，仅存 localStorage（PLAYBACK_SETTINGS_KEY），跨设备不同步。
  ambientEnabled: true, // 主区域氛围背景（封面取色光晕 + 呼吸/能量律动）
  miniSpectrumEnabled: true, // ControlBar 迷你频谱条（桌面端进度条左侧；移动端对应 MobilePlayer 中间小频谱）
  sleepTimerOn: false, // 睡眠定时器开关（统一层持久化；运行中的倒计时不持久化，页面刷新即取消）
  sleepTimerMinutes: 30, // 睡眠定时器时长（分钟，chip 单选）
  streamStats: false, // 流媒体统计开关：true = 试听 / URL 播放计入播放统计（曲库网络条目始终计入）
};

export const playbackSettings = reactive<PlaybackSettings>({ ...PLAYBACK_SETTINGS_DEFAULTS });

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
    const saved = JSON.parse(raw) as Record<string, unknown>;
    // 宽松键值视图写入：saved 为任意 JSON 形态，字段级类型校验由各消费方兜底
    const view = playbackSettings as unknown as Record<string, unknown>;
    for (const k of Object.keys(view)) {
      if (k in saved) view[k] = saved[k];
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

// 播放模式随设置恢复（用户手动三态切换时也会同步回 playbackSettings，见 queueEngine.cyclePlayMode）
// 注：eqGains 归一化 / _normalizeEqPreset / playMode 变化 watch 在 playbackEngine（需 useEq/queueEngine）
if (["order", "shuffle", "repeatOne"].includes(playbackSettings.playMode)) {
  state.playMode = playbackSettings.playMode;
}
