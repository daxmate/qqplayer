// LyricPanel 组件测试（连播歌词面板）
// 回归：控制栏"译"按钮（state.zhVisible）在连播模式必须生效
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { flushPromises } from "@vue/test-utils";
import { mount } from "@vue/test-utils";

// amll LyricPlayer 依赖 pixi（jsdom 下 ESM 互操作报错）；面板测试只关心行为，mock 掉组件
// 数据通过 data-lines 属性透出，供测试断言
vi.mock("@applemusic-like-lyrics/vue", () => ({
  LyricPlayer: {
    name: "LyricPlayer",
    template: '<div class="amll-mock" :data-lines="JSON.stringify(lyricLines)" />',
    props: ["lyricLines", "currentTime", "alignPosition"],
  },
}));

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);
// jsdom 无 ResizeObserver（useLyricScroll 与 amll 都会用）
// 用全局赋值而非 stub：afterEach 的 unstubAllGlobals 不会清掉它
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = FakeResizeObserver;

const LyricPanel = (await import("../components/LyricPanel.vue")).default;
const { state, lyricSettings, toggleZh } = await import("../composables/usePlayer.js");

const LYRIC = [
  { type: "sec", name: "主歌1" },
  { type: "line", s: 0, e: 10, text: ["君が", "kimi ga", "你"] },
  { type: "line", s: 10, e: 20, text: ["好き", "suki", "喜欢"] },
];

beforeEach(() => {
  state.zhVisible = true;
  state.currentTime = 0;
  lyricSettings.showRoma = true;
  lyricSettings.showZh = true;
  lyricSettings.showSec = true;
  lyricSettings.engine = "native"; // 默认走 DOM 断言路径；amll 路径在下方 describe 单独设
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountPanel() {
  return mount(LyricPanel, {
    props: { lyric: LYRIC, current: 0 },
  });
}

describe("LyricPanel 中文翻译显示（native 引擎 DOM）", () => {
  it("默认显示中文翻译行", () => {
    const wrapper = mountPanel();
    const zhDivs = wrapper.findAll(".lyr-zh");
    expect(zhDivs).toHaveLength(2);
    expect(zhDivs[0].text()).toBe("你");
  });

  it("译按钮关闭（zhVisible=false）后中文隐藏，原文/罗马音保留", async () => {
    const wrapper = mountPanel();
    toggleZh(); // state.zhVisible: true → false
    expect(state.zhVisible).toBe(false);
    await nextTick();
    expect(wrapper.findAll(".lyr-zh")).toHaveLength(0);
    expect(wrapper.findAll(".lyr-jp")).toHaveLength(2); // 原文仍在
    expect(wrapper.findAll(".lyr-roma")).toHaveLength(2); // 罗马音仍在
  });

  it("再点一次恢复中文显示", async () => {
    const wrapper = mountPanel();
    toggleZh();
    await nextTick();
    toggleZh(); // false → true
    await nextTick();
    expect(wrapper.findAll(".lyr-zh")).toHaveLength(2);
  });

  it("设置里关闭中文（lyricSettings.showZh=false）同样隐藏", async () => {
    const wrapper = mountPanel();
    lyricSettings.showZh = false;
    await nextTick();
    expect(wrapper.findAll(".lyr-zh")).toHaveLength(0);
  });

  it("歌词没有中文行时不渲染（即使开关全开）", () => {
    const wrapper = mount(LyricPanel, {
      props: { lyric: [{ type: "line", s: 0, e: 10, text: ["君が", "kimi ga"] }], current: 0 },
    });
    expect(wrapper.findAll(".lyr-zh")).toHaveLength(0);
    expect(wrapper.findAll(".lyr-jp")).toHaveLength(1);
  });
});

describe("LyricPanel 中文翻译显示（amll 引擎数据映射）", () => {
  // amll 引擎渲染的是 LyricPlayer（异步组件 + mock），断言传给它的 LyricLine 数据
  async function amllProps(wrapper) {
    await flushPromises(); // 等 defineAsyncComponent 加载完成
    const raw = wrapper.find(".amll-mock").attributes("data-lines");
    return JSON.parse(raw);
  }

  it("默认带中文翻译行（translatedLyric）", async () => {
    lyricSettings.engine = "amll";
    const wrapper = mountPanel();
    const lines = await amllProps(wrapper);
    expect(lines).toHaveLength(2);
    expect(lines[0].translatedLyric).toBe("你");
    expect(lines[0].romanLyric).toBe("kimi ga");
  });

  it("译按钮关闭（zhVisible=false）后中文隐藏，原文/罗马音保留", async () => {
    lyricSettings.engine = "amll";
    const wrapper = mountPanel();
    toggleZh();
    expect(state.zhVisible).toBe(false);
    await nextTick();
    const lines = await amllProps(wrapper);
    expect(lines.every((l) => l.translatedLyric === "")).toBe(true);
    expect(lines[0].words[0].word).toBe("君が");
    expect(lines[0].romanLyric).toBe("kimi ga");
  });

  it("歌词没有中文行时 translatedLyric 为空（即使开关全开）", async () => {
    lyricSettings.engine = "amll";
    const wrapper = mount(LyricPanel, {
      props: { lyric: [{ type: "line", s: 0, e: 10, text: ["君が", "kimi ga"] }], current: 0 },
    });
    const lines = await amllProps(wrapper);
    expect(lines).toHaveLength(1);
    expect(lines[0].translatedLyric).toBe("");
    expect(lines[0].words[0].word).toBe("君が");
  });
});
