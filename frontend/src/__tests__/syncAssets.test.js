// sync.js 同步管理（阶段3 · E2）新增函数单测：
//   buildSongItems / buildBookItems 产物格式
//   syncAssets 批量下载消息格式（mock nativePost）+ downloads 状态登记
//   syncAssetProgress / syncAssetDone 事件驱动 downloads 状态流转
//   clearFinished / retryFailed / clearAssets / fetchAssetsSize
//   autoPrefetchEnabled 默认关 / setAutoPrefetch 持久化
//
// mock 策略同 sync.test.js：
//   - nativeAudioBridge：vi.mock 整模块（onNativeEvent 捕获订阅者 / nativePost 记录消息）
//   - apiClient：vi.mock 整模块（resolveServerUrl）
//   - 环境：window.qqplayerNative + window.qqplayerIosBridge（setNativeEnv）
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------- mock：nativeAudioBridge（事件订阅 + 发消息） ----------
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map(); // name → Set<fn>
  return {
    handlers,
    post: vi.fn(),
    onNativeEvent: vi.fn((name, fn) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => {
        handlers.get(name)?.delete(fn);
      };
    }),
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
  onNativeEvent: bridgeMock.onNativeEvent,
  nativePost: bridgeMock.post,
}));

// ---------- mock：apiClient ----------
const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  isOffline: vi.fn(() => false), // 测试默认在线（离线短路单独测）
  resolveServerUrl: vi.fn((p) =>
    /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
  ),
}));

vi.mock("../utils/apiClient.js", () => apiMock);

// ---------- 被测模块 ----------
import * as sync from "../utils/sync.js";

// jsdom（vitest 4）无 localStorage → 手写 stub（同 Cover.test.js 风格）
const localStorageStub = {
  store: {},
  getItem(key) {
    return key in this.store ? this.store[key] : null;
  },
  setItem(key, value) {
    this.store[key] = String(value);
  },
  removeItem(key) {
    delete this.store[key];
  },
  clear() {
    this.store = {};
  },
};

async function setNativeEnv() {
  window.qqplayerNative = true;
  window.qqplayerIosBridge = { postMessage: vi.fn() };
}

function lastSyncDownload() {
  return bridgeMock.post.mock.calls.find((c) => c[0] && c[0].cmd === "syncDownload")?.[0];
}

function clearPosts() {
  bridgeMock.post.mockClear();
}

