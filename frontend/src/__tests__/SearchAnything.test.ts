// search anything 全屏搜索层测试
// 依赖：本地 stub（同路径，不 commit）—— useSearchAnything / settingsIndex / InlineControl
// 覆盖：入口渲染 / 遮罩开合 / 结果行 badge / 键盘导航 / Esc 与点空白 / 空态设置目录 / 内联控件互斥 / Cmd+K / playerCore 守卫
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import usePlayer 前注册）
class FakeAudio {
  static instances: FakeAudio[] = [];
  src = "";
  currentTime = 0;
  playbackRate = 1;
  paused = true;
  duration = 0;
  ended = false;
  listeners: Record<string, (() => void) | undefined> = {};
  constructor() {
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
  addEventListener(ev: string, fn: () => void) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

const SearchAnything = (await import("../components/SearchAnything.vue")).default;
const { useSearchAnything } = await import("../composables/useSearchAnything.js");
const { settingsIndex } = await import("../settingsIndex");
const { clearHistory } = await import("../composables/searchHistory.js");
const { state, playbackSettings, setupKeyboardShortcuts } =
  await import("../composables/usePlayer.js");

const { query, results, loading, isSearchOpen, onlineSource } = useSearchAnything();
import type { SearchResult } from "../composables/useSearchAnything.js";

const SONGS = [
  { id: "a", path: "/lib/a.mp3", name: "知足", artist: "五月天", album: "知足" },
  { id: "b", path: "/lib/b.mp3", name: "倔强", artist: "五月天", album: "神的孩子都在跳舞" },
];

function makeItem(over: Partial<SearchResult> = {}): SearchResult {
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

// 模块级 wrapper：所有用例均先调用 mountOverlay()/mount 赋值后再使用（afterEach 负责卸载）
// 初始值用断言占位（null 仅类型占位，运行时任何读取前必已赋值）
let wrapper: VueWrapper = null as unknown as VueWrapper;

beforeEach(() => {
  // 重置搜索历史模块内存态（jsdom 无 localStorage：Enter 用例只写内存，不跨用例残留）
  clearHistory();
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
  onlineSource.value = "netease"; // 源切换状态重置，防用例间污染
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ items: [] }) })),
  );
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null as unknown as VueWrapper;
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
function keydown(init: KeyboardEventInit) {
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

  it("空态（未输入）不显示设置目录，显示输入提示", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    await nextTick();
    expect(wrapper.find(".sa-dir").exists()).toBe(false);
    expect(wrapper.text()).toContain("输入关键词开始搜索");
  });

  it("设置行展开内联控件（互斥单开）+ 开关切换生效", async () => {
    mountOverlay();
    isSearchOpen.value = true;
    // 真实 settingsIndex 按 type 查找（索引顺序与 stub 不同，不能假设 [0]/[1]）
    const toggleEntry = settingsIndex.find((e) => e.type === "toggle")!;
    const sliderEntry = settingsIndex.find((e) => e.type === "slider")!;
    results.value = [
      makeItem({
        kind: "setting",
        id: "st-v",
        title: toggleEntry.labelKey,
        badge: "设置",
        payload: toggleEntry,
      }),
      makeItem({
        kind: "setting",
        id: "st-f",
        title: sliderEntry.labelKey,
        badge: "设置",
        payload: sliderEntry,
      }),
    ];
    query.value = "设置";
    await nextTick();
    // 展开第一条 → 内联控件出现
    await wrapper.findAll(".sa-row")[0].trigger("click");
    await nextTick();
    expect(wrapper.find(".sa-inline").exists()).toBe(true);
    expect(wrapper.find(".ic-switch").exists()).toBe(true);
    // 开关切换生效（entry.set 被调用）
    const before = toggleEntry.get();
    await wrapper.find(".ic-switch").trigger("click");
    expect(toggleEntry.get()).toBe(!before);
    toggleEntry.set(before); // 恢复原值，避免污染后续用例
    // 展开第二条 → 第一条收起（互斥）
    await wrapper.findAll(".sa-row")[1].trigger("click");
    await nextTick();
    const inlineRows = wrapper.findAll(".sa-inline");
    expect(inlineRows.length).toBe(1);
    expect(inlineRows[0].find(".ic-switch").exists()).toBe(false); // 第二条是 slider
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
  function captureHandler(): ((ev: KeyboardEvent) => void) | null {
    const addSpy = vi.spyOn(window, "addEventListener");
    setupKeyboardShortcuts();
    const call = addSpy.mock.calls.find((c) => c[0] === "keydown");
    return call ? (call[1] as (ev: KeyboardEvent) => void) : null;
  }
  function fire(handler: (ev: KeyboardEvent) => void, code: string, target: unknown = {}) {
    const ev = { code, target, preventDefault: vi.fn() } as unknown as KeyboardEvent;
    handler(ev);
    return ev;
  }

  it("isSearchOpen 时 Space/←→/↑↓ 不误触播放（收起后恢复）", () => {
    const h = captureHandler();
    expect(h).toBeTruthy();
    const a = FakeAudio.instances[0]!;
    state.currentSong = { path: "/a.mp3" };
    a.paused = true;
    // 搜索层打开：Space 不播放、↑ 不调音量
    isSearchOpen.value = true;
    fire(h!, "Space");
    expect(a.paused).toBe(true);
    state.volume = 0.5;
    fire(h!, "ArrowUp");
    expect(state.volume).toBe(0.5);
    // 收起后恢复
    isSearchOpen.value = false;
    fire(h!, "Space");
    expect(a.paused).toBe(false);
  });
});

