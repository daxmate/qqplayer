// Reader 阅读器组件测试：加载参数/恢复进度、relocated 节流保存、阅读设置面板、
// 设置应用（themes override）、字号 localStorage 一次性迁移、主题、关闭
//
// 阅读设置走后端 /api/settings（settings.ts 真实模块），fetch 按 URL 路由 stub：
// - /api/settings → 返回 { settings: { books: backendBooks } }（测试内可控）
// - 其他 → epub 文件 ArrayBuffer
// 由此可断言 PUT body（防抖写回/迁移）与 GET 兜底/clamp。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { reactive } from "vue";

const mocks = vi.hoisted(() => {
  const rendition = {
    themes: {
      register: vi.fn(),
      select: vi.fn(),
      fontSize: vi.fn(),
      font: vi.fn(),
      override: vi.fn(),
      removeOverride: vi.fn(),
    },
    on: vi.fn(),
    display: vi.fn().mockResolvedValue(undefined),
    next: vi.fn(),
    prev: vi.fn(),
    destroy: vi.fn(),
    resize: vi.fn(),
    annotations: { add: vi.fn(), remove: vi.fn() },
    hooks: { content: { register: vi.fn() } },
    currentLocation: vi.fn(() => ({
      start: { cfi: "epubcfi(/6/8!/4/2/2/1:0)", location: 2, percentage: 0.5 },
    })),
    getContents: vi.fn(() => []),
  };
  return { rendition, ePub: vi.fn() };
});

vi.mock("epubjs", () => ({ default: mocks.ePub }));

vi.mock("../books/api", () => ({
  fetchBooks: vi.fn(),
  importBook: vi.fn(),
  deleteBook: vi.fn(),
  saveBookProgress: vi.fn(),
}));

vi.mock("../books/annotations", () => ({
  fetchAnnotations: vi.fn().mockResolvedValue({ highlights: [], bookmarks: [], notes: [] }),
  createHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
  createBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  fetchVocab: vi.fn().mockResolvedValue([]),
  addVocab: vi.fn(),
  deleteVocab: vi.fn(),
  fetchDictSettings: vi.fn(),
  scanDictPath: vi.fn(),
  addDict: vi.fn(),
  uploadDictFile: vi.fn(),
  activateDict: vi.fn(),
  setDictEnabled: vi.fn(),
  deleteDict: vi.fn(),
  queryDict: vi.fn(),
  rewriteDictHtml: vi.fn((html: string) => html),
  HIGHLIGHT_COLOR_STYLES: { yellow: {}, green: {}, blue: {}, pink: {} },
  HIGHLIGHT_COLOR_HEX: { yellow: "#f6d32d", green: "#7bc47f", blue: "#64b5f6", pink: "#f28bb0" },
  isDarkBackground: vi.fn(() => false),
  VOCAB_EXPORT_URL: "/api/vocab/export",
}));

import { saveBookProgress } from "../books/api";
import { getReaderSettings, saveReaderSettings, READER_SETTINGS_DEFAULTS } from "../books/settings";
import { uiSettings } from "../composables/useSettings.js";
import Reader from "../books/Reader.vue";
import ReaderSettingsPanel from "../books/ReaderSettingsPanel.vue";

// jsdom 环境无 localStorage：用内存 Map 替代（迁移测试依赖读/清除）
const storage = new Map<string, string>();
const lsMock = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => {
    storage.set(k, String(v));
  },
  removeItem: (k: string) => {
    storage.delete(k);
  },
  clear: () => storage.clear(),
};
vi.stubGlobal("localStorage", lsMock);

// ============ 后端 settings 模拟（每个测试可改 backendBooks 控制 GET 返回值） ============
let backendBooks: Record<string, unknown> = {};
let settingsFetchFail = false;

function fetchStub(url: string | URL | Request) {
  const u = String(url);
  if (u.startsWith("/api/settings")) {
    if (settingsFetchFail) return Promise.resolve({ ok: false, status: 500, statusText: "boom" });
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: { books: { ...backendBooks } } }),
    });
  }
  return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
}

/** 收集所有 PUT /api/settings 的 body（解析 JSON），用于断言写回 */
function putBodies(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const call of (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls) {
    const init = call[1] as RequestInit | undefined;
    if (init?.method === "PUT" && String(call[0]).startsWith("/api/settings")) {
      out.push(JSON.parse(String(init.body)));
    }
  }
  return out;
}

