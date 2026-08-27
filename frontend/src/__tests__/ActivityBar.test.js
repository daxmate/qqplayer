// ActivityBar 按钮图标+文字（第二批 UI 操作升级）：音乐库 / 播放列表
// 验证竖排布局（图标在上、文字在下）、i18n 文案、点击切换面板、激活态 .on 与 title 切换
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ActivityBar from "../components/ActivityBar.vue";
import { uiState } from "../composables/usePlayer.js";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
  }
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

beforeEach(() => {
  Object.assign(uiState, {
    musicLibOpen: false,
    playlistOpen: false,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ActivityBar 按钮图标+文字", () => {
  it("两个按钮显示文字标签（音乐库/播放列表），图标保留", async () => {
    const wrapper = mount(ActivityBar);
    await flushPromises();

    const btns = wrapper.findAll(".ab-btn");
    expect(btns).toHaveLength(2);
    expect(btns[0].find(".ab-label").text()).toBe("音乐库");
    expect(btns[1].find(".ab-label").text()).toBe("播放列表");
    // 图标仍在（lucide svg）
    expect(btns[0].find("svg").exists()).toBe(true);
    expect(btns[1].find("svg").exists()).toBe(true);

    wrapper.unmount();
  });

  it("竖排布局：文字在图标之后（按钮内 flex 列方向）", async () => {
    const wrapper = mount(ActivityBar);
    await flushPromises();

    const btn = wrapper.find(".ab-btn");
    const icon = btn.find("svg");
    const label = btn.find(".ab-label");
    // icon 与 label 在 DOM 中相邻且 label 在后 → 图标在上文字在下
    expect(
      icon.element.compareDocumentPosition(label.element) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    wrapper.unmount();
  });

  it("点击音乐库按钮：切换 musicLibOpen + .on 激活态 + title 文案切换", async () => {
    const wrapper = mount(ActivityBar);
    await flushPromises();

    const libBtn = wrapper.findAll(".ab-btn")[0];
    expect(libBtn.classes()).not.toContain("on");
    expect(libBtn.attributes("title")).toBe("展开音乐库");

    await libBtn.trigger("click");
    await flushPromises();

    expect(uiState.musicLibOpen).toBe(true);
    expect(libBtn.classes()).toContain("on");
    expect(libBtn.attributes("title")).toBe("收起音乐库");

    await libBtn.trigger("click");
    await flushPromises();

    expect(uiState.musicLibOpen).toBe(false);
    expect(libBtn.classes()).not.toContain("on");
    expect(libBtn.attributes("title")).toBe("展开音乐库");

    wrapper.unmount();
  });

  it("点击播放列表按钮：切换 playlistOpen + .on 激活态 + title 文案切换", async () => {
    const wrapper = mount(ActivityBar);
    await flushPromises();

    const plBtn = wrapper.findAll(".ab-btn")[1];
    expect(plBtn.classes()).not.toContain("on");
    expect(plBtn.attributes("title")).toBe("展开播放列表");

    await plBtn.trigger("click");
    await flushPromises();

    expect(uiState.playlistOpen).toBe(true);
    expect(plBtn.classes()).toContain("on");
    expect(plBtn.attributes("title")).toBe("收起播放列表");

    wrapper.unmount();
  });
});
