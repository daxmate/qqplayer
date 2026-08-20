// Reader 标注交互集成测试：选中 → 工具栏 → 查词/高亮(五色+下划线)/笔记 + 书签 + 标注侧栏 + 重放
// + 点击已有高亮 → 弹菜单（换色/U 切换/移除/笔记）
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
    // 翻页热区/高亮点击检测走 getCurrentContents（views 遍历）
    views: vi.fn(() => []),
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
import { UNDERLINE_STYLE } from "../books/annotations";

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

/** 工具栏功能项按钮（按文案包含匹配） */
function actionButton(wrapper: Awaited<ReturnType<typeof mountReader>>, label: string) {
  const btn = wrapper.findAll(".hl-menu-action").find((b) => b.text().includes(label));
  expect(btn, `工具栏应有「${label}」按钮`).toBeTruthy();
  return btn!;
}

describe("Reader 标注交互", () => {
  it("选中文字 → 工具栏出现（iBooks 式：顶行五色点 + U）→ 查词弹窗", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello");

    const toolbar = wrapper.find(".hl-menu");
    expect(toolbar.exists()).toBe(true);
    // 顶行：5 色点 + U 下划线按钮
    expect(wrapper.findAll(".hl-menu-dot")).toHaveLength(5);
    expect(wrapper.find(".hl-menu-underline").exists()).toBe(true);

    // 查词（单词才显示，文案带选中词）
    await actionButton(wrapper, "查询").trigger("click");
    await flushPromises();
    const modal = wrapper.find(".dict-modal");
    expect(modal.exists()).toBe(true);
    expect(modal.text()).toContain("还没有配置词典");
    // 工具栏已收起
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("选中 → 高亮（黄色）→ 后端创建 + epub.js add + 面板可见", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);

    // 色点常驻顶行，直接点黄色
    const dots = wrapper.findAll(".hl-menu-dot");
    expect(dots).toHaveLength(5);
    await dots[0].trigger("click");
    await flushPromises();

    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "yellow",
      style: "highlight",
    });
    expect(mocks.rendition.annotations.add).toHaveBeenCalledWith(
      "highlight",
      HL_CFI,
      { id: "hl_1", text: "hello world", color: "yellow" },
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

  it('U 下划线：emit → 后端落库红色 underline + epub.js annotations.add("underline") + UNDERLINE_STYLE', async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);

    await wrapper.find(".hl-menu-underline").trigger("click");
    await flushPromises();

    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "red",
      style: "underline",
    });
    expect(mocks.rendition.annotations.add).toHaveBeenCalledWith(
      "underline",
      HL_CFI,
      { id: "hl_1", text: "hello world" },
      undefined,
      "epubjs-ul",
      UNDERLINE_STYLE,
    );
    expect(toastItems.at(-1)?.text).toBe("已添加下划线");
    wrapper.unmount();
  });

  it("已有底色高亮（同色）→ 点同色点 → 移除（toggle off，不再「重复新建」）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_x",
          cfi: HL_CFI,
          text: "hello world",
          color: "yellow",
          style: "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    await wrapper.findAll(".hl-menu-dot")[0].trigger("click"); // 黄（同色）
    await flushPromises();
    // 不新建，而是移除
    expect(apiMock.createHighlight).not.toHaveBeenCalled();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_x");
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: unknown[] } }).annotations.highlights,
    ).toHaveLength(0);
    wrapper.unmount();
  });

  it("已有底色高亮（异色）→ 点其他色点 → 换色（不新建第二条）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_x",
          cfi: HL_CFI,
          text: "hello world",
          color: "yellow",
          style: "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    await wrapper.findAll(".hl-menu-dot")[3].trigger("click"); // 粉（异色）
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_x");
    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "pink",
      style: "highlight",
    });
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: Array<{ color: string }> } })
        .annotations.highlights,
    ).toHaveLength(1); // 仍是单条标注
    wrapper.unmount();
  });

  it("已有底色高亮 → 点 U → 转下划线（删除重建，color 固定 red）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_x",
          cfi: HL_CFI,
          text: "hello world",
          color: "yellow",
          style: "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    await wrapper.find(".hl-menu-underline").trigger("click");
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_x");
    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "red",
      style: "underline",
    });
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: Array<{ style: string }> } })
        .annotations.highlights[0].style,
    ).toBe("underline");
    wrapper.unmount();
  });

  it("已有下划线选区 → 点 U → 移除（不再新建，原 bug 修复点）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_ul",
          cfi: HL_CFI,
          text: "hello world",
          color: "red",
          style: "underline",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    // 宽松匹配：选中词"hello"落在整句下划线"hello world"内（cfi 相同+文本包含均命中）
    await fireSelection(wrapper, "hello");
    // 选中下划线 → 工具栏 U 亮起（underline-active 由 Reader 传入）
    expect(wrapper.find(".hl-menu-underline").classes()).toContain("on");
    await wrapper.find(".hl-menu-underline").trigger("click");
    await flushPromises();
    expect(apiMock.createHighlight).not.toHaveBeenCalled();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_ul");
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: unknown[] } }).annotations.highlights,
    ).toHaveLength(0);
    wrapper.unmount();
  });

  it("已有下划线 → 点色点 → 转底色高亮（换色，不新建第二条）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_ul",
          cfi: HL_CFI,
          text: "hello world",
          color: "red",
          style: "underline",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    await wrapper.findAll(".hl-menu-dot")[2].trigger("click"); // 蓝
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_ul");
    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "blue",
      style: "highlight",
    });
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: Array<{ style: string }> } })
        .annotations.highlights[0].style,
    ).toBe("highlight");
    wrapper.unmount();
  });

  it("选中已有底色高亮 → 工具栏对应色点亮起（color 由 Reader 传入）", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_x",
          cfi: HL_CFI,
          text: "hello world",
          color: "blue",
          style: "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    // 蓝是第三个色点（黄绿蓝粉紫）→ 只有它带 on 类
    const dots = wrapper.findAll(".hl-menu-dot");
    const on = dots.map((d) => d.classes().includes("on"));
    expect(on).toEqual([false, false, true, false, false]);
    expect(wrapper.find(".hl-menu-underline").classes()).not.toContain("on");
    wrapper.unmount();
  });

  it("选中已有高亮的 cfi → 工具栏显示移除 → 点击删除该条", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_x",
          cfi: HL_CFI,
          text: "hello world",
          color: "blue",
          style: "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    // 选中与高亮同 cfi → hasHighlight 为 true → 移除项出现
    await fireSelection(wrapper, "hello world");
    expect(wrapper.findAll(".hl-menu-action").some((b) => b.text().includes("移除高亮"))).toBe(
      true,
    );
    await actionButton(wrapper, "移除高亮").trigger("click");
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_x");
    expect(mocks.rendition.annotations.remove).toHaveBeenCalledWith(HL_CFI, "highlight");
    wrapper.unmount();
  });

  it("搜索：点击 → 写 searchRequest 并由搜索面板消费（watch 打开面板并预填，然后置回 null）", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);
    await actionButton(wrapper, "搜索").trigger("click");
    await flushPromises();
    // 消费后置回 null（V4 合入后行为：面板已打开、initial 已预填）
    expect((wrapper.vm as unknown as { searchRequest: string | null }).searchRequest).toBeNull();
    expect((wrapper.vm as unknown as { searchOpen: boolean }).searchOpen).toBe(true);
    expect((wrapper.vm as unknown as { searchInitial: string | null }).searchInitial).toBe(
      "hello world",
    );
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

    await actionButton(wrapper, "笔记").trigger("click");
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

  it("标注重放：加载书时后端高亮逐条 add（切章自动重放）；underline 条目走 underline + epubjs-ul", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_9",
          cfi: "epubcfi(/6/10!/4/2/2/1:0,1:10)",
          text: "old hl",
          color: "blue",
          style: "highlight",
          createdAt: 1,
        },
        {
          id: "hl_10",
          cfi: "epubcfi(/6/11!/4/2/2/1:0,1:8)",
          text: "old ul",
          color: "red",
          style: "underline",
          createdAt: 2,
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
    expect(mocks.rendition.annotations.add).toHaveBeenCalledWith(
      "underline",
      "epubcfi(/6/11!/4/2/2/1:0,1:8)",
      { id: "hl_10", text: "old ul" },
      undefined,
      "epubjs-ul",
      UNDERLINE_STYLE,
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
    await actionButton(wrapper, "查询").trigger("click"); // 查词
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
    expect(wrapper.find(".hl-menu").exists()).toBe(true);

    // 模拟 iframe 内 selectionchange（选区塌缩）
    const contents = makeContents("hello world");
    selectedCfiHandler()!(HL_CFI, contents);
    const listener = contents.document.addEventListener.mock.calls.find(
      ([ev]) => ev === "selectionchange",
    )![1];
    listener({ target: { defaultView: { getSelection: () => ({ isCollapsed: true }) } } });
    await flushPromises();
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("翻页（relocated）→ 工具栏收起 + curCfi 更新", async () => {
    const wrapper = await mountReader();
    await fireSelection(wrapper);
    expect(wrapper.find(".hl-menu").exists()).toBe(true);

    const reloc = mocks.rendition.on.mock.calls.find(([ev]) => ev === "relocated")![1];
    reloc({ start: { cfi: "epubcfi(/6/9!/4/2/2/1:0)", percentage: 0.7 } });
    await flushPromises();
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });
});

