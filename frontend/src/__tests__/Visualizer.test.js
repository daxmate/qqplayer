// Visualizer 组件测试（频谱可视化）
// 覆盖：渲染/降级（无 AudioContext 静默）、开关隐藏、播放态 rAF 绘制不抛错
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const Visualizer = (await import("../components/Visualizer.vue")).default;
const { state, playbackSettings, _resetEqGraph } = await import("../composables/usePlayer.js");
const { _resetVisualizer } = await import("../composables/useVisualizer.js");

// jsdom 无 canvas 2d 实现 → stub 一个假 2d context（并让绘制路径真实执行）
let fakeCtx = null;
function fakeCtx2d() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
  };
}

beforeEach(() => {
  _resetEqGraph();
  _resetVisualizer();
  playbackSettings.visualizerEnabled = true;
  state.isPlaying = false;
  fakeCtx = fakeCtx2d();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountViz(props = {}) {
  return mount(Visualizer, { props });
}

describe("Visualizer 渲染", () => {
  it("默认渲染 canvas（无 AudioContext 静默降级，不抛错）", () => {
    // 不 stub AudioContext：jsdom 无 → ensureAnalyser 返回 null → 画平线
    const w = mountViz();
    expect(w.find('[data-testid="viz-canvas"]').exists()).toBe(true);
    expect(w.find('[data-testid="visualizer"]').isVisible()).toBe(true);
    // 挂载即画一帧（平线）
    expect(fakeCtx.fillRect).toHaveBeenCalled();
    w.unmount();
  });

  it("开关关闭 → v-show 隐藏画布", async () => {
    const w = mountViz();
    // 注：jsdom 的 getComputedStyle 有缓存 bug——先查 visible 再改 inline style 会读到旧值，
    // 所以隐藏断言直接查 v-show 实际写入的 inline style（比 isVisible 更贴近实现）
    playbackSettings.visualizerEnabled = false;
    await nextTick();
    const root = w.find('[data-testid="visualizer"]');
    expect(root.element.style.display).toBe("none");
    expect(root.element.style.display).not.toBe("");
    w.unmount();
  });

  it("重新开启后 v-show 恢复显示", async () => {
    const w = mountViz();
    playbackSettings.visualizerEnabled = false;
    await nextTick();
    playbackSettings.visualizerEnabled = true;
    await nextTick();
    const root = w.find('[data-testid="visualizer"]');
    expect(root.element.style.display).not.toBe("none");
    expect(root.isVisible()).toBe(true);
    w.unmount();
  });

  it("播放中启动 rAF 绘制，暂停停掉；全程不抛错", async () => {
    const w = mountViz();
    const drawsBefore = fakeCtx.fillRect.mock.calls.length;
    state.isPlaying = true;
    await nextTick();
    // 等一帧 rAF（jsdom 有 rAF）
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.fillRect.mock.calls.length).toBeGreaterThan(drawsBefore);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("small 模式同样渲染（移动端）", () => {
    const w = mountViz({ small: true });
    expect(w.find('[data-testid="viz-canvas"]').exists()).toBe(true);
    expect(w.find(".visualizer.small").exists()).toBe(true);
    w.unmount();
  });
});
