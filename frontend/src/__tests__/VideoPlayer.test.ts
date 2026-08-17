// VideoPlayer 播放器测试：字幕渲染/时间匹配高亮/点击跳转/变速/跟读暂停/单句循环/AB 循环/双字幕
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// 只 mock 字幕接口；streamUrl / isLibraryVideo 用真实实现
vi.mock("../videos/api", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    fetchSubtitles: vi.fn(),
    fetchOnlineSubtitles: vi.fn(),
  };
});

import { fetchSubtitles, fetchOnlineSubtitles } from "../videos/api";
import VideoPlayer from "../videos/VideoPlayer.vue";
import { useToast, clearToasts } from "../composables/useToast.js";

const items = useToast().items as Array<{ type: string; text: string }>;

// 双字幕样例：第 0 句带翻译，其余单语种
const CUES = [
  { start: 0, end: 2, text: "Hello", translation: "你好" },
  { start: 2.5, end: 5, text: "World" },
  { start: 6, end: 9, text: "Again" },
];

const LIB_VIDEO = { path: "/media/a.mp4", name: "a.mp4", size: 1, mtime: 1 };

let playSpy: ReturnType<typeof vi.fn>;
let pauseSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  (fetchSubtitles as ReturnType<typeof vi.fn>).mockResolvedValue(CUES);
  (fetchOnlineSubtitles as ReturnType<typeof vi.fn>).mockResolvedValue(CUES);
  // jsdom 的 play()/pause() 是 noop 且 paused 只读 getter：
  // 用实例级 defineProperty 覆盖，让 paused 反映播放状态（play→false, pause→true）
  playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { value: false, writable: true, configurable: true });
    return Promise.resolve();
  });
  pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(function (
    this: HTMLMediaElement,
  ) {
    Object.defineProperty(this, "paused", { value: true, writable: true, configurable: true });
  });
});

