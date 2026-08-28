// MobileAudiobooks 占位页测试：图标 + 标题 + 敬请期待文案（i18n）
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";

const MobileAudiobooks = (await import("../components/mobile/MobileAudiobooks.vue")).default;

describe("MobileAudiobooks 占位页", () => {
  it("渲染标题与敬请期待文案", () => {
    const wrapper = mount(MobileAudiobooks);
    expect(wrapper.find(".ma-page").exists()).toBe(true);
    expect(wrapper.find(".ma-icon").exists()).toBe(true); // 图标
    expect(wrapper.find(".ma-title").text()).toBe("有声书");
    expect(wrapper.text()).toContain("敬请期待");
  });
});
