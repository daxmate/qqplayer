// MobilePlayer 测试：移动端全屏播放器（模式标签 + ControlBar 跟唱入口 + 收藏 + 收起）
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

const MobilePlayer = (await import("../components/mobile/MobilePlayer.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { _resetSleepTimer } = await import("../composables/useSleepTimer.js");

const song = { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" };

beforeEach(() => {
  Object.assign(state, {
    songs: [song],
    currentIndex: 0,
    currentSong: song,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
    lyric: [],
  });
  _resetSleepTimer();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobilePlayer 音乐模式（continuous）", () => {
  it("渲染歌曲名/歌手/专辑 + 封面 + 频谱 + 控制条", () => {
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-song-name").text()).toBe("雪の華");
    expect(wrapper.find(".mp-song-artist").text()).toContain("中島美嘉");
    expect(wrapper.find(".mp-song-artist").text()).toContain("雪の華"); // 专辑
    expect(
      wrapper.find(".mp-cover-area .cover").exists() || wrapper.find(".mp-cover-area img").exists(),
    ).toBe(true);
    expect(wrapper.find(".controls").exists()).toBe(true); // ControlBar
  });

  it("顶栏显示当前模式标签；ControlBar 跟唱按钮进入/退出跟唱", async () => {
    const wrapper = mount(MobilePlayer);
    expect(state.mode).toBe("continuous");
    expect(wrapper.find(".mp-tabs .mp-tab").text()).toContain("音乐");

    // 跟唱入口：控制条按钮（非 karaoke 变体）
    const karaokeBtn = wrapper.findAll(".controls .btn").find((b) => b.text().includes("跟唱"));
    expect(karaokeBtn).toBeTruthy();
    await karaokeBtn.trigger("click");
    expect(state.mode).toBe("karaoke");
    expect(wrapper.find(".mp-karaoke").exists()).toBe(true);
    expect(wrapper.find(".mp-tabs .mp-tab").text()).toContain("跟唱");

    // 跟唱界面再点"跟唱"按钮 → 退出回音乐（toggle 语义）
    const exitBtn = wrapper.findAll(".controls .btn").find((b) => b.text().includes("跟唱"));
    expect(exitBtn).toBeTruthy();
    await exitBtn.trigger("click");
    expect(state.mode).toBe("continuous");
    expect(wrapper.find(".mp-karaoke").exists()).toBe(false);
  });

  it("跟唱界面提供返回音乐按钮（←）", () => {
    state.mode = "karaoke";
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find('.controls .btn[title="返回音乐"]').exists()).toBe(true);
  });

  it("跟唱模式时顶栏标签显示跟唱（跟随 state.mode）", () => {
    state.mode = "karaoke";
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-tabs .mp-tab").text()).toContain("跟唱");
  });
});

describe("MobilePlayer 跟唱模式（karaoke）", () => {
  it("直接渲染歌词面板（复用 KaraokePanel）", () => {
    state.mode = "karaoke";
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-karaoke").exists()).toBe(true);
    expect(wrapper.find(".mp-karaoke .karaoke-panel").exists()).toBe(true);
    // ControlBar 收到 karaoke prop → 切换为跟唱控制条
    expect(wrapper.find(".controls.karaoke").exists()).toBe(true);
  });
});

describe("MobilePlayer 收藏", () => {
  it("无歌时不显示收藏按钮（占位）", () => {
    state.currentIndex = -1;
    state.currentSong = null;
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-song-name").text()).toBe("未选择歌曲");
    // 收藏按钮被占位 span 替代
    expect(wrapper.findAll(".mp-btn-round").length).toBe(2); // 收起 + 占位
  });

  it("有歌时点击收藏：乐观更新 + 调后端接口", async () => {
    const wrapper = mount(MobilePlayer);
    const heartBtn = wrapper.findAll(".mp-btn-round")[1];
    expect(heartBtn.find("svg").exists()).toBe(true);
    await heartBtn.trigger("click");
    expect(state.favorites).toContain(song.path);
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.some(([url, opt]) => url === "/api/favorites/toggle" && opt.method === "POST"),
    ).toBe(true);
  });

  it("已收藏歌曲：红心点亮", () => {
    state.favorites = [song.path];
    const wrapper = mount(MobilePlayer);
    const heartBtn = wrapper.findAll(".mp-btn-round")[1];
    expect(heartBtn.classes()).toContain("on");
  });
});

describe("MobilePlayer 收起与杂项", () => {
  it("收起按钮 emit back 事件", async () => {
    const wrapper = mount(MobilePlayer);
    await wrapper.find('.mp-btn-round[title="收起播放器"]').trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy();
  });

  it("睡眠定时器激活时显示倒计时", async () => {
    const { toggleSleepTimer } = await import("../composables/useSleepTimer.js");
    toggleSleepTimer();
    const wrapper = mount(MobilePlayer);
    expect(wrapper.find(".mp-sleep-timer").exists()).toBe(true);
    expect(wrapper.find(".mp-sleep-timer").text()).toContain("睡眠定时器");
  });
});
