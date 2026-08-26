// syncCommands.test.js：T2 指令轮询执行器单元测试
//   pollCommands（pushDownload 反查 sync:songs → syncDownload / remoteDelete → deleteAssets /
//   逐条 ack 形状）/ getDeviceId（原生桥回执 + 缓存 + 超时）/ 60s interval 生命周期
//   （initSync 启动 / inactive 清理 / active 重启）/ syncNow 成功后顺带轮询 / reportAssets
//   （assetIndex + assetsSize 回执 → POST device/assets）
//
// mock 策略（同 sync.test.js）：
//   - apiClient：vi.mock 整模块（apiGet + apiPost + resolveServerUrl）
//   - nativeAudioBridge：vi.mock 整模块（onNativeEvent 捕获订阅者 / nativePost 记录消息）
//   - cacheDb：真实模块（jsdom 无 IndexedDB → 内存实现，setup.js 每用例清空）
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ---------- mock：nativeAudioBridge（事件订阅 + 发消息） ----------
const bridgeMock = vi.hoisted(() => {
  const handlers = new Map(); // name → Set<fn>
  return {
    handlers,
    post: vi.fn(),
    onNativeEvent: vi.fn((name, fn) => {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(fn);
      return () => {
        handlers.get(name)?.delete(fn);
      };
    }),
    /** 模拟原生侧回推事件 */
    emit(name, payload) {
      const set = handlers.get(name);
      if (!set) return;
      for (const fn of [...set]) {
        try {
          fn(payload);
        } catch {
          /* 订阅者异常不中断派发 */
        }
      }
    },
  };
});

vi.mock("../composables/nativeAudioBridge.js", () => ({
  onNativeEvent: bridgeMock.onNativeEvent,
  nativePost: bridgeMock.post,
}));

// ---------- mock：apiClient ----------
const apiMock = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  resolveServerUrl: vi.fn((p) =>
    /^https?:\/\//i.test(p) ? p : "http://192.168.1.50:17627" + (p.startsWith("/") ? p : "/" + p),
  ),
}));

vi.mock("../utils/apiClient.js", () => apiMock);

// ---------- 被测模块（静态导入；_resetSyncForTests 保证用例隔离） ----------
import { setCache } from "../utils/cacheDb.js";
import * as sync from "../utils/sync.js";

// jsdom（vitest 4）无 localStorage → 手写 stub（wifiOnlyEnabled 依赖）
const lsStore = {};
const localStorageStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => {
    lsStore[k] = String(v);
  },
  removeItem: (k) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};
