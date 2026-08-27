// MobileShell 边缘滑动返回测试（任务 I-10 + 主界面导航重构：负一屏设置区 + 分页左缘翻页）
// 覆盖：左缘右滑序列触发 pop / 位移不足回弹 / 非左缘起点不响应 /
//       分页第 0 屏左缘右滑 → 负一屏设置区（默认同步面板）/ 负一屏返回 /
//       其余分页屏左缘右滑 → 翻上一屏 / 播放器页可返回 / 纵向滑动不误触
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

// jsdom 无 TouchEvent，用原生 Event + 手写 touches/changedTouches 模拟
function fireTouch(el, type, touches, changedTouches) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

// 左缘横向滑动序列（from → to，clientY 固定 120 避免纵向干扰）
async function edgeSwipe(wrapper, { from = 8, to = 130, steps = 4 } = {}) {
  const el = wrapper.find(".mobile-shell").element;
  fireTouch(el, "touchstart", [{ clientX: from, clientY: 120 }]);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    fireTouch(el, "touchmove", [{ clientX: x, clientY: 120 }]);
  }
  fireTouch(el, "touchend", [], [{ clientX: to, clientY: 120 }]);
  await flushPromises();
}

// 分页容器普通区域横滑（非左缘起点）：左滑=下一页，右滑=上一页
async function pagerSwipe(wrapper, { from = 220, to = 60, steps = 4 } = {}) {
  const el = wrapper.find(".mp-pager").element;
  fireTouch(el, "touchstart", [{ clientX: from, clientY: 200 }]);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    fireTouch(el, "touchmove", [{ clientX: x, clientY: 200 }]);
  }
  fireTouch(el, "touchend", [], [{ clientX: to, clientY: 200 }]);
  await flushPromises();
}

function edgeShift(wrapper) {
  return wrapper.find(".mobile-shell").element.style.getPropertyValue("--edge-shift");
}

