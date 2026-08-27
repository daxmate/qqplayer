// 封面离线缓存 + 歌词文件兜底测试（阶段 F1/F2）
// 覆盖：coverAssetKey/coverItemFor/lyricKindKey（稳定哈希）/ cachedCoverURL（本地命中→
// 本地 URL，未命中→null 且不下载）/ cacheCover（显式下载，已存在跳过）/ useCoverURL
// （异步填充、本地优先、幂等、非壳远程直出）/ loadLyric 歌词文件写读兜底
//
// mock 策略（对齐 sync.test.js）：apiClient vi.mock（apiGet + resolveServerUrl）；
// nativeAudioBridge vi.mock（onNativeEvent 订阅 + nativePost 记录）；cacheDb 真实（内存实现）。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------- mock：nativeAudioBridge（事件订阅 + 发消息） ----------
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map();
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
  // playerCore 模块加载期调用 isNativePlayback() 决定 audio 实现；
  // 测试用标准 Audio（jsdom stub 已全局注册），返回 false 走普通路径
  isNativePlayback: () => false,
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
import { useCoverURL, COVER_CACHE_FIRST_N } from "../composables/useCoverURL.js";

// jsdom 无 localStorage → stub
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

function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

// 已回执过的 hasAsset requestId（跨调用去重：replyHasAsset 只回执"最新未回执"的查询，
// 避免 cacheCover 连锁查询时取到旧 requestId 导致新查询永远等不到回执——CI flaky 根因）
const repliedHasAssetIds = new Set();

afterEach(() => {
  repliedHasAssetIds.clear();
});

async function setNativeEnv({ bridge = true } = {}) {
  window.qqplayerNative = true;
  if (bridge) window.qqplayerIosBridge = { postMessage: vi.fn() };
}

/** 找到最近一次未回执的 hasAsset 并回执 assetStatus（已回执的 requestId 跳过） */
async function replyHasAsset({ exists, localURL }) {
  let msg;
  await vi.waitFor(
    () => {
      const calls = bridgeMock.post.mock.calls.filter(
        ([m]) => m && m.cmd === "hasAsset" && !repliedHasAssetIds.has(m.requestId),
      );
      expect(calls.length).toBeGreaterThan(0);
      msg = calls[calls.length - 1][0];
    },
    { timeout: 5000, interval: 20 },
  );
  repliedHasAssetIds.add(msg.requestId);
  bridgeMock.emit("assetStatus", {
    requestId: msg.requestId,
    path: msg.path,
    exists,
    localURL: localURL || null,
  });
}

describe("cover/lyric 缓存 key（stableHash 派生）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
  });

  it("coverAssetKey：稳定、同 path 同 key、格式 covers/<hash>.jpg", async () => {
    const k1 = await sync.coverAssetKey("/Music/a.mp3");
    const k2 = await sync.coverAssetKey("/Music/a.mp3");
    const k3 = await sync.coverAssetKey("/Music/b.mp3");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^covers\/[0-9a-f]+\.jpg$/);
    expect(k1).not.toBe(k3);
  });

  it("coverAssetKey：空 path → null", async () => {
    expect(await sync.coverAssetKey("")).toBeNull();
    expect(await sync.coverAssetKey(null)).toBeNull();
  });

  it("coverItemFor：url 指向 cover 端点 + 沙盒 path", async () => {
    const item = await sync.coverItemFor("/Music/a.mp3");
    expect(item).not.toBeNull();
    expect(item.url).toBe(
      "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent("/Music/a.mp3"),
    );
    expect(item.path).toMatch(/^covers\/[0-9a-f]+\.jpg$/);
    expect(item.sha256).toBe("");
    expect(item.size).toBe(0);
  });

  it("lyricKindKey：lyric:<hash> 稳定格式", async () => {
    const k1 = await sync.lyricKindKey("/Music/a.mp3");
    const k2 = await sync.lyricKindKey("/Music/a.mp3");
    expect(k1).toMatch(/^lyric:[0-9a-f]+$/);
    expect(k1).toBe(k2);
    expect(await sync.lyricKindKey(null)).toBeNull();
  });
});

