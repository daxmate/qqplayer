// Sidebar 歌单「推送到设备」按钮测试（T3b：歌单行 hover 操作区 → DevicePickerModal）
// 覆盖：空歌单不发请求；路径反查过滤（流媒体/已删歌曲）；无设备 toast；推送成功/失败 toast；
//       ContextMenu showPushDevice=false 隐藏无效菜单项
// mock 模式：模块级 vi.mock apiClient（deviceCommands 真实逻辑 + apiClient mock，与 devicePanel 同款）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

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
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
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
const Sidebar = (await import("../components/Sidebar.vue")).default;
const ContextMenu = (await import("../components/ContextMenu.vue")).default;
const ToastContainer = (await import("../components/ToastContainer.vue")).default;
const { state } = await import("../composables/usePlayer.js");
const { clearToasts } = await import("../composables/useToast.js");

const SONGS = [
  { id: "a", name: "A歌", artist: "五月天", path: "/a.mp3" },
  { id: "b", name: "B歌", artist: "高橋優", path: "/b.mp3" },
];
const PLAYLIST = {
  id: "pl1",
  name: "旅行",
  songPaths: ["/a.mp3", "/b.mp3"],
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
};
const DEVICES = [
  {
    device_id: "dev1",
    device_name: "iPhone 小超",
    last_seen: new Date().toISOString(),
    total: 1572864,
  },
];
const MANIFEST = [
  { path: "/a.mp3", sha256: "ha", size: 100 },
  { path: "/b.mp3", sha256: "hb", size: 200 },
];

// 默认 apiGet：devices + manifest 都正常返回；apiPost 默认失败（防误发）
function stubApi({ devices = DEVICES, manifest = MANIFEST, post = null } = {}) {
  apiGet.mockImplementation((url) => {
    if (url === "/api/sync/devices") return Promise.resolve({ ok: true, data: { devices } });
    if (url === "/api/sync/manifest")
      return Promise.resolve({ ok: true, data: { songs: manifest } });
    return Promise.resolve({ ok: false, data: null, message: "unexpected: " + url });
  });
  apiPost.mockResolvedValue(
    post !== null ? post : { ok: false, data: null, message: "unexpected post" },
  );
}

function mountAll() {
  const sidebar = mount(Sidebar, {
    global: { stubs: { teleport: true } }, // DevicePickerModal 内容内联渲染，便于断言
  });
  // 共享同一单例 toast 状态，stub Teleport 后内容在 wrapper 内可查询
  const toasts = mount(ToastContainer, {
    global: { stubs: { teleport: true } },
  });
  return { sidebar, toasts };
}

// 点歌单行 hover 操作区的推送按钮（title = i18n sidebar.pushToDevice）
const pushBtn = (sidebar) => sidebar.find('button[title="推送到设备"]');

async function flush() {
  await flushPromises();
}

beforeEach(() => {
  Object.assign(state, {
    songs: [],
    playlists: [JSON.parse(JSON.stringify(PLAYLIST))],
    activePlaylistId: null,
    favorites: [],
  });
  clearToasts();
  vi.clearAllMocks();
});

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

