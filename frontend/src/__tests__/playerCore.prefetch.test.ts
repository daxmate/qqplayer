// playerCore.maybePrefetchAsset 单元测试：iOS 壳「播放本地资产优先」链路（E1 修复）
//
// 覆盖：已下载 → 切本地播放（同歌校验/续播/进度 seek）、未下载 → 保持远程播放、
// autoPrefetch 关不触发下载、iOS 壳外 / 流媒体条目 no-op、回执迟到时已切歌不切源。
//
// mock 策略（参考 usePlayer.test.js / sync.test.js 风格）：
//   - nativeAudioBridge：vi.mock 整模块——isNativePlayback 可切换（默认 true），
//     createNativeAudioProxy 返回 FakeNativeProxy（src/paused/currentTime/事件监听），
//     onNativeEvent 捕获订阅者 / nativePost 记录消息
//   - sync.js 走真实模块：maybePrefetchAsset → assetForSong → ensureAsset → hasAsset →
//     assetStatus 回执（含 autoPrefetch 门控下载）全链路真实跑，事件经 mock 的
//     onNativeEvent 注入——与 iOS 壳真实行为一致
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Song } from "../composables/usePlayer.js";

// Audio stub：playerCore 模块加载即 new Audio()（audioEq/audioBare）
class FakeAudio {
  static instances: FakeAudio[] = [];
  _src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, Array<() => void>> = {};

  constructor() {
    FakeAudio.instances.push(this);
  }
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

// jsdom（vitest 4）无 localStorage → 手写 stub（同 syncAssets.test.js 风格；
// autoPrefetch 开关判定依赖）
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
  playCalls: number;
  src: string;
  listeners: Record<string, Array<(e: unknown) => void>>;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(attr: string): void;
  addEventListener(ev: string, fn: (e: unknown) => void): void;
  removeEventListener(ev: string, fn: (e: unknown) => void): void;
}

