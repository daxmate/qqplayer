// MobileSmartList 左滑操作测试（任务 I-11）
// 覆盖：左滑展开操作区 + 收藏 / 移除（从队列），recentAdded 视图无需请求后端
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Audio stub
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
const { clearToasts, useToast } = await import("../composables/useToast.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
];

function fireTouch(el, type, touches, changedTouches) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

async function swipeRow(rowEl, dx = -130) {
  const startX = 200;
  fireTouch(rowEl, "touchstart", [{ clientX: startX, clientY: 40 }]);
  fireTouch(rowEl, "touchmove", [{ clientX: startX + dx, clientY: 40 }]);
  fireTouch(rowEl, "touchend", [], [{ clientX: startX + dx, clientY: 40 }]);
  await flushPromises();
}

beforeEach(() => {
  // 注意：removeFromQueue 会原地 splice，必须用新数组，否则跨用例污染 lib
  Object.assign(state, {
    songs: lib.map((s) => ({ ...s })),
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
  clearToasts();
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock); // recentAdded 不请求后端
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobileSmartList 左滑操作（swipe-reveal）", () => {
  it("左滑行 → 露出操作区（行左移 168px）", async () => {
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    const items = wrapper.findAll(".msv-item");
    expect(items.length).toBe(2);
    await swipeRow(items[0].element, -130);
    expect(wrapper.findAll(".msv-wrap")[0].classes()).toContain("open");
    expect(wrapper.findAll(".msv-item")[0].attributes("style")).toContain("-168px");
  });

  it("操作区收藏 → toggleFavorite（乐观更新 + 调接口），执行后收起", async () => {
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    await swipeRow(wrapper.findAll(".msv-item")[0].element, -130);
    await wrapper.find(".msv-actions .msv-act").trigger("click");
    await flushPromises(); // 本地优先写：入队（IndexedDB）→ 同步 → 清队，多跳微任务后收起
    expect(state.favorites).toContain("/lib/a.mp3");
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.some(([url, opt]) => url === "/api/favorites/toggle" && opt.method === "POST"),
    ).toBe(true);
    expect(wrapper.findAll(".msv-wrap")[0].classes()).not.toContain("open");
  });

  it("操作区移除 → 从队列移除（state.songs 缩短）+ toast「已移除」", async () => {
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    await swipeRow(wrapper.findAll(".msv-item")[0].element, -130);
    await wrapper.find(".msv-actions .msv-act-remove").trigger("click");
    await flushPromises();
    expect(state.songs.map((s) => s.path)).toEqual(["/lib/b.mp3"]);
    expect(useToast().items[0].text).toBe("已从队列移除《雪の華》");
  });

  it("滑动结束后点击行 → 点击被抑制（不播放），行保持展开；再次点击收起", async () => {
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    await swipeRow(wrapper.findAll(".msv-item")[0].element, -130);
    expect(wrapper.findAll(".msv-wrap")[0].classes()).toContain("open");
    await wrapper.findAll(".msv-item")[0].trigger("click");
    expect(wrapper.emitted("open-player")).toBeFalsy();
    expect(wrapper.findAll(".msv-wrap")[0].classes()).toContain("open");
    await wrapper.findAll(".msv-item")[0].trigger("click");
    expect(wrapper.findAll(".msv-wrap")[0].classes()).not.toContain("open");
    expect(wrapper.emitted("open-player")).toBeFalsy();
  });

  it("未滑动时点击行 → 照常播放并打开播放器（保留原有行为）", async () => {
    const wrapper = mount(MobileSmartList, { props: { kind: "recentAdded" } });
    await flushPromises();
    await wrapper.findAll(".msv-item")[0].trigger("click");
    expect(state.currentIndex).toBe(0);
    expect(state.isPlaying).toBe(true);
    expect(wrapper.emitted("open-player")).toBeTruthy();
  });
});