describe("cachedCoverURL：封面本地优先查询（只查不下载）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
  });

  it("非 iOS 壳：resolve(null)，不发消息", async () => {
    const url = await sync.cachedCoverURL("/Music/a.mp3");
    expect(url).toBeNull();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("空 path → null", async () => {
    await setNativeEnv();
    expect(await sync.cachedCoverURL("")).toBeNull();
    expect(await sync.cachedCoverURL(null)).toBeNull();
  });

  it("命中本地缓存 → resolve 本地 HTTP URL", async () => {
    await setNativeEnv();
    const key = await sync.coverAssetKey("/Music/a.mp3");
    const p = sync.cachedCoverURL("/Music/a.mp3");
    await replyHasAsset({
      exists: true,
      localURL: "file:///var/mobile/.../Documents/qqplayer-assets/" + key,
    });
    const url = await p;
    expect(url).toBe("http://127.0.0.1:17888/native-assets/" + key);
  });

  it("未命中 → resolve(null) 且不发 syncDownload（即使 autoPrefetch 开）", async () => {
    await setNativeEnv();
    lsStore["qqplayer.autoPrefetch"] = "on"; // autoPrefetch 开也不下载（skipAutoDownload）
    const p = sync.cachedCoverURL("/Music/a.mp3");
    await replyHasAsset({ exists: false });
    expect(await p).toBeNull();
    const cmds = bridgeMock.post.mock.calls.map(([m]) => m && m.cmd);
    expect(cmds).not.toContain("syncDownload");
  });
});

describe("cacheCover：封面后台缓存（显式下载）", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
  });

  it("非 iOS 壳：no-op 不发消息", () => {
    sync.cacheCover("/Music/a.mp3");
    return flush().then(() => {
      expect(bridgeMock.post).not.toHaveBeenCalled();
    });
  });

  it("未命中 → 发 syncDownload（含 cover item）", async () => {
    await setNativeEnv();
    sync.cacheCover("/Music/a.mp3");
    await vi.waitFor(() => {
      expect(bridgeMock.post.mock.calls.some(([m]) => m && m.cmd === "hasAsset")).toBe(true);
    });
    // 回执未命中 → 触发下载
    const call = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "hasAsset")[0];
    bridgeMock.emit("assetStatus", {
      requestId: call.requestId,
      path: call.path,
      exists: false,
      localURL: null,
    });
    await vi.waitFor(() => {
      const dl = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "syncDownload");
      expect(dl).toBeTruthy();
      expect(dl[0].items[0].path).toMatch(/^covers\//);
      expect(dl[0].items[0].url).toContain("/api/cover");
    });
  });

  it("已存在 → 不发 syncDownload", async () => {
    await setNativeEnv();
    const key = await sync.coverAssetKey("/Music/a.mp3");
    sync.cacheCover("/Music/a.mp3");
    await vi.waitFor(() => {
      expect(bridgeMock.post.mock.calls.some(([m]) => m && m.cmd === "hasAsset")).toBe(true);
    });
    const call = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "hasAsset")[0];
    bridgeMock.emit("assetStatus", {
      requestId: call.requestId,
      path: call.path,
      exists: true,
      localURL: "file:///var/.../qqplayer-assets/" + key,
    });
    await flush();
    const cmds = bridgeMock.post.mock.calls.map(([m]) => m && m.cmd);
    expect(cmds).not.toContain("syncDownload");
  });
});

describe("useCoverURL：封面异步解析 composable", () => {
  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
  });

  it("桌面/非壳：resolveCover 同步远程直出（行为零变化）", () => {
    const { coverSrc, resolveCover } = useCoverURL();
    resolveCover("/Music/a.mp3");
    expect(coverSrc("/Music/a.mp3")).toBe(
      "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent("/Music/a.mp3"),
    );
  });

  it("iOS 壳：命中本地 → coverSrc 变本地 URL；幂等不重复查询", async () => {
    await setNativeEnv();
    const key = await sync.coverAssetKey("/Music/a.mp3");
    const { coverSrc, resolveCover } = useCoverURL();
    resolveCover("/Music/a.mp3", { download: true });
    // 未解析完成前为空（模板 v-if 隐藏 <img>）
    expect(coverSrc("/Music/a.mp3")).toBe("");
    await replyHasAsset({
      exists: true,
      localURL: "file:///var/.../qqplayer-assets/" + key,
    });
    await flush();
    expect(coverSrc("/Music/a.mp3")).toBe("http://127.0.0.1:17888/native-assets/" + key);
    const cmds = bridgeMock.post.mock.calls.map(([m]) => m && m.cmd);
    expect(cmds.filter((c) => c === "hasAsset")).toHaveLength(1); // 幂等
  });

  it("iOS 壳：未命中 → 远程 URL + download:true 时后台缓存", async () => {
    await setNativeEnv();
    const { coverSrc, resolveCover } = useCoverURL();
    resolveCover("/Music/a.mp3", { download: true });
    await replyHasAsset({ exists: false });
    await flush();
    expect(coverSrc("/Music/a.mp3")).toBe(
      "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent("/Music/a.mp3"),
    );
    // cacheCover 内部会再发一次 hasAsset（第二次），回执未命中 → 触发 syncDownload
    await replyHasAsset({ exists: false });
    await vi.waitFor(() => {
      expect(bridgeMock.post.mock.calls.some(([m]) => m && m.cmd === "syncDownload")).toBe(true);
    });
  });

  it("COVER_CACHE_FIRST_N 常量存在（节流阈值）", () => {
    expect(COVER_CACHE_FIRST_N).toBeGreaterThan(0);
  });
});

