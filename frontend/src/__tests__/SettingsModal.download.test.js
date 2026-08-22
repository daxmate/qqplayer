// SettingsModal 下载分类测试：导航渲染 / 默认值 / chip 选择写入 downloadSettings
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
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

let logoutBodies = []; // /api/quark/login/logout 请求记录

beforeEach(() => {
  Object.assign(downloadSettings, { downloadDir: "", defaultQuality: "exhigh" });
  logoutBodies = [];
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
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

describe("SettingsModal 歌曲海下载设置（quarkQuality / 引擎 / aria2 / 夸克账号）", () => {
  // 打开弹窗并进入下载分类
  async function openDownloadTab() {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("下载"),
    );
    await navItem.click();
    await flushPromises(); // 等 refreshQuarkState 收尾（quarkBusy 复位，登录按钮才可点）
    await nextTick();
    return { w, root };
  }

  it("默认值：quarkQuality=mp3（MP3 320k 选中）、engine=httpx（内置选中）、aria2 输入框隐藏", async () => {
    const { w, root } = await openDownloadTab();
    expect(downloadSettings.quarkQuality).toBe("mp3");
    expect(downloadSettings.engine).toBe("httpx");
    expect(downloadSettings.aria2Rpc).toBe("");
    expect(downloadSettings.aria2Secret).toBe("");
    // 品质 seg：MP3 320k 选中；引擎 seg：内置选中
    const segBtns = [...root.querySelectorAll(".seg-btn")].map((el) => ({
      text: el.textContent.trim(),
      on: el.classList.contains("on"),
    }));
    expect(segBtns).toContainEqual({ text: "MP3 320k", on: true });
    expect(segBtns).toContainEqual({ text: "FLAC 无损", on: false });
    expect(segBtns).toContainEqual({ text: "内置", on: true });
    expect(segBtns).toContainEqual({ text: "aria2", on: false });
    // aria2 参数输入框隐藏（引擎非 aria2）
    const inputs = [...root.querySelectorAll("input.lib-input")];
    expect(inputs.length).toBe(1); // 只有下载目录
    expect(root.textContent).not.toContain("aria2 RPC");
    w.unmount();
  });

  it("点击 FLAC → 写入 downloadSettings.quarkQuality；切 aria2 → 显示 RPC/密钥输入框并可编辑", async () => {
    const { w, root } = await openDownloadTab();
    const segBtns = [...root.querySelectorAll(".seg-btn")];
    await segBtns.find((el) => el.textContent.trim() === "FLAC 无损").click();
    await nextTick();
    expect(downloadSettings.quarkQuality).toBe("flac");
    await segBtns.find((el) => el.textContent.trim() === "aria2").click();
    await nextTick();
    expect(downloadSettings.engine).toBe("aria2");
    // aria2 输入框出现（RPC + 密钥），并写入 settings
    const inputs = [...root.querySelectorAll("input.lib-input")];
    expect(inputs.length).toBe(3); // 下载目录 + RPC + 密钥
    const rpc = inputs.find((el) => el.placeholder.includes("6800"));
    const secret = inputs.find((el) => el.type === "password");
    rpc.value = "http://127.0.0.1:6800/jsonrpc";
    await rpc.dispatchEvent(new Event("input"));
    secret.value = "tok";
    await secret.dispatchEvent(new Event("input"));
    await nextTick();
    expect(downloadSettings.aria2Rpc).toBe("http://127.0.0.1:6800/jsonrpc");
    expect(downloadSettings.aria2Secret).toBe("tok");
    w.unmount();
  });

  it("夸克账号：未登录 → 显示登录按钮；点击打开扫码登录弹窗", async () => {
    const { w, root } = await openDownloadTab();
    expect(root.textContent).toContain("未登录");
    const loginBtn = [...root.querySelectorAll("button")].find((el) =>
      el.textContent.trim().includes("登录夸克"),
    );
    expect(loginBtn).toBeTruthy();
    await loginBtn.click();
    await nextTick();
    expect(document.body.querySelector(".qlm")).toBeTruthy(); // 扫码登录弹窗挂载
    w.unmount();
  });

  it("夸克账号：已登录 → 显示昵称；点退出 → POST logout + 状态变未登录", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        if (url === "/api/quark/login/state") {
          return { ok: true, json: async () => ({ logged_in: true, nickname: "夸克用户" }) };
        }
        if (url === "/api/quark/login/logout") {
          logoutBodies.push(opts);
          return { ok: true, json: async () => ({ ok: true }) };
        }
        return { ok: false, json: async () => ({}) };
      }),
    );
    const { w, root } = await openDownloadTab();
    await flushPromises();
    expect(root.textContent).toContain("已登录：夸克用户");
    const logoutBtn = [...root.querySelectorAll("button")].find((el) =>
      el.textContent.trim().includes("退出登录"),
    );
    expect(logoutBtn).toBeTruthy();
    await logoutBtn.click();
    await flushPromises();
    expect(logoutBodies.length).toBe(1);
    expect(logoutBodies[0].method).toBe("POST");
    expect(root.textContent).toContain("未登录");
    w.unmount();
  });
});
