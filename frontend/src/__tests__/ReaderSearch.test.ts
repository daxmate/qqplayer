// Reader 书内搜索集成测试：顶栏搜索按钮打开面板 / watch(searchRequest) 预填自动搜索 /
// onSearchJump 跳转 + iframe DOM 临时高亮（不进 annotations 重放链路）/ 翻页与关闭清理
// mock 模式同 Reader.test.ts：epubjs + api + annotations（annotations 补 searchBook mock）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { Mock } from "vitest";

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
    /** 默认无 views（epub.js 分页单视图）；搜索跳转测试改为返回带 document 的 views */
    views: vi.fn(() => [] as Array<{ contents?: unknown }>),
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

const apiMock = vi.hoisted(() => ({
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
  searchBook: vi.fn(),
}));

vi.mock("../books/annotations", async (importOriginal) => {
  const real = await importOriginal<typeof import("../books/annotations")>();
  return { ...real, ...apiMock };
});

import Reader from "../books/Reader.vue";
import { useToast, clearToasts } from "../composables/useToast.js";

const toastItems = useToast().items as Array<{ type: string; text: string }>;

function fetchStub(url: string | URL | Request) {
  const u = String(url);
  if (u.startsWith("/api/settings")) {
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ settings: { books: {} } }),
    });
  }
  return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) });
}

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

function makeBookObject() {
  return {
    ready: Promise.resolve(),
    renderTo: vi.fn(() => mocks.rendition),
    destroy: vi.fn(),
    navigation: { toc: [] },
  };
}

const SEARCH_CFI = "epubcfi(/6/8[chap01]!/4/2/1:0)";
const RESULT = {
  href: "chap01.xhtml",
  chapterTitle: "Chapter 1",
  sentence: "It was a galling defeat.",
  cfi: SEARCH_CFI,
  matchStart: 9,
  matchEnd: 16,
};

/** 构造当前章节 iframe document（views() 返回它，供搜索定位 + 临时高亮落点） */
function makeViewsDoc(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  mocks.rendition.views.mockReturnValue([{ contents: { document: doc } }]);
  return doc;
}

function relocatedHandler() {
  const call = mocks.rendition.on.mock.calls.find(([ev]) => ev === "relocated");
  return call ? call[1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(fetchStub));
  mocks.ePub.mockReturnValue(makeBookObject());
  mocks.rendition.display.mockResolvedValue(undefined);
  mocks.rendition.views.mockReturnValue([]);
  (apiMock.searchBook as Mock).mockResolvedValue({ query: "", results: [] });
  (apiMock.fetchAnnotations as Mock).mockResolvedValue({
    highlights: [],
    bookmarks: [],
    notes: [],
  });
  (apiMock.fetchVocab as Mock).mockResolvedValue([]);
  mocks.rendition.annotations.add.mockClear();
  mocks.rendition.annotations.remove.mockClear();
});

afterEach(() => {
  clearToasts();
});

