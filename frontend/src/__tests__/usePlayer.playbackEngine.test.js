// usePlayer composable 单元测试 — 播放引擎（跟唱自动停/单句循环/AB 循环/恢复播放/fadeSec/播放统计）
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import {
  state,
  stepSpeed,
  audioBare,
  nextSong,
  togglePlay,
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
  playbackSettings,
  restoreLastPlayed,
  saveLastPlayed,
  LAST_PLAYED_KEY,
  lastPlayedState,
  setupPlaybackFlush,
  playerMod,
  FakeAudio,
} from "./helpers/usePlayerHarness.js";

describe("跟唱模式自动停（锚点方案，bug 回归）", () => {
  const audio = () => FakeAudio.instances[0];
  // 无间隙：e == 下一句 s（在线获取的 LRC 场景，旧逻辑中间句全不停）
  const LRC_LYRIC = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 10, e: 20, text: ["第二句"] },
    { type: "line", s: 20, e: 30, text: ["第三句"] },
  ];
  // 有间隙（本地 SRT 场景）
  const SRT_LYRIC = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 12.5, e: 20, text: ["第二句"] },
    { type: "line", s: 25, e: 35, text: ["第三句"] },
  ];

  function fireTimeupdate(t) {
    const a = audio();
    a.currentTime = t;
    a.paused = false;
    a.listeners["timeupdate"]();
    return a;
  }

  function setup(on = true) {
    state.mode = "karaoke";
    state.karaokeOn = on;
    state.currentSong = { path: "/a.mp3" };
    audio().src = "/a.mp3";
  }

  it("playLine 后一句播完自动停（无间隙 LRC，核心回归）", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    expect(audio().paused).toBe(false);
    fireTimeupdate(5); // 句内
    expect(audio().paused).toBe(false);
    fireTimeupdate(10.5); // 越过 e=10（== 下一句 s）
    expect(audio().paused).toBe(true);
  });

  it("playLine 后一句播完自动停（有间隙 SRT）", () => {
    setup();
    state.lyric = SRT_LYRIC;
    playLine(1); // 第二句 s=12.5 e=20
    fireTimeupdate(18);
    expect(audio().paused).toBe(false);
    fireTimeupdate(20.5); // 越过 e=20，下一句 s=25
    expect(audio().paused).toBe(true);
  });

  it("最后一句播完后停", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(2);
    fireTimeupdate(30.5);
    expect(audio().paused).toBe(true);
  });

  it("句末回句首暂停后点播放 → 重播本句，播完再停", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 第一句结束自动停 → 回句首
    expect(audio().paused).toBe(true);
    expect(audio().currentTime).toBe(0);
    togglePlay(); // 用户继续 → 从句首重播本句
    expect(audio().paused).toBe(false);
    fireTimeupdate(5); // 句内不停
    expect(audio().paused).toBe(false);
    fireTimeupdate(10.5); // 再次到句末停
    expect(audio().paused).toBe(true);
  });

  it("seek 到后面某句 → 播到该句结束才停", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 停住
    seek(15); // 跳到第二句中间
    fireTimeupdate(15);
    expect(audio().paused).toBe(false);
    fireTimeupdate(20.5);
    expect(audio().paused).toBe(true);
  });

  it("前奏（第一句开始前）不提前停，进入第一句后锚定", () => {
    setup();
    state.lyric = [{ type: "line", s: 3, e: 10, text: ["第一句"] }];
    play(); // 从头播，t=0 处是前奏
    fireTimeupdate(1);
    expect(audio().paused).toBe(false);
    fireTimeupdate(3.5); // 进入第一句
    expect(audio().paused).toBe(false);
    fireTimeupdate(10.5); // 第一句结束
    expect(audio().paused).toBe(true);
  });

  it("句间间隙 currentLineIndex 保持上一句（高亮不丢失）", () => {
    state.lyric = SRT_LYRIC;
    state.currentTime = 11; // 上一句 e=10 已过，下一句 s=12.5 未到
    expect(currentLineIndex.value).toBe(0);
  });

  it("句末自动停后 currentLineIndex 保持刚唱完的句（不跳下一句，回归）", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 句末自动停，t=10.5 已越过下一句起点 s=10
    expect(audio().paused).toBe(true);
    expect(state.isPlaying).toBe(false);
    expect(currentLineIndex.value).toBe(0); // 高亮停在第一句，而不是跳到第二句
  });

  it("句末自动停后再次播放同句，高亮回到该句", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5);
    playLine(0); // 重唱第一句
    fireTimeupdate(5); // 第一句句内
    expect(currentLineIndex.value).toBe(0);
    expect(audio().paused).toBe(false);
  });

  it("跟唱连续播放（不暂停）时按时间定位推进", () => {
    setup(false); // karaokeOn=false → 播完不停，连续播放
    state.lyric = LRC_LYRIC;
    playLine(0);
    audio().listeners["play"](); // 模拟真实播放事件（FakeAudio.play 不触发）
    fireTimeupdate(15); // 已进入第二句
    expect(audio().paused).toBe(false);
    expect(currentLineIndex.value).toBe(1); // 高亮跟随第二句
  });

  it("跟唱开关关闭时不自动停", () => {
    setup(false);
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5);
    expect(audio().paused).toBe(false);
  });

  it("连播模式不自动停", () => {
    state.mode = "continuous";
    state.karaokeOn = true;
    state.currentSong = { path: "/a.mp3" };
    state.lyric = LRC_LYRIC;
    audio().src = "/a.mp3";
    playLine(0);
    fireTimeupdate(10.5);
    expect(audio().paused).toBe(false);
  });
});

