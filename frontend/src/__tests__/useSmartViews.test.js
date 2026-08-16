// 智能视图（最近添加/最近播放/常听排行）数据映射与加载测试
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const {
  mapRecentPlayed,
  mapTopPlayed,
  mapRecentAdded,
  byPath,
  loadSmartView,
  closeSmartView,
  playSmartRow,
  smartViewState,
  fmtSmartSub,
  fmtTs,
  fmtDuration,
  SMART_VIEW_LIMIT,
} = await import("../composables/useSmartViews.js");
const { state } = await import("../composables/usePlayer.js");

// 测试曲库（path → song）
const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "c", path: "/lib/c.mp3", name: "温柔", artist: "五月天", album: "愛情萬歲" },
];

function makeFetch(dataByUrl) {
  return vi.fn(async (url) => ({
    ok: true,
    json: async () => dataByUrl[url] || {},
  }));
}

beforeEach(() => {
  Object.assign(state, {
    songs: lib,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
  closeSmartView();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapRecentPlayed（最近播放：按 ts 倒序、path 去重、跳过库外歌曲）", () => {
  it("按倒序去重：同一首歌多条记录只保留最新一条", () => {
    const records = [
      { path: "/lib/a.mp3", ts: "2026-08-13T10:00:00Z" },
      { path: "/lib/b.mp3", ts: "2026-08-13T09:00:00Z" },
      { path: "/lib/a.mp3", ts: "2026-08-12T08:00:00Z" }, // 同歌更早记录，应被跳过
    ];
    const rows = mapRecentPlayed(records, byPath(lib));
    expect(rows).toHaveLength(2);
    expect(rows[0].song.path).toBe("/lib/a.mp3");
    expect(rows[0].record.ts).toBe("2026-08-13T10:00:00Z"); // 保留最新
    expect(rows[1].song.path).toBe("/lib/b.mp3");
  });

  it("跳过库中已删除的歌曲（映射不到库内 song 的记录）", () => {
    const records = [
      { path: "/lib/deleted.mp3", ts: "2026-08-13T12:00:00Z" }, // 库外
      { path: "/lib/c.mp3", ts: "2026-08-13T11:00:00Z" },
    ];
    const rows = mapRecentPlayed(records, byPath(lib));
    expect(rows).toHaveLength(1);
    expect(rows[0].song.path).toBe("/lib/c.mp3");
  });

  it("保留后端倒序顺序（最新在前）并截断到 limit", () => {
    const records = ["a", "b", "c", "d", "e"].map((p, i) => ({
      path: `/lib/${p}.mp3`,
      ts: `2026-08-13T0${i}:00:00Z`,
    }));
    const rows = mapRecentPlayed(records, byPath(lib), 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].song.path).toBe("/lib/a.mp3");
    expect(rows[1].song.path).toBe("/lib/b.mp3");
  });

  it("空记录返回空数组", () => {
    expect(mapRecentPlayed([], byPath(lib))).toEqual([]);
    expect(mapRecentPlayed(null, byPath(lib))).toEqual([]);
  });
});

describe("mapTopPlayed（常听排行：播放次数降序，并列按累计时长）", () => {
  const stats = [
    { path: "/lib/a.mp3", plays: 2, totalPlayed: 100 },
    { path: "/lib/c.mp3", plays: 9, totalPlayed: 50 },
    { path: "/lib/b.mp3", plays: 9, totalPlayed: 300 },
    { path: "/lib/deleted.mp3", plays: 99, totalPlayed: 999 }, // 库外，跳过
  ];

  it("按 plays 降序，并列按 totalPlayed 降序", () => {
    const rows = mapTopPlayed(stats, byPath(lib));
    expect(rows.map((r) => r.song.path)).toEqual(["/lib/b.mp3", "/lib/c.mp3", "/lib/a.mp3"]);
  });

  it("跳过库外歌曲并截断到 limit", () => {
    const rows = mapTopPlayed(stats, byPath(lib), 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].song.path).toBe("/lib/b.mp3");
    expect(rows[0].stat.plays).toBe(9);
  });

  it("空统计返回空数组", () => {
    expect(mapTopPlayed([], byPath(lib))).toEqual([]);
  });
});

describe("mapRecentAdded（最近添加：按 mtime 降序，最新在前）", () => {
  it("无 mtime（旧数据）：保持库数组顺序，取前 N 首", () => {
    const rows = mapRecentAdded(lib, 2);
    expect(rows.map((r) => r.song.path)).toEqual(["/lib/a.mp3", "/lib/b.mp3"]);
  });

  it("有 mtime：按毫秒时间戳降序，最新添加排最上", () => {
    const lib2 = [
      { id: "a", path: "/lib/a.mp3", mtime: 1000 },
      { id: "b", path: "/lib/b.mp3", mtime: 3000 },
      { id: "c", path: "/lib/c.mp3", mtime: 2000 },
      { id: "d", path: "/lib/d.mp3" }, // 无 mtime → 排最后（0 兜底）
    ];
    const rows = mapRecentAdded(lib2, 2);
    expect(rows.map((r) => r.song.path)).toEqual(["/lib/b.mp3", "/lib/c.mp3"]);
  });

  it("超过库大小时全量返回；空库返回空", () => {
    expect(mapRecentAdded(lib, 999)).toHaveLength(3);
    expect(mapRecentAdded([])).toEqual([]);
  });

  it("默认 limit 为 50", () => {
    expect(SMART_VIEW_LIMIT).toBe(50);
    const big = Array.from({ length: 80 }, (_, i) => ({ id: String(i), path: `/lib/${i}.mp3` }));
    expect(mapRecentAdded(big)).toHaveLength(50);
  });
});

