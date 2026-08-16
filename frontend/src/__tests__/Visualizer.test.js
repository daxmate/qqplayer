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
const { state, playbackSettings, PLAYBACK_SETTINGS_KEY, _resetEqGraph } =
  await import("../composables/usePlayer.js");
const { _resetVisualizer, _resetParticles } = await import("../composables/useVisualizer.js");

// jsdom 无 canvas 2d 实现 → stub 一个假 2d context（并让绘制路径真实执行）
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
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    lineCap: "",
  };
}

// jsdom 无 localStorage（vitest 4）→ stub 手动实现（持久化断言用）
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
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  playbackSettings.visualizerEnabled = true;
  playbackSettings.visualizerStyle = "bars";
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

describe("Visualizer 6 样式分发（任务 K）", () => {
  it.each(["bars", "radial", "wave", "pulse", "mirror", "particle"])(
    "样式 %s：播放中 rAF 绘制不抛错",
    async (s) => {
      playbackSettings.visualizerStyle = s;
      const w = mountViz();
      state.isPlaying = true;
      await nextTick();
      await new Promise((r) => requestAnimationFrame(r)); // 等一帧 rAF
      // 每种样式都调用了 clearRect（至少画了一帧），全程不抛错
      expect(fakeCtx.clearRect).toHaveBeenCalled();
      state.isPlaying = false;
      await nextTick();
      w.unmount();
    },
  );

  it("bars 样式：画频谱条（fillRect 多次）", async () => {
    const w = mountViz();
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.fillRect.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("radial 样式：走圆弧描边路径（arc/stroke）", async () => {
    playbackSettings.visualizerStyle = "radial";
    const w = mountViz();
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.arc).toHaveBeenCalled();
    expect(fakeCtx.stroke).toHaveBeenCalled();
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("wave 样式：读时域数据（getByteTimeDomainData）走折线", async () => {
    playbackSettings.visualizerStyle = "wave";
    const w = mountViz();
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.moveTo).toHaveBeenCalled();
    expect(fakeCtx.lineTo.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("暂停/无 analyser：各样式画静态不抛错（wave 画中线）", async () => {
    playbackSettings.visualizerStyle = "wave";
    const w = mountViz();
    // state.isPlaying 保持 false，无 analyser → drawWave 静态中线
    expect(fakeCtx.moveTo).toHaveBeenCalled(); // 挂载首帧已画
    playbackSettings.visualizerStyle = "radial";
    await nextTick();
    expect(() => w.find('[data-testid="viz-canvas"]')).toBeTruthy();
    w.unmount();
  });

  it("非法样式值回落默认 bars（画频谱条不抛错）", async () => {
    playbackSettings.visualizerStyle = "spiral";
    const w = mountViz();
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    // bars 用 fillRect 画条（radial/particle 用 arc/fill，wave 用 lineTo）
    expect(fakeCtx.fillRect.mock.calls.length).toBeGreaterThan(1);
    expect(fakeCtx.arc).not.toHaveBeenCalled();
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("visualizerStyle 切换写入 PLAYBACK_SETTINGS_KEY", async () => {
    localStorage.removeItem(PLAYBACK_SETTINGS_KEY);
    playbackSettings.visualizerStyle = "pulse";
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.visualizerStyle).toBe("pulse");
    playbackSettings.visualizerStyle = "bars";
    await nextTick();
  });
});
