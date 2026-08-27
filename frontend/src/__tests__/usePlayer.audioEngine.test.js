// usePlayer composable 单元测试 — 音频引擎（音量/EQ）
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import {
  state,
  stepSpeed,
  audioEq,
  audioBare,
  nextSong,
  play,
  playbackSettings,
  PLAYBACK_SETTINGS_KEY,
  setVolume,
  toggleMute,
  VOLUME_KEY,
  EQ_PRESETS,
  EQ_BANDS,
  setEqPreset,
  setEqGain,
  _resetEqGraph,
  playerMod,
} from "./helpers/usePlayerHarness.js";

describe("音量", () => {
  it("setVolume 设置音量并持久化到 localStorage", () => {
    setVolume(0.5);
    expect(state.volume).toBe(0.5);
    expect(parseFloat(localStorage.getItem(VOLUME_KEY))).toBe(0.5);
  });

  it("setVolume 越界值被 clamp 到 0~1", () => {
    setVolume(1.5);
    expect(state.volume).toBe(1);
    setVolume(-1);
    expect(state.volume).toBe(0);
  });

  it("setVolume 自动取消静音", () => {
    state.muted = true;
    setVolume(0.3);
    expect(state.muted).toBe(false);
  });

  it("toggleMute 切换静音（音量值保留）", () => {
    setVolume(0.6);
    toggleMute();
    expect(state.muted).toBe(true);
    toggleMute();
    expect(state.muted).toBe(false);
    expect(state.volume).toBe(0.6);
  });
});

