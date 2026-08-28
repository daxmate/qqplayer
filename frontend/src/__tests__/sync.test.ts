// sync.js 单元测试：manifest 同步（version 对比 + 集合写入）/ ensureAsset（hasAsset→
// 回执，autoPrefetch 门控下载）/ nativeMetaSave|nativeMetaLoad（元数据文件兜底桥）/
// 下载进度聚合 / appState 生命周期 / 桌面浏览器 no-op
//
// mock 策略（参考 apiClient.test.js / nativeAudioBridge.test.js 风格）：
//   - apiClient：vi.mock 整模块（apiGet + resolveServerUrl）
//   - nativeAudioBridge：vi.mock 整模块（onNativeEvent 捕获订阅者 / nativePost 记录消息）
//   - cacheDb：真实模块（jsdom 无 IndexedDB → 内存实现，setup.js 每用例清空）
//   - sync.js 无模块加载期副作用（initSync 显式调用）→ 静态导入 + _resetSyncForTests 复位
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
  apiPost: vi.fn(),
  isOffline: vi.fn(() => false), // 测试默认在线（离线短路单独测）
  resolveServerUrl: vi.fn((p) =>
    /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
  ),
}));

vi.mock("../utils/apiClient.js", () => apiMock);

// ---------- 被测模块（静态导入；_resetSyncForTests 保证用例隔离） ----------
import { getCache, setCache } from "../utils/cacheDb.js";
import * as sync from "../utils/sync.js";

const manifestV1 = {
  version: "20260822-1000-ops1-scan0",
  generated_at: "2026-08-22T00:00:00Z",
  songs: [{ path: "/Music/a.mp3", name: "A", artist: "X", size: 100 }],
  playlists: [{ id: "p1", name: "练唱", songs: ["/Music/a.mp3"] }],
  favorites: [{ path: "/Music/a.mp3", name: "A", ts: "" }],
  books: [{ id: "b1", title: "测试书" }],
  dicts: [{ name: "oxford.mdx", path: "oxford.mdx", size: 10 }],
  annotations: [
    {
      bookId: "b1",
      version: 100,
      highlights: [{ id: "hl_1", cfi: "c", text: "x", createdAt: 100 }],
      bookmarks: [],
      notes: [],
    },
  ],
  vocab: [
    {
      id: "vw_1",
      word: "hello",
      context: "",
      bookId: "b1",
      bookTitle: "书",
      cfi: "",
      addedAt: 100,
    },
  ],
};

const manifestV2 = {
  ...manifestV1,
  version: "20260822-2000-ops2-scan0",
  songs: [
    { path: "/Music/a.mp3", name: "A", artist: "X", size: 100 },
    { path: "/Music/b.flac", name: "B", artist: "Y", size: 200 },
  ],
};

// jsdom（vitest 4）无 localStorage → 手写 stub（同 syncAssets.test.js 风格；
// autoPrefetch 开关 / 桥环境判定依赖）
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

/** 等待微任务 + 宏任务队列排空（syncNow/批量下载 flush 全异步链） */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

async function setNativeEnv({ bridge = true } = {}) {
  window.qqplayerNative = true;
  if (bridge) window.qqplayerIosBridge = { postMessage: vi.fn() };
}

