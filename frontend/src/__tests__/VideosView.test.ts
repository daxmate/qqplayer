// VideosView 容器测试：视频库 ↔ 播放器切换（仿 BooksView 测试）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../videos/api", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchVideos: vi.fn(), fetchSubtitles: vi.fn() };
});

import { fetchVideos, fetchSubtitles } from "../videos/api";
import VideosView from "../videos/VideosView.vue";
import { clearToasts } from "../composables/useToast.js";

const video = { path: "/media/a.mp4", name: "lesson1.mp4", size: 100, mtime: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  (fetchVideos as ReturnType<typeof vi.fn>).mockResolvedValue([video]);
  (fetchSubtitles as ReturnType<typeof vi.fn>).mockResolvedValue([
    { start: 0, end: 2, text: "Hi", translation: "你好" },
  ]);
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
