import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount } from "@vue/test-utils";
import DictLookupModal from "../books/DictLookupModal.vue";

vi.mock("../books/annotations", () => ({
  fetchDictSettings: vi.fn().mockResolvedValue({
    dictionaries: [{ id: "d1", name: "LDOCE", enabled: true, role: "define" }],
    activeDictId: "d1",
  }),
  queryDict: vi.fn().mockResolvedValue({
    found: true,
    html: '<span style="color:#333;background:#f5f5f5">word</span><a href="/api/dict/resource/x.mp3">🔊</a>',
    source: "LDOCE",
  }),
  addVocab: vi.fn().mockResolvedValue(true),
  rewriteDictHtml: (html: string) => html,
}));

function mountModal(themeColors?: { text: string; bg: string; dark: boolean }) {
  return mount(DictLookupModal, {
    props: {
      word: "test",
      context: "a test",
      bookId: "b1",
      bookTitle: "Book",
      cfi: "cfi",
      ...(themeColors ? { themeColors } : {}),
    },
  });
}

describe("DictLookupModal 主题 CSS 注入", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("浅色（默认）：基础样式，不注入覆盖层", async () => {
    const w = mountModal();
    await new Promise((r) => setTimeout(r, 100));
    const srcdoc = w.find("iframe").attributes("srcdoc") || "";
    expect(srcdoc).toContain("color:#1f2328");
    expect(srcdoc).not.toContain("!important");
    expect(srcdoc).toContain("word");
  });

  it("深色主题：注入主题色 + !important 覆盖词典内联样式", async () => {
    const w = mountModal({ text: "#c8ccd4", bg: "#1f2430", dark: true });
    await new Promise((r) => setTimeout(r, 100));
    const srcdoc = w.find("iframe").attributes("srcdoc") || "";
    expect(srcdoc).toContain("color:#c8ccd4");
    expect(srcdoc).toContain("background:#1f2430");
    expect(srcdoc).toContain("body, body *{color:#c8ccd4 !important}");
    expect(srcdoc).toContain('[style*="background"]{background-color:transparent !important}');
    expect(srcdoc).toContain("color:#7ab8ff !important");
  });

  it("米黄主题：覆盖层 + 深蓝链接", async () => {
    const w = mountModal({ text: "#5b4636", bg: "#f5ecd9", dark: true });
    await new Promise((r) => setTimeout(r, 100));
    const srcdoc = w.find("iframe").attributes("srcdoc") || "";
    expect(srcdoc).toContain("color:#5b4636");
    expect(srcdoc).toContain("color:#1a5aa8 !important");
  });
});