const makeBook = (over = {}) => ({
  id: "b1",
  title: "三体",
  author: "刘慈欣",
  addedAt: 1000,
  progress: { cfi: "epubcfi(/6/8[chap01]!/4/2/2/1:0)", location: 0.3, updatedAt: 1 },
  fileUrl: "/api/books/b1/file",
  coverUrl: "/api/books/b1/cover",
  ...over,
});

const TOC = [
  { id: "c1", href: "chap1.xhtml", label: "第一章" },
  {
    id: "c2",
    href: "chap2.xhtml",
    label: "第二章",
    subitems: [{ id: "c2a", href: "chap2a.xhtml", label: "2.1 小节" }],
  },
];

function makeBookObject() {
  return {
    ready: Promise.resolve(),
    renderTo: vi.fn(() => mocks.rendition),
    destroy: vi.fn(),
    navigation: { toc: TOC },
  };
}

function relocatedHandler() {
  const call = mocks.rendition.on.mock.calls.find(([ev]) => ev === "relocated");
  return call ? call[1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  storage.clear();
  backendBooks = {};
  settingsFetchFail = false;
  vi.stubGlobal("localStorage", lsMock); // afterEach 不 unstub，保持常驻
  vi.stubGlobal("fetch", vi.fn(fetchStub));
  mocks.ePub.mockReturnValue(makeBookObject());
  mocks.rendition.display.mockResolvedValue(undefined);
  (saveBookProgress as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  // 主题默认跟随 uiSettings（dark）
  uiSettings.theme = "dark";
  document.documentElement.dataset.theme = "dark";
});

afterEach(() => {
  uiSettings.theme = "dark";
  vi.useRealTimers();
});

describe("Reader 基础", () => {
  it("加载参数：fetch(fileUrl) → ArrayBuffer → ePub → renderTo(容器, 尺寸) → display(恢复 cfi)", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    expect(mocks.ePub.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);
    const renderToCall = mocks.ePub.mock.results[0].value.renderTo.mock.calls[0];
    expect(renderToCall[0]).toBeInstanceOf(HTMLElement);
    expect(renderToCall[1]).toEqual({ width: expect.any(Number), height: expect.any(Number) });
    expect(mocks.rendition.display).toHaveBeenCalledWith("epubcfi(/6/8[chap01]!/4/2/2/1:0)");

    wrapper.unmount();
  });

  it("无进度时 display() 不带参数；换书重建（destroy + 重新加载）", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook({ progress: null }) } });
    await flushPromises();
    expect(mocks.rendition.display).toHaveBeenCalledWith(undefined);

    const book2 = makeBook({ id: "b2", title: "球状闪电", fileUrl: "/api/books/b2/file" });
    await wrapper.setProps({ book: book2 });
    await flushPromises();

    expect(mocks.rendition.destroy).toHaveBeenCalled();
    expect(mocks.ePub.mock.calls[1][0]).toBeInstanceOf(ArrayBuffer);

    wrapper.unmount();
  });

  it("relocated 防抖 ~1s 保存进度：窗口内多次只存最后一次，静默失败", async () => {
    vi.useFakeTimers();
    try {
      const wrapper = mount(Reader, { props: { book: makeBook() } });
      await flushPromises();

      const handler = relocatedHandler();
      expect(handler).toBeTypeOf("function");

      // 第一次 relocated：1s 内不保存
      handler({ start: { cfi: "cfiA", percentage: 0.5 } });
      await vi.advanceTimersByTimeAsync(500);
      expect(saveBookProgress).not.toHaveBeenCalled();

      // 窗口内再次 relocated：重置计时，仍不保存
      handler({ start: { cfi: "cfiB", percentage: 0.55 } });
      await vi.advanceTimersByTimeAsync(600);
      expect(saveBookProgress).not.toHaveBeenCalled();

      // 满 1s（自最后一次）：只保存最后一次的 cfi
      await vi.advanceTimersByTimeAsync(400);
      expect(saveBookProgress).toHaveBeenCalledTimes(1);
      expect(saveBookProgress).toHaveBeenCalledWith("b1", {
        cfi: "cfiB",
        location: 0.55,
        updatedAt: expect.any(Number),
      });

      // 保存失败静默（不抛）
      (saveBookProgress as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("network"));
      handler({ start: { cfi: "cfiC", percentage: 0.6 } });
      await vi.advanceTimersByTimeAsync(1000);
      expect(saveBookProgress).toHaveBeenCalledTimes(2);

      wrapper.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("关闭：顶栏返回按钮 emit close；翻页按钮调 rendition.next/prev", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    // 顶栏按钮：返回 / 目录 / 减 / 加 / 设置 / 上一页 / 下一页
    const topBtns = wrapper.findAll(".reader-topbar .reader-btn");
    expect(topBtns.length).toBeGreaterThanOrEqual(6);
    await topBtns[0].trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();

    const nextBtn = topBtns[topBtns.length - 1];
    const prevBtn = topBtns[topBtns.length - 2];
    await nextBtn.trigger("click");
    expect(mocks.rendition.next).toHaveBeenCalled();
    await prevBtn.trigger("click");
    expect(mocks.rendition.prev).toHaveBeenCalled();

    wrapper.unmount();
  });

  it("目录：点击目录项跳转（rendition.display(href)）", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    // 打开目录抽屉
    await wrapper.findAll(".reader-topbar .reader-btn")[1].trigger("click");
    const items = wrapper.findAll(".reader-toc-item");
    expect(items).toHaveLength(3); // 树形展平：第一章/第二章/2.1 小节

    await items[2].trigger("click");
    expect(mocks.rendition.display).toHaveBeenCalledWith("chap2a.xhtml");
    expect(wrapper.find(".reader-toc-mask").exists()).toBe(false); // 跳转后关闭

    wrapper.unmount();
  });
});

