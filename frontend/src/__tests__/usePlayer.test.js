// usePlayer composable 单元测试
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const {
  state,
  cycleSpeed,
  nextSong,
  prevSong,
  togglePlay,
  toggleKaraoke,
  toggleZh,
  loadSongs,
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
  _resetKaraokeAnchor,
} = await import("../composables/usePlayer.js");

const RESET = {
  songs: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  mode: "continuous",
  karaokeOn: true,
  karaokeLoop: false,
  abLoop: null,
  speed: 1.0,
  zhVisible: true,
  lyric: [],
  lyricFormat: null,
  libraryPath: "",
  loading: false,
  error: "",
};

beforeEach(() => {
  Object.assign(state, RESET);
  _resetKaraokeAnchor();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cycleSpeed", () => {
  it("在 0.75 → 1.0 → 1.25 间循环", () => {
    state.speed = 1.0;
    cycleSpeed();
    expect(state.speed).toBe(1.25);
    cycleSpeed();
    expect(state.speed).toBe(0.75);
    cycleSpeed();
    expect(state.speed).toBe(1.0);
  });
});

describe("nextSong / prevSong", () => {
  it("环绕播放：末尾 next 回到第一首", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 1;
    await nextSong();
    expect(state.currentIndex).toBe(0);
  });

  it("环绕播放：开头 prev 到最后一首", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await prevSong();
    expect(state.currentIndex).toBe(1);
  });
});

describe("开关切换", () => {
  it("toggleKaraoke / toggleZh", () => {
    state.karaokeOn = true;
    toggleKaraoke();
    expect(state.karaokeOn).toBe(false);

    state.zhVisible = true;
    toggleZh();
    expect(state.zhVisible).toBe(false);
  });
});

describe("loadSongs", () => {
  it("拉取歌曲列表并自动选中第一首", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url) => ({
        ok: true,
        json: async () => [
          { path: "/a.mp3", name: "A" },
          { path: "/b.mp3", name: "B" },
        ],
      })),
    );
    await loadSongs();
    expect(state.songs).toHaveLength(2);
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong.path).toBe("/a.mp3");
    expect(fetch).toHaveBeenCalledWith("/api/songs", expect.anything());
  });

  it("加载失败时设置 error 而不是抛异常", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await loadSongs();
    expect(state.error).toContain("加载歌曲列表失败");
    expect(state.loading).toBe(false);
  });
});

describe("selectSong", () => {
  it("越界 index 不动作", async () => {
    state.songs = [{ path: "/a.mp3" }];
    await selectSong(5);
    expect(state.currentSong).toBeNull();
  });
});

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

  it("句末暂停后点播放 → 锚定下一句继续，不立刻停", () => {
    setup();
    state.lyric = LRC_LYRIC;
    playLine(0);
    fireTimeupdate(10.5); // 第一句结束自动停
    expect(audio().paused).toBe(true);
    togglePlay(); // 用户继续 → 应从 10.5 锚定第二句
    expect(audio().paused).toBe(false);
    fireTimeupdate(15); // 第二句内不停
    expect(audio().paused).toBe(false);
    fireTimeupdate(20.5); // 第二句结束停
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

  it("enterAbLoop：当前句为起点等待终点，并播放起点", () => {
    setup();
    state.currentTime = 12; // 第二句内
    enterAbLoop();
    expect(state.abLoop).toEqual({ a: 1, b: null });
    expect(audio().currentTime).toBe(10);
    expect(audio().paused).toBe(false);
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

  it("setAbEnd：点终点后从区间起点开始播放", () => {
    setup();
    state.abLoop = { a: 0, b: null };
    setAbEnd(2);
    expect(state.abLoop).toEqual({ a: 0, b: 2 });
    expect(audio().currentTime).toBe(0);
    expect(audio().paused).toBe(false);
  });

  it("setAbEnd：终点在起点前自动交换", () => {
    setup();
    state.abLoop = { a: 3, b: null };
    setAbEnd(1);
    expect(state.abLoop).toEqual({ a: 1, b: 3 });
    expect(audio().currentTime).toBe(10); // 新起点（第二句）句首
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

  it("等选终点时点击：设为终点并播起点（路由）", () => {
    setup();
    state.abLoop = { a: 1, b: null };
    clickLine(2);
    expect(state.abLoop).toEqual({ a: 1, b: 2 });
    expect(audio().currentTime).toBe(10); // 从区间起点开始播
    expect(audio().paused).toBe(false);
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
