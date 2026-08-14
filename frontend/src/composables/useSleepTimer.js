// 睡眠定时器（模块级单例 composable）
// 开关 + 时长持久化在 playbackSettings（与播放设置共用 PLAYBACK_SETTINGS_KEY localStorage）；
// 激活中的倒计时不持久化——页面刷新即取消（一次性行为）。
// 到点暂停：只读调用 playerCore 的 audio/state（audio.pause() 后由 playerCore 的
// pause 事件监听同步 state.isPlaying，与手动暂停完全一致），不修改 playerCore.js。
import { reactive, computed } from "vue";
import { audio, state, playbackSettings, loadPlaybackSettings } from "./playerCore.js";
import i18n from "../locales/i18n.js";

// 时长选项（分钟，chip 单选）
export const SLEEP_TIMER_OPTIONS = [15, 30, 45, 60, 90];
const DEFAULT_MINUTES = 30;

// 运行态（不持久化）：
//   active   倒计时是否运行中
//   remaining 剩余秒数
//   status   '' 空闲 | 'running' 倒计时中 | 'fired' 已到点（轻提示状态）
export const sleepTimer = reactive({
  active: false,
  remaining: 0,
  status: "",
});

let timerId = null;
let firedMessageTimer = null;

// 注：开关/时长持久化走统一 Settings 层（playerCore 的 loadPlaybackSettings 同步缓存加载 +
// settingsSync 的 GET/PUT /api/settings），不再由本模块直接读 localStorage 原始串；
// sleepTimerOn/sleepTimerMinutes 已纳入 PLAYBACK_SETTINGS_DEFAULTS，随 playbackSettings 一并恢复。

function clearFiredMessage() {
  if (firedMessageTimer) {
    clearTimeout(firedMessageTimer);
    firedMessageTimer = null;
  }
}

function stopCountdown() {
  if (timerId) {
    clearInterval(timerId);
    timerId = null;
  }
}

function startCountdown(minutes) {
  stopCountdown();
  clearFiredMessage();
  playbackSettings.sleepTimerOn = true;
  playbackSettings.sleepTimerMinutes = minutes;
  sleepTimer.active = true;
  sleepTimer.remaining = minutes * 60;
  sleepTimer.status = "running";
  timerId = setInterval(() => {
    sleepTimer.remaining -= 1;
    if (sleepTimer.remaining <= 0) fire();
  }, 1000);
}

// 到点：暂停播放（与现有暂停一致——playerCore 的 pause 事件监听同步 state.isPlaying）
function fire() {
  stopCountdown();
  if (state.isPlaying) {
    audio.pause();
  }
  playbackSettings.sleepTimerOn = false;
  sleepTimer.active = false;
  sleepTimer.remaining = 0;
  sleepTimer.status = "fired";
  // 轻提示：6 秒后自动消失（不淡出/不退出应用）
  firedMessageTimer = setTimeout(() => {
    if (sleepTimer.status === "fired") sleepTimer.status = "";
  }, 6000);
}

// 开关：开 = 以当前时长启动倒计时；关 = 取消
export function toggleSleepTimer() {
  if (sleepTimer.active) {
    cancelSleepTimer();
  } else {
    startCountdown(playbackSettings.sleepTimerMinutes || DEFAULT_MINUTES);
  }
}

// 切时长：倒计时运行中重置；开关开着但未运行（如刷新后）则直接启动
export function setSleepTimerMinutes(minutes) {
  const m = SLEEP_TIMER_OPTIONS.includes(minutes) ? minutes : DEFAULT_MINUTES;
  playbackSettings.sleepTimerMinutes = m;
  if (sleepTimer.active) {
    startCountdown(m); // 切时长 = 重置倒计时
  } else if (playbackSettings.sleepTimerOn) {
    startCountdown(m);
  }
}

// 取消（关开关）
export function cancelSleepTimer() {
  stopCountdown();
  clearFiredMessage();
  playbackSettings.sleepTimerOn = false;
  sleepTimer.active = false;
  sleepTimer.remaining = 0;
  sleepTimer.status = "";
}

// 倒计时显示文案：mm:ss（如 14:59）；空闲返回空
export const sleepTimerLabel = computed(() => {
  const m = Math.floor(sleepTimer.remaining / 60);
  const s = sleepTimer.remaining % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
});

// 控制栏/移动端播放器统一展示文案：倒计时中 / 已到点 / 空
export const sleepTimerText = computed(() => {
  if (sleepTimer.status === "fired") return i18n.global.t("control.sleepTimerFired");
  if (sleepTimer.active)
    return i18n.global.t("control.sleepTimerRunning", { time: sleepTimerLabel.value });
  return "";
});

// 仅供测试：重置运行态与开关/时长
export function _resetSleepTimer() {
  stopCountdown();
  clearFiredMessage();
  playbackSettings.sleepTimerOn = false;
  playbackSettings.sleepTimerMinutes = DEFAULT_MINUTES;
  sleepTimer.active = false;
  sleepTimer.remaining = 0;
  sleepTimer.status = "";
}

// 仅供测试：重新从 localStorage 恢复（模拟页面刷新）——走 playerCore 的同步缓存加载（统一层）
export function _reloadPersisted() {
  loadPlaybackSettings();
}
