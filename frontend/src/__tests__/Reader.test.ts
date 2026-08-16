// Reader 阅读器组件测试：加载参数/恢复进度、relocated 节流保存、字号、主题、关闭
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

const mocks = vi.hoisted(() => {
  const rendition = {
    themes: { register: vi.fn(), select: vi.fn(), fontSize: vi.fn() },
    on: vi.fn(),
    display: vi.fn().mockResolvedValue(undefined),
    next: vi.fn(),
    prev: vi.fn(),
    destroy: vi.fn(),
    resize: vi.fn(),
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

import { saveBookProgress } from "../books/api";
import { uiSettings } from "../composables/useSettings.js";
import Reader from "../books/Reader.vue";

// jsdom 环境无 localStorage：用内存 Map 替代（Reader 字号记忆依赖）
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
  vi.stubGlobal("localStorage", lsMock); // afterEach 不 unstub，保持常驻
  // loadBook 现在先 fetch(fileUrl) → arrayBuffer → ePub(ArrayBuffer)（参考 ~/codes/qq 成功案例）
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    ),
  );
  mocks.ePub.mockReturnValue(makeBookObject());
  mocks.rendition.display.mockResolvedValue(undefined);
  (saveBookProgress as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  // 主题默认跟随 uiSettings（dark）
  uiSettings.theme = "dark";
  document.documentElement.dataset.theme = "dark";
  try {
    localStorage.removeItem("qqplayer.books.fontSize");
  } catch {
    /* 忽略 */
  }
});

afterEach(() => {
  uiSettings.theme = "dark";
});

describe("Reader", () => {
  it("加载参数：ePub(fileUrl) → renderTo(容器, 尺寸) → display(恢复 cfi)", async () => {
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

  it("字号增减：+/- 更新显示、记忆 localStorage、themes.fontSize 生效", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    const fontBtns = wrapper.findAll(".reader-font .reader-btn");
    expect(fontBtns).toHaveLength(2); // 减 / 加
    expect(wrapper.find(".reader-font-val").text()).toBe("100%");

    await fontBtns[1].trigger("click"); // +
    expect(wrapper.find(".reader-font-val").text()).toBe("110%");
    expect(mocks.rendition.themes.fontSize).toHaveBeenCalledWith("110%");
    expect(localStorage.getItem("qqplayer.books.fontSize")).toBe("110");

    // 新实例恢复记忆字号（当前存的是 110）
    wrapper.unmount();
    const wrapper2 = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    expect(wrapper2.find(".reader-font-val").text()).toBe("110%");

    // 新实例里减号 → 100%
    await wrapper2.findAll(".reader-font .reader-btn")[0].trigger("click");
    expect(wrapper2.find(".reader-font-val").text()).toBe("100%");
    expect(localStorage.getItem("qqplayer.books.fontSize")).toBe("100");
    wrapper2.unmount();
  });

  it("主题跟随：uiSettings.theme 变化 → themes.register 两套 + select 对应主题", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    expect(mocks.rendition.themes.register).toHaveBeenCalledWith("light", expect.any(Object));
    expect(mocks.rendition.themes.register).toHaveBeenCalledWith("dark", expect.any(Object));
    expect(mocks.rendition.themes.select).toHaveBeenLastCalledWith("dark");

    uiSettings.theme = "light";
    await flushPromises();
    expect(mocks.rendition.themes.select).toHaveBeenLastCalledWith("light");

    wrapper.unmount();
  });

  it("关闭：顶栏返回按钮 emit close；翻页按钮调 rendition.next/prev", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    // 顶栏按钮：返回 / 目录 / 减 / 加 / 上一页 / 下一页
    const topBtns = wrapper.findAll(".reader-topbar .reader-btn");
    expect(topBtns.length).toBeGreaterThanOrEqual(5);
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
