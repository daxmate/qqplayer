// sync.js 任务 G（同步附加歌词/封面元数据）新函数单测：
//   buildSongSyncItems  每首歌音频+封面两项 / path 缺失流媒体整首跳过 / url·path 格式
//   syncLyricsForSongs  调 apiGet → 成功写 nativeMetaSave(lyric:<hash>) / 失败静默 /
//                       无歌词跳过 / 小并发限流 / 总超时兜底 / 非 iOS 壳 no-op
//   displayNameOf       同步面板封面项名不露 covers/ 前缀（经 syncAssets 登记验证）
//
// mock 策略同 sync.test.js / syncAssets.test.js：
//   - nativeAudioBridge：vi.mock 整模块（onNativeEvent 捕获订阅者 / nativePost 记录消息）
//   - apiClient：vi.mock 整模块（apiGet + resolveServerUrl）
//   - 环境：window.qqplayerNative + iOS 桥（setNativeEnv）
import { describe, it, expect, beforeEach, vi } from "vitest";

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