// 当前高亮圆点下标（0..3）
function activeDot(wrapper) {
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
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function openSongList(wrapper) {
  const rows = wrapper.findAll(".mh-row");
  await rows.find((c) => c.text().includes("所有歌曲")).trigger("click");
}

describe("MobileShell 边缘滑动返回", () => {
  it("左缘起点右滑（位移超过阈值 + 速度快）→ pop 返回上一页", async () => {
    const wrapper = mount(MobileShell);
    await openSongList(wrapper);
    expect(wrapper.find(".ml-page").exists()).toBe(true);
    await edgeSwipe(wrapper, { from: 8, to: 130 }); // dx = 122 > 80
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    expect(wrapper.find(".ml-page").exists()).toBe(false);
    expect(edgeShift(wrapper)).toBe("0px"); // 手势结束位移归零
  });

  it("位移不足（< 80px）→ 不返回，位移回弹归零", async () => {
    const wrapper = mount(MobileShell);
    await openSongList(wrapper);
    await edgeSwipe(wrapper, { from: 8, to: 50 }); // dx = 42 < 80
    expect(wrapper.find(".ml-page").exists()).toBe(true); // 仍在列表页
    expect(wrapper.find(".mh-page").exists()).toBe(false);
    expect(edgeShift(wrapper)).toBe("0px"); // 回弹
  });

  it("非左缘起点（clientX > 24）→ 不触发返回", async () => {
    const wrapper = mount(MobileShell);
    await openSongList(wrapper);
    await edgeSwipe(wrapper, { from: 120, to: 240 }); // dx = 120 够大，但起点不在左缘
    expect(wrapper.find(".ml-page").exists()).toBe(true);
    expect(wrapper.find(".mh-page").exists()).toBe(false);
    expect(edgeShift(wrapper)).toBe(""); // 从未跟手
  });

  it("分页第 0 屏（音乐页）左缘右滑 → 打开负一屏设置区（默认同步面板）", async () => {
    const wrapper = mount(MobileShell); // stack = [main]，page 0
    await edgeSwipe(wrapper, { from: 8, to: 150 });
    expect(wrapper.find(".ms-page").exists()).toBe(true); // MobileSettings
    expect(wrapper.find(".msc-page").exists()).toBe(true); // 同步面板（MobileSync embedded）
    expect(wrapper.find(".mh-page").exists()).toBe(false);
    expect(edgeShift(wrapper)).toBe("0px");
  });

  it("负一屏返回按钮 → 回到音乐页（pop 出 settings）", async () => {
    const wrapper = mount(MobileShell);
    await edgeSwipe(wrapper, { from: 8, to: 150 }); // 进 settings
    expect(wrapper.find(".ms-page").exists()).toBe(true);
    await wrapper.find(".ms-back").trigger("click");
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    expect(wrapper.find(".ms-page").exists()).toBe(false);
  });

  it("负一屏内左缘右滑（栈深>1）→ pop 回音乐页（右滑返回自动生效）", async () => {
    const wrapper = mount(MobileShell);
    await edgeSwipe(wrapper, { from: 8, to: 150 }); // 进 settings
    expect(wrapper.find(".ms-page").exists()).toBe(true);
    await edgeSwipe(wrapper, { from: 8, to: 130 }); // 再滑 → 栈深 2 > 1 → pop
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    expect(wrapper.find(".ms-page").exists()).toBe(false);
  });

  it("分页第 1 屏左缘右滑 → 翻上一屏（回音乐页），不打开负一屏", async () => {
    const wrapper = mount(MobileShell);
    await pagerSwipe(wrapper, { from: 220, to: 60 }); // 普通区域左滑 → 第 1 屏（图书）
    expect(activeDot(wrapper)).toBe(1);
    expect(wrapper.find(".mb-page").exists()).toBe(true);
    await edgeSwipe(wrapper, { from: 8, to: 130 }); // 左缘右滑 → 翻上一屏
    expect(activeDot(wrapper)).toBe(0);
    expect(wrapper.find(".mh-page").exists()).toBe(true);
    expect(wrapper.find(".ms-page").exists()).toBe(false);
  });

  it("分页第 2 屏左缘右滑 → 翻上一屏（回图书屏）", async () => {
    const wrapper = mount(MobileShell);
    await pagerSwipe(wrapper, { from: 220, to: 60 }); // → 1
    await pagerSwipe(wrapper, { from: 220, to: 60 }); // → 2（有声书）
    expect(activeDot(wrapper)).toBe(2);
    await edgeSwipe(wrapper, { from: 8, to: 130 }); // 左缘右滑 → 回第 1 屏
    expect(activeDot(wrapper)).toBe(1);
    expect(wrapper.find(".mb-page").exists()).toBe(true);
  });

  it("全屏播放器页左缘滑动 → 返回音乐页（与返回按钮共用 pop）", async () => {
    const wrapper = mount(MobileShell);
    await wrapper.find(".mini-player").trigger("click");
    expect(wrapper.find(".mobile-player").exists()).toBe(true);
    await edgeSwipe(wrapper, { from: 8, to: 130 });
    expect(wrapper.find(".mobile-player").exists()).toBe(false);
    expect(wrapper.find(".mh-page").exists()).toBe(true);
  });

  it("纵向滑动（dy 主导）不触发返回：让位列表滚动", async () => {
    const wrapper = mount(MobileShell);
    await openSongList(wrapper);
    const el = wrapper.find(".mobile-shell").element;
    // 起点在左缘，但主要位移是纵向
    fireTouch(el, "touchstart", [{ clientX: 8, clientY: 120 }]);
    fireTouch(el, "touchmove", [{ clientX: 14, clientY: 260 }]);
    fireTouch(el, "touchmove", [{ clientX: 16, clientY: 400 }]);
    fireTouch(el, "touchend", [], [{ clientX: 16, clientY: 400 }]);
    await flushPromises();
    expect(wrapper.find(".ml-page").exists()).toBe(true);
    expect(wrapper.find(".mh-page").exists()).toBe(false);
    expect(edgeShift(wrapper)).toBe("0px");
  });
});