function clearLs() {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

/** 等待微任务 + 宏任务队列排空 */
function flush() {
  return new Promise((r) => setTimeout(r, 0));
}

async function setNativeEnv() {
  window.qqplayerNative = true;
  window.qqplayerIosBridge = { postMessage: vi.fn() };
}

/** 预置 deviceId 缓存：调用 getDeviceId 并立即回执（后续 pollCommands/reportAssets 不再等桥） */
async function primeDeviceId(deviceId = "dev-123") {
  const p = sync.getDeviceId();
  const call = bridgeMock.post.mock.calls.find((c) => c[0] && c[0].cmd === "getDeviceId");
  expect(call).toBeTruthy();
  bridgeMock.emit("deviceId", { requestId: call[0].requestId, deviceId });
  await p;
}

/** 取 bridgeMock.post 中指定 cmd 的最后一条消息 */
function lastPost(cmd) {
  const calls = bridgeMock.post.mock.calls.filter((c) => c[0] && c[0].cmd === cmd);
  return calls.length ? calls[calls.length - 1][0] : null;
}

/** 取 apiPost 指定 url 前缀的最后一次调用 */
function lastApiPost(urlPrefix) {
  const calls = apiMock.apiPost.mock.calls.filter((c) => String(c[0]).startsWith(urlPrefix));
  return calls.length
    ? { url: calls[calls.length - 1][0], body: calls[calls.length - 1][1] }
    : null;
}

/** 通用 pending 拉取 mock：单条指令 */
function mockPending(command) {
  apiMock.apiGet.mockImplementation((url) => {
    if (String(url).includes("/api/sync/commands/pending")) {
      return Promise.resolve({ ok: true, status: 200, data: { commands: [command] } });
    }
    return Promise.resolve({ ok: true, status: 200, data: {} });
  });
  apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
}

const songA = { path: "/Music/a.mp3", name: "A", size: 100, sha256: "aaa111" };
const songB = { path: "/Music/b.flac", name: "B", size: 200, sha256: "bbb222" };

beforeEach(async () => {
  delete window.qqplayerNative;
  delete window.qqplayerIosBridge;
  apiMock.apiGet.mockReset();
  apiMock.apiPost.mockReset();
  bridgeMock.post.mockClear();
  bridgeMock.handlers.clear();
  clearLs();
  vi.stubGlobal("localStorage", localStorageStub);
  sync._resetSyncForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("getDeviceId：原生桥回执 + 缓存 + 超时", () => {
  it("原生回执 → resolve(deviceId)；再次调用命中缓存（同一 Promise）", async () => {
    await setNativeEnv();
    const p1 = sync.getDeviceId();
    const p2 = sync.getDeviceId();
    expect(p1).toBe(p2); // 缓存：并发共享同一 Promise
    expect(bridgeMock.post).toHaveBeenCalledWith({ cmd: "getDeviceId", requestId: "1" });
    bridgeMock.emit("deviceId", { requestId: "1", deviceId: "dev-abc" });
    await expect(p1).resolves.toBe("dev-abc");
    expect(await sync.getDeviceId()).toBe("dev-abc"); // 已缓存
    expect(bridgeMock.post).toHaveBeenCalledTimes(1); // 不再重复查询
  });

  it("原生无回执：超时 resolve(null)，不挂起调用方", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.getDeviceId();
    await vi.advanceTimersByTimeAsync(sync.DEVICE_ID_TIMEOUT_MS + 10);
    await expect(p).resolves.toBeNull();
  });

  it("非原生环境 → resolve(null)，不发桥消息", async () => {
    expect(await sync.getDeviceId()).toBeNull();
    expect(bridgeMock.post).not.toHaveBeenCalled();
  });
});

describe("pollCommands：指令拉取 + 执行 + 回执", () => {
  it("pushDownload 全部匹配：sync:songs 反查 → syncDownload 收到正确下载项 + ack ok", async () => {
    await setNativeEnv();
    await primeDeviceId();
    await setCache("sync:songs", [songA, songB]);
    mockPending({
      id: "c1",
      type: "pushDownload",
      payload: { items: [{ path: "/Music/a.mp3" }, { path: "/Music/b.flac" }] },
    });
    const r = await sync.pollCommands();
    // 轮询 URL 带 device_id
    expect(apiMock.apiGet).toHaveBeenCalledWith("/api/sync/commands/pending?device_id=dev-123");
    // 下载项形状：url 走 resolveServerUrl、path 走 stableHash、sha256/size 来自 manifest 条目
    const dl = lastPost("syncDownload");
    expect(dl).toBeTruthy();
    expect(dl.items).toHaveLength(2);
    expect(dl.items[0]).toMatchObject({
      url: "http://192.168.1.50:17627/api/audio?path=" + encodeURIComponent("/Music/a.mp3"),
      sha256: "aaa111",
      size: 100,
      wifiOnly: true,
    });
    expect(dl.items[0].path).toMatch(/^audio\/[0-9a-f]{64}\.mp3$/);
    expect(dl.items[1]).toMatchObject({
      url: "http://192.168.1.50:17627/api/audio?path=" + encodeURIComponent("/Music/b.flac"),
      sha256: "bbb222",
      size: 200,
    });
    expect(dl.items[1].path).toMatch(/^audio\/[0-9a-f]{64}\.flac$/);
    // ack：ok=true，无 skipped 不带 detail
    const ack = lastApiPost("/api/sync/commands/c1/ack");
    expect(ack.url).toBe("/api/sync/commands/c1/ack");
    expect(ack.body).toEqual({ device_id: "dev-123", ok: true });
    expect(r).toEqual({ ok: true, executed: 1 });
    // 执行过指令 → 顺带上报（fire-and-forget；assetIndex 空注册表 → 静默跳过）
    expect(lastPost("assetIndex")).toBeTruthy();
    bridgeMock.emit("assetIndex", { assets: [] });
    await flush();
  });

  it("pushDownload 部分 path 未匹配：ok=true + detail.skipped，不阻塞整体", async () => {
    await setNativeEnv();
    await primeDeviceId();
    await setCache("sync:songs", [songA]);
    mockPending({
      id: "c2",
      type: "pushDownload",
      payload: { items: [{ path: "/Music/a.mp3" }, { path: "/Music/ghost.mp3" }] },
    });
    const r = await sync.pollCommands();
    const dl = lastPost("syncDownload");
    expect(dl).toBeTruthy();
    expect(dl.items).toHaveLength(1); // 只下载匹配到的
    expect(dl.items[0].path).toMatch(/^audio\/[0-9a-f]{64}\.mp3$/);
    const ack = lastApiPost("/api/sync/commands/c2/ack");
    expect(ack.body).toEqual({
      device_id: "dev-123",
      ok: true,
      detail: { skipped: ["/Music/ghost.mp3"] },
    });
    expect(r).toEqual({ ok: true, executed: 1 });
    bridgeMock.emit("assetIndex", { assets: [] });
    await flush();
  });

  it("remoteDelete：nativePost deleteAssets + ack ok=true detail.deleted", async () => {
    await setNativeEnv();
    await primeDeviceId();
    mockPending({
      id: "c3",
      type: "remoteDelete",
      payload: { paths: ["audio/1.m4a", "audio/2.m4a"] },
    });
    const r = await sync.pollCommands();
    expect(lastPost("deleteAssets")).toEqual({
      cmd: "deleteAssets",
      paths: ["audio/1.m4a", "audio/2.m4a"],
    });
    const ack = lastApiPost("/api/sync/commands/c3/ack");
    expect(ack.body).toEqual({ device_id: "dev-123", ok: true, detail: { deleted: 2 } });
    expect(r).toEqual({ ok: true, executed: 1 });
    bridgeMock.emit("assetIndex", { assets: [] });
    await flush();
  });

  it("ack 形状：pushDownload 全部反查失败 → ok=false + error=no valid items + skipped", async () => {
    await setNativeEnv();
    await primeDeviceId();
    await setCache("sync:songs", [songA]);
    mockPending({
      id: "c4",
      type: "pushDownload",
      payload: { items: [{ path: "/Music/ghost.mp3" }, { path: "/Music/ghost2.flac" }] },
    });
    const r = await sync.pollCommands();
    expect(lastPost("syncDownload")).toBeNull(); // 无有效下载项
    const ack = lastApiPost("/api/sync/commands/c4/ack");
    expect(ack.body).toEqual({
      device_id: "dev-123",
      ok: false,
      error: "no valid items",
      detail: { skipped: ["/Music/ghost.mp3", "/Music/ghost2.flac"] },
    });
    expect(r).toEqual({ ok: true, executed: 1 }); // 处理过（失败也回执）
  });

  it("拉取失败 / 无指令：静默返回，不发 ack", async () => {
    await setNativeEnv();
    await primeDeviceId();
    apiMock.apiGet.mockResolvedValue({ ok: false, status: 0, message: "net down", network: true });
    expect(await sync.pollCommands()).toEqual({ ok: false, executed: 0 });
    expect(apiMock.apiPost).not.toHaveBeenCalled();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: { commands: [] } });
    expect(await sync.pollCommands()).toEqual({ ok: true, executed: 0 });
    expect(apiMock.apiPost).not.toHaveBeenCalled();
  });
});