describe("Reader 阅读设置", () => {
  it("字号增减：顶栏 +/-, 即时应用 themes.fontSize, 防抖写回后端, 不写 localStorage", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    const fontBtns = wrapper.findAll(".reader-font .reader-btn");
    expect(fontBtns).toHaveLength(2); // 减 / 加
    expect(wrapper.find(".reader-font-val").text()).toBe("100%");

    await fontBtns[1].trigger("click"); // +
    expect(wrapper.find(".reader-font-val").text()).toBe("110%");
    expect(mocks.rendition.themes.fontSize).toHaveBeenLastCalledWith("110%");
    // 只读不写：localStorage 不落新值
    expect(localStorage.getItem("qqplayer.books.fontSize")).toBeNull();

    // 防抖 300ms 后 PUT { books: { fontSize: 110, ...其余字段 } }（深合并全量）
    await new Promise((r) => setTimeout(r, 350));
    const bodies = putBodies();
    expect(bodies.length).toBeGreaterThanOrEqual(1);
    expect(bodies[bodies.length - 1]).toEqual({
      books: expect.objectContaining({ fontSize: 110 }),
    });

    wrapper.unmount();
  });

  it("设置面板：齿轮开/关（遮罩点击/Escape/齿轮再次点击）", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    expect(wrapper.find(".reader-settings").exists()).toBe(false);
    const gear = wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "阅读设置")!;
    expect(gear).toBeTruthy();

    await gear.trigger("click");
    expect(wrapper.find(".reader-settings").exists()).toBe(true);

    // 遮罩点击关闭
    await wrapper.find(".reader-settings-mask").trigger("click");
    expect(wrapper.find(".reader-settings").exists()).toBe(false);

    // 再开，Escape 关闭
    await gear.trigger("click");
    expect(wrapper.find(".reader-settings").exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape" }));
    await flushPromises();
    expect(wrapper.find(".reader-settings").exists()).toBe(false);

    // 齿轮再次点击也关闭
    await gear.trigger("click");
    await gear.trigger("click");
    expect(wrapper.find(".reader-settings").exists()).toBe(false);

    wrapper.unmount();
  });

  it("设置面板：改字体族 → 即时应用 themes.font + 防抖 PUT 深合并", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    await wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "阅读设置")!
      .trigger("click");

    // 点“衬线”
    const chips = wrapper.findAll(".reader-settings-chip");
    const serif = chips.find((c) => c.text() === "衬线")!;
    await serif.trigger("click");
    expect(mocks.rendition.themes.font).toHaveBeenLastCalledWith("Georgia, serif");

    // 点“默认” → 空值 override 恢复 EPUB 自身字体
    const def = chips.find((c) => c.text() === "默认")!;
    await def.trigger("click");
    expect(mocks.rendition.themes.override).toHaveBeenCalledWith("font-family", "");

    await new Promise((r) => setTimeout(r, 350));
    const last = putBodies()[putBodies().length - 1];
    expect(last).toEqual({ books: expect.objectContaining({ fontFamily: "default" }) });

    wrapper.unmount();
  });

  it("设置应用到 epub.js：字体/字号/行距/主题色全部 override；页边距走容器 padding", async () => {
    backendBooks = { fontFamily: "sans", fontSize: 120, lineHeight: 1.8, margin: 6, theme: "dark" };
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    const themes = mocks.rendition.themes;
    expect(themes.font).toHaveBeenLastCalledWith("Helvetica, Arial, sans-serif");
    expect(themes.fontSize).toHaveBeenLastCalledWith("120%");
    expect(themes.override).toHaveBeenCalledWith("line-height", "1.8");
    // 主题色：dark 预设（textColor/bgColor 空 → 预设）
    expect(themes.override).toHaveBeenCalledWith("color", "#c8ccd4", true);
    expect(themes.override).toHaveBeenCalledWith("background", "#1f2430", true);
    // 页边距：容器 padding（epub.js 布局会覆盖 body padding，容器级才可靠）
    const containerStyle = wrapper.find(".reader-container").attributes("style");
    expect(containerStyle).toContain("padding: 6px");
    wrapper.unmount();
  });

  it("主题 auto：跟随 App 主题（uiSettings.theme 变化即时重算）+ 自定义色覆盖预设", async () => {
    backendBooks = { theme: "auto" };
    uiSettings.theme = "light";
    document.documentElement.dataset.theme = "light";
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    const themes = mocks.rendition.themes;
    const colorCalls = () => themes.override.mock.calls.filter((c) => c[0] === "color");
    const bgCalls = () => themes.override.mock.calls.filter((c) => c[0] === "background");
    // 当前生效色（最后一次 color override）
    expect(colorCalls().at(-1)![1]).toBe("#1f2328");

    // App 切 dark → auto 解析为 dark 预设
    uiSettings.theme = "dark";
    document.documentElement.dataset.theme = "dark";
    await flushPromises();
    expect(colorCalls().at(-1)![1]).toBe("#c8ccd4");
    wrapper.unmount();

    // 自定义 textColor/bgColor 覆盖预设（新开书，后端带自定义色）
    backendBooks = { theme: "dark", textColor: "#00ff00", bgColor: "#000000" };
    const wrapper2 = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    expect(colorCalls().at(-1)![1]).toBe("#00ff00");
    expect(bgCalls().at(-1)![1]).toBe("#000000");
    wrapper2.unmount();
  });

  it("字号迁移：localStorage 有旧值且后端是默认 100 → PUT 迁移 + 清除 localStorage", async () => {
    localStorage.setItem("qqplayer.books.fontSize", "130");
    backendBooks = {}; // 后端无自定义（fontSize 默认 100）
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    // 迁移 PUT 一次（body 只带 fontSize）
    const bodies = putBodies();
    expect(bodies).toContainEqual({ books: { fontSize: 130 } });
    // 清除本地旧值
    expect(localStorage.getItem("qqplayer.books.fontSize")).toBeNull();
    // UI 用迁移后的值
    expect(wrapper.find(".reader-font-val").text()).toBe("130%");

    wrapper.unmount();
  });

  it("字号迁移：后端已有自定义 → 用后端值，不迁移不清 localStorage", async () => {
    localStorage.setItem("qqplayer.books.fontSize", "130");
    backendBooks = { fontSize: 120 };
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    expect(wrapper.find(".reader-font-val").text()).toBe("120%");
    expect(putBodies()).toHaveLength(0);
    expect(localStorage.getItem("qqplayer.books.fontSize")).toBe("130"); // 遗留值不再读也不再清

    wrapper.unmount();
  });

  it("字号迁移：无旧值 → 直接用后端值，不发 PUT", async () => {
    backendBooks = { fontSize: 150 };
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    expect(wrapper.find(".reader-font-val").text()).toBe("150%");
    expect(putBodies()).toHaveLength(0);

    wrapper.unmount();
  });

  it("设置读失败 → 默认值兜底，不崩", async () => {
    settingsFetchFail = true;
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    expect(wrapper.find(".reader-font-val").text()).toBe("100%");
    // 设置保存失败静默
    await wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "阅读设置")!
      .trigger("click");
    await wrapper
      .findAll(".reader-settings-chip")
      .find((c) => c.text() === "圆体")!
      .trigger("click");
    await new Promise((r) => setTimeout(r, 350));
    expect(wrapper.find(".reader-font-val").text()).toBe("100%"); // 字号不受影响

    wrapper.unmount();
  });
});

