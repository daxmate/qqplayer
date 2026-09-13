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

async function setNativeEnv() {
  window.qqplayerNative = true;
}

describe("syncNow：manifest 拉取 + version 对比 + 集合写入", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
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

describe("mergeVocab / mergeAnnotations：标注按书 LWW、生词按 id 逐条 merge（P2-B）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
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
    sync._resetSyncForTests(); // 复位模块状态（appActive/轮询定时器/deviceId 缓存）
    apiMock.apiGet.mockClear();
    apiMock.apiPost.mockClear();
    apiMock.isOffline.mockReturnValue(false);
  });

  afterEach(() => {
    delete window.qqplayerNative;
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
});
