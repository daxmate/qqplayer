// 未连接引导页测试（T4b 契约，2026-08-26 深夜修订：macOS 壳误判修复回归）：
// 1. isShellUnpaired() 判定：无 qqplayerIosBridge（桌面浏览器/macOS 壳）→ false；
//    iOS 壳无 server → true；有 server → false
// 2. NoConnectionView 渲染：标题/按钮存在；点「去配对」→ 桥收到 {cmd:"openPairing"}
// 3. App.vue 接入：未连接时渲染引导页、已连接不渲染（mock isShellUnpaired + 组件）
//
// 注意：App 组需要 mock usePairingState / NoConnectionView（vi.mock 全文件生效），
// 因此 1/2 组用 vi.importActual 拿真实实现来测。
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { installMatchMedia } from "./helpers/matchMedia.js";

// ---------- App 组 mock（hoisted：isShellUnpaired 返回值可控制） ----------
const mocks = vi.hoisted(() => ({ unpaired: false }));
vi.mock("../composables/usePairingState.js", () => ({
  isShellUnpaired: () => mocks.unpaired,
}));
vi.mock("../components/NoConnectionView.vue", () => ({
  default: { name: "NoConnectionView", template: '<div class="nc-stub">NC</div>' },
}));

// ---------- 真实实现（绕过 mock，供 1/2 组） ----------
const { isShellUnpaired } = await vi.importActual<
  typeof import("../composables/usePairingState.js")
>("../composables/usePairingState.js");
const RealNoConnectionView = (
  await vi.importActual<typeof import("../components/NoConnectionView.vue")>(
    "../components/NoConnectionView.vue",
  )
).default;

// ---------- App 组基础设施（必须在 import App 前注册，同 App.mobile.test.js） ----------
installMatchMedia(false); // 初始桌面布局（stub matchMedia，供 useMobileViewport 模块加载时读取）
class FakeAudio {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  listeners: Record<string, (() => void) | undefined> = {};
  play() {
    this.paused = false;
    this.listeners["play"]?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);
const App = (await import("../App.vue")).default;
const { state } = await import("../composables/usePlayer.js");

// jsdom（vitest 4）无 localStorage → 手写 stub（同 sync.test.js 风格）
const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = String(v);
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};
function clearLs() {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

function cleanShellEnv() {
  delete window.qqplayerNative;
  delete window.qqplayerIosBridge;
  clearLs();
}

beforeEach(() => {
  cleanShellEnv();
  mocks.unpaired = false;
  vi.stubGlobal("localStorage", localStorageStub);
  Object.assign(state, {
    songs: [],
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      if (url === "/api/songs") return { ok: true, json: async () => [] };
      return { ok: false, json: async () => ({}) };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanShellEnv();
});

// ============ 1. isShellUnpaired 判定 ============
describe("isShellUnpaired 未连接判定", () => {
  it("桌面浏览器（无 qqplayerIosBridge）→ false，即使无 server", () => {
    expect(isShellUnpaired()).toBe(false);
  });

  it("macOS 壳（只有 qqplayerNative、无 qqplayerIosBridge）→ false，不拦桌面版", () => {
    window.qqplayerNative = true; // macOS 壳只注入这个标记（不写 localStorage server）
    expect(isShellUnpaired()).toBe(false);
  });

  it("iOS 壳且无 server（localStorage 空 + 桥空）→ true", () => {
    window.qqplayerNative = true;
    window.qqplayerIosBridge = {}; // iOS 壳恒注入桥；未配对时 server 为空
    expect(isShellUnpaired()).toBe(true);
  });

  it("localStorage 有 qqplayer.server → false（即使桥空）", () => {
    window.qqplayerNative = true;
    window.qqplayerIosBridge = {};
    localStorage.setItem("qqplayer.server", "http://192.168.1.5:17627");
    expect(isShellUnpaired()).toBe(false);
  });

  it("桥对象有 server → false（即使 localStorage 空）", () => {
    window.qqplayerNative = true;
    window.qqplayerIosBridge = { server: "http://192.168.1.5:17627" };
    expect(isShellUnpaired()).toBe(false);
  });

  it("localStorage 读取抛错 → false 且不抛（异常不拦主界面）", () => {
    window.qqplayerNative = true;
    window.qqplayerIosBridge = {};
    const orig = localStorageStub.getItem;
    localStorageStub.getItem = () => {
      throw new Error("denied");
    };
    expect(isShellUnpaired()).toBe(false);
    localStorageStub.getItem = orig;
  });
});

// ============ 2. NoConnectionView 渲染与去配对桥消息 ============
describe("NoConnectionView 引导页", () => {
  it("渲染标题/说明/去配对按钮/手动提示（默认 zh-CN）", () => {
    const wrapper = mount(RealNoConnectionView);
    expect(wrapper.find(".nc-title").text()).toBe("未连接桌面端");
    expect(wrapper.find(".nc-desc").text()).toContain("连接桌面端 QQPlayer");
    expect(wrapper.find(".nc-pair-btn").text()).toContain("去配对");
    expect(wrapper.find(".nc-hint").text()).toContain("手动输入 IP");
    expect(wrapper.find(".nc-footer").text()).toContain("本机内容不受影响");
    wrapper.unmount();
  });

  it("点「去配对」→ 桥 postMessage 收到 {cmd:'openPairing'}", async () => {
    const post = vi.fn();
    window.qqplayerIosBridge = { postMessage: post };
    const wrapper = mount(RealNoConnectionView);
    await wrapper.find(".nc-pair-btn").trigger("click");
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith({ cmd: "openPairing" });
    wrapper.unmount();
  });

  it("无桥时点击不抛（nativePost 静默降级）", async () => {
    const wrapper = mount(RealNoConnectionView);
    await expect(wrapper.find(".nc-pair-btn").trigger("click")).resolves.toBeUndefined();
    wrapper.unmount();
  });
});

// ============ 3. App.vue 接入 ============
describe("App.vue 未连接引导页接入", () => {
  it("isShellUnpaired 为 true → 全屏覆盖渲染引导页", async () => {
    mocks.unpaired = true;
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".no-connection-overlay").exists()).toBe(true);
    // class 透传到组件根节点：同一元素同时携带 no-connection-overlay（App 注入）与 nc-stub（组件根）
    expect(wrapper.find(".no-connection-overlay").classes()).toContain("nc-stub");
    wrapper.unmount();
  });

  it("已连接（isShellUnpaired false）→ 不渲染引导页，主界面正常", async () => {
    mocks.unpaired = false;
    const wrapper = mount(App);
    await flushPromises();
    expect(wrapper.find(".no-connection-overlay").exists()).toBe(false);
    expect(wrapper.find(".topbar").exists()).toBe(true); // 桌面三栏主界面照常
    wrapper.unmount();
  });
});