describe("loadSmartView（进入视图拉取一次）", () => {
  it("recentAdded：直接用库顺序，不发请求", async () => {
    await loadSmartView("recentAdded");
    expect(smartViewState.active).toBe("recentAdded");
    expect(smartViewState.rows.map((r) => r.song.path)).toEqual([
      "/lib/a.mp3",
      "/lib/b.mp3",
      "/lib/c.mp3",
    ]);
    expect(smartViewState.error).toBe("");
  });

  it("recentAdded 视图打开时曲库变化 → 自动重算，新歌排最上", async () => {
    await loadSmartView("recentAdded");
    // 模拟下载新歌后 loadSongs 整体替换 state.songs（新歌 mtime 最大）
    state.songs = [
      ...lib.map((s) => ({ ...s, mtime: 1000 })),
      { id: "new", path: "/lib/new.mp3", name: "新歌", mtime: 9999 },
    ];
    await nextTick();
    expect(smartViewState.rows[0].song.path).toBe("/lib/new.mp3");
    expect(smartViewState.rows).toHaveLength(4);
  });

  it("recentPlayed：拉取 /api/playback 并映射去重", async () => {
    const fetchMock = makeFetch({
      "/api/playback": {
        records: [
          { path: "/lib/b.mp3", ts: "2026-08-13T10:00:00Z" },
          { path: "/lib/a.mp3", ts: "2026-08-13T09:00:00Z" },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadSmartView("recentPlayed");
    expect(fetchMock).toHaveBeenCalledWith("/api/playback", expect.anything());
    expect(smartViewState.rows.map((r) => r.song.path)).toEqual(["/lib/b.mp3", "/lib/a.mp3"]);
  });

  it("topPlayed：拉取 /api/playback/stats 并排序", async () => {
    const fetchMock = makeFetch({
      "/api/playback/stats": {
        songs: [
          { path: "/lib/a.mp3", plays: 1, totalPlayed: 10 },
          { path: "/lib/b.mp3", plays: 5, totalPlayed: 200 },
        ],
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    await loadSmartView("topPlayed");
    expect(smartViewState.rows.map((r) => r.song.path)).toEqual(["/lib/b.mp3", "/lib/a.mp3"]);
    expect(smartViewState.rows[0].stat.plays).toBe(5);
  });

  it("接口失败时记录 error，rows 为空", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    await loadSmartView("recentPlayed");
    expect(smartViewState.error).toBeTruthy();
    expect(smartViewState.rows).toEqual([]);
  });

  it("加载期间 loading 为 true", async () => {
    let resolveFetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    const p = loadSmartView("topPlayed");
    expect(smartViewState.loading).toBe(true);
    resolveFetch({ ok: true, json: async () => ({ songs: [] }) });
    await p;
    expect(smartViewState.loading).toBe(false);
  });
});

describe("playSmartRow（点击行播放链路）", () => {
  it("定位到全局队列并播放", async () => {
    state.songs = lib;
    const ok = playSmartRow({ song: lib[1] });
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("知足");
    expect(state.isPlaying).toBe(true);
  });

  it("库外歌曲不播放，返回 false", () => {
    const ok = playSmartRow({ song: { path: "/lib/unknown.mp3" } });
    expect(ok).toBe(false);
    expect(state.currentIndex).toBe(-1);
  });
});

describe("副信息格式化", () => {
  it("常听排行显示播放次数与累计时长", () => {
    const row = { song: lib[0], stat: { plays: 12, totalPlayed: 3720 } };
    expect(fmtSmartSub(row)).toBe("播放 12 次 · 1.0 小时");
  });

  it("最近播放显示播放时间", () => {
    const row = { song: lib[0], record: { ts: "2026-08-13T14:24:04.747Z" } };
    // 本地时区格式化，只校验格式（MM-DD HH:mm）
    expect(fmtSmartSub(row)).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("最近添加显示专辑", () => {
    const row = { song: lib[2] };
    expect(fmtSmartSub(row)).toBe("愛情萬歲");
  });

  it("fmtTs / fmtDuration 边界", () => {
    expect(fmtTs("")).toBe("");
    expect(fmtTs("not-a-date")).toBe("");
    expect(fmtDuration(0)).toBe("");
    expect(fmtDuration(45)).toBe("45 秒");
    expect(fmtDuration(300)).toBe("5 分钟");
  });
});
