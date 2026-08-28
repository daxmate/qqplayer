// playerCore 恢复播放 resumeAt 监听器劫持新歌回归测试（2026-08-26 复发根因）。
//
// 症状：恢复上次播放（resumeAt=旧断点）后，后续每首新歌都被 seek 到旧断点
// （固定秒数开始播/歌不够长直接尾部跳过）。2026-08-25 首修（4eb9c8f）把监听器
// 改为模块级引用 + 挂新前移除旧的；2026-08-26 复发——清理+挂载在 await loadLyric
// 之后，而 audio.src 赋值在前：原生加载完成即 emit loadedmetadata，歌词加载慢时
// （网络请求）竞态窗口内旧监听器（带旧断点）仍活着 → 劫持新歌。
//
// 本测试模拟完整时序：恢复播放 → 自然切歌 → loadedmetadata 在 loadLyric 完成前到达，
// 断言新歌不被旧断点 seek。旧实现（清理在 loadLyric 后）此用例必红。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Audio stub：playerCore 模块加载即 new Audio()（audioEq/audioBare）
class FakeAudio {
  _src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, Array<() => void>> = {};

  set src(v: string) {
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
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    const arr = this.listeners[ev] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
}
vi.stubGlobal("Audio", FakeAudio);

const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = String(v);
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};
function clearLs() {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

/** 原生 Audio 代理 stub 形状（对齐 nativeAudioBridge createNativeAudioProxy 返回） */
interface FakeNativeProxy {
  _src: string;
  currentTime: number;
  volume: number;
  muted: boolean;
  playbackRate: number;
  paused: boolean;
  ended: boolean;
  duration: number;
  listeners: Record<string, Array<(e: unknown) => void>>;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(attr: string): void;
  addEventListener(ev: string, fn: (e: unknown) => void): void;
  removeEventListener(ev: string, fn: (e: unknown) => void): void;
}

// ---------- mock：nativeAudioBridge（与 prefetch.test.js 同款，但 src setter 对齐
// 真实代理的换源清零语义——nativeAudioBridge.js src setter 会清 nativeState
// currentTime/duration/ended，2026-08-25 3e73bc7 防御；测试要复现真实时序必须一致） ----------
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: unknown) => void>>();
  let proxy: FakeNativeProxy | null = null;
  const makeProxy = (): FakeNativeProxy => {
    const p = {
      _src: "",
      currentTime: 0,
      volume: 1,
      muted: false,
      playbackRate: 1,
      paused: true,
      ended: false,
      duration: 0,
      listeners: {} as Record<string, Array<(e: unknown) => void>>,
      play() {
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
      load() {},
      removeAttribute(attr: string) {
        if (attr === "src") this._src = "";
      },
      addEventListener(ev: string, fn: (e: unknown) => void) {
        (this.listeners[ev] = this.listeners[ev] || []).push(fn);
      },
      removeEventListener(ev: string, fn: (e: unknown) => void) {
        const arr = this.listeners[ev] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
    };
    Object.defineProperty(p, "src", {
      get(this: FakeNativeProxy) {
        return this._src;
      },
      set(this: FakeNativeProxy, v: string) {
        this._src = v ? String(v) : "";
        if (v) {
          // 对齐真实代理：换源即清零进度/时长镜像（残留进度不得污染新歌）
          this.currentTime = 0;
          this.duration = 0;
          this.ended = false;
        }
      },
    });
    return p;
  };
  return {
    handlers,
    post: vi.fn(),
    isNativePlayback: vi.fn(() => true),
    createNativeAudioProxy: vi.fn(() => {
      if (!proxy) proxy = makeProxy();
      return proxy;
    }),
    onNativeEvent: vi.fn((name: string, fn: (e: unknown) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name)!.add(fn);
      return () => {
        handlers.get(name)?.delete(fn);
      };
    }),
    registerRemoteCommandHandler: vi.fn(),
    registerNativeSongChangedHandler: vi.fn(),
    resolveNativeUrl: vi.fn((url: string) => url),
    nativeSendMetadata: vi.fn(),
    resolveCoverURL: vi.fn(() => ""),
    getProxy: (): FakeNativeProxy | null => proxy,
    /** 模拟原生侧 loadedmetadata 到达 → 代理监听器触发（与真实 emit 同语义：
     *  nativeAudioBridge 先更新 nativeState.duration 镜像再 emit） */
    fireLoadedMetadata(duration: number) {
      if (proxy) {
        proxy.duration = duration;
      }
      const arr = (proxy?.listeners || {})["loadedmetadata"] || [];
      for (const fn of [...arr]) {
        try {
          fn({ type: "loadedmetadata", duration });
        } catch {
          /* 单个监听器异常不中断 */
        }
      }
    },
  };
});

