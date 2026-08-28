// ToastContainer 渲染测试：success / error / action 形态 + action 点击移除
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ToastContainer from "../components/ToastContainer.vue";
import { showToast, toastError, clearToasts } from "../composables/useToast.js";

// Teleport to body 在测试里 stub 掉，内容直接渲染在 wrapper 内可查询
function mountContainer() {
  return mount(ToastContainer, {
    global: { stubs: { teleport: true } },
  });
}

beforeEach(() => {
  clearToasts();
});

afterEach(() => {
  clearToasts();
});

describe("ToastContainer", () => {
  it("初始无 toast 不渲染", () => {
    const wrapper = mountContainer();
    expect(wrapper.find(".toast-item").exists()).toBe(false);
  });

  it("渲染 success toast 文本", async () => {
    const wrapper = mountContainer();
    showToast("保存成功");
    await flushPromises();
    const items = wrapper.findAll(".toast-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("保存成功");
    expect(items[0].classes()).toContain("toast-success");
    expect(items[0].find(".toast-action").exists()).toBe(false);
  });

  it("渲染 error toast（红色系 class）", async () => {
    const wrapper = mountContainer();
    toastError("加载失败");
    await flushPromises();
    const items = wrapper.findAll(".toast-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("加载失败");
    expect(items[0].classes()).toContain("toast-error");
  });

  it("多条堆叠渲染，顺序与添加一致", async () => {
    const wrapper = mountContainer();
    showToast("第一条");
    toastError("第二条");
    await flushPromises();
    const items = wrapper.findAll(".toast-item");
    expect(items).toHaveLength(2);
    expect(items[0].text()).toContain("第一条");
    expect(items[1].text()).toContain("第二条");
  });

  it("带 action 的 toast 渲染按钮，点击执行 onClick 并移除该条", async () => {
    const wrapper = mountContainer();
    const onClick = vi.fn();
    showToast("已删除歌单「旅行」", { action: { label: "撤销", onClick } });
    await flushPromises();
    const btn = wrapper.find(".toast-action");
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe("撤销");
    await btn.trigger("click");
    await flushPromises();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(wrapper.find(".toast-item").exists()).toBe(false);
  });

  it("多条时 action 只移除自己那一条", async () => {
    const wrapper = mountContainer();
    const onClick = vi.fn();
    showToast("普通提示");
    showToast("带撤销", { action: { label: "撤销", onClick } });
    await flushPromises();
    const actions = wrapper.findAll(".toast-action");
    expect(actions).toHaveLength(1);
    await actions[0].trigger("click");
    await flushPromises();
    const items = wrapper.findAll(".toast-item");
    expect(items).toHaveLength(1);
    expect(items[0].text()).toContain("普通提示");
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
