// SettingsModal 组件测试：播放分类「频谱可视化」小节 + 任务 K（视觉化 6 样式 chips / 显示封面开关）
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
const { playbackSettings, uiSettings, lyricSettings } = await import("../composables/usePlayer.js");
const { VISUALIZER_STYLES } = await import("../composables/usePlayer.js");
const zhCN = (await import("../locales/zh-CN/index.js")).default;

// 从聚合语言包解析 settings.xxx.yyy 点路径
function resolveKey(lang, key) {
  return key.split(".").reduce((o, k) => (o ? o[k] : undefined), lang);
}

// 切到指定分类导航（默认 tab 已改为「界面」，播放相关断言需先切换）
async function gotoCategory(root, label) {
  const nav = [...root.querySelectorAll(".nav-item")].find((el) => el.textContent.includes(label));
  expect(nav).toBeTruthy();
  nav.click();
  await nextTick();
}

beforeEach(() => {
  playbackSettings.visualizerEnabled = true;
  playbackSettings.ambientEnabled = true;
  playbackSettings.miniSpectrumEnabled = true;
  playbackSettings.visualizerStyle = "bars";
  uiSettings.showCover = true;
  uiSettings.showListCover = true;
  // 弹窗 watch(open) 会触发 loadLibrary / loadLibrarySettings（fetch），stub 掉
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SettingsModal 播放分类 - 频谱可视化", () => {
  it("播放分类存在「频谱可视化」开关小节", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    // Teleport 到 body
    const root = document.body.querySelector(".modal");
    expect(root).toBeTruthy();
    await gotoCategory(root, "播放");
    expect(root.textContent).toContain("频谱可视化");
    // 默认打开
    const row = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("频谱可视化"),
    );
    expect(row).toBeTruthy();
    expect(row.querySelector(".switch.on")).toBeTruthy();
    w.unmount();
  });

  it("点击开关切换 playbackSettings.visualizerEnabled", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    await gotoCategory(root, "播放");
    const row = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("频谱可视化"),
    );
    row.click();
    await nextTick();
    expect(playbackSettings.visualizerEnabled).toBe(false);
    expect(row.querySelector(".switch.on")).toBeFalsy();
    row.click();
    await nextTick();
    expect(playbackSettings.visualizerEnabled).toBe(true);
    w.unmount();
  });

  it("任务 C：总开关下显示「氛围背景 / 迷你频谱」子开关，点击各自切换", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    await gotoCategory(root, "播放");
    const subRows = [...root.querySelectorAll(".sub-toggle-row")];
    expect(subRows.length).toBe(2);
    const ambientRow = subRows.find((el) => el.textContent.includes("氛围背景"));
    const miniRow = subRows.find((el) => el.textContent.includes("迷你频谱"));
    expect(ambientRow).toBeTruthy();
    expect(miniRow).toBeTruthy();
    // 默认开
    expect(ambientRow.querySelector(".switch.on")).toBeTruthy();
    expect(miniRow.querySelector(".switch.on")).toBeTruthy();
    // 各自独立切换
    ambientRow.click();
    await nextTick();
    expect(playbackSettings.ambientEnabled).toBe(false);
    expect(ambientRow.querySelector(".switch.on")).toBeFalsy();
    expect(playbackSettings.miniSpectrumEnabled).toBe(true); // 不受影响
    miniRow.click();
    await nextTick();
    expect(playbackSettings.miniSpectrumEnabled).toBe(false);
    w.unmount();
  });

  it("任务 C：迷你频谱关闭时样式 chips 隐藏（主开关仍开）", async () => {
    playbackSettings.miniSpectrumEnabled = false;
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    await gotoCategory(root, "播放");
    expect(root.querySelector(".viz-style-grid")).toBeFalsy();
    expect(root.querySelector(".sub-toggle-row")).toBeTruthy(); // 子开关仍在
    w.unmount();
  });

  it("任务 C：主开关关闭 → 子开关与 chips 都隐藏", async () => {
    playbackSettings.visualizerEnabled = false;
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    await gotoCategory(root, "播放");
    expect(root.querySelector(".viz-style-grid")).toBeFalsy();
    expect(root.querySelector(".sub-toggle-row")).toBeFalsy();
    w.unmount();
  });
});

describe("SettingsModal 任务 K - 视觉化 6 样式 chips", () => {
  it("chips 6 选 1：文案 = VISUALIZER_STYLES 的 zh-CN 翻译，点击生效并移动高亮", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    await gotoCategory(root, "播放");
    const chips = [...root.querySelectorAll(".viz-style-grid .ext-chip")];
    expect(chips).toHaveLength(6);
    expect(chips.map((c) => c.textContent.trim())).toEqual(
      VISUALIZER_STYLES.map((s) => resolveKey(zhCN, s.labelKey)),
    );
    // 默认 bars 高亮
    expect(playbackSettings.visualizerStyle).toBe("bars");
    expect(chips[0].classList.contains("on")).toBe(true);
    // 点第 3 个（wave）→ 样式切换、高亮移动
    chips[2].click();
    await nextTick();
    expect(playbackSettings.visualizerStyle).toBe("wave");
    expect(chips[2].classList.contains("on")).toBe(true);
    expect(chips[0].classList.contains("on")).toBe(false);
    w.unmount();
  });

  it("视觉化关闭时 chips 隐藏（同 EQ 预设模式）", async () => {
    playbackSettings.visualizerEnabled = false;
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    expect(root.querySelector(".viz-style-grid")).toBeFalsy();
    w.unmount();
  });
});

