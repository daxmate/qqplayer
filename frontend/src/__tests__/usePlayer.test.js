// usePlayer composable 单元测试
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

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

// localStorage stub（vitest 默认 node 环境无 localStorage；usePlayer 模块加载时 try/catch 保护，测试体里需要显式提供）
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
  cycleSpeed,
  cyclePlayMode,
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
  lyricSettings,
  LYRIC_SETTINGS_KEY,
  _resetKaraokeAnchor,
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
} = await import("../composables/usePlayer.js");

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
  libraryPath: "",
  loading: false,
  error: "",
  volume: 1.0,
  muted: false,
  favorites: [],
};

beforeEach(() => {
  Object.assign(state, RESET);
  _resetKaraokeAnchor();
  _resetPlayMode();
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
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

describe("连播播放模式：随机 / 单曲循环", () => {
  const SONGS5 = [
    { path: "/a.mp3", name: "A" },
    { path: "/b.mp3", name: "B" },
    { path: "/c.mp3", name: "C" },
    { path: "/d.mp3", name: "D" },
    { path: "/e.mp3", name: "E" },
  ];
  const audio = () => FakeAudio.instances[0];

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
  }

  function fireEnded() {
    const a = audio();
    a.paused = false;
    a.listeners["ended"]();
    return a;
  }

  // Math.random 固定 0：leader=0 时 rest=[1,2,3,4] 洗牌后为 [2,3,4,1]
  // → 队列 [0,2,3,4,1]
  function stubRandom() {
    vi.spyOn(Math, "random").mockReturnValue(0);
  }

  it("cyclePlayMode：列表循环 → 随机 → 单曲循环 → 列表循环", () => {
    state.playMode = "order";
    cyclePlayMode();
    expect(state.playMode).toBe("shuffle");
    cyclePlayMode();
    expect(state.playMode).toBe("repeatOne");
    cyclePlayMode();
    expect(state.playMode).toBe("order");
  });

  it("单曲循环：播完重播本首（索引不变、从头播、继续播放）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    state.playMode = "repeatOne";
    const a = audio();
    a.currentTime = 120;
    fireEnded();
    expect(state.currentIndex).toBe(0);
    expect(a.currentTime).toBe(0);
    expect(a.paused).toBe(false);
  });

  it("单曲循环：手动下一首正常切歌（模式保持）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    state.playMode = "repeatOne";
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(state.playMode).toBe("repeatOne");
  });

  it("随机模式：手动下一首按洗牌队列推进", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await nextSong();
    expect(state.currentIndex).toBe(2);
    await nextSong();
    expect(state.currentIndex).toBe(3);
    await nextSong();
    expect(state.currentIndex).toBe(4);
    await nextSong();
    expect(state.currentIndex).toBe(1);
  });

  it("随机模式：播完自动随机下一首（不重复相邻）", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(2);
  });

  it("列表循环：播完自动切下一首并继续播放（连播 bug 回归）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 自动播放
  });

  it("随机模式：播完自动切下一首并继续播放（连播 bug 回归）", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(2);
    expect(a.paused).toBe(false); // 自动播放
  });

  it("列表循环：只有一首歌时播完重播本首（自动播放）", async () => {
    state.songs = [SONGS5[0]];
    stubFetch();
    await selectSong(0);
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(0);
    expect(a.currentTime).toBe(0);
    expect(a.paused).toBe(false);
  });

  it("selectSong 默认不自动播放（手动选歌由调用方决定是否播放）", async () => {
    state.songs = SONGS5;
    stubFetch();
    await selectSong(0);
    expect(audio().paused).toBe(true);
  });

  it("随机模式：一轮播完自动重新洗牌", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    // 队列 [0,2,3,4,1]：推进到队列末尾
    await nextSong(); // 2
    await nextSong(); // 3
    await nextSong(); // 4
    await nextSong(); // 1（队列末）
    // 再下一首 → 以 1 为队首重新洗牌：rest=[0,2,3,4] → 队列 [1,2,3,4,0] → 下一首 2
    await nextSong();
    expect(state.currentIndex).toBe(2);
  });

  it("随机模式：上一首按播放历史回退", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await nextSong(); // → 2，历史 [0]
    await nextSong(); // → 3，历史 [0,2]
    await prevSong();
    expect(state.currentIndex).toBe(2);
    await prevSong();
    expect(state.currentIndex).toBe(0);
  });

  it("随机模式：无历史时上一首按顺序回退", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await prevSong();
    expect(state.currentIndex).toBe(4);
  });

  it("随机模式：手动选歌同步队列位置，继续随机不乱序", async () => {
    state.songs = SONGS5;
    stubRandom();
    stubFetch();
    await selectSong(0);
    state.playMode = "shuffle";
    await nextSong(); // 2（pos 1）
    await selectSong(4); // 手动点 E：队列 [0,2,3,4,1] 中 pos 3
    await nextSong();
    expect(state.currentIndex).toBe(1); // 队列 pos 4
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

describe("音量", () => {
  it("setVolume 设置音量并持久化到 localStorage", () => {
    setVolume(0.5);
    expect(state.volume).toBe(0.5);
    expect(parseFloat(localStorage.getItem(VOLUME_KEY))).toBe(0.5);
  });

  it("setVolume 越界值被 clamp 到 0~1", () => {
    setVolume(1.5);
    expect(state.volume).toBe(1);
    setVolume(-1);
    expect(state.volume).toBe(0);
  });

  it("setVolume 自动取消静音", () => {
    state.muted = true;
    setVolume(0.3);
    expect(state.muted).toBe(false);
  });

  it("toggleMute 切换静音（音量值保留）", () => {
    setVolume(0.6);
    toggleMute();
    expect(state.muted).toBe(true);
    toggleMute();
    expect(state.muted).toBe(false);
    expect(state.volume).toBe(0.6);
  });
});

describe("收藏", () => {
  it("toggleFavorite：乐观更新 + POST 后端", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toContain("/a.mp3");
    expect(isFavorite("/a.mp3")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/favorites/toggle",
      expect.objectContaining({ method: "POST" }),
    );
    // 再点取消
    await toggleFavorite("/a.mp3");
    expect(state.favorites).not.toContain("/a.mp3");
  });

  it("toggleFavorite：后端失败时回滚", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toEqual([]);
    // 取消收藏失败也回滚
    state.favorites.push("/a.mp3");
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toContain("/a.mp3");
  });

  it("loadFavorites 拉取后端收藏列表", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ paths: ["/a.mp3", "/b.mp3"] }) })),
    );
    await loadFavorites();
    expect(state.favorites).toEqual(["/a.mp3", "/b.mp3"]);
  });
});

