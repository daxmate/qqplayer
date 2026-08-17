// VideoOnline 在线解析结果面板测试：空态/解析中/错误/结果卡片（标题/时长/字幕标签/点击播放）
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import VideoOnline from "../videos/VideoOnline.vue";

const RESULT = {
  title: "示例视频",
  url: "https://www.bilibili.com/video/BV1xx411c7mD",
  provider: "bilibili",
  duration: 245.5,
  subtitles: [
    { lang: "zh-Hans", name: "中文（自动生成）" },
    { lang: "en", name: "English" },
  ],
};

describe("VideoOnline 状态渲染", () => {
  it("空态：未解析时显示引导文案", () => {
    const wrapper = mount(VideoOnline, {
      props: { resolving: false, result: null, error: "" },
    });
    expect(wrapper.find(".vo-state").exists()).toBe(true);
    expect(wrapper.text()).toContain("解析");
    expect(wrapper.find(".vo-card").exists()).toBe(false);
    wrapper.unmount();
  });

  it("解析中：显示 loading 文案", () => {
    const wrapper = mount(VideoOnline, {
      props: { resolving: true, result: null, error: "" },
    });
    expect(wrapper.find(".vo-state").exists()).toBe(true);
    expect(wrapper.text()).toContain("解析中");
    wrapper.unmount();
  });

  it("解析失败：显示错误标题 + 后端 detail", () => {
    const wrapper = mount(VideoOnline, {
      props: { resolving: false, result: null, error: "解析失败: 视频不存在" },
    });
    expect(wrapper.find(".vo-error").exists()).toBe(true);
    expect(wrapper.text()).toContain("解析失败");
    expect(wrapper.find(".vo-error-detail").text()).toBe("解析失败: 视频不存在");
    wrapper.unmount();
  });
});

describe("VideoOnline 结果卡片", () => {
  it("渲染标题 / provider / 时长格式化 / 字幕语言标签", () => {
    const wrapper = mount(VideoOnline, {
      props: { resolving: false, result: RESULT, error: "" },
    });
    expect(wrapper.find(".vo-title").text()).toBe("示例视频");
    const sub = wrapper.find(".vo-sub").text();
    expect(sub).toContain("bilibili");
    // 245.5s → 4:05（M:SS 格式）
    expect(sub).toContain("4:05");
    // 字幕语言标签（每项「字幕 · 名称」）
    const tags = wrapper.findAll(".vo-tag");
    expect(tags).toHaveLength(2);
    expect(tags[0].text()).toContain("中文（自动生成）");
    expect(tags[1].text()).toContain("English");
    wrapper.unmount();
  });

  it("长时长（≥1h）→ H:MM:SS 格式", () => {
    const wrapper = mount(VideoOnline, {
      props: {
        resolving: false,
        result: { ...RESULT, duration: 3725 },
        error: "",
      },
    });
    expect(wrapper.find(".vo-sub").text()).toContain("1:02:05");
    wrapper.unmount();
  });

  it("无标题显示占位；无字幕不渲染标签", () => {
    const wrapper = mount(VideoOnline, {
      props: {
        resolving: false,
        result: { ...RESULT, title: "", subtitles: [] },
        error: "",
      },
    });
    expect(wrapper.find(".vo-title").text()).toBe("未命名视频");
    expect(wrapper.find(".vo-tags").exists()).toBe(false);
    wrapper.unmount();
  });

  it("点击卡片 emit play（带完整结果对象）", async () => {
    const wrapper = mount(VideoOnline, {
      props: { resolving: false, result: RESULT, error: "" },
    });
    await wrapper.find(".vo-card").trigger("click");
    expect(wrapper.emitted("play")?.[0]?.[0]).toEqual(RESULT);
    wrapper.unmount();
  });
});
