// ControlBar 移动端跟唱折叠测试
// 覆盖：karaoke + collapsible 时——下滑手势收起（保留项仍在/隐藏项消失/根 class collapsed）、
//       上滑展开恢复、位移不足 30px 不触发、横向主导（进度条拖动）不触发、
//       带水平漂移的垂直下滑仍触发、信息按钮气泡出现/点气泡展开、
//       collapsible 默认 false（桌面）手势完全不生效。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const ControlBar = (await import("../components/ControlBar.vue")).default;
const { state } = await import("../composables/usePlayer.js");

// jsdom 无 TouchEvent，用原生 Event + 手写 touches/changedTouches 模拟
type TouchLike = { clientX: number; clientY: number };
function fireTouch(el: Element, type: string, touches?: TouchLike[], changedTouches?: TouchLike[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  if (touches) Object.defineProperty(ev, "touches", { value: touches, configurable: true });
  if (changedTouches)
    Object.defineProperty(ev, "changedTouches", { value: changedTouches, configurable: true });
  el.dispatchEvent(ev);
  return ev;
}

const t = (x: number, y: number): TouchLike => ({ clientX: x, clientY: y });

// 在根元素上模拟一次手势：from → to（起点/终点）
function swipe(el: Element, from: TouchLike, to: TouchLike) {
  fireTouch(el, "touchstart", [from]);
  fireTouch(el, "touchend", [], [to]);
}

function btnByTitle(w: ReturnType<typeof mount>, title: string) {
  return w.findAll(".btn").find((b) => b.attributes("title") === title);
}

// 循环按钮（单句/AB）：title 是动态提示（karaoke.abHint/abSet），用包含匹配
function loopBtn(w: ReturnType<typeof mount>) {
  return w.findAll(".btn").find((b) => (b.attributes("title") || "").includes("单句循环"));
}

// 曲库网络歌 currentSong（下载按钮可见性前提）
const STREAM_SONG = {
  type: "stream",
  streamId: "777",
  provider: "netease",
  path: null,
  name: "稻香",
  artist: "周杰伦",
};

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    mode: "continuous",
    playMode: "order",
    karaokeOn: true,
    karaokeLoop: false,
    abLoop: null,
    speed: 1.0,
    zhVisible: false,
    volume: 1.0,
    muted: false,
    lyricFormat: null,
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.querySelectorAll(".modal-mask, .url-mask").forEach((n) => n.remove());
});

