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
  removeAttribute() {}
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
  DECADE_BUCKETS,
  decadeOfYear,
  mapDecade,
  countByDecade,
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

  it("网络歌（path=null）：按 streamId 定位播放，不误匹配第一个 stream 条目", () => {
    state.songs = [
      { path: "/a.mp3", name: "本地A" },
      { type: "stream", streamId: "s1", path: null, name: "网络1" },
      { type: "stream", streamId: "s2", path: null, name: "网络2" },
    ];
    const ok = playSmartRow({ song: state.songs[2] });
    expect(ok).toBe(true);
    expect(state.currentIndex).toBe(2);
    expect(state.currentSong.streamId).toBe("s2");
  });
});

describe("decadeOfYear（年代边界：10 年一段 + 更早/未知）", () => {
  it("边界 1959/1960：闭区间 [min, max]", () => {
    expect(decadeOfYear(1959)).toBe("1950s");
    expect(decadeOfYear(1960)).toBe("1960s");
    expect(decadeOfYear(1940)).toBe("1950s"); // 更早归 1950s
    expect(decadeOfYear(1900)).toBe("1950s");
  });

  it("各段边界与 2020s 含以后", () => {
    expect(decadeOfYear(1969)).toBe("1960s");
    expect(decadeOfYear(1970)).toBe("1970s");
    expect(decadeOfYear(1989)).toBe("1980s");
    expect(decadeOfYear(1990)).toBe("1990s");
    expect(decadeOfYear(1999)).toBe("1990s");
    expect(decadeOfYear(2000)).toBe("2000s");
    expect(decadeOfYear(2009)).toBe("2000s");
    expect(decadeOfYear(2010)).toBe("2010s");
    expect(decadeOfYear(2019)).toBe("2010s");
    expect(decadeOfYear(2020)).toBe("2020s");
    expect(decadeOfYear(2030)).toBe("2020s");
  });

  it("year 缺失/非法 → unknown", () => {
    expect(decadeOfYear(null)).toBe("unknown");
    expect(decadeOfYear(undefined)).toBe("unknown");
    expect(decadeOfYear("")).toBe("unknown");
    expect(decadeOfYear("abc")).toBe("unknown");
    expect(decadeOfYear(1990.5)).toBe("unknown");
    expect(decadeOfYear(99)).toBe("unknown");
    expect(decadeOfYear(10000)).toBe("unknown");
    expect(decadeOfYear("1995")).toBe("1990s"); // 字符串数字可解析
  });
});

describe("mapDecade（年代聚合：按 song.year 纯前端分组）", () => {
  const decadeLib = [
    { id: "a", path: "/lib/a.mp3", name: "A", year: 1991 },
    { id: "b", path: "/lib/b.mp3", name: "B", year: 1985 },
    { id: "c", path: "/lib/c.mp3", name: "C", year: 1999 },
    { id: "d", path: "/lib/d.mp3", name: "D" }, // 无 year → unknown
    { id: "e", path: "/lib/e.mp3", name: "E", year: null }, // unknown
    { id: "f", path: "/lib/f.mp3", name: "F", year: "2024" },
    { id: "g", path: "/lib/g.mp3", name: "G", year: 1959 },
    { id: "h", path: "/lib/h.mp3", name: "H", year: 1960 },
  ];

  it("按 bucket 聚合，组内 year 降序（新在前）", () => {
    const rows = mapDecade(decadeLib, "1990s");
    expect(rows.map((r) => r.song.path)).toEqual(["/lib/c.mp3", "/lib/a.mp3"]);
  });

  it("1950s 含更早 / 2020s 含以后 / 边界 1959·1960 归位", () => {
    expect(mapDecade(decadeLib, "1950s").map((r) => r.song.path)).toEqual(["/lib/g.mp3"]);
    expect(mapDecade(decadeLib, "1960s").map((r) => r.song.path)).toEqual(["/lib/h.mp3"]);
    expect(mapDecade(decadeLib, "2020s").map((r) => r.song.path)).toEqual(["/lib/f.mp3"]);
  });

  it("未知年代：year 缺失/非法全部进 unknown", () => {
    const rows = mapDecade(decadeLib, "unknown");
    expect(rows.map((r) => r.song.path)).toEqual(["/lib/d.mp3", "/lib/e.mp3"]);
  });

  it("非法 bucket key 回落 unknown；空库空数组；limit 截断", () => {
    expect(mapDecade(decadeLib, "not-a-bucket").map((r) => r.song.path)).toEqual([
      "/lib/d.mp3",
      "/lib/e.mp3",
    ]);
    expect(mapDecade([], "1990s")).toEqual([]);
    expect(mapDecade(decadeLib, "unknown", 1)).toHaveLength(1);
  });

  it("DECADE_BUCKETS 覆盖 9 组（更早/60s~20s/未知）", () => {
    expect(DECADE_BUCKETS.map((b) => b.key)).toEqual([
      "1950s",
      "1960s",
      "1970s",
      "1980s",
      "1990s",
      "2000s",
      "2010s",
      "2020s",
      "unknown",
    ]);
  });
});

