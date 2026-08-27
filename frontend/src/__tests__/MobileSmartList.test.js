// MobileSmartList 测试：移动端智能视图列表（最近添加/最近播放/常听排行）
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

const MobileSmartList = (await import("../components/mobile/MobileSmartList.vue")).default;
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

describe("MobileSmartList 最近添加（recentAdded）", () => {
  it("无需请求后端，直接取曲库前 50 首", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wrapper.find(".msv-title").text()).toBe("最近添加");
    expect(wrapper.findAll(".msv-item").length).toBe(2);
    expect(wrapper.find(".msv-count").text()).toBe("2 首");
  });

  it("空曲库显示空态文案", async () => {
    state.songs = [];
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    expect(wrapper.find(".msv-empty").text()).toBe("暂无歌曲");
  });
});

describe("MobileSmartList 最近播放（recentPlayed）", () => {
  it("拉取播放记录并渲染（副信息显示播放时间）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          records: [{ path: "/lib/b.mp3", ts: "2026-08-13T10:00:00Z" }],
        }),
      })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    expect(wrapper.find(".msv-title").text()).toBe("最近播放");
    const item = wrapper.find(".msv-item");
    expect(item.text()).toContain("知足");
    expect(item.text()).toContain("五月天");
    // 副信息 = 播放时间（月-日 时:分，本地时区 +8 → 18:00）
    expect(item.find(".msv-sub").text()).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("播放记录按 path 去重（同歌多条只保留最新）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          records: [
            { path: "/lib/a.mp3", ts: "2026-08-13T10:00:00Z" },
            { path: "/lib/a.mp3", ts: "2026-08-13T11:00:00Z" },
            { path: "/lib/b.mp3", ts: "2026-08-13T09:00:00Z" },
          ],
        }),
      })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    expect(wrapper.findAll(".msv-item").length).toBe(2);
  });

  it("空播放记录显示空态文案", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    expect(wrapper.find(".msv-empty").text()).toBe("暂无播放记录");
  });
});

describe("MobileSmartList 常听排行（topPlayed）", () => {
  it("拉取统计并渲染（副信息显示播放次数与累计时长）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          songs: [
            { path: "/lib/a.mp3", plays: 12, totalPlayed: 720 },
            { path: "/lib/b.mp3", plays: 3, totalPlayed: 90 },
          ],
        }),
      })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "topPlayed" } });
    await flushPromises();
    expect(wrapper.find(".msv-title").text()).toBe("常听排行");
    const items = wrapper.findAll(".msv-item");
    expect(items.length).toBe(2);
    // 按播放次数降序
    expect(items[0].text()).toContain("雪の華");
    expect(items[0].find(".msv-sub").text()).toContain("播放 12 次");
    expect(items[0].find(".msv-sub").text()).toContain("12 分钟");
  });

  it("后端返回曲库不存在的歌曲时跳过", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          songs: [
            { path: "/lib/a.mp3", plays: 1, totalPlayed: 10 },
            { path: "/lib/gone.mp3", plays: 99, totalPlayed: 999 },
          ],
        }),
      })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "topPlayed" } });
    await flushPromises();
    const items = wrapper.findAll(".msv-item");
    expect(items.length).toBe(1);
    expect(items[0].text()).toContain("雪の華");
  });
});

describe("MobileSmartList 加载/错误/交互", () => {
  it("请求挂起时显示加载中文案", async () => {
    // fetch 永不 resolve → loading 态保持
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    expect(wrapper.find(".msv-empty").text()).toBe("加载中…");
  });

  it("请求失败显示错误文案（不崩溃）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    expect(wrapper.find(".msv-empty").exists()).toBe(true);
    expect(wrapper.find(".msv-empty").text()).toBe("加载播放记录失败");
  });

  it("点击歌曲行：播放（全局 state 更新）+ 发 open-player 事件", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          records: [{ path: "/lib/b.mp3", ts: "2026-08-13T10:00:00Z" }],
        }),
      })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    await wrapper.find(".msv-item").trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
    expect(wrapper.emitted("open-player")).toBeTruthy();
  });

  it("当前播放行高亮 + 播放动画标记", async () => {
    state.currentIndex = 0;
    state.currentSong = lib[0];
    state.isPlaying = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          records: [{ path: "/lib/a.mp3", ts: "2026-08-13T10:00:00Z" }],
        }),
      })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    const item = wrapper.find(".msv-item");
    expect(item.classes()).toContain("active");
    expect(item.find(".msv-eq").exists()).toBe(true);
  });

  it("返回按钮 emit close 事件", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) })),
    );
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    await wrapper.find(".msv-back").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("kind 变化时重新拉取数据", async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ records: [] }) }));
    vi.stubGlobal("fetch", fetchSpy);
    const wrapper = mount(MobileSmartList, { props: { kind: "recentPlayed" } });
    await flushPromises();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await wrapper.setProps({ kind: "topPlayed" });
    await flushPromises();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBe("/api/playback/stats");
  });
});

describe("MobileSmartList showListCover 开关（列表封面：关闭后封面容器不渲染）", () => {
  it("showListCover=false 时 .msv-cover 不渲染，行信息仍完整", async () => {
    uiSettings.showListCover = false;
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    const item = wrapper.find(".msv-item");
    expect(item.exists()).toBe(true);
    expect(item.find(".msv-cover").exists()).toBe(false);
    expect(item.text()).toContain("雪の華");
    uiSettings.showListCover = true;
  });

  it("showListCover=true 时封面正常渲染（回归）", async () => {
    uiSettings.showListCover = true;
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    expect(wrapper.find(".msv-item .msv-cover").exists()).toBe(true);
  });
});
