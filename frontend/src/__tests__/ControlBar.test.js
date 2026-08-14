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
const { state } = await import("../composables/usePlayer.js");

const SONG = { path: "/music/a.mp3", name: "A", artist: "X", album: "Y" };

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    lyricFormat: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.querySelectorAll(".modal-mask, .tag-toast").forEach((n) => n.remove());
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
