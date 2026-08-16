// 流媒体播放前端核心测试（任务 B）
// 覆盖：playPreview 试听语义（不改 songs/currentIndex、ended 不自动切、切歌回主队列）/
// stream 歌播放（取直链成功 / 失败重试 / 重试失败 toast）/ 统计开关（试听不上报、stream 歌上报）/
// URL 播放（title 派生 / 非法 URL / 电台流不崩）/ 非本地歌在线歌词
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册；与 usePlayer.test.js 同款）
class FakeAudio {
  static instances = [];
  constructor() {
    this._src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.ended = false;
    this.volume = 1;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
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
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub
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
  selectSong,
  nextSong,
  prevSong,
  playPreview,
  playUrl,
  playbackSettings,
  playerToast,
  _resetPlayerToast,
  _resetPlaybackSession,
  _resetPlayMode,
} = await import("../composables/usePlayer.js");

const audio = () => FakeAudio.instances[0];

// 网络直链 → 同源代理 URL（与 playerCore.streamProxyUrl 同款格式）
const PROXY_SRC = (u) => "/api/stream/proxy?url=" + encodeURIComponent(u);

const LOCAL_SONGS = [
  { path: "/lib/a.mp3", name: "A", artist: "甲", album: "一" },
  { path: "/lib/b.mp3", name: "B", artist: "乙", album: "二" },
  { path: "/lib/c.mp3", name: "C", artist: "丙", album: "三" },
];

const STREAM_SONG = {
  type: "stream",
  streamId: "netease-123",
  provider: "netease",
  path: null,
  name: "晴",
  artist: "歌手",
  album: "专辑",
  duration: 240,
  coverUrl: "http://img.example.com/cover.jpg",
};

const LYRIC_RESULTS = [
  {
    source: "netease",
    id: "123",
    title: "晴",
    artist: "歌手",
    duration: 240,
    cover: null,
    text: "[00:01.00]第一句\n[00:05.00]第二句",
    tlyric: "[00:01.00]中文一\n[00:05.00]中文二",
  },
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
  lyric: [],
  lyricFormat: null,
  lyricSource: null,
  lastSource: "manual",
};

beforeEach(() => {
  Object.assign(state, RESET);
  playbackSettings.streamStats = false;
  _resetPlaybackSession();
  _resetPlayMode();
  _resetPlayerToast();
  // 模块级 audio 单例跨用例残留：重置 src/时长/播放态
  const a = audio();
  if (a) {
    a.src = "";
    a.currentTime = 0;
    a.duration = 0;
    a.paused = true;
    a.ended = false;
  }
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// fetch 路由 mock：stream 直链（可配失败次数）/ 在线歌词候选 / POST /api/playback 收集
function stubFetch(opts = {}) {
  const { streamFails = 0, lyricResults = null } = opts;
  const playbackCalls = [];
  let streamCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const u = String(url);
      if (u.startsWith("/api/stream/url")) {
        streamCalls++;
        if (streamCalls <= streamFails) {
          return { ok: false, status: 502, json: async () => ({ detail: "boom" }) };
        }
        return {
          ok: true,
          json: async () => ({
            url: "http://stream.example.com/song.mp3",
            level: "exhigh",
            ext: "mp3",
          }),
        };
      }
      if (u.startsWith("/api/lyric/search")) {
        return { ok: true, json: async () => ({ results: lyricResults || [] }) };
      }
      if (u === "/api/playback" && init?.method === "POST") {
        playbackCalls.push(JSON.parse(init.body));
        return { ok: true, json: async () => ({}) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
  return { playbackCalls, streamCalls: () => streamCalls };
}

describe("playPreview 试听语义（临时播放列表）", () => {
  it("试听：不改 state.songs / currentIndex，currentSong 置为试听歌，取直链播放", async () => {
    const { streamCalls } = stubFetch({ lyricResults: LYRIC_RESULTS });
    state.songs = [...LOCAL_SONGS];
    await selectSong(1); // 主队列播第 2 首
    await playPreview({ id: "123", title: "晴", artist: "歌手", album: "专辑" });

    expect(state.songs).toHaveLength(3); // 队列未动
    expect(state.currentIndex).toBe(1); // currentIndex 未动
    expect(state.currentSong.type).toBe("preview");
    expect(state.currentSong.name).toBe("晴");
    expect(state.currentSong.path).toBeNull();
    expect(audio().src).toBe(PROXY_SRC("http://stream.example.com/song.mp3"));
    expect(streamCalls()).toBe(1); // 实时取直链一次
    // 试听歌词：在线匹配（/api/lyric/search + 前端 LRC 解析）
    expect(state.lyric.length).toBe(2);
    expect(state.lyric[0].text[0]).toBe("第一句");
    expect(state.lyric[0].text[2]).toBe("中文一"); // tlyric 合并
    expect(state.lyricFormat).toBe("lrc");
    expect(state.lyricSource).toBe("netease");
  });

  it("试听播完（ended）自然停止，不自动 nextSong", async () => {
    stubFetch();
    state.songs = [...LOCAL_SONGS];
    await selectSong(1);
    await playPreview({ id: "123", title: "晴" });
    const a = audio();
    const playSpy = vi.spyOn(a, "play");
    a.listeners["ended"]();
    expect(state.currentSong.type).toBe("preview"); // 仍是试听歌
    expect(state.currentIndex).toBe(1); // 主队列位置未动
    expect(state.isPlaying).toBe(false); // 自然停止
    expect(playSpy).not.toHaveBeenCalled(); // 不自动重播 / 不自动切歌
  });

  it("试听中 nextSong → 回主队列下一首（基于未动的 currentIndex）", async () => {
    stubFetch();
    state.songs = [...LOCAL_SONGS];
    await selectSong(1);
    await playPreview({ id: "123", title: "晴" });
    await nextSong();
    expect(state.currentSong.name).toBe("C");
    expect(state.currentIndex).toBe(2);
    expect(state.currentSong.type).toBeUndefined(); // 主队列本地歌
    expect(audio().src).toBe("/api/audio?path=" + encodeURIComponent("/lib/c.mp3"));
  });

  it("试听中 prevSong → 回主队列上一首", async () => {
    stubFetch();
    state.songs = [...LOCAL_SONGS];
    await selectSong(1);
    await playPreview({ id: "123", title: "晴" });
    await prevSong();
    expect(state.currentSong.name).toBe("A");
    expect(state.currentIndex).toBe(0);
  });

  it("试听中 selectSong → 主队列正常播放", async () => {
    stubFetch();
    state.songs = [...LOCAL_SONGS];
    await selectSong(2);
    await playPreview({ id: "123", title: "晴" });
    await selectSong(0);
    expect(state.currentSong.path).toBe("/lib/a.mp3");
    expect(state.currentIndex).toBe(0);
  });
});

describe("stream 歌播放（曲库网络条目）", () => {
  it("selectSong stream 歌：实时取直链 → audio.src = 代理 URL（不走 /api/audio）", async () => {
    const { streamCalls } = stubFetch();
    state.songs = [STREAM_SONG, ...LOCAL_SONGS];
    await selectSong(0);
    expect(streamCalls()).toBe(1);
    expect(audio().src).toBe(PROXY_SRC("http://stream.example.com/song.mp3"));
    expect(state.currentIndex).toBe(0);
  });

  it("取直链失败 → 重试一次（共 2 次请求）→ 仍失败 toast，不播放", async () => {
    const { streamCalls } = stubFetch({ streamFails: 2 });
    state.songs = [STREAM_SONG];
    await selectSong(0);
    expect(streamCalls()).toBe(2); // 失败重试一次
    expect(audio().src).toBe(""); // 未播放，旧源已清
    expect(playerToast.err).toBe(true);
    expect(playerToast.msg).toContain("晴");
  });

  it("第一次失败、重试成功 → 正常播放，无 toast", async () => {
    const { streamCalls } = stubFetch({ streamFails: 1 });
    state.songs = [STREAM_SONG];
    await selectSong(0);
    expect(streamCalls()).toBe(2);
    expect(audio().src).toBe(PROXY_SRC("http://stream.example.com/song.mp3"));
    expect(playerToast.msg).toBe("");
  });

  it("stream 歌封面：coverUrl 网络图直用，不走 /api/cover", async () => {
    const { mount } = await import("@vue/test-utils");
    const { nextTick } = await import("vue");
    const Cover = (await import("../components/Cover.vue")).default;
    const w = mount(Cover, { props: { song: STREAM_SONG } });
    await nextTick();
    const img = w.find(".cover-img");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("http://img.example.com/cover.jpg"); // 直用网络图
    w.unmount();
  });
});

describe("播放统计：streamStats 开关", () => {
  async function startPreview() {
    await playPreview({ id: "123", title: "晴" });
    const a = audio();
    a.duration = 200;
    state.duration = 200;
    return a;
  }

  it("streamStats 关：试听播放后 flush 不上报", async () => {
    const { playbackCalls } = stubFetch();
    playbackSettings.streamStats = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    const a = await startPreview();
    a.listeners["play"](); // 建会话（playPreview 内 audio.play 已触发，这里幂等）
    vi.setSystemTime(new Date("2026-08-16T00:00:30Z")); // 播了 30s
    a.listeners["pause"]();
    expect(playbackCalls).toHaveLength(0);
    vi.useRealTimers();
  });

  it("streamStats 开：试听播放后正常上报（source=preview）", async () => {
    const { playbackCalls } = stubFetch();
    playbackSettings.streamStats = true;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    const a = await startPreview();
    a.listeners["play"]();
    vi.setSystemTime(new Date("2026-08-16T00:00:30Z"));
    a.listeners["pause"]();
    expect(playbackCalls).toHaveLength(1);
    expect(playbackCalls[0].source).toBe("preview");
    expect(playbackCalls[0].name).toBe("晴");
    expect(playbackCalls[0].played).toBe(30);
    vi.useRealTimers();
  });

  it("streamStats 关：曲库网络条目（stream 歌）正常上报（source=stream）", async () => {
    const { playbackCalls } = stubFetch();
    playbackSettings.streamStats = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    state.songs = [STREAM_SONG];
    await selectSong(0);
    const a = audio();
    a.duration = 240;
    state.duration = 240;
    a.listeners["play"]();
    vi.setSystemTime(new Date("2026-08-16T00:00:30Z"));
    a.listeners["pause"]();
    expect(playbackCalls).toHaveLength(1);
    expect(playbackCalls[0].source).toBe("stream");
    expect(playbackCalls[0].path).toBeNull();
    vi.useRealTimers();
  });

  it("URL 播放：streamStats 关时不上报（关页面 beacon 也跳过）", async () => {
    const { playbackCalls } = stubFetch();
    playbackSettings.streamStats = false;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-16T00:00:00Z"));
    await playUrl("https://radio.example.com/live");
    const a = audio();
    a.listeners["play"]();
    vi.setSystemTime(new Date("2026-08-16T00:00:30Z"));
    // pagehide → sendBeacon 兜底：不打 /api/playback
    const sendBeacon = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, sendBeacon });
    window.dispatchEvent(new Event("pagehide"));
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(playbackCalls).toHaveLength(0);
    vi.useRealTimers();
  });
});

describe("URL 播放（playUrl）", () => {
  it("合法 URL：audio.src = 代理 URL，title 取文件名，type=url", async () => {
    const { streamCalls } = stubFetch();
    await playUrl("https://example.com/radio/station.mp3");
    expect(audio().src).toBe(PROXY_SRC("https://example.com/radio/station.mp3"));
    expect(state.currentSong.type).toBe("url");
    expect(state.currentSong.name).toBe("station.mp3");
    expect(state.currentSong.path).toBeNull();
    expect(streamCalls()).toBe(0); // URL 播放不走 /api/stream/url
  });

  it("title 无文件名时取域名", async () => {
    stubFetch();
    await playUrl("https://radio.example.com/");
    expect(state.currentSong.name).toBe("radio.example.com");
  });

  it("非法 URL → toast，不播放", async () => {
    stubFetch();
    await playUrl("ftp://example.com/a.mp3");
    expect(playerToast.err).toBe(true);
    expect(state.currentSong).toBeNull();
    expect(audio().src).toBe("");
  });

  it("电台流（duration=Infinity）→ loadedmetadata 后 duration 保持 0，不崩", async () => {
    stubFetch();
    await playUrl("https://radio.example.com/live");
    const a = audio();
    a.duration = Infinity;
    a.listeners["loadedmetadata"]();
    expect(state.duration).toBe(0); // 进度条走空态
    expect(state.currentSong.type).toBe("url");
  });

  it("普通流 → loadedmetadata 后 duration 正常", async () => {
    stubFetch();
    await playUrl("https://example.com/a.mp3");
    const a = audio();
    a.duration = 180;
    a.listeners["loadedmetadata"]();
    expect(state.duration).toBe(180);
  });
});

describe("非本地歌在线歌词（loadLyric）", () => {
  it("stream 歌 loadLyric：走 /api/lyric/search 候选 + 前端 LRC 解析（含翻译合并）", async () => {
    stubFetch({ lyricResults: LYRIC_RESULTS });
    state.songs = [STREAM_SONG];
    await selectSong(0);
    expect(state.lyric.length).toBe(2);
    expect(state.lyric[0]).toMatchObject({
      type: "line",
      s: 1,
      e: 5,
      text: ["第一句", "", "中文一"],
    });
    expect(state.lyric[1]).toMatchObject({ type: "line", s: 5, text: ["第二句", "", "中文二"] });
    expect(state.lyricFormat).toBe("lrc");
  });

  it("候选无结果 → 空歌词（不抛错）", async () => {
    stubFetch({ lyricResults: [] });
    state.songs = [STREAM_SONG];
    await selectSong(0);
    expect(state.lyric).toEqual([]);
    expect(state.lyricFormat).toBeNull();
  });

  it("本地歌照旧走 /api/lyric（path 非空不受影响）", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).startsWith("/api/lyric?")) {
          return {
            ok: true,
            json: async () => ({
              format: "lrc",
              lines: [{ type: "line", s: 0, e: 5, text: ["本地"] }],
              source: "local",
            }),
          };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );
    state.songs = [...LOCAL_SONGS];
    await selectSong(0);
    expect(state.lyric[0].text[0]).toBe("本地");
    expect(calls.some((c) => c.startsWith("/api/lyric?"))).toBe(true);
    expect(calls.some((c) => c.startsWith("/api/lyric/search"))).toBe(false);
  });
});
