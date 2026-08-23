// 图书模式（App 集成）：顶栏第三个 tab「图书」→ 书架/阅读器主区 + ControlBar 保留
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
      if (url === "/api/songs" || url === "/api/books") {
        return { ok: true, json: async () => [] };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 图书模式", () => {
  it("顶栏有「图书」tab：点击切到 books 模式并渲染 BooksView 主区", async () => {
    const wrapper = mount(App);
    await flushPromises();

    // 第三个 tab
    const tabs = wrapper.findAll(".mode-tabs .tab");
    expect(tabs).toHaveLength(3);
    const booksTab = tabs.find((b) => b.text().includes("图书"));
    expect(booksTab).toBeTruthy();
    expect(booksTab.classes()).not.toContain("on");

    await booksTab.trigger("click");
    await flushPromises();

    expect(state.mode).toBe("books");
    expect(booksTab.classes()).toContain("on");
    expect(wrapper.find("main.books").exists()).toBe(true);
    expect(wrapper.find(".bookshelf").exists()).toBe(true);

    wrapper.unmount();
  });

  it("books 模式：ControlBar 保留（背景音乐可继续）；切回连播恢复原布局", async () => {
    const wrapper = mount(App);
    await flushPromises();

    await wrapper
      .findAll(".mode-tabs .tab")
      .find((b) => b.text().includes("图书"))
      .trigger("click");
    await flushPromises();
    expect(wrapper.find("main.books .controls").exists()).toBe(true);

    // 切回音乐
    await wrapper
      .findAll(".mode-tabs .tab")
      .find((b) => b.text().includes("音乐"))
      .trigger("click");
    await flushPromises();
    expect(state.mode).toBe("continuous");
    expect(wrapper.find("main.continuous").exists()).toBe(true);
    expect(wrapper.find("main.books").exists()).toBe(false);

    wrapper.unmount();
  });
});
