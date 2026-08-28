// KaraokePanel 移动端跟唱：顶部信息按钮常驻
// 覆盖：showInfoBtn=false 不显示（桌面不受影响）；常驻显示；
//       展开态 → 气泡提示「下滑可收起」→ 点气泡 emit collapse-controls；
//       收起态 → 气泡提示「上滑展开」→ 点气泡 emit expand-controls；
//       showInfoBtn 由 false → true 联动出现。
// 注：底部 ControlBar 的折叠手势/受控 collapsed 见 ControlBar.collapse.test.ts
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

// 滚动引擎 mock（KaraokePanel 依赖 DOM 滚动，单测聚焦信息按钮）
vi.mock("../composables/useLyricScroll.js", () => ({
  useLyricScroll: () => ({ scrollTo: vi.fn() }),
}));

const KaraokePanel = (await import("../components/KaraokePanel.vue")).default;
const { state } = await import("../composables/usePlayer.js");

beforeEach(() => {
  Object.assign(state, {
    currentSong: null,
    mode: "karaoke",
    karaokeOn: true,
    zhVisible: true,
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
});

describe("KaraokePanel 顶部信息按钮（showInfoBtn 常驻）", () => {
  it("showInfoBtn 默认 false：无信息按钮（桌面/非跟唱不受影响）", () => {
    const w = mount(KaraokePanel, { props: { lyric: [] } });
    expect(w.find(".kp-info-btn").exists()).toBe(false);
    expect(w.find(".kp-tip").exists()).toBe(false);
    w.unmount();
  });

  it("showInfoBtn=true（展开态）：按钮常驻；点开气泡提示「下滑可收起」；点气泡 emit collapse-controls", async () => {
    const w = mount(KaraokePanel, {
      props: { lyric: [], showInfoBtn: true, controlsCollapsed: false },
    });
    const info = w.find(".kp-info-btn");
    expect(info.exists()).toBe(true);
    expect(info.attributes("title")).toContain("下滑");
    await info.trigger("click");
    await nextTick();
    const tip = w.find(".kp-tip");
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain("下滑可收起");
    await tip.trigger("click");
    await nextTick();
    expect(w.emitted("collapse-controls")).toBeTruthy();
    expect(w.emitted("expand-controls")).toBeFalsy();
    expect(w.find(".kp-tip").exists()).toBe(false);
    w.unmount();
  });

  it("收起态（controlsCollapsed=true）：气泡提示「上滑展开」；点气泡 emit expand-controls", async () => {
    const w = mount(KaraokePanel, {
      props: { lyric: [], showInfoBtn: true, controlsCollapsed: true },
    });
    const info = w.find(".kp-info-btn");
    expect(info.exists()).toBe(true);
    expect(info.attributes("title")).toContain("展开");
    await info.trigger("click");
    await nextTick();
    const tip = w.find(".kp-tip");
    expect(tip.exists()).toBe(true);
    expect(tip.text()).toContain("控制区已收起");
    await tip.trigger("click");
    await nextTick();
    expect(w.emitted("expand-controls")).toBeTruthy();
    w.unmount();
  });

  it("controlsCollapsed 0→1：气泡文案切换为展开提示（联动收起态）", async () => {
    const w = mount(KaraokePanel, {
      props: { lyric: [], showInfoBtn: true, controlsCollapsed: false },
    });
    await w.setProps({ controlsCollapsed: true });
    await nextTick();
    const info = w.find(".kp-info-btn");
    expect(info.attributes("title")).toContain("展开");
    await info.trigger("click");
    await nextTick();
    expect(w.find(".kp-tip").text()).toContain("控制区已收起");
    w.unmount();
  });

  it("showInfoBtn 由 false → true：信息按钮出现（移动端跟唱进入）", async () => {
    const w = mount(KaraokePanel, { props: { lyric: [], showInfoBtn: false } });
    expect(w.find(".kp-info-btn").exists()).toBe(false);
    await w.setProps({ showInfoBtn: true });
    await nextTick();
    expect(w.find(".kp-info-btn").exists()).toBe(true);
    w.unmount();
  });

  it("气泡再点信息按钮可收起（tipOpen 切换）", async () => {
    const w = mount(KaraokePanel, {
      props: { lyric: [], showInfoBtn: true, controlsCollapsed: true },
    });
    const info = w.find(".kp-info-btn");
    await info.trigger("click");
    await nextTick();
    expect(w.find(".kp-tip").exists()).toBe(true);
    await info.trigger("click"); // 再点 → 关闭
    await nextTick();
    expect(w.find(".kp-tip").exists()).toBe(false);
    w.unmount();
  });
});
