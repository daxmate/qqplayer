// Cover 组件测试（任务 K：显示封面开关 showCover）
// 覆盖：默认显示封面图；showCover=false 时隐藏但保留占位（visibility:hidden，不折叠布局）；设置持久化
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

const Cover = (await import("../components/Cover.vue")).default;
const { state, uiSettings, UI_SETTINGS_KEY } = await import("../composables/usePlayer.js");

// localStorage stub（持久化断言用）
const lsStore = {};
const localStorageStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => {
    lsStore[k] = String(v);
  },
  removeItem: (k) => {
    delete lsStore[k];
  },
};

beforeEach(() => {
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  uiSettings.showCover = true;
  state.currentSong = { path: "/fake/song.mp3", name: "Fake" };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountCover(props = {}) {
  return mount(Cover, { props });
}

describe("showCover 显示封面开关", () => {
  it("默认 true：显示封面图（img 渲染）", () => {
    expect(uiSettings.showCover).toBe(true);
    const w = mountCover({ song: { path: "/a.mp3", name: "A" } });
    expect(w.find("img.cover-img").exists()).toBe(true);
    expect(w.find(".cover-wrap").classes()).not.toContain("no-cover");
    w.unmount();
  });

  it("showCover=false：隐藏但保留占位（img 仍在 DOM，盒子尺寸不折叠）", async () => {
    const w = mountCover({ song: { path: "/a.mp3", name: "A" } });
    expect(w.find("img.cover-img").exists()).toBe(true);
    uiSettings.showCover = false;
    await nextTick();
    // no-cover 类 → visibility:hidden：img 还在 DOM（不是 v-if 移除），布局盒子保留
    expect(w.find(".cover-wrap").classes()).toContain("no-cover");
    expect(w.find("img.cover-img").exists()).toBe(true);
    expect(w.find(".cover-box").exists()).toBe(true);
    w.unmount();
  });

  it("重新开启后恢复显示（no-cover 类移除）", async () => {
    const w = mountCover({ song: { path: "/a.mp3", name: "A" } });
    uiSettings.showCover = false;
    await nextTick();
    expect(w.find(".cover-wrap").classes()).toContain("no-cover");
    uiSettings.showCover = true;
    await nextTick();
    expect(w.find(".cover-wrap").classes()).not.toContain("no-cover");
    w.unmount();
  });

  it("small 变体同样生效（移动端/列表行）", async () => {
    const w = mountCover({ song: { path: "/a.mp3", name: "A" }, small: true });
    expect(w.find(".cover-wrap.small").exists()).toBe(true);
    uiSettings.showCover = false;
    await nextTick();
    expect(w.find(".cover-wrap.small.no-cover").exists()).toBe(true);
    w.unmount();
  });

  it("无封面歌（coverUrl 空）回退占位图标，不受开关影响", async () => {
    const w = mountCover({ song: { name: "NoCover" } });
    expect(w.find(".cover-fallback").exists()).toBe(true);
    uiSettings.showCover = false;
    await nextTick();
    // 占位仍在（隐藏由 no-cover 类统一控制，不额外移除）
    expect(w.find(".cover-fallback").exists()).toBe(true);
    w.unmount();
  });

  it("设置持久化：切换 showCover 写入 UI_SETTINGS_KEY 缓存", async () => {
    localStorage.removeItem(UI_SETTINGS_KEY);
    uiSettings.showCover = false;
    await nextTick(); // settingsSync deep watch → 写透本地缓存
    const saved = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY));
    expect(saved.showCover).toBe(false);
    uiSettings.showCover = true;
    await nextTick();
    const saved2 = JSON.parse(localStorage.getItem(UI_SETTINGS_KEY));
    expect(saved2.showCover).toBe(true);
  });
});
