// usePlayer composable 单元测试 — MediaSession 系统媒体键
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { afterEach, describe, expect, it, vi } from "vitest";
import { state, selectSong, setupMediaSession, FakeAudio } from "./helpers/usePlayerHarness.js";

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
