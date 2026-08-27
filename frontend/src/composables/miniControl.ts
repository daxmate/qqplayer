// 迷你窗/桌面歌词域（P1-2 批次2：从 playerCore.js 拆出）
//
// 桌面歌词当前播放状态上报（/api/now-playing 节流轮询）、迷你窗控制指令消费
// （setupPlayerActions）、迷你窗运行状态（miniRunning 系列）。
// 依赖方向：playerState、playbackEngine、audioEngine、useSettings、useLyric、
// apiClient（单向，系统入口调业务，无循环）。
import { ref, watch } from "vue";
import { state, type Song } from "./playerState.ts";
import { togglePlay, play, pause, nextSong, prevSong, seek } from "./playbackEngine.ts";
import { setVolume } from "./audioEngine.ts";
import { uiSettings, ACCENT_OPTIONS } from "./useSettings.js";
import { currentLineIndex } from "./useLyric.js";
import { apiPost, apiGet } from "../utils/apiClient.js";

// ============ 桌面歌词/迷你窗：当前播放状态上报（悬浮窗轮询读取）============
// 节流 250ms 合并；切歌/seek/句切换/播放状态变化都会触发，只报最新值
let nowPlayingTimer: number | null = null;
let nowPlayingPending: Record<string, unknown> | null = null;

// 当前播放快照（桌面歌词 + 迷你窗共用的完整状态）
function nowPlayingSnapshot(): Record<string, unknown> {
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
  // 当前无歌曲时不报（节流窗口内歌曲被清空/测试复位场景；避免脏上报）
  if (!state.currentSong) return;
  // 带上强调色（桌面歌词「跟随主题」配色用）
  const accent = ACCENT_OPTIONS.find((a) => a.key === uiSettings.accent)?.color || "";
  // 外部展示状态，失败静默（不排队——随时节流重发，无离线价值）
  apiPost("/api/now-playing", { ...nowPlayingSnapshot(), ...p, accent }).catch(() => {});
}

function scheduleNowPlaying(extra: Record<string, unknown> = {}) {
  nowPlayingPending = { ...extra };
  if (nowPlayingTimer) return; // 节流中，等定时器触发上报最新值
  nowPlayingTimer = setTimeout(flushNowPlaying, 250);
}

watch([() => songKeyOf(state.currentSong), currentLineIndex], ([path, line]) => {
  if (!path || line < 0) return;
  scheduleNowPlaying({ path, lineIndex: line });
});

// 当前播放歌曲的稳定标识（path 为 null 的流媒体歌用 streamId 兜底，桌面歌词/迷你窗照常上报）
function songKeyOf(song: Song | null): string | null {
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
let playerActionsTimer: number | null = null;

function executePlayerAction(a: { action?: string; value?: number }) {
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
      seek(a.value as number);
      break;
    case "volume":
      setVolume(a.value as number);
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
      // 控制指令队列是实时轮询，不走缓存
      const r = await apiGet("/api/player/actions");
      const { actions } = (r.ok && r.data) || {};
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
let miniStatusTimer: number | null = null;

export async function refreshMiniStatus() {
  try {
    // 迷你窗运行状态是实时探活，不走缓存
    const r = await apiGet("/api/mini/status");
    const { running } = (r.ok && r.data) || {};
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
