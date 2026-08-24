// SettingsModal「配对」分类测试：桌面壳显示配对 Tab 并可进入管理页；iOS 壳（qqplayerIosBridge）隐藏
// 独立文件：Audio stub 必须在 import SettingsModal（连带 usePlayer）之前注册
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
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

beforeEach(() => {
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
  delete window.qqplayerIosBridge;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.qqplayerIosBridge;
  document.body.innerHTML = "";
});

const navItems = () => [...document.body.querySelectorAll(".nav-item")];

describe("SettingsModal 配对分类", () => {
  it("桌面壳（无 iOS 桥）：导航含「配对」，点击进入配对管理页", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await flushPromises();
    const nav = navItems();
    expect(nav.some((n) => n.textContent.includes("配对"))).toBe(true);
    nav.find((n) => n.textContent.includes("配对")).click();
    await nextTick();
    await flushPromises();
    // PairingSettings 已渲染（组件根节点进入 DOM）
    expect(document.body.querySelector(".pairing-settings")).toBeTruthy();
    w.unmount();
  });

  it("iOS 壳（存在 qqplayerIosBridge）：导航不含「配对」", async () => {
    window.qqplayerIosBridge = {};
    const w = mount(SettingsModal, { props: { open: true } });
    await flushPromises();
    expect(navItems().some((n) => n.textContent.includes("配对"))).toBe(false);
    w.unmount();
  });

  it("无 iOS 桥时导航包含完整分类（含配对，共 10 项）", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await flushPromises();
    expect(navItems().length).toBe(10);
    w.unmount();
  });
});