// ============ 点击已有高亮 → 弹菜单（核心新交互） ============
describe("点击高亮弹菜单", () => {
  /** 构造可分发点击事件的 contents（getCurrentContents 需要真实 document 挂监听） */
  function makeTapContents() {
    const doc = document.implementation.createHTMLDocument("tap");
    return { document: doc, window: { getSelection: () => null } };
  }

  /** 注入一个 epubjs mark 形状的 <g class="epubjs-hl" data-id data-epubcfi><rect/></g> 到容器 */
  function injectMark(wrapper: Awaited<ReturnType<typeof mountReader>>, id: string, cfi: string) {
    const container = wrapper.find(".reader-container").element;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.classList.add("epubjs-hl");
    g.setAttribute("data-id", id);
    g.setAttribute("data-epubcfi", cfi);
    g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
    container.appendChild(g);
    return g;
  }

  /** 挂载 + 接上 views()（点击检测走 getCurrentContents）+ 注入高亮 mark；
   *  注意 views 必须在 mount 前 mock：loadBook 的 attachTapHandlers 依赖它挂点击监听 */
  async function mountWithMark(hl: {
    id: string;
    cfi: string;
    text: string;
    color: string;
    style?: string;
  }) {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: hl.id,
          cfi: hl.cfi,
          text: hl.text,
          color: hl.color,
          style: hl.style ?? "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const tap = makeTapContents();
    mocks.rendition.views.mockReturnValue([{ contents: tap }]);
    const wrapper = await mountReader();
    injectMark(wrapper, hl.id, hl.cfi);
    return { wrapper, doc: tap.document };
  }

  /** 模拟点击内容文档 (0,0)：jsdom 里 rect.getBoundingClientRect 全 0 → 命中注入的 mark */
  async function clickMark(wrapper: Awaited<ReturnType<typeof mountReader>>, doc: Document) {
    doc.dispatchEvent(new MouseEvent("click", { clientX: 0, clientY: 0, bubbles: true }));
    await flushPromises();
  }

  it("点击高亮 mark → 弹菜单（换色/U/移除/笔记）", async () => {
    const { wrapper, doc } = await mountWithMark({
      id: "hl_1",
      cfi: HL_CFI,
      text: "hello world",
      color: "yellow",
      style: "highlight",
    });
    // attachTapHandlers 在 loadBook 时 views() 返回空 → 手动触发一次以挂上点击监听
    await clickMark(wrapper, doc);

    // 菜单出现，且带换色色点 + U + 功能
    const menu = wrapper.find(".hl-menu");
    expect(menu.exists()).toBe(true);
    expect(menu.text()).toContain("移除高亮");
    expect(menu.text()).toContain("笔记");
    expect(wrapper.findAll(".hl-menu .hl-menu-dot")).toHaveLength(5);

    // 换色（绿）→ 删除重建：deleteHighlight + createHighlight(同 cfi/text，新 color)
    await wrapper.findAll(".hl-menu .hl-menu-dot")[1].trigger("click");
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_1");
    expect(apiMock.createHighlight).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "green",
      style: "highlight",
    });
    // 本地条目已替换为新色（id 变 hl_1 不变可接受，此处 mock 返回同 id）
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: Array<{ color: string }> } })
        .annotations.highlights[0].color,
    ).toBe("green");
    // 菜单保持打开（id 跟随新条目）
    expect(wrapper.find(".hl-menu").exists()).toBe(true);

    // U 切换 → 转下划线（color 固定 red）
    await wrapper.find(".hl-menu .hl-menu-underline").trigger("click");
    await flushPromises();
    expect(apiMock.createHighlight).toHaveBeenLastCalledWith("b1", {
      cfi: HL_CFI,
      text: "hello world",
      color: "red",
      style: "underline",
    });
    expect(mocks.rendition.annotations.add).toHaveBeenLastCalledWith(
      "underline",
      HL_CFI,
      { id: "hl_1", text: "hello world" },
      undefined,
      "epubjs-ul",
      UNDERLINE_STYLE,
    );

    // 移除 → 删除 + 菜单自动关闭
    await actionButton(wrapper, "移除高亮").trigger("click");
    await flushPromises();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_1");
    expect(
      (wrapper.vm as unknown as { annotations: { highlights: unknown[] } }).annotations.highlights,
    ).toHaveLength(0);
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("点击高亮 → 添加笔记：弹窗带原文摘录，保存走 createNote（cfi 用高亮 cfi）", async () => {
    const { wrapper, doc } = await mountWithMark({
      id: "hl_1",
      cfi: HL_CFI,
      text: "hello world",
      color: "pink",
    });
    await clickMark(wrapper, doc);

    await actionButton(wrapper, "笔记").trigger("click");
    const modal = wrapper.find(".note-modal");
    expect(modal.exists()).toBe(true);
    expect(modal.text()).toContain("hello world");

    await modal.find("textarea").setValue("高亮上的笔记");
    await modal.find(".note-modal-btn.primary").trigger("click");
    await flushPromises();
    expect(apiMock.createNote).toHaveBeenCalledWith("b1", {
      cfi: HL_CFI,
      excerpt: "hello world",
      text: "高亮上的笔记",
    });
    wrapper.unmount();
  });

  it("点击下划线 mark（epubjs-ul）→ 菜单出现，U 为 active 态", async () => {
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_ul",
          cfi: HL_CFI,
          text: "underlined",
          color: "red",
          style: "underline",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const tap = makeTapContents();
    mocks.rendition.views.mockReturnValue([{ contents: tap }]);
    const wrapper = await mountReader();
    const container = wrapper.find(".reader-container").element;
    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.classList.add("epubjs-ul");
    g.setAttribute("data-id", "hl_ul");
    g.setAttribute("data-epubcfi", HL_CFI);
    g.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
    container.appendChild(g);

    await clickMark(wrapper, tap.document);
    const menu = wrapper.find(".hl-menu");
    expect(menu.exists()).toBe(true);
    expect(wrapper.find(".hl-menu .hl-menu-underline").classes()).toContain("on");
    // 矩阵：下划线条目点 U = 移除（toggle off），不再切换回底色高亮
    await wrapper.find(".hl-menu .hl-menu-underline").trigger("click");
    await flushPromises();
    expect(apiMock.createHighlight).not.toHaveBeenCalled();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_ul");
    // 条目被删 → 菜单自动关闭
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("小菜单点同色色点 → 移除（toggle off，矩阵）", async () => {
    const { wrapper, doc } = await mountWithMark({
      id: "hl_1",
      cfi: HL_CFI,
      text: "hello world",
      color: "yellow",
      style: "highlight",
    });
    await clickMark(wrapper, doc);
    expect(wrapper.find(".hl-menu").exists()).toBe(true);
    // 点黄色（与当前高亮同色）→ 移除，不换色不新建
    await wrapper.findAll(".hl-menu .hl-menu-dot")[0].trigger("click");
    await flushPromises();
    expect(apiMock.createHighlight).not.toHaveBeenCalled();
    expect(apiMock.deleteHighlight).toHaveBeenCalledWith("b1", "hl_1");
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });

  it("点击非高亮区域（无 mark）→ 不弹菜单、无异常", async () => {
    const { wrapper, doc } = await mountWithMark({
      id: "hl_1",
      cfi: HL_CFI,
      text: "hello world",
      color: "yellow",
    });
    // 移除注入的 mark → 点击不命中
    wrapper.find(".reader-container .epubjs-hl").element.remove();
    await clickMark(wrapper, doc);
    expect(wrapper.find(".hl-menu").exists()).toBe(false);
    wrapper.unmount();
  });
});