describe("Sidebar 歌单推送到设备（openPlaylistPush）", () => {
  it("歌单无歌曲 → toast 推送失败，不发设备请求", async () => {
    state.playlists = [{ ...PLAYLIST, songPaths: [] }];
    stubApi();
    const { sidebar, toasts } = mountAll();

    await pushBtn(sidebar).trigger("click");
    await flush();

    expect(apiGet).not.toHaveBeenCalled();
    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.classes()).toContain("toast-error");
    expect(item.text()).toContain("推送失败");
  });

  it("有歌曲 → fetchDevices → 有设备 → 打开设备选择浮层", async () => {
    state.songs = [...SONGS];
    stubApi();
    const { sidebar } = mountAll();

    await pushBtn(sidebar).trigger("click");
    await flush();

    expect(apiGet).toHaveBeenCalledWith("/api/sync/devices");
    const dialog = sidebar.find(".dp-dialog");
    expect(dialog.exists()).toBe(true);
    expect(sidebar.find('.dp-item[data-testid="dp-device-dev1"]').exists()).toBe(true);
  });

  it("fetchDevices 无设备 → toast noDevicesToast，不弹浮层", async () => {
    state.songs = [...SONGS];
    stubApi({ devices: [] });
    const { sidebar, toasts } = mountAll();

    await pushBtn(sidebar).trigger("click");
    await flush();

    expect(apiGet).toHaveBeenCalledWith("/api/sync/devices");
    expect(sidebar.find(".dp-dialog").exists()).toBe(false);
    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.classes()).toContain("toast-error");
    expect(item.text()).toContain("暂无已配对设备");
  });

  it("路径反查：只推送 state.songs 中存在的歌曲（流媒体/已删歌曲被过滤）", async () => {
    // 歌单含 /b.mp3，但曲库没有 → 只推 /a.mp3
    state.songs = [SONGS[0]];
    stubApi();
    const { sidebar } = mountAll();

    await pushBtn(sidebar).trigger("click");
    await flush();
    expect(sidebar.find(".dp-dialog").exists()).toBe(true);

    // 选设备 → 确认 → pushSongsToDevice 只发曲库中存在的歌曲
    await sidebar.find('.dp-item[data-testid="dp-device-dev1"]').trigger("click");
    await sidebar.find(".dp-btn.primary").trigger("click");
    await flush();

    expect(apiGet).toHaveBeenCalledWith("/api/sync/manifest");
    expect(apiPost).toHaveBeenCalledWith("/api/sync/commands", {
      type: "pushDownload",
      payload: {
        items: [{ path: "/a.mp3", sha256: "ha", size: 100 }],
      },
      device_id: "dev1",
    });
  });

  it("路径反查全灭（歌单歌曲全不在曲库）→ toast 推送失败，不发设备请求", async () => {
    state.songs = [];
    state.playlists = [{ ...PLAYLIST, songPaths: ["/gone.mp3"] }];
    stubApi();
    const { sidebar, toasts } = mountAll();

    await pushBtn(sidebar).trigger("click");
    await flush();

    expect(apiGet).not.toHaveBeenCalled();
    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.classes()).toContain("toast-error");
    expect(item.text()).toContain("推送失败");
  });
});

describe("Sidebar 歌单推送到设备（onPlaylistPushPicked）", () => {
  // 打开浮层并选设备确认（选中 dev1 → confirm → select 事件 → onPlaylistPushPicked）
  async function pickAndConfirm(sidebar) {
    await pushBtn(sidebar).trigger("click");
    await flush();
    await sidebar.find('.dp-item[data-testid="dp-device-dev1"]').trigger("click");
    await sidebar.find(".dp-btn.primary").trigger("click");
    await flush();
  }

  it("推送成功（全部匹配）→ toast pushSuccess n=2", async () => {
    state.songs = [...SONGS];
    stubApi({ post: { ok: true, data: { id: 9 } } });
    const { sidebar, toasts } = mountAll();

    await pickAndConfirm(sidebar);

    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.classes()).not.toContain("toast-error");
    expect(item.text()).toContain("已推送 2 首歌曲");
  });

  it("推送成功（manifest 缺 1 首 → skipped）→ toast pushSuccess n 扣减", async () => {
    state.songs = [...SONGS];
    stubApi({ manifest: MANIFEST.slice(0, 1), post: { ok: true, data: { id: 10 } } });
    const { sidebar, toasts } = mountAll();

    await pickAndConfirm(sidebar);

    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.text()).toContain("已推送 1 首歌曲");
  });

  it("推送失败 → toast pushFailedReason（带原因）", async () => {
    state.songs = [...SONGS];
    stubApi({ post: { ok: false, data: null, message: "boom" } });
    const { sidebar, toasts } = mountAll();

    await pickAndConfirm(sidebar);

    const item = toasts.find(".toast-item");
    expect(item.exists()).toBe(true);
    expect(item.classes()).toContain("toast-error");
    expect(item.text()).toContain("推送失败：boom");
  });
});

describe("ContextMenu showPushDevice prop", () => {
  it("默认 true：渲染「推送到设备」项", () => {
    const wrapper = mount(ContextMenu, {
      props: { visible: true },
      global: { stubs: { teleport: true } },
    });
    expect(wrapper.text()).toContain("推送到设备");
  });

  it("false：不渲染「推送到设备」项（SmartViewPanel 场景）", () => {
    const wrapper = mount(ContextMenu, {
      props: { visible: true, showPushDevice: false },
      global: { stubs: { teleport: true } },
    });
    expect(wrapper.text()).not.toContain("推送到设备");
  });
});
