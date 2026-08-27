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
  stepSpeed,
  audioEq,
  audioBare,
  cyclePlayMode,
  nextSong,
  prevSong,
  togglePlay,
  toggleKaraoke,
  toggleZh,
  loadSongs,
  findSongIndex,
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
  uiSettings,
  UI_SETTINGS_KEY,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  PLAYBACK_SETTINGS_DEFAULTS,
  SHORTCUTS,
  SHORTCUT_CATEGORIES,
  fmtShortcutKey,
  parseShortcutCombo,
  restoreLastPlayed,
  saveLastPlayed,
  LAST_PLAYED_KEY,
  lastPlayedState,
  _resetKaraokeAnchor,
  _resetKaraokeJump,
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
  setupPlaybackFlush,
  setupAutoRefresh,
  stopAutoRefresh,
  setupPlayerActions,
  stopPlayerActions,
  setupMiniStatus,
  stopMiniStatus,
  refreshMiniStatus,
  miniRunning,
  EQ_PRESETS,
  EQ_BANDS,
  setEqPreset,
  setEqGain,
  _resetEqGraph,
  loadLibrarySettings,
  saveLibrarySettings,
  _resetPlaybackSession,
  reorderQueue,
  persistQueueOrder,
  loadQueueOrder,
  _resetQueueOrder,
} = await import("../composables/usePlayer.js");

// 模块对象（live binding：playerMod.audio 每次读当前活动元素，跨变速切换）
const playerMod = await import("../composables/usePlayer.js");

import { getPendingOps } from "../utils/cacheDb.js";
import { invalidate } from "../utils/apiClient.js";

const {
  loadPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  setPlaylistOrder,
  isInPlaylist,
} = await import("../composables/usePlayer.js");
const { toggleMusicLib, togglePlaylist, uiState, UI_STATE_KEY } =
  await import("../composables/usePlayer.js");
const { toggleControls } = await import("../composables/usePlayer.js");
const { loadLyric } = await import("../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

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
  libraryPath: "",
  librarySettings: null,
  loading: false,
  error: "",
  volume: 1.0,
  muted: false,
  favorites: [],
  playlists: [],
  activePlaylistId: null,
  libraryVersion: null,
  lastSource: "manual",
};

