// playerCore.songChangedTargetIndex 单元测试：锁屏/线控后台切歌（songChanged）对齐索引计算
//
// 原生成为后台播放执行器后，切歌由原生按 setQueue 快照执行，songChanged {index} 回传，
// 前端 songChangedTargetIndex 把快照位置映射回当前播放模式下的歌曲索引：
//   普通模式（order/repeatOne）index 直接映射；shuffle 模式经 shuffleQueue 映射；
//   越界/空队列返回 -1（对齐失败时不动状态）。
import { describe, it, expect, vi } from "vitest";

// Audio stub：playerCore 模块加载即 new Audio()（audioEq/audioBare），jsdom 无 Audio
class FakeAudio {
  _src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, Array<() => void>> = {};

  set src(v: string) {
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
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] = this.listeners[ev] || []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    const arr = this.listeners[ev] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
}
vi.stubGlobal("Audio", FakeAudio);

// jsdom（vitest 4）无 localStorage → 手写 stub（playerCore 模块加载期读取）
const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = String(v);
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};
vi.stubGlobal("localStorage", localStorageStub);

// nativeAudioBridge mock：非原生环境（isNativePlayback false）——纯函数测试不涉及原生代理
vi.mock("../composables/nativeAudioBridge.js", () => ({
  isNativePlayback: () => false,
  createNativeAudioProxy: () => ({}),
  registerRemoteCommandHandler: vi.fn(),
  registerNativeSongChangedHandler: vi.fn(),
  nativeSendMetadata: vi.fn(),
  resolveCoverURL: vi.fn(),
  resolveNativeUrl: vi.fn((url: string) => url),
  nativePost: vi.fn(),
  onNativeEvent: vi.fn(),
}));

const playerMod = await import("../composables/usePlayer.js");
const { songChangedTargetIndex } = playerMod;

describe("songChangedTargetIndex：songChanged 对齐索引（原生切歌跟随）", () => {
  it("普通模式：index 直接映射", () => {
    expect(songChangedTargetIndex("order", 2, [], 5)).toBe(2);
    expect(songChangedTargetIndex("repeatOne", 0, [], 3)).toBe(0);
  });

  it("shuffle 模式：经 shuffleQueue 映射到歌曲索引", () => {
    // index 是播放顺序（洗牌队列）中的位置 → 映射回歌曲索引
    expect(songChangedTargetIndex("shuffle", 1, [3, 0, 2], 4)).toBe(0);
    expect(songChangedTargetIndex("shuffle", 2, [3, 0, 2], 4)).toBe(2);
  });

  it("index 越界（负值 / 超出歌曲数）→ -1", () => {
    expect(songChangedTargetIndex("order", -1, [], 5)).toBe(-1);
    expect(songChangedTargetIndex("order", 5, [], 5)).toBe(-1);
  });

  it("songsLen 为 0（空歌曲列表）→ -1", () => {
    expect(songChangedTargetIndex("order", 0, [], 0)).toBe(-1);
  });

  it("shuffle 模式：shuffleQueue 越界 / 指向越界歌曲 / 空队列 → -1", () => {
    expect(songChangedTargetIndex("shuffle", 9, [0, 1], 4)).toBe(-1); // 位置越界
    expect(songChangedTargetIndex("shuffle", 1, [0, 99], 4)).toBe(-1); // 指向越界歌曲
    expect(songChangedTargetIndex("shuffle", 0, [], 4)).toBe(-1); // 空洗牌队列
  });
});
