// sync.js T3 负一屏同步中心新增逻辑单测：
//   fetchAssetIndex / fetchAssetsSizeDetailed  资产注册表与存储细分查询
//   computeUpdateList  可更新判定（含首次注册表空策略：全部视为最新）
//   computeOrphanAssets  孤儿计算（歌词 meta key 不算；音频/封面/图书/词典为期望集）
//   assetForSong 带 manifest sha256（下载请求用真实值）
//   applyUpdates  可更新项重建下载项 → syncAssets
//   syncAll  一键拉全（缺失统计 / 自动更新门控 / 歌词失效检测）
//   detectStaleLyrics / invalidateLyricForSong / recordLyricMtimes  歌词失效判定
//   setWifiOnly / setAutoUpdate / clearAssetsByType / deleteOrphanAssets / waitAssetsDeleted
//
// mock 策略同 sync.test.js：nativeAudioBridge vi.mock（事件订阅 + 消息记录）、
// apiClient vi.mock（apiGet + resolveServerUrl）、localStorage stub。
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

// jsdom（vitest 4）无 localStorage → 手写 stub
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

async function setNativeEnv() {
  window.qqplayerNative = true;
}

function clearNativeEnv() {
  delete window.qqplayerNative;
}

beforeEach(() => {
  clearNativeEnv();
  apiMock.apiGet.mockReset();
  bridgeMock.post.mockClear();
  bridgeMock.handlers.clear();
  clearLs();
  vi.stubGlobal("localStorage", localStorageStub);
  sync._resetSyncForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// 测试素材：manifest 歌曲（T3 契约：带 sha256 / cover_source / lyric_mtime）
const songV1 = { path: "/Music/a.mp3", name: "A", sha256: "aa".repeat(32), size: 100 };
const songV2 = { ...songV1, sha256: "bb".repeat(32) }; // 内容变了
const songB = { path: "/Music/b.flac", name: "B", sha256: "cc".repeat(32), size: 200 };
const book1 = { id: "b1", title: "书一", size: 1000 };
const dict1 = { name: "oxford.mdx", path: "abc/oxford.mdx", size: 500 };

/** manifest 下载项的沙盒路径（assetForSong 同构，测试里同步算） */
async function audioPathOf(song: Parameters<typeof sync.assetForSong>[0]) {
  const item = await sync.assetForSong(song);
  return item!.path;
}
async function coverPathOf(path: string) {
  const item = await sync.coverItemFor(path);
  return item!.path;
}
async function bookPathOf(book: Parameters<typeof sync.assetForBook>[0]) {
  const item = await sync.assetForBook(book);
  return item!.path;
}
async function dictPathOf(dict: Parameters<typeof sync.assetForDict>[0]) {
  const item = await sync.assetForDict(dict);
  return item!.path;
}

describe("computeUpdateList：可更新判定 + 首次注册表空策略", () => {
  it("注册表为空（老版本升级）→ 全部视为最新，返回 []", async () => {
    await setNativeEnv();
    const list = await sync.computeUpdateList([songV1, songB], []);
    expect(list).toEqual([]);
    expect(await sync.computeUpdateList([songV1], null)).toEqual([]);
    expect(await sync.computeUpdateList([songV1], undefined)).toEqual([]);
  });

  it("本地 sha256 = manifest sha256 → 不标记可更新", async () => {
    const local = [{ path: await audioPathOf(songV1), sha256: songV1.sha256, size: 100 }];
    const list = await sync.computeUpdateList([songV1], local);
    expect(list).toEqual([]);
  });

  it("本地 sha256 ≠ manifest sha256 → 可更新 {path, name, kind}，带 manifest song", async () => {
    // 本地还是旧内容（songV1.sha256），manifest 已是新内容（songV2.sha256）→ 可更新
    const local = [{ path: await audioPathOf(songV1), sha256: songV1.sha256, size: 100 }];
    const list = await sync.computeUpdateList([songV2], local);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: local[0].path, name: "A", kind: "audio" });
    expect(list[0].song.sha256).toBe(songV2.sha256);
  });

  it("本地没有该资产 / manifest 缺 sha256 → 不标记", async () => {
    const local = [{ path: "audio/zzz.m4a", sha256: "xx", size: 1 }];
    const list = await sync.computeUpdateList([songV1, { path: "/Music/no-hash.mp3" }], local);
    expect(list).toEqual([]);
  });

  it("文件封面（cover_source=file）size 变化 → 标记 cover 更新项", async () => {
    const songWithCover = {
      ...songV1,
      cover_source: "file",
      cover_path: "cover.jpg",
      cover_size: 999,
      cover_mtime: 111,
    };
    const coverPath = await coverPathOf(songWithCover.path);
    // 本地已下载过旧封面（size 不同）→ 封面过期
    const local = [{ path: coverPath, sha256: "", size: 500 }];
    const list = await sync.computeUpdateList([songWithCover], local);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ path: coverPath, kind: "cover", coverStale: true });
  });

  it("文件封面 size 未变 / 内嵌封面 / 无封面 → 不标记封面更新", async () => {
    const songWithCover = {
      ...songV1,
      cover_source: "file",
      cover_path: "cover.jpg",
      cover_size: 999,
      cover_mtime: 111,
    };
    const coverPath = await coverPathOf(songWithCover.path);
    // size 一致 → 不更新；内嵌封面 → 不更新；null → 不更新
    const sameSize = [{ path: coverPath, sha256: "", size: 999 }];
    expect(await sync.computeUpdateList([songWithCover], sameSize)).toEqual([]);
    const embedded = { ...songV1, cover_source: "embedded" };
    expect(await sync.computeUpdateList([embedded], sameSize)).toEqual([]);
    const none = { ...songV1, cover_source: "null", cover_size: 0 };
    expect(await sync.computeUpdateList([none], sameSize)).toEqual([]);
  });
});

