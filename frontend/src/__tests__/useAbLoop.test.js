// useAbLoop composable 单元测试（AB 区间可视化依赖设置在 playerCore，循环计数逻辑在 useAbLoop）
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub（useAbLoop → playerCore 模块加载时 try/catch 保护；测试体里显式提供）
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

const {
  state,
  playbackSettings,
  selectSong,
  _resetPlayMode,
  startKaraokeTicker,
  stopKaraokeTicker,
} = await import("../composables/playerCore.js");
const { playLine, _resetKaraokeAnchor, _resetKaraokeJump, karaokeState } =
  await import("../composables/useLyric.js");
const { enterAbLoop, setAbEnd, exitAbLoop, clickLine, _getAbLoopCount, resetAbLoopCount } =
  await import("../composables/useAbLoop.js");

const LYRIC = [
  { type: "line", s: 0, e: 10, text: ["一"] },
  { type: "line", s: 10, e: 20, text: ["二"] },
  { type: "line", s: 20, e: 30, text: ["三"] },
  { type: "line", s: 30, e: 40, text: ["四"] },
];

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
};

beforeEach(() => {
  Object.assign(state, RESET);
  playbackSettings.abLoopCountOn = true;
  playbackSettings.abLoopMaxCount = 10;
  playbackSettings.abVisual = true;
  _resetKaraokeAnchor();
  _resetKaraokeJump();
  _resetPlayMode();
  resetAbLoopCount();
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("AB 循环计数（防走开安全阀）", () => {
  const audio = () => FakeAudio.instances[0];

  function fireTimeupdate(t) {
    const a = audio();
    a.currentTime = t;
    a.paused = false;
    a.listeners["timeupdate"]();
    return a;
  }

  function setup() {
    state.mode = "karaoke";
    state.karaokeOn = true;
    state.karaokeLoop = false;
    state.currentSong = { path: "/a.mp3" };
    audio().src = "/a.mp3";
    state.lyric = LYRIC;
  }

  // 完整跑一遍区间 a→b：起点句播完逐句推进到终点句，终点句播完触发 B 完成
  function completeRound(a, b) {
    playLine(a);
    fireTimeupdate(LYRIC[b].s + 0.5); // 起点 → 逐句推进到终点句（while 跨句推进）
    fireTimeupdate(LYRIC[b].e + 0.5); // 终点句播完 → B 完成
  }

  it("计数递增：B 句播完 +1，未满 N 不暂停（跳回 A 句首继续）", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    expect(audio().paused).toBe(false);
    expect(audio().currentTime).toBe(10); // 跳回 A 句首
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(2);
    expect(audio().paused).toBe(false);
  });

  it("满 N 遍：暂停在 A 句首，区间保持", () => {
    setup();
    playbackSettings.abLoopMaxCount = 2;
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3); // 第 1 遍 → 继续
    expect(audio().paused).toBe(false);
    completeRound(1, 3); // 第 2 遍 = 满 N → 暂停
    expect(_getAbLoopCount()).toBe(2);
    expect(audio().paused).toBe(true);
    expect(audio().currentTime).toBe(10); // 停在 A 句首
    expect(state.abLoop).toEqual({ a: 1, b: 3 }); // 区间保持，可继续练习
  });

  it("满 N 暂停后再播放：下一次 B 完成 = 新一轮第 1 遍", () => {
    setup();
    playbackSettings.abLoopMaxCount = 2;
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    completeRound(1, 3); // 满 N 暂停
    expect(audio().paused).toBe(true);
    // 用户再次播放：从 A 句首继续，跑完一轮 → 计为新一轮第 1 遍，不立刻再停
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    expect(audio().paused).toBe(false);
    completeRound(1, 3); // 新一轮第 2 遍 = 满 N → 再暂停
    expect(audio().paused).toBe(true);
    expect(audio().currentTime).toBe(10);
  });

  it("exitAbLoop 退出：计数清零", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    exitAbLoop();
    expect(_getAbLoopCount()).toBe(0);
    expect(state.abLoop).toBe(null);
  });

  it("点击区间外退出 AB：计数清零（clickLine 统一走 exitAbLoop）", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    clickLine(0); // 区间外（A 前）→ 退出 AB + 播放该句
    expect(state.abLoop).toBe(null);
    expect(_getAbLoopCount()).toBe(0);
    expect(audio().currentTime).toBe(0);
    expect(audio().paused).toBe(false);
  });

  it("setAbEnd 重设区间：计数清零", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    setAbEnd(0); // 重设区间（终点在起点前 → 自动交换为 {a:0,b:1}）
    expect(state.abLoop).toEqual({ a: 0, b: 1 });
    expect(_getAbLoopCount()).toBe(0);
  });

  it("selectSong 切歌：计数清零（AB 区间一并重置）", async () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    state.songs = [{ path: "/b.mp3", name: "B" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await selectSong(0);
    expect(state.abLoop).toBe(null);
    expect(_getAbLoopCount()).toBe(0);
  });

  it("等选终点（b=null）：起点句循环不计数", () => {
    setup();
    state.abLoop = { a: 1, b: null };
    playLine(1);
    fireTimeupdate(20.5); // 起点句播完 → 回句首
    expect(audio().paused).toBe(false);
    expect(audio().currentTime).toBe(10);
    fireTimeupdate(20.5); // 再循环一次
    expect(_getAbLoopCount()).toBe(0); // b 未定：不算一遍
  });

  it("开关关闭：行为不变（无限循环，计数保持 0）", () => {
    setup();
    playbackSettings.abLoopCountOn = false;
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    completeRound(1, 3);
    completeRound(1, 3);
    expect(audio().paused).toBe(false);
    expect(audio().currentTime).toBe(10);
    expect(_getAbLoopCount()).toBe(0);
  });

  it("次数越界钳制：0 → 1（一遍就停）；非法值 → 回落默认 10", () => {
    setup();
    playbackSettings.abLoopMaxCount = 0;
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(audio().paused).toBe(true); // 钳制为 1：一遍即停
    expect(audio().currentTime).toBe(10);
    // 非法值（持久化脏数据）
    playbackSettings.abLoopMaxCount = "abc";
    playbackSettings.abLoopCountOn = true;
    state.abLoop = { a: 1, b: 3 };
    resetAbLoopCount();
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    expect(audio().paused).toBe(false); // 10 遍才停：1 遍不停
  });

  it("重设区间后再跑：计数从 0 开始", () => {
    setup();
    playbackSettings.abLoopMaxCount = 3;
    state.abLoop = { a: 1, b: 3 };
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
    exitAbLoop();
    enterAbLoop(); // 重新进入：新起点
    expect(state.abLoop).toEqual({ a: 1, b: null });
    setAbEnd(3);
    expect(state.abLoop).toEqual({ a: 1, b: 3 });
    expect(_getAbLoopCount()).toBe(0); // 进入 + 设终点均已清零
    completeRound(1, 3);
    expect(_getAbLoopCount()).toBe(1);
  });
});

