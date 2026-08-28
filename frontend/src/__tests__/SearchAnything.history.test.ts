// SearchAnything 搜索历史交互测试（任务 D）
// 覆盖：空 query+聚焦显示历史 / 有输入不显示历史 / 失焦不显示历史 /
// 点击历史项→填入并搜索 / ✕ 单删（不触发搜索）/ 清除全部 / Enter 提交记录（防抖自动搜索不记录）/
// 去重置顶 / ↑↓ 选中历史项 + Enter 执行 / Esc 行为不变（不清历史）
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
const { state, playbackSettings } = await import("../composables/usePlayer.js");
const { uiSettings } = await import("../composables/useSettings.js");

const { query, results, loading, isSearchOpen, onlineSource } = useSearchAnything();

// 模块级 wrapper：所有用例均先调用 openLayer()/mount 赋值后再使用（afterEach 负责卸载）
// 初始值用断言占位（null 仅类型占位，运行时任何读取前必已赋值）
let wrapper: VueWrapper = null as unknown as VueWrapper;

beforeEach(() => {
  // 清历史（历史存 uiSettings.searchHistory，后端统一设置；镜像 watch 同步到 history ref）
  uiSettings.searchHistory = [];
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
  playbackSettings.searchKey = "Meta+K";
  query.value = "";
  results.value = [];
  loading.value = false;
  isSearchOpen.value = false;
  onlineSource.value = "netease";
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

// 打开全屏搜索层（含自动聚焦 + loadHistory）
async function openLayer() {
  wrapper = mount(SearchAnything, { attachTo: document.body });
  isSearchOpen.value = true;
  await flushPromises(); // 聚焦输入框（watch → nextTick → focus）→ inputFocused=true
}

// 模拟真实键盘事件：派发到当前焦点元素（默认 body），冒泡到 window
function keydown(init: KeyboardEventInit) {
  const ae = document.activeElement;
  const target = ae && ae.isConnected ? ae : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

function seedHistory(items: string[]) {
  uiSettings.searchHistory = items;
}

function storedHistory() {
  return uiSettings.searchHistory;
}

describe("历史列表展示条件", () => {
  it("空 query + 聚焦 + 有历史 → 显示历史列表（标题 + 清除全部按钮）", async () => {
    seedHistory(["晴天", "五月天"]);
    await openLayer();
    expect(wrapper.find(".sa-history").exists()).toBe(true);
    const rows = wrapper.findAll(".sa-history-row");
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain("晴天"); // 最新在前
    expect(rows[1].text()).toContain("五月天");
    expect(wrapper.text()).toContain("搜索历史");
    expect(wrapper.text()).toContain("清除全部");
  });

  it("无历史 → 不显示历史列表，显示输入提示", async () => {
    await openLayer();
    expect(wrapper.find(".sa-history").exists()).toBe(false);
    expect(wrapper.text()).toContain("输入关键词开始搜索");
  });

  it("有输入 → 不显示历史列表（出结果）", async () => {
    seedHistory(["晴天"]);
    await openLayer();
    expect(wrapper.find(".sa-history").exists()).toBe(true);
    query.value = "五月天";
    await nextTick();
    expect(wrapper.find(".sa-history").exists()).toBe(false);
  });

  it("输入框失焦 → 不显示历史列表", async () => {
    seedHistory(["晴天"]);
    await openLayer();
    expect(wrapper.find(".sa-history").exists()).toBe(true);
    await wrapper.find(".sa-input").trigger("blur");
    await nextTick();
    expect(wrapper.find(".sa-history").exists()).toBe(false);
    expect(wrapper.text()).toContain("输入关键词开始搜索");
  });
});

describe("历史项交互", () => {
  it("点击历史项 → 填入 query 并触发搜索（走现有 doSearch 链路，含在线请求）", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(String(url));
        return { ok: true, json: async () => ({ items: [] }) };
      }),
    );
    seedHistory(["晴天"]);
    await openLayer();
    await wrapper.find(".sa-history-row").trigger("click");
    await nextTick();
    expect(query.value).toBe("晴天");
    expect(wrapper.find(".sa-history").exists()).toBe(false); // 历史列表让位于结果区
    await new Promise((r) => setTimeout(r, 300)); // debounce 250ms
    await flushPromises();
    expect(
      calls.some((c) => c.includes("/api/online/search?q=" + encodeURIComponent("晴天"))),
    ).toBe(true);
  });

  it("点击历史项 → 该词移到最前（去重置顶）", async () => {
    seedHistory(["晴天", "五月天"]);
    await openLayer();
    await wrapper.findAll(".sa-history-row")[1].trigger("click"); // 点五月天
    await nextTick();
    expect(query.value).toBe("五月天");
    expect(storedHistory()).toEqual(["五月天", "晴天"]);
  });

  it("✕ 单删：不触发搜索，列表即时更新，持久化同步", async () => {
    seedHistory(["晴天", "五月天"]);
    await openLayer();
    const rows = wrapper.findAll(".sa-history-row");
    await rows[0].find(".sa-history-del").trigger("click");
    await nextTick();
    expect(query.value).toBe(""); // 未触发搜索
    expect(wrapper.findAll(".sa-history-row")).toHaveLength(1);
    expect(wrapper.findAll(".sa-history-row")[0].text()).toContain("五月天");
    expect(storedHistory()).toEqual(["五月天"]);
  });

  it("清除全部 → 列表消失回到输入提示，持久化清空", async () => {
    seedHistory(["晴天", "五月天"]);
    await openLayer();
    await wrapper.find(".sa-history-clear").trigger("click");
    await nextTick();
    expect(wrapper.find(".sa-history").exists()).toBe(false);
    expect(wrapper.text()).toContain("输入关键词开始搜索");
    expect(storedHistory()).toEqual([]);
  });

  it("↑↓ 循环选中历史项（复用高亮移动逻辑），Enter 执行高亮项", async () => {
    seedHistory(["晴天", "五月天"]);
    await openLayer();
    // ↓ 选中第一项
    keydown({ key: "ArrowDown" });
    await nextTick();
    expect(wrapper.findAll(".sa-history-row")[0].classes()).toContain("active");
    // ↓ 到第二项
    keydown({ key: "ArrowDown" });
    await nextTick();
    expect(wrapper.findAll(".sa-history-row")[1].classes()).toContain("active");
    // ↓ 循环回第一项
    keydown({ key: "ArrowDown" });
    await nextTick();
    expect(wrapper.findAll(".sa-history-row")[0].classes()).toContain("active");
    // ↑ 回第二项
    keydown({ key: "ArrowUp" });
    await nextTick();
    expect(wrapper.findAll(".sa-history-row")[1].classes()).toContain("active");
    // Enter 执行高亮项 → 填入 query 并开始搜索
    keydown({ key: "Enter" });
    await nextTick();
    expect(query.value).toBe("五月天");
    expect(wrapper.find(".sa-history").exists()).toBe(false);
  });

  it("无高亮时 Enter（空 query）不动作、不记录", async () => {
    seedHistory(["晴天"]);
    await openLayer();
    keydown({ key: "Enter" });
    await nextTick();
    expect(query.value).toBe("");
    expect(storedHistory()).toEqual(["晴天"]);
  });
});

