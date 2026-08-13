// LyricPanel 组件测试（连播歌词面板）
// 回归：控制栏"译"按钮（state.zhVisible）在连播模式必须生效
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { nextTick } from "vue";
import { mount } from "@vue/test-utils";

// amll LyricPlayer 依赖 pixi（jsdom 下 ESM 互操作报错）；面板测试只关心行为，mock 掉组件
vi.mock("@applemusic-like-lyrics/vue", () => ({
  LyricPlayer: {
    name: "LyricPlayer",
    template: '<div class="amll-mock" />',
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mountPanel() {
  return mount(LyricPanel, {
    props: { lyric: LYRIC, current: 0 },
  });
}

// amll 方案：翻译/罗马音通过 LyricLine 字段传给 LyricPlayer（mock 组件），
// 断言 props 数据映射正确（zhVisible/showZh → translatedLyric，showRoma → romanLyric）
function amllProps(wrapper) {
  const player = wrapper.findComponent({ name: "LyricPlayer" });
  return player.props("lyricLines");
}

describe("LyricPanel 中文翻译显示（amll 数据映射）", () => {
  it("默认带中文翻译行（translatedLyric）", () => {
    const wrapper = mountPanel();
    const lines = amllProps(wrapper);
    expect(lines).toHaveLength(2);
    expect(lines[0].translatedLyric).toBe("你");
    expect(lines[0].romanLyric).toBe("kimi ga");
  });

  it("译按钮关闭（zhVisible=false）后中文隐藏，原文/罗马音保留", async () => {
    const wrapper = mountPanel();
    toggleZh(); // state.zhVisible: true → false
    expect(state.zhVisible).toBe(false);
    await nextTick();
    const lines = amllProps(wrapper);
    expect(lines.every((l) => l.translatedLyric === "")).toBe(true); // 中文隐藏
    expect(lines[0].words[0].word).toBe("君が"); // 原文仍在
    expect(lines[0].romanLyric).toBe("kimi ga"); // 罗马音仍在
  });

  it("再点一次恢复中文显示", async () => {
    const wrapper = mountPanel();
    toggleZh();
    await nextTick();
    toggleZh(); // false → true
    await nextTick();
    const lines = amllProps(wrapper);
    expect(lines[0].translatedLyric).toBe("你");
  });

  it("设置里关闭中文（lyricSettings.showZh=false）同样隐藏", async () => {
    const wrapper = mountPanel();
    lyricSettings.showZh = false;
    await nextTick();
    const lines = amllProps(wrapper);
    expect(lines.every((l) => l.translatedLyric === "")).toBe(true);
  });

  it("歌词没有中文行时不渲染（即使开关全开）", () => {
    const wrapper = mount(LyricPanel, {
      props: { lyric: [{ type: "line", s: 0, e: 10, text: ["君が", "kimi ga"] }], current: 0 },
    });
    const lines = amllProps(wrapper);
    expect(lines).toHaveLength(1); // 无中文行的句子仍映射为一行
    expect(lines[0].translatedLyric).toBe("");
    expect(lines[0].words[0].word).toBe("君が"); // 原文仍在
  });
});
