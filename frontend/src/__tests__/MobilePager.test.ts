// MobilePager 测试：主层级横滑分页容器（音乐 / 图书 / 有声书 / 视频）
// 覆盖：左滑翻页 + 指示器更新 / 边界（第 0 屏右滑、末屏左滑无动作）/ 左缘起点让位边缘滑动 /
//       有声书占位页渲染
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const MobilePager = (await import("../components/mobile/MobilePager.vue")).default;
const { state } = await import("../composables/usePlayer.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
];

interface TouchPoint {
  clientX: number;
  clientY: number;
}

function fireTouch(
  el: Element,
  type: string,
  touches?: TouchPoint[],
  changedTouches?: TouchPoint[],
) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

// 分页容器横滑（from → to；clientY 固定避免纵向干扰）
async function pagerSwipe(
  wrapper: VueWrapper,
  {
    from = 220,
    to = 60,
    steps = 4,
    y = 200,
  }: { from?: number; to?: number; steps?: number; y?: number } = {},
) {
  const el = wrapper.find(".mp-pager").element;
  fireTouch(el, "touchstart", [{ clientX: from, clientY: y }]);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    fireTouch(el, "touchmove", [{ clientX: x, clientY: y }]);
  }
  fireTouch(el, "touchend", [], [{ clientX: to, clientY: y }]);
  await flushPromises();
}

function activeDot(wrapper: VueWrapper) {
  const dots = wrapper.findAll(".mp-dot");
  return dots.findIndex((d) => d.classes().includes("on"));
}

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
  // 书架/视频库等网络请求全部 stub 掉（返回失败 → 空态）
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobilePager 横滑分页", () => {
  it("初始：第 0 屏音乐页 + 4 个指示圆点（第 1 个高亮）", () => {
    const wrapper = mount(MobilePager);
    expect(wrapper.findAll(".mp-dot").length).toBe(4);
    expect(activeDot(wrapper)).toBe(0);
    expect(wrapper.find(".mh-page").exists()).toBe(true); // 音乐屏
    // 其余屏随容器并排渲染（横向 translate 移出视口）
    expect(wrapper.find(".mb-page").exists()).toBe(true); // 图书
    expect(wrapper.find(".ma-page").exists()).toBe(true); // 有声书
    expect(wrapper.find(".mv-page").exists()).toBe(true); // 视频
  });

  it("左滑翻页：音乐 → 图书 → 有声书 → 视频，指示器逐屏高亮", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper); // 左滑 → 图书
    expect(activeDot(wrapper)).toBe(1);
    await pagerSwipe(wrapper); // → 有声书
    expect(activeDot(wrapper)).toBe(2);
    await pagerSwipe(wrapper); // → 视频
    expect(activeDot(wrapper)).toBe(3);
    expect(wrapper.find(".mv-page").exists()).toBe(true);
  });

  it("右滑翻回：视频 → 有声书 → 图书 → 音乐", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper); // → 1
    await pagerSwipe(wrapper); // → 2
    await pagerSwipe(wrapper); // → 3
    await pagerSwipe(wrapper, { from: 60, to: 220 }); // 右滑 → 2
    expect(activeDot(wrapper)).toBe(2);
    await pagerSwipe(wrapper, { from: 60, to: 220 }); // → 1
    expect(activeDot(wrapper)).toBe(1);
    await pagerSwipe(wrapper, { from: 60, to: 220 }); // → 0
    expect(activeDot(wrapper)).toBe(0);
  });

  it("边界：第 0 屏右滑无动作（不翻页、指示器不变）", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper, { from: 60, to: 220 }); // 右滑
    expect(activeDot(wrapper)).toBe(0); // 仍在第 0 屏
    expect(wrapper.emitted("open")).toBeFalsy();
  });

  it("边界：末屏（视频）左滑无动作", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper);
    await pagerSwipe(wrapper);
    await pagerSwipe(wrapper); // → 3（末屏）
    await pagerSwipe(wrapper, { from: 220, to: 60 }); // 再左滑
    expect(activeDot(wrapper)).toBe(3);
  });

  it("左缘起点（<24px）横滑不接管：让位壳层边缘滑动（负一屏/翻上一屏）", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper, { from: 8, to: 150 }); // 左缘右滑
    expect(activeDot(wrapper)).toBe(0); // 分页不动作
    expect(wrapper.emitted("open-settings")).toBeFalsy(); // 负一屏由壳层处理，此处不冒泡
  });

  it("位移不足（<80px）→ 回弹不翻页", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper, { from: 220, to: 250 }); // dx = 30
    expect(activeDot(wrapper)).toBe(0);
  });

  it("纵向主导滑动（dy > dx）→ 不翻页：让位页面垂直滚动", async () => {
    const wrapper = mount(MobilePager);
    const el = wrapper.find(".mp-pager").element;
    fireTouch(el, "touchstart", [{ clientX: 220, clientY: 100 }]);
    fireTouch(el, "touchmove", [{ clientX: 230, clientY: 300 }]);
    fireTouch(el, "touchmove", [{ clientX: 232, clientY: 460 }]);
    fireTouch(el, "touchend", [], [{ clientX: 232, clientY: 460 }]);
    await flushPromises();
    expect(activeDot(wrapper)).toBe(0);
  });
});

describe("MobilePager 分页屏", () => {
  it("第 2 屏为有声书占位页（图标 + 标题 + 敬请期待）", async () => {
    const wrapper = mount(MobilePager);
    await pagerSwipe(wrapper); // → 1
    await pagerSwipe(wrapper); // → 2 有声书
    const text = wrapper.find(".ma-page").text();
    expect(text).toContain("有声书");
    expect(text).toContain("敬请期待");
    expect(wrapper.find(".ma-icon").exists()).toBe(true);
  });

  it("图书/视频分页屏（standalone=false）：书架态不渲染返回按钮", () => {
    const wrapper = mount(MobilePager);
    // 图书屏在分页容器中常驻渲染（第 1 屏）
    expect(wrapper.find(".mb-page .mb-back").exists()).toBe(false);
    // 视频屏（第 3 屏）
    expect(wrapper.find(".mv-page .mv-back").exists()).toBe(false);
  });
});