describe("均衡器 EQ", () => {
  // FakeAudioContext：jsdom 无 Web Audio，stub 记录滤波器链
  class FakeAudioContext {
    static instances = [];
    constructor() {
      this.destination = {};
      this.filters = [];
      this.state = "running";
      this.resumeMock = vi.fn().mockResolvedValue();
      FakeAudioContext.instances.push(this);
    }
    createMediaElementSource() {
      this.source = { connect: vi.fn(), disconnect: vi.fn() };
      return this.source;
    }
    createGain() {
      // 音量主控节点（2026-08-27 WKWebKit 修复后图链路：source → masterGain → filters → destination）
      const g = {
        gain: { value: 1 },
        connect: vi.fn(),
      };
      this.masterGain = g;
      return g;
    }
    createBiquadFilter() {
      const f = {
        type: "",
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0 },
        connect: vi.fn(),
      };
      this.filters.push(f);
      return f;
    }
    resume() {
      return this.resumeMock();
    }
  }

  function stubAudioContext() {
    vi.stubGlobal("AudioContext", FakeAudioContext);
  }

  function setupSong() {
    state.currentSong = { path: "/fake/song.mp3" };
  }

  beforeEach(() => {
    _resetEqGraph();
    playbackSettings.eqEnabled = false;
    playbackSettings.eqPreset = "flat";
    playbackSettings.eqGains = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  });

  it("首次播放懒创建音频图：10 段滤波器、频点正确、关闭时增益全 0（直通）", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    expect(ctx.filters).toHaveLength(10);
    ctx.filters.forEach((f, i) => {
      expect(f.type).toBe("peaking");
      expect(f.frequency.value).toBe(EQ_BANDS[i]);
      expect(f.gain.value).toBe(0);
    });
    // source → masterGain → 10 filters → destination 串联
    expect(ctx.source.connect).toHaveBeenCalledWith(ctx.masterGain);
    expect(ctx.masterGain.connect).toHaveBeenCalledWith(ctx.filters[0]);
    ctx.filters.forEach((f, i) => {
      expect(f.connect).toHaveBeenCalledWith(i === 9 ? ctx.destination : ctx.filters[i + 1]);
    });
    // 音量主控初始化为当前音量（默认 1）
    expect(ctx.masterGain.gain.value).toBe(1);
  });

  it("创建前已设置的均衡器值在创建时应用（启动恢复持久化场景）", async () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    playbackSettings.eqPreset = "bass";
    playbackSettings.eqGains = [...EQ_PRESETS.bass.gains];
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    ctx.filters.forEach((f, i) => {
      expect(f.gain.value).toBe(EQ_PRESETS.bass.gains[i]);
    });
  });

  it("选择预设：增益应用 + eqGains 同步（作为切回自定义的基点）", () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    setEqPreset("rock");
    expect(playbackSettings.eqPreset).toBe("rock");
    expect(playbackSettings.eqGains).toEqual(EQ_PRESETS.rock.gains);
    // 图未创建：不抛错（创建时应用）
    expect(() => setEqPreset("jazz")).not.toThrow();
    expect(playbackSettings.eqGains).toEqual(EQ_PRESETS.jazz.gains);
  });

  it("非法预设 key 忽略", () => {
    setEqPreset("nonexistent");
    expect(playbackSettings.eqPreset).toBe("flat");
  });

  it("音量链路（2026-08-27 WKWebKit 修复）：图接管时走 masterGain 元素归一，未接管走元素音量", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    // 图接管：setVolume → masterGain.gain；元素音量恒 1
    setVolume(0.3);
    expect(ctx.masterGain.gain.value).toBe(0.3);
    expect(audioEq.volume).toBe(1);
    // 静音 → gain 0；取消恢复
    toggleMute();
    expect(ctx.masterGain.gain.value).toBe(0);
    toggleMute();
    expect(ctx.masterGain.gain.value).toBe(0.3);
    // 变速切裸元素：未接管 → 元素音量承载，masterGain 不动
    state.speed = 1.0;
    stepSpeed(-1);
    setVolume(0.7);
    expect(audioBare.volume).toBe(0.7);
    expect(ctx.masterGain.gain.value).toBe(0.3);
    // 回图元素：applyVolume 把音量同步到 masterGain，元素归一
    stepSpeed(1);
    expect(ctx.masterGain.gain.value).toBe(0.7);
    expect(audioEq.volume).toBe(1);
  });

  it("拖滑杆：切到自定义 + 值更新 + clamp ±12 + 实时应用到图", () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    setupSong();
    play();
    const ctx = FakeAudioContext.instances.at(-1);
    setEqGain(0, 6);
    expect(playbackSettings.eqGains[0]).toBe(6);
    expect(ctx.filters[0].gain.value).toBe(6);
    // clamp
    setEqGain(1, 99);
    expect(playbackSettings.eqGains[1]).toBe(12);
    setEqGain(2, -99);
    expect(playbackSettings.eqGains[2]).toBe(-12);
    // 越界 index 忽略
    setEqGain(10, 5);
    expect(playbackSettings.eqGains).toHaveLength(10);
  });

  it("关闭开关 = 全部 0dB 直通", async () => {
    stubAudioContext();
    playbackSettings.eqEnabled = true;
    playbackSettings.eqPreset = "bass";
    setupSong();
    play();
    const ctx = FakeAudioContext.instances.at(-1);
    playbackSettings.eqEnabled = false;
    await nextTick(); // 开关走 watch 异步应用
    ctx.filters.forEach((f) => expect(f.gain.value).toBe(0));
  });

  it("修改后自动持久化到 localStorage", async () => {
    localStorage.removeItem(PLAYBACK_SETTINGS_KEY);
    playbackSettings.eqEnabled = true;
    setEqPreset("vocal");
    await nextTick(); // 持久化 watch 异步落盘
    const saved = JSON.parse(localStorage.getItem(PLAYBACK_SETTINGS_KEY));
    expect(saved.eqEnabled).toBe(true);
    expect(saved.eqPreset).toBe("vocal");
    expect(saved.eqGains).toEqual(EQ_PRESETS.vocal.gains);
  });

  it("启动恢复：持久化的均衡器设置读回", async () => {
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({
        eqEnabled: true,
        eqPreset: "pop",
        eqGains: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      }),
    );
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.playbackSettings.eqEnabled).toBe(true);
    expect(m.playbackSettings.eqPreset).toBe("pop");
    expect(m.playbackSettings.eqGains).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("脏数据归一化：eqGains 长度不对 → 重置；长度对但值非法 → clamp；非法预设 → flat", async () => {
    // 场景 A：长度不对 → 重置全 0
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ eqEnabled: true, eqPreset: "bad", eqGains: [99, "x", null] }),
    );
    vi.resetModules();
    let m = await import("../composables/usePlayer.js");
    expect(m.playbackSettings.eqGains).toHaveLength(10);
    expect(m.playbackSettings.eqGains[0]).toBe(0); // 长度 3 ≠ 10 → 整体重置
    expect(m.playbackSettings.eqPreset).toBe("flat"); // 非法预设回落
    // 场景 B：长度 10 但值非法 → 逐项 clamp/置 0
    localStorage.setItem(
      PLAYBACK_SETTINGS_KEY,
      JSON.stringify({ eqGains: [99, "x", null, -99, 3, 0, 0, 0, 0, 0] }),
    );
    vi.resetModules();
    m = await import("../composables/usePlayer.js");
    expect(m.playbackSettings.eqGains[0]).toBe(12); // clamp 99 → 12
    expect(m.playbackSettings.eqGains[1]).toBe(0); // "x" → 0
    expect(m.playbackSettings.eqGains[3]).toBe(-12); // clamp -99 → -12
  });

  it("无 AudioContext 环境（测试/旧浏览器）：静默降级，播放不抛错", () => {
    // 不 stub AudioContext（jsdom 无）
    setupSong();
    expect(() => play()).not.toThrow();
    // 设置均衡器也不抛错
    expect(() => {
      setEqPreset("bass");
      setEqGain(0, 3);
      playbackSettings.eqEnabled = true;
    }).not.toThrow();
  });

  it("变速切元素：0.75/1.25 切到裸元素（原生管线），回 1.0 切回图元素（EQ）", async () => {
    stubAudioContext();
    setupSong();
    await play(); // 建图，speed=1.0 活动元素 = audioEq（走 EQ 链）
    const ctx = FakeAudioContext.instances.at(-1);
    expect(audioEq).toBeDefined();
    expect(playerMod.audio).toBe(audioEq);
    expect(ctx.source.connect).toHaveBeenLastCalledWith(ctx.masterGain);

    state.speed = 1.0;
    stepSpeed(-1); // → 0.75：切到裸元素
    expect(state.speed).toBe(0.75);
    expect(playerMod.audio).toBe(audioBare);
    expect(playerMod.audio.playbackRate).toBe(0.75);

    stepSpeed(1); // → 1.0：切回图元素
    expect(state.speed).toBe(1.0);
    expect(playerMod.audio).toBe(audioEq);
    expect(playerMod.audio.playbackRate).toBe(1.0);

    stepSpeed(1); // → 1.25：再切裸元素
    expect(state.speed).toBe(1.25);
    expect(playerMod.audio).toBe(audioBare);
    expect(playerMod.audio.playbackRate).toBe(1.25);
  });

  it("变速中切歌：换源仍走裸元素（原生管线保持），回 1.0 状态迁移回图元素", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    state.speed = 1.0;
    stepSpeed(-1); // 0.75 切裸元素
    state.songs = [{ path: "/b.mp3", name: "B" }];
    state.currentIndex = 0;
    await nextSong();
    expect(playerMod.audio).toBe(audioBare); // 变速状态：新歌加载到裸元素
    expect(ctx.source.connect).toHaveBeenLastCalledWith(ctx.masterGain); // 图元素链路未被扰动
    state.speed = 0.75;
    stepSpeed(1); // 回 1.0：切回图元素
    expect(playerMod.audio).toBe(audioEq);
  });

  it("变速切换状态迁移：播放位置/音量/静音/src 同步到目标元素（双向）", async () => {
    stubAudioContext();
    setupSong();
    await play();
    const ctx = FakeAudioContext.instances.at(-1);
    audioEq.currentTime = 42;
    setVolume(0.6);
    toggleMute(); // muted=true：图接管 → masterGain.gain = 0
    state.speed = 1.0;
    stepSpeed(-1); // → 0.75：迁移到裸元素（未接管 → 元素音量承载静音）
    expect(playerMod.audio).toBe(audioBare);
    expect(audioBare.src).toBe(audioEq.src);
    expect(audioBare.currentTime).toBe(42);
    expect(audioBare.volume).toBe(0); // 静音以音量 0 承载（不再复制元素 muted）
    expect(audioBare.muted).toBe(false);
    toggleMute(); // 取消静音 → audioBare.volume = state.volume
    expect(audioBare.volume).toBe(0.6);
    // 回 1.0：反向迁移（变速期间位置推进；音量回到 masterGain）
    audioBare.currentTime = 55;
    stepSpeed(1);
    expect(playerMod.audio).toBe(audioEq);
    expect(audioEq.currentTime).toBe(55);
    expect(ctx.masterGain.gain.value).toBe(0.6); // 图接管 → 音量走 masterGain
    expect(audioEq.volume).toBe(1); // 元素音量归一（音量由 gain 承担）
  });
});
