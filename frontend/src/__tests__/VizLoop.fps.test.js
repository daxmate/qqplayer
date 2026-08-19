// useVizLoop 帧率差异化测试（任务：MiniSpectrum 波形 30→15fps，仅浏览器）
/* global process */ // CSS 冒烟用 node fs 读文件，eslint no-undef 豁免
// 覆盖：
//   - useVizLoop 浏览器分支：默认 30fps 节流 / frameMs 可降频（15fps）/ 暂停停 rAF
//   - useVizLoop 壳分支：忽略 frameMs 永远满帧（壳零变化硬约束）
//   - MiniSpectrum 传参：frameMs = 1000/15（spy 包真实实现，原有绘制行为仍被真实执行）
//   - style.css 浏览器降级 CSS 冒烟（html.browser-degraded 全局禁用 backdrop-filter + 补色规则）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { ref } from "vue";

// spy 包真实实现：单元测试直接用真实循环逻辑；MiniSpectrum 挂载也走真实实现，仅额外断言传参
vi.mock("../composables/useVizLoop.js", async (importOriginal) => {
  const mod = await importOriginal();
  return { ...mod, useVizLoop: vi.fn(mod.useVizLoop) };
});

const { useVizLoop } = await import("../composables/useVizLoop.js");
// CSS 冒烟用 fs 直接读文件（vitest/rolldown 下 `?raw` 对 .css 返回空串；import.meta.url 非 file 协议）
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
const cssRaw = readFileSync(resolve(process.cwd(), "src/style.css"), "utf8");

// MiniSpectrum 挂载 harness（Audio stub 必须在 import usePlayer 前注册，与 MiniSpectrum.test.js 一致）
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

/** 手动驱动 rAF 的 mock：capture 排队回调，测试用 step(ts) 喂时间戳 */
function installRafMock() {
  let pending = null;
  let seq = 0;
  const raf = vi.fn((cb) => {
    pending = { cb, id: ++seq };
    return pending.id;
  });
  const caf = vi.fn((id) => {
    if (pending && pending.id === id) pending = null;
  });
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  return {
    raf,
    caf,
    hasPending: () => !!pending,
    step(ts) {
      const p = pending;
      pending = null;
      if (p) p.cb(ts);
      return !!p;
    },
  };
}

beforeEach(() => {
  useVizLoop.mockClear();
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useVizLoop 浏览器分支帧率", () => {
  it("默认 30fps 节流（无 frameMs 参数，Visualizer 大背景路径）", () => {
    const r = installRafMock();
    const paint = vi.fn();
    const loop = useVizLoop({ paint, isEnabled: () => true, isPlaying: () => true });
    expect(r.hasPending()).toBe(true);
    r.step(0); // 首帧立即画
    expect(paint).toHaveBeenCalledTimes(1);
    r.step(30); // 30ms < 33.3ms → 跳过
    expect(paint).toHaveBeenCalledTimes(1);
    r.step(40); // 40ms ≥ 33.3ms → 画
    expect(paint).toHaveBeenCalledTimes(2);
    loop.dispose();
    expect(r.hasPending()).toBe(false);
  });

  it("frameMs=1000/15 → 15fps 节流（MiniSpectrum 路径）", () => {
    const r = installRafMock();
    const paint = vi.fn();
    const loop = useVizLoop({
      paint,
      isEnabled: () => true,
      isPlaying: () => true,
      frameMs: 1000 / 15,
    });
    r.step(0); // 首帧立即画
    expect(paint).toHaveBeenCalledTimes(1);
    r.step(50); // 50ms < 66.7ms → 跳过
    expect(paint).toHaveBeenCalledTimes(1);
    r.step(70); // 70ms ≥ 66.7ms → 画
    expect(paint).toHaveBeenCalledTimes(2);
    loop.dispose();
  });

  it("浏览器暂停 → 停 rAF（不再排队）", () => {
    const r = installRafMock();
    const paint = vi.fn();
    const playing = ref(true); // watch 依赖必须响应式（普通变量不触发）
    const loop = useVizLoop({ paint, isEnabled: () => true, isPlaying: () => playing.value });
    r.step(0);
    expect(r.hasPending()).toBe(true);
    playing.value = false; // flush:sync 监听立即收敛 → stop
    expect(r.hasPending()).toBe(false);
    expect(r.caf).toHaveBeenCalled();
    loop.dispose();
  });
});

describe("useVizLoop 壳分支（零变化硬约束）", () => {
  it("壳内忽略 frameMs：即使传 1000/15 也满帧（每帧都画）", () => {
    vi.stubGlobal("qqplayerNative", {});
    const r = installRafMock();
    const paint = vi.fn();
    // 壳内 isPlaying=false 也照常跑（暂停呼吸动画），且 frameMs 参数无效
    const loop = useVizLoop({
      paint,
      isEnabled: () => true,
      isPlaying: () => false,
      frameMs: 1000 / 15,
    });
    expect(r.hasPending()).toBe(true);
    r.step(0);
    r.step(1);
    r.step(2);
    expect(paint).toHaveBeenCalledTimes(3); // 每帧都画，无节流
    loop.dispose();
  });
});

describe("MiniSpectrum 传参", () => {
  it("调用 useVizLoop 时传 frameMs = 1000/15（浏览器 15fps），且仍走真实循环绘制", async () => {
    const w = mount(MiniSpectrum);
    expect(useVizLoop).toHaveBeenCalledWith(expect.objectContaining({ frameMs: 1000 / 15 }));
    // 真实实现仍生效：播放中首帧绘制
    const before = fakeCtx.clearRect.mock.calls.length;
    state.isPlaying = true;
    await new Promise((r) => requestAnimationFrame(r));
    expect(fakeCtx.clearRect.mock.calls.length).toBeGreaterThan(before);
    state.isPlaying = false;
    w.unmount();
  });
});

describe("style.css 浏览器降级冒烟", () => {
  it("含全局 backdrop-filter 禁用规则（!important 压过 scoped 组件）", () => {
    expect(cssRaw).toContain("html.browser-degraded *");
    expect(cssRaw).toContain("backdrop-filter: none !important");
    expect(cssRaw).toContain("-webkit-backdrop-filter: none !important");
  });

  it("含持续可见区域补色规则（主面板/歌词/侧栏/搜索层/下拉）", () => {
    expect(cssRaw).toContain('html.browser-degraded[data-blur="true"] .panel');
    expect(cssRaw).toContain('html.browser-degraded[data-blur="true"] .lyric-panel');
    expect(cssRaw).toContain('html.browser-degraded[data-blur="true"] .karaoke-panel');
    expect(cssRaw).toContain('html.browser-degraded[data-blur="true"] .sidebar');
    expect(cssRaw).toContain('html.browser-degraded[data-blur="true"] .playlist');
    expect(cssRaw).toContain("html.browser-degraded .sa-mask");
    expect(cssRaw).toContain("html.browser-degraded .os-panel");
  });
});
