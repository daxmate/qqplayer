// cacheDb 单元测试：jsdom 无 IndexedDB → 走内存降级实现（同一对外接口）
// 覆盖：set/get 往返 / maxAge 过期判定 / 无 maxAge 可读过期数据（离线降级语义）/ del / clear /
//       pendingOps 入队顺序 / removePendingOps / clearPendingOps
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCache,
  setCache,
  delCache,
  clearCache,
  enqueuePendingOp,
  getPendingOps,
  removePendingOps,
  clearPendingOps,
} from "../utils/cacheDb.js";

beforeEach(async () => {
  await clearCache();
  await clearPendingOps();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cache 表", () => {
  it("set/get 往返（含对象值）", async () => {
    await setCache("GET:/api/x", { a: 1, b: [2, 3] }, 60);
    expect(await getCache("GET:/api/x")).toEqual({ a: 1, b: [2, 3] });
  });

  it("未存过 → null", async () => {
    expect(await getCache("GET:/nope")).toBeNull();
  });

  it("maxAge 内命中；过期 miss（保留条目）", async () => {
    await setCache("k", "v1", 60);
    expect(await getCache("k", { maxAge: 60 })).toBe("v1");
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 1000);
    expect(await getCache("k", { maxAge: 60 })).toBeNull();
    // 过期只判 miss，不删条目：离线降级仍能读到
    expect(await getCache("k")).toBe("v1");
    vi.useRealTimers();
  });

  it("无 maxAge 时过期数据仍可读（离线降级语义）", async () => {
    await setCache("k", "old", 60);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 1000);
    expect(await getCache("k")).toBe("old");
    vi.useRealTimers();
  });

  it("del 删除单条", async () => {
    await setCache("k1", 1, 60);
    await setCache("k2", 2, 60);
    await delCache("k1");
    expect(await getCache("k1")).toBeNull();
    expect(await getCache("k2")).toBe(2);
  });

  it("clear 清空", async () => {
    await setCache("k1", 1, 60);
    await setCache("k2", 2, 60);
    await clearCache();
    expect(await getCache("k1")).toBeNull();
    expect(await getCache("k2")).toBeNull();
  });
});

describe("pendingOps 表", () => {
  it("入队返回 id；按入队顺序读取", async () => {
    const id1 = await enqueuePendingOp({ url: "/a", method: "POST" }, { x: 1 });
    await enqueuePendingOp({ url: "/b", method: "PUT" }, { x: 2 });
    expect(typeof id1).toBe("number");
    const ops = await getPendingOps();
    expect(ops.map((o) => o.op.url)).toEqual(["/a", "/b"]);
    expect(ops[0].payload).toEqual({ x: 1 });
    expect(ops[1].payload).toEqual({ x: 2 });
    expect(ops[0].ts).toBeTypeOf("number");
  });

  it("removePendingOps 按 id 删除", async () => {
    const id1 = await enqueuePendingOp({ url: "/a" }, 1);
    const id2 = await enqueuePendingOp({ url: "/b" }, 2);
    await removePendingOps([id1]);
    const ops = await getPendingOps();
    expect(ops.map((o) => o.id)).toEqual([id2]);
  });

  it("clearPendingOps 清空", async () => {
    await enqueuePendingOp({ url: "/a" }, 1);
    await clearPendingOps();
    expect(await getPendingOps()).toEqual([]);
  });
});
