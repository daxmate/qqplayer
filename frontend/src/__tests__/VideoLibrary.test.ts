// VideoLibrary 视频库组件测试：列表渲染/空态/本地加载文件（不进库）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../videos/api", () => ({
  fetchVideos: vi.fn(),
}));

import { fetchVideos } from "../videos/api";
import VideoLibrary from "../videos/VideoLibrary.vue";
import { useToast, clearToasts } from "../composables/useToast.js";

const items = useToast().items as Array<{ type: string; text: string }>;

const makeVideo = (over = {}) => ({
  path: "/media/a.mp4",
  name: "lesson1.mp4",
  size: 157286400, // 150MB
  mtime: 1723800000000,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  (fetchVideos as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  // jsdom 有 createObjectURL 但返回空串；stub 成确定值便于断言
  URL.createObjectURL = vi.fn(() => "blob:mock-local");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  clearToasts();
});

describe("VideoLibrary", () => {
  it("渲染视频列表（文件名/大小/时间），点击 emit open", async () => {
    (fetchVideos as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeVideo(),
      makeVideo({
        path: "/media/b.webm",
        name: "song-practice.webm",
        size: 2048,
        mtime: 0,
      }),
    ]);

    const wrapper = mount(VideoLibrary);
    await flushPromises();

    const cards = wrapper.findAll(".vl-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].find(".vl-name").text()).toBe("lesson1.mp4");
    expect(cards[0].find(".vl-sub").text()).toContain("150.0 MB");
    expect(cards[0].find(".vl-sub").text()).toContain("2024-08-16");
    // mtime=0 不显示时间
    expect(cards[1].find(".vl-sub").text()).not.toContain("·");

    await cards[0].trigger("click");
    expect(wrapper.emitted("open")?.[0]?.[0]).toMatchObject({ path: "/media/a.mp4" });

    wrapper.unmount();
  });

  it("空态：无视频时显示引导文案与加载按钮", async () => {
    const wrapper = mount(VideoLibrary);
    await flushPromises();

    expect(wrapper.find(".vl-empty").exists()).toBe(true);
    expect(wrapper.find(".vl-empty .vl-load-btn").exists()).toBe(true);

    wrapper.unmount();
  });

  it("加载文件：选择本地视频 → object URL + emit open（不进库）", async () => {
    const wrapper = mount(VideoLibrary);
    await flushPromises();

    const input = wrapper.find(".vl-file-input");
    const file = new File(["x"], "clip.mp4", { type: "video/mp4" });
    Object.defineProperty(input.element, "files", { value: [file] });
    await input.trigger("change");

    const payload = wrapper.emitted("open")?.[0]?.[0] as { name: string; localUrl: string };
    expect(payload).toBeTruthy();
    expect(payload.name).toBe("clip.mp4");
    expect(payload.localUrl).toBe("blob:mock-local");
    expect((payload as { path?: string }).path).toBeUndefined(); // 不传后端
    expect(URL.createObjectURL).toHaveBeenCalledWith(file);
    expect(items.some((i) => i.text.includes("clip.mp4"))).toBe(true);

    wrapper.unmount();
  });

  it("加载文件：非视频文件 → 错误 toast，不 emit", async () => {
    const wrapper = mount(VideoLibrary);
    await flushPromises();

    const input = wrapper.find(".vl-file-input");
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "notes.txt", { type: "text/plain" })],
    });
    await input.trigger("change");

    expect(wrapper.emitted("open")).toBeUndefined();
    expect(items.some((i) => i.type === "error" && i.text === "请选择视频文件")).toBe(true);

    wrapper.unmount();
  });

  it("列表加载失败 → 错误 toast", async () => {
    (fetchVideos as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const wrapper = mount(VideoLibrary);
    await flushPromises();

    expect(items.some((i) => i.type === "error" && i.text === "视频库加载失败")).toBe(true);

    wrapper.unmount();
  });
});
