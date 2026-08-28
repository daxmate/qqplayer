// useMobileViewport 测试：移动端断点（<1024px）判定与响应式切换
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { installMatchMedia, type MatchMediaHelper } from "./helpers/matchMedia.js";

describe("useMobileViewport 断点判定", () => {
  let mq: MatchMediaHelper;

  beforeEach(() => {
    mq = installMatchMedia(false); // 桌面初始
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("模块加载时按 matchMedia 结果初始化 isMobile（false = 桌面）", async () => {
    vi.resetModules();
    const { isMobile } = await import("../composables/useMobileViewport.js");
    expect(isMobile.value).toBe(false);
  });

  it("模块加载时按 matchMedia 结果初始化 isMobile（true = 移动）", async () => {
    mq.set(true);
    vi.resetModules();
    const { isMobile } = await import("../composables/useMobileViewport.js");
    expect(isMobile.value).toBe(true);
  });

  it("使用正确的断点媒体查询 (max-width: 1023.98px)", async () => {
    vi.resetModules();
    await import("../composables/useMobileViewport.js");
    expect(mq.calls).toContain("(max-width: 1023.98px)");
  });

  it("change 事件驱动 isMobile 响应式切换（true → false）", async () => {
    mq.set(true);
    vi.resetModules();
    const { isMobile } = await import("../composables/useMobileViewport.js");
    expect(isMobile.value).toBe(true);
    mq.set(false);
    expect(isMobile.value).toBe(false);
  });

  it("change 事件驱动 isMobile 响应式切换（false → true）", async () => {
    vi.resetModules();
    const { isMobile } = await import("../composables/useMobileViewport.js");
    expect(isMobile.value).toBe(false);
    mq.set(true);
    expect(isMobile.value).toBe(true);
  });

  it("兼容 addListener 老式监听（removeEventListener 不存在时）", async () => {
    // 移除 addEventListener → 走 addListener 分支
    mq.mq.addEventListener = undefined as unknown as MatchMediaHelper["mq"]["addEventListener"];
    mq.mq.removeEventListener =
      undefined as unknown as MatchMediaHelper["mq"]["removeEventListener"];
    vi.resetModules();
    const { isMobile } = await import("../composables/useMobileViewport.js");
    mq.set(true);
    expect(isMobile.value).toBe(true);
  });
});

describe("useMobileViewport 降级", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("window 无 matchMedia 时 isMobile 保持默认 false（测试/旧环境）", async () => {
    vi.stubGlobal("matchMedia", undefined);
    vi.resetModules();
    const { isMobile } = await import("../composables/useMobileViewport.js");
    expect(isMobile.value).toBe(false);
  });
});
