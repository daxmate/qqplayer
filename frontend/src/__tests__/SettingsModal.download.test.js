// SettingsModal 下载分类测试：导航渲染 / 默认值 / chip 选择写入 downloadSettings
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick } from "vue";

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

const SettingsModal = (await import("../components/SettingsModal.vue")).default;
const { downloadSettings } = await import("../composables/useSettings.js");

beforeEach(() => {
  Object.assign(downloadSettings, { downloadDir: "", defaultQuality: "exhigh" });
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsModal 下载分类", () => {
  it("左侧导航出现「下载」分类，点击后显示下载设置", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    // 导航项
    const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("下载"),
    );
    expect(navItem).toBeTruthy();
    await navItem.click();
    await nextTick();
    // 下载分类内容：目录输入 + 默认音质 chips
    expect(root.textContent).toContain("下载目录");
    expect(root.textContent).toContain("留空 = 下载到当前曲库");
    expect(root.textContent).toContain("默认音质");
    const chips = [...root.querySelectorAll(".ext-chip")].map((el) => el.textContent.trim());
    expect(chips).toEqual(["标准 128k", "极高 320k", "无损 FLAC", "Hi-Res"]);
    w.unmount();
  });

  it("默认值：目录为空 + 音质 exhigh（极高 320k 选中）", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("下载"),
    );
    await navItem.click();
    await nextTick();
    const input = root.querySelector("input.lib-input");
    expect(input.value).toBe("");
    const onChip = [...root.querySelectorAll(".ext-chip")].find((el) =>
      el.classList.contains("on"),
    );
    expect(onChip.textContent).toContain("极高 320k");
    w.unmount();
  });

  it("点击音质 chip → 写入 downloadSettings.defaultQuality", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("下载"),
    );
    await navItem.click();
    await nextTick();
    const chips = [...root.querySelectorAll(".ext-chip")];
    await chips[2].click(); // 无损 FLAC
    await nextTick();
    expect(downloadSettings.defaultQuality).toBe("lossless");
    expect(chips[2].classList.contains("on")).toBe(true);
    expect(chips[1].classList.contains("on")).toBe(false);
    w.unmount();
  });

  it("下载目录输入 → 写入 downloadSettings.downloadDir", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("下载"),
    );
    await navItem.click();
    await nextTick();
    const input = root.querySelector("input.lib-input");
    input.value = "/Users/me/Music/Downloads";
    await input.dispatchEvent(new Event("input"));
    await nextTick();
    expect(downloadSettings.downloadDir).toBe("/Users/me/Music/Downloads");
    w.unmount();
  });
});
