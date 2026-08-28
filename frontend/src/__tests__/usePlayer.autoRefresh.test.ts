// usePlayer composable 单元测试 — setupAutoRefresh iCloud 自动刷新
// 拆分自 usePlayer.test.js（纯搬移 + harness 收敛公共头部样板，用例零改动）
import { afterEach, describe, expect, it, vi } from "vitest";
import { state, setupAutoRefresh, stopAutoRefresh } from "./helpers/usePlayerHarness.js";

describe("setupAutoRefresh（iCloud 库自动刷新）", () => {
  afterEach(() => {
    vi.useRealTimers();
    stopAutoRefresh();
  });

  function stubVersion(version: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/library/version") {
          return { ok: true, json: async () => ({ version }) };
        }
        if (url === "/api/songs") {
          return {
            ok: true,
            json: async () => [
              { path: "/a.mp3", name: "A" },
              { path: "/b.mp3", name: "B" },
            ],
          };
        }
        throw new Error("unexpected url " + url);
      }),
    );
  }

  it("首次轮询只记录版本号，不刷新列表", async () => {
    stubVersion(0);
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.libraryVersion).toBe(0);
    expect(fetch).not.toHaveBeenCalledWith("/api/songs", expect.anything());
  });

  it("版本号变化 → 自动重新拉取歌曲列表", async () => {
    let v = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/library/version") {
          return { ok: true, json: async () => ({ version: v }) };
        }
        if (url === "/api/songs") {
          return { ok: true, json: async () => [{ path: "/new.mp3", name: "新歌" }] };
        }
        throw new Error("unexpected url " + url);
      }),
    );
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.libraryVersion).toBe(0);
    v = 1; // 库变动
    await vi.advanceTimersByTimeAsync(100);
    expect(state.libraryVersion).toBe(1);
    expect(fetch).toHaveBeenCalledWith("/api/songs", expect.anything());
    expect(state.songs.map((s) => s.name)).toEqual(["新歌"]);
  });

  it("版本号不变 → 不刷新", async () => {
    let songsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/library/version") {
          return { ok: true, json: async () => ({ version: 3 }) };
        }
        if (url === "/api/songs") {
          songsCalls += 1;
          return { ok: true, json: async () => [] };
        }
        throw new Error("unexpected url " + url);
      }),
    );
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(songsCalls).toBe(0);
    expect(state.libraryVersion).toBe(3);
  });

  it("重复调用幂等，不叠加 timer", async () => {
    stubVersion(0);
    vi.useFakeTimers();
    setupAutoRefresh(100);
    setupAutoRefresh(100);
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.libraryVersion).toBe(0);
  });

  it("接口异常时静默，不影响下一轮", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("backend down");
      }),
    );
    vi.useFakeTimers();
    setupAutoRefresh(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(state.libraryVersion).toBeNull();
  });
});
