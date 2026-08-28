// sync.js 任务 G（同步附加歌词/封面元数据）新函数单测：
//   buildSongSyncItems  每首歌音频+封面两项 / path 缺失流媒体整首跳过 / url·path 格式
//   syncLyricsForSongs  调 apiGet → 成功写 nativeMetaSave(lyric:<hash>) / 失败静默 /
//                       无歌词跳过 / 小并发限流 / 总超时兜底 / 非 iOS 壳 no-op
//   displayNameOf       同步面板封面项名不露 covers/ 前缀（经 syncAssets 登记验证）
//
// mock 策略同 sync.test.js / syncAssets.test.js：
//   - nativeAudioBridge：vi.mock 整模块（onNativeEvent 捕获订阅者 / nativePost 记录消息）
//   - apiClient：vi.mock 整模块（apiGet + resolveServerUrl）
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

// ---------- 被测模块（静态导入；_resetSyncForTests 保证用例隔离） ----------
import * as sync from "../utils/sync.js";

async function setNativeEnv() {
  window.qqplayerNative = true;
  window.qqplayerIosBridge = { postMessage: vi.fn() };
}

function clearNativeEnv() {
  delete window.qqplayerNative;
  delete window.qqplayerIosBridge;
}

const lyricOK = {
  ok: true,
  status: 200,
  data: { lines: [{ type: "l", s: 0, e: 1.5, text: "hello" }], format: "lrc", source: "local" },
};

describe("buildSongSyncItems：音频+封面两项 / path 缺失跳过 / 格式", () => {
  beforeEach(() => {
    sync._resetSyncForTests();
  });

  it("每首本地歌 → 音频项+封面项，拍平返回（顺序音频、封面交错）", async () => {
    const items = await sync.buildSongSyncItems([
      { path: "/Music/a.mp3", size: 100 },
      { path: "/Music/b.flac", size: 200 },
    ]);
    expect(items).toHaveLength(4);
    const audio = items.filter((i) => i.path.startsWith("audio/"));
    const covers = items.filter((i) => i.path.startsWith("covers/"));
    expect(audio).toHaveLength(2);
    expect(covers).toHaveLength(2);
    // 音频项与 assetForSong 一致（url=/api/audio?path=..., path=audio/<64hex>.<ext>）
    expect(audio[0].url).toBe(
      "http://192.168.1.50:17627/api/audio?path=" + encodeURIComponent("/Music/a.mp3"),
    );
    expect(audio[0].path).toMatch(/^audio\/[0-9a-f]{64}\.mp3$/);
    expect(audio[0].size).toBe(100);
    // 封面项格式：url=/api/cover?path=..., path=covers/<64hex>.jpg（统一 JPEG 命名）
    expect(covers[0].url).toBe(
      "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent("/Music/a.mp3"),
    );
    expect(covers[0].path).toMatch(/^covers\/[0-9a-f]{64}\.jpg$/);
    expect(covers[0].sha256).toBe("");
    expect(covers[0].size).toBe(0);
    expect(covers[1].path).toMatch(/^covers\/[0-9a-f]{64}\.jpg$/);
  });

  it("path 缺失的流媒体条目整首跳过（音频+封面都不出）；混合列表只留本地歌", async () => {
    const items = await sync.buildSongSyncItems([
      { name: "stream", type: "stream" }, // 流媒体：无 path
      { path: "/Music/a.mp3" },
      null,
      { name: "no-path" },
    ]);
    expect(items).toHaveLength(2); // 只有 /Music/a.mp3 的音频+封面
    expect(items.every((i) => i.path.startsWith("audio/") || i.path.startsWith("covers/"))).toBe(
      true,
    );
  });

  it("非数组 → []", async () => {
    expect(await sync.buildSongSyncItems(null)).toEqual([]);
    expect(await sync.buildSongSyncItems("x")).toEqual([]);
    expect(await sync.buildSongSyncItems(undefined)).toEqual([]);
  });
});

describe("displayNameOf：covers 前缀不显示（同步面板封面项名）", () => {
  beforeEach(() => {
    sync._resetSyncForTests();
  });

  it("syncAssets 登记 covers 项：name 无 covers/ 前缀（<hash>.jpg）", async () => {
    await setNativeEnv();
    const hash = "ab".repeat(32); // 64 hex
    sync.syncAssets([
      {
        url: "http://192.168.1.50:17627/api/cover?path=%2FMusic%2Fa.mp3",
        path: "covers/" + hash + ".jpg",
        sha256: "",
        size: 0,
      },
    ]);
    expect(sync.syncDownloads["covers/" + hash + ".jpg"].name).toBe(hash + ".jpg");
  });

  it("既有 audio/books/dicts 前缀行为不变", async () => {
    await setNativeEnv();
    sync.syncAssets([
      { url: "http://s/a", path: "audio/aa.mp3", sha256: "", size: 1 },
      { url: "http://s/b", path: "books/bb.epub", sha256: "", size: 1 },
      { url: "http://s/c", path: "dicts/cc.mdx", sha256: "", size: 1 },
    ]);
    expect(sync.syncDownloads["audio/aa.mp3"].name).toBe("aa.mp3");
    expect(sync.syncDownloads["books/bb.epub"].name).toBe("bb.epub");
    expect(sync.syncDownloads["dicts/cc.mdx"].name).toBe("cc.mdx");
  });
});

