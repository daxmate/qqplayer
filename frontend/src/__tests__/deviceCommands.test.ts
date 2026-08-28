// deviceCommands.js 单元测试（桌面端设备指令工具：推送下载/远程删除/清单/格式化）
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../utils/apiClient.js", () => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPut: vi.fn(),
  apiPatch: vi.fn(),
  apiDelete: vi.fn(),
  invalidate: vi.fn(),
  scheduleFlush: vi.fn(),
  resolveServerUrl: (p: string) => p,
}));

// vi.mock 替换后运行时是 vi.fn()，但静态类型仍是真实 apiGet/apiPost 签名 → 显式收窄为 Mock
// （运行时行为不变；参考 ReaderSearch.test.ts 的 (x as Mock) 约定）
const { apiGet, apiPost } = (await import("../utils/apiClient.js")) as unknown as {
  apiGet: Mock;
  apiPost: Mock;
};
const {
  formatBytes,
  formatLastSeen,
  fetchDevices,
  fetchCommandHistory,
  pushSongsToDevice,
  deleteAssetsFromDevice,
} = await import("../utils/deviceCommands.js");

// pushSongsToDevice 参数是宽松 SongLike（path?: string），测试输入带 id 展示字段、
// path 可为 null（流媒体）→ 本地宽类型 + 断言到参数类型（运行时不变）
type TestSong = { id: string; path: string | null; type?: string };
type PushSongs = Parameters<typeof pushSongsToDevice>[0];

beforeEach(() => {
  vi.clearAllMocks();
  apiGet.mockResolvedValue({ ok: false, data: null, message: "mock" });
  apiPost.mockResolvedValue({ ok: false, data: null, message: "mock" });
});

describe("formatBytes（纯函数）", () => {
  it("边界：0 / 1023 / 1024 / 1.5KB / 1.5MB / 1GB", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1572864)).toBe("1.5 MB"); // 1.5 * 1024^2
    expect(formatBytes(1073741824)).toBe("1.0 GB"); // 1024^3
  });

  it("非数字 / 负数 / 空 → 0 B 兜底", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes("abc")).toBe("0 B");
    expect(formatBytes(undefined)).toBe("0 B");
    expect(formatBytes(null)).toBe("0 B");
    expect(formatBytes(NaN)).toBe("0 B");
  });
});