beforeEach(() => {
  _resetEqGraph(); // 重置音频图 + 活动元素回 audioEq（防变速用例把 audio 切到 audioBare 泄漏）
  Object.assign(state, RESET);
  // RESET 里的数组字段是模块级共享引用（旧用例可能 push 过），换成新数组防跨用例残留
  state.songs = [];
  state.lyric = [];
  state.favorites = [];
  state.playlists = [];
  // 快捷键配置表默认值复位（含 karaokeNextKey/PrevKey/searchKey，防用例间录制值残留）
  for (const s of SHORTCUTS) {
    playbackSettings[s.settingKey] = s.defaultCode;
  }
  _resetKaraokeAnchor();
  _resetKaraokeJump();
  _resetPlayMode();
  _resetPlaybackSession();
  _resetQueueOrder();
  // UI 开关（uiState 独立模块，RESET 不再覆盖；此处显式复位防用例间残留）
  Object.assign(uiState, {
    musicLibOpen: true,
    playlistOpen: true,
    controlsHidden: false,
    specLyricOpen: false,
  });
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

  it("播放中切歌：继续自动播放（autoPlay 跟随播放状态）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = false; // 播放中
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 切歌后自动播放
  });

  it("暂停中切歌：保持暂停（不自动播放）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true; // 主动暂停
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(true); // 保持暂停
  });

  it("跟唱模式切歌：自动退出跟唱（回音乐模式）并自动播放（句末暂停不阻止）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.mode = "karaoke";
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true; // 跟唱句末自动暂停状态
    await nextSong();
    expect(state.currentIndex).toBe(1);
    expect(state.mode).toBe("continuous"); // 自动退出跟唱
    expect(a.paused).toBe(false); // 切歌后自动播放
  });

  it("跟唱模式 prev：同样自动退出跟唱并自动播放", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 1;
    state.mode = "karaoke";
    await selectSong(1, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true;
    await prevSong();
    expect(state.currentIndex).toBe(0);
    expect(state.mode).toBe("continuous");
    expect(a.paused).toBe(false);
  });

  it("跟唱模式切歌：显式 autoPlay=false 仍尊重（不自动播放）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.mode = "karaoke";
    await selectSong(0, { autoPlay: true });
    const a = FakeAudio.instances[0];
    a.paused = true;
    await nextSong({ autoPlay: false });
    expect(state.currentIndex).toBe(1);
    expect(state.mode).toBe("continuous"); // 跟唱照样退出
    expect(a.paused).toBe(true); // 显式不播
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

  it("图书模式（books）：播完同样自动切下一首（读书放背景音乐不中断）", async () => {
    state.songs = SONGS5;
    stubFetch();
    state.mode = "books";
    await selectSong(0);
    const a = audio();
    a.currentTime = 100;
    fireEnded();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 自动播放
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

  it("toggleFavorite：网络失败 → 本地保留 + 进 dirty 队列（本地优先，离线语义）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toEqual(["/a.mp3"]); // 不回滚：离线本地先写
    const ops = await getPendingOps();
    expect(ops.some((o) => o.op.url === "/api/favorites/toggle" && o.op.method === "POST")).toBe(
      true,
    );
    // 取消收藏网络失败也保留
    await toggleFavorite("/a.mp3");
    expect(state.favorites).toEqual([]);
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

describe("removeFromQueue 撤销（toast + 原位恢复）", () => {
  const SONGS = [
    { path: "/a.mp3", name: "A" },
    { path: "/b.mp3", name: "B" },
    { path: "/c.mp3", name: "C" },
    { path: "/d.mp3", name: "D" },
  ];

  beforeEach(() => clearToasts());
  afterEach(() => clearToasts());

  it("移除后 toast 出现（带撤销 action、5s 窗口）；点撤销 → 歌曲回到原位", () => {
    state.songs = [...SONGS];
    state.currentIndex = 1;
    removeFromQueue(1); // 移除 B（当前歌）→ 切到 C
    expect(state.songs.map((s) => s.name)).toEqual(["A", "C", "D"]);
    expect(state.currentIndex).toBe(1);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("B");
    expect(items[0].duration).toBe(5000);
    expect(items[0].action.label).toBe("撤销");
    items[0].action.onClick();
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C", "D"]);
    expect(state.currentIndex).toBe(2); // C 仍是当前歌（索引顺延）
  });

  it("多首依次移除：各自独立 toast、各自原位撤销", () => {
    state.songs = [...SONGS];
    state.currentIndex = 0;
    removeFromQueue(1); // 移除 B → [A,C,D]
    removeFromQueue(2); // 移除 D → [A,C]
    const { items } = useToast();
    expect(items).toHaveLength(2);
    items[1].action.onClick(); // 撤销 D（原 index 2）→ [A,C,D]
    expect(state.songs.map((s) => s.name)).toEqual(["A", "C", "D"]);
    items[0].action.onClick(); // 撤销 B（原 index 1）→ [A,B,C,D]
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("原 index 越界（期间又移除其他歌）→ clamp 到末尾，不丢歌", () => {
    state.songs = [...SONGS];
    state.currentIndex = 3;
    removeFromQueue(3); // 移除 D → [A,B,C]
    removeFromQueue(1); // 移除 B → [A,C]
    const { items } = useToast();
    items[1].action.onClick(); // 撤销 B（index 1）→ [A,B,C]
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C"]);
    items[0].action.onClick(); // 撤销 D（原 index 3 越界）→ clamp 到末尾
    expect(state.songs.map((s) => s.name)).toEqual(["A", "B", "C", "D"]);
  });

  it("撤销成功后弹出「已恢复」提示", () => {
    state.songs = [...SONGS];
    state.currentIndex = 0;
    removeFromQueue(0);
    const { items } = useToast();
    items[0].action.onClick();
    const after = useToast().items;
    expect(after).toHaveLength(2); // 移除 toast + 已恢复 toast
    expect(after[1].text).toContain("已恢复");
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

  // 跟唱句跳转（默认 N 下一句 / P 上一句，仅跟唱模式生效，键位可配置）
  const K_LRC = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 10, e: 20, text: ["第二句"] },
  ];

  it("跟唱模式：N 下一句 / P 上一句（跳句首并播放）", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    fire(h, "KeyN");
    expect(a.currentTime).toBe(10); // 下一句句首
    expect(a.paused).toBe(false);
    fire(h, "KeyP");
    expect(a.currentTime).toBe(0); // 上一句句首
    expect(a.paused).toBe(false);
  });

  it("跟唱快捷键可配置：改键后新键生效、旧键失效", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playbackSettings.karaokeNextKey = "KeyJ";
    playLine(0);
    fire(h, "KeyN"); // 旧键不再生效
    expect(a.currentTime).toBe(0);
    fire(h, "KeyJ"); // 新键生效
    expect(a.currentTime).toBe(10);
  });

  it("连播模式：N/P 不生效", () => {
    const h = captureHandler();
    state.mode = "continuous";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    fire(h, "KeyN");
    expect(a.currentTime).toBe(0); // 没有跳句
  });

  it("边界：第一句按 P、最后一句按 N 不动作", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    fire(h, "KeyP"); // 第一句：无上一句
    expect(a.currentTime).toBe(0);
    nextLine(); // 跳到第二句（最后一句）
    fire(h, "KeyN"); // 最后一句：无下一句
    expect(a.currentTime).toBe(10);
  });

  it("输入框聚焦时 N/P 不拦截（可正常打字）", () => {
    const h = captureHandler();
    state.mode = "karaoke";
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.src = "/a.mp3";
    state.lyric = K_LRC;
    playLine(0);
    const ev = fire(h, "KeyN", { tagName: "INPUT" });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(a.currentTime).toBe(0);
  });
});

describe("快捷键配置表（任务 G）", () => {
  const audio = () => FakeAudio.instances[0];

  function captureHandler() {
    const addSpy = vi.spyOn(window, "addEventListener");
    setupKeyboardShortcuts();
    const call = addSpy.mock.calls.find((c) => c[0] === "keydown");
    return call ? call[1] : null;
  }

  // mods：{ metaKey, ctrlKey, altKey, shiftKey } 覆盖默认 false
  function fire(handler, code, target = {}, mods = {}) {
    const ev = {
      code,
      target,
      preventDefault: vi.fn(),
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...mods,
    };
    handler(ev);
    return ev;
  }

  it("配置表覆盖全部快捷键（22 项），默认值与持久化字段一致", () => {
    expect(SHORTCUTS).toHaveLength(22);
    for (const s of SHORTCUTS) {
      expect(playbackSettings[s.settingKey]).toBe(s.defaultCode);
      expect(s.id && s.labelKey && s.category && s.defaultCode).toBeTruthy();
    }
    // 分类覆盖 6 组（设置弹窗分组渲染顺序）
    expect(SHORTCUT_CATEGORIES.map((c) => c.key)).toEqual([
      "playback",
      "track",
      "volume",
      "karaoke",
      "search",
      "other",
    ]);
    // meta 标记与默认组合一致（⌘ 组合 = "Meta+" 前缀）
    for (const s of SHORTCUTS) {
      expect(s.meta).toBe(s.defaultCode.startsWith("Meta+"));
    }
  });

  it("PLAYBACK_SETTINGS_DEFAULTS 包含全部快捷键字段", () => {
    for (const s of SHORTCUTS) {
      expect(PLAYBACK_SETTINGS_DEFAULTS[s.settingKey]).toBe(s.defaultCode);
    }
  });

  it("⌘→ / ⌘← 下一首 / 上一首（自动播放）", async () => {
    const h = captureHandler();
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    fire(h, "ArrowRight", {}, { metaKey: true });
    await Promise.resolve(); // selectSong 尾部的 loadLyric fetch 异步收尾
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");
    fire(h, "ArrowLeft", {}, { metaKey: true });
    await Promise.resolve();
    expect(state.currentIndex).toBe(0);
  });

  it("M 静音切换", () => {
    const h = captureHandler();
    state.volume = 0.8;
    state.muted = false;
    const a = audio();
    fire(h, "KeyM");
    expect(state.muted).toBe(true);
    expect(a.volume).toBe(0);
    fire(h, "KeyM");
    expect(state.muted).toBe(false);
    expect(a.volume).toBe(0.8);
  });

  it("F 收藏 / 取消收藏当前歌（无当前歌忽略）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3", name: "A" };
    fire(h, "KeyF");
    expect(state.favorites).toContain("/a.mp3");
    fire(h, "KeyF");
    expect(state.favorites).not.toContain("/a.mp3");
    // 无当前歌 / 流媒体歌（path 为 null）：不动作
    state.currentSong = { type: "stream", streamId: "1", path: null, name: "S" };
    fire(h, "KeyF");
    expect(state.favorites).toEqual([]);
  });

  it("R 播放模式三态切换", () => {
    const h = captureHandler();
    state.playMode = "order";
    fire(h, "KeyR");
    expect(state.playMode).toBe("shuffle");
    fire(h, "KeyR");
    expect(state.playMode).toBe("repeatOne");
    fire(h, "KeyR");
    expect(state.playMode).toBe("order");
    expect(playbackSettings.playMode).toBe("order"); // 同步持久化
  });

  it("L 中文翻译显示开关", () => {
    const h = captureHandler();
    state.zhVisible = true;
    fire(h, "KeyL");
    expect(state.zhVisible).toBe(false);
    fire(h, "KeyL");
    expect(state.zhVisible).toBe(true);
  });

  it("G 连播 ↔ 跟唱模式切换", () => {
    const h = captureHandler();
    state.mode = "continuous";
    fire(h, "KeyG");
    expect(state.mode).toBe("karaoke");
    fire(h, "KeyG");
    expect(state.mode).toBe("continuous");
  });

  it("A / B 设 AB 循环起点 / 终点（无 AB 时 B 忽略）", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    state.lyric = [
      { type: "line", s: 0, e: 10, text: ["第一句"] },
      { type: "line", s: 10, e: 20, text: ["第二句"] },
    ]; // 两句：0-10 / 10-20
    // B 无 AB 区间：忽略
    fire(h, "KeyB");
    expect(state.abLoop).toBeNull();
    // A：锚定第二句（currentTime=12 → line 1）为起点
    state.currentTime = 12;
    fire(h, "KeyA");
    expect(state.abLoop).toEqual({ a: 1, b: null });
    // B：锚定第一句（currentTime=3 → line 0）为终点 → 自动交换为 {a:0, b:1}
    state.currentTime = 3;
    fire(h, "KeyB");
    expect(state.abLoop).toEqual({ a: 0, b: 1 });
    // 区间完整后 B 再按：忽略
    fire(h, "KeyB");
    expect(state.abLoop).toEqual({ a: 0, b: 1 });
  });

  it("[ / ] 变速步进（0.75 → 1.0 → 1.25，边界不动作）", () => {
    const h = captureHandler();
    state.speed = 1.0;
    fire(h, "BracketLeft");
    expect(state.speed).toBe(0.75);
    expect(playerMod.audio.playbackRate).toBe(0.75); // 变速写入当前活动元素（裸元素）
    fire(h, "BracketLeft"); // 边界：不再变慢
    expect(state.speed).toBe(0.75);
    fire(h, "BracketRight");
    expect(state.speed).toBe(1.0);
    fire(h, "BracketRight");
    expect(state.speed).toBe(1.25);
    expect(playerMod.audio.playbackRate).toBe(1.25);
    fire(h, "BracketRight"); // 边界：不再变快
    expect(state.speed).toBe(1.25);
  });

  it("⌘↑ / ⌘↓ 音量 ±20%（clamp 0~1）", () => {
    const h = captureHandler();
    const a = audio();
    state.volume = 0.5;
    fire(h, "ArrowUp", {}, { metaKey: true });
    expect(state.volume).toBeCloseTo(0.7);
    expect(a.volume).toBeCloseTo(0.7);
    fire(h, "ArrowDown", {}, { metaKey: true });
    expect(state.volume).toBeCloseTo(0.5);
    // clamp 上限
    state.volume = 0.95;
    fire(h, "ArrowUp", {}, { metaKey: true });
    expect(state.volume).toBe(1);
    // clamp 下限
    state.volume = 0.05;
    fire(h, "ArrowDown", {}, { metaKey: true });
    expect(state.volume).toBe(0);
  });

  it("修饰键排除：纯键带 ⌘/Ctrl 不触发，⌘ 组合不带 Meta 不触发", () => {
    const h = captureHandler();
    state.volume = 0.5;
    // Ctrl+↑ 不触发任何音量键（volUp 要求无修饰键；volStepUp 要求 Meta）
    fire(h, "ArrowUp", {}, { ctrlKey: true });
    expect(state.volume).toBe(0.5);
    // Meta+M 不触发静音（M 是纯键）
    state.muted = false;
    fire(h, "KeyM", {}, { metaKey: true });
    expect(state.muted).toBe(false);
    // 纯 M 触发静音
    fire(h, "KeyM");
    expect(state.muted).toBe(true);
    // ⌘→ 不带 Meta：不切歌，走纯键 → 快进 10s
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    const a = audio();
    a.src = "/a.mp3";
    a.currentTime = 30;
    a.duration = 100;
    fire(h, "ArrowRight"); // 纯 → 快进
    expect(state.currentIndex).toBe(0);
    expect(a.currentTime).toBe(40);
  });

  it("录制保存后按新组合生效（旧组合失效）", () => {
    const h = captureHandler();
    // 把「上一首」录制成 Meta+ArrowRight（与默认 ⌘← 不同）
    playbackSettings.shortcutPrevTrack = "Meta+ArrowRight";
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = 1;
    state.currentSong = state.songs[1];
    fire(h, "ArrowRight", {}, { metaKey: true });
    expect(state.currentIndex).toBe(0); // 上一首
    // 默认 ⌘← 已失效：按 ⌘← 不再切歌（⌘← 未绑定任何动作）
    const a = audio();
    a.src = "/b.mp3";
    const ev = fire(h, "ArrowLeft", {}, { metaKey: true });
    expect(state.currentIndex).toBe(0);
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it("搜索快捷键（⌘K）由搜索层独占：播放器层不拦截", () => {
    const h = captureHandler();
    state.currentSong = { path: "/a.mp3" };
    const a = audio();
    a.paused = true;
    const ev = fire(h, "KeyK", {}, { metaKey: true });
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(a.paused).toBe(true);
  });

  it("⌘, 打开设置（openSettings 快捷键）", async () => {
    const h = captureHandler();
    const { isSettingsOpen } = await import("../composables/settingsState.js");
    isSettingsOpen.value = false;
    fire(h, "Comma", {}, { metaKey: true });
    expect(isSettingsOpen.value).toBe(true);
    // 纯 , 不触发（⌘ 组合要求 metaKey）
    isSettingsOpen.value = false;
    fire(h, "Comma");
    expect(isSettingsOpen.value).toBe(false);
  });

  it("parseShortcutCombo：历史 Meta+K 归一为 KeyK", () => {
    expect(parseShortcutCombo("Meta+K")).toEqual({ meta: true, code: "KeyK" });
    expect(parseShortcutCombo("Meta+KeyK")).toEqual({ meta: true, code: "KeyK" });
    expect(parseShortcutCombo("Meta+ArrowLeft")).toEqual({ meta: true, code: "ArrowLeft" });
    expect(parseShortcutCombo("KeyM")).toEqual({ meta: false, code: "KeyM" });
    expect(parseShortcutCombo(null)).toBeNull();
  });

  it("fmtShortcutKey：⌘ 组合与特殊键显示", () => {
    expect(fmtShortcutKey("Meta+ArrowLeft")).toBe("⌘←");
    expect(fmtShortcutKey("Meta+K")).toBe("⌘K");
    expect(fmtShortcutKey("Meta+ArrowUp")).toBe("⌘↑");
    expect(fmtShortcutKey("Space")).toBe("Space");
    expect(fmtShortcutKey("KeyM")).toBe("M");
    expect(fmtShortcutKey("BracketLeft")).toBe("[");
    expect(fmtShortcutKey("BracketRight")).toBe("]");
    expect(fmtShortcutKey("Meta+Comma")).toBe("⌘,");
    expect(fmtShortcutKey("Comma")).toBe(",");
    expect(fmtShortcutKey("Digit5")).toBe("5");
    expect(fmtShortcutKey("F3")).toBe("F3");
    expect(fmtShortcutKey("")).toBe("—");
  });

  it("录制纯键与 ⌘ 组合均能被配置表匹配（模拟 SettingsModal 存值）", () => {
    const h = captureHandler();
    // 纯键录制：静音改为 KeyJ
    playbackSettings.shortcutMute = "KeyJ";
    state.muted = false;
    fire(h, "KeyJ");
    expect(state.muted).toBe(true);
    fire(h, "KeyM"); // 旧键失效
    expect(state.muted).toBe(true);
    // ⌘ 组合录制：翻译开关改为 Meta+KeyT
    playbackSettings.shortcutZhToggle = "Meta+KeyT";
    state.zhVisible = true;
    fire(h, "KeyT", {}, { metaKey: true });
    expect(state.zhVisible).toBe(false);
    fire(h, "KeyL"); // 旧键失效
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

  it("刷新后 currentSong 引用同步到新数组（刮削改名/封面后播放界面立即更新）", async () => {
    state.songs = [{ path: "/old.mp3", name: "旧名", artist: "旧歌手" }];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [{ path: "/old.mp3", name: "新名", artist: "新歌手" }],
      })),
    );
    await loadSongs();
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong.name).toBe("新名"); // 不再是旧对象
    expect(state.currentSong.artist).toBe("新歌手");
  });

  it("刷新后网络歌按 streamId 保持选中（path 为 null 不误匹配）", async () => {
    state.songs = [
      { path: "/a.mp3", name: "本地A" },
      { type: "stream", streamId: "s1", path: null, name: "网络1" },
      { type: "stream", streamId: "s2", path: null, name: "网络2" },
    ];
    state.currentIndex = 2;
    state.currentSong = state.songs[2]; // 正在播网络2
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => [
          { path: "/a.mp3", name: "本地A" },
          { type: "stream", streamId: "s1", path: null, name: "网络1" },
          { type: "stream", streamId: "s2", path: null, name: "网络2" },
        ],
      })),
    );
    await loadSongs();
    expect(state.currentIndex).toBe(2);
    expect(state.currentSong.streamId).toBe("s2");
  });

  it("findSongIndex：本地歌按 path，网络歌按 streamId，空/不存在返回 -1", () => {
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { type: "stream", streamId: "s1", path: null, name: "S1" },
      { type: "stream", streamId: "s2", path: null, name: "S2" },
    ];
    expect(findSongIndex({ path: "/a.mp3" })).toBe(0);
    expect(findSongIndex({ type: "stream", streamId: "s2", path: null })).toBe(2);
    expect(findSongIndex({ type: "stream", streamId: "s1", path: null })).toBe(1); // 不误匹配第一个 stream
    expect(findSongIndex({ path: "/nope.mp3" })).toBe(-1);
    expect(findSongIndex(null)).toBe(-1);
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

describe("歌词显示设置（lyricSettings）", () => {
  it("默认值：20px / 左对齐 / 系统字体 / 全开 / 1/3 停靠", () => {
    expect(lyricSettings.fontSize).toBe(20);
    expect(lyricSettings.align).toBe("left");
    expect(lyricSettings.fontFamily).toBe("system");
    expect(lyricSettings.showRoma).toBe(true);
    expect(lyricSettings.showZh).toBe(true);
    expect(lyricSettings.showSec).toBe(true);
    expect(lyricSettings.focusPos).toBe(0.5);
    expect(lyricSettings.fadeMask).toBe(true);
    expect(lyricSettings.autoScroll).toBe(true);
  });

  it("AMLL 三特效：浏览器（无壳）默认关闭，防 CPU 高占用", () => {
    // jsdom 无 window.qqplayerNative → 浏览器环境：开箱默认关（localStorage 无存储值时）
    expect(lyricSettings.amllBlur).toBe(false);
    expect(lyricSettings.amllSpring).toBe(false);
    expect(lyricSettings.amllScale).toBe(false);
    // 引擎同样回退 spring：浏览器默认不用 AMLL（pixi WebGL 长时间播放仍高占用），用户手动切才启用
    expect(lyricSettings.engine).toBe("spring");
  });

  it("AMLL 三特效：壳（window.qqplayerNative）内默认开启（满血，行为零变化）", async () => {
    localStorage.removeItem(LYRIC_SETTINGS_KEY);
    window.qqplayerNative = true;
    vi.resetModules();
    try {
      const m = await import("../composables/usePlayer.js");
      expect(m.lyricSettings.amllBlur).toBe(true);
      expect(m.lyricSettings.amllSpring).toBe(true);
      expect(m.lyricSettings.amllScale).toBe(true);
      expect(m.lyricSettings.engine).toBe("amll"); // 壳默认保持 AMLL 引擎
      expect(m.lyricSettings.fontSize).toBe(20); // 其他字段不受影响
    } finally {
      delete window.qqplayerNative;
    }
  });

  it("AMLL 三特效：已存储值优先（壳内存 false → 关；浏览器存 true → 开）", async () => {
    // 壳环境：存储值 false 覆盖环境默认 true
    localStorage.setItem(
      LYRIC_SETTINGS_KEY,
      JSON.stringify({ amllBlur: false, amllSpring: false, amllScale: false }),
    );
    window.qqplayerNative = true;
    vi.resetModules();
    try {
      const m = await import("../composables/usePlayer.js");
      expect(m.lyricSettings.amllBlur).toBe(false);
      expect(m.lyricSettings.amllSpring).toBe(false);
      expect(m.lyricSettings.amllScale).toBe(false);
    } finally {
      delete window.qqplayerNative;
    }
    // 浏览器环境：存储值 true 覆盖环境默认 false
    localStorage.setItem(
      LYRIC_SETTINGS_KEY,
      JSON.stringify({ amllBlur: true, amllSpring: true, amllScale: true, engine: "amll" }),
    );
    vi.resetModules();
    const m2 = await import("../composables/usePlayer.js");
    expect(m2.lyricSettings.amllBlur).toBe(true);
    expect(m2.lyricSettings.amllSpring).toBe(true);
    expect(m2.lyricSettings.amllScale).toBe(true);
    expect(m2.lyricSettings.engine).toBe("amll"); // 用户手动切回 AMLL 的存储值优先
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

describe("界面偏好（uiSettings）", () => {
  it("默认值：歌曲信息关闭 / 跟唱时间戳关闭 / 跟唱行号显示（默认显示，用户可关）", () => {
    expect(uiSettings.showSongInfo).toBe(false);
    expect(uiSettings.karaokeShowTime).toBe(false);
    expect(uiSettings.karaokeShowNum).toBe(true);
  });

  it("第四批默认值：深色主题 / 橙色强调色 / 封面模糊关 / 紧凑模式关", () => {
    expect(uiSettings.theme).toBe("dark");
    expect(uiSettings.accent).toBe("orange");
    expect(uiSettings.coverBlur).toBe(false);
    expect(uiSettings.compact).toBe(false);
  });

  it("修改主题/强调色/紧凑/封面模糊后写入 html dataset（驱动 CSS）", async () => {
    const html = document.documentElement;
    uiSettings.theme = "light";
    uiSettings.accent = "blue";
    uiSettings.compact = true;
    uiSettings.coverBlur = true;
    await nextTick();
    expect(html.dataset.theme).toBe("light");
    expect(html.dataset.accent).toBe("blue");
    expect(html.dataset.compact).toBe("true");
    expect(html.dataset.blur).toBe("true");
    // 关闭后移除属性
    uiSettings.compact = false;
    uiSettings.coverBlur = false;
    await nextTick();
    expect(html.dataset.compact).toBeUndefined();
    expect(html.dataset.blur).toBeUndefined();
  });

  it("auto 主题跟随系统 prefers-color-scheme（浅色系统→light，深色系统→dark）", async () => {
    const listeners = {};
    const mq = {
      matches: true,
      media: "(prefers-color-scheme: light)",
      addEventListener: (ev, fn) => {
        listeners[ev] = fn;
      },
      removeEventListener: () => {},
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mq),
    );
    uiSettings.theme = "auto";
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("light");
    // 系统切到深色 → 自动更新
    mq.matches = false;
    listeners.change();
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("dark");
    // 手动指定主题后不再跟随系统
    uiSettings.theme = "light";
    await nextTick();
    expect(document.documentElement.dataset.theme).toBe("light");
    vi.unstubAllGlobals();
  });

  it("localStorage 持久化的主题/强调色在启动时应用（data-theme 恢复）", async () => {
    localStorage.setItem(
      UI_SETTINGS_KEY,
      JSON.stringify({ theme: "light", accent: "purple", compact: true }),
    );
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.uiSettings.theme).toBe("light");
    expect(m.uiSettings.accent).toBe("purple");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.accent).toBe("purple");
    expect(document.documentElement.dataset.compact).toBe("true");
  });

  it("修改后自动持久化到 localStorage", async () => {
    localStorage.removeItem(UI_SETTINGS_KEY);
    uiSettings.showSongInfo = true;
    uiSettings.karaokeShowTime = true;
    uiSettings.karaokeShowNum = false;
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY));
    expect(saved.showSongInfo).toBe(true);
    expect(saved.karaokeShowTime).toBe(true);
    expect(saved.karaokeShowNum).toBe(false);
  });

  it("localStorage 已有配置时加载覆盖默认值，未保存项保持默认", async () => {
    localStorage.setItem(UI_SETTINGS_KEY, JSON.stringify({ showSongInfo: true }));
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.uiSettings.showSongInfo).toBe(true);
    expect(m.uiSettings.karaokeShowTime).toBe(false); // 未保存的保持默认
    expect(m.uiSettings.karaokeShowNum).toBe(true); // 未保存的保持默认
  });
});

