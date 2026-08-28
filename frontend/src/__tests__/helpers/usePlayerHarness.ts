// usePlayer composable 测试共享 harness
// 收敛原 usePlayer.test.js 头部样板（原 1-210 行）：FakeAudio stub / localStorage stub /
// usePlayer barrel 导入 / RESET 复位 / 公共 beforeEach + afterEach。
// 用法：测试文件 `import { FakeAudio, state, ... } from "./helpers/usePlayerHarness.js";`
// 注意：Audio stub 必须在 import usePlayer 之前注册（模块加载时读取 Audio），
//       故本模块内被测依赖统一用动态 await import，保证求值顺序与旧样板一致；
//       公共 hooks 在模块顶层注册，随测试文件导入自动生效（与 __tests__/setup.js 同模式）。
// usePlayer composable 单元测试
import { beforeEach, afterEach, vi } from "vitest";
import type { PlaybackSettings } from "../../composables/playerState.js";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
class FakeAudio {
  static instances: FakeAudio[] = [];
  _src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  volume = 1;
  muted = false;
  ended = false;
  preload = "auto";
  listeners: Record<string, (e?: unknown) => void> = {};
  constructor() {
    FakeAudio.instances.push(this);
  }
  // 浏览器行为：换源自动归零播放位置
  set src(v: string) {
    this._src = v;
    if (v) this.currentTime = 0;
  }
  get src(): string {
    return this._src;
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  removeAttribute(): void {}
  addEventListener(ev: string, fn: (e?: unknown) => void): void {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub（vitest 默认 node 环境无 localStorage；usePlayer 模块加载时 try/catch 保护，测试体里需要显式提供）
const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = String(v);
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
};

const {
  state,
  cycleSpeed,
  stepSpeed,
  audioEq,
  audioBare,
  cyclePlayMode,
  nextSong,
  prevSong,
  togglePlay,
  toggleKaraoke,
  toggleZh,
  loadSongs,
  findSongIndex,
  selectSong,
  play,
  playLine,
  seek,
  nextLine,
  toggleKaraokeLoop,
  enterAbLoop,
  setAbEnd,
  exitAbLoop,
  clickLine,
  currentLineIndex,
  lyricSettings,
  LYRIC_SETTINGS_KEY,
  uiSettings,
  UI_SETTINGS_KEY,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  PLAYBACK_SETTINGS_DEFAULTS,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  fmtShortcutKey,
  parseShortcutCombo,
  restoreLastPlayed,
  saveLastPlayed,
  LAST_PLAYED_KEY,
  lastPlayedState,
  _resetKaraokeAnchor,
  _resetKaraokeJump,
  _resetPlayMode,
  setVolume,
  toggleMute,
  VOLUME_KEY,
  loadFavorites,
  toggleFavorite,
  isFavorite,
  removeFromQueue,
  setupKeyboardShortcuts,
  setupMediaSession,
  setupPlaybackFlush,
  setupAutoRefresh,
  stopAutoRefresh,
  setupPlayerActions,
  stopPlayerActions,
  setupMiniStatus,
  stopMiniStatus,
  refreshMiniStatus,
  miniRunning,
  EQ_PRESETS,
  EQ_BANDS,
  setEqPreset,
  setEqGain,
  _resetEqGraph,
  loadLibrarySettings,
  saveLibrarySettings,
  _resetPlaybackSession,
  reorderQueue,
  persistQueueOrder,
  loadQueueOrder,
  _resetQueueOrder,
} = await import("../../composables/usePlayer.js");

// 模块对象（live binding：playerMod.audio 每次读当前活动元素，跨变速切换）
const playerMod = await import("../../composables/usePlayer.js");

const { getPendingOps } = await import("../../utils/cacheDb.js");
const { invalidate } = await import("../../utils/apiClient.js");

const {
  loadPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  setPlaylistOrder,
  isInPlaylist,
} = await import("../../composables/usePlayer.js");
const { toggleMusicLib, togglePlaylist, uiState, UI_STATE_KEY } =
  await import("../../composables/usePlayer.js");
const { toggleControls } = await import("../../composables/usePlayer.js");
const { loadLyric } = await import("../../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../../composables/useToast.js");

const RESET = {
  songs: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  mode: "continuous",
  playMode: "order",
  karaokeOn: true,
  karaokeLoop: false,
  abLoop: null,
  speed: 1.0,
  zhVisible: true,
  lyric: [],
  lyricFormat: null,
  lyricSource: null,
  libraryPath: "",
  librarySettings: null,
  loading: false,
  error: "",
  volume: 1.0,
  muted: false,
  favorites: [],
  playlists: [],
  activePlaylistId: null,
  libraryVersion: null,
  lastSource: "manual",
};

beforeEach(() => {
  _resetEqGraph(); // 重置音频图 + 活动元素回 audioEq（防变速用例把 audio 切到 audioBare 泄漏）
  Object.assign(state, RESET);
  // RESET 里的数组字段是模块级共享引用（旧用例可能 push 过），换成新数组防跨用例残留
  state.songs = [];
  state.lyric = [];
  state.favorites = [];
  state.playlists = [];
  // 快捷键配置表默认值复位（含 karaokeNextKey/PrevKey/searchKey，防用例间录制值残留）
  for (const s of SHORTCUTS) {
    playbackSettings[s.settingKey as keyof PlaybackSettings] = s.defaultCode as never;
  }
  _resetKaraokeAnchor();
  _resetKaraokeJump();
  _resetPlayMode();
  _resetPlaybackSession();
  _resetQueueOrder();
  // UI 开关（uiState 独立模块，RESET 不再覆盖；此处显式复位防用例间残留）
  Object.assign(uiState, {
    musicLibOpen: true,
    playlistOpen: true,
    controlsHidden: false,
    specLyricOpen: false,
  });
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

export {
  state,
  cycleSpeed,
  stepSpeed,
  audioEq,
  audioBare,
  cyclePlayMode,
  nextSong,
  prevSong,
  togglePlay,
  toggleKaraoke,
  toggleZh,
  loadSongs,
  findSongIndex,
  selectSong,
  play,
  playLine,
  seek,
  nextLine,
  toggleKaraokeLoop,
  enterAbLoop,
  setAbEnd,
  exitAbLoop,
  clickLine,
  currentLineIndex,
  lyricSettings,
  LYRIC_SETTINGS_KEY,
  uiSettings,
  UI_SETTINGS_KEY,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  PLAYBACK_SETTINGS_DEFAULTS,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  fmtShortcutKey,
  parseShortcutCombo,
  restoreLastPlayed,
  saveLastPlayed,
  LAST_PLAYED_KEY,
  lastPlayedState,
  _resetKaraokeAnchor,
  _resetKaraokeJump,
  _resetPlayMode,
  setVolume,
  toggleMute,
  VOLUME_KEY,
  loadFavorites,
  toggleFavorite,
  isFavorite,
  removeFromQueue,
  setupKeyboardShortcuts,
  setupMediaSession,
  setupPlaybackFlush,
  setupAutoRefresh,
  stopAutoRefresh,
  setupPlayerActions,
  stopPlayerActions,
  setupMiniStatus,
  stopMiniStatus,
  refreshMiniStatus,
  miniRunning,
  EQ_PRESETS,
  EQ_BANDS,
  setEqPreset,
  setEqGain,
  _resetEqGraph,
  loadLibrarySettings,
  saveLibrarySettings,
  _resetPlaybackSession,
  reorderQueue,
  persistQueueOrder,
  loadQueueOrder,
  _resetQueueOrder,
  loadPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  setPlaylistOrder,
  isInPlaylist,
  toggleMusicLib,
  togglePlaylist,
  uiState,
  UI_STATE_KEY,
  toggleControls,
  loadLyric,
  playerMod,
  useToast,
  clearToasts,
  getPendingOps,
  invalidate,
  FakeAudio,
  localStorageStub,
  lsStore,
  RESET,
};
