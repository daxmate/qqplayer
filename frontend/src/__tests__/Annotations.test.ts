// 阅读器 V2 标注组件测试：annotations.ts 纯函数 + SelectionToolbar + DictLookupModal +
// AnnotationPanel + DictManagerModal（fetch/XMLHttpRequest 全部 mock，参照 Reader.test.ts 模式）
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import { rewriteDictHtml, isDarkBackground, HIGHLIGHT_COLOR_STYLES } from "../books/annotations";
import SelectionToolbar from "../books/SelectionToolbar.vue";
import DictLookupModal from "../books/DictLookupModal.vue";
import AnnotationPanel from "../books/AnnotationPanel.vue";
import DictManagerModal from "../books/DictManagerModal.vue";
import { clearToasts } from "../composables/useToast.js";

// ============ annotations.ts 纯函数 ============
describe("annotations.ts 纯函数", () => {
  it("rewriteDictHtml：相对 src/href → 资源 URL；绝对 URL 不动", () => {
    const html =
      '<html><img src="a.gif"/><link href="style.css"/><a href="https://x.com/y">z</a>' +
      '<a href="data:image/png;base64,xx">d</a><a href="#frag">f</a></html>';
    const out = rewriteDictHtml(html, "d1");
    expect(out).toContain('src="/api/dict/resource/d1/a.gif"');
    expect(out).toContain('href="/api/dict/resource/d1/style.css"');
    expect(out).toContain('href="https://x.com/y"');
    expect(out).toContain('href="data:image/png;base64,xx"');
    expect(out).toContain('href="#frag"');
  });

  it("rewriteDictHtml：sound:// 引用 → 资源 URL；script 剔除", () => {
    const html = '<script>alert(1)</script>sound://us.mp3 <img src="b.mp3"/>';
    const out = rewriteDictHtml(html, "d1");
    expect(out).not.toContain("<script");
    expect(out).toContain("/api/dict/resource/d1/us.mp3");
    expect(out).toContain('src="/api/dict/resource/d1/b.mp3"');
  });

  it("rewriteDictHtml：非引号 src/href 与协议相对 // 不误伤", () => {
    const html = '<link href=plain.css/><img src="//cdn.example.com/x.png"/>';
    const out = rewriteDictHtml(html, "d1");
    expect(out).toContain("plain.css"); // 无引号不重写（保守）
    expect(out).toContain('src="//cdn.example.com/x.png"');
  });

  it("高亮颜色样式：四色齐全，isDarkBackground 判断正确", () => {
    expect(Object.keys(HIGHLIGHT_COLOR_STYLES).sort()).toEqual(["blue", "green", "pink", "yellow"]);
    expect(isDarkBackground("#1f2430")).toBe(true);
    expect(isDarkBackground("#ffffff")).toBe(false);
    expect(isDarkBackground("not-a-color")).toBe(false);
  });
});

// ============ 组件测试：mock annotations 模块（仅 API 函数，纯函数保留真实实现） ============
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

// ============ SelectionToolbar ============
describe("SelectionToolbar", () => {
  it("visible 时渲染在指定位置；默认在选区上方，y 靠上时翻转", () => {
    const wrapper = mount(SelectionToolbar, {
      props: { x: 120, y: 300, visible: true, text: "hello" },
    });
    const el = wrapper.find(".sel-toolbar");
    expect(el.exists()).toBe(true);
    expect(el.attributes("style")).toContain("left: 120px");
    expect(el.classes()).not.toContain("flip");

    const wrapper2 = mount(SelectionToolbar, {
      props: { x: 120, y: 30, visible: true, text: "hello" },
    });
    expect(wrapper2.find(".sel-toolbar").classes()).toContain("flip");
    wrapper.unmount();
    wrapper2.unmount();
  });

  it("不可见时整体不渲染", () => {
    const wrapper = mount(SelectionToolbar, {
      props: { x: 0, y: 0, visible: false, text: "hello" },
    });
    expect(wrapper.find(".sel-toolbar").exists()).toBe(false);
    wrapper.unmount();
  });

  it("查词 / 笔记按钮 emit 选中文字；高亮展开四色并 emit 颜色", async () => {
    const wrapper = mount(SelectionToolbar, {
      props: { x: 0, y: 0, visible: true, text: "hello world" },
    });
    const btns = wrapper.findAll(".sel-toolbar-btn");
    await btns[0].trigger("click"); // 查词
    expect(wrapper.emitted("lookup")![0]).toEqual(["hello world"]);

    await btns[2].trigger("click"); // 笔记
    expect(wrapper.emitted("note")![0]).toEqual(["hello world"]);

    await btns[1].trigger("click"); // 高亮 → 色板
    const dots = wrapper.findAll(".sel-toolbar-dot");
    expect(dots).toHaveLength(4);
    await dots[0].trigger("click"); // yellow
    expect(wrapper.emitted("highlight")![0]).toEqual(["hello world", "yellow"]);
    wrapper.unmount();
  });
});