describe("单句循环", () => {
  const audio = () => FakeAudio.instances[0];
  const LRC_LYRIC = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 10, e: 20, text: ["第二句"] },
  ];

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
    state.karaokeLoop = true;
    state.currentSong = { path: "/a.mp3" };
    audio().src = "/a.mp3";
  }

  it("toggleKaraokeLoop 开关", () => {
    state.karaokeLoop = false;
    toggleKaraokeLoop();
    expect(state.karaokeLoop).toBe(true);
    toggleKaraokeLoop();
    expect(state.karaokeLoop).toBe(false);
  });

  it("循环开启：句末不暂停，回到句首重播", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 越过 e=10
    expect(audio().paused).toBe(false); // 不停
    expect(audio().currentTime).toBe(0); // 回到句首
    expect(state.currentTime).toBe(0);
  });

  it("循环开启：反复越过句末都回到句首（持续循环）", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5);
    expect(audio().currentTime).toBe(0);
    fireTimeupdate(10.5); // 模拟再次播到句末
    expect(audio().currentTime).toBe(0);
    expect(audio().paused).toBe(false);
  });

  it("循环关闭：句末照旧暂停", () => {
    setup();
    state.karaokeLoop = false;
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5);
    expect(audio().paused).toBe(true);
  });

  it("循环关闭（默认）：句末回句首暂停（指针回到本句开始时间戳）", () => {
    setup();
    state.karaokeLoop = false;
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 越过 e=10
    expect(audio().paused).toBe(true);
    expect(audio().currentTime).toBe(0); // 回到本句句首，而非停在句尾/下一句起点
    expect(state.currentTime).toBe(0);
  });

  it("循环关闭：带歌词延迟偏移时回句首用校准后的音频时间", () => {
    setup();
    state.karaokeLoop = false;
    lyricSettings.offset = 2; // 歌词比声音延后 2s：句首音频时间 = s + 2
    state.lyric = LRC_LYRIC;
    playLine(0); // audio.currentTime = 2
    fireTimeupdate(12.5); // lyricTime = 10.5 越过 e=10
    expect(audio().paused).toBe(true);
    expect(audio().currentTime).toBe(2); // 回到校准后的本句句首
    lyricSettings.offset = 0;
  });

  it("跟唱开关关闭：循环不生效（不重播也不暂停）", () => {
    setup();
    state.karaokeOn = false;
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5);
    expect(audio().paused).toBe(false);
    expect(audio().currentTime).toBe(10.5); // 没跳回句首
  });

  it("循环中切下一句：循环跟随新句子", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 第一句循环中
    expect(audio().currentTime).toBe(0);
    nextLine(); // 切到第二句
    fireTimeupdate(10.5); // 越过第二句 e=20 之前（第二句内）
    expect(audio().paused).toBe(false);
    fireTimeupdate(20.5); // 第二句播完
    expect(audio().currentTime).toBe(10); // 回到第二句句首
    expect(audio().paused).toBe(false);
  });
});

