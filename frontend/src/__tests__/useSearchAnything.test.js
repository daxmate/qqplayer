// useSearchAnything 单元测试：五类数据源 / 打分排序 / 防抖 / searchSeq / 失败静默 / clear
// 基建照 useSleepTimer.test.js：Audio stub 必须在 import 前注册；
// settingsIndex 用 vi.mock 注入 fake 条目（真实文件由任务 B 产出，merge 后 maintainer 全量重跑）。
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，playerCore 模块顶层 new Audio()）
class FakeAudio {
  static instances = [];
  constructor() {
    this._src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
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
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.listeners["pause"]?.();
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub（playerCore/settingsSync 模块加载时 try/catch 保护，测试体里显式提供）
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

// settingsIndex mock：beforeEach 重建为 BASE_SETTINGS（上限/别名测试可自行增删）
vi.mock("../settingsIndex", () => ({
  settingsIndex: [],
  SETTING_CATEGORIES: [
    { key: "playback", labelKey: "settings.category.playback" },
    { key: "library", labelKey: "settings.category.library" },
    { key: "download", labelKey: "settings.category.download" },
    { key: "lyric", labelKey: "settings.category.lyric", subTabs: ["app", "desktop"] },
    { key: "ui", labelKey: "settings.category.ui" },
    { key: "shortcuts", labelKey: "settings.category.shortcuts" },
    { key: "about", labelKey: "settings.category.about" },
  ],
}));

// 测试用固定歌曲池
const S1 = { id: 1, path: "/s/1.mp3", name: "晴天", artist: "晴天乐队", album: "晴空" };
const S2 = { id: 2, path: "/s/2.mp3", name: "雨", artist: "歌手B", album: "晴天娃娃" };
const S3 = { id: 3, path: "/s/3.mp3", name: "风", artist: "晴天乐队", album: "晴空" };

const BASE_SETTINGS = [
  {
    key: "playMode",
    labelKey: "settings.playMode",
    keywords: ["播放模式", "循环"],
    category: "playback",
  },
  {
    key: "custom",
    labelKey: "settings.eq",
    keywords: ["晴天设置"],
    category: "playback",
  },
];

const DEBOUNCE_MS = 250;

const { state } = await import("../composables/usePlayer.js");
const settingsModule = await import("../settingsIndex");
const { useSearchAnything } = await import("../composables/useSearchAnything.js");

const { query, results, loading, isSearchOpen, clear, onlineSource, setOnlineSource } =
  useSearchAnything();

let fetchMock;

function resetSettings() {
  settingsModule.settingsIndex.length = 0;
  settingsModule.settingsIndex.push(
    ...BASE_SETTINGS.map((e) => ({ ...e, keywords: [...e.keywords] })),
  );
}

async function flush() {
  await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
  await nextTick();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("localStorage", localStorageStub);
  state.songs = [];
  resetSettings();
  clear();
  fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ items: [] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("query 空值", () => {
  it("空 query：results=[]、loading=false、不发请求、不改变 isSearchOpen", async () => {
    query.value = "  ";
    await flush();
    expect(results.value).toEqual([]);
    expect(loading.value).toBe(false);
    expect(isSearchOpen.value).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("删光搜索词：结果清空但搜索层保持打开（2026-08-16 修复，不再自动退出编辑框）", async () => {
    state.songs = [S1];
    isSearchOpen.value = true;
    query.value = "晴";
    await flush();
    expect(results.value.length).toBeGreaterThan(0);
    expect(isSearchOpen.value).toBe(true);
    // 删光 → 结果清空，层保持打开（可继续输入/按 Esc 收起）
    query.value = "";
    await flush();
    expect(results.value).toEqual([]);
    expect(loading.value).toBe(false);
    expect(isSearchOpen.value).toBe(true);
  });
});

describe("防抖", () => {
  it("250ms 内不触发请求；连续输入合并为最后一次", async () => {
    state.songs = [S1];
    query.value = "晴";
    await nextTick();
    expect(loading.value).toBe(true); // 防抖期间即进入 loading
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchMock).not.toHaveBeenCalled();
    query.value = "晴天";
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await nextTick();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `/api/online/search?q=${encodeURIComponent("晴天")}&limit=20&source=netease`,
    );
    expect(loading.value).toBe(false);
  });
});

describe("五类数据源", () => {
  it("本地/在线/歌手/专辑/设置混合出现，badge 中文写死", async () => {
    state.songs = [S1, S2, S3];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "o1",
            title: "晴天（伴奏）",
            artist: "某人",
            album: "某专",
            cover: "",
            duration: "3:00",
            quality: "standard",
          },
        ],
      }),
    });
    query.value = "晴";
    await flush();

