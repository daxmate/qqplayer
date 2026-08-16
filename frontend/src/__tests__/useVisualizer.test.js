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

const {
  state,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  play,
  loadPlaybackSettings,
  _resetEqGraph,
} = await import("../composables/usePlayer.js");
const {
  ensureAnalyser,
  getAnalyser,
  readBarData,
  readWaveData,
  drawSpectrum,
  drawRadial,
  drawWave,
  drawPulse,
  drawMirror,
  drawParticle,
  FFT_SIZE,
  _resetVisualizer,
  _resetParticles,
  _resetPeaks,
} = await import("../composables/useVisualizer.js");

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
  _resetPeaks();
  _resetParticles();
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
  // 完整 2d mock：记录绘制调用 + shadowBlur 峰值（断言发光）
  function fakeCtx2d() {
    const g = {
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      fill: vi.fn(),
      stroke: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
      arc: vi.fn(),
      roundRect: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      createRadialGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
      lineCap: "",
      lineJoin: "",
      shadowColor: "",
      _shadowMax: 0,
    };
    let sb = 0;
    Object.defineProperty(g, "shadowBlur", {
      get: () => sb,
      set: (v) => {
        sb = v;
        if (v > g._shadowMax) g._shadowMax = v;
      },
    });
    return g;
  }

  it("有数据：圆角频谱条 + 垂直渐变 + 发光 + 峰值保持亮帽", () => {
    const g = fakeCtx2d();
    drawSpectrum(g, 400, 64, [0.5, 0.25, 0.75, 1.0], "#ff7e5f", "#feb47b");
    expect(g.clearRect).toHaveBeenCalledWith(0, 0, 400, 64);
    expect(g.createLinearGradient).toHaveBeenCalled(); // 垂直渐变
    expect(g.roundRect.mock.calls.length).toBe(4); // 4 条圆角条
    expect(g.arc.mock.calls.length).toBe(4); // 4 个峰值亮帽
    expect(g.fill.mock.calls.length).toBe(5); // 1 条束填充 + 4 亮帽
    expect(g._shadowMax).toBeGreaterThan(0); // 发光（shadowBlur）
  });

  it("无数据（暂停/降级）：画设计感静态轮廓（圆角鼓包），不抛错", () => {
    const g = fakeCtx2d();
    drawSpectrum(g, 400, 64, null, "#ff7e5f", "#feb47b");
    expect(g.roundRect.mock.calls.length).toBeGreaterThan(0); // 高斯鼓包
    expect(g.fill).toHaveBeenCalled();
    expect(() => drawSpectrum(g, 400, 64, [], "#ff7e5f", "#feb47b")).not.toThrow();
  });

  it("非法颜色回退默认强调色，不抛错", () => {
    const g = fakeCtx2d();
    expect(() => drawSpectrum(g, 100, 40, null, "not-a-color", "")).not.toThrow();
    expect(() => drawSpectrum(g, 100, 40, [0.1], "not-a-color", "")).not.toThrow();
  });

  it("峰值保持：数据骤降后亮帽仍保留上一帧峰值并缓慢下落", () => {
    const g = fakeCtx2d();
    _resetPeaks();
    // 第一帧：全 1.0 → 峰值 = 58px（h=64）
    drawSpectrum(g, 400, 64, [1.0, 1.0, 1.0, 1.0], "#ff7e5f", "#feb47b");
    expect(g.arc.mock.calls.length).toBe(4);
    // 第二帧：全 0 → 亮帽不消失，仍停在上一帧峰值附近，逐帧缓慢下落（<1px/帧）
    drawSpectrum(g, 400, 64, [0, 0, 0, 0], "#ff7e5f", "#feb47b");
    const caps2 = g.arc.mock.calls.slice(-4);
    expect(caps2.length).toBe(4);
    caps2.forEach((c) => {
      expect(c[1]).toBeGreaterThan(6); // 已开始下落（y 增大）
      expect(c[1] - 6).toBeLessThan(1); // 下落量 <1px/帧（延迟感）
    });
    _resetPeaks();
  });
});

