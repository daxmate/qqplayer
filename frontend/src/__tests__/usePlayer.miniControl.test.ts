// usePlayer composable 单元测试 — setupMiniStatus 迷你窗状态
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  setupMiniStatus,
  stopMiniStatus,
  refreshMiniStatus,
  miniRunning,
} from "./helpers/usePlayerHarness.js";

describe("setupMiniStatus（迷你窗运行状态轮询）", () => {
  afterEach(() => {
    // 先清 timer 再恢复真实 timers（同上：避免 fake interval 泄漏到下一测试）
    stopMiniStatus();
    miniRunning.value = false;
    vi.useRealTimers();
  });

  function stubStatus(running: boolean) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/mini/status") {
          return { ok: true, json: async () => ({ running }) };
        }
        throw new Error("unexpected url " + url);
      }),
    );
  }

  it("迷你窗运行 → 开关点亮", async () => {
    stubStatus(true);
    vi.useFakeTimers();
    setupMiniStatus(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(miniRunning.value).toBe(true);
  });

  it("迷你窗退出 → 开关熄灭", async () => {
    miniRunning.value = true;
    stubStatus(false);
    vi.useFakeTimers();
    setupMiniStatus(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(miniRunning.value).toBe(false);
  });

  it("refreshMiniStatus 手动刷新", async () => {
    stubStatus(true);
    await refreshMiniStatus();
    expect(miniRunning.value).toBe(true);
  });

  it("重复调用幂等，不叠加 timer", async () => {
    stubStatus(true);
    vi.useFakeTimers();
    setupMiniStatus(100);
    setupMiniStatus(100);
    setupMiniStatus(100);
    await vi.advanceTimersByTimeAsync(200);
    // 首次立即查 1 次 + 200ms 内轮询 2~3 次（fake timer 边界 tick 因 Node 版本/环境而异）；
    // 若 3 个 timer 叠加次数会 ≥9——断言区间验证"不叠加"本质
    const fetchCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(fetchCalls.length).toBeGreaterThanOrEqual(3);
    expect(fetchCalls.length).toBeLessThan(6);
  });
});