// ============ MediaSession 系统媒体键 ============// navigator.mediaSession stub：记录 setActionHandler 绑定的处理器与 metadata/playbackState
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

  it("nexttrack/previoustrack 切歌后自动播放", async () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await selectSong(0);
    const a = FakeAudio.instances[0];
    a.paused = true; // 手动暂停
    await handlers.nexttrack();
    expect(state.currentIndex).toBe(1);
    expect(a.paused).toBe(false); // 自动播放
    a.paused = true;
    await handlers.previoustrack();
    expect(state.currentIndex).toBe(0);
    expect(a.paused).toBe(false);
  });

  it("未选歌时播放键自动选第一首并播放", async () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    state.currentIndex = -1;
    state.currentSong = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    handlers.play();
    await new Promise((r) => setTimeout(r, 0)); // selectSong 异步
    expect(state.currentIndex).toBe(0);
    expect(FakeAudio.instances[0].paused).toBe(false);
  });

  it("播放键在歌曲播完（ended）后重播，不卡在末尾", async () => {
    const { handlers } = createMediaSessionStub();
    setupMediaSession();
    state.songs = [{ path: "/a.mp3", name: "A" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await selectSong(0);
    const a = FakeAudio.instances[0];
    a.duration = 100;
    a.currentTime = 100;
    a.ended = true;
    a.paused = true;
    handlers.play();
    expect(a.currentTime).toBe(0);
    expect(a.paused).toBe(false);
  });
});

