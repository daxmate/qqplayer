// 同步数据层：内容寻址哈希 + 状态对象与测试复位
//
// 说明：原设备端指令链路（getDeviceId / pollCommands / 指令轮询 interval / reportAssets）
// 随 iOS 壳 2026-09-13 退役一并移除；本文件保留数据层的回归覆盖。
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../utils/apiClient.js", () => ({
  apiGet: vi.fn(async () => ({ ok: false, status: 0, data: null })),
  isOffline: vi.fn(() => false),
  onOfflineChange: vi.fn(() => () => {}),
  resolveServerUrl: (p: string) => p,
}));

import { stableHash, syncState, getSyncState, _resetSyncForTests } from "../utils/sync.js";

describe("stableHash：稳定内容寻址键", () => {
  it("同输入同值、不同输入不同值、格式为十六进制串", async () => {
    const a1 = await stableHash("/Music/a.mp3");
    const a2 = await stableHash("/Music/a.mp3");
    const b = await stableHash("/Music/b.mp3");
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1).toMatch(/^[0-9a-f]+$/);
  });

  it("非 ASCII（中文路径）稳定且不抛", async () => {
    const k1 = await stableHash("有声书/小王子/chapter 1.m4b");
    const k2 = await stableHash("有声书/小王子/chapter 1.m4b");
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]+$/);
  });

  it("空/异常输入：仍返回合法哈希（不抛）", async () => {
    expect(await stableHash("")).toMatch(/^[0-9a-f]+$/);
    expect(await stableHash(null as unknown as string)).toMatch(/^[0-9a-f]+$/);
  });
});

describe("syncState / getSyncState / _resetSyncForTests", () => {
  beforeEach(() => {
    _resetSyncForTests();
  });

  it("getSyncState 返回 syncState 本体（同一响应式对象）", () => {
    expect(getSyncState()).toBe(syncState);
  });

  it("_resetSyncForTests：复位 syncing / lastError / lastSyncAt", () => {
    syncState.syncing = true;
    syncState.lastError = "boom";
    syncState.lastSyncAt = 12345;
    _resetSyncForTests();
    expect(syncState.syncing).toBe(false);
    expect(syncState.lastError).toBe("");
    expect(syncState.lastSyncAt).toBeNull();
  });

  it("syncState 字段集合：只剩主机端可见的同步状态（无设备端下载聚合）", () => {
    expect(Object.keys(syncState).sort()).toEqual(["lastError", "lastSyncAt", "syncing"]);
  });
});