describe("Reader 书内搜索集成", () => {
  it("顶栏搜索按钮：打开面板（空预填，不自动搜索），再点关闭", async () => {
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    expect(wrapper.find(".search-panel").exists()).toBe(false);

    const btn = wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "搜索")!;
    expect(btn.exists()).toBe(true);
    await btn.trigger("click");
    expect(wrapper.find(".search-panel").exists()).toBe(true);
    expect(apiMock.searchBook).not.toHaveBeenCalled(); // 空预填不自动搜

    await btn.trigger("click");
    expect(wrapper.find(".search-panel").exists()).toBe(false);
    wrapper.unmount();
  });

  it("searchRequest 赋值（菜单「搜索」契约）→ 面板打开、预填自动搜索、请求被消费置回 null", async () => {
    (apiMock.searchBook as Mock).mockResolvedValue({ query: "galling", results: [{ ...RESULT }] });
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();

    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = "galling";
    await flushPromises();

    expect(wrapper.find(".search-panel").exists()).toBe(true);
    expect(apiMock.searchBook).toHaveBeenCalledWith("b1", "galling");
    expect(wrapper.findAll(".search-panel-item")).toHaveLength(1);
    // 已消费：置回 null，避免重复触发
    expect((wrapper.vm as unknown as { searchRequest: string | null }).searchRequest).toBeNull();
    // 再赋值 null 不重复打开/搜索
    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = null;
    await flushPromises();
    expect(apiMock.searchBook).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("点击搜索结果 → display(cfi) + iframe DOM 临时高亮命中词（不进 annotations）", async () => {
    const doc = makeViewsDoc("<html><body><p>It was a galling defeat.</p></body></html>");
    (apiMock.searchBook as Mock).mockResolvedValue({ query: "galling", results: [{ ...RESULT }] });
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = "galling";
    await flushPromises();

    await wrapper.find(".search-panel-item").trigger("click");
    await flushPromises();

    expect(mocks.rendition.display).toHaveBeenCalledWith(SEARCH_CFI);
    // 临时高亮落在 iframe 文档（<mark class="qqp-search-hl">），而非 annotations
    const mark = doc.querySelector("mark.qqp-search-hl");
    expect(mark).not.toBeNull();
    expect(mark!.textContent).toBe("galling");
    expect(mocks.rendition.annotations.add).not.toHaveBeenCalled();
    expect(mocks.rendition.annotations.remove).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("翻页（relocated）→ 临时高亮解包还原，原文保留", async () => {
    const doc = makeViewsDoc("<html><body><p>It was a galling defeat.</p></body></html>");
    (apiMock.searchBook as Mock).mockResolvedValue({ query: "galling", results: [{ ...RESULT }] });
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = "galling";
    await flushPromises();
    await wrapper.find(".search-panel-item").trigger("click");
    await flushPromises();
    expect(doc.querySelector("mark.qqp-search-hl")).not.toBeNull();

    relocatedHandler()!({ start: { cfi: "epubcfi(/6/8!/4/2/3:0)", percentage: 0.6 } });
    await flushPromises();

    expect(doc.querySelector("mark.qqp-search-hl")).toBeNull();
    expect(doc.body.textContent).toContain("It was a galling defeat.");
    wrapper.unmount();
  });

  it("关闭面板 → 临时高亮清理", async () => {
    const doc = makeViewsDoc("<html><body><p>It was a galling defeat.</p></body></html>");
    (apiMock.searchBook as Mock).mockResolvedValue({ query: "galling", results: [{ ...RESULT }] });
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = "galling";
    await flushPromises();
    await wrapper.find(".search-panel-item").trigger("click");
    await flushPromises();
    expect(doc.querySelector("mark.qqp-search-hl")).not.toBeNull();

    await wrapper.find(".search-panel-close").trigger("click");
    await flushPromises();
    expect(wrapper.find(".search-panel").exists()).toBe(false);
    expect(doc.querySelector("mark.qqp-search-hl")).toBeNull();
    wrapper.unmount();
  });

  it("跳转定位失败（display 抛错 / 文档找不到句子）→ toast，不崩溃", async () => {
    // 1) display 抛错
    makeViewsDoc("<html><body><p>It was a galling defeat.</p></body></html>");
    (apiMock.searchBook as Mock).mockResolvedValue({ query: "galling", results: [{ ...RESULT }] });
    const wrapper = mount(Reader, { props: { book: makeBook() } });
    await flushPromises();
    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = "galling";
    await flushPromises();
    mocks.rendition.display.mockRejectedValueOnce(new Error("cfi invalid"));
    await wrapper.find(".search-panel-item").trigger("click");
    await flushPromises();
    expect(toastItems.at(-1)?.text).toBe("未能在书中定位该句");

    // 2) 句子不在当前文档
    const doc2 = makeViewsDoc("<html><body><p>Something else entirely.</p></body></html>");
    (apiMock.searchBook as Mock).mockResolvedValue({
      query: "galling",
      results: [{ ...RESULT, cfi: "epubcfi(/6/8[chap02]!/4/2/1:0)" }],
    });
    (wrapper.vm as unknown as { searchRequest: string | null }).searchRequest = "galling";
    await flushPromises();
    await wrapper.find(".search-panel-item").trigger("click");
    await flushPromises();
    expect(toastItems.at(-1)?.text).toBe("未能在书中定位该句");
    expect(doc2.querySelector("mark.qqp-search-hl")).toBeNull();
    wrapper.unmount();
  });
});
