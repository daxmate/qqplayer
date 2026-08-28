// InlineControl 四 type 渲染 + 交互（entry 用 fake 对象，不依赖真实 settingsIndex）
// setup.js 已自动挂 i18n 插件，t(option.labelKey) / t(placeholder) 直接可用。
import { describe, expect, it, vi } from "vitest";
import { mount } from "@vue/test-utils";
import { nextTick, ref } from "vue";
import InlineControl from "../components/InlineControl.vue";

// 测试用 entry 结构（对齐 InlineControl.vue 的 props.entry 运行时形状）
interface TestEntry {
  type: string;
  labelKey: string;
  keywords: string[];
  get: () => unknown;
  set: (v: unknown) => void;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; labelKey: string }>;
  placeholder?: string;
}

function makeEntry(overrides: Partial<TestEntry> = {}): TestEntry & Record<string, unknown> {
  return {
    type: "toggle",
    labelKey: "settings.resumeLast",
    keywords: ["x"],
    get: () => false,
    set: vi.fn(),
    ...overrides,
  };
}

describe("InlineControl", () => {
  it("toggle：渲染开关，视觉反映 get()，点击调 set(!当前值)", async () => {
    const on = ref(false);
    const entry = makeEntry({
      type: "toggle",
      get: () => on.value,
      set: vi.fn((v) => {
        on.value = v;
      }),
    });
    const w = mount(InlineControl, { props: { entry } });
    const btn = w.find(".ic-switch");
    expect(btn.exists()).toBe(true);
    expect(btn.attributes("role")).toBe("switch");
    expect(btn.classes()).not.toContain("on");

    await btn.trigger("click");
    expect(entry.set).toHaveBeenCalledWith(true);
    await nextTick();
    expect(w.find(".ic-switch").classes()).toContain("on");

    await w.find(".ic-switch").trigger("click");
    expect(entry.set).toHaveBeenCalledWith(false);
    await nextTick();
    expect(w.find(".ic-switch").classes()).not.toContain("on");
  });

  it("slider：渲染 range（min/max/step）+ 数值徽标，input 调 set(Number)", async () => {
    const v = ref(3);
    const entry = makeEntry({
      type: "slider",
      min: 0,
      max: 10,
      step: 1,
      get: () => v.value,
      set: vi.fn((x) => {
        v.value = x;
      }),
    });
    const w = mount(InlineControl, { props: { entry } });
    const range = w.find(".ic-range");
    expect(range.exists()).toBe(true);
    expect(range.attributes("min")).toBe("0");
    expect(range.attributes("max")).toBe("10");
    expect(range.attributes("step")).toBe("1");
    expect(w.find(".ic-value").text()).toBe("3");

    (range.element as HTMLInputElement).value = "5";
    await range.trigger("input");
    expect(entry.set).toHaveBeenCalledWith(5);
    await nextTick();
    expect(w.find(".ic-value").text()).toBe("5");
  });

  it("slider 小数（step 0.5）数值徽标保留 1 位", () => {
    const entry = makeEntry({
      type: "slider",
      min: -2,
      max: 2,
      step: 0.1,
      get: () => 1.5,
      set: vi.fn(),
    });
    const w = mount(InlineControl, { props: { entry } });
    expect(w.find(".ic-value").text()).toBe("1.5");
  });

  it("select：渲染选项 chips（labelKey 翻译），当前项高亮，点击调 set(value)", async () => {
    const v = ref("a");
    const entry = makeEntry({
      type: "select",
      options: [
        { value: "a", labelKey: "settings.playModeOrder" },
        { value: "b", labelKey: "settings.playModeShuffle" },
      ],
      get: () => v.value,
      set: vi.fn((x) => {
        v.value = x;
      }),
    });
    const w = mount(InlineControl, { props: { entry } });
    const chips = w.findAll(".ic-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0].text()).toBe("列表循环");
    expect(chips[1].text()).toBe("随机");
    expect(chips[0].classes()).toContain("on");
    expect(chips[1].classes()).not.toContain("on");

    await chips[1].trigger("click");
    expect(entry.set).toHaveBeenCalledWith("b");
    await nextTick();
    const after = w.findAll(".ic-chip");
    expect(after[0].classes()).not.toContain("on");
    expect(after[1].classes()).toContain("on");
  });

  it("text：渲染输入框（placeholder 翻译），Enter 提交调 set，blur 也提交", async () => {
    const v = ref("");
    const entry = makeEntry({
      type: "text",
      placeholder: "settings.downloadDirPlaceholder",
      get: () => v.value,
      set: vi.fn((x) => {
        v.value = x;
      }),
    });
    const w = mount(InlineControl, { props: { entry } });
    const input = w.find("input.ic-input");
    expect(input.exists()).toBe(true);
    expect(input.attributes("placeholder")).toBe("留空 = 当前曲库");

    await input.setValue("/tmp/dl");
    await input.trigger("keydown.enter");
    expect(entry.set).toHaveBeenCalledWith("/tmp/dl");

    await input.setValue("/tmp/dl2");
    await input.trigger("blur");
    expect(entry.set).toHaveBeenLastCalledWith("/tmp/dl2");
  });
});
