// ControlBar.vue 下载当前网络歌按钮测试（任务 F）
// 当前歌是网络歌（type=stream 曲库网络歌 / type=preview 试听）时显示下载按钮；
// 本地歌不显示；点击 → POST /api/online/download 下载当前歌，成功/失败 toast。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";

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
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const ControlBar = (await import("../components/ControlBar.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { downloadSettings } = await import("../composables/useSettings.js");
const { useToast, clearToasts } = await import("../composables/useToast.js");

// 曲库网络歌 currentSong 结构（与后端 /api/songs type=stream 条目一致）
const STREAM_SONG = {
  type: "stream",
  streamId: "777",
  provider: "netease",
  path: null,
  name: "稻香",
  artist: "周杰伦",
};
// 试听歌 currentSong 结构（playerCore.toPreviewSong）
const PREVIEW_SONG = {
  type: "preview",
  streamId: "888",
  provider: "netease",
  path: null,
  name: "晴天",
  artist: "周杰伦",
};
const LOCAL_SONG = { id: "a", name: "A歌", artist: "五月天", path: "/a.mp3" };

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    lyricFormat: null,
  });
  downloadSettings.defaultQuality = "exhigh";
  // jsdom 无 canvas 2d → MiniSpectrum paint 静默返回
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearToasts();
  document.body.querySelectorAll(".modal-mask, .tag-toast, .url-mask").forEach((n) => n.remove());
});

describe("ControlBar 下载当前网络歌", () => {
  it("当前歌是曲库网络歌（type=stream）→ 显示下载按钮", () => {
    state.currentSong = { ...STREAM_SONG };
    const w = mount(ControlBar);
    const btn = w.find('[data-testid="download-btn"]');
    expect(btn.exists()).toBe(true);
    expect(btn.isVisible()).toBe(true);
    w.unmount();
  });

  it("当前歌是试听歌（type=preview）→ 显示下载按钮", () => {
    state.currentSong = { ...PREVIEW_SONG };
    const w = mount(ControlBar);
    expect(w.find('[data-testid="download-btn"]').exists()).toBe(true);
    w.unmount();
  });

  it("当前歌是本地歌 → 不显示下载按钮", () => {
    state.currentSong = { ...LOCAL_SONG };
    const w = mount(ControlBar);
    expect(w.find('[data-testid="download-btn"]').exists()).toBe(false);
    w.unmount();
  });

  it("无 currentSong → 不显示下载按钮", () => {
    const w = mount(ControlBar);
    expect(w.find('[data-testid="download-btn"]').exists()).toBe(false);
    w.unmount();
  });

  it("点击下载当前网络歌 → POST /api/online/download 参数正确，成功 toast", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts) => {
        calls.push({ url: String(url), opts });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, path: "/lib/稻香-周杰伦.mp3" }),
        };
      }),
    );
    state.currentSong = { ...STREAM_SONG };
    const w = mount(ControlBar);
    await w.find('[data-testid="download-btn"]').trigger("click");
    await flushPromises();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/online/download");
    expect(calls[0].opts.method).toBe("POST");
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      id: "777",
      level: downloadSettings.defaultQuality,
      title: "稻香",
      artist: "周杰伦",
    });
    const toasts = useToast().items;
    expect(toasts.some((t) => t.text.includes("已开始下载") && t.text.includes("稻香"))).toBe(true);
    // 下载完成后按钮恢复（不再旋转）
    expect(w.find('[data-testid="download-btn"] .dl-spin').exists()).toBe(false);
    w.unmount();
  });

  it("下载中显示 Loader2 旋转（busy 态）", async () => {
    let resolveFetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    state.currentSong = { ...STREAM_SONG };
    const w = mount(ControlBar);
    await w.find('[data-testid="download-btn"]').trigger("click");
    await flushPromises();
    const btn = w.find('[data-testid="download-btn"]');
    expect(btn.find(".dl-spin").exists()).toBe(true);
    expect(btn.classes()).toContain("busy");
    resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, path: "/lib/x.mp3" }) });
    await flushPromises();
    expect(w.find('[data-testid="download-btn"] .dl-spin').exists()).toBe(false);
    w.unmount();
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
    state.currentSong = { ...PREVIEW_SONG };
    const w = mount(ControlBar);
    await w.find('[data-testid="download-btn"]').trigger("click");
    await flushPromises();
    const err = useToast().items.find((t) => t.type === "error");
    expect(err).toBeTruthy();
    expect(err.text).toContain("下载失败");
    expect(err.text).toContain("无法获取下载链接");
    w.unmount();
  });
});
