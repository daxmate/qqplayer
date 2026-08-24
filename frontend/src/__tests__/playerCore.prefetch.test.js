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

// Audio stub：playerCore 模块加载即 new Audio()（audioEq/audioBare）
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
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  removeEventListener(ev, fn) {
    const arr = this.listeners[ev] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
}
vi.stubGlobal("Audio", FakeAudio);

// jsdom（vitest 4）无 localStorage → 手写 stub（同 syncAssets.test.js 风格；
// autoPrefetch 开关判定依赖）
const lsStore = {};
const localStorageStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => {
    lsStore[k] = String(v);
  },
  removeItem: (k) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};
function clearLs() {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

// ---------- mock：nativeAudioBridge（原生播放语义代理 + 事件订阅/发消息） ----------
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map(); // name → Set<fn>
  let proxy = null;
  const makeProxy = () => {
    const p = {
      _src: "",
      currentTime: 0,
      volume: 1,
      muted: false,
      playbackRate: 1,
      paused: true,
      ended: false,
      duration: 0,
      listeners: {},
      playCalls: 0,
      play() {
        this.paused = false;
        this.playCalls += 1;
        return Promise.resolve();
      },
      pause() {
        this.paused = true;
      },
      load() {},
      removeAttribute(attr) {
        if (attr === "src") this._src = "";
      },
      addEventListener(ev, fn) {
        (this.listeners[ev] = this.listeners[ev] || []).push(fn);
      },
      removeEventListener(ev, fn) {
        const arr = this.listeners[ev] || [];
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      },
    };
    Object.defineProperty(p, "src", {
      get() {
        return this._src;
      },
      set(v) {
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
    onNativeEvent: vi.fn((name, fn) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => {
        handlers.get(name)?.delete(fn);
      };
    }),
    registerRemoteCommandHandler: vi.fn(),
    nativeSendMetadata: vi.fn(),
    getProxy: () => proxy,
    /** 模拟原生侧回推事件 */
    emit(name, payload) {
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
  nativeSendMetadata: bridgeMock.nativeSendMetadata,
  nativePost: bridgeMock.post,
  onNativeEvent: bridgeMock.onNativeEvent,
}));

// ---------- 被测模块（动态导入：须在 Audio stub 之后） ----------
const playerMod = await import("../composables/playerCore.js");
const sync = await import("../utils/sync.js");

const { state, maybePrefetchAsset } = playerMod;

/** 等待异步链排空（assetForSong 哈希 / ensureAsset 回执结算 / 批量下载 flush）
 *  jsdom 下 crypto.subtle.digest 完成比 setTimeout(0) 慢，给 30ms 余量 */
function flush() {
  return new Promise((r) => setTimeout(r, 30));
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
    const proxy = bridgeMock.getProxy();
    const song = { path: "/Music/a.mp3", name: "A" };
    state.currentSong = song;
    const remoteSrc = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";
    proxy._src = remoteSrc; // 远程播放中
    proxy.paused = false; // wasPlaying
    proxy.currentTime = 42;

    const p = maybePrefetchAsset(state.currentSong); // 真实调用点传 state.currentSong（响应式代理）
    await flush(); // assetForSong（哈希）完成后 hasAsset 已发出
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset");
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
    const proxy = bridgeMock.getProxy();
    const song = { path: "/Music/b.flac", name: "B" };
    state.currentSong = song;
    const remoteSrc = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fb.flac";
    proxy._src = remoteSrc;
    proxy.paused = true;

    const p = maybePrefetchAsset(state.currentSong);
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset");
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
    const proxy = bridgeMock.getProxy();
    const song = { path: "/Music/c.mp3", name: "C" };
    state.currentSong = song;
    const remoteSrc = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fc.mp3";
    proxy._src = remoteSrc;
    proxy.paused = true;

    const p = maybePrefetchAsset(state.currentSong);
    await flush();
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset");
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
    const proxy = bridgeMock.getProxy();
    state.currentSong = { path: "/Music/a.mp3", name: "A" };
    proxy._src = "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3";

    const p = maybePrefetchAsset(state.currentSong); // 传当前歌引用
    await flush();
    state.currentSong = { path: "/Music/other.mp3", name: "Other" }; // 回执到达前已切歌
    const hasAssetCall = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "hasAsset");
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

  it("iOS 壳外（无桥）：直接 no-op，不发任何资产消息", async () => {
    bridgeMock.isNativePlayback.mockReturnValue(false);
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    await maybePrefetchAsset({ path: "/Music/a.mp3", name: "A" });
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("无 path 的流媒体条目：不触发资产查询", async () => {
    await maybePrefetchAsset({ type: "stream", streamId: "s1", name: "S" });
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});