describe("computeOrphanAssets：期望集 diff 本地注册表", () => {
  it("音频/封面/图书/词典之外 → 孤儿，含可释放总大小；歌词 meta key 不算", async () => {
    await setNativeEnv();
    const audioA = await audioPathOf(songV1);
    const coverA = await coverPathOf(songV1.path);
    const audioB = await audioPathOf(songB);
    const book = await bookPathOf(book1);
    const dict = await dictPathOf(dict1);
    const local = [
      { path: audioA, sha256: songV1.sha256, size: 100 },
      { path: coverA, sha256: "c1", size: 10 },
      { path: audioB, sha256: songB.sha256, size: 200 },
      { path: book, sha256: "b1", size: 1000 },
      { path: dict, sha256: "d1", size: 500 },
      { path: "audio/orphan1.m4a", sha256: "o1", size: 77 }, // 孤儿
      { path: "books/orphan2.epub", sha256: "o2", size: 23 }, // 孤儿
      { path: "lyric:deadbeef", sha256: "o3", size: 999 }, // 歌词 meta key：不算
    ];
    const r = await sync.computeOrphanAssets([songV1, songB], [dict1], [book1], local);
    expect(r.orphans).toEqual([
      { path: "audio/orphan1.m4a", size: 77 },
      { path: "books/orphan2.epub", size: 23 },
    ]);
    expect(r.totalSize).toBe(100);
  });

  it("空注册表 → {orphans: [], totalSize: 0}", async () => {
    const r = await sync.computeOrphanAssets([songV1], [dict1], [book1], []);
    expect(r).toEqual({ orphans: [], totalSize: 0 });
  });
});

describe("仅 Wi-Fi / 自动更新开关", () => {
  it("wifiOnly 默认开；setWifiOnly(false) 持久化", () => {
    expect(sync.wifiOnlyEnabled()).toBe(true); // 默认开
    expect(sync.setWifiOnly(false)).toBe(false);
    expect(localStorage.getItem("qqplayer.syncWifiOnly")).toBe("off");
    expect(sync.setWifiOnly(true)).toBe(true);
    expect(localStorage.getItem("qqplayer.syncWifiOnly")).toBe("on");
  });

  it("autoUpdate 默认关；setAutoUpdate(true) 持久化", async () => {
    expect(sync.autoUpdateEnabled()).toBe(false);
    expect(sync.setAutoUpdate(true)).toBe(true);
    expect(localStorage.getItem("qqplayer.syncAutoUpdate")).toBe("on");
    expect(sync.setAutoUpdate(false)).toBe(false);
    expect(sync.autoUpdateEnabled()).toBe(false);
  });
});