afterEach(() => {
  clearToasts();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** 挂载播放器（库内视频），返回 wrapper + video 元素引用（组件内元素，非游离 Audio） */
async function mountPlayer(props = {}) {
  const wrapper = mount(VideoPlayer, {
    props: { video: LIB_VIDEO, ...props },
  });
  await flushPromises();
  return { wrapper, video: wrapper.find("video").element as HTMLVideoElement };
}

/** 把视频拨到 t 秒并触发 timeupdate（模拟播放推进） */
async function playTo(wrapper: ReturnType<typeof mount>, video: HTMLVideoElement, t: number) {
  video.currentTime = t;
  await wrapper.find("video").trigger("timeupdate");
}

describe("VideoPlayer 字幕渲染与时间匹配", () => {
  it("逐句渲染字幕；带 translation 显示双字幕，无则单语种", async () => {
    const { wrapper } = await mountPlayer();

    const lines = wrapper.findAll(".vline");
    expect(lines).toHaveLength(3);
    expect(lines[0].find(".vline-text").text()).toBe("Hello");
    expect(lines[0].find(".vline-trans").exists()).toBe(true);
    expect(lines[0].find(".vline-trans").text()).toBe("你好");
    expect(lines[1].find(".vline-trans").exists()).toBe(false);

    wrapper.unmount();
  });

  it("timeupdate 按时间匹配当前句并高亮；句间间隙保持上一句", async () => {
    const { wrapper, video } = await mountPlayer();

    await playTo(wrapper, video, 1);
    expect(wrapper.findAll(".vline")[0].classes()).toContain("active");

    await playTo(wrapper, video, 3);
    expect(wrapper.findAll(".vline")[1].classes()).toContain("active");

    // 句间间隙（2~2.5）：保持上一句高亮
    await playTo(wrapper, video, 2.3);
    expect(wrapper.findAll(".vline")[0].classes()).toContain("active");

    // 当前句浮层字幕：原文 + 翻译
    await playTo(wrapper, video, 1);
    expect(wrapper.find(".vp-overlay-text").text()).toBe("Hello");
    expect(wrapper.find(".vp-overlay-trans").text()).toBe("你好");

    wrapper.unmount();
  });

  it("点击字幕行跳转对应时间点并播放", async () => {
    const { wrapper, video } = await mountPlayer();

    await wrapper.findAll(".vline")[1].trigger("click");
    expect(video.currentTime).toBe(2.5);
    expect(playSpy).toHaveBeenCalled();

    wrapper.unmount();
  });
});

describe("VideoPlayer 跟唱交互", () => {
  it("变速：1.0 → 1.25 → 0.75 循环（与 karaoke 同序），写入 video.playbackRate", async () => {
    const { wrapper, video } = await mountPlayer();

    const speedBtn = wrapper.findAll(".vc-btn").find((b) => b.text().includes("x"))!;
    await speedBtn.trigger("click");
    expect(video.playbackRate).toBe(1.25);
    expect(speedBtn.text()).toContain("1.25x");
    await speedBtn.trigger("click");
    expect(video.playbackRate).toBe(0.75);
    await speedBtn.trigger("click");
    expect(video.playbackRate).toBe(1.0);

    wrapper.unmount();
  });

  it("跟读暂停：句末回句首暂停；关闭跟读后自然流过", async () => {
    const { wrapper, video } = await mountPlayer();

    // 跟读开（默认）：第 0 句播完（t=2）→ 跳回句首 0 并暂停
    await playTo(wrapper, video, 2);
    expect(video.currentTime).toBe(0);
    expect(pauseSpy).toHaveBeenCalled();

    // 关闭跟读（点 Mic 按钮）→ 不再停
    pauseSpy.mockClear();
    await wrapper
      .findAll(".vc-btn")
      .find((b) => b.text().includes("跟读"))!
      .trigger("click");
    await playTo(wrapper, video, 2);
    expect(video.currentTime).toBe(2);
    expect(pauseSpy).not.toHaveBeenCalled();

    wrapper.unmount();
  });

  it("单句循环：句末回句首续播（不暂停）", async () => {
    const { wrapper, video } = await mountPlayer();

    // 单击循环按钮开启单句循环（按钮文案「单句循环」）
    await wrapper
      .findAll(".vc-btn")
      .find((b) => b.text().includes("单句循环"))!
      .trigger("click");

    await playTo(wrapper, video, 2);
    expect(video.currentTime).toBe(0);
    expect(pauseSpy).not.toHaveBeenCalled(); // 续播不暂停

    wrapper.unmount();
  });

  it("AB 循环：长按进入（当前句为 A）→ 点字幕选 B → 区间内 B 播完跳回 A", async () => {
    const { wrapper, video } = await mountPlayer();

    // 先到第 0 句（A 起点）
    await playTo(wrapper, video, 1);

    // 长按循环按钮 500ms → 进入 AB（等选终点）；fake timers 只在挂载/拉字幕之后启用
    vi.useFakeTimers();
    const loopBtn = wrapper.findAll(".vc-btn").find((b) => b.text().includes("单句循环"))!;
    await loopBtn.trigger("pointerdown");
    await vi.advanceTimersByTimeAsync(500);
    await loopBtn.trigger("pointerup");
    await loopBtn.trigger("click"); // 长按手势收尾的 click 被吞（longPressFired 复位）
    expect(loopBtn.text()).toContain("AB");
    expect(loopBtn.attributes("title")).toContain("请点击字幕选终点");

    // 点击第 2 句（index 1）作为 B → 区间 {0,1}；端点徽标 A/B
    await wrapper.findAll(".vline")[1].trigger("click");
    expect(wrapper.findAll(".vline")[0].find(".vline-badge").text()).toBe("A");
    expect(wrapper.findAll(".vline")[1].find(".vline-badge").text()).toBe("B");

    // B 播完（t=5）→ 跳回 A（t=0）续播不暂停
    await playTo(wrapper, video, 5);
    expect(video.currentTime).toBe(0);
    expect(pauseSpy).not.toHaveBeenCalled();

    // 单击退出 AB
    await loopBtn.trigger("click");
    expect(loopBtn.text()).toContain("单句循环");

    wrapper.unmount();
    vi.useRealTimers();
  });

  it("AB 区间内点击跳转播放；区间外点击退出 AB 并播放；等选终点时点击设为终点", async () => {
    const { wrapper, video } = await mountPlayer();
    const longPress = async () => {
      const btn = wrapper.findAll(".vc-btn").find((b) => b.text().includes("单句循环"))!;
      await btn.trigger("pointerdown");
      await new Promise((r) => setTimeout(r, 510));
      await btn.trigger("pointerup");
      await btn.trigger("click"); // 长按手势收尾的 click 被吞（longPressFired 复位）
      return btn;
    };

    // 第 0 句为 A，点第 3 句（index 2）为 B → 区间 {0,2}
    await playTo(wrapper, video, 1);
    let loopBtn = await longPress();
    await wrapper.findAll(".vline")[2].trigger("click");

    // 区间内点击（index 1）→ 跳转播放，区间保持
    await wrapper.findAll(".vline")[1].trigger("click");
    expect(video.currentTime).toBe(2.5);
    expect(loopBtn.text()).toContain("AB");

    // 单击退出 AB
    await loopBtn.trigger("click");
    expect(loopBtn.text()).toContain("单句循环");

    // 再建区间 {0,1}（A=0，B=index 1）→ 点 index 2（区间外）→ 退出 AB + 播放该句
    await playTo(wrapper, video, 1); // 回到第 0 句作为新 A
    loopBtn = await longPress();
    await wrapper.findAll(".vline")[1].trigger("click"); // 等选终点：点击设为 B
    await wrapper.findAll(".vline")[2].trigger("click"); // 区间外：退出 AB + 播放
    expect(loopBtn.text()).toContain("单句循环"); // 已退出 AB
    expect(video.currentTime).toBe(6);

    wrapper.unmount();
  });

  it("上一句 / 下一句按钮按锚点句跳转", async () => {
    const { wrapper, video } = await mountPlayer();

    await playTo(wrapper, video, 3); // 当前第 1 句
    const btns = wrapper.findAll(".vc-btn");
    // 顺序：上一句 / 播放 / 下一句 / 变速 / 跟读 / 循环
    await btns[2].trigger("click"); // 下一句
    expect(video.currentTime).toBe(6);
    await btns[0].trigger("click"); // 上一句
    expect(video.currentTime).toBe(2.5);

    wrapper.unmount();
  });
});

describe("VideoPlayer 无字幕 / 本地加载", () => {
  it("字幕为空：显示空态提示，循环按钮禁用", async () => {
    (fetchSubtitles as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const { wrapper } = await mountPlayer();

    expect(wrapper.find(".vp-sub-empty").exists()).toBe(true);
    const loopBtn = wrapper.findAll(".vc-btn").find((b) => b.text().includes("单句循环"))!;
    expect((loopBtn.element as HTMLButtonElement).disabled).toBe(true);

    wrapper.unmount();
  });

  it("字幕加载失败 → 错误 toast，不阻塞播放", async () => {
    (fetchSubtitles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const { wrapper } = await mountPlayer();

    expect(items.some((i) => i.type === "error" && i.text === "字幕加载失败")).toBe(true);
    // 空态字幕区仍在（纯播放可用）
    expect(wrapper.find(".vp-sub-empty").exists()).toBe(true);

    wrapper.unmount();
  });

  it("本地加载（localUrl）：直接播放 object URL，不拉字幕", async () => {
    const { wrapper, video } = await mountPlayer({
      video: { name: "clip.mp4", localUrl: "blob:mock-local" },
    });

    expect(fetchSubtitles).not.toHaveBeenCalled();
    expect(video.getAttribute("src")).toBe("blob:mock-local");
    expect(wrapper.find(".vp-sub-empty").exists()).toBe(true);

    wrapper.unmount();
  });
});

describe("VideoPlayer 在线视频源", () => {
  const ONLINE = {
    title: "B站示例视频",
    url: "https://www.bilibili.com/video/BV1xx411c7mD",
    provider: "bilibili",
    duration: 125,
    subtitles: [{ lang: "zh-Hans", name: "中文（自动生成）" }],
  };

  it("在线视频：src 走 /api/video-online/stream 代理；字幕拉 resolve 返回的第一个 lang", async () => {
    const wrapper = mount(VideoPlayer, { props: { video: ONLINE } });
    await flushPromises();

    const videoEl = wrapper.find("video").element as HTMLVideoElement;
    expect(videoEl.getAttribute("src")).toBe(
      `/api/video-online/stream?url=${encodeURIComponent(ONLINE.url)}`,
    );
    expect(fetchOnlineSubtitles).toHaveBeenCalledWith(ONLINE.url, "zh-Hans");
    expect(fetchSubtitles).not.toHaveBeenCalled();
    // 标题用 title，provider 徽标展示
    expect(wrapper.find(".vp-title").text()).toBe("B站示例视频");
    expect(wrapper.find(".vp-provider").text()).toBe("bilibili");
    // 字幕渲染 + 双字幕布局（翻译有值在上原文下）不受在线源影响
    expect(wrapper.findAll(".vline")).toHaveLength(3);
    expect(wrapper.find(".vline-text").text()).toBe("Hello");

    wrapper.unmount();
  });

  it("在线视频无字幕信息：不请求字幕接口，纯播放", async () => {
    const wrapper = mount(VideoPlayer, {
      props: { video: { ...ONLINE, subtitles: [] } },
    });
    await flushPromises();

    expect(fetchOnlineSubtitles).not.toHaveBeenCalled();
    expect(wrapper.find(".vp-sub-empty").exists()).toBe(true);

    wrapper.unmount();
  });

  it("在线视频字幕加载失败 → 错误 toast，不阻塞播放", async () => {
    (fetchOnlineSubtitles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"));
    const wrapper = mount(VideoPlayer, { props: { video: ONLINE } });
    await flushPromises();

    expect(items.some((i) => i.type === "error" && i.text === "字幕加载失败")).toBe(true);
    expect(wrapper.find(".vp-sub-empty").exists()).toBe(true);

    wrapper.unmount();
  });
});
