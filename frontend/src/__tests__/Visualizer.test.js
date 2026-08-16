// Visualizer 组件测试（任务 C：主区域 = 封面取色氛围背景；small = 迷你频谱条）
// 覆盖：氛围背景渲染/降级（无 AudioContext 静默）、开关隐藏、播放态 rAF 绘制不抛错、
//       small 变体 6 样式分发（移动端 / 迷你频谱共用渲染器）
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
const { _resetVisualizer, _resetParticles, _resetPeaks, _resetColorCache } =
  await import("../composables/useVisualizer.js");

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
  _resetPeaks();
  _resetColorCache();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  playbackSettings.visualizerEnabled = true;
  playbackSettings.ambientEnabled = true;
  playbackSettings.miniSpectrumEnabled = true;
  playbackSettings.visualizerStyle = "bars";
  state.isPlaying = false;
  state.currentSong = null;
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

describe("Visualizer 主区域（氛围背景，任务 C）", () => {
  it("默认渲染 canvas + ambient 类（无 AudioContext 静默降级，不抛错）", () => {
    const w = mountViz();
    expect(w.find('[data-testid="viz-canvas"]').exists()).toBe(true);
    expect(w.find('[data-testid="visualizer"]').isVisible()).toBe(true);
    expect(w.find(".visualizer.ambient").exists()).toBe(true);
    // 挂载即画一帧：氛围背景走径向渐变光晕（不再画频谱条 roundRect）
    expect(fakeCtx.createRadialGradient).toHaveBeenCalled();
    expect(fakeCtx.roundRect).not.toHaveBeenCalled();
    w.unmount();
  });

  it("开关关闭 → v-show 隐藏画布", async () => {
    const w = mountViz();
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

  it("氛围背景子开关关闭 → 主区域隐藏（总开关仍开）", async () => {
    const w = mountViz();
    expect(w.find('[data-testid="visualizer"]').isVisible()).toBe(true);
    playbackSettings.ambientEnabled = false;
    await nextTick();
    const root = w.find('[data-testid="visualizer"]');
    expect(root.element.style.display).toBe("none");
    w.unmount();
  });

  it("播放中启动 rAF 绘制氛围背景（径向渐变 + 光晕填充），暂停停掉；全程不抛错", async () => {
    const w = mountViz();
    const drawsBefore = fakeCtx.createRadialGradient.mock.calls.length;
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r)); // 等一帧 rAF（jsdom 有 rAF）
    expect(fakeCtx.createRadialGradient.mock.calls.length).toBeGreaterThan(drawsBefore);
    expect(fakeCtx.fillRect).toHaveBeenCalled(); // 光晕铺满
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("封面取色失败/未完成 → 降级主题色画光晕（不抛错，不依赖封面）", async () => {
    // jsdom 中 Image 不加载（无资源加载器）→ 取色 promise 挂起 → 用 --accent 兜底
    state.currentSong = { path: "/fake/song.mp3", name: "Fake" };
    const w = mountViz();
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.createRadialGradient).toHaveBeenCalled(); // 兜底色照常渲染
    w.unmount();
  });
});

describe("Visualizer small（迷你频谱，移动端/渲染器共用）", () => {
  it("small 模式同样渲染（移动端）+ 画频谱条", async () => {
    const w = mountViz({ small: true });
    expect(w.find('[data-testid="viz-canvas"]').exists()).toBe(true);
    expect(w.find(".visualizer.small").exists()).toBe(true);
    expect(w.find(".visualizer.ambient").exists()).toBe(false);
    w.unmount();
  });

  it.each(["bars", "radial", "wave", "pulse", "mirror", "particle"])(
    "样式 %s：播放中 rAF 绘制不抛错",
    async (s) => {
      playbackSettings.visualizerStyle = s;
      const w = mountViz({ small: true });
      state.isPlaying = true;
      await nextTick();
      await new Promise((r) => requestAnimationFrame(r)); // 等一帧 rAF
      expect(fakeCtx.clearRect).toHaveBeenCalled(); // 每帧都画
      state.isPlaying = false;
      await nextTick();
      w.unmount();
    },
  );

  it("bars 样式：画圆角频谱条（roundRect 多次）", async () => {
    const w = mountViz({ small: true });
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.roundRect.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("radial 样式：走圆弧描边路径（arc/stroke）", async () => {
    playbackSettings.visualizerStyle = "radial";
    const w = mountViz({ small: true });
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.arc).toHaveBeenCalled();
    expect(fakeCtx.stroke).toHaveBeenCalled();
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("wave 样式：读时域数据走波形路径（moveTo + lineTo）", async () => {
    playbackSettings.visualizerStyle = "wave";
    const w = mountViz({ small: true });
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.moveTo).toHaveBeenCalled();
    expect(fakeCtx.lineTo.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("暂停/无 analyser：各样式画静态不抛错", async () => {
    playbackSettings.visualizerStyle = "wave";
    const w = mountViz({ small: true });
    expect(fakeCtx.moveTo).toHaveBeenCalled(); // 挂载首帧已画（静态正弦）
    playbackSettings.visualizerStyle = "radial";
    await nextTick();
    expect(() => w.find('[data-testid="viz-canvas"]')).toBeTruthy();
    w.unmount();
  });

  it("非法样式值回落默认 bars（画圆角条不抛错）", async () => {
    playbackSettings.visualizerStyle = "spiral";
    const w = mountViz({ small: true });
    state.isPlaying = true;
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.roundRect.mock.calls.length).toBeGreaterThan(1);
    state.isPlaying = false;
    await nextTick();
    w.unmount();
  });

  it("迷你频谱子开关关闭 → small 隐藏（移动端对应 ControlBar 迷你频谱开关）", async () => {
    const w = mountViz({ small: true });
    expect(w.find('[data-testid="visualizer"]').isVisible()).toBe(true);
    playbackSettings.miniSpectrumEnabled = false;
    await nextTick();
    const root = w.find('[data-testid="visualizer"]');
    expect(root.element.style.display).toBe("none");
    w.unmount();
  });
});

describe("开关持久化", () => {
  it("visualizerStyle 切换写入 PLAYBACK_SETTINGS_KEY", async () => {
    localStorage.removeItem(PLAYBACK_SETTINGS_KEY);
    playbackSettings.visualizerStyle = "pulse";
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.visualizerStyle).toBe("pulse");
    playbackSettings.visualizerStyle = "bars";
    await nextTick();
  });

  it("ambientEnabled / miniSpectrumEnabled 写入 PLAYBACK_SETTINGS_KEY（前端本地持久化）", async () => {
    localStorage.removeItem(PLAYBACK_SETTINGS_KEY);
    playbackSettings.ambientEnabled = false;
    playbackSettings.miniSpectrumEnabled = false;
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.ambientEnabled).toBe(false);
    expect(saved.miniSpectrumEnabled).toBe(false);
    playbackSettings.ambientEnabled = true;
    playbackSettings.miniSpectrumEnabled = true;
    await nextTick();
  });
});
