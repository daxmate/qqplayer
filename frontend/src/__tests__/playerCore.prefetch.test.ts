// selectSong 设备端资产链路回归测试
//
// 背景：原 iOS 壳「播放本地资产优先」链路（assetForSong → ensureAsset → hasAsset 回执 →
// 切本地源）与原生桥资产消息随壳 2026-09-13 退役一并移除。
// 覆盖：选歌播放不再查询本地资产、不再发资产消息，本地歌照常走 /api/audio 远程源。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
vi.stubGlobal("localStorage", {
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
});

// API 层：全部返回失败（歌词/时长等旁路请求静默，不影响选歌主流程）
vi.mock("../utils/apiClient.js", () => ({
  apiGet: vi.fn(async () => ({ ok: false, status: 0, data: null })),
  apiPost: vi.fn(async () => ({ ok: false })),
  apiPut: vi.fn(async () => ({ ok: false })),
  apiDelete: vi.fn(async () => ({ ok: false })),
  invalidate: vi.fn(),
  isOffline: vi.fn(() => false),
  onOfflineChange: vi.fn(() => () => {}),
  onUnauthorized: vi.fn(() => () => {}),
  resolveServerUrl: (p: string) => p,
}));

// 同步数据层：spy 资产构造/查询入口（选歌链路不应触达）
const syncMock = vi.hoisted(() => ({
  assetForSong: vi.fn(async () => null),
  assetForDict: vi.fn(async () => null),
  assetForBook: vi.fn(async () => null),
  syncNow: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../utils/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils/sync.js")>();
  return { ...actual, ...syncMock };
});

const playerMod = await import("../composables/usePlayer.js");
const { state, selectSong } = playerMod;

const SONGS = [
  { path: "/Music/song-0.mp3", name: "Song 0", artist: "A" },
  { path: "/Music/song-1.flac", name: "Song 1", artist: "B" },
  { name: "Stream", artist: "C", type: "stream", streamUrl: "http://radio.example/live" },
];

describe("selectSong：不再触发设备端资产链路", () => {
  beforeEach(() => {
    for (const fn of Object.values(syncMock)) fn.mockClear();
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
    vi.unstubAllEnvs?.();
  });

  it("本地歌：音源走 /api/audio 远程地址，且不查询本地资产", async () => {
    await selectSong(0, { record: false });
    expect(syncMock.assetForSong).not.toHaveBeenCalled();
    expect(syncMock.assetForDict).not.toHaveBeenCalled();
    const el = FakeAudio.instances.find((a) => !!a.src)!;
    expect(el.src).toContain("/api/audio?path=");
  });

  it("自动切歌（autoPlay）同样不触发资产查询", async () => {
    await selectSong(1, { autoPlay: true, record: false });
    expect(syncMock.assetForSong).not.toHaveBeenCalled();
    expect(syncMock.syncNow).not.toHaveBeenCalled();
  });

  it("带断点恢复（resumeAt）：仍不触发资产查询（断点逻辑与资产链路解耦）", async () => {
    await selectSong(0, { resumeAt: 12.5, record: false });
    expect(syncMock.assetForSong).not.toHaveBeenCalled();
  });

  it("流媒体歌（无 path）：不触发资产查询", async () => {
    await selectSong(2, { record: false }).catch(() => {});
    expect(syncMock.assetForSong).not.toHaveBeenCalled();
    expect(syncMock.assetForBook).not.toHaveBeenCalled();
  });
});