describe("loadLyric 歌词文件兜底（阶段 F2）", () => {
  let lyricModule;
  let lyricState;

  beforeEach(async () => {
    delete window.qqplayerNative;
    delete window.qqplayerIosBridge;
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
    // 动态导入 useLyric（playerCore 有模块加载期副作用，隔离测试）；
    // 复用当前 sync（真实）——歌词文件写读走 nativeMetaSave/Load 桥（mock post/emit）。
    lyricModule = await import("../composables/useLyric.js");
    const { state } = await import("../composables/usePlayer.js");
    lyricState = state;
    lyricState.songs = [{ path: "/Music/a.mp3", name: "A", artist: "X" }];
    lyricState.currentIndex = 0;
    lyricState.lyric = [];
    lyricState.lyricFormat = null;
    lyricState.lyricSource = null;
  });

  it("非 iOS 壳：成功加载不写文件（不发 metaSave）", async () => {
    apiMock.apiGet.mockResolvedValueOnce({
      ok: true,
      data: { lines: [{ s: 0, e: 5, text: ["词"] }], format: "lrc", source: "local" },
    });
    await lyricModule.loadLyric(0);
    expect(lyricState.lyric.length).toBe(1);
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("iOS 壳：成功加载 → 写歌词文件（metaSave）", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValueOnce({
      ok: true,
      data: { lines: [{ s: 0, e: 5, text: ["词"] }], format: "lrc", source: "local" },
    });
    await lyricModule.loadLyric(0);
    expect(lyricState.lyric.length).toBe(1);
    await flush();
    const save = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "metaSave");
    expect(save).toBeTruthy();
    expect(save[0].kind).toMatch(/^lyric:[0-9a-f]+$/);
    const data = JSON.parse(save[0].json);
    expect(data.lines.length).toBe(1);
    expect(data.format).toBe("lrc");
  });

  it("iOS 壳：网络失败 + 文件有数据 → 读文件回填歌词", async () => {
    await setNativeEnv();
    // 第一次：成功加载 → 写文件
    apiMock.apiGet.mockResolvedValueOnce({
      ok: true,
      data: { lines: [{ s: 0, e: 5, text: ["离线词"] }], format: "lrc", source: "local" },
    });
    await lyricModule.loadLyric(0);
    expect(lyricState.lyric[0].text[0]).toBe("离线词");
    await flush();
    const save = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "metaSave");
    expect(save).toBeTruthy();
    // 第二次：网络失败（无缓存）→ 读文件回填；模拟原生 metaLoaded 回执返回刚才写入的 json
    apiMock.apiGet.mockResolvedValueOnce({ ok: false, status: 0, data: null, network: true });
    lyricState.lyric = [];
    const p = lyricModule.loadLyric(0);
    await vi.waitFor(() => {
      expect(bridgeMock.post.mock.calls.some(([m]) => m && m.cmd === "metaLoad")).toBe(true);
    });
    const load = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "metaLoad");
    bridgeMock.emit("metaLoaded", {
      requestId: load[0].requestId,
      kind: load[0].kind,
      json: save[0].json,
    });
    await p;
    expect(lyricState.lyric.length).toBe(1);
    expect(lyricState.lyric[0].text[0]).toBe("离线词");
    expect(lyricState.lyricFormat).toBe("lrc");
  });

  it("iOS 壳：网络失败 + 无文件 → 空歌词", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValueOnce({ ok: false, status: 0, data: null, network: true });
    const p = lyricModule.loadLyric(0);
    // 模拟原生 metaLoaded 回执：文件缺失（无 json）→ resolve(null)
    await vi.waitFor(() => {
      expect(bridgeMock.post.mock.calls.some(([m]) => m && m.cmd === "metaLoad")).toBe(true);
    });
    const load = bridgeMock.post.mock.calls.find(([m]) => m && m.cmd === "metaLoad");
    bridgeMock.emit("metaLoaded", {
      requestId: load[0].requestId,
      kind: load[0].kind,
      json: null,
    });
    await p;
    expect(lyricState.lyric).toEqual([]);
    expect(lyricState.lyricFormat).toBeNull();
  });
});
