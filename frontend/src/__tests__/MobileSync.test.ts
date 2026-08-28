// MobileSync.vue 负一屏同步中心组件测试
// 覆盖：整体结构渲染（头部/主按钮/音乐/图书/词典/下载面板/存储细分/孤儿/开关）、
//       存储细分按类型显示、开关点击生效、返回事件。
// mock 策略：vi.mock sync.js —— 保留真实 reactive syncState/syncDownloads，
//   异步数据函数（computeSyncOverview / fetchAssetsSizeDetailed / syncAll 等）替换为可控 vi.fn；
//   apiClient / nativeAudioBridge 走真实模块（jsdom 无原生环境 → 内部 no-op）。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const overviewData = {
  ok: true,
  missing: { audio: 1, covers: 2, books: 0, dicts: 1 },
  updateCount: 1,
  orphans: [{ path: "audio/orphan.m4a", size: 77 }],
  orphanSize: 77,
  assets: [{ path: "audio/a.m4a", sha256: "", size: 1 }],
  songs: [],
  dicts: [],
  manifest: {},
};

vi.mock("../utils/sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncNow: vi.fn(async () => ({ ok: true, enabled: true })),
    computeSyncOverview: vi.fn(async () => ({ ...overviewData })),
    fetchAssetsSizeDetailed: vi.fn(async () => ({
      total: 1000,
      byType: { audio: 400, covers: 100, lyric: 50, books: 300, dicts: 100, meta: 30, other: 20 },
    })),
    syncAll: vi.fn(async () => ({ ok: true, sent: true, missing: overviewData.missing })),
    wifiOnlyEnabled: vi.fn(() => true),
    setWifiOnly: vi.fn((on: boolean) => on),
    autoUpdateEnabled: vi.fn(() => false),
    setAutoUpdate: vi.fn((on: boolean) => on),
    autoPrefetchEnabled: vi.fn(() => false),
    setAutoPrefetch: vi.fn((on: boolean) => on),
    clearAssetsByType: vi.fn(() => 1),
    deleteOrphanAssets: vi.fn(() => true),
    waitAssetsDeleted: vi.fn(async () => []),
  };
});

import {
  syncAll,
  setWifiOnly,
  setAutoUpdate,
  setAutoPrefetch,
  computeSyncOverview,
  fetchAssetsSizeDetailed,
} from "../utils/sync.js";
import MobileSync from "../components/mobile/MobileSync.vue";

// vi.mock 替换后的 mock 函数（运行时即上述 vi.fn，此处仅类型收窄）
const mockedSyncAll = vi.mocked(syncAll);
const mockedSetWifiOnly = vi.mocked(setWifiOnly);
const mockedSetAutoUpdate = vi.mocked(setAutoUpdate);
const mockedSetAutoPrefetch = vi.mocked(setAutoPrefetch);
const mockedComputeSyncOverview = vi.mocked(computeSyncOverview);
const mockedFetchAssetsSizeDetailed = vi.mocked(fetchAssetsSizeDetailed);

beforeEach(() => {
  vi.clearAllMocks();
  mockedComputeSyncOverview.mockResolvedValue({ ...overviewData });
  mockedFetchAssetsSizeDetailed.mockResolvedValue({
    total: 1000,
    byType: { audio: 400, covers: 100, lyric: 50, books: 300, dicts: 100, meta: 30, other: 20 },
  });
});

describe("MobileSync 负一屏同步中心", () => {
  it("渲染：标题 / 同步全部主按钮（徽标 = 缺失 + 可更新）/ 各分区", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    expect(wrapper.find(".msc-page").exists()).toBe(true);
    expect(wrapper.find(".msc-title").text()).toBe("同步中心");
    expect(wrapper.find(".msc-sync-all").text()).toContain("同步全部");
    // 徽标：缺失 1+2+0+1=4 + 可更新 1 = 5
    expect(wrapper.find(".msc-badge").text()).toBe("5");
    // 分区标题
    const text = wrapper.text();
    expect(text).toContain("音乐");
    expect(text).toContain("图书");
    expect(text).toContain("阅读标注与生词"); // P2-B：标注/生词同步状态区
    expect(text).toContain("暂无标注与生词"); // 空态（无缓存数据）
    expect(text).toContain("词典");
    expect(text).toContain("下载状态");
    expect(text).toContain("存储管理");
    expect(text).toContain("清理未引用");
    expect(text).toContain("仅 Wi-Fi");
    expect(text).toContain("自动更新");
    expect(text).toContain("自动预取");
    // 挂载时拉了总览与存储
    expect(mockedComputeSyncOverview).toHaveBeenCalled();
    expect(mockedFetchAssetsSizeDetailed).toHaveBeenCalled();
  });

  it("存储细分：按类型显示占用（音频/封面/歌词/图书/词典 + 其他合计）", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    const rows = wrapper.findAll(".msc-storage-row");
    const text = rows.map((r) => r.text()).join(" | ");
    expect(text).toContain("音频");
    expect(text).toContain("400 B");
    expect(text).toContain("封面");
    expect(text).toContain("100 B");
    expect(text).toContain("歌词");
    expect(text).toContain("50 B");
    expect(text).toContain("图书");
    expect(text).toContain("300 B");
    expect(text).toContain("词典");
    expect(text).toContain("100 B");
    expect(text).toContain("其他");
    expect(text).toContain("50 B"); // meta 30 + other 20
    expect(text).toContain("1000 B"); // total（< 1024 不缩写）
  });

  it("开关：仅 Wi-Fi / 自动更新 / 自动预取 点击调用对应 setter 并更新样式", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    const toggles = wrapper.findAll(".msc-toggle-row");
    expect(toggles).toHaveLength(3);
    // 仅 Wi-Fi（默认开）：点击关
    await toggles[0].trigger("click");
    expect(mockedSetWifiOnly).toHaveBeenCalledWith(false);
    expect(wrapper.findAll(".msc-toggle-row .switch")[0].classes()).not.toContain("on");
    // 自动更新（默认关）：点击开
    await toggles[1].trigger("click");
    expect(mockedSetAutoUpdate).toHaveBeenCalledWith(true);
    // 自动预取（默认关）：点击开
    await toggles[2].trigger("click");
    expect(mockedSetAutoPrefetch).toHaveBeenCalledWith(true);
  });

  it("主按钮：点击同步全部 → 调 syncAll + 刷新总览", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    await wrapper.find(".msc-sync-all").trigger("click");
    await flushPromises();
    expect(mockedSyncAll).toHaveBeenCalled();
    expect(mockedComputeSyncOverview.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("返回按钮 → emit back", async () => {
    const wrapper = mount(MobileSync);
    await wrapper.find(".msc-back").trigger("click");
    expect(wrapper.emitted("back")).toHaveLength(1);
  });

  it("词典空态：无词典时显示「暂无词典」", async () => {
    const wrapper = mount(MobileSync);
    await flushPromises();
    expect(wrapper.text()).toContain("暂无词典");
  });
});