describe("60s 轮询 interval：initSync 启动 / inactive 清理 / active 重启", () => {
  it("initSync 后注册；inactive 停止；active 重启（fake timers）", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    apiMock.apiGet.mockResolvedValue({ ok: true, status: 200, data: { commands: [] } });
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    await primeDeviceId(); // 预置 deviceId：轮询 tick 立即发 GET（不等 3s 超时）
    const pendingCalls = () =>
      apiMock.apiGet.mock.calls.filter((c) => String(c[0]).includes("/api/sync/commands/pending"))
        .length;

    sync.initSync();
    await vi.advanceTimersByTimeAsync(0);
    const afterInit = pendingCalls();
    expect(afterInit).toBeGreaterThan(0); // initSync 顺带首轮拉取（syncNow 钩子）

    // 60s 后 interval 触发轮询
    await vi.advanceTimersByTimeAsync(sync.COMMAND_POLL_MS);
    expect(pendingCalls()).toBeGreaterThan(afterInit);

    // inactive：interval 清理，不再轮询
    bridgeMock.emit("appState", { state: "inactive" });
    const afterInactive = pendingCalls();
    await vi.advanceTimersByTimeAsync(sync.COMMAND_POLL_MS * 2);
    expect(pendingCalls()).toBe(afterInactive);

    // active：重启 interval
    bridgeMock.emit("appState", { state: "active" });
    await vi.advanceTimersByTimeAsync(sync.COMMAND_POLL_MS);
    expect(pendingCalls()).toBeGreaterThan(afterInactive);
  });
});

