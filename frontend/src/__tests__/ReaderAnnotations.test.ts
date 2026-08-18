// Reader 标注交互集成测试：选中 → 工具栏 → 查词/高亮/笔记 + 书签 + 标注侧栏 + 重放
// 模式同 Reader.test.ts：mock epubjs + api；annotations 模块 mock API 函数（纯函数保留真实）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

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

const HL_CFI = "epubcfi(/6/8!/4/2/2/1:0,1:10)";

/** 构造一个 epub.js contents 假对象：window.getSelection 返回模拟选区 */
function makeSelection(text: string) {
  return {
    isCollapsed: false,
    rangeCount: 1,
    toString: () => text,
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 20 }),
    }),
  };
}

function makeContents(text: string) {
  return {
    window: { getSelection: () => makeSelection(text) },
    document: {
      addEventListener: vi.fn(),
      body: { innerText: `这是第一句。${text}。这是第二句！` },
    },
  };
}

function selectedHandler() {
  const call = mocks.rendition.on.mock.calls.find(([ev]) => ev === "selected");
  return call ? call[1] : null;
}

function selectedCfiHandler() {
  const call = mocks.rendition.on.mock.calls.find(([ev]) => ev === "selected");
  return call ? call[1] : null;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  vi.stubGlobal("fetch", vi.fn(fetchStub));
  mocks.ePub.mockReturnValue(makeBookObject());
  mocks.rendition.display.mockResolvedValue(undefined);
  apiMock.fetchAnnotations.mockResolvedValue({ highlights: [], bookmarks: [], notes: [] });
  apiMock.fetchVocab.mockResolvedValue([]);
  apiMock.fetchDictSettings.mockResolvedValue({ dictionaries: [], activeDictId: "" });
  apiMock.queryDict.mockResolvedValue({
    word: "hello",
    found: false,
    html: "",
    source: "",
    audio: [],
    frequency: null,
  });
  apiMock.createHighlight.mockResolvedValue({ id: "hl_1" });
  apiMock.createBookmark.mockResolvedValue({ id: "bm_1" });
  apiMock.createNote.mockResolvedValue({ id: "nt_1" });
  apiMock.deleteHighlight.mockResolvedValue(undefined);
  apiMock.deleteBookmark.mockResolvedValue(undefined);
  apiMock.deleteNote.mockResolvedValue(undefined);
  apiMock.deleteVocab.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

/** 挂载 + 渲染完成 + 容器内补 iframe（选中定位需要） */
async function mountReader(book = makeBook()) {
  const wrapper = mount(Reader, { props: { book } });
  await flushPromises();
  // epubjs 渲染的是 iframe；测试里手动补一个供 onSelected 定位
  const container = wrapper.find(".reader-container");
  if (!container.element.querySelector("iframe")) {
    container.element.appendChild(document.createElement("iframe"));
  }
  return wrapper;
}

/** 触发 epub.js selected 事件（模拟 iframe 内选中文字）；等待 Vue 异步重渲染 */
async function fireSelection(
  wrapper: Awaited<ReturnType<typeof mountReader>>,
  text = "hello world",
) {
  selectedHandler()!(HL_CFI, makeContents(text));
  await flushPromises();
  return wrapper;
}

describe("Reader 标注交互", () => {
  it("选中文字 → 工具栏出现 → 查词弹窗（无词典空态）", async () => {
    const wrapper = await mountReader();
    await await fireSelection(wrapper);

    const toolbar = wrapper.find(".sel-toolbar");
    expect(toolbar.exists()).toBe(true);
    expect(wrapper.find(".sel-toolbar-btn").text()).toContain("查词");

    // 查词 → 弹窗打开（无词典空态 + 跳转词典管理入口）
    await wrapper.findAll(".sel-toolbar-btn")[0].trigger("click");
    await flushPromises();
    const modal = wrapper.find(".dict-modal");
    expect(modal.exists()).toBe(true);
    expect(modal.text()).toContain("还没有配置词典");
    // 工具栏已收起
    expect(wrapper.find(".sel-toolbar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("选中 → 高亮（黄色）→ 后端创建 + epub.js add + 面板可见", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);

    // 高亮 → 色板 → 黄色
    await wrapper.findAll(".sel-toolbar-btn")[1].trigger("click");
    const dots = wrapper.findAll(".sel-toolbar-dot");
    expect(dots).toHaveLength(4);
    await dots[0].trigger("click");
    await flushPromises();

    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "yellow",
    });
    expect(mocks.rendition.annotations.add).toHaveBeenCalledWith(
      "highlight",
      HL_CFI,
      { id: "hl_1" },
      undefined,
      "epubjs-hl",
      expect.objectContaining({ fill: expect.any(String) }),
    );
    expect(toastItems.at(-1)?.text).toBe("已添加高亮");

    // 打开标注侧栏 → 高亮条目存在 → 删除 → 后端 DELETE + 本地移除
    const panelBtn = wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "标注")!;
    await panelBtn.trigger("click");
    expect(wrapper.find(".anno-panel").exists()).toBe(true);
    expect(wrapper.find(".anno-panel-item").text()).toContain("hello world");

    await wrapper.find(".anno-panel-item .anno-panel-action.danger").trigger("click");
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_1");
    expect(mocks.rendition.annotations.remove).toHaveBeenCalledWith(HL_CFI, "highlight");
    expect(wrapper.find(".anno-panel-item").exists()).toBe(false);
    wrapper.unmount();
  });

  it("重复高亮同一 cfi → 拒绝 + toast", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [{ id: "hl_x", cfi: HL_CFI, text: "hello world", color: "yellow", createdAt: 1 }],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper);
    await wrapper.findAll(".sel-toolbar-btn")[1].trigger("click");
    await wrapper.findAll(".sel-toolbar-dot")[0].trigger("click");
    await flushPromises();
    expect(apiMock.createHighlight).not.toHaveBeenCalled();
    expect(toastItems.at(-1)?.text).toBe("这段文字已高亮过");
    wrapper.unmount();
  });

  it("书签：顶栏按钮 → currentLocation cfi 存书签（第 3 页）；再点 → 删除", async () => {
    const wrapper = await mountReader();
    const bmBtn = wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "书签")!;

    await bmBtn.trigger("click");
    await flushPromises();
    expect(apiMock.createBookmark).toHaveBeenCalledWith("b1", {
      cfi: "epubcfi(/6/8!/4/2/2/1:0)",
      text: "第 3 页",
    });
    expect(toastItems.at(-1)?.text).toBe("已添加书签");

    // 再次点击（同 cfi）→ 删除
    await bmBtn.trigger("click");
    await flushPromises();
    expect(apiMock.deleteBookmark).toHaveBeenCalledWith("b1", "bm_1");
    expect(toastItems.at(-1)?.text).toBe("已移除书签");
    wrapper.unmount();
  });

  it("笔记：选中 → 笔记弹窗（带摘录）→ 保存 → 后端创建", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");

    await wrapper.findAll(".sel-toolbar-btn")[2].trigger("click"); // 笔记
    const modal = wrapper.find(".note-modal");
    expect(modal.exists()).toBe(true);
    expect(modal.text()).toContain("hello world"); // 原文摘录

    await modal.find("textarea").setValue("我的第一条笔记");
    await modal.find(".note-modal-btn.primary").trigger("click");
    await flushPromises();
    expect(apiMock.createNote).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      excerpt: "hello world",
      text: "我的第一条笔记",
    });
    expect(toastItems.at(-1)?.text).toBe("笔记已保存");
    wrapper.unmount();
  });

  it("标注重放：加载书时后端高亮逐条 add（切章自动重放）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_9",
          cfi: "epubcfi(/6/10!/4/2/2/1:0,1:10)",
          text: "old hl",
          color: "blue",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await flushPromises();
    expect(mocks.rendition.annotations.add).toHaveBeenCalledWith(
      "highlight",
      "epubcfi(/6/10!/4/2/2/1:0,1:10)",
      { id: "hl_9", text: "old hl", color: "blue" },
      undefined,
      "epubjs-hl",
      expect.any(Object),
    );
    wrapper.unmount();
  });

  it("生词本：加入（查词弹窗）→ 侧栏列表 → 删除", async () => {
    apiMock.fetchDictSettings.mockResolvedValue({
      dictionaries: [
        {
          id: "d1",
          name: "LDOCE",
          path: "/x.mdx",
          kind: "local",
          role: "define",
          enabled: true,
          addedAt: 1,
        },
      ],
      activeDictId: "d1",
    });
    apiMock.queryDict.mockResolvedValue({
      word: "hello",
      found: false,
      html: "",
      source: "",
      audio: [],
      frequency: null,
    });
    apiMock.addVocab.mockResolvedValue({ id: "vw_1" });
    apiMock.fetchVocab.mockResolvedValue([
      {
        id: "vw_1",
        word: "hello",
        context: "这是第一句。hello world。这是第二句！",
        bookId: "b1",
        bookTitle: "三体",
        cfi: HL_CFI,
        addedAt: 1,
      },
    ]);

    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello");
    await wrapper.findAll(".sel-toolbar-btn")[0].trigger("click"); // 查词
    await flushPromises();
    await wrapper.find(".dict-modal-btn.vocab").trigger("click"); // 加入生词本
    await flushPromises();
    expect(apiMock.addVocab).toHaveBeenCalledWith({
      word: "hello",
      context: "hello。",
      bookId: "b1",
      bookTitle: "三体",
      cfi: HL_CFI,
    });
    expect(toastItems.at(-1)?.text).toBe("已加入生词本");

    // 关弹窗 → 打开侧栏生词本 tab → 有词 → 删除
    await wrapper.find(".dict-modal-head .dict-modal-btn.icon").trigger("click");
    const panelBtn = wrapper
      .findAll(".reader-topbar .reader-btn")
      .find((b) => b.attributes("title") === "标注")!;
    await panelBtn.trigger("click");
    await wrapper.findAll(".anno-panel-tab")[1].trigger("click");
    expect(wrapper.find(".anno-panel-item.vocab").text()).toContain("hello");
    await wrapper.find(".anno-panel-item.vocab .anno-panel-action.danger").trigger("click");
    await flushPromises();
    expect(apiMock.deleteVocab).toHaveBeenCalledWith("vw_1");
    wrapper.unmount();
  });

  it("选区收起（selectionchange）→ 工具栏隐藏", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);
    expect(wrapper.find(".sel-toolbar").exists()).toBe(true);

    // 模拟 iframe 内 selectionchange（选区塌缩）
    const contents = makeContents("hello world");
    selectedCfiHandler()!(HL_CFI, contents);
    const listener = contents.document.addEventListener.mock.calls.find(
      ([ev]) => ev === "selectionchange",
    )![1];
    listener({ target: { defaultView: { getSelection: () => ({ isCollapsed: true }) } } });
    await flushPromises();
    expect(wrapper.find(".sel-toolbar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("翻页（relocated）→ 工具栏收起 + curCfi 更新", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);
    expect(wrapper.find(".sel-toolbar").exists()).toBe(true);

    const reloc = mocks.rendition.on.mock.calls.find(([ev]) => ev === "relocated")![1];
    reloc({ start: { cfi: "epubcfi(/6/9!/4/2/2/1:0)", percentage: 0.7 } });
    await flushPromises();
    expect(wrapper.find(".sel-toolbar").exists()).toBe(false);
    wrapper.unmount();
  });
});
