// App 布局切换测试：<1024px 渲染 MobileShell（页面栈），≥1024px 渲染桌面三栏
// 通过 matchMedia change 事件驱动 isMobile 响应式切换，验证两种布局互斥渲染
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { installMatchMedia } from "./helpers/matchMedia.js";

// matchMedia stub 必须在 import App 之前（useMobileViewport 模块加载时读取）
const mq = installMatchMedia(false); // 初始桌面布局

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

const App = (await import("../App.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { uiSettings } = await import("../composables/useSettings.js");
const { toggleSleepTimer, _resetSleepTimer } = await import("../composables/useSleepTimer.js");

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
  });
  // App onMounted 会 loadSongs/loadFavorites/loadPlaylists/歌词等 → 全部 stub
  // 注意 loadSongs 不检查 res.ok 直接 state.songs = await res.json()，必须返回数组
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 布局切换（isMobile 响应式）", () => {
  it("桌面（≥1024px）：渲染三栏布局，不渲染移动壳", async () => {
    mq.set(false);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".topbar").exists()).toBe(true); // 桌面顶栏
    expect(wrapper.find(".mobile-shell").exists()).toBe(false);
    wrapper.unmount();
  });

  it("移动（<1024px）：渲染页面栈壳，不渲染桌面顶栏", async () => {
    mq.set(true);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".mobile-shell").exists()).toBe(true);
    expect(wrapper.find(".mh-page").exists()).toBe(true); // 移动首页
    expect(wrapper.find(".topbar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("窗口从桌面缩到移动（1024 → 1023）：布局实时切换", async () => {
    mq.set(false);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".topbar").exists()).toBe(true);
    // 触发 matchMedia change → isMobile 变 true → 切到移动布局
    mq.set(true);
    await flushPromises();
    expect(wrapper.find(".mobile-shell").exists()).toBe(true);
    expect(wrapper.find(".topbar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("窗口从移动放大到桌面（1023 → 1024）：布局实时切回", async () => {
    mq.set(true);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".mobile-shell").exists()).toBe(true);
    mq.set(false);
    await flushPromises();
    expect(wrapper.find(".topbar").exists()).toBe(true);
    expect(wrapper.find(".mobile-shell").exists()).toBe(false);
    wrapper.unmount();
  });

  it("移动布局下音乐页设置齿轮 → 进入负一屏设置区（不再弹桌面设置弹窗）", async () => {
    mq.set(true);
    const wrapper = mount(App);
    await flushPromises();
    await wrapper.find('.mh-icon-btn[title="设置"]').trigger("click");
    await flushPromises();
    // MobileShell 内部进入负一屏设置区（同步面板），不再 Teleport 桌面弹窗
    expect(wrapper.find(".ms-page").exists()).toBe(true);
    expect(wrapper.find(".msc-page").exists()).toBe(true);
    expect(document.body.querySelector(".modal")).toBeFalsy();
    wrapper.unmount();
  });
});

describe("ControlBar 睡眠定时器 isMobile 分支", () => {
  beforeEach(() => {
    _resetSleepTimer();
    toggleSleepTimer(); // 激活倒计时
  });

  it("桌面布局：ControlBar 显示睡眠倒计时小字", async () => {
    mq.set(false);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".controls .sleep-timer").exists()).toBe(true);
    expect(wrapper.find(".controls .sleep-timer").text()).toContain("睡眠定时器");
    wrapper.unmount();
  });

  it("移动布局：ControlBar 隐藏倒计时（MobilePlayer 单独显示，避免重复）", async () => {
    mq.set(true);
    const wrapper = mount(App);
    await flushPromises();
    // 打开播放器 → MobilePlayer 内有自己的倒计时
    await wrapper.find(".mini-player").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mobile-player").exists()).toBe(true);
    expect(wrapper.find(".mp-sleep-timer").exists()).toBe(true); // MobilePlayer 自己的
    expect(wrapper.find(".controls .sleep-timer").exists()).toBe(false); // ControlBar 隐藏
    wrapper.unmount();
  });
});

describe("H3 coverBlur 背景层移动端守卫（bg-blur 仅桌面渲染）", () => {
  beforeEach(() => {
    uiSettings.coverBlur = true;
    state.currentSong = { path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉" };
  });
  afterEach(() => {
    uiSettings.coverBlur = false;
    state.currentSong = null;
  });

  it("桌面：coverBlur 开启时渲染 .bg-blur 背景层", async () => {
    mq.set(false);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".bg-blur").exists()).toBe(true);
    wrapper.unmount();
  });

  it("移动：即使 coverBlur 开启也不渲染 .bg-blur（移动端由 mp-glass 毛玻璃承担，避免双重模糊）", async () => {
    mq.set(true);
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".bg-blur").exists()).toBe(false);
    wrapper.unmount();
  });
});