// ============ 播放统计（会话跟踪 + 上报）============
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

describe("歌单", () => {
  it("loadPlaylists 拉取歌单列表；激活的歌单被删则退回全部歌曲", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          playlists: [{ id: "p1", name: "日语", songPaths: ["/a.mp3"] }],
        }),
      })),
    );
    state.activePlaylistId = "p1";
    await loadPlaylists();
    expect(state.playlists).toHaveLength(1);
    expect(state.playlists[0].name).toBe("日语");
    expect(state.activePlaylistId).toBe("p1");
    // 歌单没了 → 退回全部歌曲（歌单列表有 60s 声明式缓存，先失效再拉取）
    await invalidate("/api/playlists");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ playlists: [] }) })),
    );
    await loadPlaylists();
    expect(state.activePlaylistId).toBeNull();
  });

  it("createPlaylist 创建并加入列表；空名报错", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ id: "p9", name: "新歌单", songPaths: [] }),
      })),
    );
    const p = await createPlaylist("新歌单");
    expect(state.playlists).toContainEqual(p);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists",
      expect.objectContaining({ method: "POST" }),
    );
    // 后端拒绝
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ detail: "歌单名称不能为空" }),
      })),
    );
    await expect(createPlaylist("")).rejects.toThrow("歌单名称不能为空");
  });

  it("renamePlaylist 乐观改名；失败回滚", async () => {
    state.playlists = [{ id: "p1", name: "旧名", songPaths: [] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await renamePlaylist("p1", "新名");
    expect(state.playlists[0].name).toBe("新名");
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1",
      expect.objectContaining({ method: "PATCH" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(renamePlaylist("p1", "再改")).rejects.toThrow("改名失败");
    expect(state.playlists[0].name).toBe("新名");
  });

  it("deletePlaylist 删除并退回全部歌曲；失败回滚", async () => {
    state.playlists = [
      { id: "p1", name: "A", songPaths: [] },
      { id: "p2", name: "B", songPaths: [] },
    ];
    state.activePlaylistId = "p1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await deletePlaylist("p1");
    expect(state.playlists.map((p) => p.id)).toEqual(["p2"]);
    expect(state.activePlaylistId).toBeNull();
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1",
      expect.objectContaining({ method: "DELETE" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(deletePlaylist("p2")).rejects.toThrow("删除失败");
    expect(state.playlists.map((p) => p.id)).toEqual(["p2"]);
  });

  it("addToPlaylist 加歌（去重）并 POST 后端", async () => {
    state.playlists = [{ id: "p1", name: "A", songPaths: [] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await addToPlaylist("p1", "/a.mp3");
    expect(isInPlaylist("p1", "/a.mp3")).toBe(true);
    // 已在歌单 → 不发请求（去重）
    const before = fetch.mock.calls.length;
    await addToPlaylist("p1", "/a.mp3");
    expect(fetch.mock.calls.length).toBe(before);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1/songs",
      expect.objectContaining({ method: "POST" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(addToPlaylist("p1", "/b.mp3")).rejects.toThrow("加入歌单失败");
    expect(isInPlaylist("p1", "/b.mp3")).toBe(false);
  });

  it("removeFromPlaylist 移出并 DELETE（path 编码）；失败回滚", async () => {
    state.playlists = [{ id: "p1", name: "A", songPaths: ["/a.mp3"] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await removeFromPlaylist("p1", "/a.mp3");
    expect(isInPlaylist("p1", "/a.mp3")).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1/songs/" + encodeURIComponent("/a.mp3"),
      expect.objectContaining({ method: "DELETE" }),
    );
    // 失败回滚
    state.playlists[0].songPaths = ["/b.mp3"];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(removeFromPlaylist("p1", "/b.mp3")).rejects.toThrow("移出歌单失败");
    expect(isInPlaylist("p1", "/b.mp3")).toBe(true);
  });

  it("removeFromPlaylist 移除成功弹 toast（带撤销）；点撤销 → POST 加回歌单末尾", async () => {
    state.playlists = [{ id: "p1", name: "旅行", songPaths: ["/a.mp3"] }];
    state.songs = [{ path: "/a.mp3", name: "A歌" }];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    clearToasts();
    await removeFromPlaylist("p1", "/a.mp3");
    expect(isInPlaylist("p1", "/a.mp3")).toBe(false);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].text).toContain("A歌");
    expect(items[0].duration).toBe(5000);
    expect(items[0].action).toBeTruthy();
    // 点撤销 → POST /api/playlists/p1/songs 加回
    items[0].action.onClick();
    await new Promise((r) => setTimeout(r, 0));
    expect(isInPlaylist("p1", "/a.mp3")).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/playlists/p1/songs",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ path: "/a.mp3" }) }),
    );
    clearToasts();
  });

  it("setPlaylistOrder 提交新顺序；失败回滚", async () => {
    state.playlists = [{ id: "p1", name: "A", songPaths: ["/a.mp3", "/b.mp3"] }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    await setPlaylistOrder("p1", ["/b.mp3", "/a.mp3"]);
    expect(state.playlists[0].songPaths).toEqual(["/b.mp3", "/a.mp3"]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/playlists/p1/order",
      expect.objectContaining({ method: "PUT" }),
    );
    // 失败回滚
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false })),
    );
    await expect(setPlaylistOrder("p1", ["/a.mp3"])).rejects.toThrow("排序保存失败");
    expect(state.playlists[0].songPaths).toEqual(["/b.mp3", "/a.mp3"]);
  });
});

describe("侧栏面板开关", () => {
  it("toggleMusicLib / togglePlaylist 切换并持久化 localStorage（统一 key qqplayer.ui.v1）", () => {
    expect(uiState.musicLibOpen).toBe(true);
    expect(uiState.playlistOpen).toBe(true);
    toggleMusicLib();
    togglePlaylist();
    expect(uiState.musicLibOpen).toBe(false);
    expect(uiState.playlistOpen).toBe(false);
    expect(lsStore[UI_STATE_KEY]).toBe(
      JSON.stringify({ musicLib: false, playlist: false, controlsHidden: false }),
    );
    toggleMusicLib();
    expect(uiState.musicLibOpen).toBe(true);
    expect(uiState.playlistOpen).toBe(false);
  });

  it("两个面板独立开关，互不影响", () => {
    toggleMusicLib();
    expect(uiState.musicLibOpen).toBe(false);
    expect(uiState.playlistOpen).toBe(true);
    togglePlaylist();
    expect(uiState.musicLibOpen).toBe(false);
    expect(uiState.playlistOpen).toBe(false);
  });

  it("加载时从 localStorage 恢复面板状态", async () => {
    lsStore[UI_STATE_KEY] = JSON.stringify({ musicLib: false, playlist: true });
    vi.resetModules();
    const mod = await import("../composables/usePlayer.js");
    expect(mod.uiState.musicLibOpen).toBe(false);
    expect(mod.uiState.playlistOpen).toBe(true);
  });

  it("旧 key（PANEL_KEY/CONTROLS_KEY）首次读取时迁移到统一 key，行为不变", async () => {
    lsStore["qqplay…p.v1"] = JSON.stringify({ musicLib: false, playlist: true });
    lsStore["qqplayer.controls.v1"] = "1";
    vi.resetModules();
    const mod = await import("../composables/usePlayer.js");
    expect(mod.uiState.musicLibOpen).toBe(false);
    expect(mod.uiState.playlistOpen).toBe(true);
    expect(mod.uiState.controlsHidden).toBe(true);
    // 迁移后写透新 key；后续启动走新 key（旧 key 保留不删）
    expect(JSON.parse(lsStore[UI_STATE_KEY])).toEqual({
      musicLib: false,
      playlist: true,
      controlsHidden: true,
    });
  });

  it("toggleControls 收起/展开控制区并持久化 localStorage", () => {
    expect(uiState.controlsHidden).toBe(false);
    toggleControls();
    expect(uiState.controlsHidden).toBe(true);
    expect(JSON.parse(lsStore[UI_STATE_KEY]).controlsHidden).toBe(true);
    toggleControls();
    expect(uiState.controlsHidden).toBe(false);
    expect(JSON.parse(lsStore[UI_STATE_KEY]).controlsHidden).toBe(false);
  });

  it("加载时从 localStorage 恢复控制区收起状态", async () => {
    lsStore[UI_STATE_KEY] = JSON.stringify({ controlsHidden: true });
    vi.resetModules();
    const mod = await import("../composables/usePlayer.js");
    expect(mod.uiState.controlsHidden).toBe(true);
  });
});

describe("setupAutoRefresh（iCloud 库自动刷新）", () => {
  afterEach(() => {
    vi.useRealTimers();
    stopAutoRefresh();
  });

  function stubVersion(version) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/library/version") {
          return { ok: true, json: async () => ({ version }) };
        }
        if (url === "/api/songs") {
          return {
            ok: true,
            json: async () => [
              { path: "/a.mp3", name: "A" },
              { path: "/b.mp3", name: "B" },
            ],
          };
        }
        throw new Error("unexpected url " + url);
      }),
    );
  }

  it("首次轮询只记录版本号，不刷新列表", async () => {
    stubVersion(0);
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.libraryVersion).toBe(0);
    expect(fetch).not.toHaveBeenCalledWith("/api/songs", expect.anything());
  });

  it("版本号变化 → 自动重新拉取歌曲列表", async () => {
    let v = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/library/version") {
          return { ok: true, json: async () => ({ version: v }) };
        }
        if (url === "/api/songs") {
          return { ok: true, json: async () => [{ path: "/new.mp3", name: "新歌" }] };
        }
        throw new Error("unexpected url " + url);
      }),
    );
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.libraryVersion).toBe(0);
    v = 1; // 库变动
    await vi.advanceTimersByTimeAsync(100);
    expect(state.libraryVersion).toBe(1);
    expect(fetch).toHaveBeenCalledWith("/api/songs", expect.anything());
    expect(state.songs.map((s) => s.name)).toEqual(["新歌"]);
  });

  it("版本号不变 → 不刷新", async () => {
    let songsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/library/version") {
          return { ok: true, json: async () => ({ version: 3 }) };
        }
        if (url === "/api/songs") {
          songsCalls += 1;
          return { ok: true, json: async () => [] };
        }
        throw new Error("unexpected url " + url);
      }),
    );
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(songsCalls).toBe(0);
    expect(state.libraryVersion).toBe(3);
  });

  it("重复调用幂等，不叠加 timer", async () => {
    stubVersion(0);
    vi.useFakeTimers();
    setupAutoRefresh(100);
    setupAutoRefresh(100);
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.libraryVersion).toBe(0);
  });

  it("接口异常时静默，不影响下一轮", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend down");
      }),
    );
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.libraryVersion).toBeNull();
  });
});

