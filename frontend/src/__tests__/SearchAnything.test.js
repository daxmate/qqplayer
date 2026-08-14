// search anything 全屏搜索层测试
// 依赖：本地 stub（同路径，不 commit）—— useSearchAnything / settingsIndex / InlineControl
// 覆盖：入口渲染 / 遮罩开合 / 结果行 badge / 键盘导航 / Esc 与点空白 / 空态设置目录 / 内联控件互斥 / Cmd+K / playerCore 守卫
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this.src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.ended = false;
    this.listeners = {};
    FakeAudio.instances.push(this);
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

const SearchAnything = (await import("../components/SearchAnything.vue")).default;
const { useSearchAnything } = await import("../composables/useSearchAnything.js");
const { settingsIndex } = await import("../settingsIndex.js");
const { state, playbackSettings, setupKeyboardShortcuts } =
  await import("../composables/usePlayer.js");

const { query, results, loading, isSearchOpen } = useSearchAnything();

const SONGS = [
  { id: "a", path: "/lib/a.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "b", path: "/lib/b.mp3", name: "倔强", artist: "五月天", album: "神的孩子都在跳舞" },
];

function makeItem(over) {
  return {
    kind: "song",
    id: "s1",
    title: "知足",
    subtitle: "五月天 · 知足",
    badge: "本地",
    score: 100,
    payload: { path: "/lib/a.mp3" },
    ...over,
  };
}

let wrapper = null;

beforeEach(() => {
  Object.assign(state, {
    songs: SONGS,
    currentIndex: -1,
    currentSong: null,
    isPlaying: false,
    favorites: [],
    playlists: [],
    activePlaylistId: null,
    mode: "continuous",
  });
  playbackSettings.searchKey = "Meta+K";
  query.value = "";
  results.value = [];
  loading.value = false;
  isSearchOpen.value = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  isSearchOpen.value = false;
  query.value = "";
  results.value = [];
  vi.unstubAllGlobals();
});

function mountOverlay() {
  wrapper = mount(SearchAnything, { attachTo: document.body }); // 默认 = 全屏搜索层本体（attachTo 才能聚焦）
  return wrapper;
}

// 模拟真实键盘事件：派发到当前焦点元素（默认 body），冒泡到 window —— e.target 才是真实目标
// 注意 jsdom 中卸载组件后 activeElement 可能残留为已脱离文档的元素，需 isConnected 兜底
function keydown(init) {
  const ae = document.activeElement;
  const target = ae && ae.isConnected ? ae : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("search anything 入口（常态小放大镜）", () => {
  it("entry 模式只渲染放大镜按钮，无输入框/遮罩", () => {
    wrapper = mount(SearchAnything, { props: { entry: true } });
    expect(wrapper.find(".sa-entry").exists()).toBe(true);
    expect(wrapper.find("input").exists()).toBe(false);
    expect(wrapper.find(".sa-mask").exists()).toBe(false);
  });

  it("点击放大镜打开全局搜索层（isSearchOpen 单例置真，遮罩渲染）", async () => {
    const entryW = mount(SearchAnything, { props: { entry: true } });
    await entryW.find(".sa-entry").trigger("click");
    expect(isSearchOpen.value).toBe(true);
    entryW.unmount();
    wrapper = mount(SearchAnything, { attachTo: document.body });
    await nextTick();
    expect(wrapper.find(".sa-mask").exists()).toBe(true);
    expect(wrapper.find(".sa-input").exists()).toBe(true);
  });
});

describe("search anything 全屏搜索层", () => {
  it("打开时自动聚焦大搜索框", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    await flushPromises();
    expect(document.activeElement?.classList.contains("sa-input")).toBe(true);
  });

  it("输入关键词渲染混合结果行（类别 badge 可见）", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    results.value = [
      makeItem({ kind: "song", id: "s1", title: "知足", badge: "本地" }),
      makeItem({ kind: "online", id: "o1", title: "知足", subtitle: "五月天", badge: "在线" }),
      makeItem({ kind: "artist", id: "ar1", title: "五月天", subtitle: "5 首歌曲", badge: "歌手" }),
      makeItem({ kind: "album", id: "al1", title: "知足", subtitle: "五月天", badge: "专辑" }),
      makeItem({
        kind: "setting",
        id: "st1",
        title: "频谱可视化",
        badge: "设置",
        payload: settingsIndex[0],
      }),
    ];
    query.value = "五月天";
    await nextTick();
    const rows = wrapper.findAll(".sa-row");
    expect(rows.length).toBe(5);
    const badges = rows.map((r) => r.find(".sa-badge").text());
    expect(badges).toEqual(["本地", "在线", "歌手", "专辑", "设置"]);
  });

  it("键盘导航：↑↓ 移动高亮（循环），Enter 执行高亮行", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    results.value = [
      makeItem({ id: "s1", title: "知足", payload: { path: "/lib/a.mp3" } }),
      makeItem({ id: "s2", title: "倔强", payload: { path: "/lib/b.mp3" } }),
    ];
    query.value = "五月天";
    await nextTick();
    // ↑↓ 循环移动高亮
    keydown({ key: "ArrowUp" });
    await nextTick();
    expect(wrapper.findAll(".sa-row")[1].classes()).toContain("active");
    keydown({ key: "ArrowDown" });
    await nextTick();
    expect(wrapper.findAll(".sa-row")[0].classes()).toContain("active");
    keydown({ key: "ArrowDown" });
    await nextTick();
    expect(wrapper.findAll(".sa-row")[1].classes()).toContain("active");
    // Enter 播放高亮行（倔强）
    keydown({ key: "Enter" });
    await flushPromises();
    expect(state.currentSong?.path).toBe("/lib/b.mp3");
    expect(isSearchOpen.value).toBe(false); // 播放后收起
  });

  it("Enter 无高亮时执行首行", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    results.value = [makeItem({ id: "s1", payload: { path: "/lib/a.mp3" } })];
    query.value = "知足";
    await nextTick();
    keydown({ key: "Enter" });
    await flushPromises();
    expect(state.currentSong?.path).toBe("/lib/a.mp3");
  });

  it("Esc 收起并清空；点遮罩空白收起（点面板不收起）", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    query.value = "知足";
    results.value = [makeItem({})];
    await nextTick();
    keydown({ key: "Escape" });
    await nextTick();
    expect(isSearchOpen.value).toBe(false);
    expect(query.value).toBe(""); // clear() 重置
    // 再开：点面板不收起
    isSearchOpen.value = true;
    query.value = "abc";
    await nextTick();
    await wrapper.find(".sa-panel").trigger("mousedown");
    await nextTick();
    expect(isSearchOpen.value).toBe(true);
    // 点遮罩空白收起（.self：target 必须是遮罩本身）
    await wrapper.find(".sa-mask").trigger("mousedown");
    await nextTick();
    expect(isSearchOpen.value).toBe(false);
  });

  it("空态（未输入）显示设置目录：分类标题 + 设置项", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    await nextTick();
    expect(wrapper.find(".sa-dir").exists()).toBe(true);
    expect(wrapper.text()).toContain("播放"); // settings.category.playback
    expect(wrapper.text()).toContain("音乐库"); // settings.category.library
    expect(wrapper.text()).toContain("频谱可视化"); // settings.visualizer
    expect(wrapper.text()).toContain("切歌淡入淡出"); // settings.fade
  });

  it("设置行展开内联控件（互斥单开）+ 开关切换生效", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    results.value = [
      makeItem({
        kind: "setting",
        id: "st-v",
        title: "频谱可视化",
        badge: "设置",
        payload: settingsIndex[0],
      }),
      makeItem({
        kind: "setting",
        id: "st-f",
        title: "切歌淡入淡出",
        badge: "设置",
        payload: settingsIndex[1],
      }),
    ];
    query.value = "设置";
    await nextTick();
    // 展开第一条 → 内联控件出现
    await wrapper.findAll(".sa-row")[0].trigger("click");
    await nextTick();
    expect(wrapper.find(".sa-inline").exists()).toBe(true);
    expect(wrapper.find(".ic-toggle").exists()).toBe(true);
    // 开关切换生效（entry.set 被调用）
    const before = settingsIndex[0].get();
    await wrapper.find(".ic-toggle").trigger("click");
    expect(settingsIndex[0].get()).toBe(!before);
    // 展开第二条 → 第一条收起（互斥）
    await wrapper.findAll(".sa-row")[1].trigger("click");
    await nextTick();
    const inlineRows = wrapper.findAll(".sa-inline");
    expect(inlineRows.length).toBe(1);
    expect(inlineRows[0].find(".ic-toggle").exists()).toBe(false); // 第二条是 slider
    expect(inlineRows[0].find(".ic-slider").exists()).toBe(true);
    // 再点第二条 → 收起
    await wrapper.findAll(".sa-row")[1].trigger("click");
    await nextTick();
    expect(wrapper.find(".sa-inline").exists()).toBe(false);
  });
});

