// Bookshelf 书架组件测试：渲染列表/进度条/导入/删除/空态
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../books/api", () => ({
  fetchBooks: vi.fn(),
  importBook: vi.fn(),
  deleteBook: vi.fn(),
  saveBookProgress: vi.fn(),
}));

vi.mock("../books/annotations", () => ({
  fetchAnnotations: vi.fn(),
  createHighlight: vi.fn(),
  deleteHighlight: vi.fn(),
  createBookmark: vi.fn(),
  deleteBookmark: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
  deleteNote: vi.fn(),
  fetchVocab: vi.fn(),
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

import { fetchBooks, importBook, deleteBook } from "../books/api";
import Bookshelf from "../books/Bookshelf.vue";
import { useToast, clearToasts } from "../composables/useToast.js";

// useToast.js 为 JS 模块：items 推断为 never[]，这里收窄为可读结构
const items = useToast().items as Array<{ type: string; text: string }>;

const makeBook = (over = {}) => ({
  id: "b1",
  title: "三体",
  author: "刘慈欣",
  addedAt: 1000,
  progress: null,
  fileUrl: "/api/books/b1/file",
  coverUrl: "/api/books/b1/cover",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (deleteBook as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  (importBook as ReturnType<typeof vi.fn>).mockResolvedValue(makeBook());
});

afterEach(() => {
  clearToasts();
});

describe("Bookshelf", () => {
  it("渲染书架列表（封面/书名/作者/进度条）", async () => {
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeBook({
        id: "b1",
        title: "三体",
        author: "刘慈欣",
        progress: { cfi: "cfi1", location: 0.42, updatedAt: 1 },
      }),
      makeBook({ id: "b2", title: "朝闻道", author: "", progress: null }),
    ]);

    const wrapper = mount(Bookshelf);
    await flushPromises();

    const cards = wrapper.findAll(".bs-card");
    expect(cards).toHaveLength(2);
    expect(cards[0].find(".bs-name").text()).toBe("三体");
    expect(cards[0].find(".bs-author").text()).toBe("刘慈欣");
    // 进度条：阅读中 42%
    expect(cards[0].find(".bs-progress-text").text()).toBe("阅读中 42%");
    expect(cards[0].find(".bs-progress-fill").attributes("style")).toContain("width: 42%");
    // 无进度：作者缺省 + 不渲染进度条
    expect(cards[1].find(".bs-author").text()).toBe("未知作者");
    expect(cards[1].find(".bs-progress").exists()).toBe(false);

    wrapper.unmount();
  });

  it("空态：无书时显示引导文案与导入按钮", async () => {
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const wrapper = mount(Bookshelf);
    await flushPromises();

    expect(wrapper.find(".bs-empty").exists()).toBe(true);
    expect(wrapper.find(".bs-empty-title").text()).toBe("书架空空如也");
    expect(wrapper.find(".bs-empty .bs-import-btn").exists()).toBe(true);

    wrapper.unmount();
  });

  it("导入：文件选择 .epub → importBook → 刷新列表 + toast", async () => {
    const epubFile = new File(["x"], "book.epub");
    (importBook as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeBook({ id: "b9", title: "新书", author: "佚名", progress: null }),
    );
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const wrapper = mount(Bookshelf);
    await flushPromises();

    const input = wrapper.find(".bs-file-input");
    Object.defineProperty(input.element, "files", {
      value: [epubFile, new File(["y"], "notes.txt")],
    });
    await input.trigger("change");
    await flushPromises();

    // 只导入 .epub（.txt 被过滤）
    expect(importBook).toHaveBeenCalledTimes(1);
    expect(importBook).toHaveBeenCalledWith(epubFile);
    expect(fetchBooks).toHaveBeenCalledTimes(2); // 初始 + 导入后刷新
    expect(items.some((i) => i.text === "已导入《新书》")).toBe(true);

    wrapper.unmount();
  });

  it("导入：拖拽 .epub 到网格区 → importBook；非 epub 拖入 → 错误 toast", async () => {
    const epubFile = new File(["x"], "a.epub");
    (importBook as ReturnType<typeof vi.fn>).mockResolvedValue(makeBook());
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const wrapper = mount(Bookshelf);
    await flushPromises();

    await wrapper.trigger("drop", { dataTransfer: { files: [epubFile] } });
    await flushPromises();
    expect(importBook).toHaveBeenCalledWith(epubFile);

    await wrapper.trigger("drop", { dataTransfer: { files: [new File(["y"], "b.txt")] } });
    await flushPromises();
    expect(importBook).toHaveBeenCalledTimes(1); // 非 epub 不导入
    expect(items.some((i) => i.type === "error" && i.text === "仅支持 .epub 文件")).toBe(true);

    wrapper.unmount();
  });

  it("删除：确认弹窗 → 取消不删 / 确认后 deleteBook + 刷新 + toast", async () => {
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
      makeBook({ id: "b1", title: "三体", progress: null }),
    ]);

    const wrapper = mount(Bookshelf);
    await flushPromises();

    // 取消：弹窗出现 → 点取消 → 不删除
    await wrapper.find(".bs-del").trigger("click");
    expect(wrapper.find(".bs-confirm-mask").exists()).toBe(true);
    await wrapper.find(".bs-confirm-cancel").trigger("click");
    expect(deleteBook).not.toHaveBeenCalled();
    expect(wrapper.find(".bs-confirm-mask").exists()).toBe(false);

    // 确认：再点删除 → 确认 → deleteBook + 刷新 + toast
    await wrapper.find(".bs-del").trigger("click");
    await wrapper.find(".bs-confirm-ok").trigger("click");
    await flushPromises();

    expect(deleteBook).toHaveBeenCalledTimes(1);
    expect(deleteBook).toHaveBeenCalledWith("b1");
    expect(fetchBooks).toHaveBeenCalledTimes(2);
    expect(items.some((i) => i.text === "已删除《三体》")).toBe(true);

    wrapper.unmount();
  });

  it("词典：顶栏按钮打开词典管理弹窗，不破坏书架结构", async () => {
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const wrapper = mount(Bookshelf);
    await flushPromises();

    // 词典按钮在导入按钮旁边，标题区结构不变
    const dictBtn = wrapper.find(".bs-dict-btn");
    expect(dictBtn.exists()).toBe(true);
    expect(dictBtn.text()).toContain("词典");
    expect(wrapper.find(".bs-title").text()).toBe("图书");

    await dictBtn.trigger("click");
    expect(wrapper.find(".dictmgr").exists()).toBe(true);
    expect(wrapper.find(".dictmgr-title").text()).toContain("词典管理");

    // 关闭弹窗 → 书架仍在
    await wrapper.find(".dictmgr-close").trigger("click");
    expect(wrapper.find(".dictmgr").exists()).toBe(false);
    expect(wrapper.find(".bs-empty").exists()).toBe(true);

    wrapper.unmount();
  });
});
