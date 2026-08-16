// Sidebar.vue 拖拽加歌单测试（任务 A 第一项）
// 覆盖：歌曲行拖过歌单项 → 高亮（sb-drop）；离开取消高亮；drop → addToPlaylist + toast「已加入」；
//      已在歌单 → toast「已在」不重复添加；非歌曲拖拽（文件/文本）不响应；dragend 全局清理高亮。
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

const Sidebar = (await import("../components/Sidebar.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { DRAG_SONG_TYPE } = await import("../composables/usePlayer.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

const PLAYLISTS = [
  { id: "p1", name: "旅行", songPaths: ["/b.mp3"], createdAt: "", updatedAt: "" },
  { id: "p2", name: "日语歌", songPaths: [], createdAt: "", updatedAt: "" },
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
  state.playlists = PLAYLISTS.map((p) => ({ ...p, songPaths: [...p.songPaths] }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  wrappers.splice(0).forEach((w) => w.unmount());
});

const wrappers = [];

function mountSidebar() {
  const wrapper = mount(Sidebar);
  wrappers.push(wrapper);
  return wrapper;
}

function toastText() {
  return useToast()
    .items.map((i) => i.text)
    .join(" ");
}

// 歌单项 DOM（按歌单名 title 定位）
const plItem = (wrapper, name) => wrapper.find(`[title="${name}"]`);

// 歌曲拖拽的 dataTransfer 假对象
function songDataTransfer(path) {
  return {
    types: [DRAG_SONG_TYPE],
    getData: vi.fn((type) => (type === DRAG_SONG_TYPE ? path : "")),
    dropEffect: "",
  };
}

// 文件拖拽（系统文件导入）的 dataTransfer：应被忽略
function fileDataTransfer() {
  return { types: ["Files"], getData: vi.fn(() => ""), dropEffect: "" };
}

describe("Sidebar 拖拽加歌单", () => {
  it("歌曲拖过歌单项 → 高亮（sb-drop class）", async () => {
    const wrapper = mountSidebar();
    const item = plItem(wrapper, "旅行");
    expect(item.classes()).not.toContain("sb-drop");
    await item.trigger("dragover", { dataTransfer: songDataTransfer("/a.mp3") });
    await nextTick();
    expect(plItem(wrapper, "旅行").classes()).toContain("sb-drop");
    // 其他歌单项不高亮
    expect(plItem(wrapper, "日语歌").classes()).not.toContain("sb-drop");
  });

  it("文件拖拽（Files 类型）→ 不响应（留给导入遮罩）", async () => {
    const wrapper = mountSidebar();
    const item = plItem(wrapper, "旅行");
    await item.trigger("dragover", { dataTransfer: fileDataTransfer() });
    await nextTick();
    expect(item.classes()).not.toContain("sb-drop");
  });

  it("dragleave（离开歌单项）→ 取消高亮；移入子元素不取消", async () => {
    const wrapper = mountSidebar();
    const item = plItem(wrapper, "旅行");
    await item.trigger("dragover", { dataTransfer: songDataTransfer("/a.mp3") });
    expect(item.classes()).toContain("sb-drop");
    // relatedTarget 仍在项内（拖过子元素）→ 不高亮切换
    await item.trigger("dragleave", { relatedTarget: item.element });
    expect(item.classes()).toContain("sb-drop");
    // relatedTarget 在项外 → 取消高亮
    await item.trigger("dragleave", { relatedTarget: wrapper.element });
    expect(item.classes()).not.toContain("sb-drop");
  });

  it("drop 到歌单 → addToPlaylist（幂等去重后添加）+ toast「已加入」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const wrapper = mountSidebar();
    await plItem(wrapper, "日语歌").trigger("drop", {
      dataTransfer: songDataTransfer("/a.mp3"),
    });
    await nextTick();
    const pl = state.playlists.find((p) => p.id === "p2");
    expect(pl.songPaths).toEqual(["/a.mp3"]);
    expect(toastText()).toContain("已加入歌单「日语歌」");
    // 高亮已清理
    expect(plItem(wrapper, "日语歌").classes()).not.toContain("sb-drop");
  });

  it("drop 已在歌单的歌 → toast「已在」，不重复添加", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({}) })),
    );
    const wrapper = mountSidebar();
    await plItem(wrapper, "旅行").trigger("drop", {
      dataTransfer: songDataTransfer("/b.mp3"),
    });
    await nextTick();
    expect(state.playlists.find((p) => p.id === "p1").songPaths).toEqual(["/b.mp3"]);
    expect(toastText()).toContain("已在歌单「旅行」中");
    expect(toastText()).not.toContain("已加入");
  });

  it("drop 非歌曲拖拽（文件）→ 忽略，歌单不变", async () => {
    const wrapper = mountSidebar();
    await plItem(wrapper, "日语歌").trigger("drop", { dataTransfer: fileDataTransfer() });
    await nextTick();
    expect(state.playlists.find((p) => p.id === "p2").songPaths).toEqual([]);
    expect(toastText()).toBe("");
  });

  it("drop 后歌单持久化失败 → toastError（乐观更新回滚）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, json: async () => ({}) })),
    );
    const wrapper = mountSidebar();
    await plItem(wrapper, "日语歌").trigger("drop", {
      dataTransfer: songDataTransfer("/a.mp3"),
    });
    await nextTick();
    // addToPlaylist 乐观更新后回滚
    expect(state.playlists.find((p) => p.id === "p2").songPaths).toEqual([]);
    expect(toastText()).toContain("加入歌单失败");
  });

  it("全局 dragend（拖到空白处松手）→ 清理高亮", async () => {
    const wrapper = mountSidebar();
    await plItem(wrapper, "旅行").trigger("dragover", { dataTransfer: songDataTransfer("/a.mp3") });
    expect(plItem(wrapper, "旅行").classes()).toContain("sb-drop");
    window.dispatchEvent(new Event("dragend"));
    await nextTick();
    expect(plItem(wrapper, "旅行").classes()).not.toContain("sb-drop");
  });
});