describe("Cmd+K 全局唤起", () => {
  it("Meta+K 打开 / 再按收起；点击期间焦点在输入框", async () => {
    mountOverlay();
    keydown({ key: "k", code: "KeyK", metaKey: true });
    await nextTick();
    expect(isSearchOpen.value).toBe(true);
    await flushPromises();
    expect(document.activeElement?.classList.contains("sa-input")).toBe(true);
    keydown({ key: "k", code: "KeyK", metaKey: true });
    await nextTick();
    expect(isSearchOpen.value).toBe(false);
  });

  it("searchKey 可配置：改键后按新键唤起（如 KeyN）", async () => {
    mountOverlay();
    playbackSettings.searchKey = "KeyN";
    keydown({ key: "n", code: "KeyN" });
    await nextTick();
    expect(isSearchOpen.value).toBe(true);
    playbackSettings.searchKey = "Meta+K";
  });

  it("搜索层打开、焦点在输入框时，录的单键不误关（searchKey=KeyK 打字 K 不收起）", async () => {
    mountOverlay();
    playbackSettings.searchKey = "KeyK";
    isSearchOpen.value = true;
    await flushPromises(); // 聚焦输入框
    keydown({ key: "k", code: "KeyK" });
    await nextTick();
    expect(isSearchOpen.value).toBe(true);
    playbackSettings.searchKey = "Meta+K";
  });
});

describe("playerCore 快捷键守卫", () => {
  // 捕获 window keydown 监听器（setupKeyboardShortcuts 注册的 SHORTCUT_HANDLER）
  function captureHandler() {
    const addSpy = vi.spyOn(window, "addEventListener");
    setupKeyboardShortcuts();
    const call = addSpy.mock.calls.find((c) => c[0] === "keydown");
    return call ? call[1] : null;
  }
  function fire(handler, code, target = {}) {
    const ev = { code, target, preventDefault: vi.fn() };
    handler(ev);
    return ev;
  }

  it("isSearchOpen 时 Space/←→/↑↓ 不误触播放（收起后恢复）", () => {
    const h = captureHandler();
    expect(h).toBeTruthy();
    const a = FakeAudio.instances[0];
    state.currentSong = { path: "/a.mp3" };
    a.paused = true;
    // 搜索层打开：Space 不播放、↑ 不调音量
    isSearchOpen.value = true;
    fire(h, "Space");
    expect(a.paused).toBe(true);
    state.volume = 0.5;
    fire(h, "ArrowUp");
    expect(state.volume).toBe(0.5);
    // 收起后恢复
    isSearchOpen.value = false;
    fire(h, "Space");
    expect(a.paused).toBe(false);
  });
});
