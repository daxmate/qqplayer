// SettingsModal 组件测试：播放分类「频谱可视化」小节
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const SettingsModal = (await import("../components/SettingsModal.vue")).default;
const { playbackSettings } = await import("../composables/usePlayer.js");

beforeEach(() => {
  playbackSettings.visualizerEnabled = true;
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsModal 播放分类 - 频谱可视化", () => {
  it("播放分类存在「频谱可视化」开关小节", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    // Teleport 到 body
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    expect(root.textContent).toContain("频谱可视化");
    // 默认打开
    const row = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("频谱可视化"),
    );
    expect(row).toBeTruthy();
    expect(row.querySelector(".switch.on")).toBeTruthy();
    w.unmount();
  });

  it("点击开关切换 playbackSettings.visualizerEnabled", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const row = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("频谱可视化"),
    );
    row.click();
    await nextTick();
    expect(playbackSettings.visualizerEnabled).toBe(false);
    expect(row.querySelector(".switch.on")).toBeFalsy();
    row.click();
    await nextTick();
    expect(playbackSettings.visualizerEnabled).toBe(true);
    w.unmount();
  });
});