describe("SettingsModal 任务 K - 显示封面开关", () => {
  it("界面分类：默认开，点击切换 uiSettings.showCover", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    // 切到「界面」分类
    const uiNav = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("界面"),
    );
    expect(uiNav).toBeTruthy();
    uiNav.click();
    await nextTick();
    const row = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("显示封面"),
    );
    expect(row).toBeTruthy();
    expect(row.querySelector(".switch.on")).toBeTruthy();
    row.click();
    await nextTick();
    expect(uiSettings.showCover).toBe(false);
    expect(row.querySelector(".switch.on")).toBeFalsy();
    row.click();
    await nextTick();
    expect(uiSettings.showCover).toBe(true);
    w.unmount();
  });

  it("界面分类：新增「列表封面」开关默认开，点击切换 uiSettings.showListCover（与 showCover 独立）", async () => {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const uiNav = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("界面"),
    );
    uiNav.click();
    await nextTick();
    const row = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("列表封面"),
    );
    expect(row).toBeTruthy();
    expect(row.querySelector(".switch.on")).toBeTruthy();
    row.click();
    await nextTick();
    expect(uiSettings.showListCover).toBe(false);
    expect(uiSettings.showCover).toBe(true); // 大封面开关不受影响
    expect(row.querySelector(".switch.on")).toBeFalsy();
    row.click();
    await nextTick();
    expect(uiSettings.showListCover).toBe(true);
    w.unmount();
  });
});

describe("SettingsModal 视频分类 - 浏览器 Cookie 来源", () => {
  it("视频分类：默认「不使用」，选项含 6 浏览器，选择后写入 videoSettings.cookiesFromBrowser", async () => {
    const { videoSettings } = await import("../composables/useSettings.js");
    videoSettings.cookiesFromBrowser = "";
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");

    // 切到「视频」分类
    const videoNav = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("视频"),
    );
    expect(videoNav).toBeTruthy();
    videoNav.click();
    await nextTick();

    const select = root.querySelector("select");
    expect(select).toBeTruthy();
    expect(select.value).toBe("");
    const opts = [...select.querySelectorAll("option")].map((o) => o.value);
    expect(opts).toEqual(["", "vivaldi", "chrome", "safari", "edge", "firefox", "brave"]);

    // 选择 Chrome → v-model 写入 composable
    select.value = "chrome";
    select.dispatchEvent(new Event("change"));
    await nextTick();
    expect(videoSettings.cookiesFromBrowser).toBe("chrome");
    w.unmount();
  });
});

describe("SettingsModal 歌词分类 - AMLL 三特效开关", () => {
  async function openLyricTab() {
    const w = mount(SettingsModal, { props: { open: true } });
    await nextTick();
    const root = document.body.querySelector(".modal");
    const navItem = [...root.querySelectorAll(".nav-item")].find((el) =>
      el.textContent.includes("歌词"),
    );
    expect(navItem).toBeTruthy();
    navItem.click();
    await nextTick();
    return { w, root };
  }

  it("歌词分类渲染 AMLL 模糊/弹簧/放大三个开关，默认值跟随 lyricSettings", async () => {
    lyricSettings.amllBlur = true;
    lyricSettings.amllSpring = false;
    lyricSettings.amllScale = true;
    const { w, root } = await openLyricTab();
    expect(root.textContent).toContain("AMLL 模糊效果");
    expect(root.textContent).toContain("AMLL 弹簧动画");
    expect(root.textContent).toContain("AMLL 放大效果");
    // 三个开关行的 on/off 状态与设置一致
    const rows = [...root.querySelectorAll(".toggle-row")].filter((el) =>
      /AMLL (模糊效果|弹簧动画|放大效果)/.test(el.textContent),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("AMLL 模糊效果");
    expect(rows[0].querySelector(".switch.on")).toBeTruthy();
    expect(rows[1].textContent).toContain("AMLL 弹簧动画");
    expect(rows[1].querySelector(".switch.on")).toBeFalsy();
    expect(rows[2].textContent).toContain("AMLL 放大效果");
    expect(rows[2].querySelector(".switch.on")).toBeTruthy();
    w.unmount();
  });

  it("点击开关切换 lyricSettings.amll*（写入持久化链路的 reactive）", async () => {
    lyricSettings.amllBlur = true;
    const { w, root } = await openLyricTab();
    const blurRow = [...root.querySelectorAll(".toggle-row")].find((el) =>
      el.textContent.includes("AMLL 模糊效果"),
    );
    blurRow.click();
    await nextTick();
    expect(lyricSettings.amllBlur).toBe(false);
    expect(blurRow.querySelector(".switch.on")).toBeFalsy();
    blurRow.click();
    await nextTick();
    expect(lyricSettings.amllBlur).toBe(true);
    w.unmount();
  });

  it("info 按钮渲染在 AMLL 三开关旁，点击展开/收起性能提示", async () => {
    const { w, root } = await openLyricTab();
    const btn = root.querySelector(".amll-info-btn");
    expect(btn).toBeTruthy();
    // 提示展开前不显示文案
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(root.textContent).not.toContain("性能影响巨大");
    // 点击展开：提示出现，含关键文案
    btn.click();
    await nextTick();
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(root.textContent).toContain("性能影响巨大");
    expect(root.textContent).toContain("CPU 占用");
    expect(root.textContent).toContain("浏览器环境");
    // 再点收起：提示消失
    btn.click();
    await nextTick();
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(root.textContent).not.toContain("性能影响巨大");
    w.unmount();
  });
});