// ============ 第一批：播放设置（playbackSettings）============
describe("播放设置 playbackSettings", () => {
  // 模块级 reactive 跨测试残留：每个测试前保存、后恢复
  let saved;
  beforeEach(() => {
    saved = { ...playbackSettings };
  });
  afterEach(() => {
    Object.assign(playbackSettings, saved);
    state.volume = 1.0;
    state.muted = false;
  });

  it("cyclePlayMode 同步持久化播放模式（启动时恢复用）", async () => {
    state.playMode = "order";
    cyclePlayMode();
    expect(playbackSettings.playMode).toBe("shuffle");
    await nextTick(); // watch 持久化为异步写入
    expect(JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY)).playMode).toBe("shuffle");
  });

  it("设置弹窗里改播放模式立即生效（同步 state）", () => {
    state.playMode = "order";
    playbackSettings.playMode = "repeatOne";
    expect(state.playMode).toBe("repeatOne");
  });

  it("播放模式持久化：模块加载时从 localStorage 恢复", async () => {
    // 重新加载模块验证启动恢复（重置模块缓存）
    // 拆分后 usePlayer.js 是 barrel 聚合层（export * 的底层模块已被缓存，查询参数无法强制重载），
    // 播放设置的加载逻辑在 playerState.ts（playbackSettings 与 loadPlaybackSettings 同模块），
    // 直接重载它验证等价行为
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ playMode: "shuffle", resumeLast: false, rememberVolume: false, fadeSec: 1 }),
    );
    const mod = await import("../composables/playerState.ts?restore-test=" + Date.now());
    expect(mod.state.playMode).toBe("shuffle");
    expect(mod.playbackSettings.fadeSec).toBe(1);
  });

  it("记住音量：开启时 setVolume 持久化", () => {
    playbackSettings.rememberVolume = true;
    setVolume(0.5);
    expect(parseFloat(localStorage.getItem(VOLUME_KEY))).toBe(0.5);
  });

  it("记住音量：关闭时 setVolume 不写入 localStorage", () => {
    playbackSettings.rememberVolume = false;
    setVolume(0.5);
    expect(localStorage.getItem(VOLUME_KEY)).toBeNull();
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

describe("歌词延迟校准（lyricSettings.offset）", () => {
  const LRC = [
    { type: "line", s: 0, e: 10, text: ["第一句"] },
    { type: "line", s: 10, e: 20, text: ["第二句"] },
  ];

  const audio = () => FakeAudio.instances[0];

  function setup(on = true) {
    state.mode = "karaoke";
    state.karaokeOn = on;
    state.currentSong = { path: "/a.mp3" };
    audio().src = "/a.mp3";
  }
  function fireTimeupdate(t) {
    const a = audio();
    a.currentTime = t;
    a.paused = false;
    a.listeners["timeupdate"]();
    return a;
  }

  beforeEach(() => {
    lyricSettings.offset = 0;
  });

  it("offset>0：playLine 跳到句首 + 偏移（歌词延后，音频先行）", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = 0.5;
    playLine(1); // 第二句 s=10
    expect(audio().currentTime).toBe(10.5);
  });

  it("offset<0：playLine 跳到句首 - 偏移，且不小于 0", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = -0.5;
    playLine(0); // 第一句 s=0 → clamp 到 0
    expect(audio().currentTime).toBe(0);
    playLine(1); // 第二句 s=10 → 9.5
    expect(audio().currentTime).toBe(9.5);
  });

  it("句末自动停时刻随 offset 平移（延后 0.5s）", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = 0.5;
    playLine(0);
    fireTimeupdate(10.2); // 歌词轴 9.7，仍在第一句内
    expect(audio().paused).toBe(false);
    fireTimeupdate(10.5); // 歌词轴 10.0，越过 e=10 → 停
    expect(audio().paused).toBe(true);
  });

  it("句末自动停时刻随 offset 平移（提前 0.5s）", () => {
    setup();
    state.lyric = LRC;
    lyricSettings.offset = -0.5;
    playLine(0);
    fireTimeupdate(9.2); // 歌词轴 9.7，仍在第一句内
    expect(audio().paused).toBe(false);
    fireTimeupdate(9.5); // 歌词轴 10.0，越过 e=10 → 停
    expect(audio().paused).toBe(true);
  });

  it("currentLineIndex 高亮随 offset 平移", () => {
    state.lyric = LRC;
    state.currentTime = 10.2;
    lyricSettings.offset = 0.5;
    expect(currentLineIndex.value).toBe(0); // 歌词轴 9.7 仍在第一句
    lyricSettings.offset = -0.5;
    expect(currentLineIndex.value).toBe(1); // 歌词轴 10.7 已进第二句
  });
});

