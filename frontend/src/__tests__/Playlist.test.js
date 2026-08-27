// Playlist 组件测试
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
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

const Playlist = (await import("../components/Playlist.vue")).default;
const { state, isFavorite, uiSettings } = await import("../composables/usePlayer.js");

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    loading: false,
    error: "",
    favorites: [],
    playlists: [],
    activePlaylistId: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // 清理 Teleport 到 body 的浮层残留（加歌浮层测试）
  document.body.querySelectorAll(".add-menu, .am-backdrop").forEach((el) => el.remove());
});

describe("Playlist", () => {
  it("空列表时显示提示", () => {
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("没有歌曲");
  });

  it("扫描中显示扫描提示", () => {
    state.loading = true;
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("扫描中");
  });

  it("渲染歌曲名称和歌手", () => {
    state.songs = [
      { id: "a", name: "ヤキモチ", artist: "高橋優", has_lyric: true },
      { id: "b", name: "知足", artist: "五月天", has_lyric: false },
    ];
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("ヤキモチ");
    expect(wrapper.text()).toContain("高橋優");
    expect(wrapper.text()).toContain("五月天");
  });

  it("有歌词的歌曲显示歌词标记（Mic 图标）", () => {
    state.songs = [{ id: "a", name: "ヤキモチ", artist: "高橋優", has_lyric: true }];
    const wrapper = mount(Playlist);
    expect(wrapper.find(".pl-lyric svg").exists()).toBe(true);
  });

  it("当前播放的歌曲有 active class", () => {
    state.songs = [
      { id: "a", name: "A", artist: "" },
      { id: "b", name: "B", artist: "" },
    ];
    state.currentIndex = 1;
    const wrapper = mount(Playlist);
    const items = wrapper.findAll(".pl-item");
    expect(items[1].classes()).toContain("active");
  });

  it("点击歌曲后选中该歌并开始播放", async () => {
    state.songs = [
      { id: "a", name: "A", artist: "" },
      { id: "b", name: "B", artist: "" },
    ];
    const wrapper = mount(Playlist);
    const items = wrapper.findAll(".pl-item");
    await items[1].trigger("click");
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("B");
    expect(state.isPlaying).toBe(true);
  });

  it("搜索：按歌名/歌手过滤列表", async () => {
    state.songs = [
      { id: "a", name: "ヤキモチ", artist: "高橋優" },
      { id: "b", name: "知足", artist: "五月天" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-search input").setValue("知足");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("知足");
    expect(wrapper.text()).not.toContain("ヤキモチ");
    // 按歌手搜
    await wrapper.find(".pl-search input").setValue("高橋");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("ヤキモチ");
    // 无匹配
    await wrapper.find(".pl-search input").setValue("不存在的歌");
    expect(wrapper.findAll(".pl-item")).toHaveLength(0);
    expect(wrapper.text()).toContain("没有匹配的歌曲");
  });

  it("搜索：繁体输入能筛出简体歌名（简繁互通）", async () => {
    state.songs = [
      { id: "a", name: "温柔", artist: "五月天" },
      { id: "b", name: "知足", artist: "五月天" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-search input").setValue("溫柔");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("温柔");
    expect(wrapper.text()).not.toContain("知足");
  });

  it("搜索：简体输入能筛出繁体歌名", async () => {
    state.songs = [
      { id: "a", name: "溫柔", artist: "五月天" },
      { id: "b", name: "知足", artist: "五月天" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-search input").setValue("温柔");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("溫柔");
  });

  it("搜索：带声调输入能筛出无调歌名（é→e）", async () => {
    state.songs = [
      { id: "a", name: "Resume", artist: "" },
      { id: "b", name: "知足", artist: "" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-search input").setValue("résumé");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("Resume");
  });

  it("搜索：全角输入能筛出半角歌名", async () => {
    state.songs = [
      { id: "a", name: "ABC 123", artist: "" },
      { id: "b", name: "知足", artist: "" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-search input").setValue("ＡＢＣ");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("ABC 123");
  });

  it("排序：按标题排序", async () => {
    state.songs = [
      { id: "b", name: "B歌", artist: "" },
      { id: "a", name: "A歌", artist: "" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-sort").setValue("name");
    const names = wrapper.findAll(".pl-name").map((n) => n.text());
    expect(names).toEqual(["A歌", "B歌"]);
  });

  it("排序：按时长排序", async () => {
    state.songs = [
      { id: "long", name: "长歌", artist: "", duration: 300 },
      { id: "short", name: "短歌", artist: "", duration: 90 },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-sort").setValue("duration");
    const names = wrapper.findAll(".pl-name").map((n) => n.text());
    expect(names).toEqual(["短歌", "长歌"]);
  });

  it("排序后点击歌曲仍播放正确的原始索引", async () => {
    state.songs = [
      { id: "b", name: "B歌", artist: "" },
      { id: "a", name: "A歌", artist: "" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-sort").setValue("name");
    const items = wrapper.findAll(".pl-item");
    await items[0].trigger("click"); // 排序后第一项是 A歌（原索引 1）
    expect(state.currentIndex).toBe(1);
    expect(state.currentSong.name).toBe("A歌");
  });

  it("点击红心收藏歌曲（乐观更新，不触发行点击）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.songs = [{ id: "a", name: "A", artist: "", path: "/a.mp3" }];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-action.heart").trigger("click");
    expect(isFavorite("/a.mp3")).toBe(true);
    // 收藏标记显示
    expect(wrapper.find(".pl-fav-mark").exists()).toBe(true);
    // 再点取消
    await wrapper.find(".pl-action.heart").trigger("click");
    expect(isFavorite("/a.mp3")).toBe(false);
  });

  it("只看收藏：切换后只显示收藏歌曲", async () => {
    state.favorites = ["/b.mp3"];
    state.songs = [
      { id: "a", name: "A", artist: "", path: "/a.mp3" },
      { id: "b", name: "B", artist: "", path: "/b.mp3" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-fav-btn").trigger("click");
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    expect(wrapper.text()).toContain("B");
    expect(wrapper.text()).not.toContain("A");
  });

  it("从队列移除歌曲（不触发行点击）", async () => {
    state.songs = [
      { id: "a", name: "A", artist: "" },
      { id: "b", name: "B", artist: "" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pl-action.remove")[0].trigger("click");
    expect(state.songs).toHaveLength(1);
    expect(state.songs[0].name).toBe("B");
  });

  it("显示歌曲时长", () => {
    state.songs = [{ id: "a", name: "A", artist: "", duration: 214.5 }];
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("3:34");
  });

  it("歌单视图：只显示歌单内歌曲，且按歌单顺序（独立视图）", () => {
    state.playlists = [{ id: "p1", name: "日语歌", songPaths: ["/b.mp3", "/a.mp3"] }];
    state.activePlaylistId = "p1";
    state.songs = [
      { id: "a", name: "A歌", artist: "", path: "/a.mp3" },
      { id: "b", name: "B歌", artist: "", path: "/b.mp3" },
      { id: "c", name: "C歌", artist: "", path: "/c.mp3" },
    ];
    const wrapper = mount(Playlist);
    expect(wrapper.find(".pl-head").text()).toContain("日语歌");
    const items = wrapper.findAll(".pl-item");
    expect(items).toHaveLength(2); // C 歌不在歌单里
    expect(items[0].text()).toContain("B歌"); // 按歌单顺序而非曲库顺序
    expect(items[1].text()).toContain("A歌");
    expect(wrapper.text()).not.toContain("C歌");
  });

  it("歌单视图：空歌单显示引导提示", () => {
    state.playlists = [{ id: "p1", name: "空歌单", songPaths: [] }];
    state.activePlaylistId = "p1";
    state.songs = [{ id: "a", name: "A歌", artist: "", path: "/a.mp3" }];
    const wrapper = mount(Playlist);
    expect(wrapper.text()).toContain("歌单是空的");
  });

  it("歌单视图：✕ 按钮从歌单移除（不删曲库歌曲）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    state.playlists = [{ id: "p1", name: "歌单", songPaths: ["/a.mp3", "/b.mp3"] }];
    state.activePlaylistId = "p1";
    state.songs = [
      { id: "a", name: "A歌", artist: "", path: "/a.mp3" },
      { id: "b", name: "B歌", artist: "", path: "/b.mp3" },
    ];
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pl-action.remove")[0].trigger("click");
    expect(state.playlists[0].songPaths).toEqual(["/b.mp3"]);
    expect(state.songs).toHaveLength(2); // 曲库不变
  });

  it("歌单视图：手柄始终可用（排序/过滤也可拖出加歌单）；列表内排序仅在无过滤时启用", async () => {
    state.playlists = [{ id: "p1", name: "歌单", songPaths: ["/a.mp3"] }];
    state.activePlaylistId = "p1";
    state.songs = [{ id: "a", name: "A歌", artist: "", path: "/a.mp3" }];
    const wrapper = mount(Playlist);
    expect(wrapper.find(".pl-drag").exists()).toBe(true);
    // 激活排序 → 手柄仍显示（可拖出到其他歌单），仅列表内排序禁用
    await wrapper.find(".pl-sort").setValue("name");
    expect(wrapper.find(".pl-drag").exists()).toBe(true);
    // 全部歌曲视图 + 排序 → 手柄仍显示
    state.activePlaylistId = null;
    expect(wrapper.find(".pl-drag").exists()).toBe(true);
  });

  // ============ 分组浏览（歌手/专辑） ============
  const SAMPLE = [
    {
      id: "a",
      path: "/Music/yakimochi.mp3",
      name: "ヤキモチ",
      artist: "高橋優",
      album: "開往明天的旅行",
    },
    { id: "b", path: "/Music/zhizu.mp3", name: "知足", artist: "五月天", album: "知足" },
    { id: "c", path: "/Music/wenrou.mp3", name: "溫柔", artist: "五月天", album: "知足" },
    { id: "d", path: "/Music/wugeshou.mp3", name: "无歌手歌", artist: "", album: "知足" },
  ];

  it("歌手 tab：聚合歌手卡片（计数 + 排序）", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[1].trigger("click"); // 歌手
    const cards = wrapper.findAll(".gr-card");
    expect(cards).toHaveLength(3);
    // zh collation 按拼音排序：高橋優(gao) < 未知歌手(wei) < 五月天(wu)
    const names = cards.map((c) => c.find(".gr-name").text());
    expect(names).toEqual(["高橋優", "未知歌手", "五月天"]);
    const wy = cards.find((c) => c.find(".gr-name").text() === "五月天");
    expect(wy.find(".gr-count").text()).toContain("2");
  });

  it("歌手卡：首字母色块显示首字符", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[1].trigger("click");
    const wy = wrapper.findAll(".gr-card").find((c) => c.find(".gr-name").text() === "五月天");
    expect(wy.find(".gr-avatar").text()).toBe("五");
  });

  it("专辑 tab：聚合专辑卡片（专辑名 + 歌手 + 封面）", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[2].trigger("click"); // 专辑
    const cards = wrapper.findAll(".gr-card");
    expect(cards).toHaveLength(2);
    // 同名专辑聚合，歌手去重显示
    const names = cards.map((c) => c.find(".gr-name").text());
    expect(names).toEqual(["開往明天的旅行", "知足"]);
    const zz = cards.find((c) => c.find(".gr-name").text() === "知足");
    expect(zz.find(".gr-count").text()).toContain("五月天");
    expect(zz.find(".gr-count").text()).toContain("3");
    // 封面 img 指向 /api/cover
    expect(zz.find(".gr-cover img").attributes("src")).toContain("/api/cover?path=");
  });

  it("专辑卡封面跟随「列表封面」设置：关闭后不渲染，重开恢复", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[2].trigger("click"); // 专辑
    // 默认开启：封面渲染
    expect(wrapper.find(".gr-cover img").exists()).toBe(true);
    // 关闭 → 封面区域整个不渲染（meta 仍在）
    uiSettings.showListCover = false;
    await nextTick();
    expect(wrapper.find(".gr-cover").exists()).toBe(false);
    expect(wrapper.find(".gr-name").exists()).toBe(true);
    // 重开 → 恢复
    uiSettings.showListCover = true;
    await nextTick();
    expect(wrapper.find(".gr-cover img").exists()).toBe(true);
  });

  it("列表行封面：有 path 的歌显示封面 img，无 path 不渲染 img 但留占位", () => {
    state.songs = [
      { id: "a", name: "A", artist: "", path: "/music/a.mp3" },
      { id: "b", name: "B", artist: "", path: null }, // 流媒体/网络歌
    ];
    const wrapper = mount(Playlist);
    const items = wrapper.findAll(".pl-item");
    // 有 path：封面 img 指向 /api/cover（桌面远程直出）
    const covA = items[0].find(".pl-cover img");
    expect(covA.exists()).toBe(true);
    expect(covA.attributes("src")).toContain(
      "/api/cover?path=" + encodeURIComponent("/music/a.mp3"),
    );
    // 无 path：img 不渲染，外层 span 仍占位（固定尺寸，行不跳动）
    expect(items[1].find(".pl-cover img").exists()).toBe(false);
    expect(items[1].find(".pl-cover").exists()).toBe(true);
  });

  it("列表行封面跟随「列表封面」设置：关闭后整个封面区不渲染，重开恢复", async () => {
    state.songs = [{ id: "a", name: "A", artist: "", path: "/music/a.mp3" }];
    const wrapper = mount(Playlist);
    expect(wrapper.find(".pl-cover img").exists()).toBe(true);
    uiSettings.showListCover = false;
    await nextTick();
    expect(wrapper.find(".pl-cover").exists()).toBe(false);
    expect(wrapper.find(".pl-name").exists()).toBe(true);
    uiSettings.showListCover = true;
    await nextTick();
    expect(wrapper.find(".pl-cover img").exists()).toBe(true);
  });

  it("点击歌手卡 → 列表只显示该歌手 + 返回条标题", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[1].trigger("click");
    await wrapper.findAll(".gr-card")[1].trigger("click"); // 未知歌手
    // 返回条：全部 + 分组名 + 首数
    expect(wrapper.find(".pl-filter-title").text()).toBe("未知歌手");
    expect(wrapper.text()).toContain("1 首");
    const items = wrapper.findAll(".pl-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("无歌手歌");
  });

  it("点击返回 → 回到歌手网格", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[1].trigger("click");
    await wrapper.findAll(".gr-card")[0].trigger("click"); // 五月天
    expect(wrapper.find(".pl-item").exists()).toBe(true);
    await wrapper.find(".pl-back").trigger("click");
    expect(wrapper.find(".gr-card").exists()).toBe(true);
    expect(wrapper.find(".pl-item").exists()).toBe(false);
  });

  it("分组内搜索只搜该分组", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[1].trigger("click");
    // 点“五月天”卡片（拼音序第三张）
    const wy = wrapper.findAll(".gr-card").find((c) => c.find(".gr-name").text() === "五月天");
    await wy.trigger("click");
    await wrapper.find(".pl-search input").setValue("溫柔");
    const items = wrapper.findAll(".pl-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("溫柔");
  });

  it("网格视图：搜索过滤卡片", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[1].trigger("click"); // 歌手
    await wrapper.find(".pl-search input").setValue("五月");
    const cards = wrapper.findAll(".gr-card");
    expect(cards).toHaveLength(1);
    expect(cards[0].find(".gr-name").text()).toBe("五月天");
  });

  it("切回全部歌曲 tab → 恢复完整列表", async () => {
    state.songs = SAMPLE;
    const wrapper = mount(Playlist);
    await wrapper.findAll(".pb-tab")[2].trigger("click"); // 专辑
    await wrapper.findAll(".gr-card")[0].trigger("click");
    expect(wrapper.find(".pl-item").exists()).toBe(true);
    await wrapper.findAll(".pb-tab")[0].trigger("click"); // 全部歌曲
    expect(wrapper.findAll(".pl-item")).toHaveLength(4);
    expect(wrapper.find(".pl-filter-bar").exists()).toBe(false);
  });

  it("歌单视图 + 分组过滤 → 手柄仍显示（可拖出加歌单），列表内排序禁", async () => {
    state.playlists = [{ id: "p1", name: "歌单", songPaths: ["/a.mp3", "/b.mp3"] }];
    state.activePlaylistId = "p1";
    state.songs = [
      { id: "a", name: "A歌", artist: "五月天", path: "/a.mp3" },
      { id: "b", name: "B歌", artist: "高橋優", path: "/b.mp3" },
    ];
    const wrapper = mount(Playlist);
    expect(wrapper.find(".pl-drag").exists()).toBe(true);
    await wrapper.findAll(".pb-tab")[1].trigger("click");
    await wrapper.findAll(".gr-card")[0].trigger("click"); // 进入歌手分组
    expect(wrapper.find(".pl-drag").exists()).toBe(true);
  });

  // ============ 加歌浮层：锚定触发按钮 ============
  describe("加歌浮层：锚定触发按钮", () => {
    // 行内按钮顺序：红心 → 加歌（ListPlus） → 移除
    const addBtn = (wrapper) => wrapper.findAll(".pl-action")[1];
    const menuEl = () => document.body.querySelector(".add-menu");
    const backdropEl = () => document.body.querySelector(".am-backdrop");
    // 统一登记 wrapper：断言失败也能在 afterEach 卸载，避免残留 Teleport DOM 污染后续测试
    const wrappers = [];
    const m = (w) => {
      wrappers.push(w);
      return w;
    };

    function mountWithSongs() {
      state.songs = [{ id: "a", name: "A歌", artist: "", path: "/a.mp3" }];
      return m(mount(Playlist));
    }

    // mock 触发按钮的 getBoundingClientRect，返回 spy 供后续改值模拟 resize/滚动
    function stubBtnRect(btn, rect) {
      return vi.spyOn(btn.element, "getBoundingClientRect").mockReturnValue({
        x: rect.left,
        y: rect.top,
        width: rect.right - rect.left,
        height: rect.bottom - rect.top,
        toJSON: () => ({}),
        ...rect,
      });
    }

    afterEach(() => {
      wrappers.splice(0).forEach((w) => w.unmount());
    });

    it("打开时定位到按钮下方、右缘对齐（jsdom 视口 1024×768）", async () => {
      const wrapper = mountWithSongs();
      stubBtnRect(addBtn(wrapper), { left: 400, top: 280, right: 428, bottom: 300 });
      await addBtn(wrapper).trigger("click");
      await nextTick();
      const menu = menuEl();
      expect(menu).toBeTruthy();
      expect(menu.style.top).toBe("306px"); // bottom(300) + 6
      expect(menu.style.left).toBe("208px"); // right(428) - 220 右对齐按钮右缘
    });

    it("右边界 clamp：按钮靠右时浮层不超出视口右缘", async () => {
      const wrapper = mountWithSongs();
      stubBtnRect(addBtn(wrapper), { left: 1000, top: 280, right: 1028, bottom: 300 });
      await addBtn(wrapper).trigger("click");
      await nextTick();
      const menu = menuEl();
      // right(1028) - 220 = 808 → clamp 到 1024 - 220 - 8 = 796
      expect(menu.style.left).toBe("796px");
      expect(menu.style.top).toBe("306px");
    });

    it("底部放不下时翻转到按钮上方", async () => {
      const wrapper = mountWithSongs();
      stubBtnRect(addBtn(wrapper), { left: 400, top: 680, right: 428, bottom: 700 });
      await addBtn(wrapper).trigger("click");
      await nextTick();
      const menu = menuEl();
      // below = 706，706 + 220 = 926 > 768 - 8 → 翻转：top = 680 - 220 - 6 = 454
      expect(menu.style.top).toBe("454px");
      expect(menu.style.left).toBe("208px");
    });

    it("resize 时按按钮新位置重算", async () => {
      const wrapper = mountWithSongs();
      const btn = addBtn(wrapper);
      const spy = stubBtnRect(btn, { left: 400, top: 280, right: 428, bottom: 300 });
      await btn.trigger("click");
      await nextTick();
      expect(menuEl().style.top).toBe("306px");
      // 窗口变化 → 按钮重新布局到更靠下位置（仍在下方放得下）
      spy.mockReturnValue({
        x: 400,
        y: 400,
        width: 28,
        height: 20,
        toJSON: () => ({}),
        left: 400,
        top: 400,
        right: 428,
        bottom: 420,
      });
      window.dispatchEvent(new Event("resize"));
      await nextTick();
      expect(menuEl().style.top).toBe("426px"); // 420 + 6
    });

    it("列表滚动时重算位置（捕获阶段监听任意滚动容器）", async () => {
      // attachTo 使 .pl-list 真正挂到 document，滚动事件才能沿捕获路径传到 window
      state.songs = [{ id: "a", name: "A歌", artist: "", path: "/a.mp3" }];
      const wrapper = m(mount(Playlist, { attachTo: document.body }));
      const btn = addBtn(wrapper);
      const spy = stubBtnRect(btn, { left: 400, top: 280, right: 428, bottom: 300 });
      await btn.trigger("click");
      await nextTick();
      expect(menuEl().style.top).toBe("306px");
      // 列表向下滚动 → 按钮 rect 变化
      spy.mockReturnValue({
        x: 400,
        y: 500,
        width: 28,
        height: 20,
        toJSON: () => ({}),
        left: 400,
        top: 500,
        right: 428,
        bottom: 520,
      });
      wrapper.find(".pl-list").element.dispatchEvent(new Event("scroll", { bubbles: true }));
      await nextTick();
      expect(menuEl().style.top).toBe("526px"); // 520 + 6
    });

    it("点击 backdrop 关闭浮层", async () => {
      const wrapper = mountWithSongs();
      await addBtn(wrapper).trigger("click");
      await nextTick();
      expect(menuEl()).toBeTruthy();
      backdropEl().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await nextTick();
      expect(menuEl()).toBeNull();
    });

    it("Esc 关闭浮层", async () => {
      const wrapper = mountWithSongs();
      await addBtn(wrapper).trigger("click");
      await nextTick();
      expect(menuEl()).toBeTruthy();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await nextTick();
      expect(menuEl()).toBeNull();
    });

    it("位置纯函数：正常 / 右边界 / 底部翻转 / 左侧兜底 / 顶部兜底", () => {
      const wrapper = mountWithSongs();
      const { computeAddMenuPos } = wrapper.vm;
      // 正常：按钮下方 + 右对齐右缘
      expect(
        computeAddMenuPos({ left: 400, top: 280, right: 428, bottom: 300 }, 220, 1024, 768),
      ).toEqual({
        top: 306,
        left: 208,
        flip: false,
      });
      // 右边界 clamp
      expect(
        computeAddMenuPos({ left: 1000, top: 280, right: 1028, bottom: 300 }, 220, 1024, 768).left,
      ).toBe(796);
      // 底部溢出 → 翻转
      expect(
        computeAddMenuPos({ left: 400, top: 680, right: 428, bottom: 700 }, 220, 1024, 768),
      ).toEqual({
        top: 454,
        left: 208,
        flip: true,
      });
      // 极窄视口：右缘 - 220 为负 → 左边界兜底 8
      expect(
        computeAddMenuPos({ left: 20, top: 280, right: 48, bottom: 300 }, 220, 200, 768).left,
      ).toBe(8);
      // 按钮滚出视口上方 → top 兜底到留白
      expect(
        computeAddMenuPos({ left: 400, top: -500, right: 428, bottom: -480 }, 220, 1024, 768).top,
      ).toBe(8);
    });
  });
});
