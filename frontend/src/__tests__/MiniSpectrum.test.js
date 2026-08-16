// MiniSpectrum 组件测试（任务 C：ControlBar 迷你频谱条）
// 覆盖：渲染/开关（总开关 + 子开关）、播放态 rAF 绘制、6 样式分发不抛错
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

const MiniSpectrum = (await import("../components/MiniSpectrum.vue")).default;
const { state, playbackSettings, _resetEqGraph } = await import("../composables/usePlayer.js");
const { _resetVisualizer, _resetParticles, _resetPeaks } =
  await import("../composables/useVisualizer.js");

let fakeCtx = null;
function fakeCtx2d() {
  return {
    clearRect: vi.fn(),
    fillRect: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    beginPath: vi.fn(),
    closePath: vi.fn(),
    arc: vi.fn(),
    roundRect: vi.fn(),
    quadraticCurveTo: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "",
    lineJoin: "",
    shadowBlur: 0,
    shadowColor: "",
  };
}

const lsStore = {};
const localStorageStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => {
    lsStore[k] = String(v);
  },
  removeItem: (k) => {
    delete lsStore[k];
  },
};

beforeEach(() => {
  _resetEqGraph();
  _resetVisualizer();
  _resetParticles();
  _resetPeaks();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  playbackSettings.visualizerEnabled = true;
  playbackSettings.miniSpectrumEnabled = true;
  playbackSettings.visualizerStyle = "bars";
  state.isPlaying = false;
  fakeCtx = fakeCtx2d();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(fakeCtx);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("MiniSpectrum 渲染与开关", () => {
  it("默认渲染 canvas（无 AudioContext 静默降级，不抛错）", () => {
    const w = mount(MiniSpectrum);
    expect(w.find('[data-testid="ms-canvas"]').exists()).toBe(true);
    expect(w.find('[data-testid="mini-spectrum"]').isVisible()).toBe(true);
    w.unmount();
  });

  it("总开关关闭 → v-show 隐藏", async () => {
    const w = mount(MiniSpectrum);
    playbackSettings.visualizerEnabled = false;
    await nextTick();
    const root = w.find('[data-testid="mini-spectrum"]');
    expect(root.element.style.display).toBe("none");
    w.unmount();
  });

  it("迷你频谱子开关关闭 → v-show 隐藏（总开关仍开）", async () => {
    const w = mount(MiniSpectrum);
    playbackSettings.miniSpectrumEnabled = false;
    await nextTick();
    const root = w.find('[data-testid="mini-spectrum"]');
    expect(root.element.style.display).toBe("none");
    w.unmount();
  });

  it("重新开启后恢复显示", async () => {
    const w = mount(MiniSpectrum);
    playbackSettings.miniSpectrumEnabled = false;
    await nextTick();
    playbackSettings.miniSpectrumEnabled = true;
    await nextTick();
    const root = w.find('[data-testid="mini-spectrum"]');
    expect(root.element.style.display).not.toBe("none");
    w.unmount();
  });
});

describe("MiniSpectrum 绘制", () => {
  it("播放中启动 rAF 绘制（bars → 圆角频谱条），暂停停掉；不抛错", async () => {
    const w = mount(MiniSpectrum);
    const before = fakeCtx.clearRect.mock.calls.length;
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.clearRect.mock.calls.length).toBeGreaterThan(before);
    expect(fakeCtx.roundRect.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it.each(["bars", "radial", "wave", "pulse", "mirror", "particle"])(
    "样式 %s：播放中绘制不抛错",
    async (s) => {
      playbackSettings.visualizerStyle = s;
      const w = mount(MiniSpectrum);
      state.isPlaying = true;
      await nextTick();
      await new Promise((r) => requestAnimationFrame(r));
      expect(fakeCtx.clearRect).toHaveBeenCalled();
      state.isPlaying = false;
      await nextTick();
      w.unmount();
    },
  );

  it("暂停/无 analyser：各样式画静态不抛错", () => {
    playbackSettings.visualizerStyle = "wave";
    const w = mount(MiniSpectrum);
    expect(fakeCtx.moveTo).toHaveBeenCalled(); // 挂载首帧静态正弦
    w.unmount();
  });

  it("非法样式回落默认 bars", async () => {
    playbackSettings.visualizerStyle = "spiral";
    const w = mount(MiniSpectrum);
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.roundRect.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });
});
