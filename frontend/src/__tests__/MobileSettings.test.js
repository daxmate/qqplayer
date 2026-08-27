// MobileSettings 测试：负一屏设置区（汉堡抽屉 + 设置面板 + 返回）
// 覆盖：默认同步面板（MobileSync embedded）/ 抽屉开关 / 点分类切换面板（SettingsModal 嵌入式）/
//       返回事件 / 遮罩点击关闭抽屉
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import SettingsModal（连带 usePlayer）前注册）
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
  delete window.qqplayerIosBridge;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete window.qqplayerIosBridge;
  document.body.innerHTML = "";
});

async function openDrawer(wrapper) {
  await wrapper.find(".ms-burger").trigger("click");
  await flushPromises();
}

describe("MobileSettings 负一屏设置区", () => {
  it("初始面板 = 同步（MobileSync embedded 渲染，无自身头部）", () => {
    const wrapper = mount(MobileSettings);
    expect(wrapper.find(".ms-page").exists()).toBe(true);
    expect(wrapper.find(".msc-page").exists()).toBe(true); // MobileSync 面板
    expect(wrapper.find(".msc-head").exists()).toBe(false); // embedded 隐藏自身头部
    // 标题显示当前面板名「同步」
    expect(wrapper.find(".ms-title").text()).toBe("同步");
  });

  it("汉堡 → 抽屉打开（列出设置分类），点遮罩关闭", async () => {
    const wrapper = mount(MobileSettings);
    expect(wrapper.find(".ms-drawer").exists()).toBe(false);
    await openDrawer(wrapper);
    expect(wrapper.find(".ms-drawer").exists()).toBe(true);
    const items = wrapper.findAll(".ms-drawer-item");
    expect(items.length).toBeGreaterThan(0);
    // 当前面板「同步」高亮
    expect(items.find((b) => b.text().includes("同步")).classes()).toContain("on");
    // 点遮罩（非抽屉本体）关闭
    await wrapper.find(".ms-drawer-mask").trigger("click");
    await flushPromises();
    expect(wrapper.find(".ms-drawer").exists()).toBe(false);
  });

  it("点分类（界面）→ 切换为 SettingsModal 嵌入式面板，抽屉关闭", async () => {
    const wrapper = mount(MobileSettings);
    await openDrawer(wrapper);
    await wrapper
      .findAll(".ms-drawer-item")
      .find((b) => b.text().includes("界面"))
      .trigger("click");
    await flushPromises();
    // 抽屉关闭 + 面板切换
    expect(wrapper.find(".ms-drawer").exists()).toBe(false);
    expect(wrapper.find(".msc-page").exists()).toBe(false); // 同步面板已退出
    expect(wrapper.find(".modal-mask.embedded").exists()).toBe(true); // SettingsModal 嵌入式
    expect(wrapper.find(".ms-title").text()).toBe("界面");
    // 嵌入式面板内容渲染（settings-scroll 区域）
    expect(wrapper.find(".modal-mask.embedded .settings-scroll").exists()).toBe(true);
  });

  it("切回同步面板 → 恢复 MobileSync", async () => {
    const wrapper = mount(MobileSettings);
    await openDrawer(wrapper);
    await wrapper
      .findAll(".ms-drawer-item")
      .find((b) => b.text().includes("界面"))
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".msc-page").exists()).toBe(false);
    await openDrawer(wrapper);
    await wrapper
      .findAll(".ms-drawer-item")
      .find((b) => b.text().includes("同步"))
      .trigger("click");
    await flushPromises();
    expect(wrapper.find(".msc-page").exists()).toBe(true);
    expect(wrapper.find(".modal-mask.embedded").exists()).toBe(false);
  });

  it("返回按钮 → back 事件（壳层 pop 回音乐页）", async () => {
    const wrapper = mount(MobileSettings);
    await wrapper.find(".ms-back").trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy();
  });
});
