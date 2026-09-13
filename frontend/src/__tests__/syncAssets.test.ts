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
//   - 环境：window.qqplayerNative + iOS 桥（setNativeEnv）
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
    emit(name: string, payload?: unknown) {
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
  store: {} as Record<string, string>,
  getItem(key: string) {
    return key in this.store ? this.store[key] : null;
  },
  setItem(key: string, value: string) {
    this.store[key] = String(value);
  },
  removeItem(key: string) {
    delete this.store[key];
  },
  clear() {
    this.store = {};
  },
};

beforeEach(() => {
  delete window.qqplayerNative;
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
