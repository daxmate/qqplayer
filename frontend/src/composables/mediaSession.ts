// 系统媒体键域（P1-2 批次2：从 playerCore.js 拆出）
//
// MediaSession（桌面系统媒体键/控制中心/锁屏）+ iOS 原生远端命令/切歌跟随 +
// 锁屏元数据封面解析（resolveCoverForMetadata/setupMediaSession）。
// 依赖方向：playerState、playbackEngine、queueEngine、audioEngine、useAbLoop、
// useLyric、nativeAudioBridge、utils（单向，无循环）。
//
// 循环依赖处理（与原始 playerCore.js 的行为零变化）：
//   - audioEngine 的音频事件需要同步 MediaSession 位置/播放态 → 本模块经
//     registerAudioEventHooks 注入 syncPosition/syncPlaybackState（audioEngine 不反向 import）。
//   - 原生切歌跟随要读写 queueEngine 的洗牌队列内部状态（shuffleQueue 读 /
//     shufflePos 写）→ shuffleQueue 只读导出 + setShufflePos setter。
import { watch } from "vue";
import { state, type Song } from "./playerState.ts";
import { play, pause, prevSong, nextSong, seek, togglePlay } from "./playbackEngine.ts";
import { songChangedTargetIndex, dbgLog, shuffleQueue, setShufflePos } from "./queueEngine.ts";
import { audio, registerAudioEventHooks } from "./audioEngine.ts";
import { resetAbLoopCount } from "./useAbLoop.js";
import { loadLyric } from "./useLyric.js";
import {
  isNativePlayback,
  registerRemoteCommandHandler,
  registerNativeSongChangedHandler,
  nativeSendMetadata,
  resolveCoverURL,
  nativePost,
  type LockScreenSong,
} from "./nativeAudioBridge.js";
import { cachedCoverURL, cacheCover } from "../utils/sync.js";
import { coverToDataURL } from "../utils/coverDataURL.js";
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

/**
 * 解析切歌时原生元数据用的封面（data: URL 优先，CarPlay 即时刷新）：
 * - 本地封面缓存命中 → coverToDataURL 转 data:（失败兑底原始本地 URL）
 * - 未命中 → cacheCover 后台缓存（fire-and-forget）+ 远程 URL → coverToDataURL 转 data:
 *   （失败兑底远程 URL，原生异步路径锁屏仍正常）
 * 任一步 await 后都用 isCurrent 校验：已切歌返回 null（调用方不覆盖新歌元数据）。
 * @param isCurrent 校验函数：返回 true/false 布尔谓词，或返回当前歌对象（与 song 恒等比较）
 * @returns Promise<string | null> "" = 无封面；null = 已切歌（结果作废）
 */
export async function resolveCoverForMetadata(
  song: Song | null | undefined,
  isCurrent: (song: Song | null | undefined) => boolean | Song | null | undefined,
): Promise<string | null> {
  if (!song?.path) return "";
  const local = await cachedCoverURL(song.path).catch(() => null);
  if (!isSongStillCurrent(song, isCurrent)) return null; // 已切歌 → aborted
  if (local) {
    const cover = await coverToDataURL(local).catch(() => local); // 失败兑底原始本地 URL
    if (!isSongStillCurrent(song, isCurrent)) return null;
    return cover;
  }
  cacheCover(song.path); // fire-and-forget 保持现状
  const remote = resolveCoverURL(song as unknown as LockScreenSong);
  if (!remote) return "";
  const cover = await coverToDataURL(remote).catch(() => remote); // 失败兑底远程 URL（原生异步路径，锁屏仍正常）
  if (!isSongStillCurrent(song, isCurrent)) return null;
  return cover;
}