// ============ DictLookupModal ============
const LOOKUP_PROPS = {
  word: "hello",
  context: "Hello world.",
  bookId: "b1",
  bookTitle: "三体",
  cfi: "epubcfi(/6/8!/4/2/2/1:0)",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearToasts();
  apiMock.fetchDictSettings.mockResolvedValue({ dictionaries: [], activeDictId: "" });
  apiMock.queryDict.mockResolvedValue({
    word: "hello",
    found: false,
    html: "",
    source: "",
    audio: [],
    frequency: null,
  });
  apiMock.addVocab.mockResolvedValue({ id: "vw_1" });
  apiMock.fetchAnnotations.mockResolvedValue({ highlights: [], bookmarks: [], notes: [] });
  apiMock.fetchVocab.mockResolvedValue([]);
  apiMock.fetchDictSettings.mockResolvedValue({
    dictionaries: DICTS.map((d) => ({ ...d })),
    activeDictId: "d1",
  });
  apiMock.scanDictPath.mockResolvedValue([
    { path: "/Users/x/Dictionary/oald.mdx", name: "oald", size: 1024, mddExists: true },
  ]);
  apiMock.addDict.mockResolvedValue({ ...DICTS[0], id: "d3", name: "oald" });
  apiMock.uploadDictFile.mockResolvedValue({ ok: true });
  apiMock.activateDict.mockResolvedValue(undefined);
  apiMock.setDictEnabled.mockResolvedValue(undefined);
  apiMock.deleteDict.mockResolvedValue(undefined);
});

describe("DictLookupModal", () => {
  it("无词典 → 空态提示 + 跳转入口（openDictManager）", async () => {
    apiMock.fetchDictSettings.mockResolvedValue({ dictionaries: [], activeDictId: "" });
    const wrapper = mount(DictLookupModal, { props: LOOKUP_PROPS });
    await flushPromises();
    expect(wrapper.text()).toContain("还没有配置词典");
    await wrapper.find(".dict-modal-btn.primary").trigger("click");
    expect(wrapper.emitted("openDictManager")).toBeTruthy();
    wrapper.unmount();
  });

  it("有词典 → 查询渲染 srcdoc iframe（HTML 重写）+ 词频星级", async () => {
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
      found: true,
      html: '<p><img src="a.gif"/>hello</p>',
      source: "LDOCE",
      audio: [],
      frequency: { rank: 800, total: 60000 },
    });
    const wrapper = mount(DictLookupModal, { props: LOOKUP_PROPS });
    await flushPromises();

    expect(apiMock.queryDict).toHaveBeenCalledWith("hello", "d1");
    const iframe = wrapper.find(".dict-modal-frame");
    expect(iframe.exists()).toBe(true);
    // srcdoc：资源重写（真实 rewriteDictHtml）+ 词频星级（rank 800 → ★★★★★）
    const srcdoc = iframe.attributes("srcdoc") ?? "";
    expect(srcdoc).toContain("/api/dict/resource/d1/a.gif");
    expect(srcdoc).toContain("hello");
    expect(wrapper.find(".dict-modal-freq").text()).toBe("★★★★★");
    wrapper.unmount();
  });

  it("词典切换：select 变更 → 重新 query（新 dictId）", async () => {
    apiMock.fetchDictSettings.mockResolvedValue({
      dictionaries: [
        {
          id: "d1",
          name: "LDOCE",
          path: "/1.mdx",
          kind: "local",
          role: "define",
          enabled: true,
          addedAt: 1,
        },
        {
          id: "d2",
          name: "OALD",
          path: "/2.mdx",
          kind: "local",
          role: "define",
          enabled: true,
          addedAt: 1,
        },
      ],
      activeDictId: "d1",
    });
    const wrapper = mount(DictLookupModal, { props: LOOKUP_PROPS });
    await flushPromises();
    expect(apiMock.queryDict).toHaveBeenCalledTimes(1);

    await wrapper.find(".dict-modal-select").setValue("d2");
    await flushPromises();
    expect(apiMock.queryDict).toHaveBeenLastCalledWith("hello", "d2");
    wrapper.unmount();
  });

  it("加入生词本：POST 形状正确 → 按钮变已加入", async () => {
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
    const wrapper = mount(DictLookupModal, { props: LOOKUP_PROPS });
    await flushPromises();
    const btn = wrapper.find(".dict-modal-btn.vocab");
    await btn.trigger("click");
    await flushPromises();
    expect(apiMock.addVocab).toHaveBeenCalledWith({
      word: "hello",
      context: "Hello world.",
      bookId: "b1",
      bookTitle: "三体",
      cfi: "epubcfi(/6/8!/4/2/2/1:0)",
    });
    expect(btn.text()).toContain("已加入");
    wrapper.unmount();
  });

  it("未命中：空态显示未找到释义，底部仍可加入生词本", async () => {
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
      word: "xyz",
      found: false,
      html: "",
      source: "",
      audio: [],
      frequency: null,
    });
    const wrapper = mount(DictLookupModal, { props: LOOKUP_PROPS });
    await flushPromises();
    expect(wrapper.text()).toContain("未找到释义");
    expect(wrapper.find(".dict-modal-btn.vocab").exists()).toBe(true);
    wrapper.unmount();
  });
});

