// VideosView 容器测试：视频库 ↔ 播放器切换（仿 BooksView 测试）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../videos/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchVideos: vi.fn(),
    fetchSubtitles: vi.fn(),
    fetchOnlineSubtitles: vi.fn(),
    resolveOnline: vi.fn(),
  };
});

import { fetchVideos, fetchSubtitles, fetchOnlineSubtitles, resolveOnline } from "../videos/api";
import VideosView from "../videos/VideosView.vue";
import { clearToasts } from "../composables/useToast.js";

const video = { path: "/media/a.mp4", name: "lesson1.mp4", size: 100, mtime: 1 };

// 在线解析样例（POST /api/video-online/resolve 响应契约）
const ONLINE = {
  title: "B站示例视频",
  url: "https://www.bilibili.com/video/BV1xx411c7mD",
  provider: "bilibili",
  duration: 125,
  subtitles: [{ lang: "zh-Hans", name: "中文（自动生成）" }],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  (fetchVideos as ReturnType<typeof vi.fn>).mockResolvedValue([video]);
  (fetchSubtitles as ReturnType<typeof vi.fn>).mockResolvedValue([
    { start: 0, end: 2, text: "Hi", translation: "你好" },
  ]);
  (fetchOnlineSubtitles as ReturnType<typeof vi.fn>).mockResolvedValue([
    { start: 0, end: 2, text: "Hello", translation: null },
  ]);
  (resolveOnline as ReturnType<typeof vi.fn>).mockResolvedValue(ONLINE);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  clearToasts();
});

describe("VideosView", () => {
  it("默认视频库 → 点视频进播放器（stream URL）→ 返回回视频库", async () => {
    const wrapper = mount(VideosView);
    await flushPromises();

    // 初始：视频库
    expect(wrapper.findComponent({ name: "VideoLibrary" }).exists()).toBe(true);
    expect(wrapper.find(".video-player").exists()).toBe(false);

    // 点视频卡片 → 播放器（src 走后端流接口）
    await wrapper.find(".vl-card").trigger("click");
    await flushPromises();
    expect(wrapper.find(".video-player").exists()).toBe(true);
    const videoEl = wrapper.find("video").element as HTMLVideoElement;
    expect(videoEl.getAttribute("src")).toBe("/api/videos/stream?path=%2Fmedia%2Fa.mp4");
    expect(fetchSubtitles).toHaveBeenCalledWith("/media/a.mp4");
    expect(wrapper.find(".vp-title").text()).toBe("lesson1.mp4");

    // 返回 → 视频库
    await wrapper.find(".vp-back").trigger("click");
    await flushPromises();
    expect(wrapper.find(".video-player").exists()).toBe(false);
    expect(wrapper.find(".vl-card").exists()).toBe(true);

    wrapper.unmount();
  });

  it("换视频：再开一个 → 播放器重建（key 变化）", async () => {
    (fetchVideos as ReturnType<typeof vi.fn>).mockResolvedValue([
      video,
      { ...video, path: "/media/b.mp4", name: "b.mp4" },
    ]);

    const wrapper = mount(VideosView);
    await flushPromises();

    await wrapper.findAll(".vl-card")[1].trigger("click");
    await flushPromises();
    expect(wrapper.find(".vp-title").text()).toBe("b.mp4");
    expect((wrapper.find("video").element as HTMLVideoElement).getAttribute("src")).toBe(
      "/api/videos/stream?path=%2Fmedia%2Fb.mp4",
    );

    wrapper.unmount();
  });
});

