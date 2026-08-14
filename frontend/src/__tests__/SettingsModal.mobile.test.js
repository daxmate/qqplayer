// SettingsModal 移动分支测试：<1024px 时显示返回按钮（桌面无）
// 独立文件：matchMedia stub 必须在 import SettingsModal 之前（模块加载时 isMobile 求值）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";
import { installMatchMedia } from "./helpers/matchMedia.js";

const mq = installMatchMedia(true); // 初始移动布局

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
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const SettingsModal = (await import("../components/SettingsModal.vue")).default;

beforeEach(() => {
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsModal 移动布局返回按钮（isMobile 分支）", () => {
  it("移动布局（<1024px）：显示返回按钮，点击发出 close 事件", async () => {
    mq.set(true);
    const wrapper = mount(SettingsModal, { props: { open: true } });
    await flushPromises();
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    const back = root.querySelector(".modal-back");
    expect(back).toBeTruthy();
    back.click();
    await nextTick();
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });

  it("桌面布局（≥1024px）：不显示返回按钮（仍有右上角关闭）", async () => {
    mq.set(false);
    const wrapper = mount(SettingsModal, { props: { open: true } });
    await flushPromises();
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    expect(root.querySelector(".modal-back")).toBeNull();
    expect(root.querySelector(".modal-close")).toBeTruthy();
    wrapper.unmount();
  });

  it("窗口从移动放大到桌面：返回按钮实时消失", async () => {
    mq.set(true);
    const wrapper = mount(SettingsModal, { props: { open: true } });
    await flushPromises();
    expect(document.body.querySelector(".modal-back")).toBeTruthy();
    mq.set(false); // 触发 matchMedia change → isMobile 变 false
    await nextTick();
    expect(document.body.querySelector(".modal-back")).toBeNull();
    wrapper.unmount();
  });
});