// ============ AnnotationPanel ============
const panelProps = {
  annotations: {
    highlights: [
      { id: "hl_1", cfi: "cfiH1", text: "hello world", color: "yellow" as const, createdAt: 1 },
    ],
    bookmarks: [{ id: "bm_1", cfi: "cfiB1", text: "第 3 页", createdAt: 1 }],
    notes: [
      {
        id: "nt_1",
        cfi: "cfiN1",
        excerpt: "excerpt text",
        text: "note body",
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  },
  vocab: [
    {
      id: "vw_1",
      word: "hello",
      context: "Hello world.",
      bookId: "b1",
      bookTitle: "三体",
      cfi: "",
      addedAt: 1,
    },
  ],
};

describe("AnnotationPanel", () => {
  it("标注 tab：高亮/书签/笔记分节渲染 + 删除/跳转/编辑 emit", async () => {
    const wrapper = mount(AnnotationPanel, { props: panelProps });
    expect(wrapper.text()).toContain("hello world");
    expect(wrapper.text()).toContain("第 3 页");
    expect(wrapper.text()).toContain("note body");

    const actions = wrapper.findAll(".anno-panel-action");
    // 高亮行：跳转 + 删除；书签行：跳转 + 删除；笔记行：跳转 + 编辑 + 删除
    await actions[1].trigger("click"); // 删除高亮
    expect(wrapper.emitted("delete-highlight")![0]).toEqual(["hl_1"]);
    await actions[2].trigger("click"); // 跳转书签
    expect(wrapper.emitted("jump")![0]).toEqual(["cfiB1"]);
    await actions[5].trigger("click"); // 编辑笔记（第一行跳转、第二行编辑）
    const edited = wrapper.emitted("edit-note")![0][0] as { id: string };
    expect(edited.id).toBe("nt_1");
    wrapper.unmount();
  });

  it("生词本 tab：列表 + 删除 emit + 导出触发 a[download] 点击", async () => {
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const wrapper = mount(AnnotationPanel, { props: panelProps });
    await wrapper.findAll(".anno-panel-tab")[1].trigger("click");
    expect(wrapper.text()).toContain("hello");
    expect(wrapper.text()).toContain("三体");

    await wrapper.find(".anno-panel-export").trigger("click");
    expect(clickSpy).toHaveBeenCalledTimes(1);
    clickSpy.mockRestore();

    const delBtn = wrapper.find(".anno-panel-item.vocab .anno-panel-action");
    await delBtn.trigger("click");
    expect(wrapper.emitted("delete-vocab")![0]).toEqual(["vw_1"]);
    wrapper.unmount();
  });

  it("空态：无标注 / 无生词", async () => {
    const empty = { annotations: { highlights: [], bookmarks: [], notes: [] }, vocab: [] };
    const wrapper = mount(AnnotationPanel, { props: empty });
    expect(wrapper.text()).toContain("暂无标注");
    await wrapper.findAll(".anno-panel-tab")[1].trigger("click");
    expect(wrapper.text()).toContain("还没有生词");
    wrapper.unmount();
  });

  it("关闭按钮 emit close", async () => {
    const wrapper = mount(AnnotationPanel, { props: panelProps });
    await wrapper.find(".anno-panel-close").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });
});

// ============ DictManagerModal ============
const DICTS = [
  {
    id: "d1",
    name: "LDOCE6++ En-Cn",
    path: "/Users/x/Dictionary/ldoce.mdx",
    kind: "local" as const,
    role: "define" as const,
    enabled: true,
    addedAt: 1,
  },
  {
    id: "d2",
    name: "COCA Frequency",
    path: "/Users/x/Dictionary/coca.mdx",
    kind: "local" as const,
    role: "frequency" as const,
    enabled: false,
    addedAt: 2,
  },
];

describe("DictManagerModal", () => {
  it("列表渲染：name + 路径 + role 徽标 + 默认标记", async () => {
    const wrapper = mount(DictManagerModal);
    await flushPromises();
    expect(wrapper.text()).toContain("LDOCE6++ En-Cn");
    expect(wrapper.text()).toContain("COCA Frequency");
    expect(wrapper.findAll(".dictmgr-role").map((r) => r.text())).toEqual(["释义", "词频"]);
    expect(wrapper.text()).toContain("默认"); // d1 active
    wrapper.unmount();
  });

  it("扫描：输入路径 → 候选列表 → 点选添加", async () => {
    const wrapper = mount(DictManagerModal);
    await flushPromises();
    await wrapper.find(".dictmgr-input").setValue("/Users/x/Dictionary");
    await wrapper.find(".dictmgr-path-row .dictmgr-btn.primary").trigger("click");
    await flushPromises();
    expect(apiMock.scanDictPath).toHaveBeenCalledWith("/Users/x/Dictionary");
    expect(wrapper.text()).toContain("oald");

    await wrapper.find(".dictmgr-candidate .dictmgr-btn").trigger("click");
    await flushPromises();
    expect(apiMock.addDict).toHaveBeenCalledWith("/Users/x/Dictionary/oald.mdx");
    wrapper.unmount();
  });

  it("启停切换 + 设为默认 + 删除", async () => {
    const wrapper = mount(DictManagerModal);
    await flushPromises();
    // 启停：d2 当前 disabled → 点开关启用
    const switches = wrapper.findAll(".dictmgr-switch");
    await switches[1].trigger("click");
    expect(apiMock.setDictEnabled).toHaveBeenCalledWith("d2", true);

    // 设为默认：d2 的按钮（d1 是默认已 disabled）
    const setDefaultBtns = wrapper
      .findAll(".dictmgr-item-actions .dictmgr-btn")
      .filter((b) => b.text() === "设为默认");
    await setDefaultBtns[0].trigger("click");
    expect(apiMock.activateDict).toHaveBeenCalledWith("d2");

    // 删除 d1
    const delBtns = wrapper.findAll(".dictmgr-item-actions .dictmgr-btn.danger");
    await delBtns[0].trigger("click");
    await flushPromises();
    expect(apiMock.deleteDict).toHaveBeenCalledWith("d1");
    wrapper.unmount();
  });

  it("上传：选文件 → uploadDictFile 带进度回调 → 刷新列表", async () => {
    const wrapper = mount(DictManagerModal);
    await flushPromises();
    const input = wrapper.find('.dictmgr-upload input[type="file"]');
    const file = new File(["x"], "test.mdx", { type: "application/octet-stream" });
    Object.defineProperty(input.element, "files", { value: [file], configurable: true });
    await input.trigger("change");
    await flushPromises();
    expect(apiMock.uploadDictFile).toHaveBeenCalledWith(file, expect.any(Function));
    wrapper.unmount();
  });

  it("直接添加 .mdx 路径：路径不合法时提示且不请求", async () => {
    const wrapper = mount(DictManagerModal);
    await flushPromises();
    // 输入 .epub 路径 → 添加按钮 disabled
    await wrapper.find(".dictmgr-input").setValue("/x/y.epub");
    const addBtn = wrapper.findAll(".dictmgr-path-row .dictmgr-btn")[1];
    expect(addBtn.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });

  it("关闭 emit close", async () => {
    const wrapper = mount(DictManagerModal);
    await flushPromises();
    await wrapper.find(".dictmgr-close").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();
    wrapper.unmount();
  });
});
