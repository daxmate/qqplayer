// 视频模式（App 集成）：顶栏第四个 tab「视频」→ 视频库主区 + ControlBar 保留
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { installMatchMedia } from "./helpers/matchMedia.js";

// matchMedia stub 必须在 import App 之前（useMobileViewport 模块加载时读取）
installMatchMedia(false); // 初始桌面布局

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
  // App onMounted 会 loadSongs/loadFavorites/loadPlaylists 等 → 全部 stub
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (url === "/api/songs" || url === "/api/books" || url === "/api/videos") {
        return { ok: true, json: async () => [] };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 视频模式", () => {
  it("顶栏有「视频」tab：四个 tab；点击切到 videos 模式并渲染 VideosView 主区", async () => {
    const wrapper = mount(App);
    await flushPromises();

    const tabs = wrapper.findAll(".mode-tabs .tab");
    expect(tabs).toHaveLength(3);
    const videosTab = tabs.find((b) => b.text().includes("视频"));
    expect(videosTab).toBeTruthy();
    expect(videosTab.classes()).not.toContain("on");

    await videosTab.trigger("click");
    await flushPromises();

    expect(state.mode).toBe("videos");
    expect(videosTab.classes()).toContain("on");
    expect(wrapper.find("main.videos").exists()).toBe(true);
    expect(wrapper.find(".video-library").exists()).toBe(true);

    wrapper.unmount();
  });

  it("videos 模式：ControlBar 保留；切回连播恢复原布局", async () => {
    const wrapper = mount(App);
    await flushPromises();

    await wrapper
      .findAll(".mode-tabs .tab")
      .find((b) => b.text().includes("视频"))
      .trigger("click");
    await flushPromises();
    expect(wrapper.find("main.videos .controls").exists()).toBe(true);

    // 切回音乐
    await wrapper
      .findAll(".mode-tabs .tab")
      .find((b) => b.text().includes("音乐"))
      .trigger("click");
    await flushPromises();
    expect(state.mode).toBe("continuous");
    expect(wrapper.find("main.continuous").exists()).toBe(true);
    expect(wrapper.find("main.videos").exists()).toBe(false);

    wrapper.unmount();
  });
});
