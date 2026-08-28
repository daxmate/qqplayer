// KaraokePanel 移动端跟唱折叠：顶部信息按钮（控制区收起时显示，点气泡 → 展开）
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

// 滚动引擎 mock（KaraokePanel 依赖 DOM 滚动，单测聚焦折叠信息按钮）
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

describe("KaraokePanel 折叠信息按钮（collapseHint）", () => {
  it("collapseHint 默认 false：无信息按钮（桌面/非跟唱不受影响）", () => {
    const w = mount(KaraokePanel, { props: { lyric: [] } });
    expect(w.find(".kp-info-btn").exists()).toBe(false);
    expect(w.find(".kp-tip").exists()).toBe(false);
    w.unmount();
  });

  it("collapseHint=true：显示信息按钮 → 点击出气泡（提示语）→ 点气泡 emit expand-controls 并关闭气泡", async () => {
    const w = mount(KaraokePanel, { props: { lyric: [], collapseHint: true } });
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
    expect(w.find(".kp-tip").exists()).toBe(false);
    w.unmount();
  });

  it("collapseHint 由 false → true：信息按钮出现（与收起态联动）", async () => {
    const w = mount(KaraokePanel, { props: { lyric: [], collapseHint: false } });
    expect(w.find(".kp-info-btn").exists()).toBe(false);
    await w.setProps({ collapseHint: true });
    await nextTick();
    expect(w.find(".kp-info-btn").exists()).toBe(true);
    w.unmount();
  });

  it("气泡再点信息按钮可收起（tipOpen 切换）", async () => {
    const w = mount(KaraokePanel, { props: { lyric: [], collapseHint: true } });
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
