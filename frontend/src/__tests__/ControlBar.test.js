// ControlBar 入口测试：歌曲信息编辑按钮（打开 TagEditorModal）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

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
const { state, playbackSettings } = await import("../composables/usePlayer.js");

const SONG = { path: "/music/a.mp3", name: "A", artist: "X", album: "Y" };

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    lyricFormat: null,
  });
  playbackSettings.visualizerEnabled = true;
  playbackSettings.miniSpectrumEnabled = true;
  // jsdom 无 canvas 2d → MiniSpectrum paint 静默返回（不抛错即可）
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.querySelectorAll(".modal-mask, .tag-toast").forEach((n) => n.remove());
});

describe("ControlBar 迷你频谱条（任务 C）", () => {
  it("桌面端默认渲染迷你频谱（data-testid 存在且可见）", () => {
    const w = mount(ControlBar);
    const el = w.find('[data-testid="mini-spectrum"]');
    expect(el.exists()).toBe(true);
    expect(el.isVisible()).toBe(true);
    w.unmount();
  });

  it("迷你频谱子开关关闭 → v-show 隐藏", async () => {
    const w = mount(ControlBar);
    playbackSettings.miniSpectrumEnabled = false;
    await nextTick();
    const el = w.find('[data-testid="mini-spectrum"]');
    expect(el.exists()).toBe(true);
    expect(el.element.style.display).toBe("none");
    w.unmount();
  });

  it("视觉化总开关关闭 → 迷你频谱隐藏", async () => {
    const w = mount(ControlBar);
    playbackSettings.visualizerEnabled = false;
    await nextTick();
    const el = w.find('[data-testid="mini-spectrum"]');
    expect(el.element.style.display).toBe("none");
    w.unmount();
  });
});

describe("ControlBar 歌曲编辑入口", () => {
  it("有 currentSong 时显示编辑按钮，点击打开 TagEditorModal", async () => {
    state.currentSong = { ...SONG };
    const w = mount(ControlBar);
    const btn = w.find('[data-testid="song-edit-btn"]');
    expect(btn.exists()).toBe(true);
    btn.trigger("click");
    await nextTick();
    // 弹窗 Teleport 到 body：展示当前歌曲信息
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    expect(root.textContent).toContain("编辑歌曲信息");
    expect(root.textContent).toContain("A");
    w.unmount();
  });

  it("无 currentSong 时不显示编辑按钮", () => {
    const w = mount(ControlBar);
    expect(w.find('[data-testid="song-edit-btn"]').exists()).toBe(false);
    w.unmount();
  });
});
