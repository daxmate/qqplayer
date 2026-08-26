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
  resolveServerUrl: vi.fn((p) =>
    /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
  ),
}));

vi.mock("../utils/apiClient.js", () => apiMock);

// ---------- 被测模块 ----------
import * as sync from "../utils/sync.js";

// jsdom（vitest 4）无 localStorage → 手写 stub
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

async function setNativeEnv() {
  window.qqplayerNative = true;
  window.qqplayerIosBridge = { postMessage: vi.fn() };
}

function clearNativeEnv() {
  delete window.qqplayerNative;
  delete window.qqplayerIosBridge;
}

/** 最新一次指定 cmd 的桥消息 */
function lastMsg(cmd) {
  const calls = bridgeMock.post.mock.calls.filter((c) => c[0] && c[0].cmd === cmd);
  return calls.length ? calls[calls.length - 1][0] : null;
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
async function audioPathOf(song) {
  const item = await sync.assetForSong(song);
  return item.path;
}
async function coverPathOf(path) {
  const item = await sync.coverItemFor(path);
  return item.path;
}
async function bookPathOf(book) {
  const item = await sync.assetForBook(book);
  return item.path;
}
async function dictPathOf(dict) {
  const item = await sync.assetForDict(dict);
  return item.path;
}

const manifest = {
  version: "20260826-1200",
  songs: [songV1, songB],
  books: [book1],
  dicts: [dict1],
  playlists: [],
  favorites: [],
};

describe("fetchAssetIndex：assetIndex 命令 + 回执", () => {
  it("回执 push('assetIndex',{assets}) → resolve(assets)", async () => {
    await setNativeEnv();
    const p = sync.fetchAssetIndex();
    expect(bridgeMock.post).toHaveBeenCalledWith({ cmd: "assetIndex" });
    const assets = [{ path: "audio/x.m4a", sha256: "h1", size: 10 }];
    bridgeMock.emit("assetIndex", { assets });
    await expect(p).resolves.toEqual(assets);
  });

  it("原生无回执：超时 resolve([])，不挂起", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.fetchAssetIndex();
    vi.advanceTimersByTime(sync.ASSET_INDEX_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual([]);
    // 迟到回执：忽略（已结算）
    bridgeMock.emit("assetIndex", { assets: [{ path: "audio/x.m4a" }] });
    vi.advanceTimersByTime(0);
  });

  it("非原生环境：立即 resolve([])，不发消息", async () => {
    await expect(sync.fetchAssetIndex()).resolves.toEqual([]);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});

describe("fetchAssetsSizeDetailed：assetsSize 回执扩展 byType", () => {
  it("回执 {total, byType} → resolve 完整明细", async () => {
    await setNativeEnv();
    const p = sync.fetchAssetsSizeDetailed();
    bridgeMock.emit("assetsSize", {
      total: 1000,
      byType: { audio: 400, covers: 100, lyric: 50, books: 300, dicts: 100, meta: 30, other: 20 },
    });
    const r = await p;
    expect(r.total).toBe(1000);
    expect(r.byType.audio).toBe(400);
    expect(r.byType.lyric).toBe(50);
  });

  it("旧壳只回 total：resolve {total, byType:{}}（不抛）", async () => {
    await setNativeEnv();
    const p = sync.fetchAssetsSizeDetailed();
    bridgeMock.emit("assetsSize", { total: 999 });
    const r = await p;
    expect(r.total).toBe(999);
    expect(r.byType).toEqual({});
  });

  it("超时 / 非原生 → resolve(null)；fetchAssetsSize 仍只回数字", async () => {
    // 非原生：立即 resolve(null)
    await expect(sync.fetchAssetsSize()).resolves.toBeNull();
    await expect(sync.fetchAssetsSizeDetailed()).resolves.toBeNull();
    // 原生 + 原生无回执：超时 resolve(null)
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.fetchAssetsSizeDetailed();
    vi.advanceTimersByTime(sync.ASSETS_SIZE_TIMEOUT_MS + 10);
    await expect(p).resolves.toBeNull();
    const p2 = sync.fetchAssetsSize();
    vi.advanceTimersByTime(sync.ASSETS_SIZE_TIMEOUT_MS + 10);
    await expect(p2).resolves.toBeNull();
  });
});

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

describe("assetForSong 带 sha256 / applyUpdates", () => {
  it("assetForSong：manifest 条目带 sha256 → 下载项 sha256 用真实值", async () => {
    const item = await sync.assetForSong(songV1);
    expect(item.sha256).toBe(songV1.sha256);
    expect(item.path).toMatch(/^audio\/[0-9a-f]{64}\.mp3$/);
    // 老清单缺 sha256 → 空串（兼容旧行为）
    const legacy = await sync.assetForSong({ path: "/Music/x.mp3", size: 1 });
    expect(legacy.sha256).toBe("");
  });

  it("applyUpdates：可更新项重建音频下载项（真实 sha256）→ syncAssets", async () => {
    await setNativeEnv();
    const list = await sync.computeUpdateList(
      [songV2],
      [{ path: await audioPathOf(songV1), sha256: songV1.sha256, size: 100 }],
    );
    expect(list).toHaveLength(1);
    const sent = await sync.applyUpdates(list);
    expect(sent).toBe(true);
    const msg = lastMsg("syncDownload");
    expect(msg).toBeTruthy();
    const audio = msg.items.find((i) => i.path.startsWith("audio/"));
    const cover = msg.items.find((i) => i.path.startsWith("covers/"));
    expect(audio.sha256).toBe(songV2.sha256); // 真实内容哈希
    expect(cover).toBeUndefined(); // 封面未过期：不重建封面项（sha256 空 + 已存在会恒过，无需重下）
    expect(audio.wifiOnly).toBe(true);
  });

  it("applyUpdates：封面过期项 → 先 deleteAssets 删旧封面 + 下载项带 manifest cover_size", async () => {
    await setNativeEnv();
    const songWithCover = {
      ...songV2,
      cover_source: "file",
      cover_path: "cover.jpg",
      cover_size: 999,
      cover_mtime: 111,
    };
    const coverPath = await coverPathOf(songWithCover.path);
    const list = await sync.computeUpdateList(
      [songWithCover],
      [
        { path: await audioPathOf(songV1), sha256: songV1.sha256, size: 100 },
        { path: coverPath, sha256: "", size: 500 }, // 旧封面 size 不同 → 过期
      ],
    );
    expect(list.find((u) => u.kind === "cover")).toBeTruthy();
    const sent = await sync.applyUpdates(list);
    expect(sent).toBe(true);
    // 先删旧封面（不删则原生 hasAsset 命中旧文件直接 done）
    const del = lastMsg("deleteAssets");
    expect(del.paths).toContain(coverPath);
    // 下载项：音频带真实 sha256，封面带 manifest cover_size（原生 size 校验）
    const msg = lastMsg("syncDownload");
    const audio = msg.items.find((i) => i.path.startsWith("audio/"));
    const cover = msg.items.find((i) => i.path.startsWith("covers/"));
    expect(audio.sha256).toBe(songWithCover.sha256);
    expect(cover.size).toBe(999);
  });

  it("applyUpdates：空列表 → false 不发消息", async () => {
    expect(await sync.applyUpdates([])).toBe(false);
    expect(await sync.applyUpdates(null)).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});

describe("syncAll：一键拉全（缺失下载 + 更新门控 + 歌词失效）", () => {
  it("缺失统计 + 下载（音频/封面/图书/词典）；自动更新关 → 不应用更新", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifest });
    // 本地注册表：只有 a.mp3 的音频（缺封面/书/词典/b.flac）
    const audioA = await audioPathOf(songV1);
    const p = sync.syncAll();
    bridgeMock.emit("assetIndex", {
      assets: [{ path: audioA, sha256: songV1.sha256, size: 100 }],
    });
    const r = await p;
    expect(r.ok).toBe(true);
    // 缺失：b 音频+封面、a 封面、书、词典 = 5 项
    expect(r.missing).toEqual({ audio: 1, covers: 2, books: 1, dicts: 1 });
    const msg = lastMsg("syncDownload");
    expect(msg.items).toHaveLength(5);
    expect(msg.items.every((i) => i.wifiOnly === true)).toBe(true);
    // 自动更新默认关：a.mp3 已本地且 sha 相同，无更新项
    expect(r.updateCount).toBe(0);
  });

  it("自动更新开 + 本地 sha 与 manifest 不同 → 同步后自动应用更新", async () => {
    await setNativeEnv();
    sync.setAutoUpdate(true);
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: manifest });
    const audioA = await audioPathOf(songV1);
    const coverA = await coverPathOf(songV1.path);
    const audioB = await audioPathOf(songB);
    const book = await bookPathOf(book1);
    const dict = await dictPathOf(dict1);
    const p = sync.syncAll();
    bridgeMock.emit("assetIndex", {
      assets: [
        { path: audioA, sha256: "old-hash", size: 100 }, // sha 与 manifest 不同 → 可更新
        { path: coverA, sha256: "c1", size: 10 },
        { path: audioB, sha256: songB.sha256, size: 200 },
        { path: book, sha256: "b1", size: 1000 },
        { path: dict, sha256: "d1", size: 500 },
      ],
    });
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.updateCount).toBe(1); // 只有 a.mp3 音频可更新
    // 下载消息含缺失项 + 更新项（audioA 以新 sha 重新下载）
    const msgs = bridgeMock.post.mock.calls
      .filter((c) => c[0] && c[0].cmd === "syncDownload")
      .map((c) => c[0]);
    const updateMsg = msgs.find((m) =>
      m.items.some((i) => i.path === audioA && i.sha256 === songV1.sha256),
    );
    expect(updateMsg).toBeTruthy();
  });

  it("manifest 拉取失败 → {ok:false, message}，不发下载", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: false, status: 500, message: "boom" });
    const p = sync.syncAll();
    bridgeMock.emit("assetIndex", { assets: [] }); // Promise.all 需要 assetIndex 也结算
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toBe("boom");
    // assetIndex 查询命令允许发出（Promise.all 并行）；不得有下载/删除消息
    expect(lastMsg("syncDownload")).toBeNull();
    expect(lastMsg("deleteAssets")).toBeNull();
  });

  it("桌面浏览器：no-op 返回 {enabled:false}", async () => {
    const r = await sync.syncAll();
    expect(r).toEqual({ enabled: false, ok: false });
    expect(apiMock.apiGet).not.toHaveBeenCalled();
  });
});