describe("歌词来源优先级（lyricSettings.source）", () => {
  const lyricRes = (source) => ({
    ok: true,
    json: async () => ({
      format: "lrc",
      lines: [{ type: "line", s: 0, e: 1, text: ["x"] }],
      source,
    }),
  });

  beforeEach(() => {
    lyricSettings.source = "local";
  });

  it("默认 local：加载歌词请求带 prefer=local，记录实际来源", async () => {
    const fetchMock = vi.fn(async () => lyricRes("local"));
    vi.stubGlobal("fetch", fetchMock);
    state.songs = [{ path: "/a.mp3" }];
    await selectSong(0);
    const url = fetchMock.mock.calls[0][0];
    expect(url).toContain("/api/lyric?path=");
    expect(url).toContain("prefer=local");
    expect(state.lyricSource).toBe("local");
  });

  it("切换到在线优先：watch 触发重载，请求带 prefer=online", async () => {
    const fetchMock = vi.fn(async () => lyricRes("netease"));
    vi.stubGlobal("fetch", fetchMock);
    state.songs = [{ path: "/a.mp3" }];
    await selectSong(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    lyricSettings.source = "online";
    await new Promise((r) => setTimeout(r, 0)); // watch 异步触发重载
    // 重载请求必须带 prefer=online（次数不做硬断言：watch 链式触发次数随环境而变，验证本质即可）
    const onlineCalls = fetchMock.mock.calls.filter(([url]) =>
      String(url).includes("prefer=online"),
    );
    expect(onlineCalls.length).toBeGreaterThanOrEqual(1);
    expect(state.lyricSource).toBe("netease");
  });

  it("loadLyric 越界 index 时清空歌词", async () => {
    state.songs = [{ path: "/a.mp3" }];
    state.lyric = [{ type: "line", s: 0, e: 1, text: ["x"] }];
    await loadLyric(3);
    expect(state.lyric).toEqual([]);
    expect(state.lyricSource).toBeNull();
  });
});

// ============ 第三批：音乐库设置（librarySettings）============
describe("音乐库设置 librarySettings", () => {
  it("loadLibrarySettings 拉取后端设置并写入 state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        expect(url).toBe("/api/library/settings");
        return {
          ok: true,
          json: async () => ({
            settings: { audioExts: [".mp3", ".flac"], ignoreHidden: true },
          }),
        };
      }),
    );
    await loadLibrarySettings();
    expect(state.librarySettings).toEqual({
      audioExts: [".mp3", ".flac"],
      ignoreHidden: true,
    });
  });

  it("loadLibrarySettings 后端不可用时静默（不抛异常）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    await expect(loadLibrarySettings()).resolves.toBeUndefined();
    expect(state.librarySettings).toBeNull();
  });

  it("saveLibrarySettings PUT 成功：写入 state 并返回响应", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        expect(url).toBe("/api/library/settings");
        expect(opts.method).toBe("PUT");
        expect(JSON.parse(opts.body)).toEqual({ autoRefresh: false });
        return {
          ok: true,
          json: async () => ({
            settings: { audioExts: [".mp3"], autoRefresh: false },
            count: 10,
          }),
        };
      }),
    );
    const data = await saveLibrarySettings({ autoRefresh: false });
    expect(state.librarySettings.autoRefresh).toBe(false);
    expect(data.count).toBe(10);
  });

  it("saveLibrarySettings 后端失败：抛出错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        json: async () => ({ detail: "保存失败" }),
      })),
    );
    await expect(saveLibrarySettings({ autoRefresh: true })).rejects.toThrow("保存失败");
  });
});

// ============ 迷你窗控制指令消费（setupPlayerActions） ============
describe("setupPlayerActions（迷你窗控制指令消费）", () => {
  afterEach(() => {
    // 先清 timer 再恢复真实 timers：顺序反了 fake interval id 在真实环境 clear 无效，
    // timer 泄漏到下一测试（CI 全量跑偶发多一次 fetch 的 flaky 根因）
    stopPlayerActions();
    vi.useRealTimers();
  });

  function stubActions(actions) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/player/actions") {
          return { ok: true, json: async () => ({ actions }) };
        }
        if (url.startsWith("/api/lyric")) {
          return { ok: true, json: async () => ({ lyric: [], source: null }) };
        }
        if (url === "/api/cover") {
          return { ok: true };
        }
        throw new Error("unexpected url " + url);
      }),
    );
  }

  it("取到指令依次执行：togglePlay / seek / volume / next / prev", async () => {
    // 重置模块级单例 audio 的播放状态（跨测试残留：上一个测试可能停在播放中）
    const fake = FakeAudio.instances[0];
    fake.paused = true;
    fake.currentTime = 0;
    fake.duration = 0;
    state.songs = [
      { path: "/a.mp3", name: "A", artist: "X", duration: 100 },
      { path: "/b.mp3", name: "B", artist: "Y", duration: 100 },
    ];
    state.currentIndex = 0;
    state.currentSong = state.songs[0];
    state.duration = 100;
    vi.useFakeTimers();

    // 第一轮：播放控制类指令（同一轮会同步全部执行，末条状态为准）
    stubActions([
      { action: "togglePlay", value: null },
      { action: "seek", value: 42 },
      { action: "volume", value: 0.3 },
    ]);
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(FakeAudio.instances[0].paused).toBe(false); // togglePlay
    expect(state.currentTime).toBe(42); // seek
    expect(state.volume).toBe(0.3); // volume

    // 第二轮：next → 切到下一首（selectSong 换源后默认暂停）
    stubActions([{ action: "next", value: null }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");

    // 第三轮：prev → 回到上一首
    stubActions([{ action: "prev", value: null }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.currentIndex).toBe(0);
  });

  it("未知指令忽略，不抛错", async () => {
    stubActions([
      { action: "rm -rf /", value: null },
      { action: "seek", value: 10 },
    ]);
    vi.useFakeTimers();
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.currentTime).toBe(10);
  });

  it("重复调用幂等，不叠加 timer", async () => {
    stubActions([{ action: "volume", value: 0.5 }]);
    vi.useFakeTimers();
    setupPlayerActions(100);
    setupPlayerActions(100);
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(fetch).toHaveBeenCalledTimes(3); // 3 轮 × 1 次（非 3 个 timer × 3 轮）
    expect(state.volume).toBe(0.5);
  });

  it("接口异常时静默，不影响下一轮", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls += 1;
        throw new Error("backend down");
      }),
    );
    vi.useFakeTimers();
    setupPlayerActions(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(calls).toBe(3);
  });
});