describe("AB 循环", () => {
  const audio = () => FakeAudio.instances[0];
  const LYRIC = [
    { type: "line", s: 0, e: 10, text: ["一"] },
    { type: "line", s: 10, e: 20, text: ["二"] },
    { type: "line", s: 20, e: 30, text: ["三"] },
    { type: "line", s: 30, e: 40, text: ["四"] },
  ];

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

  it("enterAbLoop：当前句为起点等待终点，不影响当前播放", () => {
    setup();
    state.currentTime = 12; // 第二句内
    const before = audio().currentTime;
    enterAbLoop();
    expect(state.abLoop).toEqual({ a: 1, b: null });
    expect(audio().currentTime).toBe(before); // 播放位置不变
  });

  it("enterAbLoop：无当前句（前奏）忽略", () => {
    setup();
    state.lyric = [{ type: "line", s: 3, e: 10, text: ["第一句"] }];
    state.currentTime = 1; // 第一句开始前
    enterAbLoop();
    expect(state.abLoop).toBe(null);
  });

  it("enterAbLoop：已在 AB 循环中忽略", () => {
    setup();
    state.abLoop = { a: 0, b: 1 };
    enterAbLoop();
    expect(state.abLoop).toEqual({ a: 0, b: 1 });
  });

  it("setAbEnd：点终点后设定区间，不影响当前播放", () => {
    setup();
    state.abLoop = { a: 0, b: null };
    const before = audio().currentTime;
    setAbEnd(2);
    expect(state.abLoop).toEqual({ a: 0, b: 2 });
    expect(audio().currentTime).toBe(before); // 播放位置不变
  });

  it("setAbEnd：终点在起点前自动交换", () => {
    setup();
    state.abLoop = { a: 3, b: null };
    const before = audio().currentTime;
    setAbEnd(1);
    expect(state.abLoop).toEqual({ a: 1, b: 3 });
    expect(audio().currentTime).toBe(before); // 播放位置不变
  });

  it("setAbEnd：点起点本身忽略", () => {
    setup();
    state.abLoop = { a: 1, b: null };
    setAbEnd(1);
    expect(state.abLoop).toEqual({ a: 1, b: null });
  });

  it("setAbEnd：未进入 AB 时无效", () => {
    setup();
    setAbEnd(2);
    expect(state.abLoop).toBe(null);
  });

  it("等待终点：起点句播完自动回句首（起点单句循环）", () => {
    setup();
    state.abLoop = { a: 1, b: null };
    playLine(1);
    fireTimeupdate(20.5); // 越过第二句 e=20
    expect(audio().currentTime).toBe(10);
    expect(audio().paused).toBe(false);
  });

  it("区间中间句播完自动推进，不暂停", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    playLine(1);
    fireTimeupdate(20.5); // 第二句播完 → 推进第三句
    expect(audio().paused).toBe(false);
    expect(audio().currentTime).toBe(20.5); // 未跳回，继续播
    fireTimeupdate(30.5); // 第三句播完 → 推进第四句
    expect(audio().currentTime).toBe(30.5);
  });

  it("终点句播完跳回起点句首", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    playLine(1);
    fireTimeupdate(20.5); // 二 → 三
    fireTimeupdate(30.5); // 三 → 四
    fireTimeupdate(40.5); // 四（终点）播完 → 跳回第二句
    expect(audio().currentTime).toBe(10);
    expect(audio().paused).toBe(false);
  });

  it("反复循环：终点后回起点持续循环", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    playLine(1);
    fireTimeupdate(20.5);
    fireTimeupdate(30.5);
    fireTimeupdate(40.5); // 第一轮终点 → 回第二句
    expect(audio().currentTime).toBe(10);
    fireTimeupdate(20.5); // 第二轮第二句播完 → 推进
    expect(audio().currentTime).toBe(20.5);
    fireTimeupdate(40.5); // 第二轮终点 → 再回第二句
    expect(audio().currentTime).toBe(10);
    expect(audio().paused).toBe(false);
  });

  it("点击区间外（A 前）：退出 AB 并播放该句", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    clickLine(0);
    expect(state.abLoop).toBe(null);
    expect(audio().currentTime).toBe(0); // 第一句句首
    expect(audio().paused).toBe(false);
  });

  it("点击区间外（B 后）：退出 AB 并播放该句", () => {
    setup();
    state.abLoop = { a: 1, b: 2 };
    clickLine(3); // 第四句在区间外
    expect(state.abLoop).toBe(null);
    expect(audio().currentTime).toBe(30);
    expect(audio().paused).toBe(false);
  });

  it("点击区间内：跳到该句播放，区间不变", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    clickLine(2); // 第三句在区间内
    expect(state.abLoop).toEqual({ a: 1, b: 3 });
    expect(audio().currentTime).toBe(20);
    expect(audio().paused).toBe(false);
  });

  it("点击区间内终点句，播完仍跳回起点（循环继续）", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    clickLine(3); // 直接跳到终点句
    fireTimeupdate(40.5); // 终点句播完 → 跳回起点
    expect(state.abLoop).toEqual({ a: 1, b: 3 });
    expect(audio().currentTime).toBe(10);
    expect(audio().paused).toBe(false);
  });

  it("等选终点时点击：设为终点，不影响当前播放（路由）", () => {
    setup();
    state.abLoop = { a: 1, b: null };
    const before = audio().currentTime;
    clickLine(2);
    expect(state.abLoop).toEqual({ a: 1, b: 2 });
    expect(audio().currentTime).toBe(before); // 播放位置不变
  });

  it("无 AB 循环时点击：直接播放该句", () => {
    setup();
    clickLine(2);
    expect(state.abLoop).toBe(null);
    expect(audio().currentTime).toBe(20);
    expect(audio().paused).toBe(false);
  });

  it("exitAbLoop：单击退出恢复正常跟唱", () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    exitAbLoop();
    expect(state.abLoop).toBe(null);
    playLine(0);
    fireTimeupdate(10.5); // 无循环 → 正常暂停
    expect(audio().paused).toBe(true);
  });

  it("AB 循环优先于单句循环（单句循环开着也按区间推进）", () => {
    setup();
    state.karaokeLoop = true;
    state.abLoop = { a: 0, b: 2 };
    playLine(0);
    fireTimeupdate(10.5); // 起点句播完 → 推进，而不是回第一句
    expect(audio().currentTime).toBe(10.5);
    expect(audio().paused).toBe(false);
    fireTimeupdate(30.5); // 终点句播完 → 跳回起点
    expect(audio().currentTime).toBe(0);
  });

  it("selectSong 切歌重置 AB 循环", async () => {
    setup();
    state.abLoop = { a: 1, b: 3 };
    state.songs = [{ path: "/b.mp3", name: "B" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await selectSong(0);
    expect(state.abLoop).toBe(null);
  });
});