describe("syncNow：manifest 拉取 + version 对比 + 集合写入", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    apiMock.apiGet.mockReset();
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("首次同步：拉取 manifest → 全量写入各集合（changed=true）", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV1 });
    const r = await sync.syncNow();
    expect(apiMock.apiGet).toHaveBeenCalledWith("/api/sync/manifest");
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(r.version).toBe(manifestV1.version);
    expect(r.counts).toEqual({
      songs: 1,
      playlists: 1,
      favorites: 1,
      books: 1,
      dicts: 1,
      annotations: 1,
      vocab: 1,
    });
    expect(await getCache("sync:songs")).toEqual(manifestV1.songs);
    expect(await getCache("sync:playlists")).toEqual(manifestV1.playlists);
    expect(await getCache("sync:favorites")).toEqual(manifestV1.favorites);
    expect(await getCache("sync:books")).toEqual(manifestV1.books);
    expect(await getCache("sync:dicts")).toEqual(manifestV1.dicts);
    expect(await getCache("sync:annotations")).toEqual(manifestV1.annotations);
    expect(await getCache("sync:vocab")).toEqual(manifestV1.vocab);
    const meta = (await getCache("sync:meta"))!;
    expect(meta.version).toBe(manifestV1.version);
    expect(sync.getSyncState().lastSyncAt).toBeTruthy();
    expect(sync.getSyncState().syncing).toBe(false);
  });

  it("version 未变：changed=false，不重写集合（manifest 仍实时拉取，不走缓存）", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV1 });
    await sync.syncNow();
    const r2 = await sync.syncNow();
    expect(r2.changed).toBe(false);
    expect(apiMock.apiGet).toHaveBeenCalledTimes(2); // 每次都发请求（不缓存）
    expect(await getCache("sync:songs")).toEqual(manifestV1.songs);
  });

  it("version 变化：全量重写集合（changed=true）", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV1 });
    await sync.syncNow();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV2 });
    const r = await sync.syncNow();
    expect(r.changed).toBe(true);
    expect(r.counts!.songs).toBe(2);
    expect(await getCache("sync:songs")).toEqual(manifestV2.songs);
    expect((await getCache("sync:meta"))!.version).toBe(manifestV2.version);
  });

  it("缓存结构升级（schemaVersion）：version 未变也强制刷新——dicts.title 场景", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV1 });
    await sync.syncNow();
    expect((await getCache("sync:meta"))!.schemaVersion).toBe(3);
    // 手写旧结构缓存（无 schemaVersion）模拟升级前：version 相同但缓存必须刷新
    const oldMeta = { version: manifestV1.version, generatedAt: "", syncedAt: 0 };
    await setCache("sync:meta", oldMeta);
    await setCache("sync:dicts", [{ name: "f37e...mdx", path: "f37e...mdx" }]); // 旧结构：无 title
    const r = await sync.syncNow();
    expect(r.changed).toBe(true);
    expect((await getCache("sync:meta"))!.schemaVersion).toBe(3);
    expect(await getCache("sync:dicts")).toEqual(manifestV1.dicts); // 缓存已按新结构重写
    // v2 → v3：旧缓存无 annotations/vocab 集合 → 重写后写入新集合（结构变更强制刷新）
    const oldMetaV2 = {
      version: manifestV1.version,
      schemaVersion: 2,
      generatedAt: "",
      syncedAt: 0,
    };
    await setCache("sync:meta", oldMetaV2);
    const r3 = await sync.syncNow();
    expect(r3.changed).toBe(true); // schemaVersion 2 ≠ 3 → 强制重拉
    expect(await getCache("sync:annotations")).toEqual(manifestV1.annotations);
    expect(await getCache("sync:vocab")).toEqual(manifestV1.vocab);
  });

  it("拉取失败：返回 {ok:false, message}，lastError 记录", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: false, status: 500, message: "boom" });
    const r = await sync.syncNow();
    expect(r.ok).toBe(false);
    expect(r.message).toBe("boom");
    expect(sync.getSyncState().lastError).toBe("boom");
    expect(await getCache("sync:meta")).toBeNull();
  });

  it("桌面浏览器（无 qqplayerNative）：no-op，不发请求", async () => {
    const r = await sync.syncNow();
    expect(r).toEqual({ enabled: false, ok: false });
    expect(apiMock.apiGet).not.toHaveBeenCalled();
  });
});

