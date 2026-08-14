// MobileShell 测试：移动端页面栈导航（Apple Music 式：home → list → player）
// 集成测试：真实 mount MobileHome/MobileList/MobilePlayer/MiniPlayerBar
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

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

const MobileShell = (await import("../components/mobile/MobileShell.vue")).default;
const { state } = await import("../composables/usePlayer.js");

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
    mode: "continuous",
    lyric: [],
  });
  // 歌词下载等网络请求全部 stub 掉（返回失败静默降级）
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobileShell 页面栈导航", () => {
  it("初始状态：首页 + 底部迷你播放条，无播放器", () => {
    const wrapper = mount(MobileShell);
    expect(wrapper.find(".mobile-shell").exists()).toBe(true);
    expect(wrapper.find(".mh-page").exists()).toBe(true); // MobileHome
    expect(wrapper.find(".mini-player").exists()).toBe(true); // MiniPlayerBar
    expect(wrapper.find(".mobile-player").exists()).toBe(false); // MobilePlayer
  });

  it("首页入口（搜索按钮）→ 进入列表页，迷你条仍在", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    expect(wrapper.find(".ml-page").exists()).toBe(true); // MobileList
    expect(wrapper.find(".mh-page").exists()).toBe(false); // home 已推出
    expect(wrapper.find(".mini-player").exists()).toBe(true);
    expect(wrapper.find(".mobile-player").exists()).toBe(false);
  });

  it("列表返回 → 回到首页", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    expect(wrapper.find(".ml-page").exists()).toBe(true);
    await wrapper.find(".ml-back").trigger("click");
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    expect(wrapper.find(".ml-page").exists()).toBe(false);
  });

  it("迷你条点击 → 打开全屏播放器，迷你条隐藏", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find(".mini-player").trigger("click");
    expect(wrapper.find(".mobile-player").exists()).toBe(true);
    expect(wrapper.find(".mini-player").exists()).toBe(false); // 播放器打开时隐藏
  });

  it("播放器收起 → 回到首页，迷你条重现", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find(".mini-player").trigger("click");
    await wrapper.find('.mp-btn-round[title="收起播放器"]').trigger("click");
    expect(wrapper.find(".mobile-player").exists()).toBe(false);
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    expect(wrapper.find(".mini-player").exists()).toBe(true);
  });

  it("列表点击歌曲 → 开始播放 + 打开全屏播放器", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    await wrapper.findAll(".ml-item")[1].trigger("click");
    await flushPromises(); // playFromList 是 async（selectSong → loadLyric）
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
    expect(wrapper.find(".mobile-player").exists()).toBe(true);
    // 播放器内显示当前歌曲名
    expect(wrapper.find(".mp-song-name").text()).toBe("知足");
  });

  it("进列表 → 返回 → 再进列表 → 返回，栈始终可回退到首页", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    expect(wrapper.find(".ml-page").exists()).toBe(true);
    await wrapper.find(".ml-back").trigger("click");
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    // 再次进入（重新查找按钮，home 重挂载后旧引用已失效）
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    expect(wrapper.find(".ml-page").exists()).toBe(true);
    await wrapper.find(".ml-back").trigger("click");
    expect(wrapper.find(".mh-page").exists()).toBe(true);
  });

  it("播放器打开时再点迷你条位置不重复入栈（单层播放器）", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find(".mini-player").trigger("click");
    expect(wrapper.find(".mobile-player").exists()).toBe(true);
    // 播放器状态无法再点迷你条（已隐藏），直接收起到首页：栈底唯一 home
    await wrapper.find('.mp-btn-round[title="收起播放器"]').trigger("click");
    expect(wrapper.find(".mh-page").exists()).toBe(true);
  });

  it("分组下钻嵌套：播放列表 → 歌单 → 返回逐级回退到首页", async () => {
    state.playlists = [{ id: "p1", name: "我的歌单", songPaths: ["/lib/a.mp3"] }];
    const wrapper = mount(MobileShell);
    // 用文本定位「播放列表」卡片
    const cards = wrapper.findAll(".mh-card");
    const playlistsCard = cards.find((c) => c.text().includes("播放列表"));
    await playlistsCard.trigger("click");
    expect(wrapper.find(".ml-group").exists()).toBe(true);
    expect(wrapper.find(".ml-title").text()).toBe("播放列表");
    // 点歌单 → 嵌套歌曲列表
    await wrapper.find(".ml-group").trigger("click");
    expect(wrapper.find(".ml-title").text()).toBe("我的歌单");
    expect(wrapper.findAll(".ml-item").length).toBe(1);
    // 返回 → 回到播放列表分组
    await wrapper.find(".ml-back").trigger("click");
    expect(wrapper.find(".ml-title").text()).toBe("播放列表");
    // 再返回 → 回首页
    await wrapper.find(".ml-back").trigger("click");
    expect(wrapper.find(".mh-page").exists()).toBe(true);
  });

  it("智能视图歌曲行点击 → 播放 + 打开全屏播放器", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (url === "/api/songs") return { ok: true, json: async () => [] };
        if (url === "/api/playback") {
          return {
            ok: true,
            json: async () => ({ records: [{ path: "/lib/b.mp3", ts: "2026-08-13T10:00:00Z" }] }),
          };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const wrapper = mount(MobileShell);
    const cards = wrapper.findAll(".mh-card");
    const recentPlayed = cards.find((c) => c.text().includes("最近播放"));
    await recentPlayed.trigger("click");
    await flushPromises();
    expect(wrapper.find(".msv-item").exists()).toBe(true);
    await wrapper.find(".msv-item").trigger("click");
    await flushPromises();
    expect(state.currentIndex).toBe(1);
    expect(state.isPlaying).toBe(true);
    expect(wrapper.find(".mobile-player").exists()).toBe(true);
  });
});
