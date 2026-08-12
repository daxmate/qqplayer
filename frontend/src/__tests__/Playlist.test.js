// Playlist 组件测试
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";

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
const { state, isFavorite } = await import("../composables/usePlayer.js");

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    loading: false,
    error: "",
    favorites: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
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
});