describe("removeFromQueue", () => {
  const SONGS = [
    { path: "/a.mp3", name: "A" },
    { path: "/b.mp3", name: "B" },
    { path: "/c.mp3", name: "C" },
  ];

  function stubFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
  }

  it("移除当前歌：切到原位置的新歌", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    stubFetch();
    removeFromQueue(1); // 移除 B
    expect(state.songs.map((s) => s.name)).toEqual(["A", "C"]);
    expect(state.currentIndex).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentSong.name).toBe("C");
  });

  it("移除最后一首：切到新的最后一首", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 2;
    stubFetch();
    removeFromQueue(2); // 移除 C
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B"]);
    expect(state.currentIndex).toBe(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentSong.name).toBe("B");
  });

  it("移除当前歌之前的歌：索引前移", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 2;
    state.currentSong = state.songs[2];
    stubFetch();
    removeFromQueue(0); // 移除 A（当前 C 之前）
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("C");
  });

  it("移除当前歌之后的歌：当前不变", async () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    state.currentSong = state.songs[1];
    removeFromQueue(2); // 移除 C（当前 B 之后）
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");
  });

  it("移除最后一首歌：清空播放器状态", () => {
    state.songs = [{ path: "/a.mp3", name: "A" }];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    removeFromQueue(0);
    expect(state.songs).toEqual([]);
    expect(state.currentIndex).toBe(-1);
    expect(state.currentSong).toBeNull();
    expect(state.isPlaying).toBe(false);
  });

  it("越界索引不动作", () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    removeFromQueue(5);
    expect(state.songs).toHaveLength(3);
  });
});