describe("Enter 提交记录", () => {
  it("Enter 提交记录历史；防抖自动搜索不记录", async () => {
    seedHistory(["旧词"]);
    await openLayer();
    // 防抖自动搜索（仅输入，不按 Enter）→ 不记录
    query.value = "晴天";
    await new Promise((r) => setTimeout(r, 300));
    await flushPromises();
    expect(storedHistory()).toEqual(["旧词"]);
    // Enter 提交 → 记录
    keydown({ key: "Enter" });
    await nextTick();
    expect(storedHistory()).toEqual(["晴天", "旧词"]);
    // 重复提交同词 → 去重置顶（顺序不变即置顶语义）
    keydown({ key: "Enter" });
    await nextTick();
    expect(storedHistory()).toEqual(["晴天", "旧词"]);
  });

  it("Enter 记录后重新打开搜索层 → 历史列表含新词（最新在前）", async () => {
    seedHistory(["旧词"]);
    await openLayer();
    query.value = "新词";
    keydown({ key: "Enter" });
    await nextTick();
    // 关闭（走 Esc → close() 清空 query）再打开（触发 loadHistory）
    keydown({ key: "Escape" });
    await nextTick();
    isSearchOpen.value = true;
    await flushPromises();
    const rows = wrapper.findAll(".sa-history-row");
    expect(rows.length).toBe(2);
    expect(rows[0].text()).toContain("新词");
    expect(rows[1].text()).toContain("旧词");
  });

  it("Esc 收起行为不变：层关闭、query 清空、历史保留", async () => {
    seedHistory(["晴天"]);
    await openLayer();
    keydown({ key: "Escape" });
    await nextTick();
    expect(isSearchOpen.value).toBe(false);
    expect(query.value).toBe("");
    expect(storedHistory()).toEqual(["晴天"]);
  });
});
