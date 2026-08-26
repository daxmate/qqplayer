// SettingsModal 同步 tab 设备管理面板测试（桌面端：设备清单 / 指令历史 / 删除资产 / i18n 键）
// mock 模式：模块级 vi.mock apiClient（组件 + deviceCommands 共用同一 mock）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

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
  removeAttribute() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

vi.mock("../utils/apiClient.js", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  invalidate: vi.fn(),
  scheduleFlush: vi.fn(),
  resolveServerUrl: (p) => p,
}));

const { apiGet, apiPost } = await import("../utils/apiClient.js");
const { clearToasts } = await import("../composables/useToast.js");
const SettingsModal = (await import("../components/SettingsModal.vue")).default;
const zhSettings = (await import("../locales/zh-CN/settings.js")).default.settings;
const enSettings = (await import("../locales/en-US/settings.js")).default.settings;
const zhPlaylist = (await import("../locales/zh-CN/playlist.js")).default.playlist;
const enPlaylist = (await import("../locales/en-US/playlist.js")).default.playlist;

const DEVICES = [
  {
    device_id: "device-abc12345",
    device_name: "iPhone 小超",
    server_id: "srv1",
    last_seen: new Date().toISOString(),
    assets_count: 2,
    total: 1572864, // 1.5 MB
    byType: { audio: 1, cover: 1, books: 0, dicts: 2 },
    assets: [
      { path: "audio/aaa.m4a", sha256: "h1", size: 1048576 },
      { path: "cover/bbb.jpg", sha256: "h2", size: 524288 },
    ],
  },
  {
    device_id: "device-noName8888",
    device_name: "",
    server_id: "srv1",
    last_seen: new Date(Date.now() - 5 * 60000).toISOString(),
    assets_count: 0,
    total: 0,
    byType: {},
    assets: [],
  },
];

const COMMANDS = [
  {
    id: 1,
    type: "pushDownload",
    payload: { items: [] },
    status: "done",
    device_id: "device-abc12345",
    created_at: new Date().toISOString(),
    ack_at: new Date().toISOString(),
  },
  {
    id: 2,
    type: "remoteDelete",
    payload: { paths: [] },
    status: "pending",
    device_id: null,
    created_at: new Date().toISOString(),
    ack_at: null,
  },
];

