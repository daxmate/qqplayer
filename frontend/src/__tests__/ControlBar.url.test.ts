// ControlBar 播放 URL 入口测试（任务 B）
// 覆盖：URL 按钮 → 弹窗打开 / 非法 URL 提示不关闭 / 合法 URL → playUrl（试听语义）/
// 电台流 URL 不崩
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  ended = false;
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
  removeAttribute() {}
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const ControlBar = (await import("../components/ControlBar.vue")).default;
const { state } = await import("../composables/usePlayer.js");

// 网络直链 → 同源代理 URL（与 playerCore.streamProxyUrl 同款格式）
const PROXY_SRC = (u: string) => "/api/stream/proxy?url=" + encodeURIComponent(u);

let wrapper: VueWrapper | null = null;

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    currentTime: 0,
    duration: 0,
    isPlaying: false,
    mode: "continuous",
    playMode: "order",
    lyricFormat: null,
    volume: 1.0,
    muted: false,
  });
  const a = FakeAudio.instances[0];
  if (a) {
    a.src = "";
    a.paused = true;
    a.currentTime = 0;
  }
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const u = String(url);
      if (u.startsWith("/api/lyric/search")) {
        return { ok: true, json: async () => ({ results: [] }) };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.querySelectorAll(".url-mask").forEach((n) => n.remove());
  vi.unstubAllGlobals();
});

function findUrlBtn(w: VueWrapper) {
  return w.findAll(".btn").find((b) => b.attributes("title") === "播放 URL");
}

describe("ControlBar 播放 URL 入口", () => {
  it("按钮存在；点击打开 URL 弹窗（Teleport body）", async () => {
    wrapper = mount(ControlBar);
    const btn = findUrlBtn(wrapper)!;
    expect(btn).toBeTruthy();
    await btn.trigger("click");
    await nextTick();
    const mask = document.body.querySelector(".url-mask")!;
    expect(mask).toBeTruthy();
    expect(mask.querySelector("input")).toBeTruthy();
    wrapper.unmount();
  });

  it("非法 URL → 提示错误，弹窗不关闭，不播放", async () => {
    wrapper = mount(ControlBar);
    await findUrlBtn(wrapper)!.trigger("click");
    await nextTick();
    const input = document.body.querySelector(".url-input") as HTMLInputElement;
    input.value = "ftp://example.com/a.mp3";
    await input.dispatchEvent(new Event("input"));
    await document.body
      .querySelector(".url-btn.primary")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector(".url-err")).toBeTruthy(); // 非法提示
    expect(document.body.querySelector(".url-mask")).toBeTruthy(); // 弹窗未关
    expect(state.currentSong).toBeNull(); // 未播放
    expect(FakeAudio.instances[0].src).toBe("");
    wrapper.unmount();
  });

  it("空输入 → 提示错误（http/https 校验）", async () => {
    wrapper = mount(ControlBar);
    await findUrlBtn(wrapper)!.trigger("click");
    await nextTick();
    await document.body
      .querySelector(".url-btn.primary")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector(".url-err")).toBeTruthy();
    wrapper.unmount();
  });

  it("合法 URL → playUrl 试听语义播放（弹窗关闭、currentSong=url 歌）", async () => {
    wrapper = mount(ControlBar);
    await findUrlBtn(wrapper)!.trigger("click");
    await nextTick();
    const input = document.body.querySelector(".url-input") as HTMLInputElement;
    input.value = "https://example.com/radio/station.mp3";
    await input.dispatchEvent(new Event("input"));
    await document.body
      .querySelector(".url-btn.primary")!
      .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(document.body.querySelector(".url-mask")).toBeFalsy(); // 弹窗已关
    expect(state.currentSong!.type).toBe("url");
    expect(state.currentSong!.name).toBe("station.mp3");
    expect(FakeAudio.instances[0].src).toBe(PROXY_SRC("https://example.com/radio/station.mp3"));
    wrapper.unmount();
  });

  it("Enter 键提交合法 URL；电台流 URL 不崩（duration=Infinity → 保持 0）", async () => {
    wrapper = mount(ControlBar);
    await findUrlBtn(wrapper)!.trigger("click");
    await nextTick();
    const input = document.body.querySelector(".url-input") as HTMLInputElement;
    input.value = "https://radio.example.com/live";
    await input.dispatchEvent(new Event("input"));
    await input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await flushPromises();
    expect(state.currentSong!.type).toBe("url");
    const a = FakeAudio.instances[0];
    a.duration = Infinity;
    a.listeners["loadedmetadata"]?.();
    expect(state.duration).toBe(0); // 电台流无时长 → 进度条空态
    expect(state.currentSong!.name).toBe("live"); // 无文件名取域名
    wrapper.unmount();
  });

  it("取消按钮关闭弹窗，不播放", async () => {
    wrapper = mount(ControlBar);
    await findUrlBtn(wrapper)!.trigger("click");
    await nextTick();
    const cancelBtn = [...document.body.querySelectorAll(".url-btn")].find((b) =>
      b.textContent.includes("取消"),
    )!;
    await cancelBtn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(document.body.querySelector(".url-mask")).toBeFalsy();
    expect(state.currentSong).toBeNull();
    wrapper.unmount();
  });
});