// isCurrent 语义归一：布尔谓词（true=仍当前/false=已切）或当前歌对象（与 song 恒等比较——
// Vue reactive 会把赋值对象包成代理，不能靠 !cur 判空，必须对 song 做恒等比较）。
function isSongStillCurrent(
  song: Song,
  isCurrent: (song: Song | null | undefined) => boolean | Song | null | undefined,
): boolean {
  const cur = isCurrent(song);
  if (cur === true) return true;
  if (cur === false || cur == null) return false;
  return cur === song;
}

export function setupMediaSession() {
  // iOS 原生播放：无 navigator.mediaSession，锁屏元数据/远端命令走原生桥
  // （currentSong 变化 → setMetadata；锁屏/线控命令 → 同一套动作）
  if (isNativePlayback()) {
    mediaSessionStop?.();
    mediaSessionStop = watch(
      () => state.currentSong,
      async (song) => {
        // 封面 data: URL 优先（CarPlay 无线场景手机脱离 Mac 网络，远程 /api/cover 拉图会失败；
        // 且原生对 data: 走同步解码路径，CarPlay 即时刷新——异步补图车机不刷新）。
        // 异步转换期间可能已切歌：旧结果不覆盖新歌（isCurrent 校验）。
        const cover = await resolveCoverForMetadata(song, () => state.currentSong);
        if (cover === null) return; // 已切歌，旧结果不覆盖新歌
        nativeSendMetadata(song as unknown as LockScreenSong, cover);
      },
      { immediate: true },
    );
    return () => {
      mediaSessionStop?.();
      mediaSessionStop = null;
    };
  }
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

// iOS 原生播放：锁屏/耳机线控命令（壳 MPRemoteCommandCenter → remoteCommand 事件）
// 与桌面 MediaSession 同一套动作（队列/切歌逻辑复用）；桌面浏览器不注册（行为零变化）
if (isNativePlayback()) {
  registerRemoteCommandHandler((cmd, t) => {
    // 诊断日志：远端命令到达 Web（debuglog.json；与 nativecmd.log 对照定位断点）
    dbgLog("remoteCmd", { cmd, t: t ?? null });
    switch (cmd) {
      case "play":
        play();
        break;
      case "pause":
        pause();
        break;
      case "toggle":
        togglePlay();
        break;
      case "next":
        nextSong({ autoPlay: true, source: "media" });
        break;
      case "prev":
        prevSong({ autoPlay: true, source: "media" });
        break;
      case "seekto":
        if (typeof t === "number" && Number.isFinite(t)) seek(t);
        break;
      default:
        break;
    }
  });
  // 原生切歌跟随：锁屏/线控切歌由原生执行（后台 Web 挂起），songChanged 回传后对齐状态——
  // 不重新 load（原生已切源），只同步当前歌/进度/歌词等状态
  registerNativeSongChangedHandler((index) => {
    const target = songChangedTargetIndex(state.playMode, index, shuffleQueue, state.songs.length);
    if (target < 0) return;
    if (state.playMode === "shuffle" && index >= 0 && index < shuffleQueue.length) {
      // 原生快照位置 = 洗牌队列位置（nativeSyncQueue 按 shuffleQueue 顺序同步）→ 跟随
      setShufflePos(index);
    }
    state.currentIndex = target;
    state.currentSong = state.songs[target];
    state.isPlaying = true; // 原生切歌即播放
    state.currentTime = 0;
    state.duration = 0;
    state.lyric = [];
    state.lyricFormat = null;
    state.lyricSource = null;
    state.abLoop = null; // 切歌重置 AB 循环
    resetAbLoopCount();
    dbgLog("songChanged", { index, title: state.currentSong?.name });
    loadLyric(target);
  });
  // 桥就绪上报：壳收到 nativeReady 后才开始推播放事件（防事件早于适配层）
  nativePost({ cmd: "nativeReady" });
}

// audioEngine 音频事件 → 同步 MediaSession 位置/播放态（避免 audioEngine ↔ 本模块循环 import）
registerAudioEventHooks({
  syncPosition: syncMediaPosition,
  syncPlaybackState: syncMediaPlaybackState,
});