describe("ControlBar 折叠（karaoke + collapsible）", () => {
  it("默认展开态：全部按钮可见（隐藏项与保留项都在）", () => {
    state.currentSong = { ...STREAM_SONG };
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    expect(w.find(".controls.collapsible").exists()).toBe(true);
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    // 保留项
    expect(w.find(".progress-row").exists()).toBe(true);
    expect(btnByTitle(w, "播放/暂停")).toBeTruthy();
    expect(btnByTitle(w, "变速")).toBeTruthy();
    expect(btnByTitle(w, "退出跟唱")).toBeTruthy();
    expect(loopBtn(w)).toBeTruthy();
    // 隐藏项（展开时可见）
    expect(btnByTitle(w, "上一首")).toBeTruthy();
    expect(btnByTitle(w, "返回音乐")).toBeTruthy();
    expect(btnByTitle(w, "上一句")).toBeTruthy();
    expect(btnByTitle(w, "下一句")).toBeTruthy();
    expect(btnByTitle(w, "播放 URL")).toBeTruthy();
    expect(w.find('[data-testid="download-btn"]').exists()).toBe(true);
    expect(btnByTitle(w, "显示/隐藏中文")).toBeTruthy();
    expect(w.find(".vol-group").exists()).toBe(true);
    expect(w.find(".song-line").exists()).toBe(true);
    // 收起态专属元素不存在
    expect(w.find(".ctrl-info-btn").exists()).toBe(false);
    expect(w.find(".ctrl-tip").exists()).toBe(false);
    w.unmount();
  });

  it("下滑手势（|dy|≥30 垂直主导）→ 收起：隐藏项消失、保留项仍在、根 class 含 collapsed", async () => {
    state.currentSong = { ...STREAM_SONG };
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(100, 50), t(100, 130)); // dy=+80 → 下滑
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(true);
    // 隐藏项
    expect(btnByTitle(w, "上一首")).toBeFalsy();
    expect(btnByTitle(w, "返回音乐")).toBeFalsy();
    expect(btnByTitle(w, "上一句")).toBeFalsy();
    expect(btnByTitle(w, "下一句")).toBeFalsy();
    expect(btnByTitle(w, "播放 URL")).toBeFalsy();
    expect(w.find('[data-testid="download-btn"]').exists()).toBe(false);
    expect(btnByTitle(w, "显示/隐藏中文")).toBeFalsy();
    expect(w.find(".vol-group").exists()).toBe(false);
    expect(w.find(".song-line").exists()).toBe(false);
    // 保留项
    expect(w.find(".progress-row").exists()).toBe(true);
    expect(btnByTitle(w, "播放/暂停")).toBeTruthy();
    expect(btnByTitle(w, "变速")).toBeTruthy();
    expect(btnByTitle(w, "退出跟唱")).toBeTruthy();
    expect(loopBtn(w)).toBeTruthy();
    // 收起态信息按钮出现
    expect(w.find(".ctrl-info-btn").exists()).toBe(true);
    w.unmount();
  });

  it("上滑手势 → 展开恢复（隐藏项重新出现）", async () => {
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(100, 50), t(100, 130)); // 下滑收起
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(true);
    swipe(w.element, t(100, 130), t(100, 50)); // 上滑展开（dy=-80）
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    expect(btnByTitle(w, "上一首")).toBeTruthy();
    expect(btnByTitle(w, "返回音乐")).toBeTruthy();
    expect(btnByTitle(w, "上一句")).toBeTruthy();
    expect(btnByTitle(w, "下一句")).toBeTruthy();
    expect(w.find(".song-line").exists()).toBe(true);
    expect(w.find(".ctrl-info-btn").exists()).toBe(false);
    w.unmount();
  });

  it("位移不足 30px（视为点击）→ 不收起", async () => {
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(100, 50), t(100, 72)); // dy=+22 < 30
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    w.unmount();
  });

  it("横向主导（|dy| ≤ |dx|*1.2，进度条拖动场景）→ 不收起", async () => {
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(50, 100), t(200, 130)); // dx=+150, dy=+30（dx*1.2=180 ≥ dy）
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    w.unmount();
  });

  it("带水平漂移的垂直下滑（dy=60, dx=30）→ 仍收起", async () => {
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(50, 100), t(80, 160)); // dy=+60, dx=+30（dx*1.2=36 < 60）
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(true);
    w.unmount();
  });

  it("收起后上滑展开：AB/单句循环按钮也恢复可用", async () => {
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(100, 50), t(100, 130));
    await nextTick();
    // 收起态：循环按钮保留（title 为 karaoke.abHint，含「单句循环」）
    expect(loopBtn(w)).toBeTruthy();
    swipe(w.element, t(100, 130), t(100, 50));
    await nextTick();
    expect(loopBtn(w)).toBeTruthy();
    w.unmount();
  });

  it("点击信息按钮 → 气泡出现（文本为提示语）；点击气泡 → 展开", async () => {
    const w = mount(ControlBar, { props: { karaoke: true, collapsible: true } });
    swipe(w.element, t(100, 50), t(100, 130)); // 先收起
    await nextTick();
    const info = w.find(".ctrl-info-btn");
    expect(info.exists()).toBe(true);
    await info.trigger("click");
    await nextTick();
    const tip = w.find(".ctrl-tip");
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain("控制区已收起");
    await tip.trigger("click"); // 点气泡 → 展开
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    expect(w.find(".ctrl-tip").exists()).toBe(false);
    w.unmount();
  });

  it("collapsible 默认 false（桌面不传）→ 手势完全不生效，行为零变化", async () => {
    const w = mount(ControlBar); // 不传 collapsible
    expect(w.find(".controls.collapsible").exists()).toBe(false);
    swipe(w.element, t(100, 50), t(100, 130));
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    expect(btnByTitle(w, "上一首")).toBeTruthy();
    expect(w.find(".song-line").exists()).toBe(true);
    expect(w.find(".ctrl-info-btn").exists()).toBe(false);
    w.unmount();
  });

  it("karaoke 非 collapsible（如桌面全屏）→ 手势不生效", async () => {
    const w = mount(ControlBar, { props: { karaoke: true } });
    swipe(w.element, t(100, 50), t(100, 130));
    await nextTick();
    expect(w.find(".controls.collapsed").exists()).toBe(false);
    expect(btnByTitle(w, "返回音乐")).toBeTruthy();
    w.unmount();
  });
});