describe("syncLyricsForSongs：调 apiGet → 落文件 / 失败静默 / 无歌词跳过", () => {
  beforeEach(() => {
    clearNativeEnv();
    apiMock.apiGet.mockReset();
    bridgeMock.post.mockClear();
    bridgeMock.handlers.clear();
    sync._resetSyncForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("成功：逐首调 apiGet（url 与 useLyric.lyricUrl 同构）→ nativeMetaSave(lyric:<hash>) 写文件", async () => {
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue(lyricOK);
    const r = await sync.syncLyricsForSongs([{ path: "/Music/a.mp3" }, { path: "/Music/b.flac" }]);
    expect(r).toEqual({ ok: 2, total: 2 });
    expect(apiMock.apiGet).toHaveBeenCalledTimes(2);
    // URL 构造：/api/lyric?path=<encodeURIComponent>&prefer=local
    expect(apiMock.apiGet.mock.calls[0][0]).toBe(
      "/api/lyric?path=" + encodeURIComponent("/Music/a.mp3") + "&prefer=local",
    );
    // 落文件：kind = lyric:<64hex>，json 含 lines/format/source
    const saveCalls = bridgeMock.post.mock.calls.filter((c) => c[0].cmd === "metaSave");
    expect(saveCalls).toHaveLength(2);
    for (const [msg] of saveCalls) {
      expect(msg.kind).toMatch(/^lyric:[0-9a-f]{64}$/);
      const parsed = JSON.parse(msg.json);
      expect(parsed.lines).toEqual([{ type: "l", s: 0, e: 1.5, text: "hello" }]);
      expect(parsed.format).toBe("lrc");
      expect(parsed.source).toBe("local");
    }
    // 只发过 metaSave（无 syncDownload / hasAsset 等其它桥消息）
    expect(saveCalls).toHaveLength(bridgeMock.post.mock.calls.length);
  });

  it("无歌词（ok:false / lines 空）：跳过不写文件，返回 {ok:0, total:n}", async () => {
    await setNativeEnv();
    apiMock.apiGet
      .mockResolvedValueOnce({ ok: false, status: 404, message: "no lyric" }) // 404
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { lines: [], format: null, source: null },
      }); // 空歌词
    const r = await sync.syncLyricsForSongs([{ path: "/Music/a.mp3" }, { path: "/Music/b.mp3" }]);
    expect(r).toEqual({ ok: 0, total: 2 });
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("网络异常（apiGet 抛错）：单首静默，不写文件、不 reject，其余继续", async () => {
    await setNativeEnv();
    apiMock.apiGet
      .mockRejectedValueOnce(new Error("network down")) // 第一首抛错
      .mockResolvedValueOnce(lyricOK); // 第二首正常
    const r = await sync.syncLyricsForSongs([{ path: "/Music/a.mp3" }, { path: "/Music/b.mp3" }]);
    expect(r).toEqual({ ok: 1, total: 2 });
    const saveCalls = bridgeMock.post.mock.calls.filter((c) => c[0].cmd === "metaSave");
    expect(saveCalls).toHaveLength(1); // 只写了第二首
  });

  it("限流：mock apiGet 并发计数 ≤ LYRIC_SYNC_CONCURRENCY，126 首全部处理完", async () => {
    await setNativeEnv();
    const songs = Array.from({ length: 126 }, (_, i) => ({ path: "/Music/s" + i + ".mp3" }));
    let inFlight = 0;
    let maxInFlight = 0;
    apiMock.apiGet.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5)); // 模拟网络延迟，制造并发窗口
      inFlight -= 1;
      return lyricOK;
    });
    const r = await sync.syncLyricsForSongs(songs);
    expect(r).toEqual({ ok: 126, total: 126 });
    expect(apiMock.apiGet).toHaveBeenCalledTimes(126);
    expect(maxInFlight).toBeLessThanOrEqual(sync.LYRIC_SYNC_CONCURRENCY);
  });

  it("总超时兜底：60s 未完成 → 静默返回已完部分，不 reject", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    apiMock.apiGet.mockReturnValue(new Promise(() => {})); // 永不 resolve：模拟后端卡死
    const p = sync.syncLyricsForSongs([{ path: "/Music/a.mp3" }, { path: "/Music/b.mp3" }]);
    expect(apiMock.apiGet).toHaveBeenCalledTimes(2); // 并发池内全部发起（5 ≥ 2）
    await vi.advanceTimersByTimeAsync(sync.LYRIC_SYNC_TOTAL_TIMEOUT_MS + 10);
    await expect(p).resolves.toEqual({ ok: 0, total: 2 });
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("非 iOS 壳（桌面/无桥）：不请求不写，返回 {ok:0, total:0}", async () => {
    const r = await sync.syncLyricsForSongs([{ path: "/Music/a.mp3" }]);
    expect(r).toEqual({ ok: 0, total: 0 });
    expect(apiMock.apiGet).not.toHaveBeenCalled();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });

  it("空数组 / 无 path 条目：{ok:0, total:0}，不发请求", async () => {
    await setNativeEnv();
    expect(await sync.syncLyricsForSongs([])).toEqual({ ok: 0, total: 0 });
    expect(await sync.syncLyricsForSongs(null)).toEqual({ ok: 0, total: 0 });
    expect(
      await sync.syncLyricsForSongs([{ name: "stream", type: "stream" }, { name: "x" }]),
    ).toEqual({ ok: 0, total: 0 });
    expect(apiMock.apiGet).not.toHaveBeenCalled();
  });
});