describe("在线源切换（网易云 / 歌曲海）", () => {
  it("切到歌曲海后搜索请求带 source=gequhai，结果 badge 显示歌曲海", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        if (String(url).includes("source=gequhai")) {
          return {
            ok: true,
            json: async () => ({
              items: [
                {
                  id: "326",
                  title: "晴天",
                  artist: "周杰伦",
                  album: null,
                  cover: null,
                  duration: null,
                  level: "320",
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({ items: [] }) };
      }),
    );
    mountOverlay();
    isSearchOpen.value = true;
    query.value = "晴天";
    await new Promise((r) => setTimeout(r, 300)); // debounce 250ms
    await flushPromises();
    // 切到歌曲海（setOnlineSource 立即重搜，不走 debounce）
    const srcBtn = [...document.querySelectorAll(".sa-source")].find((b) =>
      b.textContent.includes("歌曲海"),
    );
    expect(srcBtn).toBeTruthy();
    srcBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await flushPromises();
    expect(calls.some((c) => c.includes("source=gequhai"))).toBe(true);
    const badges = [...document.querySelectorAll(".sa-badge")].map((b) => b.textContent.trim());
    expect(badges).toContain("歌曲海");
  });

  it("歌曲海下载未登录 → 弹扫码登录 → 登录成功自动重试下载", async () => {
    let dlCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        const u = String(url);
        if (u.includes("source=gequhai")) {
          return {
            ok: true,
            json: async () => ({
              items: [{ id: "326", title: "晴天", artist: "周杰伦" }],
            }),
          };
        }
        if (u === "/api/gequhai/download") {
          dlCalls++;
          if (dlCalls === 1) {
            return {
              status: 401,
              ok: false,
              json: async () => ({ error: "quark_login_required" }),
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, path: "/lib/晴天-周杰伦.mp3" }),
          };
        }
        if (u === "/api/quark/login/qrcode") {
          return {
            ok: true,
            json: async () => ({
              qr_image: "data:image/png;base64,AAAA",
              qr_id: "q1",
              expires_in: 170,
            }),
          };
        }
        if (u.startsWith("/api/quark/login/status")) {
          return { ok: true, json: async () => ({ status: "ok", nickname: "夸克用户" }) };
        }
        return { ok: true, json: async () => ({ items: [] }) };
      }),
    );
    vi.useFakeTimers();
    try {
      mountOverlay();
      isSearchOpen.value = true;
      query.value = "晴天";
      await vi.advanceTimersByTimeAsync(300); // debounce → 首次搜索
      await flushPromises();
      // 切到歌曲海
      [...document.querySelectorAll(".sa-source")]
        .find((b) => b.textContent.includes("歌曲海"))!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushPromises();
      // 点在线结果行 → 401 → 弹扫码登录
      const row = [...document.querySelectorAll(".sa-row")].find((r) =>
        r.textContent.includes("晴天"),
      );
      row!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await flushPromises();
      expect(document.querySelector(".qlm")).toBeTruthy(); // 登录弹窗出现
      // 轮询 2s → status ok → emit success → 自动重试下载
      await vi.advanceTimersByTimeAsync(2000);
      await flushPromises();
      expect(dlCalls).toBe(2); // 401 一次 + 登录后重试一次
      expect(document.querySelector(".qlm")).toBeFalsy(); // 弹窗已关
    } finally {
      vi.useRealTimers();
    }
  });
});
