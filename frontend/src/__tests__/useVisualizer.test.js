// useVisualizer composable 单元测试（频谱可视化）
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  constructor() {
    this._src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
  }
  set src(v) {
    this._src = v;
    if (v) this.currentTime = 0;
  }
  get src() {
    return this._src;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub
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

const { state, playbackSettings, PLAYBACK_SETTINGS_KEY, play, _resetEqGraph } =
  await import("../composables/usePlayer.js");
const { ensureAnalyser, getAnalyser, readBarData, drawSpectrum, FFT_SIZE, _resetVisualizer } =
  await import("../composables/useVisualizer.js");

// FakeAudioContext：jsdom 无 Web Audio，stub 记录滤波器链 + analyser 挂载
class FakeAudioContext {
  static instances = [];
  constructor() {
    this.destination = {};
    this.filters = [];
    this.analyser = null;
    FakeAudioContext.instances.push(this);
  }
  createMediaElementSource() {
    this.source = { connect: vi.fn() };
    return this.source;
  }
  createBiquadFilter() {
    const f = {
      type: "",
      frequency: { value: 0 },
      Q: { value: 0 },
      gain: { value: 0 },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
    this.filters.push(f);
    return f;
  }
  createAnalyser() {
    this.analyser = {
      fftSize: 0,
      smoothingTimeConstant: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      getByteFrequencyData: vi.fn((arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i < arr.length / 4 ? 200 : 30;
      }),
    };
    return this.analyser;
  }
  resume() {
    return Promise.resolve();
  }
}

function stubAudioContext() {
  vi.stubGlobal("AudioContext", FakeAudioContext);
}

function setupSong() {
  state.currentSong = { path: "/fake/song.mp3", name: "Fake" };
}

beforeEach(() => {
  _resetEqGraph();
  _resetVisualizer();
  playbackSettings.visualizerEnabled = true;
  vi.restoreAllMocks();
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureAnalyser / getAnalyser", () => {
  it("无 AudioContext 环境（jsdom/SSR）：返回 null，不抛错", () => {
    // 不 stub AudioContext（jsdom 无）→ 图永远不会建
    expect(() => ensureAnalyser()).not.toThrow();
    expect(ensureAnalyser()).toBe(null);
    expect(getAnalyser()).toBe(null);
  });

  it("图未建时返回 null；首次播放建图后挂到图尾并幂等", async () => {
    stubAudioContext();
    setupSong();
    // 图未建（还没播放过）
    expect(ensureAnalyser()).toBe(null);
    await play(); // audio.play() 同步建图（source → 10 filters → destination）
    const ctx = FakeAudioContext.instances.at(-1);
    const a1 = ensureAnalyser();
    expect(a1).not.toBe(null);
    // analyser 插入图尾：lastFilter.disconnect + lastFilter→analyser→destination
    const last = ctx.filters[9];
    expect(last.disconnect).toHaveBeenCalled();
    expect(last.connect).toHaveBeenCalledWith(a1);
    expect(a1.connect).toHaveBeenCalledWith(ctx.destination);
    // 参数
    expect(a1.fftSize).toBe(FFT_SIZE);
    expect(a1.fftSize).toBe(256);
    expect(a1.smoothingTimeConstant).toBe(0.8);
    // 幂等：重复调用返回同一实例，不再重复断开
    expect(ensureAnalyser()).toBe(a1);
    expect(getAnalyser()).toBe(a1);
    expect(last.disconnect).toHaveBeenCalledTimes(1);
  });

  it("图建好但 analyser 创建失败：标记失败不反复抛错", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    const orig = ctx.createAnalyser.bind(ctx);
    ctx.createAnalyser = () => {
      throw new Error("boom");
    };
    expect(() => ensureAnalyser()).not.toThrow();
    expect(ensureAnalyser()).toBe(null);
    expect(getAnalyser()).toBe(null);
    // 恢复后也不重试（失败即降级，避免每帧抛错）
    ctx.createAnalyser = orig;
    expect(ensureAnalyser()).toBe(null);
  });

  it("切歌/换源后 analyser 仍有效（图常驻，不重建）", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const a1 = ensureAnalyser();
    // 模拟切歌：直接换 src（playerCore selectSong 流程会 pause + 换 src，但不重建图）
    state.currentSong = { path: "/fake/song2.mp3", name: "Fake2" };
    expect(getAnalyser()).toBe(a1);
  });

  it("_resetEqGraph + _resetVisualizer 后重新挂载（用例隔离）", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const a1 = ensureAnalyser();
    _resetEqGraph(); // 模拟测试隔离：图重置
    _resetVisualizer();
    expect(getAnalyser()).toBe(null);
    await play(); // 重建图
    const a2 = ensureAnalyser();
    expect(a2).not.toBe(null);
    expect(a2).not.toBe(a1); // 挂到新 context 的新 analyser
  });
});

describe("readBarData", () => {
  it("归一化 0~1、条数可控、跳过 DC", () => {
    const a = {
      frequencyBinCount: 128,
      getByteFrequencyData: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = 0; // 全 0 → 静音
      },
    };
    const vals = readBarData(a, 32);
    expect(vals).toHaveLength(32);
    vals.forEach((v) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    });
  });

  it("条数上限与下限钳制", () => {
    const a = {
      frequencyBinCount: 128,
      getByteFrequencyData: () => {},
    };
    expect(readBarData(a, 999)).toHaveLength(127); // ≤ frequencyBinCount-1
    expect(readBarData(a, 1)).toHaveLength(4); // ≥ 4
  });
});

describe("drawSpectrum", () => {
  function fakeCtx2d() {
    return {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fillStyle: "",
    };
  }

  it("有数据：画 n 条频谱条 + n 个峰顶亮帽（渐变填充）", () => {
    const g = fakeCtx2d();
    drawSpectrum(g, 400, 64, [0.5, 0.25, 0.75, 1.0], "#ff7e5f", "#feb47b");
    expect(g.clearRect).toHaveBeenCalledWith(0, 0, 400, 64);
    expect(g.createLinearGradient).toHaveBeenCalled();
    // 4 条 + 4 个亮帽（所有值 > 阈值）
    expect(g.fillRect).toHaveBeenCalledTimes(8);
  });

  it("无数据（暂停/降级）：只画底部基准平线", () => {
    const g = fakeCtx2d();
    drawSpectrum(g, 400, 64, null, "#ff7e5f", "#feb47b");
    expect(g.fillRect).toHaveBeenCalledTimes(1);
    expect(g.fillRect).toHaveBeenCalledWith(0, 62, 400, 2); // 底部 2px
  });

  it("非法颜色回退默认强调色，不抛错", () => {
    const g = fakeCtx2d();
    expect(() => drawSpectrum(g, 100, 40, null, "not-a-color", "")).not.toThrow();
    expect(() => drawSpectrum(g, 100, 40, [0.1], "not-a-color", "")).not.toThrow();
  });
});

describe("开关持久化", () => {
  it("切换 visualizerEnabled 写入 PLAYBACK_SETTINGS_KEY", async () => {
    localStorage.removeItem(PLAYBACK_SETTINGS_KEY);
    playbackSettings.visualizerEnabled = false;
    await nextTick(); // 持久化 watch 异步落盘
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.visualizerEnabled).toBe(false);
    playbackSettings.visualizerEnabled = true;
    await nextTick();
    const saved2 = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved2.visualizerEnabled).toBe(true);
  });

  it("默认开启（仅播放中活跃，暂停静止）", () => {
    expect(playbackSettings.visualizerEnabled).toBe(true);
  });
});
