// Playlist.vue 队列拖拽排序测试（任务 A 第三项）+ 拖拽加歌单数据源（任务 A 第一项）
// 覆盖：全部歌曲视图无过滤时拖拽手柄可见（可排序队列）；搜索/排序/收藏/分组过滤时隐藏；
//      dragstart 写入歌曲路径（自定义 MIME，避开 sortablejs 的 Text 槽位）；网络歌不可拖。
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
  removeAttribute() {}
}
vi.stubGlobal("Audio", FakeAudio);

const Playlist = (await import("../components/Playlist.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { DRAG_SONG_TYPE } = await import("../composables/usePlayer.js");

const SONGS = [
  { id: "a", name: "A歌", artist: "五月天", path: "/a.mp3" },
  { id: "b", name: "B歌", artist: "高橋優", path: "/b.mp3" },
  { id: "c", name: "C歌", artist: "五月天", path: "/c.mp3" },
];

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
  wrappers.splice(0).forEach((w) => w.unmount());
  document.body.querySelectorAll(".add-menu, .am-backdrop").forEach((el) => el.remove());
});

const wrappers = [];

function mountSongs(songs = SONGS) {
  state.songs = songs.map((s) => ({ ...s }));
  const wrapper = mount(Playlist);
  wrappers.push(wrapper);
  return wrapper;
}

describe("Playlist 队列拖拽排序（全部歌曲视图）", () => {
  it("全部歌曲视图 + 默认状态 → 拖拽手柄可见（可排队列）", async () => {
    const wrapper = mountSongs();
    await nextTick();
    expect(wrapper.findAll(".pl-drag")).toHaveLength(3);
  });

  it("搜索过滤 → 手柄隐藏", async () => {
    const wrapper = mountSongs();
    await wrapper.find(".pl-search input").setValue("B歌");
    await nextTick();
    expect(wrapper.find(".pl-drag").exists()).toBe(false);
  });

  it("排序（按标题）→ 手柄隐藏", async () => {
    const wrapper = mountSongs();
    await wrapper.find(".pl-sort").setValue("name");
    await nextTick();
    expect(wrapper.find(".pl-drag").exists()).toBe(false);
  });

  it("只看收藏 → 手柄隐藏", async () => {
    const wrapper = mountSongs();
    await wrapper.find(".pl-fav-btn").trigger("click");
    await nextTick();
    expect(wrapper.find(".pl-drag").exists()).toBe(false);
  });

  it("分组过滤（进入歌手）→ 手柄隐藏", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pb-tab")[1].trigger("click"); // 歌手 tab
    const card = wrapper.findAll(".gr-card").find((c) => c.find(".gr-name").text() === "五月天");
    await card.trigger("click");
    await nextTick();
    expect(wrapper.find(".pl-drag").exists()).toBe(false);
  });

  it("歌单视图 + 默认状态 → 手柄仍可见（歌单内排序，回归）", async () => {
    state.playlists = [{ id: "p1", name: "歌单", songPaths: ["/a.mp3", "/b.mp3"] }];
    state.activePlaylistId = "p1";
    const wrapper = mountSongs();
    await nextTick();
    expect(wrapper.findAll(".pl-drag")).toHaveLength(2);
  });

  it("网格视图（歌手 tab）→ 无列表行，无手柄", async () => {
    const wrapper = mountSongs();
    await wrapper.findAll(".pb-tab")[1].trigger("click");
    await nextTick();
    expect(wrapper.find(".pl-drag").exists()).toBe(false);
    expect(wrapper.find(".pl-item").exists()).toBe(false);
  });
});

describe("Playlist 拖拽到歌单（dragstart 数据源）", () => {
  it("拖手柄 → dataTransfer 写入歌曲路径（自定义 MIME）+ effectAllowed=copy", async () => {
    const wrapper = mountSongs();
    await nextTick();
    const handle = wrapper.findAll(".pl-drag")[0];
    const dt = { setData: vi.fn(), effectAllowed: "" };
    await handle.trigger("dragstart", { dataTransfer: dt });
    expect(dt.setData).toHaveBeenCalledWith(DRAG_SONG_TYPE, "/a.mp3");
    expect(dt.effectAllowed).toBe("copy");
  });

  it("网络歌（path=null）→ 阻止拖拽，不写数据", async () => {
    const wrapper = mountSongs([
      { id: "s", name: "网歌", type: "stream", streamId: "1", path: null },
      { id: "a", name: "A歌", path: "/a.mp3" },
    ]);
    await nextTick();
    const dt = { setData: vi.fn(), effectAllowed: "" };
    // 手动 dispatch：拿到事件对象断言 defaultPrevented
    const evt = new Event("dragstart", { bubbles: true, cancelable: true });
    evt.dataTransfer = dt;
    wrapper.findAll(".pl-drag")[0].element.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(dt.setData).not.toHaveBeenCalled();
    // 本地歌正常写入
    const dt2 = { setData: vi.fn(), effectAllowed: "" };
    await wrapper.findAll(".pl-drag")[1].trigger("dragstart", { dataTransfer: dt2 });
    expect(dt2.setData).toHaveBeenCalledWith(DRAG_SONG_TYPE, "/a.mp3");
  });
});