describe("ReaderSettingsPanel 组件", () => {
  function mountPanel(over = {}) {
    return mount(ReaderSettingsPanel, {
      props: { settings: reactive({ ...READER_SETTINGS_DEFAULTS, ...over }) },
    });
  }

  it("渲染各控件：字体/字号/行距/边距/主题/颜色 + 恢复默认按钮", () => {
    const wrapper = mountPanel();
    expect(wrapper.find(".reader-settings-title").text()).toBe("阅读设置");
    // 4 字体族 + 恢复默认
    expect(wrapper.findAll(".reader-settings-chip").length).toBe(5);
    // 4 主题卡片
    expect(wrapper.findAll(".reader-settings-theme").length).toBe(4);
    // 2 颜色选择器
    expect(wrapper.findAll('input[type="color"]').length).toBe(2);
    // 2 滑杆
    expect(wrapper.findAll('input[type="range"]').length).toBe(2);
    // 字号值/行距值/边距值展示
    expect(wrapper.text()).toContain("100%");
    expect(wrapper.text()).toContain("1.6");
    expect(wrapper.text()).toContain("4px");
    wrapper.unmount();
  });

  it("控件修改 → emit patch（字体族/字号/主题）", async () => {
    const wrapper = mountPanel();
    await wrapper.findAll(".reader-settings-chip")[1].trigger("click"); // 衬线
    expect(wrapper.emitted("patch")![0]).toEqual([{ fontFamily: "serif" }]);

    await wrapper.find('.reader-btn[title="增大"]').trigger("click"); // 字号 +
    expect(wrapper.emitted("patch")!.at(-1)).toEqual([{ fontSize: 110 }]);

    await wrapper.findAll(".reader-settings-theme")[2].trigger("click"); // 深色
    expect(wrapper.emitted("patch")!.at(-1)).toEqual([{ theme: "dark" }]);
    wrapper.unmount();

    // 选中态渲染：theme 为 dark 时第 3 张卡片带 on
    const wrapper2 = mountPanel({ theme: "dark" });
    expect(wrapper2.findAll(".reader-settings-theme")[2].classes()).toContain("on");
    wrapper2.unmount();
  });

  it("滑杆：行距/边距 emit（含小数取整）", async () => {
    const wrapper = mountPanel();
    const ranges = wrapper.findAll('input[type="range"]');
    await ranges[0].setValue("1.8");
    await ranges[0].trigger("input");
    expect(wrapper.emitted("patch")!.at(-1)).toEqual([{ lineHeight: 1.8 }]);

    await ranges[1].setValue("8");
    await ranges[1].trigger("input");
    expect(wrapper.emitted("patch")!.at(-1)).toEqual([{ margin: 8 }]);
    wrapper.unmount();
  });

  it("颜色：textColor/bgColor emit + 恢复主题默认清空", async () => {
    const wrapper = mountPanel({ textColor: "#123456" });
    const colors = wrapper.findAll('input[type="color"]');
    // 自定义色时恢复按钮可用
    const resetBtn = wrapper
      .findAll(".reader-settings-chip")
      .find((c) => c.text() === "恢复主题默认色")!;
    expect(resetBtn.attributes("disabled")).toBeUndefined();

    await colors[1].setValue("#abcdef");
    await colors[1].trigger("input");
    expect(wrapper.emitted("patch")!.at(-1)).toEqual([{ bgColor: "#abcdef" }]);

    await resetBtn.trigger("click");
    expect(wrapper.emitted("patch")!.at(-1)).toEqual([{ textColor: "", bgColor: "" }]);
    wrapper.unmount();
  });

  it("关闭：X 按钮与遮罩 emit close", async () => {
    const wrapper = mountPanel();
    await wrapper.find(".reader-settings-head .reader-btn").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });
});

describe("settings 模块（/api/settings 契约）", () => {
  it("GET：缺字段/非法值 → 默认值兜底 + clamp", async () => {
    backendBooks = { lastReadId: "x", fontSize: 250, lineHeight: 3, margin: -5, theme: "wrong" };
    const s = await getReaderSettings();
    expect(s).toEqual({
      fontFamily: "default",
      fontSize: 200, // clamp 70~200
      lineHeight: 2.0, // clamp 1.0~2.0
      margin: 0, // clamp 0~15
      theme: "light", // 非法回默认
      textColor: "",
      bgColor: "",
    });
  });

  it("PUT：body 是 { books: patch } 深合并形状", async () => {
    const ok = await saveReaderSettings({ fontSize: 90, lineHeight: 1.4 });
    expect(ok).toBe(true);
    const call = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "PUT",
    )!;
    expect(call[0]).toBe("/api/settings");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      books: { fontSize: 90, lineHeight: 1.4 },
    });
  });

  it("PUT 失败 → 返回 false 不抛（调用方迁移逻辑靠它决定是否清 localStorage）", async () => {
    settingsFetchFail = true;
    await expect(saveReaderSettings({ fontSize: 110 })).resolves.toBe(false);
  });
});
