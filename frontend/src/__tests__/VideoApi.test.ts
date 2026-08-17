// videos api 在线源封装测试：resolveOnline 页面链接语义 / 错误 detail 提取
import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveOnline } from "../videos/api";

const PAGE_URL = "https://www.bilibili.com/video/BV1GJ411x7h7";

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
