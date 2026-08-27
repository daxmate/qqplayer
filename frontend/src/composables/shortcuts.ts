// 键盘快捷键域（P1-2 批次2：从 playerCore.js 拆出）
//
// 配置表驱动、全量可录制（SHORTCUTS/SHORTCUT_CATEGORIES/parseShortcutCombo/fmtShortcutKey/
// setupKeyboardShortcuts）。
// 依赖方向：playerState、playbackEngine、queueEngine、audioEngine、useAbLoop、
// useLibrary、useLyric、searchState、settingsState（单向，系统入口调业务，无循环）。
import { state, playbackSettings } from "./playerState.ts";
import {
  togglePlay,
  seek,
  prevSong,
  nextSong,
  toggleMode,
  stepSpeed,
  pause,
} from "./playbackEngine.ts";
import { cyclePlayMode } from "./queueEngine.ts";
import { setVolume, toggleMute, audio } from "./audioEngine.ts";
import { setAbPointA, setAbPointB } from "./useAbLoop.js";
import { toggleFavorite } from "./useLibrary.js";
import { nextLine, prevLine, toggleZh } from "./useLyric.js";
import { isSearchOpen } from "./searchState.js";
import { isSettingsOpen } from "./settingsState.js";

// 空格播放/暂停，←/→ 快退/快进 10s，↑/↓ 音量 ±10%，⌘←/⌘→ 上下曲，M 静音，F 收藏，
// R 播放模式，L 翻译开关，G 连播↔跟唱，A/B AB 循环，[ ] 变速，⌘↑/⌘↓ 音量 ±20%
// 媒体键（MediaPlayPause 等）仅在无 MediaSession 的环境兜底处理（键盘事件），
// 有 MediaSession 时交给系统（避免双重触发）；媒体键不进配置表（不可录制，设置里仍展示说明）
const HAS_MEDIA_SESSION = typeof navigator !== "undefined" && "mediaSession" in navigator;
const MEDIA_KEY_CODES = ["MediaPlayPause", "MediaTrackNext", "MediaTrackPrevious", "MediaStop"];

// 快捷键分类（设置弹窗快捷键 tab 分组渲染顺序）
export const SHORTCUT_CATEGORIES: Array<{ key: string; labelKey: string }> = [
  { key: "playback", labelKey: "settings.shortcutCatPlayback" },
  { key: "track", labelKey: "settings.shortcutCatTrack" },
  { key: "volume", labelKey: "settings.shortcutCatVolume" },
  { key: "karaoke", labelKey: "settings.shortcutCatKaraoke" },
  { key: "search", labelKey: "settings.shortcutCatSearch" },
  { key: "other", labelKey: "settings.shortcutCatOther" },
];

export interface ShortcutDef {
  id: string;
  labelKey: string;
  category: string;
  settingKey: string;
  defaultCode: string;
  meta: boolean;
  handler: (() => void) | null;
}

// 快捷键配置表：{ id, labelKey, category, settingKey, defaultCode, meta, handler }
// - settingKey：playbackSettings 持久化字段（录制/加载均读写该字段；defaultCode 为出厂值）
// - defaultCode：默认组合（"Meta+<code>" = ⌘ 组合；否则纯键，e.code 风格）
// - meta：默认组合是否带 ⌘（展示/测试参考；实际匹配以当前 settingKey 值为准）
// - handler：null = 不进播放器处理（搜索快捷键由 SearchAnything 独占，避免双重触发）
export const SHORTCUTS: ShortcutDef[] = [
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
  {
    id: "openSettings",
    labelKey: "settings.shortcutOpenSettings",
    category: "other",
    settingKey: "shortcutOpenSettings",
    defaultCode: "Meta+Comma",
    meta: true,
    handler: () => {
      isSettingsOpen.value = true;
    },
  },
];

// 组合解析："Meta+<code>" → { meta: true, code }；纯 <code> → { meta: false, code }
// 历史格式兼容：searchKey 默认 "Meta+K"（省略 Key 前缀）→ code 归一为 KeyK
// 导出供 SettingsModal 冲突检测 / SearchAnything 匹配复用
export function parseShortcutCombo(
  combo: string | null | undefined,
): { meta: boolean; code: string } | null {
  if (!combo) return null;
  const meta = combo.startsWith("Meta+");
  let code = meta ? combo.slice(5) : combo;
  if (meta && code.length === 1) code = "Key" + code;
  return { meta, code };
}

// 组合匹配：meta=true 要求 e.metaKey；meta=false 要求无 meta/ctrl/alt（避免修饰键误触发）
function matchShortcutCombo(e: KeyboardEvent, combo: string): boolean {
  const p = parseShortcutCombo(combo);
  if (!p) return false;
  if (e.code !== p.code) return false;
  if (p.meta) return !!e.metaKey;
  return !e.metaKey && !e.ctrlKey && !e.altKey;
}

// 组合 → 展示文本（⌘← / Space / M / [ 等）；设置弹窗与搜索层共用
export function fmtShortcutKey(code: string | null | undefined): string {
  if (!code) return "—";
  const meta = code.startsWith("Meta+");
  const rest = meta ? code.slice(5) : code;
  const mod = meta ? "⌘" : "";
  const arrows: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
  };
  if (rest === "Space") return mod + "Space";
  if (arrows[rest]) return mod + arrows[rest];
  if (rest.startsWith("Key")) return mod + rest.slice(3);
  if (rest.startsWith("Digit")) return mod + rest.slice(5);
  if (rest === "BracketLeft") return mod + "[";
  if (rest === "BracketRight") return mod + "]";
  if (rest === "Comma") return mod + ",";
  return mod + rest;
}

// 输入框/文本域聚焦时不拦截（媒体键除外：即使输入框聚焦也应全局响应）
// search anything 搜索层打开时屏蔽播放快捷键（isSearchOpen 来自零依赖 searchState，避免循环依赖）
const SHORTCUT_HANDLER = (e: KeyboardEvent) => {
  // search anything 全屏搜索层打开时不响应播放快捷键（Space/←→/↑↓ 由搜索层消费）
  if (isSearchOpen.value) return;
  const el = e.target as HTMLElement | null;
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
    // settingKey 字段在 PlaybackSettings 均为 string；宽松键值视图取值（跨域只读）
    const combo = (playbackSettings as unknown as Record<string, unknown>)[s.settingKey] as
      string | undefined;
    if (matchShortcutCombo(e, combo || s.defaultCode)) {
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