describe("ensureAsset：hasAsset → assetStatus 回执 / syncDownload 下载", () => {
  const item = {
    path: "audio/abc123.mp3",
    url: "http://192.168.1.50:17627/api/audio?path=%2FMusic%2Fa.mp3",
    sha256: "abc123",
    size: 1024,
  };

  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    apiMock.apiGet.mockReset();
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs(); // autoPrefetch 复位默认关
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("exists=true：resolve(localURL)，不发下载", async () => {
    await setNativeEnv();
    const p = sync.ensureAsset(item);
    expect(bridgeMock.post).toHaveBeenCalledWith({
      cmd: "hasAsset",
      path: item.path,
      requestId: "1",
    });
    bridgeMock.emit("assetStatus", {
      requestId: "1",
      path: item.path,
      exists: true,
      localURL: "file:///Documents/qqplayer-assets/audio/abc123.mp3",
    });
    await expect(p).resolves.toBe("file:///Documents/qqplayer-assets/audio/abc123.mp3");
    // 只发过 hasAsset，没有 syncDownload
    expect(bridgeMock.post).toHaveBeenCalledTimes(1);
  });

  it("exists=false + autoPrefetch 关（默认）：resolve(null)，不发 syncDownload（只查不下载）", async () => {
    await setNativeEnv();
    sync.setAutoPrefetch(false); // 默认关；显式复位防用例间残留
    const p = sync.ensureAsset(item);
    bridgeMock.emit("assetStatus", {
      requestId: "1",
      path: item.path,
      exists: false,
      localURL: "",
    });
    await expect(p).resolves.toBeNull();
    await flush();
    // 只发过 hasAsset，没有 syncDownload（播放本地优先：未下载保持远程）
    expect(bridgeMock.post).toHaveBeenCalledTimes(1);
  });

  it("exists=false + autoPrefetch 开：resolve(null) 且发 syncDownload（批量 items）", async () => {
    await setNativeEnv();
    sync.setAutoPrefetch(true);
    const p = sync.ensureAsset(item);
    bridgeMock.emit("assetStatus", {
      requestId: "1",
      path: item.path,
      exists: false,
      localURL: "",
    });
    await expect(p).resolves.toBeNull();
    await flush(); // 微任务批量 flush
    expect(bridgeMock.post).toHaveBeenCalledWith({
      cmd: "syncDownload",
      items: [{ url: item.url, path: item.path, sha256: "abc123", size: 1024 }],
    });
  });

  it("exists=false + autoPrefetch 关 + 显式 download:true：仍发 syncDownload（阅读器链路）", async () => {
    await setNativeEnv();
    sync.setAutoPrefetch(false);
    const p = sync.ensureAsset(item, { download: true });
    bridgeMock.emit("assetStatus", {
      requestId: "1",
      path: item.path,
      exists: false,
      localURL: "",
    });
    await expect(p).resolves.toBeNull();
    await flush();
    expect(bridgeMock.post).toHaveBeenCalledWith({
      cmd: "syncDownload",
      items: [{ url: item.url, path: item.path, sha256: "abc123", size: 1024 }],
    });
  });

  it("同一 tick 多条请求合并为一次 syncDownload（批量；autoPrefetch 开）", async () => {
    await setNativeEnv();
    sync.setAutoPrefetch(true);
    const item2 = { ...item, path: "audio/def456.flac", url: "http://s/api/audio?path=2" };
    const p1 = sync.ensureAsset(item);
    const p2 = sync.ensureAsset(item2);
    bridgeMock.emit("assetStatus", {
      requestId: "1",
      path: item.path,
      exists: false,
      localURL: "",
    });
    bridgeMock.emit("assetStatus", {
      requestId: "2",
      path: item2.path,
      exists: false,
      localURL: "",
    });
    await Promise.all([p1, p2]);
    await flush();
    const dl = bridgeMock.post.mock.calls.find((c) => c[0].cmd === "syncDownload")!;
    expect(dl).toBeTruthy();
    expect(dl[0].items).toHaveLength(2);
  });

  it("原生无回执：超时 resolve(null)，不挂起", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.ensureAsset(item);
    expect(bridgeMock.post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(sync.ASSET_QUERY_TIMEOUT_MS + 10);
    await expect(p).resolves.toBeNull();
    // 超时后回执到达 → 忽略（无 syncDownload、无异常）
    bridgeMock.emit("assetStatus", {
      requestId: "1",
      path: item.path,
      exists: false,
      localURL: "",
    });
    vi.advanceTimersByTime(0);
    expect(bridgeMock.post).toHaveBeenCalledTimes(1);
  });

  it("无 iOS 桥（macOS 壳场景）：直接 resolve(null)，不发消息", async () => {
    await setNativeEnv({ bridge: false }); // qqplayerNative=true 但无 qqplayerIosBridge
    await expect(sync.ensureAsset(item)).resolves.toBeNull();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("桌面浏览器（无 qqplayerNative）：resolve(null)，不发消息", async () => {
    await expect(sync.ensureAsset(item)).resolves.toBeNull();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("cancelDownloads：发取消命令并清空进度", async () => {
    await setNativeEnv();
    sync.cancelDownloads();
    expect(bridgeMock.post).toHaveBeenCalledWith({ cmd: "cancelDownloads" });
    expect(sync.getSyncState().pendingCount).toBe(0);
  });
});

describe("nativeMetaSave / nativeMetaLoad：元数据文件持久化兜底桥", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    apiMock.apiGet.mockReset();
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("nativeMetaSave：发 {cmd:metaSave, kind, json}（fire-and-forget）", async () => {
    await setNativeEnv();
    const json = JSON.stringify([{ path: "/Music/a.mp3" }]);
    expect(sync.nativeMetaSave("songs", json)).toBe(true);
    expect(bridgeMock.post).toHaveBeenCalledWith({ cmd: "metaSave", kind: "songs", json });
  });

  it("nativeMetaSave：空 json / 非原生环境 → 静默 no-op（不发消息）", async () => {
    await setNativeEnv();
    expect(sync.nativeMetaSave("songs", "")).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    expect(sync.nativeMetaSave("songs", "[]")).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("nativeMetaLoad：发 metaLoad → metaLoaded 回执 resolve(json)", async () => {
    await setNativeEnv();
    const json = JSON.stringify(["favorites", "songs"]);
    const p = sync.nativeMetaLoad("favorites");
    expect(bridgeMock.post).toHaveBeenCalledWith({
      cmd: "metaLoad",
      kind: "favorites",
      requestId: "1",
    });
    bridgeMock.emit("metaLoaded", { requestId: "1", kind: "favorites", json });
    await expect(p).resolves.toBe(json);
  });

  it("nativeMetaLoad：文件缺失（无 json 字段）→ resolve(null)", async () => {
    await setNativeEnv();
    const p = sync.nativeMetaLoad("playlists");
    bridgeMock.emit("metaLoaded", { requestId: "1", kind: "playlists" });
    await expect(p).resolves.toBeNull();
  });

  it("nativeMetaLoad：原生无回执 → 超时 resolve(null)，不挂起", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.nativeMetaLoad("songs");
    expect(bridgeMock.post).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(sync.META_LOAD_TIMEOUT_MS + 10);
    await expect(p).resolves.toBeNull();
    // 迟到回执：忽略（已结算，不抛错）
    bridgeMock.emit("metaLoaded", { requestId: "1", kind: "songs", json: "[]" });
    vi.advanceTimersByTime(0);
  });

  it("nativeMetaLoad：非原生环境（桌面/macOS 壳无桥）→ 立即 resolve(null)", async () => {
    await expect(sync.nativeMetaLoad("songs")).resolves.toBeNull();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});

describe("assetForSong / assetForDict / assetForBook：沙盒路径内容寻址", () => {
  beforeEach(() => {
    sync._resetSyncForTests();
  });

  it("assetForSong：url 绝对化，path = audio/<sha256>.<ext>，sha256 暂为空（内容校验待后端补哈希）", async () => {
    const item = (await sync.assetForSong({ path: "/Music/foo.mp3", size: 100 }))!;
    expect(item.url).toBe(
      "http://192.168.1.50:17627/api/audio?path=" + encodeURIComponent("/Music/foo.mp3"),
    );
    expect(item.path).toMatch(/^audio\/[0-9a-f]{64}\.mp3$/);
    expect(item.sha256).toBe("");
    expect(item.size).toBe(100);
  });

  it("assetForSong：name = 歌手 - 歌名（同步面板展示用，不显示 hash）", async () => {
    expect(
      (await sync.assetForSong({ path: "/Music/foo.mp3", name: "星星点灯", artist: "郑智化" }))!
        .name,
    ).toBe("郑智化 - 星星点灯");
    expect((await sync.assetForSong({ path: "/Music/foo.mp3", name: "星星点灯" }))!.name).toBe(
      "星星点灯",
    );
    expect((await sync.assetForSong({ path: "/Music/郑智化 - 星星点灯.mp3" }))!.name).toBe(
      "郑智化 - 星星点灯",
    );
  });

  it("assetForDict：dicts/ 子目录，扩展名保留；name = title（真实词典名）优先", async () => {
    const item = (await sync.assetForDict({
      name: "f37e654b0b56489eabc2af427c48a82a.mdx",
      title: "LDOCE6++ En-Cn V2-19",
      path: "f37e654b0b56489eabc2af427c48a82a.mdx",
      size: 11,
    }))!;
    expect(item.url).toBe(
      "http://192.168.1.50:17627/api/sync/dicts/file?path=" +
        encodeURIComponent("f37e654b0b56489eabc2af427c48a82a.mdx"),
    );
    expect(item.path).toMatch(/^dicts\/[0-9a-f]{64}\.mdx$/);
    expect(item.size).toBe(11);
    expect(item.name).toBe("LDOCE6++ En-Cn V2-19");
  });

  it("assetForDict：无 title 时回退 name（真实文件名）", async () => {
    const item = (await sync.assetForDict({ name: "oxford.mdx", path: "abc123/oxford.mdx" }))!;
    expect(item.name).toBe("oxford");
  });

  it("assetForBook：books/ 子目录 .epub；name = 书名", async () => {
    const item = (await sync.assetForBook({ id: "b1", title: "测试书" }))!;
    expect(item.url).toBe("http://192.168.1.50:17627/api/books/b1/file");
    expect(item.path).toMatch(/^books\/[0-9a-f]{64}\.epub$/);
    expect(item.name).toBe("测试书");
  });

  it("缺 path/id：返回 null", async () => {
    expect(await sync.assetForSong({ name: "x" })).toBeNull();
    expect(await sync.assetForDict({ name: "x" })).toBeNull();
    expect(await sync.assetForBook({ title: "x" })).toBeNull();
  });
});

describe("initSync：事件订阅 + 下载进度聚合 + appState 触发同步", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    apiMock.apiGet.mockReset();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV1 });
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
  });

  it("initSync：注册事件订阅 + 首次 syncNow", async () => {
    await setNativeEnv();
    sync.initSync();
    await flush();
    expect(apiMock.apiGet).toHaveBeenCalledWith("/api/sync/manifest");
    // 各类事件均已订阅（含 metaLoaded 元数据文件回执）
    for (const name of [
      "syncAssetProgress",
      "syncAssetDone",
      "assetStatus",
      "appState",
      "metaLoaded",
    ]) {
      expect(bridgeMock.handlers.has(name)).toBe(true);
    }
  });

  it("syncAssetProgress/Done 聚合进度与待下载数", async () => {
    await setNativeEnv();
    sync.initSync();
    await flush();
    const st = sync.getSyncState();
    bridgeMock.emit("syncAssetProgress", { path: "audio/x.mp3", received: 50, total: 100 });
    bridgeMock.emit("syncAssetProgress", { path: "audio/y.flac", received: 20, total: 80 });
    expect(st.pendingCount).toBe(2);
    expect(st.progress).toEqual({ received: 70, total: 180 });
    bridgeMock.emit("syncAssetDone", { path: "audio/x.mp3", ok: true, localURL: "file:///x.mp3" });
    expect(st.pendingCount).toBe(1);
    expect(st.progress).toEqual({ received: 20, total: 80 });
  });

  it("appState active 触发 syncNow；background/inactive 不触发", async () => {
    await setNativeEnv();
    sync.initSync();
    await flush();
    expect(apiMock.apiGet).toHaveBeenCalledTimes(1); // 启动首次
    bridgeMock.emit("appState", { state: "background" });
    await flush();
    expect(apiMock.apiGet).toHaveBeenCalledTimes(1);
    bridgeMock.emit("appState", { state: "inactive" });
    await flush();
    expect(apiMock.apiGet).toHaveBeenCalledTimes(1);
    bridgeMock.emit("appState", { state: "active" });
    await flush();
    expect(apiMock.apiGet).toHaveBeenCalledTimes(2); // 前台恢复再同步一次
  });

  it("桌面浏览器：initSync 静默 no-op（不订阅、不同步）", async () => {
    sync.initSync();
    await flush();
    expect(apiMock.apiGet).not.toHaveBeenCalled();
    expect(bridgeMock.handlers.size).toBe(0);
  });

  it("stopSync：取消订阅，后续事件不再处理", async () => {
    await setNativeEnv();
    sync.initSync();
    await flush();
    sync.stopSync();
    const st = sync.getSyncState();
    bridgeMock.emit("syncAssetProgress", { path: "audio/x.mp3", received: 10, total: 100 });
    expect(st.pendingCount).toBe(0);
    // 重新 initSync 可再次工作（幂等复位）
    sync.initSync();
    await flush();
    bridgeMock.emit("syncAssetProgress", { path: "audio/x.mp3", received: 10, total: 100 });
    expect(st.pendingCount).toBe(1);
  });
});

describe("mergeVocab / mergeAnnotations：标注按书 LWW、生词按 id 逐条 merge（P2-B）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    apiMock.apiGet.mockReset();
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
  });

  it("mergeVocab：本地/远端各自独有条目都保留（不丢对端新词）", () => {
    const local = [
      { id: "vw_1", word: "hello", addedAt: 100 }, // 共有 id，本地旧
      { id: "vw_local", word: "local-only", addedAt: 200 }, // 仅本地
    ];
    const remote = [
      { id: "vw_1", word: "hello", addedAt: 300 }, // 远端新 → 胜
      { id: "vw_remote", word: "remote-only", addedAt: 400 }, // 仅远端
    ];
    const merged = sync.mergeVocab(local, remote) as Array<{
      id: string;
      addedAt: number;
      word?: string;
    }>;
    const byId = Object.fromEntries(merged.map((v) => [v.id, v]));
    expect(Object.keys(byId).sort()).toEqual(["vw_1", "vw_local", "vw_remote"]);
    expect(byId["vw_1"].addedAt).toBe(300); // 大者胜
    expect(byId["vw_local"].word).toBe("local-only"); // 本地新增保留
    expect(byId["vw_remote"].word).toBe("remote-only"); // 远端新增保留
  });

  it("mergeVocab：本地条目比远端新 → 保留本地（LWW）", () => {
    const local = [{ id: "vw_1", word: "hello", addedAt: 500 }];
    const remote = [{ id: "vw_1", word: "hello", addedAt: 300 }];
    expect(sync.mergeVocab(local, remote)).toEqual(local);
  });

  it("mergeVocab：非数组/空输入容错（undefined → 直接取对端）", () => {
    expect(sync.mergeVocab(undefined, [{ id: "v", addedAt: 1 }])).toEqual([
      { id: "v", addedAt: 1 },
    ]);
    expect(sync.mergeVocab([{ id: "v", addedAt: 1 }], null)).toEqual([{ id: "v", addedAt: 1 }]);
    expect(sync.mergeVocab(undefined, undefined)).toEqual([]);
  });

  it("mergeAnnotations：按书 version 大者胜；仅本地有的书保留", () => {
    const local = [
      {
        bookId: "b1",
        version: 500, // 本地新 → 保留
        highlights: [{ id: "hl_local", createdAt: 500 }],
        bookmarks: [],
        notes: [],
      },
      {
        bookId: "b_local",
        version: 10, // 仅本地
        highlights: [],
        bookmarks: [],
        notes: [],
      },
    ];
    const remote = [
      {
        bookId: "b1",
        version: 300,
        highlights: [{ id: "hl_remote", createdAt: 300 }],
        bookmarks: [],
        notes: [],
      },
      {
        bookId: "b2",
        version: 700, // 仅远端
        highlights: [],
        bookmarks: [],
        notes: [],
      },
    ];
    const merged = sync.mergeAnnotations(local, remote) as Array<{
      bookId: string;
      version: number;
      highlights: Array<{ id: string }>;
    }>;
    const byBook = Object.fromEntries(merged.map((a) => [a.bookId, a]));
    expect(Object.keys(byBook).sort()).toEqual(["b1", "b2", "b_local"]);
    expect(byBook["b1"].highlights[0].id).toBe("hl_local"); // 本地更新 → 保留
    expect(byBook["b2"].version).toBe(700); // 远端新增保留
    expect(byBook["b_local"].version).toBe(10); // 本地独有保留
  });

  it("mergeAnnotations：远端书更新 → 整书替换（LWW）", () => {
    const local = [
      {
        bookId: "b1",
        version: 100,
        highlights: [{ id: "hl_old", createdAt: 100 }],
        bookmarks: [],
        notes: [],
      },
    ];
    const remote = [
      {
        bookId: "b1",
        version: 200,
        highlights: [],
        bookmarks: [{ id: "bm_new", createdAt: 200 }],
        notes: [],
      },
    ];
    expect(sync.mergeAnnotations(local, remote)).toEqual(remote);
  });

  it("fetchAndCacheManifest：annotations/vocab 写入时与既有缓存合并（不整表覆盖）", async () => {
    await setNativeEnv();
    // 预置本地缓存：本地独有的生词 + 更新的标注书（模拟本端已有数据）
    await setCache("sync:vocab", [{ id: "vw_local", word: "local", addedAt: 99999 }]);
    await setCache("sync:annotations", [
      {
        bookId: "b1",
        version: 99999,
        highlights: [{ id: "hl_local", createdAt: 99999 }],
        bookmarks: [],
        notes: [],
      },
    ]);
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifestV1 });
    const r = await sync.syncNow();
    expect(r.ok).toBe(true);
    const vocab = (await getCache("sync:vocab")) as unknown as Array<{ id: string }>;
    const ids = vocab.map((v) => v.id).sort();
    expect(ids).toEqual(["vw_1", "vw_local"]); // 本地词保留 + 远端词并入
    const annotations = (await getCache("sync:annotations")) as unknown as Array<{
      bookId: string;
      version: number;
      highlights: Array<{ id: string }>;
    }>;
    const b1 = annotations.find((a) => a.bookId === "b1")!;
    expect(b1.highlights[0].id).toBe("hl_local"); // 本地书更新 → 保留（不整表覆盖）
    expect(annotations.length).toBe(1);
  });
});

