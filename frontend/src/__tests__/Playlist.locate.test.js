// Playlist.vue 定位当前播放测试（任务 A 第二项）
// 覆盖：工具条按钮点击 → 滚动 .pl-list 到当前行 + 临时高亮；EQ 标记点击同效果；
//      搜索/过滤中当前行不可见 → toast 提示；无当前歌 → 按钮禁用；网格视图不显示按钮。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
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
const { useToast, clearToasts } = await import("../composables/useToast.js");

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
  clearToasts();
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

function toastText() {
  return useToast()
    .items.map((i) => i.text)
    .join(" ");
}

// 让 .pl-list 是滚动容器、当前行在视口下方 → 点定位应把 scrollTop 滚到行顶
// rowIdx：定位目标是第几行（EQ 在当前行上，测试常需指定）
function stubScrollGeometry(wrapper, rowIdx = 0) {
  const list = wrapper.find(".pl-list").element;
  const row = wrapper.findAll(".pl-item")[rowIdx].element;
  list.getBoundingClientRect = () => ({
    top: 0,
    bottom: 100,
    left: 0,
    right: 200,
    width: 200,
    height: 100,
  });
  row.getBoundingClientRect = () => ({
    top: 300,
    bottom: 330,
    left: 0,
    right: 200,
    width: 200,
    height: 30,
  });
  Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
  list.scrollTop = 0;
  return { list, row };
}

describe("Playlist 定位当前播放", () => {
  it("工具条有定位按钮（icon + title）", () => {
    const wrapper = mountSongs();
    const btn = wrapper.find(".pl-locate");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("title")).toBe("定位当前播放");
  });

  it("无当前播放歌 → 按钮禁用", () => {
    const wrapper = mountSongs();
    expect(wrapper.find(".pl-locate").attributes("disabled")).toBeDefined();
  });

  it("点击定位按钮 → 滚动 .pl-list 到当前行 + 行临时高亮", async () => {
    state.currentIndex = 0;
    state.currentSong = SONGS[0];
    const wrapper = mountSongs();
    const { list, row } = stubScrollGeometry(wrapper);
    await wrapper.find(".pl-locate").trigger("click");
    await nextTick();
    // 行在视口下方（relTop=300 > viewTop=0）→ scrollTop 滚到 300-6（内边距留白）
    expect(list.scrollTop).toBe(294);
    expect(row.classList.contains("pl-locate")).toBe(true);
  });

  it("当前行已在视口内 → 不滚动但高亮", async () => {
    state.currentIndex = 0;
    state.currentSong = SONGS[0];
    const wrapper = mountSongs();
    const list = wrapper.find(".pl-list").element;
    const row = wrapper.find(".pl-item").element;
    list.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      width: 200,
    });
    row.getBoundingClientRect = () => ({
      top: 20,
      bottom: 50,
      height: 30,
      left: 0,
      right: 200,
      width: 200,
    });
    Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    list.scrollTop = 0;
    await wrapper.find(".pl-locate").trigger("click");
    await nextTick();
    expect(list.scrollTop).toBe(0); // 视口内不动
    expect(row.classList.contains("pl-locate")).toBe(true);
  });

  it("点击当前行上的 EQ 标记 → 同样定位滚动（title 提示）", async () => {
    state.currentIndex = 1;
    state.currentSong = SONGS[1];
    const wrapper = mountSongs();
    expect(wrapper.find(".pl-eq").exists()).toBe(true);
    expect(wrapper.find(".pl-eq").attributes("title")).toBe("定位当前播放");
    const { list, row } = stubScrollGeometry(wrapper, 1); // 当前行是第 2 行
    await wrapper.find(".pl-eq").trigger("click");
    await nextTick();
    expect(list.scrollTop).toBe(294);
    expect(row.classList.contains("pl-locate")).toBe(true);
  });

  it("EQ 标记只出现在当前播放行", () => {
    state.currentIndex = 1;
    state.currentSong = SONGS[1];
    const wrapper = mountSongs();
    expect(wrapper.findAll(".pl-eq")).toHaveLength(1);
    expect(wrapper.findAll(".pl-item")[1].find(".pl-eq").exists()).toBe(true);
  });

  it("搜索/过滤中当前行不可见 → 按钮仍可用，点击 toast 提示", async () => {
    state.currentIndex = 0;
    state.currentSong = SONGS[0]; // A歌
    const wrapper = mountSongs();
    await wrapper.find(".pl-search input").setValue("B歌"); // 只显示 B
    await nextTick();
    expect(wrapper.findAll(".pl-item")).toHaveLength(1);
    await wrapper.find(".pl-locate").trigger("click");
    await nextTick();
    expect(toastText()).toContain("当前播放歌曲不在此列表");
  });

  it("网格视图（歌手 tab）→ 不显示定位按钮", async () => {
    state.currentIndex = 0;
    state.currentSong = SONGS[0];
    const wrapper = mountSongs();
    await wrapper.findAll(".pb-tab")[1].trigger("click"); // 歌手
    expect(wrapper.find(".pl-locate").exists()).toBe(false);
  });

  it("歌单视图内定位同样有效（当前行在歌单里）", async () => {
    state.playlists = [{ id: "p1", name: "歌单", songPaths: ["/a.mp3", "/b.mp3"] }];
    state.activePlaylistId = "p1";
    state.currentIndex = 1;
    state.currentSong = SONGS[1];
    const wrapper = mountSongs();
    const list = wrapper.find(".pl-list").element;
    const row = wrapper.findAll(".pl-item")[1].element;
    list.getBoundingClientRect = () => ({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      width: 200,
    });
    row.getBoundingClientRect = () => ({
      top: 300,
      bottom: 330,
      height: 30,
      left: 0,
      right: 200,
      width: 200,
    });
    Object.defineProperty(list, "clientHeight", { value: 100, configurable: true });
    list.scrollTop = 0;
    await wrapper.find(".pl-locate").trigger("click");
    await nextTick();
    expect(list.scrollTop).toBe(294);
    await flushPromises();
  });
});
