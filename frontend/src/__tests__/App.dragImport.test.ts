// App 拖拽导入：window 级监听绑定（mount 后响应文件拖拽、卸载清理）+ drop 上传链路
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { installMatchMedia } from "./helpers/matchMedia.js";

// matchMedia stub 必须在 import App 之前（useMobileViewport 模块加载时读取）
installMatchMedia(false); // 初始桌面布局；返回值不需要（本文件不切换断点）

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

const App = (await import("../App.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { clearToasts, useToast } = await import("../composables/useToast.js");
const { resetDragState, dragVisible } = await import("../composables/useDragImport.js");

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
  });
  resetDragState();
  clearToasts();
  // App onMounted 会 loadSongs/loadFavorites/loadPlaylists 等 → 全部 stub
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      if (url === "/api/import") {
        return { ok: true, json: async () => ({ imported: 1, skipped: 0, errors: 0 }) };
      }
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// 构造带 dataTransfer 的 window 事件（jsdom 的 DragEvent 不支持 dataTransfer 赋值）
function fireFileEvent(type: string, files: File[]) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, "dataTransfer", { value: { types: ["Files"], files } });
  window.dispatchEvent(ev);
  return ev;
}

describe("App 拖拽导入遮罩", () => {
  it("mount 后监听：文件拖入显示遮罩「松开导入曲库」，计数归零隐藏", async () => {
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".drag-overlay").exists()).toBe(false);

    fireFileEvent("dragenter", []);
    fireFileEvent("dragenter", []);
    await wrapper.vm.$nextTick();
    const overlay = wrapper.find(".drag-overlay");
    expect(overlay.exists()).toBe(true);
    expect(overlay.text()).toContain("松开导入曲库");

    fireFileEvent("dragleave", []);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".drag-overlay").exists()).toBe(true); // 计数 1 未归零仍显示
    fireFileEvent("dragleave", []);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".drag-overlay").exists()).toBe(false);
    wrapper.unmount();
  });

  it("drop 音频文件 → POST /api/import（FormData files）→ toast 已导入 1 首，遮罩隐藏", async () => {
    const wrapper = mount(App);
    await flushPromises();
    fireFileEvent("dragenter", []);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".drag-overlay").exists()).toBe(true);

    fireFileEvent("drop", [new File(["x"], "a.mp3")]);
    await flushPromises();

    expect(wrapper.find(".drag-overlay").exists()).toBe(false);
    const fetchMock = vi.mocked(globalThis.fetch);
    const importCall = fetchMock.mock.calls.find(([url]) => url === "/api/import");
    expect(importCall).toBeTruthy();
    const [, init] = importCall!;
    expect(init!.method).toBe("POST");
    const body = init!.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.getAll("files").map((f) => (f as File).name)).toEqual(["a.mp3"]);
    const { items } = useToast();
    expect(items[0].type).toBe("success");
    expect(items[0].text).toBe("已导入 1 首");
    wrapper.unmount();
  });

  it("卸载清理：监听移除且计数复位，卸载后 dragenter 不再计数", async () => {
    const wrapper = mount(App);
    await flushPromises();
    fireFileEvent("dragenter", []);
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".drag-overlay").exists()).toBe(true); // mount 后监听生效
    wrapper.unmount();
    fireFileEvent("dragenter", []);
    expect(dragVisible.value).toBe(false); // 监听已移除 + 计数已复位
  });
});
