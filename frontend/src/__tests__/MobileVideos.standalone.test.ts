// MobileVideos 分页屏 back 适配测试（standalone prop，同 MobileBooks）
// 覆盖：standalone=false（分页屏）列表态隐藏返回按钮；播放器打开时返回按钮出现、点击关闭播放器
//       （不 emit back，浮层状态上报 overlay）；standalone=true（独立页）保持原行为 emit back
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

class FakeAudio {
  src = "";
  paused = true;
  play() {
    return Promise.resolve();
  }
  pause() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

vi.mock("../videos/VideoLibrary.vue", () => ({
  default: {
    name: "VideoLibraryStub",
    emits: ["open"],
    template: `<button class="vl-stub" @click="$emit('open', { path: '/v/1.mp4', name: '测试视频' })">library</button>`,
  },
}));
vi.mock("../videos/VideoPlayer.vue", () => ({
  default: {
    name: "VideoPlayerStub",
    props: ["video"],
    emits: ["close"],
    template: `<div class="vp-stub"><button class="vp-close" @click="$emit('close')">close</button></div>`,
  },
}));

const MobileVideos = (await import("../videos/MobileVideos.vue")).default;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobileVideos 分页屏模式（standalone=false）", () => {
  it("列表态：无返回按钮，不 emit back", async () => {
    const wrapper = mount(MobileVideos, { props: { standalone: false } });
    expect(wrapper.find(".mv-back").exists()).toBe(false);
    expect(wrapper.emitted("back")).toBeFalsy();
    expect(wrapper.emitted("overlay")).toBeFalsy();
  });

  it("打开播放器 → 返回按钮出现 + overlay 上报；点返回关闭播放器（不 emit back）", async () => {
    const wrapper = mount(MobileVideos, { props: { standalone: false } });
    await wrapper.find(".vl-stub").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mv-player-overlay").exists()).toBe(true);
    expect(wrapper.find(".mv-back").exists()).toBe(true);
    expect(wrapper.emitted("overlay")!.at(-1)).toEqual([true]);
    await wrapper.find(".mv-back").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mv-player-overlay").exists()).toBe(false);
    expect(wrapper.find(".mv-back").exists()).toBe(false);
    expect(wrapper.emitted("back")).toBeFalsy();
    expect(wrapper.emitted("overlay")!.at(-1)).toEqual([false]);
  });
});

describe("MobileVideos 独立页模式（standalone=true，原行为）", () => {
  it("列表态显示返回按钮，点击 emit back", async () => {
    const wrapper = mount(MobileVideos);
    expect(wrapper.find(".mv-back").exists()).toBe(true);
    await wrapper.find(".mv-back").trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy();
  });

  it("播放器打开时点返回：先关播放器，再点才 emit back", async () => {
    const wrapper = mount(MobileVideos);
    await wrapper.find(".vl-stub").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mv-player-overlay").exists()).toBe(true);
    await wrapper.find(".mv-back").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mv-player-overlay").exists()).toBe(false);
    expect(wrapper.emitted("back")).toBeFalsy();
    await wrapper.find(".mv-back").trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy();
  });
});
