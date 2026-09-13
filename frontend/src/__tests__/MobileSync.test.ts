// MobileSync.vue 同步面板组件测试（负一屏 / 移动设置区）
//
// 覆盖：结构渲染（头部 + 阅读数据 + 词典清单 + 开关组）、上次同步时间文案、开关点击生效、返回事件。
// 说明：设备端区块（同步全部 / 音乐 / 图书下载 / 下载面板 / 存储管理 / 孤儿清理）随 iOS 壳
// 2026-09-13 退役一并移除，本文件不再覆盖。
// mock 策略：vi.mock sync.js —— 保留真实 reactive syncState / syncNow 等数据层；
// setter 与 assetForDict 替换为可控 vi.fn。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../utils/sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncNow: vi.fn(async () => ({ ok: true, enabled: true })),
    assetForDict: vi.fn(async (d: { path?: string } | null | undefined) => ({
      path: "dicts/" + (d?.path ?? "x") + ".mdx",
      url: "",
      sha256: "",
      size: 0,
    })),
    wifiOnlyEnabled: vi.fn(() => true),
    setWifiOnly: vi.fn((on: boolean) => on),
    autoUpdateEnabled: vi.fn(() => false),
    setAutoUpdate: vi.fn((on: boolean) => on),
    autoPrefetchEnabled: vi.fn(() => false),
    setAutoPrefetch: vi.fn((on: boolean) => on),
  };
});

import { syncNow, setWifiOnly, setAutoUpdate, setAutoPrefetch, syncState } from "../utils/sync.js";
import MobileSync from "../components/mobile/MobileSync.vue";

const mockedSyncNow = vi.mocked(syncNow);
const mockedSetWifiOnly = vi.mocked(setWifiOnly);
const mockedSetAutoUpdate = vi.mocked(setAutoUpdate);
const mockedSetAutoPrefetch = vi.mocked(setAutoPrefetch);

beforeEach(() => {
  vi.clearAllMocks();
  syncState.lastSyncAt = null;
  syncState.syncing = false;
  syncState.lastError = "";
});

describe("MobileSync 同步面板", () => {
  it("渲染：标题 / 上次同步时间（从未）/ 阅读数据区块 / 词典空态 / 开关组（三个）", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    expect(wrapper.find(".msc-title").text()).toBe("同步中心");
    expect(wrapper.find(".msc-last").text()).toBe("尚未同步");
    // 阅读标注 + 生词区块（数据层：随同步拉取）
    expect(wrapper.text()).toContain("阅读标注与生词");
    // 词典区块：无清单 → 空态文案
    expect(wrapper.text()).toContain("词典");
    expect(wrapper.findAll(".msc-toggle-row").length).toBe(3);
    wrapper.unmount();
  });

  it("上次同步时间：syncState.lastSyncAt 有值 → 渲染本地时间字符串", async () => {
    syncState.lastSyncAt = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const wrapper = mount(MobileSync);
    await flushPromises();
    expect(wrapper.find(".msc-last").text()).not.toBe("尚未同步");
    wrapper.unmount();
  });

  it("嵌入模式（embedded）：隐藏自身头部，仍渲染开关组", async () => {
    const wrapper = mount(MobileSync, { props: { embedded: true } });
    await flushPromises();
    expect(wrapper.find(".msc-head").exists()).toBe(false);
    expect(wrapper.findAll(".msc-toggle-row").length).toBe(3);
    wrapper.unmount();
  });

  it("挂载即拉清单（syncNow）并刷新阅读数据", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    expect(mockedSyncNow).toHaveBeenCalled();
    wrapper.unmount();
  });

  it("点击「刷新」阅读数据（reSync）→ 再次调用 syncNow", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    mockedSyncNow.mockClear();
    await wrapper.find(".msc-group .msc-btn").trigger("click");
    await flushPromises();
    expect(mockedSyncNow).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("开关点击：仅 Wi-Fi / 自动更新 / 自动预取 分别调用对应 setter 并翻转 UI", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    const rows = wrapper.findAll(".msc-toggle-row");
    await rows[0].trigger("click");
    expect(mockedSetWifiOnly).toHaveBeenCalledWith(false); // 初始 true → 点击关
    await rows[1].trigger("click");
    expect(mockedSetAutoUpdate).toHaveBeenCalledWith(true); // 初始 false → 点击开
    await rows[2].trigger("click");
    expect(mockedSetAutoPrefetch).toHaveBeenCalledWith(true);
    // UI 开关态跟随 setter 返回值
    expect(rows[0].find(".switch").classes()).not.toContain("on");
    expect(rows[1].find(".switch").classes()).toContain("on");
    wrapper.unmount();
  });

  it("非嵌入模式点击返回 → emit('back')", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    await wrapper.find(".msc-back").trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
    wrapper.unmount();
  });
});
