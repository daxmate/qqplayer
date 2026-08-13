// 移动端智能视图：首页入口卡片 + 列表浮层 + 点击播放链路
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
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

const MobileHome = (await import("../components/mobile/MobileHome.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { closeSmartView } = await import("../composables/useSmartViews.js");

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
  closeSmartView();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function cardByText(wrapper, text) {
  return wrapper.findAll(".mh-card").find((c) => c.text().includes(text));
}

describe("MobileHome 智能视图入口（移动端）", () => {
  it("首页渲染三张智能视图卡片", () => {
    const wrapper = mount(MobileHome);
    const text = wrapper.text();
    expect(text).toContain("最近添加");
    expect(text).toContain("最近播放");
    expect(text).toContain("常听排行");
  });

  it("最近添加卡片数量随曲库变化（封顶 50）", () => {
    const wrapper = mount(MobileHome);
    const card = cardByText(wrapper, "最近添加");
    expect(card.text()).toContain("2 首");
  });

  it("点击卡片打开智能视图列表（显示歌曲行）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          records: [{ path: "/lib/b.mp3", name: "知足", ts: "2026-08-13T10:00:00Z" }],
        }),
      })),
    );
    const wrapper = mount(MobileHome);
    await cardByText(wrapper, "最近播放").trigger("click");
    await flushPromises();
    expect(wrapper.find(".msv-page").exists()).toBe(true);
    expect(wrapper.find(".msv-title").text()).toBe("最近播放");
    expect(wrapper.find(".msv-item").text()).toContain("知足");
  });

  it("空播放记录显示空态文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) })),
    );
    const wrapper = mount(MobileHome);
    await cardByText(wrapper, "最近播放").trigger("click");
    await flushPromises();
    expect(wrapper.find(".msv-empty").text()).toBe("暂无播放记录");
  });

  it("点击歌曲行：播放 + 向 MobileShell 打开全屏播放器", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          records: [{ path: "/lib/b.mp3", name: "知足", ts: "2026-08-13T10:00:00Z" }],
        }),
      })),
    );
    const wrapper = mount(MobileHome);
    await cardByText(wrapper, "最近播放").trigger("click");
    await flushPromises();
    await wrapper.find(".msv-item").trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
    // MobileHome 转发 open-player → 'open' { name: 'player' }
    const opens = wrapper.emitted("open");
    expect(opens).toBeTruthy();
    expect(opens.some(([v]) => v && v.name === "player")).toBe(true);
  });

  it("返回按钮关闭列表浮层", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) })),
    );
    const wrapper = mount(MobileHome);
    await cardByText(wrapper, "常听排行").trigger("click");
    await flushPromises();
    expect(wrapper.find(".msv-page").exists()).toBe(true);
    await wrapper.find(".msv-back").trigger("click");
    expect(wrapper.find(".msv-page").exists()).toBe(false);
  });
});