describe("离线短路（主机不可达 · 契约 docs/host-reachability.md）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    sync._resetSyncForTests(); // 复位模块状态（appActive/轮询定时器/deviceId 缓存）
    apiMock.apiGet.mockClear();
    apiMock.apiPost.mockClear();
    apiMock.isOffline.mockReturnValue(false);
  });

  afterEach(() => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    apiMock.isOffline.mockReturnValue(false);
    vi.useRealTimers();
  });

  it("syncNow 离线 → 返回 {ok:false, message:'主机离线'}，不设 syncing（不转动画）、不发请求", async () => {
    await setNativeEnv();
    apiMock.isOffline.mockReturnValue(true);
    const r = await sync.syncNow();
    expect(r).toEqual({ ok: false, message: "主机离线" });
    expect(sync.syncState.syncing).toBe(false);
    expect(apiMock.apiGet).not.toHaveBeenCalled();
  });

  it("ensureCommandPolling 离线 → 不启动 interval；恢复在线后再启动", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, data: { commands: [] } });
    vi.useFakeTimers();
    // 离线：不启动轮询
    apiMock.isOffline.mockReturnValue(true);
    sync.ensureCommandPolling();
    await vi.advanceTimersByTimeAsync(60000);
    expect(apiMock.apiGet).not.toHaveBeenCalled();
    // 恢复在线：启动轮询（60s 后拉一次指令；getDeviceId 查询需再等 3s 超时结算）
    apiMock.isOffline.mockReturnValue(false);
    sync.ensureCommandPolling();
    await vi.advanceTimersByTimeAsync(60000);
    await vi.advanceTimersByTimeAsync(5000); // deviceId 查询超时（3s）→ 落到 apiGet
    expect(apiMock.apiGet).toHaveBeenCalled();
    sync.stopCommandPolling();
  });

  it("pollCommands 离线 → 短路返回，不发请求", async () => {
    await setNativeEnv();
    apiMock.isOffline.mockReturnValue(true);
    const r = await sync.pollCommands();
    expect(r).toEqual({ ok: false, executed: 0 });
    expect(apiMock.apiGet).not.toHaveBeenCalled();
  });

  it("reportAssets 离线 → 短路返回 false，不发请求", async () => {
    await setNativeEnv();
    apiMock.isOffline.mockReturnValue(true);
    const r = await sync.reportAssets();
    expect(r).toBe(false);
    expect(apiMock.apiPost).not.toHaveBeenCalled();
  });
});
