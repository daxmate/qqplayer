// playerCore selectSong 恢复播放断点监听器测试（浏览器路径）
//
// 覆盖：恢复播放 seek 到断点（功能正常）、恢复播放后自然切歌不被旧断点劫持
// （loadedmetadata 早于 loadLyric 完成）、连续切歌多轮安全。
//
// 说明：原 iOS 壳原生 Audio 代理（nativeAudioBridge）路径随壳 2026-09-13 退役移除；
// 本文件改为验证浏览器（HTMLAudio 语义）路径——audio 为 stub 的 FakeAudio
// （src 换源清零语义与浏览器 <audio> 一致）。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Audio stub：playerCore 模块加载即 new Audio()（audioEq/audioBare）
class FakeAudio {
  static instances: FakeAudio[] = [];
  _src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  volume = 1;
  muted = false;
  preload = "";
  listeners: Record<string, Array<() => void>> = {};

  constructor() {
    FakeAudio.instances.push(this);
  }
  set src(v: string) {
    this._src = v;
    if (v) this.currentTime = 0; // 浏览器换源语义：进度归零
  }
  get src() {
    return this._src;
  }
  play() {
    this.paused = false;
    this.listeners["play"]?.forEach((fn) => fn());
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  load() {
    /* no-op */
  }
  removeAttribute(attr: string) {
    if (attr === "src") this._src = "";
  }
  addEventListener(ev: string, fn: () => void) {
    (this.listeners[ev] ||= []).push(fn);
  }
  removeEventListener(ev: string, fn: () => void) {
    const arr = this.listeners[ev] || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  }
}
vi.stubGlobal("Audio", FakeAudio);

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
function clearLs() {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

/** 当前活动音频元素（audioEq / audioBare 中正在播放的那个）的 loadedmetadata 触发 */
function fireLoadedMetadata(duration: number) {
  const el = FakeAudio.instances.find((a) => !!a.src) || FakeAudio.instances[0];
  el.duration = duration;
  for (const fn of [...(el.listeners["loadedmetadata"] || [])]) {
    try {
      fn();
    } catch {
      /* 单个监听器异常不中断 */
    }
  }
  return el;
}

const playerMod = await import("../composables/usePlayer.js");
const { state, selectSong } = playerMod;

const SONGS = [
  { path: "/Music/song-0.mp3", name: "Song 0", artist: "A" },
  { path: "/Music/song-1.mp3", name: "Song 1", artist: "B" },
  { path: "/Music/song-2.mp3", name: "Song 2", artist: "C" },
];

describe("selectSong 恢复播放断点监听器（浏览器路径）", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageStub);
    clearLs();
    Object.assign(state, {
      songs: [...SONGS],
      currentIndex: -1,
      currentSong: null,
      isPlaying: false,
      currentTime: 0,
      duration: 0,
      lyric: [],
      lyricFormat: null,
      lyricSource: null,
      abLoop: null,
      playMode: "order",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("恢复播放 seek 到断点（功能正常）", async () => {
    const p = selectSong(0, { resumeAt: 57.5, record: false });
    const el = fireLoadedMetadata(239); // 恢复歌加载完成
    await p;
    expect(el.currentTime).toBe(57.5);
  });

  it("恢复播放后自然切歌：新歌不被旧断点劫持（loadedmetadata 早于 loadLyric 完成）", async () => {
    // 1. 恢复播放：挂带 resumeAt=57.5 的监听器，第一首歌 seek 到断点
    const p1 = selectSong(0, { resumeAt: 57.5, record: false });
    const el1 = fireLoadedMetadata(239);
    await p1;
    expect(el1.currentTime).toBe(57.5);

    // 2. 自然切歌（autoPlay，无 resumeAt）
    const p2 = selectSong(1, { autoPlay: true, record: false });
    // 换源清零（浏览器 <audio> 语义）
    expect(el1.currentTime).toBe(0);
    // 3. 竞态窗口：loadLyric（网络请求）尚未完成时，新歌 loadedmetadata 到达
    fireLoadedMetadata(314);
    await p2;
    // 4. 新歌不得被 seek 到旧断点（旧实现此处 currentTime 变 57.5 = 劫持）
    expect(el1.currentTime).toBe(0);
    expect(state.currentTime).toBe(0);
  });

  it("连续切歌：每首都不带旧断点（多轮循环安全）", async () => {
    await selectSong(0, { resumeAt: 57.5, record: false });
    const el = FakeAudio.instances.find((a) => !!a.src)!;
    // 多轮自然切歌，每轮都在 loadLyric 完成前注入 loadedmetadata
    for (let i = 1; i < SONGS.length; i++) {
      const p = selectSong(i, { autoPlay: true, record: false });
      fireLoadedMetadata(200 + i * 100);
      await p;
      expect(el.currentTime).toBe(0);
      expect(state.currentTime).toBe(0);
    }
  });
});
