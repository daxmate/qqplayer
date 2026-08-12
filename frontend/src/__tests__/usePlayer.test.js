// usePlayer composable 单元测试
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
class FakeAudio {
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
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

const { state, cycleSpeed, nextSong, prevSong, toggleKaraoke, toggleZh, loadSongs, selectSong } =
  await import("../composables/usePlayer.js");

const RESET = {
  songs: [],
  currentIndex: -1,
  currentSong: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  mode: "continuous",
  karaokeOn: true,
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
