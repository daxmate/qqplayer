// videos api 在线源封装测试：resolveOnline 页面链接语义 / 错误 detail 提取 / onlineStreamUrl t 参数
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveOnline, onlineStreamUrl } from "../videos/api";

const PAGE_URL = "https://www.bilibili.com/video/BV1GJ411x7h7";
const STREAM_BASE = `/api/video-online/stream?url=${encodeURIComponent(PAGE_URL)}`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveOnline", () => {
  it("解析成功：url 字段用入参页面链接覆盖直链（stream/subtitles 需要页面链接）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          title: "示例",
          url: "https://xy1.mcdn.bilivideo.cn/direct-signed.m4s?deadline=1",
          provider: "bilibili",
          duration: 212.4,
          subtitles: [{ lang: "zh-Hans", name: "中文" }],
        }),
      })),
    );
    const r = await resolveOnline(PAGE_URL);
    expect(fetch).toHaveBeenCalledWith(
      "/api/video-online/resolve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ url: PAGE_URL }),
      }),
    );
    expect(r.url).toBe(PAGE_URL); // 直链被页面链接替换
    expect(r.title).toBe("示例");
    expect(r.provider).toBe("bilibili");
  });

  it("解析失败：抛后端 detail（400 带原因）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({ detail: "解析失败: 视频不存在" }),
      })),
    );
    await expect(resolveOnline(PAGE_URL)).rejects.toThrow("解析失败: 视频不存在");
  });
});

describe("onlineStreamUrl", () => {
  it("不带 t：纯代理地址（无 t 参数）", () => {
    expect(onlineStreamUrl(PAGE_URL)).toBe(STREAM_BASE);
    expect(onlineStreamUrl(PAGE_URL, undefined)).toBe(STREAM_BASE);
  });

  it("带 t：追加 &t=<向下取整秒>", () => {
    expect(onlineStreamUrl(PAGE_URL, 12.7)).toBe(`${STREAM_BASE}&t=12`);
    expect(onlineStreamUrl(PAGE_URL, 0)).toBe(`${STREAM_BASE}&t=0`);
  });

  it("t 为 null / NaN：忽略不追加", () => {
    expect(onlineStreamUrl(PAGE_URL, null as unknown as number)).toBe(STREAM_BASE);
    expect(onlineStreamUrl(PAGE_URL, Number.NaN)).toBe(STREAM_BASE);
  });
});
