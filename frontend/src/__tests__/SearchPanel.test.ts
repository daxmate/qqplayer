// 书内搜索面板测试：SearchPanel 组件（mock fetch）+ searchHighlight 纯函数（jsdom DOM）
// 参照 Reader.test.ts / ReaderAnnotations.test.ts 的 mock 模式；i18n 由 setup.js 全局挂载（默认 zh-CN）
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import SearchPanel from "../books/SearchPanel.vue";
import {
  highlightParts,
  findSentenceRange,
  applyTempMark,
  removeTempMark,
  ensureTempMarkStyle,
  SEARCH_TEMP_CLASS,
} from "../books/searchHighlight";
import { clearToasts } from "../composables/useToast.js";

// ============ fetch 路由 stub（/api/books/{bid}/search 可控；其余给空 JSON） ============
let searchBody: unknown = { query: "", results: [] };
let searchStatus = 200;
let searchDetail = "";

function searchFetch(url: string | URL | Request) {
  const u = String(url);
  if (u.startsWith("/api/books/") && u.includes("/search")) {
    if (searchStatus !== 200) {
      return Promise.resolve({
        ok: false,
        status: searchStatus,
        statusText: "error",
        json: () => Promise.resolve({ detail: searchDetail }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(searchBody) });
  }
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
}

beforeEach(() => {
  searchBody = { query: "", results: [] };
  searchStatus = 200;
  searchDetail = "";
  vi.stubGlobal("fetch", vi.fn(searchFetch));
});

afterEach(() => {
  clearToasts();
  vi.unstubAllGlobals();
});

const RESULT = {
  href: "chap01.xhtml",
  chapterTitle: "Chapter 1",
  sentence: "It was a galling defeat.",
  cfi: "epubcfi(/6/8[chap01]!/4/2/1:0)",
  matchStart: 9,
  matchEnd: 16,
};

const fetchMock = () => fetch as unknown as ReturnType<typeof vi.fn>;

// ============ SearchPanel 组件 ============
describe("SearchPanel", () => {
  it("initialQuery 非空：挂载即预填输入框并自动搜索一次", async () => {
    searchBody = { query: "galling", results: [{ ...RESULT }] };
    const wrapper = mount(SearchPanel, {
      props: { bookId: "b1", initialQuery: "galling" },
    });
    await flushPromises();

    expect((wrapper.find(".search-panel-input").element as HTMLInputElement).value).toBe("galling");
    const urls = fetchMock().mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/api/books/b1/search?q=galling");
    expect(wrapper.findAll(".search-panel-item")).toHaveLength(1);
    wrapper.unmount();
  });

  it("initialQuery 为 null：不自动搜索，等待用户输入", async () => {
    const wrapper = mount(SearchPanel, { props: { bookId: "b1", initialQuery: null } });
    await flushPromises();
    expect(fetchMock()).not.toHaveBeenCalled();
    expect(wrapper.find(".search-panel-input").element as HTMLInputElement).toBeTruthy();
    wrapper.unmount();
  });

  it("结果渲染：章节标题 + 句子全文，命中词 <mark> 高亮（sentence 含首尾空白时偏移正确）", async () => {
    // 前导 2 空格 + 尾随 2 空格：matchStart/End 基于原始串（11..18），trim 后应切出 "galling"
    searchBody = {
      query: "galling",
      results: [
        {
          ...RESULT,
          sentence: "  It was a galling defeat.  ",
          matchStart: 11,
          matchEnd: 18,
        },
        {
          ...RESULT,
          sentence: "The galling truth.",
          cfi: "epubcfi(/6/8[chap01]!/4/2/2:0)",
          chapterTitle: "Chapter 2",
          matchStart: 4,
          matchEnd: 11,
        },
      ],
    };
    const wrapper = mount(SearchPanel, {
      props: { bookId: "b1", initialQuery: "galling" },
    });
    await flushPromises();

    const items = wrapper.findAll(".search-panel-item");
    expect(items).toHaveLength(2);
    // 首条：trim 后 before="It was a " / word="galling" / after=" defeat."
    expect(items[0].find(".search-panel-chapter").text()).toBe("Chapter 1");
    expect(items[0].find(".search-panel-mark").text()).toBe("galling");
    expect(items[0].find(".search-panel-sentence").text()).toContain("It was a galling defeat.");
    // 结果计数
    expect(wrapper.find(".search-panel-count").text()).toContain("2");
    wrapper.unmount();
  });

  it("空态：无结果时显示「没有找到包含…」", async () => {
    searchBody = { query: "zzz", results: [] };
    const wrapper = mount(SearchPanel, {
      props: { bookId: "b1", initialQuery: "zzz" },
    });
    await flushPromises();
    expect(wrapper.find(".search-panel-status").text()).toContain("没有找到包含「zzz」的内容");
    wrapper.unmount();
  });

  it("加载态：搜索中显示转圈、按钮禁用、不可重复提交", async () => {
    let resolveSearch: (v: unknown) => void = () => {};
    const pending = new Promise((r) => {
      resolveSearch = r;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending),
    );
    const wrapper = mount(SearchPanel, {
      props: { bookId: "b1", initialQuery: "galling" },
    });
    await flushPromises(); // 挂载后 runSearch 开始（fetch 未决）

    expect(wrapper.find(".search-panel-status").text()).toContain("搜索中");
    expect((wrapper.find(".search-panel-btn").element as HTMLButtonElement).disabled).toBe(true);
    // 搜索中再点/回车 → 不重复提交
    await wrapper.find(".search-panel-btn").trigger("click");
    await wrapper.find(".search-panel-input").trigger("keydown.enter");
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    resolveSearch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ query: "galling", results: [{ ...RESULT }] }),
    });
    await flushPromises();
    expect(wrapper.findAll(".search-panel-item")).toHaveLength(1);
    wrapper.unmount();
  });

  it("错误态：后端 400 → 面板内提示「搜索失败：{detail}」", async () => {
    searchStatus = 400;
    searchDetail = "invalid query";
    const wrapper = mount(SearchPanel, {
      props: { bookId: "b1", initialQuery: "galling" },
    });
    await flushPromises();
    const status = wrapper.find(".search-panel-status.err");
    expect(status.exists()).toBe(true);
    expect(status.text()).toContain("搜索失败");
    expect(status.text()).toContain("invalid query");
    wrapper.unmount();
  });

  it("回车触发新搜索；结果随输入更新", async () => {
    const wrapper = mount(SearchPanel, { props: { bookId: "b1", initialQuery: null } });
    await flushPromises();
    const input = wrapper.find(".search-panel-input");
    await input.setValue("hello");
    searchBody = { query: "hello", results: [{ ...RESULT, sentence: "Hello world." }] };
    await input.trigger("keydown.enter");
    await flushPromises();
    const urls = fetchMock().mock.calls.map((c) => String(c[0]));
    expect(urls).toContain("/api/books/b1/search?q=hello");
    expect(wrapper.findAll(".search-panel-item")).toHaveLength(1);
    wrapper.unmount();
  });

  it("点击结果 → emit jump(cfi, matchStart, matchEnd, sentence)", async () => {
    searchBody = { query: "galling", results: [{ ...RESULT }] };
    const wrapper = mount(SearchPanel, {
      props: { bookId: "b1", initialQuery: "galling" },
    });
    await flushPromises();
    await wrapper.find(".search-panel-item").trigger("click");
    const jumps = wrapper.emitted("jump");
    expect(jumps).toBeTruthy();
    expect(jumps![0]).toEqual([
      "epubcfi(/6/8[chap01]!/4/2/1:0)",
      9,
      16,
      "It was a galling defeat.",
    ]);
    wrapper.unmount();
  });

  it("关闭按钮 → emit close；Escape（输入框内）→ emit close", async () => {
    const wrapper = mount(SearchPanel, { props: { bookId: "b1", initialQuery: null } });
    await flushPromises();
    await wrapper.find(".search-panel-close").trigger("click");
    expect(wrapper.emitted("close")).toBeTruthy();

    const wrapper2 = mount(SearchPanel, { props: { bookId: "b1", initialQuery: null } });
    await wrapper2.find(".search-panel-input").trigger("keydown.esc");
    expect(wrapper2.emitted("close")).toBeTruthy();
    wrapper.unmount();
    wrapper2.unmount();
  });
});