describe("countByDecade（年代计数：未知年代徽标数据源）", () => {
  it("统计各年代数量（含 unknown）", () => {
    const counts = countByDecade([
      { year: 1985 },
      { year: 1990 },
      { year: 1991 },
      { year: null },
      { year: "2020" },
      { year: "bad" },
    ]);
    expect(counts["1980s"]).toBe(1);
    expect(counts["1990s"]).toBe(2);
    expect(counts["2020s"]).toBe(1);
    expect(counts["unknown"]).toBe(2);
    expect(counts["1950s"]).toBe(0);
  });

  it("空库全 0", () => {
    const counts = countByDecade([]);
    expect(Object.values(counts).every((v) => v === 0)).toBe(true);
  });
});

describe("loadSmartView decades（年代视图：纯前端聚合，不发请求）", () => {
  it("进入年代视图：按 decade 聚合 rows，state.decade 落参", async () => {
    state.songs = [
      { id: "a", path: "/lib/a.mp3", name: "A", year: 1988 },
      { id: "b", path: "/lib/b.mp3", name: "B", year: 1989 },
      { id: "c", path: "/lib/c.mp3", name: "C", year: 1990 },
    ];
    await loadSmartView("decades", "1980s");
    expect(smartViewState.active).toBe("decades");
    expect(smartViewState.decade).toBe("1980s");
    expect(smartViewState.rows.map((r) => r.song.path)).toEqual(["/lib/b.mp3", "/lib/a.mp3"]);
    expect(smartViewState.error).toBe("");
  });

  it("未传 decade 参数：用已写入的 smartViewState.decade（侧栏 openSmartView 先落参）", async () => {
    state.songs = [{ id: "a", path: "/lib/a.mp3", year: 1975 }];
    smartViewState.decade = "1970s";
    await loadSmartView("decades");
    expect(smartViewState.decade).toBe("1970s");
    expect(smartViewState.rows).toHaveLength(1);
  });

  it("年代视图打开时曲库变化 → 自动重算（复用 recentAdded 的 watch 机制）", async () => {
    state.songs = [{ id: "a", path: "/lib/a.mp3", name: "A", year: 2001 }];
    await loadSmartView("decades", "2000s");
    expect(smartViewState.rows).toHaveLength(1);
    state.songs = [
      { id: "a", path: "/lib/a.mp3", name: "A", year: 2001 },
      { id: "b", path: "/lib/b.mp3", name: "B", year: 2005 },
    ];
    await nextTick();
    expect(smartViewState.rows).toHaveLength(2);
    expect(smartViewState.rows[0].song.path).toBe("/lib/b.mp3"); // year 降序
  });

  it("非年代视图 decade 复位为 null；closeSmartView 复位 decade", async () => {
    await loadSmartView("decades", "1990s");
    expect(smartViewState.decade).toBe("1990s");
    await loadSmartView("recentAdded");
    expect(smartViewState.decade).toBe(null);
    await loadSmartView("decades", "2010s");
    closeSmartView();
    expect(smartViewState.active).toBe(null);
    expect(smartViewState.decade).toBe(null);
    expect(smartViewState.rows).toEqual([]);
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
