// MobilePlayer 横滑手势 + 全歌词界面测试（fix/mobile-full-lyric）
// 覆盖：
//   封面区：左划 → nextSong / 右划 → prevSong / 位移不足或速度慢 → 回弹不切歌 /
//           滑出编排后封面位移归零（滑入 0）/ 下拉返回原行为不破坏（方向仲裁）
//   歌词区：左划 → 全歌词界面打开 / 纵向滚动不被劫持 / 右划无动作
//   全歌词界面：右划 → 关闭 / 返回按钮 → 关闭 / 布局（毛玻璃背景 + 头部 + 歌词 + 控制区）
// 事件模拟沿用 MobileShell.edgeSwipe.test.js 的 fireTouch helper：原生 Event + 手写 touches。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";
import type { HorizontalSwipeOptions } from "../composables/useSwipe.js";

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

const MobilePlayer = (await import("../components/mobile/MobilePlayer.vue")).default;
const { state, uiSettings } = await import("../composables/usePlayer.js");
const { _resetSleepTimer } = await import("../composables/useSleepTimer.js");
const { useHorizontalSwipe } = await import("../composables/useSwipe.js");

const songA = { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" };
const songB = { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" };

// jsdom 无 TouchEvent，用原生 Event + 手写 touches/changedTouches 模拟
type TouchLike = { clientX: number; clientY: number; screenY?: number };
function fireTouch(el: Element, type: string, touches?: TouchLike[], changedTouches?: TouchLike[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

function touch(x: number, y: number): TouchLike {
  return { clientX: x, clientY: y, screenY: y };
}

// 封面区横向滑动序列（from → to，clientY 固定 200 避免纵向干扰）
function coverSwipeEl(wrapper: VueWrapper, { from = 200, to = 60, steps = 4, y = 200 } = {}) {
  const el = wrapper.find(".mp-cover-area").element;
  fireTouch(el, "touchstart", [touch(from, y)]);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    fireTouch(el, "touchmove", [touch(x, y)]);
  }
  fireTouch(el, "touchend", [], [touch(to, y)]);
}

// 歌词区左划序列（从 kp-scroll 内部发起，模拟真实触点路径：事件会冒泡到 .mp-lyric-area）
function lyricSwipeEl(wrapper: VueWrapper, { from = 250, to = 90, steps = 4, y = 300 } = {}) {
  const el = wrapper.find(".mp-lyric-area .kp-scroll").element;
  fireTouch(el, "touchstart", [touch(from, y)]);
  for (let i = 1; i <= steps; i++) {
    const x = from + ((to - from) * i) / steps;
    fireTouch(el, "touchmove", [touch(x, y)]);
  }
  fireTouch(el, "touchend", [], [touch(to, y)]);
}

function coverShift(wrapper: VueWrapper) {
  return wrapper.find(".mp-cover-area").attributes("style") || "";
}

beforeEach(() => {
  Object.assign(state, {
    songs: [songA, songB],
    currentIndex: 0,
    currentSong: songA,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
    lyric: [],
    playMode: "order",
  });
  uiSettings.glassCover = true;
  _resetSleepTimer();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  _resetSleepTimer();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MobilePlayer 封面区横向切歌", () => {
  it("左划（位移超阈值 + 速度快）→ 滑出后触发 nextSong，切歌后封面滑入归零", async () => {
    const wrapper = mount(MobilePlayer);
    coverSwipeEl(wrapper, { from: 200, to: 60 }); // dx = -140
    await nextTick();
    // 松手即编排滑出：封面跟手位移跳到 -屏宽（1024）
    expect(coverShift(wrapper)).toContain("translateX(-1024px)");
    await flushPromises();
    // 滑出动画（200ms）后切歌
    await vi.waitFor(() => expect(state.currentIndex).toBe(1));
    expect(state.currentSong!.name).toBe("知足");
    // 封面 URL 变化 → 重定位到 +屏宽 → 下一帧滑入 0
    await new Promise((r) => requestAnimationFrame(r));
    expect(coverShift(wrapper)).not.toContain("translateX");
  });

  it("右划（位移超阈值 + 速度快）→ 触发 prevSong", async () => {
    state.currentIndex = 1;
    state.currentSong = songB;
    const wrapper = mount(MobilePlayer);
    coverSwipeEl(wrapper, { from: 60, to: 200 }); // dx = +140
    await nextTick();
    expect(coverShift(wrapper)).toContain("translateX(1024px)"); // 滑出到右侧
    await flushPromises();
    await vi.waitFor(() => expect(state.currentIndex).toBe(0));
    expect(state.currentSong!.name).toBe("雪の華");
  });

  it("位移不足（< 80px）→ 回弹不切歌，位移归零", async () => {
    const wrapper = mount(MobilePlayer);
    coverSwipeEl(wrapper, { from: 200, to: 170 }); // dx = -30
    await flushPromises();
    expect(state.currentIndex).toBe(0);
    expect(wrapper.emitted("back")).toBeFalsy();
    expect(coverShift(wrapper)).not.toContain("translateX");
  });

  it("位移够但速度慢（拖到阈值后慢速停住）→ 回弹不切歌", async () => {
    // 控制 Date.now：首段快（瞬发），末段慢（10s 拖 20px）→ lastV 极低不触发
    let fakeNow = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => fakeNow);
    const wrapper = mount(MobilePlayer);
    const el = wrapper.find(".mp-cover-area").element;
    fakeNow = 1000;
    fireTouch(el, "touchstart", [touch(200, 200)]);
    fakeNow = 1000;
    fireTouch(el, "touchmove", [touch(100, 200)]); // dx = -100
    fakeNow = 11000;
    fireTouch(el, "touchmove", [touch(80, 200)]); // dx = -120，段速 -0.002
    fakeNow = 12000;
    fireTouch(el, "touchend", [], [touch(80, 200)]);
    await flushPromises();
    expect(state.currentIndex).toBe(0); // 未切歌
    expect(coverShift(wrapper)).not.toContain("translateX"); // 回弹归零
  });

  it("横向主导的对角线 → 切歌而不是下拉返回（方向仲裁）", async () => {
    const wrapper = mount(MobilePlayer);
    const el = wrapper.find(".mp-cover-area").element;
    fireTouch(el, "touchstart", [touch(200, 150)]);
    fireTouch(el, "touchmove", [touch(140, 175)]); // dx=-60 dy=25 → 横向锁定
    fireTouch(el, "touchmove", [touch(60, 190)]); // dx=-140 dy=40
    fireTouch(el, "touchend", [], [touch(60, 190)]);
    await flushPromises();
    await vi.waitFor(() => expect(state.currentIndex).toBe(1)); // 切歌
    expect(wrapper.emitted("back")).toBeFalsy(); // 未触发下拉返回
  });

  it("纵向主导的对角线 → 下拉返回而不是切歌", async () => {
    const wrapper = mount(MobilePlayer);
    const el = wrapper.find(".mp-cover-area").element;
    fireTouch(el, "touchstart", [touch(150, 60)]);
    fireTouch(el, "touchmove", [touch(160, 130)]); // dx=10 dy=70 → 纵向锁定
    fireTouch(el, "touchmove", [touch(170, 200)]); // dy=140
    fireTouch(el, "touchend", [], [touch(170, 200)]);
    expect(wrapper.emitted("back")).toBeTruthy();
    expect(state.currentIndex).toBe(0); // 未切歌
  });

  it("下拉超过阈值（原行为保留）→ emit back", async () => {
    const wrapper = mount(MobilePlayer);
    const area = wrapper.find(".mp-cover-area");
    await area.trigger("touchstart", { touches: [touch(100, 60)] });
    await area.trigger("touchmove", { touches: [touch(100, 200)] }); // dy=140
    await area.trigger("touchend", { changedTouches: [touch(100, 200)] });
    expect(wrapper.emitted("back")).toBeTruthy();
  });

  it("滑出编排中（busy）新手势被忽略，不重复切歌", async () => {
    const wrapper = mount(MobilePlayer);
    coverSwipeEl(wrapper, { from: 200, to: 60 }); // 触发编排（busy）
    // 编排未完成前再来一次左划 → 不响应
    coverSwipeEl(wrapper, { from: 200, to: 60 });
    await flushPromises();
    await vi.waitFor(() => expect(state.currentIndex).toBe(1));
    // 等待兜底/滑入完成后 busy 解除，也不会多切一次
    await new Promise((r) => setTimeout(r, 650));
    await new Promise((r) => requestAnimationFrame(r));
    expect(state.currentIndex).toBe(1);
  });
});

describe("MobilePlayer 歌词区左划 → 全歌词界面", () => {
  it("左划达阈值 → 打开全歌词界面（毛玻璃背景 + 头部 + 全屏歌词 + 控制区）", async () => {
    state.lyric = [
      { type: "line", s: 0, e: 10, text: ["第一句"] },
      { type: "line", s: 10, e: 20, text: ["第二句"] },
    ];
    const wrapper = mount(MobilePlayer);
    lyricSwipeEl(wrapper, { from: 250, to: 90 }); // dx = -160
    await nextTick();
    const fl = wrapper.find(".mp-full-lyric");
    expect(fl.exists()).toBe(true);
    // 背景：毛玻璃同款（玻璃图 + 遮罩 + 渐变兜底）
    expect(fl.find(".mp-glass .mp-glass-img").exists()).toBe(true);
    expect(fl.find(".mp-glass-scrim").exists()).toBe(true);
    expect(fl.find(".mp-gradient").exists()).toBe(true);
    // 头部：返回按钮 + 歌名/歌手
    expect(fl.find(".mp-fl-back").exists()).toBe(true);
    expect(fl.find(".mp-fl-name").text()).toBe("雪の華");
    expect(fl.find(".mp-fl-artist").text()).toContain("中島美嘉");
    // 中间：全屏歌词（KaraokePanel headless，字号放大 fontScale）
    expect(fl.find(".mp-fl-lyric .karaoke-panel").exists()).toBe(true);
    expect(fl.findAll(".mp-fl-lyric .kline").length).toBe(2);
    // 底部：与主播放页同款控制区（共享组件）
    expect(fl.find(".mp-fl-content .mp-controls-row").exists()).toBe(true);
    expect(fl.find(".mp-fl-content .mp-play").exists()).toBe(true);
    expect(fl.find(".mp-fl-content .mp-moon-btn").exists()).toBe(true);
    // 歌词区位移已重置
    expect(wrapper.find(".mp-lyric-area").attributes("style") || "").not.toContain("translateX");
  });

  it("歌词区纵向滚动不被劫持：不打开全歌词、歌词区无横向位移", async () => {
    state.lyric = [
      { type: "line", s: 0, e: 10, text: ["第一句"] },
      { type: "line", s: 10, e: 20, text: ["第二句"] },
    ];
    const wrapper = mount(MobilePlayer);
    const el = wrapper.find(".mp-lyric-area .kp-scroll").element;
    fireTouch(el, "touchstart", [touch(150, 200)]);
    fireTouch(el, "touchmove", [touch(153, 340)]);
    fireTouch(el, "touchmove", [touch(154, 480)]);
    fireTouch(el, "touchend", [], [touch(154, 480)]);
    await nextTick();
    expect(wrapper.find(".mp-full-lyric").exists()).toBe(false);
    expect(wrapper.find(".mp-lyric-area").attributes("style") || "").not.toContain("translateX");
  });

  it("歌词区右划 → 无动作（不打开全歌词、不跟手）", async () => {
    const wrapper = mount(MobilePlayer);
    const el = wrapper.find(".mp-lyric-area .kp-scroll").element;
    fireTouch(el, "touchstart", [touch(100, 300)]);
    fireTouch(el, "touchmove", [touch(180, 300)]);
    fireTouch(el, "touchmove", [touch(260, 300)]);
    fireTouch(el, "touchend", [], [touch(260, 300)]);
    await nextTick();
    expect(wrapper.find(".mp-full-lyric").exists()).toBe(false);
    expect(wrapper.find(".mp-lyric-area").attributes("style") || "").not.toContain("translateX");
  });

  it("全歌词打开后：封面手势/下拉不响应（覆盖层 + 守卫）", async () => {
    const wrapper = mount(MobilePlayer);
    lyricSwipeEl(wrapper, { from: 250, to: 90 });
    await nextTick();
    expect(wrapper.find(".mp-full-lyric").exists()).toBe(true);
    // 在全歌词打开状态下对封面区做下拉 → 不 emit back
    const area = wrapper.find(".mp-cover-area");
    await area.trigger("touchstart", { touches: [touch(100, 60)] });
    await area.trigger("touchmove", { touches: [touch(100, 200)] });
    await area.trigger("touchend", { changedTouches: [touch(100, 200)] });
    expect(wrapper.emitted("back")).toBeFalsy();
  });
});

describe("MobilePlayer 全歌词界面关闭", () => {
  async function openFullLyric(wrapper: VueWrapper) {
    lyricSwipeEl(wrapper, { from: 250, to: 90 });
    await nextTick();
    expect(wrapper.find(".mp-full-lyric").exists()).toBe(true);
  }

  it("右划达阈值 → 滑出后关闭回到主播放页", async () => {
    const wrapper = mount(MobilePlayer);
    await openFullLyric(wrapper);
    const fl = wrapper.find(".mp-full-lyric").element;
    fireTouch(fl, "touchstart", [touch(40, 300)]);
    fireTouch(fl, "touchmove", [touch(100, 300)]);
    fireTouch(fl, "touchmove", [touch(180, 300)]); // dx = +140
    fireTouch(fl, "touchend", [], [touch(180, 300)]);
    await vi.waitFor(() => expect(wrapper.find(".mp-full-lyric").exists()).toBe(false));
    // 主播放页仍在，歌词区位移清零
    expect(wrapper.find(".mp-cover-area").exists()).toBe(true);
    expect(wrapper.find(".mp-lyric-area").attributes("style") || "").not.toContain("translateX");
  });

  it("右划位移不足 → 回弹，全歌词保持打开", async () => {
    const wrapper = mount(MobilePlayer);
    await openFullLyric(wrapper);
    const fl = wrapper.find(".mp-full-lyric").element;
    fireTouch(fl, "touchstart", [touch(100, 300)]);
    fireTouch(fl, "touchmove", [touch(130, 300)]); // dx = +30
    fireTouch(fl, "touchend", [], [touch(130, 300)]);
    await new Promise((r) => setTimeout(r, 50));
    expect(wrapper.find(".mp-full-lyric").exists()).toBe(true);
  });

  it("返回按钮 → 滑出关闭", async () => {
    const wrapper = mount(MobilePlayer);
    await openFullLyric(wrapper);
    await wrapper.find(".mp-fl-back").trigger("click");
    await vi.waitFor(() => expect(wrapper.find(".mp-full-lyric").exists()).toBe(false));
  });

  it("全歌词界面内操作钮可点：下一首按钮切歌", async () => {
    const wrapper = mount(MobilePlayer);
    await openFullLyric(wrapper);
    // 控制区按钮顺序：模式/上一首/播放/下一首/队列/月亮
    await wrapper.find(".mp-full-lyric .mp-controls-row").findAll("button")[3].trigger("click");
    expect(state.currentIndex).toBe(1);
  });
});

describe("useHorizontalSwipe 参数化手势（useSwipe.js）", () => {
  function mountHost(
    direction: "both" | "left" | "right",
    opts: Partial<HorizontalSwipeOptions> = {},
  ) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const el = document.createElement("div");
    host.appendChild(el);
    const onTrigger = vi.fn();
    const swipe = useHorizontalSwipe({ direction, onTrigger, ...opts });
    swipe.bind(el);
    return { host, el, onTrigger, swipe };
  }

  it("direction:left：纵向滑动不 preventDefault（让位滚动）；横向锁定后才接管并触发 left", () => {
    const { host, el, onTrigger, swipe } = mountHost("left");
    fireTouch(el, "touchstart", [touch(100, 100)]);
    // 纵向主导：dx=4, dy=140 → 不锁定、不 preventDefault
    const evVert = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(evVert, "touches", { value: [touch(104, 240)] });
    const vertSpy = vi.spyOn(evVert, "preventDefault");
    el.dispatchEvent(evVert);
    expect(vertSpy).not.toHaveBeenCalled();
    expect(swipe.shift.value).toBe(0);
    // 横向锁定：dx=-90, dy=30 → 接管 + preventDefault + 跟手
    const evHor = new Event("touchmove", { bubbles: true, cancelable: true });
    Object.defineProperty(evHor, "touches", { value: [touch(10, 130)] });
    const horSpy = vi.spyOn(evHor, "preventDefault");
    el.dispatchEvent(evHor);
    expect(horSpy).toHaveBeenCalled();
    expect(swipe.shift.value).toBeLessThan(0);
    fireTouch(el, "touchend", [], [touch(10, 130)]);
    expect(onTrigger).toHaveBeenCalledWith("left");
    host.remove();
  });

  it("direction:right：左划被放弃（不跟手、不触发）", () => {
    const { host, el, onTrigger, swipe } = mountHost("right");
    fireTouch(el, "touchstart", [touch(200, 200)]);
    fireTouch(el, "touchmove", [touch(120, 200)]); // dx=-80 左划 → 方向不符放弃
    fireTouch(el, "touchend", [], [touch(120, 200)]);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(swipe.shift.value).toBe(0);
    host.remove();
  });

  it("未达阈值 → 回弹归零不触发", () => {
    const { host, el, onTrigger, swipe } = mountHost("both");
    fireTouch(el, "touchstart", [touch(200, 200)]);
    fireTouch(el, "touchmove", [touch(170, 200)]); // dx=-30
    fireTouch(el, "touchend", [], [touch(170, 200)]);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(swipe.shift.value).toBe(0);
    host.remove();
  });

  it("excludeEdgeZone：左缘起点不横向接管（让位页面边缘返回）", () => {
    const { host, el, onTrigger, swipe } = mountHost("both", { excludeEdgeZone: true });
    fireTouch(el, "touchstart", [touch(8, 200)]); // 起点在左缘 24px 内
    fireTouch(el, "touchmove", [touch(100, 200)]);
    fireTouch(el, "touchend", [], [touch(100, 200)]);
    expect(onTrigger).not.toHaveBeenCalled();
    expect(swipe.shift.value).toBe(0);
    host.remove();
  });
});
