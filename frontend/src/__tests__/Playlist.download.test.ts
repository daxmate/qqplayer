// Playlist.vue 网络歌行内下载按钮测试（任务 F）
// 网络歌（type=stream / path=null）行操作区显示下载按钮 → POST /api/online/download
// 下载中显示 Loader2 旋转；成功/失败 toast；本地歌不显示下载按钮。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};

  constructor() {
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
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
  removeAttribute() {}
}
vi.stubGlobal("Audio", FakeAudio);

const Playlist = (await import("../components/Playlist.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { downloadSettings } = await import("../composables/useSettings.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

// 曲库网络条目结构（与后端 /api/songs 的 type=stream 条目一致）
const NET = {
  type: "stream",
  streamId: "123456",
  provider: "netease",
  path: null,
  name: "晴天",
  artist: "周杰伦",
};
const LOCAL = { id: "a", name: "A歌", artist: "五月天", path: "/a.mp3" };

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
  downloadSettings.defaultQuality = "exhigh";
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearToasts();
  document.body.querySelectorAll(".add-menu, .am-backdrop").forEach((el) => el.remove());
});

describe("Playlist 网络歌下载按钮", () => {
  it("网络歌行显示下载按钮，本地歌不显示", () => {
    state.songs = [NET, LOCAL];
    const wrapper = mount(Playlist);
    const dlButtons = wrapper.findAll(".pl-action.dl");
    expect(dlButtons).toHaveLength(1);
    // 下载按钮所在行是网络歌行
    const item = dlButtons[0].element.closest(".pl-item");
    expect(item!.textContent).toContain("晴天");
    wrapper.unmount();
  });

  it("点击下载 → POST /api/online/download 参数正确（id/title/artist/level），成功 toast", async () => {
    const calls: Array<{ url: string; opts: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: RequestInfo | URL, opts?: RequestInit) => {
        calls.push({ url: String(url), opts: opts ?? {} });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, path: "/lib/晴天-周杰伦.mp3" }),
        };
      }),
    );
    state.songs = [NET];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-action.dl").trigger("click");
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/online/download");
    expect(calls[0].opts.method).toBe("POST");
    expect(JSON.parse(calls[0].opts.body as string)).toEqual({
      id: "123456",
      level: downloadSettings.defaultQuality,
      title: "晴天",
      artist: "周杰伦",
    });
    // 成功 toast
    const toasts = useToast().items;
    expect(toasts.some((t) => t.text.includes("已开始下载") && t.text.includes("晴天"))).toBe(true);
    // 下载完成后按钮恢复为 Download 图标（不再旋转）
    expect(wrapper.find(".pl-action.dl .pl-spin").exists()).toBe(false);
    wrapper.unmount();
  });

  it("下载中显示 Loader2 旋转（busy 态），完成后恢复", async () => {
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    state.songs = [NET];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-action.dl").trigger("click");
    await flushPromises();
    // 下载未完成：显示旋转图标 + busy class
    expect(wrapper.find(".pl-action.dl .pl-spin").exists()).toBe(true);
    expect(wrapper.find(".pl-action.dl").classes()).toContain("busy");
    // 完成
    resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, path: "/lib/x.mp3" }) });
    await flushPromises();
    expect(wrapper.find(".pl-action.dl .pl-spin").exists()).toBe(false);
    wrapper.unmount();
  });

  it("下载失败 → toastError（后端 404 error 透传）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 404,
        json: async () => ({ error: "无法获取下载链接" }),
      })),
    );
    state.songs = [NET];
    const wrapper = mount(Playlist);
    await wrapper.find(".pl-action.dl").trigger("click");
    await flushPromises();
    const toasts = useToast().items;
    const err = toasts.find((t) => t.type === "error");
    expect(err).toBeTruthy();
    expect(err!.text).toContain("下载失败");
    expect(err!.text).toContain("无法获取下载链接");
    wrapper.unmount();
  });

  it("下载中再次点击不重复请求（按 streamId 防重入）", async () => {
    const calls: number[] = [];
    let resolveFetch!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            calls.push(1);
            resolveFetch = resolve;
          }),
      ),
    );
    state.songs = [NET];
    const wrapper = mount(Playlist);
    const btn = wrapper.find(".pl-action.dl");
    await btn.trigger("click");
    await flushPromises();
    await btn.trigger("click");
    await flushPromises();
    expect(calls).toHaveLength(1); // 第二次点击被忽略
    resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, path: "/lib/x.mp3" }) });
    await flushPromises();
    wrapper.unmount();
  });
});