vi.mock("../composables/nativeAudioBridge.js", () => ({
  isNativePlayback: bridgeMock.isNativePlayback,
  createNativeAudioProxy: bridgeMock.createNativeAudioProxy,
  registerRemoteCommandHandler: bridgeMock.registerRemoteCommandHandler,
  registerNativeSongChangedHandler: bridgeMock.registerNativeSongChangedHandler,
  resolveNativeUrl: bridgeMock.resolveNativeUrl,
  nativeSendMetadata: bridgeMock.nativeSendMetadata,
  resolveCoverURL: bridgeMock.resolveCoverURL,
  nativePost: bridgeMock.post,
  onNativeEvent: bridgeMock.onNativeEvent,
}));

// sync.js 部分 mock：cachedCoverURL/cacheCover 可控；ensureAsset/hasAsset 走真实
// 实现但测试不注入 assetStatus 回执 → maybePrefetchAsset 停留在等待（fire-and-forget，
// 不影响 selectSong 主流程；本测试聚焦 loadedMetaHandler 劫持路径）
vi.mock("../utils/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/sync.js")>();
  return {
    ...actual,
    cachedCoverURL: vi.fn().mockResolvedValue(null),
    cacheCover: vi.fn(),
  };
});

const coverToDataURLMock = vi.fn(async (url: string) => url);
vi.mock("../utils/coverDataURL.js", () => ({
  coverToDataURL: coverToDataURLMock,
}));

const playerMod = await import("../composables/usePlayer.js");
const { state, selectSong } = playerMod;

const SONGS = [
  { path: "/Music/song-0.mp3", name: "Song 0", artist: "A" },
  { path: "/Music/song-1.mp3", name: "Song 1", artist: "B" },
  { path: "/Music/song-2.mp3", name: "Song 2", artist: "C" },
];

describe("selectSong 恢复播放断点监听器", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
    bridgeMock.post.mockClear();
    Object.assign(state, {
      songs: [...SONGS],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      lyric: [],
      lyricFormat: null,
      lyricSource: null,
      abLoop: null,
      playMode: "order",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("恢复播放 seek 到断点（功能正常）", async () => {
    const p = selectSong(0, { resumeAt: 57.5, record: false });
    bridgeMock.fireLoadedMetadata(239); // 恢复歌加载完成
    await p;
    const proxy = bridgeMock.getProxy()!;
    expect(proxy.currentTime).toBe(57.5);
  });

  it("恢复播放后自然切歌：新歌不被旧断点劫持（loadedmetadata 早于 loadLyric 完成）", async () => {
    // 1. 恢复播放：挂带 resumeAt=57.5 的监听器，第一首歌 seek 到断点
    const p1 = selectSong(0, { resumeAt: 57.5, record: false });
    bridgeMock.fireLoadedMetadata(239);
    await p1;
    const proxy = bridgeMock.getProxy()!;
    expect(proxy.currentTime).toBe(57.5);

    // 2. 自然切歌（autoPlay，无 resumeAt）
    const p2 = selectSong(1, { autoPlay: true, record: false });
    // 换源清零后应回到 0（真实代理语义）
    expect(proxy.currentTime).toBe(0);
    // 3. 竞态窗口：loadLyric（网络请求）尚未完成时，新歌 loadedmetadata 到达
    bridgeMock.fireLoadedMetadata(314);
    await p2;
    // 4. 新歌不得被 seek 到旧断点（旧实现此处 currentTime 变 57.5 = 劫持）
    expect(proxy.currentTime).toBe(0);
    expect(state.currentTime).toBe(0);
  });

  it("连续切歌：每首都不带旧断点（多轮循环安全）", async () => {
    await selectSong(0, { resumeAt: 57.5, record: false });
    const proxy = bridgeMock.getProxy()!;
    // 多轮自然切歌，每轮都在 loadLyric 完成前注入 loadedmetadata
    for (let i = 1; i < SONGS.length; i++) {
      const p = selectSong(i, { autoPlay: true, record: false });
      bridgeMock.fireLoadedMetadata(200 + i * 100);
      await p;
      expect(proxy.currentTime).toBe(0);
      expect(state.currentTime).toBe(0);
    }
  });
});