    const kinds = new Set(results.value.map((r) => r.kind));
    for (const k of ["song", "online", "artist", "album", "setting"]) {
      expect(kinds.has(k)).toBe(true);
    }
    expect(results.value.find((r) => r.kind === "song").badge).toBe("本地");
    expect(results.value.find((r) => r.kind === "online").badge).toBe("在线");
    expect(results.value.find((r) => r.kind === "artist").badge).toBe("歌手");
    expect(results.value.find((r) => r.kind === "album").badge).toBe("专辑");
    expect(results.value.find((r) => r.kind === "setting").badge).toBe("设置");
  });

  it("ResultItem payload 结构", async () => {
    state.songs = [S1, S3]; // S3 同歌手/同专辑，验证聚合计数
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "o1",
            title: "晴天（伴奏）",
            artist: "某人",
            album: "某专",
            cover: "c.jpg",
            duration: "3:00",
            quality: "standard",
          },
        ],
      }),
    });
    query.value = "晴";
    await flush();

    const song = results.value.find((r) => r.kind === "song");
    expect(song.id).toBe(S1.path);
    expect(song.title).toBe("晴天");
    expect(song.subtitle).toBe("晴天乐队 · 晴空");
    expect(song.score).toBe(120); // 前缀 100 + 歌名字段权重 20
    expect(song.payload).toEqual(S1); // 本地歌曲 payload = state.songs 条目（reactive 代理，deep 相等）

    const online = results.value.find((r) => r.kind === "online");
    expect(online.id).toBe("online-o1");
    expect(online.payload).toEqual({
      id: "o1",
      title: "晴天（伴奏）",
      artist: "某人",
      album: "某专",
      cover: "c.jpg",
      duration: "3:00",
      quality: "standard",
    });

    const artist = results.value.find((r) => r.kind === "artist");
    expect(artist.title).toBe("晴天乐队");
    expect(artist.subtitle).toBe("2 首");
    expect(artist.payload).toEqual({ artist: "晴天乐队", count: 2 });

    const album = results.value.find((r) => r.kind === "album");
    expect(album.title).toBe("晴空");
    expect(album.payload).toEqual({ album: "晴空", artists: ["晴天乐队"], count: 2 });

    const setting = results.value.find((r) => r.kind === "setting");
    expect(setting.title).toBe("均衡器"); // t(settings.eq)
    expect(setting.subtitle).toBe("播放"); // t(settings.category.playback)
    expect(setting.score).toBe(110); // 别名"晴天设置"前缀命中 100 + 别名加成 10
    expect(setting.payload).toEqual(settingsModule.settingsIndex.find((e) => e.key === "custom"));
  });
});