// ============ 迷你窗运行状态（顶栏开关点亮） ============
describe("setupMiniStatus（迷你窗运行状态轮询）", () => {
  afterEach(() => {
    // 先清 timer 再恢复真实 timers（同上：避免 fake interval 泄漏到下一测试）
    stopMiniStatus();
    miniRunning.value = false;
    vi.useRealTimers();
  });

  function stubStatus(running) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/mini/status") {
          return { ok: true, json: async () => ({ running }) };
        }
        throw new Error("unexpected url " + url);
      }),
    );
  }

  it("迷你窗运行 → 开关点亮", async () => {
    stubStatus(true);
    vi.useFakeTimers();
    setupMiniStatus(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(miniRunning.value).toBe(true);
  });

  it("迷你窗退出 → 开关熄灭", async () => {
    miniRunning.value = true;
    stubStatus(false);
    vi.useFakeTimers();
    setupMiniStatus(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(miniRunning.value).toBe(false);
  });

  it("refreshMiniStatus 手动刷新", async () => {
    stubStatus(true);
    await refreshMiniStatus();
    expect(miniRunning.value).toBe(true);
  });

  it("重复调用幂等，不叠加 timer", async () => {
    stubStatus(true);
    vi.useFakeTimers();
    setupMiniStatus(100);
    setupMiniStatus(100);
    setupMiniStatus(100);
    await vi.advanceTimersByTimeAsync(200);
    // 首次立即查 1 次 + 200ms 内轮询 2~3 次（fake timer 边界 tick 因 Node 版本/环境而异）；
    // 若 3 个 timer 叠加次数会 ≥9——断言区间验证"不叠加"本质
    expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fetch.mock.calls.length).toBeLessThan(6);
  });
});

// ============ 均衡器 EQ（Web Audio API）============
describe("均衡器 EQ", () => {
  // FakeAudioContext：jsdom 无 Web Audio，stub 记录滤波器链
  class FakeAudioContext {
    static instances = [];
    constructor() {
      this.destination = {};
      this.filters = [];
      this.state = "running";
      this.resumeMock = vi.fn().mockResolvedValue();
      FakeAudioContext.instances.push(this);
    }
    createMediaElementSource() {
      this.source = { connect: vi.fn(), disconnect: vi.fn() };
      return this.source;
    }
    createGain() {
      // 音量主控节点（2026-08-27 WKWebKit 修复后图链路：source → masterGain → filters → destination）
      const g = {
        gain: { value: 1 },
        connect: vi.fn(),
      };
      this.masterGain = g;
      return g;
    }
    createBiquadFilter() {
      const f = {
        type: "",
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0 },
        connect: vi.fn(),
      };
      this.filters.push(f);
      return f;
    }
    resume() {
      return this.resumeMock();
    }
  }

  function stubAudioContext() {
    vi.stubGlobal("AudioContext", FakeAudioContext);
  }

  function setupSong() {
    state.currentSong = { path: "/fake/song.mp3" };
  }

  beforeEach(() => {
    _resetEqGraph();
    playbackSettings.eqEnabled = false;
    playbackSettings.eqPreset = "flat";
    playbackSettings.eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  });

  it("首次播放懒创建音频图：10 段滤波器、频点正确、关闭时增益全 0（直通）", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    expect(ctx.filters).toHaveLength(10);
    ctx.filters.forEach((f, i) => {
      expect(f.type).toBe("peaking");
      expect(f.frequency.value).toBe(EQ_BANDS[i]);
      expect(f.gain.value).toBe(0);
    });
    // source → masterGain → 10 filters → destination 串联
    expect(ctx.source.connect).toHaveBeenCalledWith(ctx.masterGain);
    expect(ctx.masterGain.connect).toHaveBeenCalledWith(ctx.filters[0]);
    ctx.filters.forEach((f, i) => {
      expect(f.connect).toHaveBeenCalledWith(i === 9 ? ctx.destination : ctx.filters[i + 1]);
    });
    // 音量主控初始化为当前音量（默认 1）
    expect(ctx.masterGain.gain.value).toBe(1);
  });

  it("创建前已设置的均衡器值在创建时应用（启动恢复持久化场景）", async () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    playbackSettings.eqPreset = "bass";
    playbackSettings.eqGains = [...EQ_PRESETS.bass.gains];
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    ctx.filters.forEach((f, i) => {
      expect(f.gain.value).toBe(EQ_PRESETS.bass.gains[i]);
    });
  });

  it("选择预设：增益应用 + eqGains 同步（作为切回自定义的基点）", () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    setEqPreset("rock");
    expect(playbackSettings.eqPreset).toBe("rock");
    expect(playbackSettings.eqGains).toEqual(EQ_PRESETS.rock.gains);
    // 图未创建：不抛错（创建时应用）
    expect(() => setEqPreset("jazz")).not.toThrow();
    expect(playbackSettings.eqGains).toEqual(EQ_PRESETS.jazz.gains);
  });

  it("非法预设 key 忽略", () => {
    setEqPreset("nonexistent");
    expect(playbackSettings.eqPreset).toBe("flat");
  });

  it("音量链路（2026-08-27 WKWebKit 修复）：图接管时走 masterGain 元素归一，未接管走元素音量", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    // 图接管：setVolume → masterGain.gain；元素音量恒 1
    setVolume(0.3);
    expect(ctx.masterGain.gain.value).toBe(0.3);
    expect(audioEq.volume).toBe(1);
    // 静音 → gain 0；取消恢复
    toggleMute();
    expect(ctx.masterGain.gain.value).toBe(0);
    toggleMute();
    expect(ctx.masterGain.gain.value).toBe(0.3);
    // 变速切裸元素：未接管 → 元素音量承载，masterGain 不动
    state.speed = 1.0;
    stepSpeed(-1);
    setVolume(0.7);
    expect(audioBare.volume).toBe(0.7);
    expect(ctx.masterGain.gain.value).toBe(0.3);
    // 回图元素：applyVolume 把音量同步到 masterGain，元素归一
    stepSpeed(1);
    expect(ctx.masterGain.gain.value).toBe(0.7);
    expect(audioEq.volume).toBe(1);
  });

  it("拖滑杆：切到自定义 + 值更新 + clamp ±12 + 实时应用到图", () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    setupSong();
    play();
    const ctx = FakeAudioContext.instances.at(-1);
    setEqGain(0, 6);
    expect(playbackSettings.eqGains[0]).toBe(6);
    expect(ctx.filters[0].gain.value).toBe(6);
    // clamp
    setEqGain(1, 99);
    expect(playbackSettings.eqGains[1]).toBe(12);
    setEqGain(2, -99);
    expect(playbackSettings.eqGains[2]).toBe(-12);
    // 越界 index 忽略
    setEqGain(10, 5);
    expect(playbackSettings.eqGains).toHaveLength(10);
  });

  it("关闭开关 = 全部 0dB 直通", async () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    playbackSettings.eqPreset = "bass";
    setupSong();
    play();
    const ctx = FakeAudioContext.instances.at(-1);
    playbackSettings.eqEnabled = false;
    await nextTick(); // 开关走 watch 异步应用
    ctx.filters.forEach((f) => expect(f.gain.value).toBe(0));
  });

  it("修改后自动持久化到 localStorage", async () => {
    localStorage.removeItem(PLAYBACK_SETTINGS_KEY);
    playbackSettings.eqEnabled = true;
    setEqPreset("vocal");
    await nextTick(); // 持久化 watch 异步落盘
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.eqEnabled).toBe(true);
    expect(saved.eqPreset).toBe("vocal");
    expect(saved.eqGains).toEqual(EQ_PRESETS.vocal.gains);
  });

  it("启动恢复：持久化的均衡器设置读回", async () => {
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({
        eqEnabled: true,
        eqPreset: "pop",
        eqGains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      }),
    );
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.playbackSettings.eqEnabled).toBe(true);
    expect(m.playbackSettings.eqPreset).toBe("pop");
    expect(m.playbackSettings.eqGains).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("脏数据归一化：eqGains 长度不对 → 重置；长度对但值非法 → clamp；非法预设 → flat", async () => {
    // 场景 A：长度不对 → 重置全 0
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ eqEnabled: true, eqPreset: "bad", eqGains: [99, "x", null] }),
    );
    vi.resetModules();
    let m = await import("../composables/usePlayer.js");
    expect(m.playbackSettings.eqGains).toHaveLength(10);
    expect(m.playbackSettings.eqGains[0]).toBe(0); // 长度 3 ≠ 10 → 整体重置
    expect(m.playbackSettings.eqPreset).toBe("flat"); // 非法预设回落
    // 场景 B：长度 10 但值非法 → 逐项 clamp/置 0
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ eqGains: [99, "x", null, -99, 3, 0, 0, 0, 0, 0] }),
    );
    vi.resetModules();
    m = await import("../composables/usePlayer.js");
    expect(m.playbackSettings.eqGains[0]).toBe(12); // clamp 99 → 12
    expect(m.playbackSettings.eqGains[1]).toBe(0); // "x" → 0
    expect(m.playbackSettings.eqGains[3]).toBe(-12); // clamp -99 → -12
  });

  it("无 AudioContext 环境（测试/旧浏览器）：静默降级，播放不抛错", () => {
    // 不 stub AudioContext（jsdom 无）
    setupSong();
    expect(() => play()).not.toThrow();
    // 设置均衡器也不抛错
    expect(() => {
      setEqPreset("bass");
      setEqGain(0, 3);
      playbackSettings.eqEnabled = true;
    }).not.toThrow();
  });

  it("变速切元素：0.75/1.25 切到裸元素（原生管线），回 1.0 切回图元素（EQ）", async () => {
    stubAudioContext();
    setupSong();
    await play(); // 建图，speed=1.0 活动元素 = audioEq（走 EQ 链）
    const ctx = FakeAudioContext.instances.at(-1);
    expect(audioEq).toBeDefined();
    expect(playerMod.audio).toBe(audioEq);
    expect(ctx.source.connect).toHaveBeenLastCalledWith(ctx.masterGain);

    state.speed = 1.0;
    stepSpeed(-1); // → 0.75：切到裸元素
    expect(state.speed).toBe(0.75);
    expect(playerMod.audio).toBe(audioBare);
    expect(playerMod.audio.playbackRate).toBe(0.75);

    stepSpeed(1); // → 1.0：切回图元素
    expect(state.speed).toBe(1.0);
    expect(playerMod.audio).toBe(audioEq);
    expect(playerMod.audio.playbackRate).toBe(1.0);

    stepSpeed(1); // → 1.25：再切裸元素
    expect(state.speed).toBe(1.25);
    expect(playerMod.audio).toBe(audioBare);
    expect(playerMod.audio.playbackRate).toBe(1.25);
  });

  it("变速中切歌：换源仍走裸元素（原生管线保持），回 1.0 状态迁移回图元素", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    state.speed = 1.0;
    stepSpeed(-1); // 0.75 切裸元素
    state.songs = [{ path: "/b.mp3", name: "B" }];
    state.currentIndex = 0;
    await nextSong();
    expect(playerMod.audio).toBe(audioBare); // 变速状态：新歌加载到裸元素
    expect(ctx.source.connect).toHaveBeenLastCalledWith(ctx.masterGain); // 图元素链路未被扰动
    state.speed = 0.75;
    stepSpeed(1); // 回 1.0：切回图元素
    expect(playerMod.audio).toBe(audioEq);
  });

  it("变速切换状态迁移：播放位置/音量/静音/src 同步到目标元素（双向）", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    audioEq.currentTime = 42;
    setVolume(0.6);
    toggleMute(); // muted=true：图接管 → masterGain.gain = 0
    state.speed = 1.0;
    stepSpeed(-1); // → 0.75：迁移到裸元素（未接管 → 元素音量承载静音）
    expect(playerMod.audio).toBe(audioBare);
    expect(audioBare.src).toBe(audioEq.src);
    expect(audioBare.currentTime).toBe(42);
    expect(audioBare.volume).toBe(0); // 静音以音量 0 承载（不再复制元素 muted）
    expect(audioBare.muted).toBe(false);
    toggleMute(); // 取消静音 → audioBare.volume = state.volume
    expect(audioBare.volume).toBe(0.6);
    // 回 1.0：反向迁移（变速期间位置推进；音量回到 masterGain）
    audioBare.currentTime = 55;
    stepSpeed(1);
    expect(playerMod.audio).toBe(audioEq);
    expect(audioEq.currentTime).toBe(55);
    expect(ctx.masterGain.gain.value).toBe(0.6); // 图接管 → 音量走 masterGain
    expect(audioEq.volume).toBe(1); // 元素音量归一（音量由 gain 承担）
  });
});

