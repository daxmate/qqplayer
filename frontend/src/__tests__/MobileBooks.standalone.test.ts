// MobileBooks 分页屏 back 适配测试（standalone prop）
// 覆盖：standalone=false（分页屏）书架态隐藏返回按钮；阅读器打开时返回按钮出现、点击关闭阅读器
//       （不向壳层 emit back，浮层状态上报 overlay）；standalone=true（独立页）保持原行为 emit back
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import type { VueWrapper } from "@vue/test-utils";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
class FakeAudio {
  src = "";
  paused = true;
  play() {
    return Promise.resolve();
  }
  pause() {}
  addEventListener() {}
}
vi.stubGlobal("Audio", FakeAudio);

// 书架/阅读器用桩替代（真实 Reader 挂载重，这里只测 back/overlay 编排逻辑）
vi.mock("../books/Bookshelf.vue", () => ({
  default: {
    name: "BookshelfStub",
    emits: ["open"],
    template: `<button class="bs-stub" @click="$emit('open', { id: 'b1', title: '测试书' })">shelf</button>`,
  },
}));
vi.mock("../books/Reader.vue", () => ({
  default: {
    name: "ReaderStub",
    props: ["book"],
    emits: ["close"],
    template: `<div class="reader-stub"><button class="r-close" @click="$emit('close')">close</button></div>`,
  },
}));

const MobileBooks = (await import("../books/MobileBooks.vue")).default;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MobileBooks 分页屏模式（standalone=false）", () => {
  it("书架态：无返回按钮，不 emit back", async () => {
    const wrapper = mount(MobileBooks, { props: { standalone: false } });
    expect(wrapper.find(".mb-back").exists()).toBe(false);
    expect(wrapper.emitted("back")).toBeFalsy();
    expect(wrapper.emitted("overlay")).toBeFalsy();
  });

  it("打开阅读器 → 返回按钮出现 + overlay 上报；点返回关闭阅读器（不 emit back）", async () => {
    const wrapper: VueWrapper = mount(MobileBooks, { props: { standalone: false } });
    await wrapper.find(".bs-stub").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mb-reader-overlay").exists()).toBe(true);
    expect(wrapper.find(".mb-back").exists()).toBe(true);
    expect(wrapper.emitted("overlay")!.at(-1)).toEqual([true]);
    // 点返回：关闭阅读器，不向上 pop
    await wrapper.find(".mb-back").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mb-reader-overlay").exists()).toBe(false);
    expect(wrapper.find(".mb-back").exists()).toBe(false);
    expect(wrapper.emitted("back")).toBeFalsy();
    expect(wrapper.emitted("overlay")!.at(-1)).toEqual([false]);
  });
});

describe("MobileBooks 独立页模式（standalone=true，原行为）", () => {
  it("书架态显示返回按钮，点击 emit back", async () => {
    const wrapper = mount(MobileBooks);
    expect(wrapper.find(".mb-back").exists()).toBe(true);
    await wrapper.find(".mb-back").trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy();
  });

  it("阅读器打开时点返回：先关阅读器，再点才 emit back", async () => {
    const wrapper = mount(MobileBooks);
    await wrapper.find(".bs-stub").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mb-reader-overlay").exists()).toBe(true);
    await wrapper.find(".mb-back").trigger("click");
    await flushPromises();
    expect(wrapper.find(".mb-reader-overlay").exists()).toBe(false);
    expect(wrapper.emitted("back")).toBeFalsy(); // 第一次只关阅读器
    await wrapper.find(".mb-back").trigger("click");
    expect(wrapper.emitted("back")).toBeTruthy(); // 第二次 pop
  });
});
