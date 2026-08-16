// BooksView 容器测试：书架 ↔ 阅读器切换
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";

vi.mock("../books/api", () => ({
  fetchBooks: vi.fn(),
  importBook: vi.fn(),
  deleteBook: vi.fn(),
  saveBookProgress: vi.fn(),
  getLastReadBookId: vi.fn(),
  setLastReadBookId: vi.fn(),
}));

const mocks = vi.hoisted(() => ({
  rendition: {
    themes: { register: vi.fn(), select: vi.fn(), fontSize: vi.fn() },
    on: vi.fn(),
    display: vi.fn().mockResolvedValue(undefined),
    next: vi.fn(),
    prev: vi.fn(),
    destroy: vi.fn(),
    resize: vi.fn(),
  },
  ePub: vi.fn(),
}));

vi.mock("epubjs", () => ({ default: mocks.ePub }));

import { fetchBooks, getLastReadBookId, setLastReadBookId } from "../books/api";
import BooksView from "../books/BooksView.vue";

const book = {
  id: "b1",
  title: "三体",
  author: "刘慈欣",
  addedAt: 1000,
  progress: { cfi: "epubcfi(/6/8)", location: 0.3, updatedAt: 1 },
  fileUrl: "/api/books/b1/file",
  coverUrl: "/api/books/b1/cover",
};

beforeEach(() => {
  vi.clearAllMocks();
  // loadBook 先 fetch(fileUrl) → arrayBuffer → ePub(ArrayBuffer)
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)) }),
    ),
  );
  (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([book]);
  (getLastReadBookId as ReturnType<typeof vi.fn>).mockResolvedValue("");
  mocks.ePub.mockReturnValue({
    ready: Promise.resolve(),
    renderTo: vi.fn(() => mocks.rendition),
    destroy: vi.fn(),
    navigation: { toc: [] },
  });
});

describe("BooksView", () => {
  it("默认书架 → 点卡片进阅读器 → 返回回书架", async () => {
    const wrapper = mount(BooksView);
    await flushPromises();

    // 初始：书架
    expect(wrapper.findComponent({ name: "Bookshelf" }).exists()).toBe(true);
    expect(wrapper.find(".reader").exists()).toBe(false);

    // 点卡片 → 阅读器
    await wrapper.find(".bs-card").trigger("click");
    await flushPromises();
    expect(wrapper.find(".reader").exists()).toBe(true);
    expect(wrapper.find(".reader-title").text()).toBe("三体");
    expect(mocks.ePub.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer);

    // 返回 → 书架
    await wrapper.find(".reader-topbar .reader-btn").trigger("click");
    await flushPromises();
    expect(wrapper.find(".reader").exists()).toBe(false);
    expect(wrapper.find(".bs-card").exists()).toBe(true);

    wrapper.unmount();
  });

  it("换书：书架点另一本书 → Reader 重建（key 变化）", async () => {
    (fetchBooks as ReturnType<typeof vi.fn>).mockResolvedValue([
      book,
      { ...book, id: "b2", title: "球状闪电", fileUrl: "/api/books/b2/file" },
    ]);

    const wrapper = mount(BooksView);
    await flushPromises();

    const cards = wrapper.findAll(".bs-card");
    await cards[1].trigger("click");
    await flushPromises();
    expect(wrapper.find(".reader-title").text()).toBe("球状闪电");

    // 返回书架再开另一本
    await wrapper.find(".reader-topbar .reader-btn").trigger("click");
    await flushPromises();
    await wrapper.findAll(".bs-card")[0].trigger("click");
    await flushPromises();
    expect(wrapper.find(".reader-title").text()).toBe("三体");

    wrapper.unmount();
  });

  it("有 lastReadId → 自动打开上次的书（Reader 按 progress.cfi 恢复）", async () => {
    (getLastReadBookId as ReturnType<typeof vi.fn>).mockResolvedValue("b1");
    const wrapper = mount(BooksView);
    await flushPromises();

    expect(wrapper.find(".reader").exists()).toBe(true);
    expect(wrapper.find(".reader-title").text()).toBe("三体");

    wrapper.unmount();
  });

  it("lastReadId 对应书不存在（已删）→ 回落书架", async () => {
    (getLastReadBookId as ReturnType<typeof vi.fn>).mockResolvedValue("ghost-id");
    const wrapper = mount(BooksView);
    await flushPromises();

    expect(wrapper.find(".reader").exists()).toBe(false);
    expect(wrapper.find(".bs-card").exists()).toBe(true);

    wrapper.unmount();
  });

  it("打开书时记录 lastReadId（统一 Settings 层）", async () => {
    const wrapper = mount(BooksView);
    await flushPromises();

    await wrapper.find(".bs-card").trigger("click");
    await flushPromises();
    expect(setLastReadBookId).toHaveBeenCalledWith("b1");

    wrapper.unmount();
  });
});