describe("恢复上次播放 restoreLastPlayed", () => {
  let saved;
  beforeEach(() => {
    saved = { ...playbackSettings };
    Object.assign(lastPlayedState, { path: null, position: 0, ts: 0 }); // 跨测试隔离
  });
  afterEach(() => {
    Object.assign(playbackSettings, saved);
  });

  it("歌曲在库中：恢复歌曲并 seek 到断点（数据源为统一层 lastPlayedState）", async () => {
    playbackSettings.resumeLast = true;
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    Object.assign(lastPlayedState, { path: "/b.mp3", position: 42, ts: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await restoreLastPlayed();
    expect(state.currentSong.path).toBe("/b.mp3");
    // 触发 loadedmetadata → seek 到断点
    const a = FakeAudio.instances[0];
    a.duration = 100;
    a.listeners["loadedmetadata"]();
    expect(a.currentTime).toBe(42);
    expect(state.currentTime).toBe(42);
  });

  it("进度超出歌曲时长：clamp 到末尾附近", async () => {
    playbackSettings.resumeLast = true;
    state.songs = [{ path: "/a.mp3", name: "A" }];
    Object.assign(lastPlayedState, { path: "/a.mp3", position: 999, ts: 1 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await restoreLastPlayed();
    const a = FakeAudio.instances[0];
    a.duration = 100;
    a.listeners["loadedmetadata"]();
    expect(a.currentTime).toBe(99.5);
  });

  it("歌曲已不在库中：不恢复（保持当前状态）", async () => {
    playbackSettings.resumeLast = true;
    state.songs = [{ path: "/a.mp3", name: "A" }];
    Object.assign(lastPlayedState, { path: "/gone.mp3", position: 10, ts: 1 });
    await restoreLastPlayed();
    expect(state.currentSong).toBeNull();
  });

  it("开关关闭时不恢复", async () => {
    playbackSettings.resumeLast = false;
    state.songs = [{ path: "/a.mp3", name: "A" }];
    Object.assign(lastPlayedState, { path: "/a.mp3", position: 10, ts: 1 });
    await restoreLastPlayed();
    expect(state.currentSong).toBeNull();
  });

  it("saveLastPlayed：记录当前歌曲与进度", () => {
    playbackSettings.resumeLast = true;
    state.currentSong = { path: "/a.mp3", name: "A" };
    const a = FakeAudio.instances[0];
    a._src = "/api/audio?path=/a.mp3";
    a.currentTime = 30;
    saveLastPlayed();
    const saved = JSON.parse(localStorage.getItem(LAST_PLAYED_KEY));
    expect(saved.path).toBe("/a.mp3");
    expect(saved.position).toBe(30);
  });
});

describe("切歌淡入淡出 fadeSec", () => {
  let saved;
  beforeEach(() => {
    vi.useRealTimers(); // 清理其他测试残留的 fake timers
    FakeAudio.instances[0].paused = true; // 重置 audio 播放状态（跨测试残留）
    FakeAudio.instances[0].volume = 1;
    saved = { ...playbackSettings };
  });
  afterEach(() => {
    Object.assign(playbackSettings, saved);
    vi.useRealTimers();
  });

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
  }

  it("fadeSec=0（默认）：切歌音量不变", async () => {
    playbackSettings.fadeSec = 0;
    state.volume = 0.8;
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    stubFetch();
    await selectSong(0);
    const a = FakeAudio.instances[0];
    a.volume = 0.8;
    await selectSong(1);
    expect(a.volume).toBe(0.8);
  });

  it("fadeSec>0 播放中切歌：先淡出到 0 再换源，自动播放时淡入回目标音量", async () => {
    vi.useFakeTimers();
    playbackSettings.fadeSec = 1;
    state.volume = 0.8;
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    stubFetch();
    await selectSong(0);
    const a = FakeAudio.instances[0];
    a.volume = 0.8;
    a.paused = false;
    const p = selectSong(1, { autoPlay: true, source: "auto" }); // 不 await：先跑淡出
    await vi.advanceTimersByTimeAsync(500); // 一半：音量应低于 0.8
    expect(a.volume).toBeLessThan(0.8);
    expect(a.volume).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1500); // 淡出完成（剩 500ms）→ 换源 → 淡入（1000ms）
    await p;
    expect(decodeURIComponent(a.src)).toContain("/b.mp3");
    expect(a.volume).toBe(0.8); // 淡入结束回到目标音量
  });

  it("淡出期间再次切歌：旧切歌放弃，新切歌接管", async () => {
    vi.useFakeTimers();
    playbackSettings.fadeSec = 1;
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
      { path: "/c.mp3", name: "C" },
    ];
    stubFetch();
    await selectSong(0);
    const a = FakeAudio.instances[0];
    a.volume = 0.8;
    a.paused = false;
    const p1 = selectSong(1); // 开始淡出中
    await vi.advanceTimersByTimeAsync(200);
    const p2 = selectSong(2); // 快速连切
    await vi.advanceTimersByTimeAsync(2000);
    await p1;
    await p2;
    expect(decodeURIComponent(a.src)).toContain("/c.mp3"); // 最终停在最后一次选择
  });
});

describe("播放统计", () => {
  const audio = () => FakeAudio.instances[0];

  // 捕获 fetch POST /api/playback 的调用
  function stubPlaybackFetch() {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        if (url === "/api/playback" && opts?.method === "POST") {
          calls.push(JSON.parse(opts.body));
        }
        return { ok: true, json: async () => ({}) };
      }),
    );
    return calls;
  }

  // 模拟开始播放一首歌：先 selectSong 再触发 play 事件（Date.now 受控）
  async function startPlaying(path = "/a.mp3", name = "A") {
    state.songs = [{ path, name, artist: "X", album: "Y" }];
    await selectSong(0);
    const a = audio();
    a.duration = 200;
    state.duration = 200;
    a.listeners["play"](); // 触发 play 事件 → 建会话
    return a;
  }

  it("播放后暂停 → 上报一条记录（含细节字段）", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying();
    vi.setSystemTime(new Date("2026-08-12T12:00:30Z")); // 播了 30s
    const a = audio();
    a.listeners["pause"]();
    vi.useRealTimers();

    expect(calls.length).toBe(1);
    const rec = calls[0];
    expect(rec.path).toBe("/a.mp3");
    expect(rec.name).toBe("A");
    expect(rec.artist).toBe("X");
    expect(rec.album).toBe("Y");
    expect(rec.played).toBe(30);
    expect(rec.duration).toBe(200);
    expect(rec.ratio).toBe(0.15);
    expect(rec.completed).toBe(false);
    expect(rec.source).toBe("manual");
    expect(rec.mode).toBe("continuous");
    expect(rec.device).toBe("mac");
    expect(rec.ts).toBeTruthy();
  });

  it("播放不足 3 秒 → 不上报（误触）", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying();
    vi.setSystemTime(new Date("2026-08-12T12:00:02Z")); // 2s
    const a = audio();
    a.listeners["pause"]();
    vi.useRealTimers();
    expect(calls.length).toBe(0);
  });

  it("自然播完（ended）→ completed=true 上报", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying();
    vi.setSystemTime(new Date("2026-08-12T12:03:20Z")); // 200s = 完整播完
    const a = audio();
    a.ended = true;
    a.listeners["ended"]();
    vi.useRealTimers();

    expect(calls.length).toBe(1);
    expect(calls[0].completed).toBe(true);
    expect(calls[0].ratio).toBe(1);
  });

  it("切歌 → 上报旧歌会话；新歌播放再建新会话", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying("/a.mp3", "A");
    vi.setSystemTime(new Date("2026-08-12T12:00:20Z"));
    // 切到 B（手动选歌 source=manual）
    state.songs = [
      { path: "/a.mp3", name: "A", artist: "X", album: "Y" },
      { path: "/b.mp3", name: "B", artist: "X", album: "Y" },
    ];
    await selectSong(1); // selectSong 内部 flush 旧会话
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/a.mp3");
    expect(calls[0].played).toBe(20);

    // 播放 B → 建新会话
    const a = audio();
    a.duration = 100;
    state.duration = 100;
    a.listeners["play"]();
    vi.setSystemTime(new Date("2026-08-12T12:00:50Z")); // 播了 30s
    a.listeners["pause"]();
    vi.useRealTimers();
    expect(calls.length).toBe(2);
    expect(calls[1].path).toBe("/b.mp3");
    expect(calls[1].played).toBe(30);
  });

  it("媒体键切歌 → source=media；自动切歌 → source=auto", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying("/a.mp3", "A");
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    vi.setSystemTime(new Date("2026-08-12T12:00:10Z"));
    await nextSong({ autoPlay: true, source: "media" }); // 媒体键切歌
    // 切歌上报的是旧歌 A 的会话（手动选的 → manual）
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/a.mp3");
    expect(calls[0].source).toBe("manual");

    // 播 B，模拟播完自动切歌
    const a = audio();
    a.duration = 100;
    state.duration = 100;
    a.listeners["play"]();
    vi.setSystemTime(new Date("2026-08-12T12:01:50Z")); // 播 100s
    a.ended = true;
    a.listeners["ended"]();
    expect(calls.length).toBe(2);
    expect(calls[1].path).toBe("/b.mp3");
    expect(calls[1].completed).toBe(true);
    expect(calls[1].source).toBe("media"); // B 由媒体键选中 → source=media
    vi.useRealTimers();
  });

  it("页面关闭（pagehide）→ sendBeacon 兜底上报", async () => {
    const beacon = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, sendBeacon: beacon });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying();
    vi.setSystemTime(new Date("2026-08-12T12:00:15Z"));

    // 捕获 pagehide 监听
    const addSpy = vi.spyOn(window, "addEventListener");
    const un = setupPlaybackFlush();
    const call = addSpy.mock.calls.find((c) => c[0] === "pagehide");
    call[1](); // 触发
    vi.useRealTimers();

    expect(beacon).toHaveBeenCalledTimes(1);
    const [url, blob] = beacon.mock.calls[0];
    expect(url).toBe("/api/playback");
    const text = await blob.text();
    const rec = JSON.parse(text);
    expect(rec.path).toBe("/a.mp3");
    expect(rec.played).toBe(15);
    un();
  });

  it("跟唱模式句间暂停不上报，播完/切模式才上报", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying();
    state.mode = "karaoke"; // 切到跟唱模式
    await nextTick(); // 让 mode watch 生效（flush 旧会话，played=0 不上报）
    const a = audio();
    a.duration = 300;
    state.duration = 300;
    a.listeners["play"](); // 重新建会话（karaoke 模式）
    vi.setSystemTime(new Date("2026-08-12T12:00:05Z"));
    a.listeners["pause"](); // 句间暂停 → 不上报
    vi.setSystemTime(new Date("2026-08-12T12:00:10Z"));
    a.listeners["play"](); // 下一句
    vi.setSystemTime(new Date("2026-08-12T12:00:15Z"));
    state.mode = "continuous"; // 切回连播 → 上报整段
    await nextTick();
    vi.useRealTimers();

    expect(calls.length).toBe(1);
    expect(calls[0].played).toBe(15); // 5+10s 累计（从 karaoke play 到切模式）
  });

  it("变速切换不打断播放会话（pause 被 swappingAudio 抑制，无断裂记录）", async () => {
    const calls = stubPlaybackFetch();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    await startPlaying();
    vi.setSystemTime(new Date("2026-08-12T12:00:30Z")); // 播了 30s
    state.speed = 1.0;
    stepSpeed(-1); // 0.75：swap 触发 pause（audioEq）+ play（audioBare）
    expect(playerMod.audio).toBe(audioBare);
    expect(calls.length).toBe(0); // 变速 pause 被抑制：无断裂播放记录
    stepSpeed(1); // 回 1.0：再切一次
    expect(calls.length).toBe(0);
    // 真实暂停（非变速）才上报
    playerMod.audio.listeners["pause"]();
    expect(calls.length).toBe(1);
    expect(calls[0].path).toBe("/a.mp3");
    expect(calls[0].played).toBe(30);
    vi.useRealTimers();
  });
});