describe("键盘快捷键", () => {
  const audio = () => FakeAudio.instances[0];

  // 捕获 window keydown 监听器
  function captureHandler() {
    const addSpy = vi.spyOn(window, "addEventListener");
    setupKeyboardShortcuts();
    const call = addSpy.mock.calls.find((c) => c[0] === "keydown");
    return call ? call[1] : null;
  }

  function fire(handler, code, target = {}) {
    const ev = { code, target, preventDefault: vi.fn() };
    handler(ev);
    return ev;
  }

  it("空格切换播放/暂停", () => {
    const h = captureHandler();
    expect(h).toBeTruthy();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.paused = true;
    fire(h, "Space");
    expect(a.paused).toBe(false);
    fire(h, "Space");
    expect(a.paused).toBe(true);
  });

  it("←/→ 快退/快进 10 秒", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    a.currentTime = 30;
    a.duration = 100;
    fire(h, "ArrowLeft");
    expect(a.currentTime).toBe(20);
    fire(h, "ArrowRight");
    expect(a.currentTime).toBe(30);
  });

  it("← 在开头不越过 0", () => {
    const h = captureHandler();
    const a = audio();
    a.src = "/a.mp3";
    a.currentTime = 3;
    a.duration = 100;
    fire(h, "ArrowLeft");
    expect(a.currentTime).toBe(0);
  });

  it("↑/↓ 音量 ±10%", () => {
    const h = captureHandler();
    state.volume = 0.5;
    fire(h, "ArrowUp");
    expect(state.volume).toBe(0.6);
    fire(h, "ArrowDown");
    expect(state.volume).toBe(0.5);
  });

  it("输入框聚焦时不拦截按键", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.paused = true;
    const ev = fire(h, "Space", { tagName: "INPUT" });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(a.paused).toBe(true); // 没有触发播放
  });

  it("node 环境（无 window）安装安全返回", () => {
    const orig = globalThis.window;
    globalThis.window = undefined;
    try {
      const un = setupKeyboardShortcuts();
      expect(typeof un).toBe("function");
    } finally {
      globalThis.window = orig;
    }
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

describe("歌词显示设置（lyricSettings）", () => {
  it("默认值：20px / 左对齐 / 系统字体 / 全开 / 1/3 停靠", () => {
    expect(lyricSettings.fontSize).toBe(20);
    expect(lyricSettings.align).toBe("left");
    expect(lyricSettings.fontFamily).toBe("system");
    expect(lyricSettings.showRoma).toBe(true);
    expect(lyricSettings.showZh).toBe(true);
    expect(lyricSettings.showSec).toBe(true);
    expect(lyricSettings.focusPos).toBe(0.33);
    expect(lyricSettings.fadeMask).toBe(true);
    expect(lyricSettings.autoScroll).toBe(true);
  });

  it("修改后自动持久化到 localStorage", async () => {
    localStorage.removeItem(LYRIC_SETTINGS_KEY);
    lyricSettings.fontSize = 26;
    lyricSettings.align = "center";
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(LYRIC_SETTINGS_KEY));
    expect(saved.fontSize).toBe(26);
    expect(saved.align).toBe("center");
  });

  it("localStorage 已有配置时加载覆盖默认值，未保存项保持默认", async () => {
    localStorage.setItem(LYRIC_SETTINGS_KEY, JSON.stringify({ fontSize: 24, focusPos: 0.5 }));
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.lyricSettings.fontSize).toBe(24);
    expect(m.lyricSettings.focusPos).toBe(0.5);
    expect(m.lyricSettings.align).toBe("left"); // 未保存的保持默认
    expect(m.lyricSettings.fadeMask).toBe(true);
  });
});

