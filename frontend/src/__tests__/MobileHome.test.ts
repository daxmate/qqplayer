// MobileHome 测试：一列入口列表（6 项音乐入口）+ 顶栏入口 + 打开文件导入
// 智能视图入口已随列表化移除（图书/视频/有声书改为主层级分页屏）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { VueWrapper, DOMWrapper } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
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
  });
  useSearchAnything().isSearchOpen.value = false;
  clearToasts();
  resetDragState();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rowByText(wrapper: VueWrapper, text: string): DOMWrapper<Element> {
  return wrapper.findAll(".mh-row").find((c) => c.text().includes(text))!;
}

describe("MobileHome 入口列表（一列 6 项，仅音乐）", () => {
  it("渲染 6 个音乐入口行；无图书/视频/智能视图入口", () => {
    const wrapper = mount(MobileHome);
    expect(wrapper.findAll(".mh-row").length).toBe(6);
    const text = wrapper.text();
    expect(text).toContain("所有歌曲");
    expect(text).toContain("我喜欢的音乐");
    expect(text).toContain("播放列表");
    expect(text).toContain("艺术家");
    expect(text).toContain("专辑");
    expect(text).toContain("打开文件");
    // 图书/视频/智能视图入口已从首页移除（改为主层级分页屏）
    expect(text).not.toContain("图书");
    expect(text).not.toContain("视频");
    expect(text).not.toContain("最近添加");
    expect(text).not.toContain("最近播放");
    expect(text).not.toContain("常听排行");
  });

  it("所有歌曲行：数量随曲库变化 + 点击 open songs 列表", async () => {
    const wrapper = mount(MobileHome);
    const row = rowByText(wrapper, "所有歌曲");
    expect(row.text()).toContain("2 首");
    await row.trigger("click");
    const opens = wrapper.emitted("open")!;
    expect(opens[0][0]).toMatchObject({ name: "list", kind: "songs", title: "所有歌曲" });
  });

  it("收藏行：数量随收藏变化（实际收藏计数）", async () => {
    const wrapper = mount(MobileHome);
    expect(rowByText(wrapper, "我喜欢的音乐").text()).toContain("0 首");
    state.favorites = ["/lib/a.mp3"];
    await flushPromises();
    expect(rowByText(wrapper, "我喜欢的音乐").text()).toContain("1 首");
  });

  it("播放列表/艺术家/专辑行数量", () => {
    state.playlists = [{ id: "p1", name: "我的歌单", songPaths: [] }];
    const wrapper = mount(MobileHome);
    expect(rowByText(wrapper, "播放列表").text()).toContain("1 个");
    expect(rowByText(wrapper, "艺术家").text()).toContain("2 位");
    expect(rowByText(wrapper, "专辑").text()).toContain("2 张");
  });

  it("艺术家/专辑分组与桌面一致：未知值归一化 + 排序", () => {
    state.songs = [
      { id: "x", path: "/lib/x.mp3", name: "X", artist: "", album: "" },
      { id: "y", path: "/lib/y.mp3", name: "Y", artist: "五月天", album: "" },
      { id: "z", path: "/lib/z.mp3", name: "Z", artist: "五月天", album: "" },
    ];
    const wrapper = mount(MobileHome);
    expect(rowByText(wrapper, "艺术家").text()).toContain("2 位"); // 未知歌手 + 五月天
    expect(rowByText(wrapper, "专辑").text()).toContain("1 张"); // 三首都归一化为未知专辑
  });

  it("入口行点击转发 open 事件（播放列表 → 分组列表）", async () => {
    const wrapper = mount(MobileHome);
    await rowByText(wrapper, "播放列表").trigger("click");
    const opens = wrapper.emitted("open")!;
    expect(opens[0][0]).toMatchObject({ name: "list", kind: "playlists" });
  });
});

describe("MobileHome 顶栏入口", () => {
  it("搜索入口 → 打开全局 search anything 搜索层（isSearchOpen 置真，不再导航列表页）", async () => {
    const wrapper = mount(MobileHome);
    await wrapper.find('.mh-icon-btn[title="搜索歌曲"]').trigger("click");
    expect(useSearchAnything().isSearchOpen.value).toBe(true);
    expect(wrapper.emitted("open")).toBeFalsy();
  });

  it("设置入口 → open-settings 事件（MobileShell 内部转发 → 负一屏设置区）", async () => {
    const wrapper = mount(MobileHome);
    await wrapper.find('.mh-icon-btn[title="设置"]').trigger("click");
    expect(wrapper.emitted("open-settings")).toBeTruthy();
  });
});

describe("MobileHome 打开文件", () => {
  it("打开文件：选择音频 → POST /api/import（FormData files）→ toast 实际导入数（skipped 合并）", async () => {
    const fetchMock = vi.fn(async (url: string, _opt: RequestInit) => {
      if (url === "/api/import") {
        return { ok: true, json: async () => ({ imported: 2, skipped: 1, errors: 0 }) };
      }
      return { ok: true, json: async () => ({ records: [] }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(MobileHome);
    const input = wrapper.find(".mh-file-input");
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "a.mp3", { type: "audio/mpeg" }), new File(["x"], "b.mp3")],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    const importCall = fetchMock.mock.calls.find(([url]) => url === "/api/import");
    expect(importCall).toBeTruthy();
    expect(importCall![1].method).toBe("POST");
    expect(importCall![1].body).toBeInstanceOf(FormData);
    expect((importCall![1].body as FormData).getAll("files").map((f) => (f as File).name)).toEqual([
      "a.mp3",
      "b.mp3",
    ]);
    expect(useToast().items[0].text).toBe("已导入 2 首；跳过 1 首");
  });

  it("上传失败 → toastError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    const wrapper = mount(MobileHome);
    const input = wrapper.find(".mh-file-input");
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "a.mp3")],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    expect(useToast().items[0].type).toBe("error");
    expect(useToast().items[0].text).toBe("导入失败，请重试");
  });

  it("选择全非音频文件：toastError，不发请求", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const wrapper = mount(MobileHome);
    const input = wrapper.find(".mh-file-input");
    Object.defineProperty(input.element, "files", {
      value: [new File(["x"], "a.txt")],
      configurable: true,
    });
    await input.trigger("change");
    await flushPromises();
    expect(useToast().items[0].type).toBe("error");
    expect(useToast().items[0].text).toBe("没有可导入的音频文件");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
