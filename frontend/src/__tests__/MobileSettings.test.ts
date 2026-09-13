// MobileSettings 测试：负一屏设置区（汉堡抽屉 + 设置面板 + 返回）
// 覆盖：默认面板（第一个设置分类，SettingsModal 嵌入式）/ 抽屉开关 / 点分类切换面板 /
//       返回事件 / 遮罩点击关闭抽屉
// （原「默认同步面板 MobileSync」相关用例随 iOS 壳同步中心面板退役移除，2026-09-13）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises, type VueWrapper } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import SettingsModal（连带 usePlayer）前注册）
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

const MobileSettings = (await import("../components/mobile/MobileSettings.vue")).default;

beforeEach(() => {
  // SettingsModal 面板按需加载等网络请求全部 stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function openDrawer(wrapper: VueWrapper) {
  await wrapper.find(".ms-burger").trigger("click");
  await flushPromises();
}

describe("MobileSettings 负一屏设置区", () => {
  it("初始面板 = 第一个设置分类（界面，SettingsModal 嵌入式渲染）", () => {
    const wrapper = mount(MobileSettings);
    expect(wrapper.find(".ms-page").exists()).toBe(true);
    expect(wrapper.find(".modal-mask.embedded").exists()).toBe(true); // SettingsModal 嵌入式
    expect(wrapper.find(".modal-mask.embedded .settings-scroll").exists()).toBe(true);
    // 标题显示当前面板名「界面」
    expect(wrapper.find(".ms-title").text()).toBe("界面");
  });

  it("汉堡 → 抽屉打开（列出设置分类），点遮罩关闭", async () => {
    const wrapper = mount(MobileSettings);
    expect(wrapper.find(".ms-drawer").exists()).toBe(false);
    await openDrawer(wrapper);
    expect(wrapper.find(".ms-drawer").exists()).toBe(true);
    const items = wrapper.findAll(".ms-drawer-item");
    expect(items.length).toBeGreaterThan(0);
    // 当前面板「界面」高亮
    expect(items.find((b) => b.text().includes("界面"))!.classes()).toContain("on");
    // 点遮罩（非抽屉本体）关闭
    await wrapper.find(".ms-drawer-mask").trigger("click");
    await flushPromises();
    expect(wrapper.find(".ms-drawer").exists()).toBe(false);
  });

  it("点分类（歌词）→ 切换为对应设置面板，抽屉关闭", async () => {
    const wrapper = mount(MobileSettings);
    await openDrawer(wrapper);
    await wrapper
      .findAll(".ms-drawer-item")
      .find((b) => b.text().includes("歌词"))!
      .trigger("click");
    await flushPromises();
    // 抽屉关闭 + 面板切换
    expect(wrapper.find(".ms-drawer").exists()).toBe(false);
    expect(wrapper.find(".ms-title").text()).toBe("歌词");
    // 嵌入式面板内容渲染（settings-scroll 区域）
    expect(wrapper.find(".modal-mask.embedded .settings-scroll").exists()).toBe(true);
  });

  it("切换分类后切回第一个分类 → 面板跟随切换", async () => {
    const wrapper = mount(MobileSettings);
    await openDrawer(wrapper);
    await wrapper
      .findAll(".ms-drawer-item")
      .find((b) => b.text().includes("歌词"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".ms-title").text()).toBe("歌词");
    await openDrawer(wrapper);
    await wrapper
      .findAll(".ms-drawer-item")
      .find((b) => b.text().includes("界面"))!
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".ms-title").text()).toBe("界面");
    expect(wrapper.find(".modal-mask.embedded").exists()).toBe(true);
  });

  it("返回按钮 → back 事件（壳层 pop 回音乐页）", async () => {
    const wrapper = mount(MobileSettings);
    await wrapper.find(".ms-back").trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy();
  });
});
