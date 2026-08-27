// useSleepTimer composable 单元测试（睡眠定时器）
// 覆盖：启动定时器 / 切时长重置 / 关开关取消 / 到点触发暂停 / 持久化恢复开关与时长
// 倒计时用 setInterval 逐秒递减（不依赖 Date），配合 vi.useFakeTimers() 精确控制
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
// 与真实浏览器一致：play/pause 触发对应事件（playerCore 靠 pause 事件同步 state.isPlaying）
class FakeAudio {
  static instances = [];
  constructor() {
    this._src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  // 浏览器行为：换源自动归零播放位置
  set src(v) {
    this._src = v;
    if (v) this.currentTime = 0;
  }
  get src() {
    return this._src;
  }
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.listeners["pause"]?.();
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub（模块加载与测试体共用）
const lsStore = {};
const localStorageStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => {
    lsStore[k] = String(v);
  },
  removeItem: (k) => {
    delete lsStore[k];
  },
};

const { state, playbackSettings, selectSong, PLAYBACK_SETTINGS_KEY } =
  await import("../composables/usePlayer.js");
const {
  sleepTimer,
  sleepTimerText,
  SLEEP_TIMER_OPTIONS,
  toggleSleepTimer,
  setSleepTimerMinutes,
  cancelSleepTimer,
  _resetSleepTimer,
  _reloadPersisted,
} = await import("../composables/useSleepTimer.js");

function audio() {
  return FakeAudio.instances[0];
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  _resetSleepTimer();
  Object.assign(state, { isPlaying: false, mode: "continuous" });
  await nextTick(); // 冲刷 playerCore 的 deep watch 写入，保证 localStorage 基线干净
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("睡眠定时器", () => {
  it("启动：开关打开 + 倒计时运行（15 分钟 → 900s，逐秒递减，显示 mm:ss）", () => {
    setSleepTimerMinutes(15);
    toggleSleepTimer();
    expect(playbackSettings.sleepTimerOn).toBe(true);
    expect(playbackSettings.sleepTimerMinutes).toBe(15);
    expect(sleepTimer.active).toBe(true);
    expect(sleepTimer.remaining).toBe(900);
    expect(sleepTimer.status).toBe("running");
    expect(sleepTimerText.value).toBe("睡眠定时器 15:00");

    vi.advanceTimersByTime(3000);
    expect(sleepTimer.remaining).toBe(897);
    expect(sleepTimerText.value).toBe("睡眠定时器 14:57");
  });

  it("默认时长：未选过时开关即用 30 分钟", () => {
    toggleSleepTimer();
    expect(playbackSettings.sleepTimerMinutes).toBe(30);
    expect(sleepTimer.remaining).toBe(1800);
  });

  it("切时长：重置倒计时（开关保持开）", () => {
    toggleSleepTimer(); // 30 分钟
    expect(sleepTimer.remaining).toBe(1800);
    vi.advanceTimersByTime(60_000);
    expect(sleepTimer.remaining).toBe(1740);

    setSleepTimerMinutes(45);
    expect(sleepTimer.remaining).toBe(2700); // 45 分钟重置
    expect(playbackSettings.sleepTimerMinutes).toBe(45);
    expect(playbackSettings.sleepTimerOn).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(sleepTimer.remaining).toBe(2640);
  });

  it("关开关：取消倒计时，不再到点暂停", () => {
    toggleSleepTimer();
    audio().play(); // 模拟正在播放
    expect(audio().paused).toBe(false);
    expect(state.isPlaying).toBe(true);

    cancelSleepTimer();
    expect(playbackSettings.sleepTimerOn).toBe(false);
    expect(sleepTimer.active).toBe(false);
    expect(sleepTimer.remaining).toBe(0);
    expect(sleepTimer.status).toBe("");
    expect(sleepTimerText.value).toBe("");

    vi.advanceTimersByTime(10 * 60_000);
    expect(audio().paused).toBe(false); // 已取消：不会到点暂停
  });

  it("到点：自动暂停播放并同步 state.isPlaying（与手动暂停一致）", () => {
    setSleepTimerMinutes(15);
    toggleSleepTimer();
    audio().play();
    expect(state.isPlaying).toBe(true);

    vi.advanceTimersByTime(15 * 60_000);
    expect(audio().paused).toBe(true);
    expect(state.isPlaying).toBe(false); // pause 事件同步
    expect(sleepTimer.active).toBe(false);
    expect(sleepTimer.remaining).toBe(0);
    expect(playbackSettings.sleepTimerOn).toBe(false);
    expect(sleepTimer.status).toBe("fired");
    expect(sleepTimerText.value).toBe("睡眠定时器已到点");
  });

  it("到点轻提示：6 秒后自动消失", () => {
    toggleSleepTimer();
    vi.advanceTimersByTime(30 * 60_000);
    expect(sleepTimer.status).toBe("fired");
    vi.advanceTimersByTime(6_000);
    expect(sleepTimer.status).toBe("");
    expect(sleepTimerText.value).toBe("");
  });

  it("手动暂停不重置倒计时（继续倒数）", () => {
    toggleSleepTimer(); // 30 分钟
    vi.advanceTimersByTime(60_000);
    expect(sleepTimer.remaining).toBe(1740);

    audio().play();
    audio().pause(); // 手动暂停
    expect(state.isPlaying).toBe(false);
    expect(sleepTimer.active).toBe(true);
    expect(sleepTimer.remaining).toBe(1740); // 未重置

    vi.advanceTimersByTime(60_000);
    expect(sleepTimer.remaining).toBe(1680); // 继续倒数
  });

  it("切歌不重置倒计时", async () => {
    state.songs = [{ path: "/b.mp3", name: "B" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    toggleSleepTimer();
    vi.advanceTimersByTime(30_000);
    expect(sleepTimer.remaining).toBe(1770);

    await selectSong(0); // 切歌
    expect(sleepTimer.active).toBe(true);
    expect(sleepTimer.remaining).toBe(1770); // 未重置
  });

  it("持久化：开关 + 时长写入 PLAYBACK_SETTINGS_KEY", async () => {
    setSleepTimerMinutes(60);
    toggleSleepTimer();
    await nextTick(); // 等待 deep watch 落盘
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.sleepTimerOn).toBe(true);
    expect(saved.sleepTimerMinutes).toBe(60);
  });

  it("持久化恢复：开关/时长恢复，倒计时不恢复（页面刷新即取消）", () => {
    lsStore[PLAYBACK_SETTINGS_KEY] = JSON.stringify({ sleepTimerOn: true, sleepTimerMinutes: 90 });
    _reloadPersisted(); // 模拟页面刷新后的模块加载
    expect(playbackSettings.sleepTimerOn).toBe(true);
    expect(playbackSettings.sleepTimerMinutes).toBe(90);
    expect(sleepTimer.active).toBe(false); // 倒计时不持久化
    expect(sleepTimer.remaining).toBe(0);
    expect(sleepTimerText.value).toBe("");
  });

  it("开关开但倒计时未运行（刷新后）：选时长即启动", () => {
    lsStore[PLAYBACK_SETTINGS_KEY] = JSON.stringify({ sleepTimerOn: true, sleepTimerMinutes: 30 });
    _reloadPersisted();
    expect(sleepTimer.active).toBe(false);
    setSleepTimerMinutes(15);
    expect(sleepTimer.active).toBe(true);
    expect(sleepTimer.remaining).toBe(900);
  });

  it("时长选项导出：15/30/45/60/90", () => {
    expect(SLEEP_TIMER_OPTIONS).toEqual([15, 30, 45, 60, 90]);
  });
});