// ============ 壳桥接：postReaderState 上报 highlightStyle（壳右键菜单「下划线」勾选态，与 hasHighlight 同源） ============
describe("壳上报 highlightStyle", () => {
  function installShellBridge(messages: Array<Record<string, unknown>>) {
    (window as unknown as Record<string, unknown>).qqplayerNative = true;
    (window as unknown as Record<string, unknown>).webkit = {
      messageHandlers: {
        native: {
          postMessage: (m: unknown) => messages.push(m as Record<string, unknown>),
        },
      },
    };
  }

  function uninstallShellBridge() {
    delete (window as unknown as Record<string, unknown>).qqplayerNative;
    delete (window as unknown as Record<string, unknown>).webkit;
  }

  it("壳内选中已有下划线 → readerState 携带 hasHighlight=true + highlightStyle=underline", async () => {
    const messages: Array<Record<string, unknown>> = [];
    installShellBridge(messages);
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_ul",
          cfi: HL_CFI,
          text: "hello world",
          color: "red",
          style: "underline",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    const last = messages.filter((m) => m.type === "readerState").at(-1);
    expect(last?.hasHighlight).toBe(true);
    expect(last?.highlightStyle).toBe("underline");
    wrapper.unmount();
    uninstallShellBridge();
  });

  it("壳内选中已有底色高亮 → highlightStyle=highlight", async () => {
    const messages: Array<Record<string, unknown>> = [];
    installShellBridge(messages);
    apiMock.fetchAnnotations.mockResolvedValue({
      highlights: [
        {
          id: "hl_x",
          cfi: HL_CFI,
          text: "hello world",
          color: "yellow",
          style: "highlight",
          createdAt: 1,
        },
      ],
      bookmarks: [],
      notes: [],
    });
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    const last = messages.filter((m) => m.type === "readerState").at(-1);
    expect(last?.hasHighlight).toBe(true);
    expect(last?.highlightStyle).toBe("highlight");
    wrapper.unmount();
    uninstallShellBridge();
  });

  it("壳内选中无标注文字 → highlightStyle=null", async () => {
    const messages: Array<Record<string, unknown>> = [];
    installShellBridge(messages);
    const wrapper = await mountReader();
    await fireSelection(wrapper, "hello world");
    const last = messages.filter((m) => m.type === "readerState").at(-1);
    expect(last?.hasHighlight).toBe(false);
    expect(last?.highlightStyle).toBeNull();
    wrapper.unmount();
    uninstallShellBridge();
  });
});