// ---------- mock：nativeAudioBridge（原生播放语义代理 + 事件订阅/发消息） ----------
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(e: unknown) => void>>(); // name → Set<fn>
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
      playCalls: 0,
      src: "", // 运行时经 defineProperty 换成 get/set，先占位满足接口
      listeners: {} as Record<string, Array<(e: unknown) => void>>,
      play() {
        this.paused = false;
        this.playCalls += 1;
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
    // 模拟真实 nativeSendMetadata 行为：coverOverride 优先，空则 song.coverUrl / 远程兑底
    // （与 nativeAudioBridge.js 同款逻辑；本环境无 server base → 远程兜底返回相对路径）
    nativeSendMetadata: vi.fn(
      (
        song: { coverUrl?: string; path?: string | null } | null | undefined,
        coverOverride = "",
      ) => {
        let cover = coverOverride;
        if (!cover && song) {
          if (song.coverUrl) cover = song.coverUrl;
          else if (song.path) cover = "/api/cover?path=" + encodeURIComponent(song.path);
        }
        return cover;
      },
    ),
    // 与 nativeAudioBridge.js resolveCoverURL 同款逻辑（playerCore 封面解析用）
    resolveCoverURL: vi.fn(
      (song: { coverUrl?: string; path?: string | null } | null | undefined) => {
        if (!song) return "";
        if (song.coverUrl) return song.coverUrl;
        if (song.path) return "/api/cover?path=" + encodeURIComponent(song.path);
        return "";
      },
    ),
    getProxy: (): FakeNativeProxy | null => proxy,
    /** 模拟原生侧回推事件 */
    emit(name: string, payload: unknown) {
      const set = handlers.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch {
          /* 订阅者异常不中断派发 */
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

// sync.js 部分 mock：cachedCoverURL / cacheCover 换可控 vi.fn（封面本地优先测试需要
// 注入本地/未缓存/乱序结果）；其余导出（ensureAsset/assetForSong/_resetSyncForTests/
// setAutoPrefetch 等）走真实实现——maybePrefetchAsset 全链路（哈希/assetStatus 回执）
// 保持真实跑，既有用例行为不变。
vi.mock("../utils/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/sync.js")>();
  return {
    ...actual,
    cachedCoverURL: vi.fn(),
    cacheCover: vi.fn(),
  };
});

// coverDataURL 换可控 vi.fn：默认 identity（原样返回 URL）——既有用例期望封面 URL 透传；
// resolveCoverForMetadata 新用例里用 mockResolvedValue/mockRejectedValue 注入 data URL/失败。
const coverToDataURLMock = vi.fn(async (url: string) => url);
vi.mock("../utils/coverDataURL.js", () => ({
  coverToDataURL: coverToDataURLMock,
}));

// ---------- 被测模块（动态导入：须在 Audio stub 之后） ----------
const playerMod = await import("../composables/usePlayer.js");
const sync = await import("../utils/sync.js");

// sync.js 部分 mock 后的可控 vi.fn 视图（mock 是运行时替换，静态类型仍是真实签名 →
// 经 vi.mocked 取 Mock 类型，.mockReset/.mockResolvedValue 才能过类型检查）
const cachedCoverURLMock = vi.mocked(sync.cachedCoverURL);
const cacheCoverMock = vi.mocked(sync.cacheCover);

const { state, maybePrefetchAsset, resolveCoverForMetadata } = playerMod;

/** 等待异步链排空（assetForSong 哈希 / ensureAsset 回执结算 / 批量下载 flush）
 *  jsdom 下 crypto.subtle.digest 完成比 setTimeout(0) 慢，给 30ms 余量 */
function flush() {
  return new Promise<void>((r) => setTimeout(r, 30));
}

function resetProxy() {
  const proxy = bridgeMock.getProxy();
  if (!proxy) return;
  proxy._src = "";
  proxy.currentTime = 0;
  proxy.volume = 1;
  proxy.muted = false;
  proxy.playbackRate = 1;
  proxy.paused = true;
  proxy.ended = false;
  proxy.duration = 0;
  proxy.playCalls = 0;
}

describe("maybePrefetchAsset：播放本地资产优先（iOS 壳）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    bridgeMock.isNativePlayback.mockReturnValue(true);
    resetProxy();
    Object.assign(state, {
      songs: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      muted: false,
      volume: 1,
      favorites: [],
      playlists: [],
      loading: false,
      error: "",
    });
    sync._resetSyncForTests();
    // 原生壳环境（真实 sync.js 的 syncEnabled/iosBridgeAvailable 判定）
    window.qqplayerNative = true;
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs(); // autoPrefetch 复位为默认关
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("已下载：hasAsset 回执 localURL → 切本地播放（续播 + loadedmetadata 后 seek 保留进度）", async () => {
    const proxy = bridgeMock.getProxy()!;
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    const remoteSrc = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";
    proxy._src = remoteSrc; // 远程播放中
    proxy.paused = false; // wasPlaying
    proxy.currentTime = 42;

    const p = maybePrefetchAsset(state.currentSong!); // 真实调用点传 state.currentSong（响应式代理）
    await flush(); // assetForSong（哈希）完成后 hasAsset 已发出
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    expect(hasAssetCall).toBeTruthy(); // 总是查本地资产（不再被 autoPrefetch 挡在门外）
    const { path, requestId } = hasAssetCall[0];
    expect(path).toMatch(/^audio\//);

    const localURL = "file:///Documents/qqplayer-assets/" + path;
    bridgeMock.emit("assetStatus", { requestId, path, exists: true, localURL });
    await p;

    expect(proxy.src).toBe(localURL); // 已下载 → 切本地播放
    expect(proxy.playCalls).toBe(1); // wasPlaying → 续播
    // 进度保留：loadedmetadata 后 seek 到断点
    for (const fn of [...(proxy.listeners.loadedmetadata || [])]) fn({ duration: 180 });
    expect(proxy.currentTime).toBe(42);
    expect(state.currentTime).toBe(42);
  });

  it("未下载：保持远程播放，autoPrefetch 默认关不发下载（只查不下载）", async () => {
    const proxy = bridgeMock.getProxy()!;
    const song = { path: "/Music/b.flac", name: "B" };
    state.currentSong = song;
    const remoteSrc = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fb.flac";
    proxy._src = remoteSrc;
    proxy.paused = true;

    const p = maybePrefetchAsset(state.currentSong!);
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    expect(hasAssetCall).toBeTruthy();
    bridgeMock.emit("assetStatus", {
      requestId: hasAssetCall[0].requestId,
      path: hasAssetCall[0].path,
      exists: false,
      localURL: "",
    });
    await p;
    await flush();

    expect(proxy.src).toBe(remoteSrc); // 未切源
    expect(bridgeMock.post.mock.calls.some((c) => c[0].cmd === "syncDownload")).toBe(false);
  });

  it("autoPrefetch 开启 + 未下载：发 syncDownload，但源仍保持远程（不阻塞）", async () => {
    sync.setAutoPrefetch(true);
    const proxy = bridgeMock.getProxy()!;
    const song = { path: "/Music/c.mp3", name: "C" };
    state.currentSong = song;
    const remoteSrc = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fc.mp3";
    proxy._src = remoteSrc;
    proxy.paused = true;

    const p = maybePrefetchAsset(state.currentSong!);
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    bridgeMock.emit("assetStatus", {
      requestId: hasAssetCall[0].requestId,
      path: hasAssetCall[0].path,
      exists: false,
      localURL: "",
    });
    await p;
    await flush();

    expect(proxy.src).toBe(remoteSrc); // 保持远程
    const dl = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "syncDownload");
    expect(dl).toBeTruthy(); // autoPrefetch 开 → 后台下载
  });

  it("回执到达时已切歌：不切本地源（同一首歌校验）", async () => {
    const proxy = bridgeMock.getProxy()!;
    state.currentSong = { path: "/Music/a.mp3", name: "A" };
    proxy._src = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";

    const p = maybePrefetchAsset(state.currentSong!); // 传当前歌引用
    await flush();
    state.currentSong = { path: "/Music/other.mp3", name: "Other" }; // 回执到达前已切歌
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    bridgeMock.emit("assetStatus", {
      requestId: hasAssetCall[0].requestId,
      path: hasAssetCall[0].path,
      exists: true,
      localURL: "file:///Documents/qqplayer-assets/" + hasAssetCall[0].path,
    });
    await p;

    // 已切歌：不切本地源，src 保持原样（song A 的远程地址）
    expect(proxy.src).toBe("http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3");
  });

  it("已下载且新歌未播（currentTime=0）：切本地不从残留位置 seek（修复 2026-08-25 尾部播放）", async () => {
    const proxy = bridgeMock.getProxy()!;
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    // 换源后镜像清零：新歌还没开始播，currentTime=0（修复前残留上一首进度会污染这里）
    proxy._src = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";
    proxy.paused = true;
    proxy.currentTime = 0;

    const p = maybePrefetchAsset(state.currentSong!);
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    const { path, requestId } = hasAssetCall[0];
    bridgeMock.emit("assetStatus", {
      requestId,
      path,
      exists: true,
      localURL: "file:///Documents/qqplayer-assets/" + path,
    });
    await p;

    expect(proxy.src.startsWith("file:///")).toBe(true); // 切本地
    expect(proxy.playCalls).toBe(0); // 未在播不续播
    // 无进度（t=0）：不挂 loadedmetadata seek——新歌从 0 播，绝不 seek 到残留位置
    expect(proxy.listeners.loadedmetadata || []).toHaveLength(0);
    expect(bridgeMock.post.mock.calls.some((c) => c[0].cmd === "seek")).toBe(false);
  });

  it("已下载 + resumeAt（restoreLastPlayed 断点续播）：切本地后 seek 到断点而不是从 0 开始", async () => {
    const proxy = bridgeMock.getProxy()!;
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    proxy._src = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";
    proxy.paused = true;
    proxy.currentTime = 0; // 还没开始播（换源清零）

    const p = maybePrefetchAsset(state.currentSong!, { resumeAt: 120 }); // 断点 120s
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    const { path, requestId } = hasAssetCall[0];
    bridgeMock.emit("assetStatus", {
      requestId,
      path,
      exists: true,
      localURL: "file:///Documents/qqplayer-assets/" + path,
    });
    await p;

    // 挂载了 loadedmetadata seek；duration 就绪后 seek 到断点
    const metas = proxy.listeners.loadedmetadata || [];
    expect(metas.length).toBe(1);
    for (const fn of metas) fn({ duration: 180 });
    expect(proxy.currentTime).toBe(120);
    expect(state.currentTime).toBe(120);
  });

  it("resumeAt 超过 duration：clamp 到 duration-0.5（防 seek 越界立即 ended = 直接跳过）", async () => {
    const proxy = bridgeMock.getProxy()!;
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    proxy._src = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";
    proxy.paused = true;
    proxy.currentTime = 0;

    const p = maybePrefetchAsset(state.currentSong!, { resumeAt: 9999 }); // 远超时长
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset")!;
    const { path, requestId } = hasAssetCall[0];
    bridgeMock.emit("assetStatus", {
      requestId,
      path,
      exists: true,
      localURL: "file:///Documents/qqplayer-assets/" + path,
    });
    await p;

    for (const fn of [...(proxy.listeners.loadedmetadata || [])]) fn({ duration: 180 });
    expect(proxy.currentTime).toBe(179.5); // 180 - 0.5，不越界
  });

  it("iOS 壳外（无桥）：直接 no-op，不发任何资产消息", async () => {
    bridgeMock.isNativePlayback.mockReturnValue(false);
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    await maybePrefetchAsset({ path: "/Music/a.mp3", name: "A" });
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("无 path 的流媒体条目：不触发资产查询", async () => {
    await maybePrefetchAsset({ type: "stream", streamId: "s1", name: "S" } as Song);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});

describe("setupMediaSession（iOS 分支）：封面本地优先（CarPlay 封面修复）", () => {
  beforeEach(() => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.handlers.clear();
    bridgeMock.isNativePlayback.mockReturnValue(true);
    bridgeMock.nativeSendMetadata.mockClear();
    bridgeMock.resolveCoverURL.mockClear();
    coverToDataURLMock.mockClear();
    cachedCoverURLMock.mockReset();
    cacheCoverMock.mockReset();
    Object.assign(state, {
      songs: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      muted: false,
      volume: 1,
      favorites: [],
      playlists: [],
      loading: false,
      error: "",
    });
    sync._resetSyncForTests();
    // 原生壳环境（真实 sync.js 的 syncEnabled/iosBridgeAvailable 判定）
    window.qqplayerNative = true;
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("已缓存封面：coverUrl 用本地 URL，不再走远程", async () => {
    const unsub = playerMod.setupMediaSession();
    bridgeMock.nativeSendMetadata.mockClear(); // 清掉 immediate 触发（null）的一次
    try {
      const local = "http://127.0.0.1:17888/native-assets/audio/abc.m4a";
      cachedCoverURLMock.mockResolvedValue(local);
      const song = { path: "/Music/a.mp3", name: "A", artist: "X", album: "Y" };
      state.currentSong = song;
      await flush();
      expect(bridgeMock.nativeSendMetadata).toHaveBeenLastCalledWith(song, local);
      expect(sync.cacheCover).not.toHaveBeenCalled(); // 已缓存：不触发后台下载
    } finally {
      unsub();
    }
  });

  it("未缓存封面：cover 转 data URL（远程兑底后直传解析结果），并触发后台缓存", async () => {
    const unsub = playerMod.setupMediaSession();
    bridgeMock.nativeSendMetadata.mockClear();
    try {
      cachedCoverURLMock.mockResolvedValue(null);
      const song = { path: "/Music/b.flac", name: "B" };
      state.currentSong = song;
      await flush();
      // 新链路：coverToDataURL(远程 URL) identity → 直传解析后的远程 URL
      //（原生收到的 coverUrl 与旧链路 resolveCoverURL 计算值相同，行为不变）
      const remote = "/api/cover?path=%2FMusic%2Fb.flac";
      expect(bridgeMock.nativeSendMetadata).toHaveBeenLastCalledWith(song, remote);
      expect(bridgeMock.nativeSendMetadata.mock.results.at(-1)!.value).toBe(remote);
      expect(sync.cacheCover).toHaveBeenCalledWith("/Music/b.flac");
    } finally {
      unsub();
    }
  });

  it("乱序：第一首慢查询迟到 → 旧结果被丢弃，只发第二首元数据", async () => {
    const unsub = playerMod.setupMediaSession();
    await flush(); // immediate 触发（null）的异步壳先结算，再清计数
    bridgeMock.nativeSendMetadata.mockClear();
    try {
      let resolveFirst: (v: string) => void = () => {};
      cachedCoverURLMock
        .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
        .mockResolvedValue("http://127.0.0.1:17888/native-assets/audio/second.m4a");
      const song1 = { path: "/Music/a.mp3", name: "A" };
      const song2 = { path: "/Music/b.mp3", name: "B" };
      state.currentSong = song1;
      await flush(); // 第一首 watcher 触发并挂起在 deferred 查询上
      state.currentSong = song2;
      await flush(); // 第二首查询立即 resolve → 发送
      expect(bridgeMock.nativeSendMetadata).toHaveBeenCalledTimes(1);
      expect(bridgeMock.nativeSendMetadata).toHaveBeenLastCalledWith(
        song2,
        "http://127.0.0.1:17888/native-assets/audio/second.m4a",
      );
      resolveFirst("http://127.0.0.1:17888/native-assets/audio/first.m4a"); // 迟到结果
      await flush();
      expect(bridgeMock.nativeSendMetadata).toHaveBeenCalledTimes(1); // 未追加发送
    } finally {
      unsub();
    }
  });
});

describe("resolveCoverForMetadata：封面转 data URL（CarPlay 即时刷新）", () => {
  beforeEach(() => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.handlers.clear();
    bridgeMock.isNativePlayback.mockReturnValue(true);
    bridgeMock.resolveCoverURL.mockClear();
    coverToDataURLMock.mockClear();
    cachedCoverURLMock.mockReset();
    cacheCoverMock.mockReset();
    Object.assign(state, {
      songs: [],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      muted: false,
      volume: 1,
      favorites: [],
      playlists: [],
      loading: false,
      error: "",
    });
    sync._resetSyncForTests();
    window.qqplayerNative = true;
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("本地缓存命中：coverToDataURL(local) 转 data URL", async () => {
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    const local = "http://127.0.0.1:17888/native-assets/audio/a.m4a";
    cachedCoverURLMock.mockResolvedValue(local);
    coverToDataURLMock.mockResolvedValue("data:image/jpeg;base64,local");

    const cover = await resolveCoverForMetadata(song, () => true);

    expect(cover).toBe("data:image/jpeg;base64,local");
    expect(coverToDataURLMock).toHaveBeenCalledWith(local);
    expect(sync.cacheCover).not.toHaveBeenCalled(); // 已缓存：不触发后台下载
    expect(bridgeMock.resolveCoverURL).not.toHaveBeenCalled(); // 本地命中不走远程
  });

  it("本地缓存命中但转换失败：兑底原始本地 URL", async () => {
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    const local = "http://127.0.0.1:17888/native-assets/audio/a.m4a";
    cachedCoverURLMock.mockResolvedValue(local);
    coverToDataURLMock.mockRejectedValue(new Error("fetch failed"));

    const cover = await resolveCoverForMetadata(song, () => true);

    expect(cover).toBe(local); // 失败不阻塞元数据推送
  });

  it("未缓存：cacheCover 触发 + 远程 URL 转 data URL", async () => {
    const song = { path: "/Music/b.flac", name: "B" };
    state.currentSong = song;
    cachedCoverURLMock.mockResolvedValue(null);
    coverToDataURLMock.mockResolvedValue("data:image/jpeg;base64,remote");

    const cover = await resolveCoverForMetadata(song, () => true);

    expect(cover).toBe("data:image/jpeg;base64,remote");
    expect(sync.cacheCover).toHaveBeenCalledWith("/Music/b.flac"); // fire-and-forget 保持
    expect(bridgeMock.resolveCoverURL).toHaveBeenCalledWith(song);
    expect(coverToDataURLMock).toHaveBeenCalledWith("/api/cover?path=%2FMusic%2Fb.flac");
  });

  it("未缓存 + 远程转换失败：兑底远程 URL（原生异步路径，锁屏仍正常）", async () => {
    const song = { path: "/Music/b.flac", name: "B" };
    state.currentSong = song;
    cachedCoverURLMock.mockResolvedValue(null);
    coverToDataURLMock.mockRejectedValue(new Error("bad"));

    const cover = await resolveCoverForMetadata(song, () => true);

    expect(cover).toBe("/api/cover?path=%2FMusic%2Fb.flac");
    expect(sync.cacheCover).toHaveBeenCalledWith("/Music/b.flac");
  });

  it("isCurrent 返回 false（第一次 await 后已切歌）→ 返回 null", async () => {
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    cachedCoverURLMock.mockResolvedValue("http://127.0.0.1:17888/native-assets/audio/a.m4a");

    const cover = await resolveCoverForMetadata(song, () => false);

    expect(cover).toBeNull();
    expect(coverToDataURLMock).not.toHaveBeenCalled();
  });

  it("第二次 await 后已切歌：返回 null（旧结果不覆盖新歌）", async () => {
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    const local = "http://127.0.0.1:17888/native-assets/audio/a.m4a";
    cachedCoverURLMock.mockResolvedValue(local);
    let resolveConvert: (v: string) => void = () => {};
    coverToDataURLMock.mockImplementationOnce(() => new Promise((r) => (resolveConvert = r)));

    let current = song; // 模拟 state.currentSong 的当前歌引用（转换期间被切走）
    const p = resolveCoverForMetadata(song, () => current);
    await flush(); // cachedCoverURL 结算 → 挂起在 coverToDataURL
    current = { path: "/Music/other.mp3", name: "Other" }; // 转换期间已切歌
    resolveConvert("data:image/jpeg;base64,stale");

    expect(await p).toBeNull();
  });

  it("无 path（流媒体/空歌）：直接返回空串，不查询缓存", async () => {
    const cover = await resolveCoverForMetadata(
      { type: "stream", coverUrl: "https://img.example.com/c.jpg" } as Song,
      () => state.currentSong,
    );
    expect(cover).toBe("");
    expect(sync.cachedCoverURL).not.toHaveBeenCalled();
  });
});