describe("pushSongsToDevice", () => {
  const MANIFEST_OK = {
    ok: true,
    data: {
      songs: [
        { path: "/a.mp3", sha256: "h1", size: 100 },
        { path: "/b.mp3", sha256: "h2", size: 200 },
      ],
    },
  };

  it("manifest 匹配 → 发送 pushDownload（items 带 sha256/size），返回 ok + id", async () => {
    apiGet.mockResolvedValueOnce(MANIFEST_OK);
    apiPost.mockResolvedValueOnce({ ok: true, data: { id: 42 } });
    const r = await pushSongsToDevice(
      [
        { id: "a", path: "/a.mp3" },
        { id: "b", path: "/b.mp3" },
      ] as TestSong[] as PushSongs,
      "dev1",
    );
    expect(r).toEqual({ ok: true, id: 42, skipped: [] });
    expect(apiPost).toHaveBeenCalledWith("/api/sync/commands", {
      type: "pushDownload",
      payload: {
        items: [
          { path: "/a.mp3", sha256: "h1", size: 100 },
          { path: "/b.mp3", sha256: "h2", size: 200 },
        ],
      },
      device_id: "dev1",
    });
  });

  it("流媒体（path=null）跳过 + manifest 匹配不到的项跳过（进 skipped）", async () => {
    apiGet.mockResolvedValueOnce(MANIFEST_OK);
    apiPost.mockResolvedValueOnce({ ok: true, data: { id: 7 } });
    const r = await pushSongsToDevice(
      [
        { id: "s", path: null, type: "stream" }, // 流媒体：直接跳过
        { id: "a", path: "/a.mp3" }, // 命中
        { id: "x", path: "/missing.mp3" }, // 匹配不到
      ] as TestSong[] as PushSongs,
      "dev1",
    );
    expect(apiPost).toHaveBeenCalledWith("/api/sync/commands", {
      type: "pushDownload",
      payload: { items: [{ path: "/a.mp3", sha256: "h1", size: 100 }] },
      device_id: "dev1",
    });
    expect(r.ok).toBe(true);
    expect(r.skipped).toEqual(["/missing.mp3"]);
  });

  it("items 空（全部匹配不到）→ 不发送请求，返回 no_valid_items", async () => {
    apiGet.mockResolvedValueOnce({ ok: true, data: { songs: [] } });
    const r = await pushSongsToDevice(
      [{ id: "x", path: "/x.mp3" }] as TestSong[] as PushSongs,
      "dev1",
    );
    expect(r).toEqual({ ok: false, reason: "no_valid_items", skipped: ["/x.mp3"] });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("无 path 输入（空数组/流媒体）→ 不发送请求", async () => {
    const r = await pushSongsToDevice([] as TestSong[] as PushSongs, "dev1");
    expect(r).toEqual({ ok: false, reason: "no_valid_items", skipped: [] });
    expect(apiPost).not.toHaveBeenCalled();
    const r2 = await pushSongsToDevice(
      [{ id: "s", path: null }] as TestSong[] as PushSongs,
      "dev1",
    );
    expect(r2).toEqual({ ok: false, reason: "no_valid_items", skipped: [] });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("manifest 拉取失败 → 不发送请求，返回 manifest_failed + 全部 skipped", async () => {
    apiGet.mockResolvedValueOnce({ ok: false, status: 0, message: "网络连接失败", network: true });
    const r = await pushSongsToDevice(
      [{ id: "a", path: "/a.mp3" }] as TestSong[] as PushSongs,
      "dev1",
    );
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("manifest_failed");
    expect(r.skipped).toEqual(["/a.mp3"]);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("指令发送失败 → send_failed + error（已匹配项已入 items，skipped 为空）", async () => {
    apiGet.mockResolvedValueOnce(MANIFEST_OK);
    apiPost.mockResolvedValueOnce({ ok: false, status: 500, message: "boom" });
    const r = await pushSongsToDevice(
      [{ id: "a", path: "/a.mp3" }] as TestSong[] as PushSongs,
      "dev1",
    );
    expect(r).toEqual({ ok: false, reason: "send_failed", skipped: [], error: "boom" });
  });
});

describe("deleteAssetsFromDevice", () => {
  it("发送 remoteDelete 指令（paths 透传）", async () => {
    apiPost.mockResolvedValueOnce({ ok: true, data: { id: 9 } });
    const r = await deleteAssetsFromDevice("dev1", ["audio/x.m4a", "audio/y.m4a"]);
    expect(r).toEqual({ ok: true, id: 9 });
    expect(apiPost).toHaveBeenCalledWith("/api/sync/commands", {
      type: "remoteDelete",
      payload: { paths: ["audio/x.m4a", "audio/y.m4a"] },
      device_id: "dev1",
    });
  });

  it("空路径 → 不发送请求，返回 no_paths", async () => {
    const r = await deleteAssetsFromDevice("dev1", []);
    expect(r).toEqual({ ok: false, reason: "no_paths" });
    expect(apiPost).not.toHaveBeenCalled();
  });

  it("发送失败 → send_failed + error", async () => {
    apiPost.mockResolvedValueOnce({ ok: false, message: "nope" });
    const r = await deleteAssetsFromDevice("dev1", ["audio/x.m4a"]);
    expect(r).toEqual({ ok: false, reason: "send_failed", error: "nope" });
  });
});

describe("fetchDevices / fetchCommandHistory", () => {
  it("fetchDevices 成功 → {ok, devices}", async () => {
    apiGet.mockResolvedValueOnce({ ok: true, data: { devices: [{ device_id: "d1" }] } });
    const r = await fetchDevices();
    expect(r).toEqual({ ok: true, devices: [{ device_id: "d1" }] });
    expect(apiGet).toHaveBeenCalledWith("/api/sync/devices");
  });

  it("fetchDevices 失败 → {ok:false, devices:[]} + error", async () => {
    apiGet.mockResolvedValueOnce({ ok: false, message: "x" });
    const r = await fetchDevices();
    expect(r).toEqual({ ok: false, devices: [], error: "x" });
  });

  it("fetchCommandHistory 无过滤 → 不带 query", async () => {
    apiGet.mockResolvedValueOnce({ ok: true, data: { commands: [] } });
    await fetchCommandHistory();
    expect(apiGet).toHaveBeenCalledWith("/api/sync/commands");
  });

  it("fetchCommandHistory 带过滤 → 拼 query（status + device_id）", async () => {
    apiGet.mockResolvedValueOnce({ ok: true, data: { commands: [] } });
    await fetchCommandHistory({ status: "done", device_id: "d1" });
    expect(apiGet).toHaveBeenCalledWith("/api/sync/commands?status=done&device_id=d1");
  });

  it("fetchCommandHistory 失败 → {ok:false, commands:[]} + error", async () => {
    apiGet.mockResolvedValueOnce({ ok: false, message: "y" });
    const r = await fetchCommandHistory();
    expect(r).toEqual({ ok: false, commands: [], error: "y" });
  });
});

describe("formatLastSeen", () => {
  it("空 / 无效 → 空串 / 原样", () => {
    expect(formatLastSeen("")).toBe("");
    expect(formatLastSeen(null)).toBe("");
    expect(formatLastSeen(undefined)).toBe("");
    expect(formatLastSeen("not-a-date")).toBe("not-a-date");
  });

  it("1 分钟内 → justNow label", () => {
    const d = new Date(Date.now() - 1000).toISOString();
    expect(formatLastSeen(d, { justNow: "刚刚" })).toBe("刚刚");
  });

  it("几分钟前 → minutesAgo(n)（n 为分钟数）", () => {
    const d = new Date(Date.now() - 330000).toISOString(); // 5.5 分钟前（避开毫秒误差）
    expect(formatLastSeen(d, { minutesAgo: (n) => `${n} 分钟前` })).toBe("5 分钟前");
  });

  it("昨天 → yesterday label", () => {
    const y = new Date(Date.now() - 24 * 3600000).toISOString();
    expect(formatLastSeen(y, { yesterday: "昨天" })).toBe("昨天");
  });
});
