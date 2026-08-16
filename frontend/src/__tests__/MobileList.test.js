// MobileList 测试：移动端列表页（歌曲/收藏/歌单/艺术家/专辑/分组 + 搜索 + 拖拽排序）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Sortable mock：MobileList 在歌单视图启用拖拽（jsdom 无法真实创建）
const sortableMock = vi.hoisted(() => ({
  create: vi.fn((el, opts) => {
    sortableMock.onEnd = opts.onEnd;
    return { destroy: vi.fn() };
  }),
  onEnd: null,
}));
vi.mock("sortablejs", () => ({
  default: {
    create: sortableMock.create,
  },
}));

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
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

const MobileList = (await import("../components/mobile/MobileList.vue")).default;
const { state } = await import("../composables/usePlayer.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "c", path: "/lib/c.mp3", name: "突然好想你", artist: "五月天", album: "后青春期的诗" },
];

const playlist = {
  id: "p1",
  name: "我的歌单",
  songPaths: ["/lib/a.mp3", "/lib/c.mp3"],
};

beforeEach(() => {
  Object.assign(state, {
    songs: lib,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [playlist],
    activePlaylistId: null,
  });
  sortableMock.create.mockClear();
  sortableMock.onEnd = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountList(props = {}) {
  return mount(MobileList, {
    props: { kind: "songs", title: "全部歌曲", ...props },
  });
}

describe("MobileList 歌曲列表（kind=songs）", () => {
  it("渲染标题与歌曲计数", () => {
    const wrapper = mountList({ title: "我的收藏" });
    expect(wrapper.find(".ml-title").text()).toBe("我的收藏");
    expect(wrapper.find(".ml-count").text()).toBe("3 首");
  });

  it("搜索 placeholder：歌曲视图 = 搜索歌名 / 歌手", () => {
    const wrapper = mountList();
    expect(wrapper.find(".ml-search input").attributes("placeholder")).toBe("搜索歌名 / 歌手");
  });

  it("focusSearch payload：挂载后搜索框自动聚焦（首页顶栏搜索入口）", async () => {
    const wrapper = mount(MobileList, {
      props: { kind: "songs", title: "全部歌曲", payload: { focusSearch: true } },
      attachTo: document.body,
    });
    await flushPromises();
    expect(document.activeElement).toBe(wrapper.find(".ml-search input").element);
    wrapper.unmount();
  });

  it("渲染全部歌曲行（名称 + 歌手·专辑副标题）", () => {
    const wrapper = mountList();
    const items = wrapper.findAll(".ml-item");
    expect(items.length).toBe(3);
    expect(items[0].text()).toContain("雪の華");
    expect(items[0].text()).toContain("中島美嘉 · 雪の華");
  });

  it("点击歌曲行 emit play 事件（带完整 song 对象）", async () => {
    const wrapper = mountList();
    await wrapper.findAll(".ml-item")[1].trigger("click");
    const plays = wrapper.emitted("play");
    expect(plays).toBeTruthy();
    expect(plays[0][0].path).toBe("/lib/b.mp3");
  });

  it("正在播放的歌曲行高亮 + 播放动画标记", () => {
    state.currentIndex = 1;
    state.isPlaying = true;
    const wrapper = mountList();
    const items = wrapper.findAll(".ml-item");
    expect(items[1].classes()).toContain("active");
    expect(items[1].find(".ml-eq").exists()).toBe(true);
  });

  it("搜索框过滤歌曲（按歌名/歌手）", async () => {
    const wrapper = mountList();
    await wrapper.find(".ml-search input").setValue("五月天");
    expect(wrapper.findAll(".ml-item").length).toBe(2);
    await wrapper.find(".ml-search input").setValue("知足");
    expect(wrapper.findAll(".ml-item").length).toBe(1);
  });

  it("搜索无结果显示空态文案", async () => {
    const wrapper = mountList();
    await wrapper.find(".ml-search input").setValue("不存在的歌");
    expect(wrapper.find(".ml-empty").text()).toBe("没有匹配的歌曲");
  });

  it("清空按钮清除搜索并恢复全量", async () => {
    const wrapper = mountList();
    await wrapper.find(".ml-search input").setValue("知足");
    expect(wrapper.findAll(".ml-item").length).toBe(1);
    await wrapper.find(".ml-clear").trigger("click");
    expect(wrapper.findAll(".ml-item").length).toBe(3);
  });

  it("封面加载失败降级为图标", async () => {
    const wrapper = mountList();
    const items = wrapper.findAll(".ml-item");
    expect(items[0].find(".ml-row-cover img").exists()).toBe(true);
    await items[0].find(".ml-row-cover img").trigger("error");
    expect(wrapper.findAll(".ml-item")[0].find(".ml-row-cover img").exists()).toBe(false);
    expect(wrapper.findAll(".ml-item")[0].find(".ml-row-cover svg").exists()).toBe(true);
  });

  it("收藏按钮点击：乐观更新 favorites + 调后端接口", async () => {
    const wrapper = mountList();
    const items = wrapper.findAll(".ml-item");
    await items[0].find(".ml-heart").trigger("click");
    expect(state.favorites).toContain("/lib/a.mp3");
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(
      fetchCalls.some(([url, opt]) => url === "/api/favorites/toggle" && opt.method === "POST"),
    ).toBe(true);
    // 已收藏 → 再点取消
    await wrapper.findAll(".ml-item")[0].find(".ml-heart").trigger("click");
    expect(state.favorites).not.toContain("/lib/a.mp3");
  });

  it("收藏行显示实心红心", () => {
    state.favorites = ["/lib/a.mp3"];
    const wrapper = mountList();
    const first = wrapper.findAll(".ml-item")[0];
    expect(first.find(".ml-heart").classes()).toContain("on");
  });
});

describe("MobileList 收藏/歌单/艺术家/专辑视图", () => {
  it("favorites：只渲染已收藏的歌曲", () => {
    state.favorites = ["/lib/b.mp3"];
    const wrapper = mountList({ kind: "favorites" });
    const items = wrapper.findAll(".ml-item");
    expect(items.length).toBe(1);
    expect(items[0].text()).toContain("知足");
  });

  it("favorites 为空显示空态文案", () => {
    const wrapper = mountList({ kind: "favorites" });
    expect(wrapper.find(".ml-empty").text()).toBe("还没有收藏的歌曲");
  });

  it("playlist：按歌单 songPaths 渲染", () => {
    const wrapper = mountList({
      kind: "playlist",
      title: "我的歌单",
      payload: { playlist },
    });
    const items = wrapper.findAll(".ml-item");
    expect(items.length).toBe(2);
    expect(items[0].text()).toContain("雪の華");
    expect(items[1].text()).toContain("突然好想你");
  });

  it("playlist 空歌单显示空态文案", () => {
    const wrapper = mountList({
      kind: "playlist",
      payload: { playlist: { id: "p2", name: "空", songPaths: [] } },
    });
    expect(wrapper.find(".ml-empty").text()).toBe("歌单是空的");
  });

  it("artist：按艺术家过滤歌曲", () => {
    const wrapper = mountList({ kind: "artist", payload: { artist: "五月天" } });
    const items = wrapper.findAll(".ml-item");
    expect(items.length).toBe(2);
    expect(items[0].text()).toContain("知足");
  });

  it("album：按专辑过滤歌曲", () => {
    const wrapper = mountList({ kind: "album", payload: { album: "雪の華" } });
    const items = wrapper.findAll(".ml-item");
    expect(items.length).toBe(1);
    expect(items[0].text()).toContain("雪の華");
  });

  it("未知艺术家归一化为「未知歌手」", () => {
    state.songs = [{ id: "z", path: "/lib/z.mp3", name: "X", artist: "", album: "" }];
    const wrapper = mountList({ kind: "artist", payload: { artist: "未知歌手" } });
    expect(wrapper.findAll(".ml-item").length).toBe(1);
  });
});

describe("MobileList 分组列表（playlists/artists/albums）", () => {
  it("搜索 placeholder：艺术家视图 = 搜索歌手，专辑视图 = 搜索专辑", () => {
    const w1 = mountList({ kind: "artists", title: "艺术家" });
    expect(w1.find(".ml-search input").attributes("placeholder")).toBe("搜索歌手");
    const w2 = mountList({ kind: "albums", title: "专辑" });
    expect(w2.find(".ml-search input").attributes("placeholder")).toBe("搜索专辑");
  });

  it("playlists：渲染歌单名 + 歌曲数量，点击 emit open 下钻", async () => {
    const wrapper = mountList({ kind: "playlists", title: "播放列表" });
    const rows = wrapper.findAll(".ml-group");
    expect(rows.length).toBe(1);
    expect(rows[0].text()).toContain("我的歌单");
    expect(rows[0].text()).toContain("2 首");
    await rows[0].trigger("click");
    const opens = wrapper.emitted("open");
    expect(opens[0][0]).toMatchObject({
      name: "list",
      kind: "playlist",
      title: "我的歌单",
    });
  });

  it("artists：按艺术家分组（含数量 + 首字母色块）", () => {
    const wrapper = mountList({ kind: "artists", title: "艺术家" });
    const rows = wrapper.findAll(".ml-group");
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain("五月天");
    expect(rows[0].text()).toContain("2 首");
    expect(rows[1].text()).toContain("中島美嘉");
    expect(rows[0].find(".ml-avatar").exists()).toBe(true);
  });

  it("albums：按专辑分组（多艺术家合并 + 数量）", () => {
    const wrapper = mountList({ kind: "albums", title: "专辑" });
    const rows = wrapper.findAll(".ml-group");
    expect(rows.length).toBe(3);
    // 五月天两张专辑
    const m = rows.find((r) => r.text().includes("后青春期的诗"));
    expect(m.text()).toContain("1 首");
  });

  it("分组搜索按名称过滤", async () => {
    const wrapper = mountList({ kind: "artists", title: "艺术家" });
    await wrapper.find(".ml-search input").setValue("五月");
    expect(wrapper.findAll(".ml-group").length).toBe(1);
  });

  it("分组空态文案", () => {
    state.playlists = [];
    const wrapper = mountList({ kind: "playlists", title: "播放列表" });
    expect(wrapper.find(".ml-empty").text()).toBe("还没有歌单");
  });
});

describe("MobileList 歌单拖拽排序", () => {
  it("歌单视图 + 未搜索时启用 Sortable（出现拖拽手柄）", async () => {
    const wrapper = mountList({
      kind: "playlist",
      title: "我的歌单",
      payload: { playlist },
    });
    await flushPromises();
    expect(sortableMock.create).toHaveBeenCalled();
    expect(wrapper.find(".ml-drag").exists()).toBe(true);
  });

  it("搜索时禁用拖拽排序", async () => {
    const wrapper = mountList({
      kind: "playlist",
      title: "我的歌单",
      payload: { playlist },
    });
    await wrapper.find(".ml-search input").setValue("知足");
    await flushPromises();
    expect(sortableMock.create.mock.calls.length).toBeLessThanOrEqual(1); // 初始创建后未重建
    expect(wrapper.find(".ml-drag").exists()).toBe(false);
  });

  it("拖拽结束后按新顺序调 setPlaylistOrder（PUT /api/playlists/:id/order）", async () => {
    const wrapper = mountList({
      kind: "playlist",
      title: "我的歌单",
      payload: { playlist },
    });
    await flushPromises();
    expect(sortableMock.onEnd).toBeTypeOf("function");
    // 模拟拖拽：真实调整 DOM 顺序（Sortable 移动的是容器直接子元素 .ml-wrap，c 插到 a 前），再触发 onEnd
    const listEl = wrapper.find(".ml-scroll").element;
    const wraps = wrapper.findAll(".ml-wrap");
    listEl.insertBefore(wraps[1].element, wraps[0].element);
    sortableMock.onEnd({ oldIndex: 0, newIndex: 1 });
    await flushPromises();
    const fetchCalls = vi.mocked(fetch).mock.calls;
    const orderCall = fetchCalls.find(([url]) => url === "/api/playlists/p1/order");
    expect(orderCall).toBeTruthy();
    expect(JSON.parse(orderCall[1].body)).toEqual({ paths: ["/lib/c.mp3", "/lib/a.mp3"] });
    expect(state.playlists[0].songPaths).toEqual(["/lib/c.mp3", "/lib/a.mp3"]);
  });

  it("拖拽位置未变化时不调接口", async () => {
    mountList({
      kind: "playlist",
      title: "我的歌单",
      payload: { playlist },
    });
    await flushPromises();
    sortableMock.onEnd({ oldIndex: 0, newIndex: 0 });
    await flushPromises();
    const fetchCalls = vi.mocked(fetch).mock.calls;
    expect(fetchCalls.some(([url]) => url.includes("/order"))).toBe(false);
  });
});
