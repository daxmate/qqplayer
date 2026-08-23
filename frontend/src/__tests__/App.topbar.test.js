// 顶栏按钮图标+文字（第二批 UI 操作升级）：迷你模式 / 桌面歌词 / 设置
// 验证三个按钮均显示 i18n 文字标签，title/tooltip 行为不变，激活态类名保留
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
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 顶栏按钮图标+文字", () => {
  it("三个顶栏按钮均显示文字标签（迷你模式/桌面歌词/设置）", async () => {
    const wrapper = mount(App);
    await flushPromises();

    const miniBtn = wrapper.find(".mini-btn");
    const lyricBtn = wrapper.find(".lyric-float-btn");
    const settingsBtns = wrapper.findAll(".gear-btn");

    expect(miniBtn.find(".gear-label").text()).toBe("迷你模式");
    expect(lyricBtn.find(".gear-label").text()).toBe("桌面歌词");
    // 设置按钮是第三个 gear-btn（前两个是迷你模式/桌面歌词）
    const settingsBtn = settingsBtns.find(
      (b) => b.find(".gear-label").exists() && b.find(".gear-label").text() === "设置",
    );
    expect(settingsBtn).toBeTruthy();

    wrapper.unmount();
  });

  it("图标与文字并排：每个按钮同时包含 lucide 图标 svg 和文字 span", async () => {
    const wrapper = mount(App);
    await flushPromises();

    for (const cls of [".mini-btn", ".lyric-float-btn"]) {
      const btn = wrapper.find(cls);
      expect(btn.find("svg").exists()).toBe(true); // 图标仍在
      expect(btn.find(".gear-label").exists()).toBe(true); // 文字已加
    }
    const settingsBtn = wrapper
      .findAll(".gear-btn")
      .find((b) => b.find(".gear-label").exists() && b.find(".gear-label").text() === "设置");
    expect(settingsBtn.find("svg").exists()).toBe(true);

    wrapper.unmount();
  });

  it("title/tooltip 行为保留：迷你模式/桌面歌词/设置按钮 title 文案不变", async () => {
    const wrapper = mount(App);
    await flushPromises();

    expect(wrapper.find(".mini-btn").attributes("title")).toBe("迷你模式（独立小窗）");
    expect(wrapper.find(".lyric-float-btn").attributes("title")).toBe("打开桌面歌词");
    const settingsBtn = wrapper
      .findAll(".gear-btn")
      .find((b) => b.find(".gear-label").exists() && b.find(".gear-label").text() === "设置");
    expect(settingsBtn.attributes("title")).toBe("设置");

    wrapper.unmount();
  });

  it("跟唱模式（音乐内功能）：音乐 tab 保持高亮", async () => {
    state.mode = "karaoke";
    const wrapper = mount(App);
    await flushPromises();

    const tabs = wrapper.findAll(".mode-tabs .tab");
    const musicTab = tabs.find((b) => b.text().includes("音乐"));
    expect(musicTab.classes()).toContain("on");
    expect(tabs.find((b) => b.text().includes("图书")).classes()).not.toContain("on");
    expect(tabs.find((b) => b.text().includes("视频")).classes()).not.toContain("on");

    wrapper.unmount();
  });
});
