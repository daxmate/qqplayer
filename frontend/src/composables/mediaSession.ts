// 系统媒体键域（P1-2 批次2：从 playerCore.js 拆出）
//
// MediaSession（系统媒体键/控制中心/锁屏）+ 锁屏元数据（setupMediaSession）。
// 依赖方向：playerState、playbackEngine、queueEngine、audioEngine、useAbLoop、
// useLyric（单向，无循环）。
//
// 循环依赖处理（与原始 playerCore.js 的行为零变化）：
//   - audioEngine 的音频事件需要同步 MediaSession 位置/播放态 → 本模块经
//     registerAudioEventHooks 注入 syncPosition/syncPlaybackState（audioEngine 不反向 import）。
import { watch } from "vue";
import { state } from "./playerState.ts";
import { play, pause, prevSong, nextSong, seek } from "./playbackEngine.ts";
import { audio, registerAudioEventHooks } from "./audioEngine.ts";
import i18n from "../locales/i18n.js";

let mediaSessionPosSync = 0; // setPositionState 节流时间戳

// 相对路径 → 绝对 URL（artwork 要求绝对地址；无 window 环境原样返回）
function absoluteUrl(path: string): string {
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
let mediaSessionStop: (() => void) | null = null;

export function setupMediaSession() {
  if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
    return () => {};
  }
  const ms = navigator.mediaSession;
  // 初始化为 paused（而非默认 none）：Chrome/系统媒体键只路由给 playbackState
  // 非 none 的页面，否则未播放过时按播放键无响应
  ms.playbackState = state.isPlaying ? "playing" : "paused";
  const handlers: Record<string, (details?: unknown) => void> = {
    play: () => play(),
    pause: () => pause(),
    previoustrack: () => prevSong({ autoPlay: true, source: "media" }),
    nexttrack: () => nextSong({ autoPlay: true, source: "media" }),
    seekto: (details) => {
      if (details && typeof (details as { seekTime?: unknown }).seekTime === "number") {
        seek((details as { seekTime: number }).seekTime);
      }
    },
    seekbackward: (details) => {
      const offset = (details as { seekOffset?: number } | undefined)?.seekOffset || 10;
      seek(Math.max(0, (audio.currentTime || 0) - offset));
    },
    seekforward: (details) => {
      const offset = (details as { seekOffset?: number } | undefined)?.seekOffset || 10;
      seek(Math.min(audio.duration || 0, (audio.currentTime || 0) + offset));
    },
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(action as MediaSessionAction, fn);
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
        ms.setActionHandler(action as MediaSessionAction, null);
      } catch {
        /* 忽略 */
      }
    }
  };
}

// audioEngine 音频事件 → 同步 MediaSession 位置/播放态（避免 audioEngine ↔ 本模块循环 import）
registerAudioEventHooks({
  syncPosition: syncMediaPosition,
  syncPlaybackState: syncMediaPlaybackState,
});