describe("syncNow 成功后顺带 pollCommands", () => {
  it("manifest 先拉、pending 后拉（fire-and-forget 不阻塞 syncNow 返回）", async () => {
    await setNativeEnv();
    await primeDeviceId();
    apiMock.apiGet.mockImplementation((url) => {
      if (url === "/api/sync/manifest") {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { version: "v1", songs: [songA] },
        });
      }
      if (String(url).includes("/api/sync/commands/pending")) {
        return Promise.resolve({ ok: true, status: 200, data: { commands: [] } });
      }
      return Promise.resolve({ ok: true, status: 200, data: {} });
    });
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    const r = await sync.syncNow();
    expect(r.ok).toBe(true);
    const urls = apiMock.apiGet.mock.calls.map((c) => c[0]);
    expect(urls[0]).toBe("/api/sync/manifest");
    expect(urls).toContain("/api/sync/commands/pending?device_id=dev-123");
    expect(urls.indexOf("/api/sync/manifest")).toBeLessThan(
      urls.indexOf("/api/sync/commands/pending?device_id=dev-123"),
    );
  });

  it("appState active → 顺带 pollCommands（fire-and-forget）", async () => {
    await setNativeEnv();
    await primeDeviceId();
    apiMock.apiGet.mockImplementation((url) => {
      if (url === "/api/sync/manifest") {
        return Promise.resolve({ ok: true, status: 200, data: { version: "v1", songs: [] } });
      }
      if (String(url).includes("/api/sync/commands/pending")) {
        return Promise.resolve({ ok: true, status: 200, data: { commands: [] } });
      }
      return Promise.resolve({ ok: true, status: 200, data: {} });
    });
    sync.initSync();
    await flush();
    apiMock.apiGet.mockClear();
    bridgeMock.emit("appState", { state: "active" });
    await flush();
    expect(apiMock.apiGet).toHaveBeenCalledWith(
      expect.stringContaining("/api/sync/commands/pending"),
    );
  });
});

describe("reportAssets：资产清单上报", () => {
  it("assetIndex + assetsSize 回执 → POST device/assets 形状正确", async () => {
    await setNativeEnv();
    await primeDeviceId();
    apiMock.apiPost.mockResolvedValue({ ok: true, status: 200, data: { ok: true } });
    const p = sync.reportAssets();
    await flush(); // getDeviceId 已缓存（resolved promise）→ 微任务后进入上报流程
    expect(lastPost("assetIndex")).toBeTruthy();
    expect(lastPost("assetsSize")).toBeTruthy();
    bridgeMock.emit("assetIndex", {
      assets: [
        { path: "audio/abc.m4a", sha256: "s1", size: 10 },
        { path: "covers/def.jpg", sha256: "s2", size: 20 },
      ],
    });
    bridgeMock.emit("assetsSize", { total: 12345, byType: { audio: 10000, covers: 2345 } });
    await expect(p).resolves.toBe(true);
    expect(apiMock.apiPost).toHaveBeenCalledWith("/api/sync/device/assets", {
      device_id: "dev-123",
      assets: [
        { path: "audio/abc.m4a", sha256: "s1", size: 10 },
        { path: "covers/def.jpg", sha256: "s2", size: 20 },
      ],
      total: 12345,
      byType: { audio: 10000, covers: 2345 },
    });
  });

  it("deviceId 超时拿不到 → 静默跳过（不发 assetIndex / 不 POST）", async () => {
    vi.useFakeTimers();
    await setNativeEnv();
    const p = sync.reportAssets();
    expect(lastPost("getDeviceId")).toBeTruthy();
    await vi.advanceTimersByTimeAsync(sync.DEVICE_ID_TIMEOUT_MS + 10);
    await expect(p).resolves.toBe(false);
    expect(lastPost("assetIndex")).toBeNull(); // 未拿到 deviceId：不进入上报流程
    expect(apiMock.apiPost).not.toHaveBeenCalled();
  });
});