// 默认 apiGet 路由：library 相关返回空，sync 接口返回 DEVICES/COMMANDS
function routeApiGet(devices = DEVICES, commands = COMMANDS) {
  apiGet.mockImplementation(async (url) => {
    if (url === "/api/sync/devices") return { ok: true, data: { devices } };
    if (url === "/api/sync/commands") return { ok: true, data: { commands } };
    if (url.startsWith("/api/library")) return { ok: true, data: { path: "", settings: {} } };
    return { ok: false, message: "not found" };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  delete window.qqplayerIosBridge;
  routeApiGet();
  apiPost.mockResolvedValue({ ok: true, data: { id: 99 } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

// 打开设置弹窗 → 进入「同步」tab
async function openSyncTab() {
  const w = mount(SettingsModal, { props: { open: true } });
  await flushPromises();
  const nav = [...document.body.querySelectorAll(".nav-item")].find((n) =>
    n.textContent.includes("同步"),
  );
  expect(nav).toBeTruthy();
  nav.click();
  await flushPromises();
  await nextTick();
  return w;
}

describe("SettingsModal 同步 tab · 设备管理面板", () => {
  it("有设备：渲染设备名 / 最后在线 / 占用 / 文件数 / byType 细分", async () => {
    const w = await openSyncTab();
    const dev = document.body.querySelector('[data-testid="sync-device-device-abc12345"]');
    expect(dev).toBeTruthy();
    expect(dev.textContent).toContain("iPhone 小超");
    expect(dev.textContent).toContain("最后在线");
    expect(dev.textContent).toContain("1.5 MB");
    expect(dev.textContent).toContain("2 个文件");
    expect(dev.textContent).toContain("音频 1");
    expect(dev.textContent).toContain("封面 1");
    expect(dev.textContent).toContain("词典 2");
    // 空设备名 → device_id 前 8 位
    const dev2 = document.body.querySelector('[data-testid="sync-device-device-noName8888"]');
    expect(dev2.textContent).toContain("device-n");
    w.unmount();
  });

  it("无设备：显示暂无已配对设备 + 配对引导文案", async () => {
    routeApiGet([], []);
    const w = await openSyncTab();
    const panel = document.body.querySelector(".modal");
    expect(panel.textContent).toContain("暂无已配对设备");
    expect(panel.textContent).toContain("配对");
    w.unmount();
  });

  it("指令历史：类型 / 状态标签 / 目标设备 / 全部设备", async () => {
    const w = await openSyncTab();
    const cmd1 = document.body.querySelector('[data-testid="sync-cmd-1"]');
    expect(cmd1.textContent).toContain("推送下载");
    expect(cmd1.querySelector(".sync-status.st-done").textContent).toContain("已完成");
    expect(cmd1.textContent).toContain("device-abc12345");
    const cmd2 = document.body.querySelector('[data-testid="sync-cmd-2"]');
    expect(cmd2.textContent).toContain("远程删除");
    expect(cmd2.querySelector(".sync-status.st-pending").textContent).toContain("排队中");
    expect(cmd2.textContent).toContain("全部设备");
    w.unmount();
  });

  it("指令历史为空：显示暂无指令", async () => {
    routeApiGet(DEVICES, []);
    const w = await openSyncTab();
    expect(document.body.querySelector(".modal").textContent).toContain("暂无指令");
    w.unmount();
  });

  it("后端未启动（devices 拉取失败）：显示兜底文案 + 刷新按钮", async () => {
    apiGet.mockImplementation(async (url) => {
      if (url === "/api/sync/devices") return { ok: false, message: "网络连接失败", network: true };
      if (url === "/api/sync/commands")
        return { ok: false, message: "网络连接失败", network: true };
      if (url.startsWith("/api/library")) return { ok: true, data: { path: "", settings: {} } };
      return { ok: false, message: "not found" };
    });
    const w = await openSyncTab();
    const panel = document.body.querySelector(".modal");
    expect(panel.textContent).toContain("获取数据失败，请稍后重试");
    expect(panel.querySelector(".btn")).toBeTruthy(); // 刷新按钮
    w.unmount();
  });

  it("删除资产：展开 → 勾选 → 确认弹窗 → 确认 → 发 remoteDelete + 刷新", async () => {
    const w = await openSyncTab();
    // 展开设备资产列表
    const head = document.body.querySelector(".sync-device-head");
    head.click();
    await nextTick();
    const rows = [...document.body.querySelectorAll(".sync-asset-row")];
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("audio/aaa.m4a");
    expect(rows[0].textContent).toContain("1.0 MB");
    // 勾选第一个资产
    const cb = rows[0].querySelector("input");
    cb.checked = true;
    cb.dispatchEvent(new Event("change", { bubbles: true }));
    await nextTick();
    // 删除按钮出现（带数量）
    const delBtn = [...document.body.querySelectorAll("button")].find((b) =>
      b.textContent.includes("删除选中资产"),
    );
    expect(delBtn).toBeTruthy();
    expect(delBtn.textContent).toContain("(1)");
    // 确认弹窗
    delBtn.click();
    await nextTick();
    const dialog = document.body.querySelector(".sync-dialog");
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("确认删除选中资产");
    // 确认
    dialog.querySelector(".sync-dialog-btn.danger").click();
    await flushPromises();
    expect(apiPost).toHaveBeenCalledWith("/api/sync/commands", {
      type: "remoteDelete",
      payload: { paths: ["audio/aaa.m4a"] },
      device_id: "device-abc12345",
    });
    // 刷新：devices + commands 重新拉取
    const syncDevCalls = apiGet.mock.calls.filter(([u]) => u === "/api/sync/devices").length;
    expect(syncDevCalls).toBeGreaterThanOrEqual(2);
    w.unmount();
  });
});

describe("设备面板 i18n 键存在性", () => {
  const REQUIRED = [
    "devicePanelTitle",
    "devicePanelDesc",
    "noDevices",
    "noDevicesHint",
    "deviceLastSeen",
    "deviceAssets",
    "deviceTotal",
    "commandHistory",
    "commandType.pushDownload",
    "commandType.remoteDelete",
    "commandStatus.pending",
    "commandStatus.executing",
    "commandStatus.done",
    "commandStatus.failed",
    "commandTarget.all",
    "deleteAssets",
    "deleteAssetsConfirm",
    "refresh",
  ];
  const get = (obj, key) =>
    key.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);

  it("settings 必需键在 zh-CN 与 en-US 都存在", () => {
    for (const key of REQUIRED) {
      expect(get(zhSettings, key), `zh-CN settings.${key}`).toBeTruthy();
      expect(get(enSettings, key), `en-US settings.${key}`).toBeTruthy();
    }
  });

  it("playlist 推送键在 zh-CN 与 en-US 都存在", () => {
    for (const key of [
      "pushToDevice",
      "noDevicesToast",
      "pushSuccess",
      "pushFailed",
      "devicePicker.title",
      "devicePicker.confirm",
    ]) {
      expect(get(zhPlaylist, key), `zh-CN playlist.${key}`).toBeTruthy();
      expect(get(enPlaylist, key), `en-US playlist.${key}`).toBeTruthy();
    }
  });
});
