// useToast 单例测试：添加 / 自动消失（fake timers）/ 多条并存 / action 点击执行并移除 / clearToasts
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  showToast,
  toastError,
  clearToasts,
  dismissToast,
  handleToastAction,
  useToast,
} from "../composables/useToast.js";

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
});

describe("useToast", () => {
  it("showToast 添加一条 success toast（默认 3200ms）", () => {
    showToast("保存成功");
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("success");
    expect(items[0].text).toBe("保存成功");
    expect(items[0].action).toBeNull();
    expect(items[0].duration).toBe(3200);
  });

  it("toastError 是 error 类型快捷方式", () => {
    toastError("出错了");
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("error");
    expect(items[0].text).toBe("出错了");
  });

  it("多条并存，id 自增且唯一", () => {
    showToast("a");
    showToast("b");
    toastError("c");
    const { items } = useToast();
    expect(items).toHaveLength(3);
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(3); // 互不相同
    expect(ids[0]).toBeLessThan(ids[1]);
    expect(ids[1]).toBeLessThan(ids[2]);
    expect(items.map((i) => i.text)).toEqual(["a", "b", "c"]);
  });

  it("自定义 duration 生效", () => {
    showToast("x", { duration: 1000 });
    const { items } = useToast();
    expect(items[0].duration).toBe(1000);
  });

  it("到 duration 自动消失", () => {
    showToast("短暂", { duration: 2000 });
    expect(useToast().items).toHaveLength(1);
    vi.advanceTimersByTime(1999);
    expect(useToast().items).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(useToast().items).toHaveLength(0);
  });

  it("不同 duration 各自独立消失", () => {
    showToast("短", { duration: 1000 });
    showToast("长", { duration: 5000 });
    vi.advanceTimersByTime(1000);
    const { items } = useToast();
    expect(items).toHaveLength(1);
    expect(items[0].text).toBe("长");
    vi.advanceTimersByTime(4000);
    expect(useToast().items).toHaveLength(0);
  });

  it("action 点击：执行 onClick 并立即移除该条", () => {
    const onClick = vi.fn();
    showToast("删除成功", {
      action: { label: "撤销", onClick },
    });
    const { items, handleToastAction } = useToast();
    expect(items).toHaveLength(1);
    handleToastAction(items[0].id);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(useToast().items).toHaveLength(0);
  });

  it("带 action 不点击：到 duration 自动消失且不执行 onClick", () => {
    const onClick = vi.fn();
    showToast("删除成功", { duration: 5000, action: { label: "撤销", onClick } });
    vi.advanceTimersByTime(5000);
    expect(useToast().items).toHaveLength(0);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("dismissToast 手动移除指定 id", () => {
    showToast("a");
    const id = showToast("b");
    showToast("c");
    dismissToast(id);
    const { items } = useToast();
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.text)).toEqual(["a", "c"]);
  });

  it("clearToasts 清空全部并取消定时器", () => {
    showToast("a", { duration: 100000 });
    showToast("b", { duration: 100000 });
    clearToasts();
    expect(useToast().items).toHaveLength(0);
    // 清空后推进时间不再冒出
    vi.advanceTimersByTime(200000);
    expect(useToast().items).toHaveLength(0);
  });

  it("handleToastAction 对不存在的 id 无副作用", () => {
    expect(() => handleToastAction(999)).not.toThrow();
    expect(useToast().items).toHaveLength(0);
  });
});