beforeEach(() => {
  delete window.qqplayerNative;
  delete window.qqplayerIosBridge;
  apiMock.apiGet.mockReset();
  bridgeMock.post.mockClear();
  bridgeMock.handlers.clear();
  localStorageStub.clear();
  vi.stubGlobal("localStorage", localStorageStub);
  sync._resetSyncForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("buildSongItems / buildBookItems：产物格式", () => {
  it("buildSongItems：本地歌 → {url, path: audio/<sha256>.<ext>, sha256:'', size}；流媒体（无 path）跳过", async () => {
    const items = await sync.buildSongItems([
      { path: "/Music/a.mp3", name: "A", size: 100 },
      { path: "/Music/b.flac", name: "B", size: 200 },
      { name: "stream", type: "stream" }, // path 缺失 → 跳过
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      url: "http://192.168.1.50:17627/api/audio?path=" + encodeURIComponent("/Music/a.mp3"),
      sha256: "",
      size: 100,
    });
    expect(items[0].path).toMatch(/^audio\/[0-9a-f]{64}\.mp3$/);
    expect(items[1]).toMatchObject({ size: 200 });
    expect(items[1].path).toMatch(/^audio\/[0-9a-f]{64}\.flac$/);
  });

  it("buildBookItems：书 → {url: /api/books/<id>/file, path: books/<sha256>.epub, sha256:'', size}；缺 id 跳过", async () => {
    const items = await sync.buildBookItems([
      { id: "b1", title: "书一", size: 1234 },
      { id: "b2", title: "书二" },
      { title: "无 id" }, // 缺 id → 跳过
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].url).toBe("http://192.168.1.50:17627/api/books/b1/file");
    expect(items[0].path).toMatch(/^books\/[0-9a-f]{64}\.epub$/);
    expect(items[0].size).toBe(1234);
    expect(items[1].size).toBe(0);
  });

  it("非数组输入 → 空数组", async () => {
    expect(await sync.buildSongItems(null)).toEqual([]);
    expect(await sync.buildSongItems("x")).toEqual([]);
    expect(await sync.buildBookItems(undefined)).toEqual([]);
  });
});

describe("syncAssets：批量下载消息 + downloads 状态登记", () => {
  it("非原生环境：no-op 返回 false，不发消息、不登记", () => {
    const items = [{ url: "http://s/a.mp3", path: "audio/aaa.mp3", sha256: "", size: 10 }];
    expect(sync.syncAssets(items)).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();
    expect(Object.keys(sync.syncDownloads)).toHaveLength(0);
  });

  it("空列表 / 全无效项：返回 false 不发消息", async () => {
    await setNativeEnv();
    expect(sync.syncAssets([])).toBe(false);
    expect(sync.syncAssets([{ path: "x" }])).toBe(false); // 缺 url
    expect(sync.syncAssets([null, undefined])).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("批量下载：一次 syncDownload，items 字段 {url,path,sha256,size,wifiOnly} 透传", async () => {
    await setNativeEnv();
    const items = [
      { url: "http://s/a.m4a", path: "audio/aaa.m4a", sha256: "", size: 100 },
      { url: "http://s/b.epub", path: "books/bbb.epub", sha256: "h2", size: 200 },
    ];
    expect(sync.syncAssets(items)).toBe(true);
    const msg = lastSyncDownload();
    expect(msg).toBeTruthy();
    expect(msg.cmd).toBe("syncDownload");
    expect(msg.items).toEqual([
      { url: "http://s/a.m4a", path: "audio/aaa.m4a", sha256: "", size: 100, wifiOnly: true },
      { url: "http://s/b.epub", path: "books/bbb.epub", sha256: "h2", size: 200, wifiOnly: true },
    ]);
  });

  it("登记 downloads：status='queued'，name = path 去前缀，保留 url/sha256/size 供重试", async () => {
    await setNativeEnv();
    sync.syncAssets([{ url: "http://s/a.m4a", path: "audio/aaa.m4a", sha256: "", size: 100 }]);
    const entry = sync.syncDownloads["audio/aaa.m4a"];
    expect(entry).toMatchObject({
      name: "aaa.m4a",
      status: "queued",
      received: 0,
      total: 100,
      error: "",
      url: "http://s/a.m4a",
      sha256: "",
      size: 100,
    });
    // 事件订阅已挂（保证进度事件可到达）
    expect(bridgeMock.handlers.has("syncAssetProgress")).toBe(true);
    expect(bridgeMock.handlers.has("syncAssetDone")).toBe(true);
  });
});

describe("syncAssetProgress / syncAssetDone 事件驱动 downloads 状态", () => {
  it("进度 → status downloading + received/total 更新；成功 → done + received=total", async () => {
    await setNativeEnv();
    sync.syncAssets([
      { url: "http://s/a.m4a", path: "audio/aaa.m4a", sha256: "", size: 100 },
      { url: "http://s/b.m4a", path: "audio/bbb.m4a", sha256: "", size: 50 },
    ]);
    bridgeMock.emit("syncAssetProgress", { path: "audio/aaa.m4a", received: 40, total: 100 });
    const a = sync.syncDownloads["audio/aaa.m4a"];
    expect(a.status).toBe("downloading");
    expect(a.received).toBe(40);
    expect(a.total).toBe(100);
    // 未登记路径的进度：不报错、不产生条目
    bridgeMock.emit("syncAssetProgress", { path: "audio/unknown.m4a", received: 1, total: 9 });
    expect(sync.syncDownloads["audio/unknown.m4a"]).toBeUndefined();

    bridgeMock.emit("syncAssetDone", {
      path: "audio/aaa.m4a",
      ok: true,
      localURL: "file:///qqplayer-assets/audio/aaa.m4a",
    });
    expect(sync.syncDownloads["audio/aaa.m4a"].status).toBe("done");
    expect(sync.syncDownloads["audio/aaa.m4a"].received).toBe(100);
  });

  it("失败 → status failed + error；retryFailed 重建消息并回到 queued", async () => {
    await setNativeEnv();
    sync.syncAssets([{ url: "http://s/b.m4a", path: "audio/bbb.m4a", sha256: "", size: 50 }]);
    bridgeMock.emit("syncAssetDone", {
      path: "audio/bbb.m4a",
      ok: false,
      error: "网络中断",
      localURL: "",
    });
    const entry = sync.syncDownloads["audio/bbb.m4a"];
    expect(entry.status).toBe("failed");
    expect(entry.error).toBe("网络中断");

    // 重试：非失败态 no-op
    clearPosts();
    expect(sync.retryFailed("audio/aaa.m4a")).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();

    // 重试：失败项重建 {url, path, sha256, size}（来自条目内保留字段）并回 queued
    expect(sync.retryFailed("audio/bbb.m4a")).toBe(true);
    const msg = lastSyncDownload();
    expect(msg.items).toEqual([
      { url: "http://s/b.m4a", path: "audio/bbb.m4a", sha256: "", size: 50 },
    ]);
    expect(sync.syncDownloads["audio/bbb.m4a"].status).toBe("queued");
    expect(sync.syncDownloads["audio/bbb.m4a"].error).toBe("");
    expect(sync.syncDownloads["audio/bbb.m4a"].received).toBe(0);
  });

  it("clearFinished：只清 done/failed，保留 queued/downloading", async () => {
    await setNativeEnv();
    sync.syncAssets([
      { url: "http://s/a.m4a", path: "audio/a.m4a", sha256: "", size: 1 },
      { url: "http://s/b.m4a", path: "audio/b.m4a", sha256: "", size: 1 },
      { url: "http://s/c.m4a", path: "audio/c.m4a", sha256: "", size: 1 },
    ]);
    bridgeMock.emit("syncAssetDone", { path: "audio/a.m4a", ok: true, localURL: "file:///a" });
    bridgeMock.emit("syncAssetDone", { path: "audio/b.m4a", ok: false, error: "e" });
    // c 保持 queued
    sync.clearFinished();
    expect(Object.keys(sync.syncDownloads)).toEqual(["audio/c.m4a"]);
  });
});

describe("clearAssets：deleteAssets 消息 scope", () => {
  it("scope 透传；非原生环境 no-op", async () => {
    expect(sync.clearAssets("all")).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();

    await setNativeEnv();
    expect(sync.clearAssets("audio")).toBe(true);
    expect(sync.clearAssets("books")).toBe(true);
    expect(sync.clearAssets("dicts")).toBe(true);
    expect(sync.clearAssets()).toBe(true); // 默认 'all'
    const calls = bridgeMock.post.mock.calls
      .filter((c) => c[0] && c[0].cmd === "deleteAssets")
      .map((c) => c[0].scope);
    expect(calls).toEqual(["audio", "books", "dicts", "all"]);
  });
});

describe("fetchAssetsSize：assetsSize 命令 + 回执事件", () => {
  it("回执 push('assetsSize',{total}) → resolve(bytes)", async () => {
    await setNativeEnv();
    const p = sync.fetchAssetsSize();
    expect(bridgeMock.post).toHaveBeenCalledWith({ cmd: "assetsSize" });
    bridgeMock.emit("assetsSize", { total: 123456789 });
    await expect(p).resolves.toBe(123456789);
  });

  it("原生无回执：超时 resolve(null)，不挂起", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.fetchAssetsSize();
    vi.advanceTimersByTime(sync.ASSETS_SIZE_TIMEOUT_MS + 10);
    await expect(p).resolves.toBeNull();
    // 迟到回执：忽略（已结算）
    bridgeMock.emit("assetsSize", { total: 1 });
    vi.advanceTimersByTime(0);
  });

  it("非原生环境：立即 resolve(null)", async () => {
    await expect(sync.fetchAssetsSize()).resolves.toBeNull();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});

describe("自动预取开关：默认关 + setAutoPrefetch 持久化", () => {
  it("默认 false（localStorage 未设置）", () => {
    expect(sync.autoPrefetchEnabled()).toBe(false);
    expect(localStorage.getItem("qqplayer.autoPrefetch")).toBeNull();
  });

  it("setAutoPrefetch(true) → true 且持久化 'on'；false → 移除", () => {
    expect(sync.setAutoPrefetch(true)).toBe(true);
    expect(localStorage.getItem("qqplayer.autoPrefetch")).toBe("on");
    expect(sync.autoPrefetchEnabled()).toBe(true);
    expect(sync.setAutoPrefetch(false)).toBe(false);
    expect(sync.autoPrefetchEnabled()).toBe(false);
    expect(localStorage.getItem("qqplayer.autoPrefetch")).toBeNull();
  });
});