describe("打分排序", () => {
  it("前缀命中排最前", async () => {
    state.songs = [S2, S1]; // S2 仅包含命中（50），S1 前缀命中（120）
    query.value = "晴";
    await flush();
    expect(results.value[0].kind).toBe("song");
    expect(results.value[0].title).toBe("晴天");
    expect(results.value[0].score).toBeGreaterThan(results.value[1].score);
  });

  it("同分优先级：本地先出，在线追加末尾", async () => {
    // 三者同分 120：song 专辑字段完全相等 / online title 完全相等 / album 聚合完全相等 / setting 文案完全相等
    // 新语义（2026-08-16 用户拍板）：本地结果先出，在线结果到达后追加末尾，不参与全局混排
    state.songs = [{ id: 9, path: "/x.mp3", name: "xx", artist: "yy", album: "播放模式" }];
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "o9",
            title: "播放模式",
            artist: "a",
            album: "b",
            cover: "",
            duration: "1:00",
            quality: "low",
          },
        ],
      }),
    });
    query.value = "播放模式";
    await flush();

    const top = results.value.filter((r) => r.score === 120).map((r) => r.kind);
    expect(top).toEqual(["song", "album", "setting", "online"]);
  });

  it("本地结果先行渲染，在线到达后追加末尾", async () => {
    state.songs = [{ id: 1, path: "/a.mp3", name: "本地歌", artist: "A", album: "B" }];
    let resolveOnline;
    fetchMock.mockReturnValue(
      new Promise((res) => {
        resolveOnline = res;
      }),
    );
    query.value = "本地歌";
    await flush(); // 防抖后本地立即渲染（在线未返回）
    expect(results.value.map((r) => r.kind)).toEqual(["song"]);
    resolveOnline({
      ok: true,
      json: async () => ({
        items: [
          {
            id: "o1",
            title: "本地歌",
            artist: "X",
            album: "Y",
            cover: "",
            duration: "1:00",
            quality: "low",
          },
        ],
      }),
    });
    await vi.advanceTimersByTimeAsync(0); // drain promise 微任务（续体在 await fetch 之后）
    await nextTick();
    expect(results.value.map((r) => r.kind)).toEqual(["song", "online"]);
    expect(results.value[1].title).toBe("本地歌");
  });

  it("字段权重：歌名命中排在歌手命中前", async () => {
    state.songs = [
      { id: 1, path: "/a.mp3", name: "光芒", artist: "无名", album: "B" }, // 歌名前缀 100+20=120
      { id: 2, path: "/b.mp3", name: "星光大道", artist: "光良", album: "B" }, // 歌手前缀 100+10=110
    ];
    query.value = "光";
    await flush();
    const songs = results.value.filter((r) => r.kind === "song");
    expect(songs[0].title).toBe("光芒");
    expect(songs[0].score).toBe(120);
    expect(songs[1].title).toBe("星光大道");
    expect(songs[1].score).toBe(110);
  });

  it("设置项别名命中 +10", async () => {
    // 文案"播放模式"不含"循环"：query="循环" 走 keywords 别名 → 完全相等 120+10
    query.value = "循环";
    await flush();
    const setting = results.value.find((r) => r.kind === "setting");
    expect(setting).toBeTruthy();
    expect(setting.score).toBe(130);
    expect(setting.payload.key).toBe("playMode");
  });
});

describe("歌手/专辑聚合", () => {
  it("空 artist/album 归未知歌手/未知专辑", async () => {
    state.songs = [
      { id: 1, path: "/a.mp3", name: "无主", artist: "", album: "" },
      { id: 2, path: "/b.mp3", name: "无主2", artist: "  ", album: null },
    ];
    query.value = "未知";
    await flush();
    const artist = results.value.find((r) => r.kind === "artist");
    expect(artist.title).toBe("未知歌手");
    expect(artist.payload.count).toBe(2);
    const album = results.value.find((r) => r.kind === "album");
    expect(album.title).toBe("未知专辑");
    expect(album.payload.count).toBe(2);
  });

  it("专辑 artists 去重，>2 显示 A / B 等", async () => {
    state.songs = [
      { id: 1, path: "/a.mp3", name: "x", artist: "A", album: "合辑" },
      { id: 2, path: "/b.mp3", name: "y", artist: "B", album: "合辑" },
      { id: 3, path: "/c.mp3", name: "z", artist: "C", album: "合辑" },
      { id: 4, path: "/d.mp3", name: "w", artist: "A", album: "合辑" }, // A 去重
    ];
    query.value = "合辑";
    await flush();
    const album = results.value.find((r) => r.kind === "album");
    expect(album.subtitle).toBe("A / B 等");
    expect(album.payload.count).toBe(4);
    expect(album.payload.artists).toEqual(["A", "B", "C"]);
  });

  it("2 个 artists 显示 A / B（不截断）", async () => {
    state.songs = [
      { id: 1, path: "/a.mp3", name: "x", artist: "A", album: "双人辑" },
      { id: 2, path: "/b.mp3", name: "y", artist: "B", album: "双人辑" },
    ];
    query.value = "双人辑";
    await flush();
    const album = results.value.find((r) => r.kind === "album");
    expect(album.subtitle).toBe("A / B");
  });
});

describe("每类上限", () => {
  it("本地 8 / 歌手 5 / 专辑 5 / 设置 10", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: i,
      path: `/m/${i}.mp3`,
      name: `q歌${i}`,
      artist: `q歌手${i}`,
      album: `q专辑${i}`,
    }));
    state.songs = many;
    settingsModule.settingsIndex.length = 0;
    for (let i = 0; i < 12; i++) {
      settingsModule.settingsIndex.push({
        key: `k${i}`,
        labelKey: "settings.playMode",
        keywords: [`q设置${i}`],
        category: "playback",
      });
    }
    query.value = "q";
    await flush();
    expect(results.value.filter((r) => r.kind === "song")).toHaveLength(8);
    expect(results.value.filter((r) => r.kind === "artist")).toHaveLength(5);
    expect(results.value.filter((r) => r.kind === "album")).toHaveLength(5);
    expect(results.value.filter((r) => r.kind === "setting")).toHaveLength(10);
  });
});