// ============ searchHighlight.ts 纯函数 ============
describe("highlightParts：命中词切片（strip 对齐偏移）", () => {
  it("前导空白：偏移随 trim 前移，命中词不变", () => {
    const p = highlightParts("  It was a galling defeat.", 11, 18);
    expect(p).toEqual({ before: "It was a ", word: "galling", after: " defeat." });
  });

  it("尾随空白 + 词在句尾：不越界", () => {
    const p = highlightParts("The galling truth.  ", 4, 11);
    expect(p).toEqual({ before: "The ", word: "galling", after: " truth." });
  });

  it("无空白：原样切片", () => {
    const p = highlightParts("A galling day", 2, 9);
    expect(p).toEqual({ before: "A ", word: "galling", after: " day" });
  });

  it("越界偏移 clamp 到句子范围", () => {
    const p = highlightParts("galling", -5, 100);
    expect(p).toEqual({ before: "", word: "galling", after: "" });
  });

  it("空命中（matchStart===matchEnd）→ word 为空串", () => {
    const p = highlightParts("galling", 3, 3);
    expect(p.word).toBe("");
  });
});

function makeDoc(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("findSentenceRange：文档内定位命中词", () => {
  it("整句精确匹配：Range 恰好圈住命中词", () => {
    const doc = makeDoc("<html><body><p>It was a galling defeat.</p></body></html>");
    const hit = findSentenceRange(doc, "It was a galling defeat.", 9, 16);
    expect(hit).not.toBeNull();
    expect(hit!.range.toString()).toBe("galling");
    expect(hit!.word).toBe("galling");
  });

  it("DOM 换行/多空格 vs index 单空格：空白归一化兜底命中", () => {
    const doc = makeDoc("<html><body><p>It was a\n  galling defeat.</p></body></html>");
    const hit = findSentenceRange(doc, "It was a galling defeat.", 9, 16);
    expect(hit).not.toBeNull();
    expect(hit!.range.toString()).toBe("galling");
  });

  it("大小写差异：单词级大小写不敏感兜底命中（保留原文大小写）", () => {
    const doc = makeDoc("<html><body><p>It was a GALLING defeat.</p></body></html>");
    const hit = findSentenceRange(doc, "It was a galling defeat.", 9, 16);
    expect(hit).not.toBeNull();
    expect(hit!.range.toString()).toBe("GALLING");
  });

  it("命中词跨多个文本节点（<b> 包裹）：Range 跨节点正确", () => {
    const doc = makeDoc("<html><body><p>It was a <b>galling</b> defeat.</p></body></html>");
    const hit = findSentenceRange(doc, "It was a galling defeat.", 9, 16);
    expect(hit).not.toBeNull();
    expect(hit!.range.toString()).toBe("galling");
    // 跨节点句子片段（覆盖 "a galling"）同样能切
    const hit2 = findSentenceRange(doc, "It was a galling defeat.", 7, 16);
    expect(hit2!.range.toString()).toBe("a galling");
  });

  it("找不到 → null（调用方 toast，不崩溃）", () => {
    const doc = makeDoc("<html><body><p>Something entirely different.</p></body></html>");
    const hit = findSentenceRange(doc, "It was a galling defeat.", 9, 16);
    expect(hit).toBeNull();
  });
});

describe("applyTempMark / removeTempMark：<mark> 包住 + 解包还原", () => {
  it("apply 后 mark 带 class、原文保留；remove 后 DOM 还原", () => {
    const doc = makeDoc("<html><body><p>It was a galling defeat.</p></body></html>");
    ensureTempMarkStyle(doc);
    expect(doc.getElementById("qqp-search-hl-style")).not.toBeNull();

    const hit = findSentenceRange(doc, "It was a galling defeat.", 9, 16)!;
    const mark = applyTempMark(hit.range);
    expect(mark.tagName).toBe("MARK");
    expect(mark.className).toBe(SEARCH_TEMP_CLASS);
    expect(mark.textContent).toBe("galling");
    expect(doc.body.textContent).toContain("It was a galling defeat.");

    removeTempMark(mark);
    expect(doc.querySelector(`mark.${SEARCH_TEMP_CLASS}`)).toBeNull();
    expect(doc.body.textContent).toContain("It was a galling defeat.");

    // 已还原/不在文档 → 幂等 no-op
    removeTempMark(mark);
    removeTempMark(null);
  });

  it("ensureTempMarkStyle 幂等：重复调用只注入一次", () => {
    const doc = makeDoc("<html><head></head><body><p>x</p></body></html>");
    ensureTempMarkStyle(doc);
    ensureTempMarkStyle(doc);
    expect(doc.querySelectorAll("style#qqp-search-hl-style")).toHaveLength(1);
  });
});