// ============ 任务 K：readWaveData + 6 样式渲染器 ============
function fullCtx2d() {
  const g = {
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
  return g;
}

describe("readWaveData（时域波形）", () => {
  it("getByteTimeDomainData 数据归一化 -1~1，count 抽稀", () => {
    const a = {
      fftSize: 256,
      getByteTimeDomainData: (arr) => {
        for (let i = 0; i < arr.length; i++) arr[i] = 128; // 全静音中线
      },
    };
    const vals = readWaveData(a, 16);
    expect(vals).toHaveLength(16);
    vals.forEach((v) => expect(v).toBeCloseTo(0, 5)); // 128/128-1 = 0
  });

  it("正负采样值（128=中线，255=+1，0=-1）", () => {
    const a = {
      fftSize: 4,
      getByteTimeDomainData: (arr) => {
        arr[0] = 255;
        arr[1] = 128;
        arr[2] = 0;
        arr[3] = 64;
      },
    };
    const vals = readWaveData(a, 4);
    expect(vals[0]).toBeCloseTo(0.992, 2); // 255/128-1 ≈ 0.992
    expect(vals[1]).toBeCloseTo(0, 5);
    expect(vals[2]).toBeCloseTo(-1, 5);
    expect(vals[3]).toBeCloseTo(-0.5, 5); // 64/128-1 = -0.5
  });
});

describe("任务 K 渲染器（6 样式）", () => {
  it("drawRadial：数据 → 底环 + 统一光晕 + n 段渐变弧 + 中心点；无数据 → 静态双层环，不抛错", () => {
    const g = fullCtx2d();
    drawRadial(g, 200, 64, [0.5, 0.25, 0.75, 1.0], { accent: "#ff7e5f", accent2: "#feb47b" });
    expect(g.clearRect).toHaveBeenCalledWith(0, 0, 200, 64);
    // 底环 + 光晕 4 段 + 主环 4 段 + 中心点 = 10 次 arc
    expect(g.arc.mock.calls.length).toBe(10);
    // 底环 + 光晕 + 4 段主环 = 6 次 stroke
    expect(g.stroke.mock.calls.length).toBe(6);
    expect(g.fill.mock.calls.length).toBe(1); // 中心点
    expect(() => drawRadial(g, 200, 64, null, {})).not.toThrow();
    expect(g.arc.mock.calls.length).toBe(36); // +基准环 + 24 点环 + 中心点
    expect(g.stroke.mock.calls.length).toBe(7);
  });

  it("drawWave：数据 → 平滑曲线（中点贝塞尔）+ 渐变填充 + 辉光；无数据 → 柔和静态正弦", () => {
    const g = fullCtx2d();
    drawWave(g, 200, 64, [0.5, -0.5, 0.25, -0.25, 0.8, -0.3, 0.1, -0.7], {});
    expect(g.moveTo).toHaveBeenCalled();
    expect(g.quadraticCurveTo.mock.calls.length).toBeGreaterThan(1); // 平滑曲线（非折线）
    expect(g.stroke).toHaveBeenCalled();
    expect(g.fill).toHaveBeenCalled(); // 曲线下方渐变填充
    expect(() => drawWave(g, 200, 64, null, {})).not.toThrow();
    expect(g.moveTo).toHaveBeenCalledWith(0, 32); // 静态正弦起点（中线）
  });

  it("drawPulse：低频均值 → 中心光晕脉动（radial 渐变）+ 外圈频谱环；无数据 → 静态，不抛错", () => {
    const g = fullCtx2d();
    drawPulse(g, 200, 64, [0.8, 0.6, 0.4, 0.2, 0.1, 0.1, 0.1, 0.1], {});
    expect(g.createRadialGradient).toHaveBeenCalled();
    expect(g.fill.mock.calls.length).toBe(2); // 外晕 + 亮核
    expect(g.arc.mock.calls.length).toBe(3); // 基准环 + 外晕 + 亮核
    expect(g.stroke.mock.calls.length).toBeGreaterThan(1); // 基准环 + 光晕 + spokes
    expect(() => drawPulse(g, 200, 64, null, {})).not.toThrow();
  });

  it("drawMirror：数据 → 上下对称圆角条（渐变）+ 中心亮线；无数据 → 静态对称轮廓", () => {
    const g = fullCtx2d();
    drawMirror(g, 400, 64, [0.5, 0.25, 0.75, 1.0], {});
    expect(g.roundRect.mock.calls.length).toBe(8); // 4 上 + 4 下
    expect(g.fillRect.mock.calls.length).toBe(1); // 中心基线
    expect(g.fill.mock.calls.length).toBe(2); // 上下两个渐变填充
    expect(() => drawMirror(g, 400, 64, null, {})).not.toThrow();
    expect(g.roundRect.mock.calls.length).toBeGreaterThan(8); // 静态对称鼓包
  });

  it("drawParticle：粒子沿频谱槽位分布（拖尾 + 发光头点）；数据/无数据都画；小尺寸粒子数缩减", () => {
    const g = fullCtx2d();
    _resetParticles();
    expect(() => drawParticle(g, 360, 64, [0.5, 0.25, 0.75, 1.0], {})).not.toThrow();
    expect(g.arc.mock.calls.length).toBeGreaterThan(0);
    expect(g.fill.mock.calls.length).toBeGreaterThan(0);
    expect(g.stroke.mock.calls.length).toBeGreaterThan(0); // 拖尾描边
    expect(() => drawParticle(g, 360, 64, null, {})).not.toThrow(); // 暂停轻柔浮游
    expect(() => drawParticle(g, 44, 44, [0.5], { small: true })).not.toThrow();
    _resetParticles();
  });

  it("drawParticle：small 变体粒子数缩减（绘制调用更少）", () => {
    const g = fullCtx2d();
    _resetParticles();
    drawParticle(g, 360, 64, [0.5, 0.25, 0.75, 1.0], {});
    const fullCount = g.arc.mock.calls.length;
    _resetParticles();
    const before = g.arc.mock.calls.length;
    drawParticle(g, 360, 64, [0.5, 0.25, 0.75, 1.0], { small: true });
    expect(g.arc.mock.calls.length - before).toBeLessThan(fullCount);
    _resetParticles();
  });

  it("6 个渲染器均接受非法颜色，不抛错（颜色工具兜底）", () => {
    const g = fullCtx2d();
    expect(() => drawRadial(g, 100, 40, [0.1], { accent: "x", accent2: "" })).not.toThrow();
    expect(() => drawWave(g, 100, 40, [0.1], { accent: "x", accent2: "" })).not.toThrow();
    expect(() => drawPulse(g, 100, 40, [0.1], { accent: "x", accent2: "" })).not.toThrow();
    expect(() => drawMirror(g, 100, 40, [0.1], { accent: "x", accent2: "" })).not.toThrow();
    expect(() => drawParticle(g, 100, 40, [0.1], { accent: "x", accent2: "" })).not.toThrow();
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

  it("visualizerStyle 默认 'bars'，切换写入 PLAYBACK_SETTINGS_KEY", async () => {
    expect(playbackSettings.visualizerStyle).toBe("bars");
    playbackSettings.visualizerStyle = "radial";
    await nextTick();
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.visualizerStyle).toBe("radial");
    playbackSettings.visualizerStyle = "bars"; // 恢复默认，避免污染其他用例
    await nextTick();
  });

  it("脏数据（非法枚举）加载时回落默认 'bars'", async () => {
    localStorage.setItem(PLAYBACK_SETTINGS_KEY, JSON.stringify({ visualizerStyle: "spiral" }));
    loadPlaybackSettings();
    expect(playbackSettings.visualizerStyle).toBe("bars");
    // 合法值保留
    localStorage.setItem(PLAYBACK_SETTINGS_KEY, JSON.stringify({ visualizerStyle: "wave" }));
    loadPlaybackSettings();
    expect(playbackSettings.visualizerStyle).toBe("wave");
    playbackSettings.visualizerStyle = "bars";
  });
});