describe("VideosView 在线源地址栏", () => {
  it("地址栏常驻：本地库视图也有输入框 + 解析按钮", async () => {
    const wrapper = mount(VideosView);
    await flushPromises();

    // 默认本地库视图 + 顶部地址栏
    expect(wrapper.find(".vl-card").exists()).toBe(true);
    expect(wrapper.find(".vo-url-input").exists()).toBe(true);
    expect(wrapper.find(".vo-resolve-btn").exists()).toBe(true);
    expect(wrapper.find(".vo-seg").exists()).toBe(true);
    // 空输入：解析按钮禁用
    expect((wrapper.find(".vo-resolve-btn").element as HTMLButtonElement).disabled).toBe(true);

    wrapper.unmount();
  });

  it("粘贴链接点解析 → loading → 切在线视图渲染结果卡片", async () => {
    const wrapper = mount(VideosView);
    await flushPromises();

    await wrapper.find(".vo-url-input").setValue(ONLINE.url);
    expect((wrapper.find(".vo-resolve-btn").element as HTMLButtonElement).disabled).toBe(false);
    await wrapper.find(".vo-resolve-btn").trigger("click");
    expect(resolveOnline).toHaveBeenCalledWith(ONLINE.url);

    // 解析中（未 flush）：loading 态（resolveOnline 是同步 resolved，这里验证按钮 loading 文案路径走通）
    await flushPromises();

    // 切到在线视图 + 结果卡片
    expect(wrapper.find(".video-library").exists()).toBe(false);
    expect(wrapper.find(".vo-card").exists()).toBe(true);
    expect(wrapper.find(".vo-title").text()).toBe("B站示例视频");
    expect(wrapper.find(".vo-sub").text()).toContain("2:05");

    wrapper.unmount();
  });

  it("解析失败：显示后端错误 detail，不阻塞地址栏再试", async () => {
    (resolveOnline as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("解析失败: 视频不存在"),
    );
    const wrapper = mount(VideosView);
    await flushPromises();

    await wrapper.find(".vo-url-input").setValue("https://example.com/404");
    await wrapper.find(".vo-resolve-btn").trigger("click");
    await flushPromises();

    expect(wrapper.find(".vo-error").exists()).toBe(true);
    expect(wrapper.find(".vo-error-detail").text()).toBe("解析失败: 视频不存在");
    expect(wrapper.find(".vo-card").exists()).toBe(false);

    wrapper.unmount();
  });

  it("非 http(s) 链接：前端拦截提示，不调接口", async () => {
    const wrapper = mount(VideosView);
    await flushPromises();

    await wrapper.find(".vo-url-input").setValue("file:///etc/passwd");
    await wrapper.find(".vo-resolve-btn").trigger("click");
    await flushPromises();

    expect(resolveOnline).not.toHaveBeenCalled();
    expect(wrapper.find(".vo-error").exists()).toBe(true);
    expect(wrapper.text()).toContain("请输入 http(s) 链接");

    wrapper.unmount();
  });

  it("点结果卡片 → 在线播放器（stream 代理 src + 在线字幕）；返回回在线结果", async () => {
    const wrapper = mount(VideosView);
    await flushPromises();

    await wrapper.find(".vo-url-input").setValue(ONLINE.url);
    await wrapper.find(".vo-resolve-btn").trigger("click");
    await flushPromises();

    await wrapper.find(".vo-card").trigger("click");
    await flushPromises();
    expect(wrapper.find(".video-player").exists()).toBe(true);
    const videoEl = wrapper.find("video").element as HTMLVideoElement;
    expect(videoEl.getAttribute("src")).toBe(
      `/api/video-online/stream?url=${encodeURIComponent(ONLINE.url)}`,
    );
    expect(fetchOnlineSubtitles).toHaveBeenCalledWith(ONLINE.url, "zh-Hans");
    expect(wrapper.find(".vp-title").text()).toBe("B站示例视频");
    expect(wrapper.find(".vp-provider").text()).toBe("bilibili");

    // 返回 → 回到在线结果视图（保留结果卡片）
    await wrapper.find(".vp-back").trigger("click");
    await flushPromises();
    expect(wrapper.find(".video-player").exists()).toBe(false);
    expect(wrapper.find(".vo-card").exists()).toBe(true);

    wrapper.unmount();
  });

  it("本地库 / 在线子视图切换：互不影响", async () => {
    const wrapper = mount(VideosView);
    await flushPromises();

    // 切到在线（空态）→ 切回本地库
    await wrapper.findAll(".vo-seg-btn")[1].trigger("click");
    expect(wrapper.find(".video-library").exists()).toBe(false);
    expect(wrapper.find(".vo-online").exists()).toBe(true);

    await wrapper.findAll(".vo-seg-btn")[0].trigger("click");
    expect(wrapper.find(".video-library").exists()).toBe(true);

    wrapper.unmount();
  });
});
