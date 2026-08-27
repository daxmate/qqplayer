// MiniPlayerBar 测试：移动端底部迷你播放条（封面/歌名/播放暂停/下一首/打开播放器）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

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

const MiniPlayerBar = (await import("../components/mobile/MiniPlayerBar.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { uiSettings } = await import("../composables/useSettings.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
];

beforeEach(() => {
  Object.assign(state, {
    songs: lib,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MiniPlayerBar（移动端迷你播放条）", () => {
  it("无歌时显示空态文案，控制按钮禁用", () => {
    const wrapper = mount(MiniPlayerBar);
    expect(wrapper.text()).toContain("未选择歌曲");
    const btns = wrapper.findAll(".mp-btn");
    expect(btns.length).toBe(2);
    for (const b of btns) expect(b.classes()).toContain("disabled");
  });

  it("有歌时显示歌名与歌手", () => {
    state.currentIndex = 1;
    state.currentSong = lib[1];
    const wrapper = mount(MiniPlayerBar);
    expect(wrapper.find(".mp-name").text()).toBe("知足");
    expect(wrapper.find(".mp-artist").text()).toBe("五月天");
  });

  it("封面 URL 跟随当前歌曲 path 生成", () => {
    state.currentIndex = 0;
    state.currentSong = lib[0];
    const wrapper = mount(MiniPlayerBar);
    const img = wrapper.find(".mp-cover-img");
    expect(img.exists()).toBe(true);
    expect(img.attributes("src")).toBe("/api/cover?path=" + encodeURIComponent(lib[0].path));
  });

  it("封面加载失败后降级为图标", async () => {
    state.currentIndex = 0;
    state.currentSong = lib[0];
    const wrapper = mount(MiniPlayerBar);
    const img = wrapper.find(".mp-cover-img");
    await img.trigger("error");
    expect(wrapper.find(".mp-cover-img").exists()).toBe(false);
    expect(wrapper.find(".mp-cover svg").exists()).toBe(true);
  });

  it("播放/暂停按钮切换播放状态", async () => {
    state.currentIndex = 0;
    state.currentSong = lib[0];
    state.isPlaying = false;
    const wrapper = mount(MiniPlayerBar);
    // 未播放 → Play 图标，点击后播放
    expect(wrapper.find(".mp-btn").html()).toContain("lucide-play");
    await wrapper.find(".mp-btn").trigger("click");
    expect(state.isPlaying).toBe(true);
    await wrapper.vm.$nextTick();
    // 播放中 → Pause 图标
    expect(wrapper.find(".mp-btn").html()).toContain("lucide-pause");
  });

  it("下一首按钮切到下一首（越界回绕）", async () => {
    state.currentIndex = 0;
    state.currentSong = lib[0];
    state.isPlaying = false;
    const wrapper = mount(MiniPlayerBar);
    await wrapper.findAll(".mp-btn")[1].trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    // 再点：回到第一首
    await wrapper.findAll(".mp-btn")[1].trigger("click");
    expect(state.currentIndex).toBe(0);
  });

  it("未选歌时点下一首：从第一首开始（与 play() 自动选歌一致）", async () => {
    const wrapper = mount(MiniPlayerBar);
    await wrapper.findAll(".mp-btn")[1].trigger("click");
    expect(state.currentIndex).toBe(0);
    expect(state.currentSong.name).toBe("雪の華");
  });

  it("点击整条迷你条发出 open-player 事件（打开全屏播放器）", async () => {
    const wrapper = mount(MiniPlayerBar);
    await wrapper.find(".mini-player").trigger("click");
    expect(wrapper.emitted("open-player")).toBeTruthy();
  });

  it("点击控制按钮不触发 open-player（事件冒泡隔离）", async () => {
    const wrapper = mount(MiniPlayerBar);
    await wrapper.find(".mp-btns").trigger("click");
    expect(wrapper.emitted("open-player")).toBeFalsy();
  });

  it("showCover=false 时封面容器不渲染，信息与控制区仍完整", async () => {
    uiSettings.showCover = false;
    state.currentIndex = 0;
    state.currentSong = lib[0];
    const wrapper = mount(MiniPlayerBar);
    expect(wrapper.find(".mp-cover").exists()).toBe(false);
    expect(wrapper.find(".mp-name").text()).toBe("雪の華");
    expect(wrapper.findAll(".mp-btn").length).toBe(2);
    uiSettings.showCover = true;
  });

  it("showCover=true 时封面正常渲染（回归）", () => {
    uiSettings.showCover = true;
    state.currentIndex = 0;
    state.currentSong = lib[0];
    const wrapper = mount(MiniPlayerBar);
    expect(wrapper.find(".mp-cover").exists()).toBe(true);
  });
});