// ============ MediaSession 系统媒体键 ============
// navigator.mediaSession stub：记录 setActionHandler 绑定的处理器与 metadata/playbackState
function createMediaSessionStub() {
  const handlers = {};
  const ms = {
    metadata: null,
    playbackState: "none",
    setActionHandler: vi.fn((action, fn) => {
      handlers[action] = fn;
    }),
    setPositionState: vi.fn(),
  };
  vi.stubGlobal("navigator", { ...navigator, mediaSession: ms });
  vi.stubGlobal(
    "MediaMetadata",
    class {
      constructor(opts) {
        Object.assign(this, opts);
      }
    },
  );
  return { ms, handlers };
}

// 触发全局 audio 的某个事件（如 play/pause/timeupdate）
function fireAudioEvent(name) {
  const a = FakeAudio.instances[0];
  if (a.listeners[name]) a.listeners[name]();
  return a;
}

describe("MediaSession 系统媒体键", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("安装时绑定全部媒体键处理器", () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    for (const action of [
      "play",
      "pause",
      "previoustrack",
      "nexttrack",
      "seekto",
      "seekbackward",
      "seekforward",
    ]) {
      expect(handlers[action]).toBeTypeOf("function");
    }
  });

  it("无 MediaSession 环境安全返回卸载函数", () => {
    const orig = globalThis.navigator;
    globalThis.navigator = undefined;
    try {
      const un = setupMediaSession();
      expect(typeof un).toBe("function");
    } finally {
      globalThis.navigator = orig;
    }
  });

  it("play/pause 媒体键切换播放状态", () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    state.currentSong = { path: "/a.mp3", name: "A" };
    const a = FakeAudio.instances[0];
    a.paused = true;
    handlers.play();
    expect(a.paused).toBe(false);
    handlers.pause();
    expect(a.paused).toBe(true);
  });

  it("previoustrack/nexttrack 切歌", async () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await handlers.nexttrack();
    expect(state.currentIndex).toBe(1);
    await handlers.previoustrack();
    expect(state.currentIndex).toBe(0);
  });

  it("seekto 跳到指定时间", () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    const a = FakeAudio.instances[0];
    a.src = "/a.mp3";
    a.currentTime = 30;
    a.duration = 100;
    handlers.seekto({ seekTime: 42 });
    expect(a.currentTime).toBe(42);
  });

  it("seekbackward/seekforward 默认 ±10s，可指定偏移", () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    const a = FakeAudio.instances[0];
    a.src = "/a.mp3";
    a.currentTime = 50;
    a.duration = 100;
    handlers.seekbackward({});
    expect(a.currentTime).toBe(40);
    handlers.seekforward({});
    expect(a.currentTime).toBe(50);
    handlers.seekforward({ seekOffset: 30 });
    expect(a.currentTime).toBe(80);
  });

  it("播放/暂停同步 playbackState", () => {
    const { ms } = createMediaSessionStub();
    setupMediaSession();
    const a = fireAudioEvent("play");
    expect(ms.playbackState).toBe("playing");
    expect(state.isPlaying).toBe(true);
    a.listeners["pause"]();
    expect(ms.playbackState).toBe("paused");
    expect(state.isPlaying).toBe(false);
  });

  it("timeupdate 同步 setPositionState（节流）", () => {
    const { ms } = createMediaSessionStub();
    setupMediaSession();
    const a = FakeAudio.instances[0];
    a.src = "/a.mp3";
    a.currentTime = 30;
    a.duration = 100;
    a.listeners["timeupdate"]();
    expect(ms.setPositionState).toHaveBeenCalledWith(
      expect.objectContaining({ duration: 100, position: 30 }),
    );
  });

  it("切歌时更新 metadata（歌名/歌手/封面）", async () => {
    const { ms } = createMediaSessionStub();
    setupMediaSession();
    state.songs = [
      {
        path: "/a.mp3",
        name: "A",
        artist: "ArtistX",
        album: "AlbumY",
      },
    ];
    // selectSong 会请求歌词：stub fetch 返回空
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await selectSong(0);
    expect(ms.metadata).toBeTruthy();
    expect(ms.metadata.title).toBe("A");
    expect(ms.metadata.artist).toBe("ArtistX");
    expect(ms.metadata.album).toBe("AlbumY");
    expect(ms.metadata.artwork[0].src).toContain("/api/cover?path=" + encodeURIComponent("/a.mp3"));
  });
});
