// SmartViewPanel 组件测试（桌面智能视图面板：渲染/空态/加载/错误/点击播放）
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

const SmartViewPanel = (await import("../components/SmartViewPanel.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { closeSmartView } = await import("../composables/useSmartViews.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "c", path: "/lib/c.mp3", name: "温柔", artist: "五月天", album: "愛情萬歲" },
];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
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
  // 模拟桌面布局：播放列表面板作为智能视图的定位锚点
  const main = document.createElement("div");
  main.className = "main";
  main.innerHTML = '<div class="playlist"></div>';
  document.body.appendChild(main);
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function mountPanel(kind) {
  return mount(SmartViewPanel, {
    props: { kind },
    global: { stubs: { teleport: true } }, // teleport 内容内联渲染，便于断言
  });
}

function fetchReturning(body) {
  return vi.fn(async () => ({ ok: true, json: async () => body }));
}

describe("SmartViewPanel（桌面）", () => {
  it("渲染视图标题与歌曲行（最近播放）", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        records: [
          { path: "/lib/b.mp3", name: "知足", ts: "2026-08-13T10:00:00Z" },
          { path: "/lib/a.mp3", name: "雪の華", ts: "2026-08-13T09:00:00Z" },
        ],
      }),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-title").text()).toBe("最近播放");
    const items = wrapper.findAll(".sv-item");
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain("知足");
    expect(items[0].text()).toContain("五月天");
    expect(items[1].text()).toContain("雪の華");
    expect(wrapper.find(".sv-count").text()).toContain("2");
  });

  it("最近添加：直接用库顺序渲染（不发请求）", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mountPanel("recentAdded");
    await flushPromises();
    expect(fetchMock).not.toHaveBeenCalled();
    const items = wrapper.findAll(".sv-item");
    expect(items.some((i) => i.text().includes("雪の華"))).toBe(true);
  });

  it("常听排行：显示播放次数副信息", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        songs: [
          { path: "/lib/c.mp3", plays: 11, totalPlayed: 524 },
          { path: "/lib/a.mp3", plays: 2, totalPlayed: 100 },
        ],
      }),
    );
    const wrapper = mountPanel("topPlayed");
    await flushPromises();
    expect(wrapper.findAll(".sv-item")).toHaveLength(2);
    expect(wrapper.find(".sv-item").text()).toContain("播放 11 次");
  });

  it("空态：无播放记录显示提示文案", async () => {
    vi.stubGlobal("fetch", fetchReturning({ records: [] }));
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-empty").text()).toBe("暂无播放记录");
  });

  it("加载中显示加载提示", async () => {
    let resolveFetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-empty").text()).toBe("加载中…");
    resolveFetch({ ok: true, json: async () => ({ records: [] }) });
    await flushPromises();
  });

  it("接口失败显示错误信息", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-empty").exists()).toBe(true);
    expect(wrapper.find(".sv-empty").text()).toBeTruthy();
  });

  it("点击行触发播放（selectSong + play）", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        records: [{ path: "/lib/b.mp3", name: "知足", ts: "2026-08-13T10:00:00Z" }],
      }),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    await wrapper.find(".sv-item").trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
  });

  it("当前播放歌曲行高亮 active", async () => {
    vi.stubGlobal(
      "fetch",
      fetchReturning({
        records: [{ path: "/lib/a.mp3", name: "雪の華", ts: "2026-08-13T10:00:00Z" }],
      }),
    );
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    state.currentSong = lib[0];
    state.currentIndex = 0;
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".sv-item").classes()).toContain("active");
  });

  it("点击返回按钮触发 close 事件", async () => {
    vi.stubGlobal("fetch", fetchReturning({ records: [] }));
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    await wrapper.find(".sv-back").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
  });

  it("无定位锚点时面板不渲染（防溢出）", async () => {
    document.body.innerHTML = ""; // 移除 .main .playlist 锚点
    vi.stubGlobal("fetch", fetchReturning({ records: [] }));
    const wrapper = mountPanel("recentPlayed");
    await flushPromises();
    expect(wrapper.find(".sv-panel").exists()).toBe(false);
  });
});