describe("队列拖拽排序 reorderQueue / persistQueueOrder（任务 A 第三项）", () => {
  const Q = [
    { id: "a", name: "A歌", path: "/a.mp3" },
    { id: "b", name: "B歌", path: "/b.mp3" },
    { id: "c", name: "C歌", path: "/c.mp3" },
    { id: "d", name: "D歌", path: "/d.mp3" },
  ];

  it("reorderQueue：把 from 位置的歌挪到 to（当前歌在移动歌之后 → 索引前移）", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 2; // 播 C
    reorderQueue(0, 2); // A 挪到 C 之后
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "A歌", "D歌"]);
    expect(state.currentIndex).toBe(1); // C 2 → 1
  });

  it("reorderQueue：移动的就是当前歌 → 当前索引跟随新位置", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 1;
    reorderQueue(1, 0); // B 挪到开头
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "A歌", "C歌", "D歌"]);
    expect(state.currentIndex).toBe(0);
  });

  it("reorderQueue：向后挪且跨过当前歌 → 当前索引前移", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 2; // C
    reorderQueue(0, 3); // A 挪到末尾（跨过 C）
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "D歌", "A歌"]);
    expect(state.currentIndex).toBe(1);
  });

  it("reorderQueue：向前挪且跨过当前歌 → 当前索引后移", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 1; // B
    reorderQueue(3, 0); // D 挪到开头（跨过 B）
    expect(state.songs.map((s) => s.name)).toEqual(["D歌", "A歌", "B歌", "C歌"]);
    expect(state.currentIndex).toBe(2);
  });

  it("reorderQueue：越界 / 相同位置 → 无操作", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 0;
    reorderQueue(0, 0);
    reorderQueue(-1, 2);
    reorderQueue(0, 99);
    reorderQueue(99, 0);
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌", "C歌", "D歌"]);
    expect(state.currentIndex).toBe(0);
  });

  it("reorderQueue：shuffle 模式下不冲突（洗牌队列失效，下次自动重建，不崩）", () => {
    state.songs = Q.map((s) => ({ ...s }));
    state.currentIndex = 0;
    cyclePlayMode(); // order → shuffle
    expect(state.playMode).toBe("shuffle");
    reorderQueue(0, 2);
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "C歌", "A歌", "D歌"]);
    // 洗牌队列已失效：切歌仍能正常推进（内部 ensureShuffleQueue 重建）
    expect(() => nextSong()).not.toThrow();
  });

  it("persistQueueOrder：PUT /api/queue/order 保存顺序键数组（网络歌用 stream: 前缀）", async () => {
    state.songs = [
      { id: "a", name: "A歌", path: "/a.mp3" },
      { id: "s", name: "网歌", type: "stream", streamId: "9", path: null },
      { id: "b", name: "B歌", path: "/b.mp3" },
    ];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    await persistQueueOrder();
    const call = fetchMock.mock.calls.find(([u]) => String(u).includes("/api/queue/order"));
    expect(call).toBeTruthy();
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(call[1].body).paths).toEqual(["/a.mp3", "stream:9", "/b.mp3"]);
  });

  it("persistQueueOrder：非 200 → 抛错（调用方 toast）", async () => {
    state.songs = [{ id: "a", name: "A歌", path: "/a.mp3" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    await expect(persistQueueOrder()).rejects.toThrow();
  });

  it("loadQueueOrder + loadSongs：刷新后按保存顺序恢复（round-trip）", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/queue/order")) {
        return { ok: true, json: async () => ({ paths: ["/c.mp3", "/a.mp3", "/b.mp3"] }) };
      }
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
            { id: "c", name: "C歌", path: "/c.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadQueueOrder();
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["C歌", "A歌", "B歌"]);
    expect(state.currentIndex).toBe(1); // A 现在在位置 1
    expect(state.currentSong.name).toBe("A歌");
  });

  it("loadSongs：保存顺序与曲库无交集（换库/清库）→ 保持默认顺序", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/queue/order")) {
        return { ok: true, json: async () => ({ paths: ["/old1.mp3", "/old2.mp3"] }) };
      }
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadQueueOrder();
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌"]);
    expect(state.currentIndex).toBe(0);
  });

  it("loadSongs：新歌（保存顺序之外）按曲库顺序补在末尾", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/queue/order")) {
        return { ok: true, json: async () => ({ paths: ["/b.mp3"] }) };
      }
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadQueueOrder();
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["B歌", "A歌"]);
  });

  it("loadSongs：未加载过队列顺序（queueOrder 为 null）→ 不重排", async () => {
    const fetchMock = vi.fn(async (url) => {
      const u = String(url);
      if (u.includes("/api/songs")) {
        return {
          ok: true,
          json: async () => [
            { id: "a", name: "A歌", path: "/a.mp3" },
            { id: "b", name: "B歌", path: "/b.mp3" },
          ],
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal("fetch", fetchMock);
    state.currentIndex = 0;
    state.currentSong = { id: "a", name: "A歌", path: "/a.mp3" };
    await loadSongs();
    expect(state.songs.map((s) => s.name)).toEqual(["A歌", "B歌"]);
  });
});
