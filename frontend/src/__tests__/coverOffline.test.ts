// cover/lyric 缓存 key（stableHash 派生）+ useCoverURL 封面解析测试
//
// 说明：原 iOS 壳离线封面缓存（cachedCoverURL / cacheCover / getEmbeddedCover）与
// 歌词文件兜底（loadLyric 落文件）覆盖随壳 2026-09-13 退役一并移除；本文件保留
// 内容寻址 key 与封面解析（浏览器路径）的回归覆盖。
import { describe, it, expect, vi } from "vitest";

vi.mock("../utils/apiClient.js", () => ({
  apiGet: vi.fn(),
  isOffline: vi.fn(() => false),
  onOfflineChange: vi.fn(() => () => {}),
  resolveServerUrl: (p: string) =>
    /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
}));

import * as sync from "../utils/sync.js";
import { useCoverURL, COVER_CACHE_FIRST_N } from "../composables/useCoverURL.js";

const REMOTE = "http://192.168.1.50:17627/api/cover?path=" + encodeURIComponent("/Music/a.mp3");

describe("cover/lyric 缓存 key（stableHash 派生）", () => {
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
    expect(await sync.coverAssetKey(null as unknown as string)).toBeNull();
  });

  it("coverItemFor：url 指向 cover 端点 + 沙盒 path", async () => {
    const item = await sync.coverItemFor("/Music/a.mp3");
    expect(item).not.toBeNull();
    if (!item) throw new Error("coverItemFor 不应返回空（契约前提）");
    expect(item.url).toBe(REMOTE);
    expect(item.path).toMatch(/^covers\/[0-9a-f]+\.jpg$/);
    expect(item.sha256).toBe("");
    expect(item.size).toBe(0);
  });

  it("lyricKindKey：lyric:<hash> 稳定格式", async () => {
    const k1 = await sync.lyricKindKey("/Music/a.mp3");
    const k2 = await sync.lyricKindKey("/Music/a.mp3");
    expect(k1).toMatch(/^lyric:[0-9a-f]+$/);
    expect(k1).toBe(k2);
    expect(await sync.lyricKindKey(null as unknown as string)).toBeNull();
  });
});

describe("useCoverURL：封面解析 composable", () => {
  it("resolveCover 同步远程直出（行为零变化）", () => {
    const { coverSrc, resolveCover } = useCoverURL();
    resolveCover("/Music/a.mp3");
    expect(coverSrc("/Music/a.mp3")).toBe(REMOTE);
  });

  it("幂等：已解析后重复 resolveCover 不改结果", () => {
    const { coverSrc, resolveCover } = useCoverURL();
    resolveCover("/Music/a.mp3");
    resolveCover("/Music/a.mp3");
    expect(coverSrc("/Music/a.mp3")).toBe(REMOTE);
  });

  it("空 path：coverSrc 返回空串（不解析）", () => {
    const { coverSrc, resolveCover } = useCoverURL();
    resolveCover("");
    expect(coverSrc("")).toBe("");
  });

  it("markCoverError / coverOk：失败标记与展示门控", () => {
    const { coverOk, markCoverError } = useCoverURL();
    expect(coverOk("/Music/a.mp3")).toBe(true);
    markCoverError("/Music/a.mp3");
    expect(coverOk("/Music/a.mp3")).toBe(false);
  });

  it("COVER_CACHE_FIRST_N 常量存在（节流阈值）", () => {
    expect(COVER_CACHE_FIRST_N).toBeGreaterThan(0);
  });
});