describe("歌词失效判定（mock nativeMetaLoad 链路）", () => {
  const songWithLyric = { path: "/Music/a.mp3", name: "A", lyric_mtime: 111 };

  it("recordLyricMtimes：写 syncMeta（song path → lyric_mtime）", async () => {
    await setNativeEnv();
    const p = sync.recordLyricMtimes([songWithLyric]);
    // 先读旧记录（文件缺失 → json null）
    const loadMsg = lastMsg("metaLoad");
    expect(loadMsg.kind).toBe("syncMeta");
    bridgeMock.emit("metaLoaded", { requestId: loadMsg.requestId, kind: "syncMeta", json: null });
    await p;
    const msg = lastMsg("metaSave");
    expect(msg.kind).toBe("syncMeta");
    expect(JSON.parse(msg.json)).toEqual({ "/Music/a.mp3": 111 });
  });

  it("detectStaleLyrics：mtime 变了 → 返回该歌曲；未变 → 空", async () => {
    await setNativeEnv();
    // 先记录基线（metaSave syncMeta {path: 111}）
    let p = sync.recordLyricMtimes([songWithLyric]);
    let loadMsg = lastMsg("metaLoad");
    bridgeMock.emit("metaLoaded", { requestId: loadMsg.requestId, kind: "syncMeta", json: null });
    await p;
    const saveMsg = lastMsg("metaSave");
    // mtime 变了（111 → 222）：检测到失效
    p = sync.detectStaleLyrics([{ ...songWithLyric, lyric_mtime: 222 }]);
    loadMsg = lastMsg("metaLoad");
    bridgeMock.emit("metaLoaded", {
      requestId: loadMsg.requestId,
      kind: "syncMeta",
      json: saveMsg.json,
    });
    const stale = await p;
    expect(stale).toHaveLength(1);
    expect(stale[0].path).toBe("/Music/a.mp3");
    // mtime 未变：不失效
    p = sync.detectStaleLyrics([songWithLyric]);
    loadMsg = lastMsg("metaLoad");
    bridgeMock.emit("metaLoaded", {
      requestId: loadMsg.requestId,
      kind: "syncMeta",
      json: saveMsg.json,
    });
    await expect(p).resolves.toEqual([]);
  });

  it("detectStaleLyrics：无 lyric_mtime 条目 / 非原生 → 不查不返回", async () => {
    await setNativeEnv();
    await expect(sync.detectStaleLyrics([{ path: "/Music/x.mp3" }])).resolves.toEqual([]);
    await expect(sync.detectStaleLyrics([])).resolves.toEqual([]);
    clearNativeEnv();
    await expect(sync.detectStaleLyrics([songWithLyric])).resolves.toEqual([]);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("invalidateLyricForSong：metaSave lyric:<hash> 覆盖为 {} 哨兵（清缓存）", async () => {
    await setNativeEnv();
    expect(await sync.invalidateLyricForSong(songWithLyric)).toBe(true);
    const msg = lastMsg("metaSave");
    expect(msg.kind).toMatch(/^lyric:[0-9a-f]{64}$/);
    expect(msg.json).toBe("{}"); // 空对象哨兵：loadLyricFile 视为无缓存
    // 非原生 → false
    clearNativeEnv();
    expect(await sync.invalidateLyricForSong(songWithLyric)).toBe(false);
  });
});

describe("仅 Wi-Fi / 自动更新开关", () => {
  it("wifiOnly 默认开；setWifiOnly(false) 持久化 + 通知原生", async () => {
    await setNativeEnv();
    expect(sync.wifiOnlyEnabled()).toBe(true); // 默认开
    expect(sync.setWifiOnly(false)).toBe(false);
    expect(localStorage.getItem("qqplayer.syncWifiOnly")).toBe("off");
    expect(bridgeMock.post).toHaveBeenCalledWith({ cmd: "setWifiOnly", on: false });
    // 之后 syncAssets 的 items 带 wifiOnly: false
    sync.syncAssets([{ url: "http://s/a.m4a", path: "audio/a.m4a", sha256: "", size: 1 }]);
    const msg = lastMsg("syncDownload");
    expect(msg.items[0].wifiOnly).toBe(false);
  });

  it("autoUpdate 默认关；setAutoUpdate(true) 持久化", async () => {
    expect(sync.autoUpdateEnabled()).toBe(false);
    expect(sync.setAutoUpdate(true)).toBe(true);
    expect(localStorage.getItem("qqplayer.syncAutoUpdate")).toBe("on");
    expect(sync.setAutoUpdate(false)).toBe(false);
    expect(sync.autoUpdateEnabled()).toBe(false);
  });
});

describe("精确删除：clearAssetsByType / deleteOrphanAssets / waitAssetsDeleted", () => {
  it("clearAssetsByType：按前缀过滤 paths → deleteAssets {paths}", async () => {
    await setNativeEnv();
    const assets = [
      { path: "audio/a.m4a", sha256: "", size: 1 },
      { path: "covers/a.jpg", sha256: "", size: 1 },
      { path: "books/b.epub", sha256: "", size: 1 },
      { path: "dicts/d.mdx", sha256: "", size: 1 },
      { path: "audio/orphan.m4a", sha256: "", size: 1 },
    ];
    expect(sync.clearAssetsByType("audio", assets)).toBe(2);
    expect(sync.clearAssetsByType("covers", assets)).toBe(1);
    expect(sync.clearAssetsByType("dicts", assets)).toBe(1);
    const dels = bridgeMock.post.mock.calls
      .filter((c) => c[0] && c[0].cmd === "deleteAssets")
      .map((c) => c[0]);
    expect(dels[0]).toEqual({ cmd: "deleteAssets", paths: ["audio/a.m4a", "audio/orphan.m4a"] });
    expect(dels[1]).toEqual({ cmd: "deleteAssets", paths: ["covers/a.jpg"] });
    expect(dels[2]).toEqual({ cmd: "deleteAssets", paths: ["dicts/d.mdx"] });
    // lyric 前缀（meta kind）
    expect(sync.clearAssetsByType("lyric", [{ path: "lyric:abc" }])).toBe(1);
    // 无匹配且无 scope 回退（covers）→ 0
    expect(sync.clearAssetsByType("covers", [])).toBe(0);
  });

  it("deleteOrphanAssets：孤儿 paths → deleteAssets；空列表不发", async () => {
    await setNativeEnv();
    expect(sync.deleteOrphanAssets([{ path: "audio/x.m4a", size: 1 }])).toBe(true);
    expect(lastMsg("deleteAssets")).toEqual({ cmd: "deleteAssets", paths: ["audio/x.m4a"] });
    bridgeMock.post.mockClear();
    expect(sync.deleteOrphanAssets([])).toBe(false);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("waitAssetsDeleted：回推 paths 结算；超时 resolve([])", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.waitAssetsDeleted(1000);
    bridgeMock.emit("assetsDeleted", { paths: ["audio/x.m4a"] });
    await expect(p).resolves.toEqual(["audio/x.m4a"]);
    // 超时路径
    const p2 = sync.waitAssetsDeleted(1000);
    vi.advanceTimersByTime(1001);
    await expect(p2).resolves.toEqual([]);
  });
});