describe("跟唱句末高频检测（变速精度，2026-08-19）", () => {
  const audio = () => FakeAudio.instances[0];

  function startKaraoke() {
    const a = audio();
    state.mode = "karaoke";
    state.karaokeOn = true;
    state.karaokeLoop = false;
    state.currentSong = { path: "/a.mp3" };
    a.src = "/a.mp3";
    state.lyric = LYRIC;
    karaokeState.line = 0; // 已锚定第 0 句
    return a;
  }

  it("播放中 50ms 轮询触发句末判定：越过截止时间戳即回句首暂停", () => {
    vi.useFakeTimers();
    const a = startKaraoke();
    a.currentTime = LYRIC[0].e + 0.5; // 越过截止时间戳（变速下 timeupdate 太粗，靠轮询兜住）
    startKaraokeTicker();
    vi.advanceTimersByTime(50);
    expect(a.currentTime).toBe(LYRIC[0].s); // 回句首
    expect(a.paused).toBe(true); // 句末暂停
    stopKaraokeTicker();
  });

  it("停止轮询后不再处理句末", () => {
    vi.useFakeTimers();
    const a = startKaraoke();
    a.currentTime = LYRIC[0].e + 0.5;
    startKaraokeTicker();
    vi.advanceTimersByTime(50);
    expect(a.currentTime).toBe(LYRIC[0].s); // 第一次触发已处理
    stopKaraokeTicker();
    a.currentTime = LYRIC[1].e + 0.5; // 再越过一句
    vi.advanceTimersByTime(200);
    expect(a.currentTime).toBe(LYRIC[1].e + 0.5); // 不再跳转
  });

  it("非跟唱模式：轮询空转不处理", () => {
    vi.useFakeTimers();
    const a = audio();
    state.mode = "continuous";
    state.karaokeOn = true;
    state.currentSong = { path: "/a.mp3" };
    a.src = "/a.mp3";
    state.lyric = LYRIC;
    karaokeState.line = 0;
    a.currentTime = LYRIC[0].e + 0.5;
    startKaraokeTicker();
    vi.advanceTimersByTime(100);
    expect(a.currentTime).toBe(LYRIC[0].e + 0.5); // 不处理
    stopKaraokeTicker();
  });
});
