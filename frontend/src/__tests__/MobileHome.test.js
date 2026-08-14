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

describe("MobileHome 顶栏入口", () => {
  it("搜索入口 → open 全部歌曲列表（focusSearch 自动聚焦）", async () => {
    const wrapper = mount(MobileHome);
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    const opens = wrapper.emitted("open");
    expect(opens).toBeTruthy();
    expect(opens[0][0]).toMatchObject({
      name: "list",
      kind: "songs",
      payload: { focusSearch: true },
    });
  });

  it("设置入口 → open-settings 事件（MobileShell 转发到 App）", async () => {
    const wrapper = mount(MobileHome);
    await wrapper.find('.mh-icon-btn[title="设置"]').trigger("click");
    expect(wrapper.emitted("open-settings")).toBeTruthy();
  });
});

describe("MobileHome 入口卡片", () => {
  it("所有歌曲卡片：数量随曲库变化 + 点击 open songs 列表", async () => {
    const wrapper = mount(MobileHome);
    const card = cardByText(wrapper, "所有歌曲");
    expect(card.text()).toContain("2 首");
    await card.trigger("click");
    const opens = wrapper.emitted("open");
    expect(opens[0][0]).toMatchObject({ name: "list", kind: "songs", title: "所有歌曲" });
  });

  it("收藏卡片：数量随收藏变化（实际收藏计数）", async () => {
    const wrapper = mount(MobileHome);
    expect(cardByText(wrapper, "我喜欢的音乐").text()).toContain("0 首");
    state.favorites = ["/lib/a.mp3"];
    await flushPromises();
    expect(cardByText(wrapper, "我喜欢的音乐").text()).toContain("1 首");
  });

  it("播放列表/艺术家/专辑卡片数量", () => {
    state.playlists = [{ id: "p1", name: "我的歌单", songPaths: [] }];
    const wrapper = mount(MobileHome);
    expect(cardByText(wrapper, "播放列表").text()).toContain("1 个");
    expect(cardByText(wrapper, "艺术家").text()).toContain("2 位");
    expect(cardByText(wrapper, "专辑").text()).toContain("2 张");
  });

  it("艺术家/专辑分组与桌面一致：未知值归一化 + 排序", () => {
    state.songs = [
      { id: "x", path: "/lib/x.mp3", name: "X", artist: "", album: "" },
      { id: "y", path: "/lib/y.mp3", name: "Y", artist: "五月天", album: "" },
      { id: "z", path: "/lib/z.mp3", name: "Z", artist: "五月天", album: "" },
    ];
    const wrapper = mount(MobileHome);
    expect(cardByText(wrapper, "艺术家").text()).toContain("2 位"); // 未知歌手 + 五月天
    expect(cardByText(wrapper, "专辑").text()).toContain("1 张"); // 三首都归一化为未知专辑
  });
});

describe("MobileHome 智能视图开关与打开文件", () => {
  it("再点同一卡片：关闭已打开的智能视图", async () => {
    const wrapper = mount(MobileHome);
    const card = cardByText(wrapper, "最近添加");
    await card.trigger("click");
    expect(wrapper.find(".msv-page").exists()).toBe(true);
    await card.trigger("click");
    expect(wrapper.find(".msv-page").exists()).toBe(false);
  });

  it("打开文件：选择文件后显示导入提示 toast", async () => {
    const wrapper = mount(MobileHome);
    const input = wrapper.find(".mh-file-input");
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "a.mp3", { type: "audio/mpeg" }), new File(["x"], "b.mp3")],
      configurable: true,
    });
    await input.trigger("change");
    expect(wrapper.find(".mh-toast").text()).toBe("已选择 2 个文件，NAS 导入接口待后端支持");
  });

  it("toast 超时后自动消失（3.2s）", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(MobileHome);
      const input = wrapper.find(".mh-file-input");
      Object.defineProperty(input.element, "files", {
        value: [new File(["x"], "a.mp3")],
        configurable: true,
      });
      await input.trigger("change");
      expect(wrapper.find(".mh-toast").exists()).toBe(true);
      vi.advanceTimersByTime(3300);
      await flushPromises();
      expect(wrapper.find(".mh-toast").exists()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