describe("在线请求", () => {
  it("searchSeq：过期响应丢弃", async () => {
    let resolveFirst;
    fetchMock
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveFirst = r;
          }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({ items: [{ id: "o2", title: "ab结果" }] }),
        }),
      );
    query.value = "a";
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // 请求1发出（pending）
    query.value = "ab";
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS); // 请求2发出并完成
    await nextTick();
    resolveFirst({ ok: true, json: async () => ({ items: [{ id: "o1", title: "a结果" }] }) }); // 过期响应
    await nextTick();
    const onlineTitles = results.value.filter((r) => r.kind === "online").map((r) => r.title);
    expect(onlineTitles).toContain("ab结果");
    expect(onlineTitles).not.toContain("a结果");
    expect(loading.value).toBe(false);
  });

  it("在线失败静默：无在线组、本地结果保留、不抛错", async () => {
    state.songs = [S1];
    fetchMock.mockRejectedValue(new Error("network down"));
    query.value = "晴";
    await flush();
    expect(results.value.filter((r) => r.kind === "online")).toHaveLength(0);
    expect(results.value.some((r) => r.kind === "song")).toBe(true);
    expect(loading.value).toBe(false);
  });

  it("在线接口返回非 items 结构：静默忽略", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ foo: "bar" }) });
    query.value = "晴";
    await flush();
    expect(results.value.filter((r) => r.kind === "online")).toHaveLength(0);
    expect(loading.value).toBe(false);
  });
});

describe("在线结果匹配扩展到歌手/专辑（2026-08-25）", () => {
  // 构造单条在线 item：title/artist/album 可分别命中不同 query
  function mockOnlineItem(item) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        items: [{ id: "o1", cover: "", duration: "3:00", quality: "s", ...item }],
      }),
    });
  }

  function onlineTitles() {
    return results.value.filter((r) => r.kind === "online").map((r) => r.title);
  }

  beforeEach(() => {
    onlineSource.value = "netease";
  });

  it("搜歌手名：title 不含关键词也能命中（artist 字段匹配）", async () => {
    mockOnlineItem({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    query.value = "周杰伦";
    await flush();
    expect(onlineTitles()).toEqual(["晴天"]);
  });

  it("搜歌名：title 匹配，照常出现", async () => {
    mockOnlineItem({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    query.value = "晴天";
    await flush();
    expect(onlineTitles()).toEqual(["晴天"]);
  });

  it("搜专辑名：album 字段匹配，出现", async () => {
    mockOnlineItem({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    query.value = "叶惠美";
    await flush();
    expect(onlineTitles()).toEqual(["晴天"]);
  });

  it("无关词：三字段都不中，在线结果为空数组", async () => {
    mockOnlineItem({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    query.value = "xyzabc";
    await flush();
    expect(onlineTitles()).toEqual([]);
  });

  it("双源：gequhai 同样走三字段匹配，badge 为歌曲海", async () => {
    mockOnlineItem({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    setOnlineSource("gequhai");
    query.value = "周杰伦";
    await flush();
    const online = results.value.filter((r) => r.kind === "online");
    expect(online).toHaveLength(1);
    expect(online[0].title).toBe("晴天");
    expect(online[0].badge).toBe("歌曲海");
    // 请求确实带 source=gequhai
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("source=gequhai"),
      expect.anything(),
    );
  });

  it("gequhai 无关词同样过滤为空", async () => {
    mockOnlineItem({ title: "晴天", artist: "周杰伦", album: "叶惠美" });
    setOnlineSource("gequhai");
    query.value = "xyzabc";
    await flush();
    expect(onlineTitles()).toEqual([]);
  });
});

describe("clear", () => {
  it("清空 query/results/loading/isSearchOpen", async () => {
    state.songs = [S1];
    query.value = "晴";
    await flush();
    expect(results.value.length).toBeGreaterThan(0);
    expect(isSearchOpen.value).toBe(true);
    clear();
    expect(query.value).toBe("");
    expect(results.value).toEqual([]);
    expect(loading.value).toBe(false);
    expect(isSearchOpen.value).toBe(false);
  });

  it("clear 后 pending 防抖不再触发搜索", async () => {
    query.value = "晴";
    await nextTick();
    clear();
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(results.value).toEqual([]);
  });
});
