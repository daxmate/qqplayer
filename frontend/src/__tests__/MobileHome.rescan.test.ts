// MobileHome 重新扫描曲库入口测试（任务 I-12）
// 覆盖：点击触发 loadSongs（GET /api/songs）/ 进行中状态（转圈 + 禁用）/ 成功 toast「已刷新」/ 失败 toastError
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";

// Audio stub
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const MobileHome = (await import("../components/mobile/MobileHome.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { useSearchAnything } = await import("../composables/useSearchAnything.js");
const { closeSmartView } = await import("../composables/useSmartViews.js");
const { clearToasts, useToast } = await import("../composables/useToast.js");
const { resetDragState } = await import("../composables/useDragImport.js");

const lib = [
  { id: "a", path: "/lib/a.mp3", name: "雪の華", artist: "中島美嘉", album: "雪の華" },
  { id: "b", path: "/lib/b.mp3", name: "知足", artist: "五月天", album: "知足" },
];

beforeEach(() => {
  Object.assign(state, {
    songs: lib,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    loading: false,
    error: "",
  });
  useSearchAnything().isSearchOpen.value = false;
  closeSmartView();
  clearToasts();
  resetDragState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rescanBtn(wrapper: VueWrapper) {
  return wrapper.find('.mh-icon-btn[title="重新扫描"]');
}

describe("MobileHome 重新扫描曲库入口", () => {
  it("顶栏渲染重扫按钮（刷新图标）", () => {
    const wrapper = mount(MobileHome);
    expect(rescanBtn(wrapper).exists()).toBe(true);
  });

  it("点击 → 调 loadSongs（GET /api/songs）→ 完成 toast「已刷新」", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/songs") return { ok: true, json: async () => lib };
      return { ok: true, json: async () => ({ records: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(MobileHome);
    await rescanBtn(wrapper).trigger("click");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledWith("/api/songs", expect.anything());
    expect(state.songs.length).toBe(2);
    expect(useToast().items[0].text).toBe("已刷新");
    expect(rescanBtn(wrapper).classes()).not.toContain("spinning"); // 结束后停止转圈
    expect(rescanBtn(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("进行中状态：转圈动画 + 按钮禁用（请求未返回期间）", async () => {
    // 释放开关：释放前所有 fetch 挂起（记录 resolve），释放后立即返回
    let released = false;
    const pending: Array<{ url: string; resolve: (value: unknown) => void }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string): Promise<unknown> => {
        if (released)
          return Promise.resolve({ ok: true, json: async () => (url === "/api/songs" ? lib : []) });
        return new Promise((resolve) => pending.push({ url, resolve }));
      }),
    );
    const wrapper = mount(MobileHome);
    await rescanBtn(wrapper).trigger("click");
    expect(rescanBtn(wrapper).classes()).toContain("spinning");
    expect(rescanBtn(wrapper).attributes("disabled")).toBeDefined();
    // 释放所有挂起请求（loadSongs 内部还会发歌词等后续请求，走 released 分支立即完成）
    released = true;
    pending.forEach(({ url, resolve }) =>
      resolve({ ok: true, json: async () => (url === "/api/songs" ? lib : []) }),
    );
    await flushPromises();
    expect(rescanBtn(wrapper).classes()).not.toContain("spinning");
    expect(rescanBtn(wrapper).attributes("disabled")).toBeUndefined();
  });

  it("进行中重复点击被忽略（只发一次 /api/songs）", async () => {
    let released = false;
    const pending: Array<{ url: string; resolve: (value: unknown) => void }> = [];
    const fetchMock = vi.fn((url: string): Promise<unknown> => {
      if (released)
        return Promise.resolve({ ok: true, json: async () => (url === "/api/songs" ? lib : []) });
      return new Promise((resolve) => pending.push({ url, resolve }));
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(MobileHome);
    await rescanBtn(wrapper).trigger("click");
    await rescanBtn(wrapper).trigger("click");
    await rescanBtn(wrapper).trigger("click");
    expect(fetchMock.mock.calls.filter(([url]) => url === "/api/songs").length).toBe(1);
    released = true;
    pending.forEach(({ resolve }) => resolve({ ok: true, json: async () => lib }));
    await flushPromises();
  });

  it("刷新失败（后端异常）→ toastError，不显示「已刷新」", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const wrapper = mount(MobileHome);
    await rescanBtn(wrapper).trigger("click");
    await flushPromises();
    expect(useToast().items[0].type).toBe("error");
    expect(useToast().items[0].text).toContain("network down");
  });
});
