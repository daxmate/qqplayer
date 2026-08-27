// apiClient 单元测试：统一出口 / Bearer token / baseURL / 声明式缓存 / 离线降级 / 401 特判 / dirty 队列
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  api,
  apiGet,
  apiPost,
  apiPut,
  apiDelete,
  invalidate,
  isOffline,
  onOfflineChange,
  onUnauthorized,
  flushPendingOps,
  writeLocal,
  resetApiClientState,
  resolveServerUrl,
} from "../utils/apiClient.js";
import {
  clearCache,
  clearPendingOps,
  setCache,
  enqueuePendingOp,
  getPendingOps,
} from "../utils/cacheDb.js";

// localStorage stub（Node 实验性 localStorage 在无 --localstorage-file 时不可用，与既有测试同款 stub）
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

beforeEach(async () => {
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  await Promise.all([clearCache(), clearPendingOps()]);
  resetApiClientState();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function okJson(data, status = 200) {
  return { ok: status < 400, status, json: async () => data };
}

describe("统一出口与归一化", () => {
  it("GET 返回 {ok, status, data}，fetch 以相对路径调用", async () => {
    const fetchMock = vi.fn(async () => okJson({ items: [1] }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await apiGet("/api/x");
    expect(fetchMock).toHaveBeenCalledWith("/api/x", expect.objectContaining({ method: "GET" }));
    expect(r).toMatchObject({ ok: true, status: 200, data: { items: [1] }, fromCache: false });
  });

  it("带 token 时自动加 Authorization: Bearer", async () => {
    localStorage.setItem("qqplayer.token", "tok123");
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/x");
    expect(fetchMock.mock.calls[0][1].headers).toEqual({
      Authorization: "Bearer tok123",
    });
  });

  it("无 token 时不带 Authorization", async () => {
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/x");
    expect(fetchMock.mock.calls[0][1].headers).toBeUndefined();
  });

  it("baseURL 从 localStorage qqplayer.server 读取（iOS 壳注入）", async () => {
    localStorage.setItem("qqplayer.server", "http://192.168.1.5:17627");
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/x");
    expect(fetchMock.mock.calls[0][0]).toBe("http://192.168.1.5:17627/api/x");
  });

  it("resolveServerUrl 附加 token query（浏览器/原生资源带不了 header；真机 401 修复）", () => {
    localStorage.setItem("qqplayer.server", "http://192.168.1.5:17627");
    localStorage.setItem("qqplayer.token", "tok-abc");
    expect(resolveServerUrl("/api/cover?path=x")).toBe(
      "http://192.168.1.5:17627/api/cover?path=x&token=tok-abc",
    );
    // 已有 query 用 & 拼接；绝对 URL 原样返回（不重复附加）
    expect(resolveServerUrl("http://cdn.example.com/a.jpg")).toBe("http://cdn.example.com/a.jpg");
    // 无 token 时行为与旧版一致
    localStorage.removeItem("qqplayer.token");
    expect(resolveServerUrl("/api/cover?path=x")).toBe("http://192.168.1.5:17627/api/cover?path=x");
  });

  it("POST 自动 JSON.stringify + Content-Type；DELETE 无 body 不带 header", async () => {
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/favorites/toggle", { path: "/a.mp3" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/favorites/toggle");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ path: "/a.mp3" }));
    expect(init.headers).toEqual({ "Content-Type": "application/json" });

    await apiDelete("/api/playlists/p1");
    expect(fetchMock.mock.calls[1][1]).toEqual(expect.objectContaining({ method: "DELETE" }));
  });

  it("FormData 原样透传（不 stringify、不设 Content-Type）", async () => {
    const fd = new FormData();
    fd.append("files", new File(["x"], "a.mp3"));
    const fetchMock = vi.fn(async () => okJson({ imported: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await apiPost("/api/import", fd);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.body).toBe(fd);
    expect(init.headers).toBeUndefined();
    expect(r.data).toEqual({ imported: 1 });
  });

  it("错误归一化：HTTP 错误带 detail 提取 message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ detail: "歌单不存在" }, 404)),
    );
    const r = await apiGet("/api/playlists/p9");
    expect(r).toMatchObject({ ok: false, status: 404, network: false });
    expect(r.data.detail).toBe("歌单不存在");
    expect(r.message).toBe("歌单不存在");
  });

  it("网络失败（fetch 抛错）→ {ok:false, network:true, message 透传}", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    const r = await apiGet("/api/x");
    expect(r).toMatchObject({ ok: false, status: 0, network: true });
    expect(r.message).toBe("network down");
  });

  it("超时（AbortError）→ 网络失败路径", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("The operation was aborted", "AbortError")),
            );
          }),
      ),
    );
    const r = await apiGet("/api/slow", { timeout: 20 });
    expect(r.network).toBe(true);
  });

  it("raw 模式：返回原始 Response 供二进制消费", async () => {
    const arrayBuffer = new ArrayBuffer(8);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => arrayBuffer })),
    );
    const r = await api({ url: "/api/books/b1/file", raw: true });
    expect(r.ok).toBe(true);
    expect(await r.response.arrayBuffer()).toBe(arrayBuffer);
  });
});

describe("声明式缓存", () => {
  it("ttl 内命中：第二次不请求网络，fromCache=true", async () => {
    const fetchMock = vi.fn(async () => okJson({ v: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const r1 = await apiGet("/api/meta", { cache: { ttl: 60 } });
    const r2 = await apiGet("/api/meta", { cache: { ttl: 60 } });
    expect(r1.fromCache).toBe(false);
    expect(r2).toMatchObject({ ok: true, data: { v: 1 }, fromCache: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("缓存过期：重新请求", async () => {
    const fetchMock = vi.fn(async () => okJson({ v: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    await apiGet("/api/meta", { cache: { ttl: 1 } });
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);
    await apiGet("/api/meta", { cache: { ttl: 1 } });
    vi.useRealTimers();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("force 跳过缓存读（仍写缓存）", async () => {
    await setCache("GET:/api/meta", { v: "cached" }, 3600);
    const fetchMock = vi.fn(async () => okJson({ v: "fresh" }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await apiGet("/api/meta", { cache: { ttl: 60 }, force: true });
    expect(r).toMatchObject({ ok: true, data: { v: "fresh" }, fromCache: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("POST 不缓存：同 URL 每次请求", async () => {
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiPost("/api/w", { x: 1 }, { cache: { ttl: 60 } });
    await apiPost("/api/w", { x: 2 }, { cache: { ttl: 60 } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidate 失效缓存后重新请求", async () => {
    await setCache("GET:/api/meta", { v: "cached" }, 3600);
    const fetchMock = vi.fn(async () => okJson({ v: "fresh" }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await apiGet("/api/meta", { cache: { ttl: 60 } })).fromCache).toBe(true);
    await invalidate("/api/meta");
    const r = await apiGet("/api/meta", { cache: { ttl: 60 } });
    expect(r.data).toEqual({ v: "fresh" });
    expect(r.fromCache).toBe(false);
  });
});

describe("离线降级", () => {
  it("网络失败 + offline 声明 + 过期缓存命中 → 返回缓存并进入离线模式", async () => {
    await setCache("GET:/api/lyric", { lines: [] }, 3600);
    // 让缓存过期（maxAge 60 判定 miss）：走网络 → 失败 → 离线降级读 stale
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 1000);
    const changes = [];
    onOfflineChange((off) => changes.push(off));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const r = await apiGet("/api/lyric", { cache: { ttl: 60, offline: true } });
    expect(r).toMatchObject({ ok: true, data: { lines: [] }, fromCache: true, degraded: true });
    expect(isOffline()).toBe(true);
    expect(changes).toEqual([true]);
    vi.useRealTimers();
  });

  it("网络失败 + 无缓存 → 网络错误（不进离线模式）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    const r = await apiGet("/api/live", { cache: { ttl: 60, offline: true } });
    expect(r.ok).toBe(false);
    expect(r.network).toBe(true);
    expect(isOffline()).toBe(false);
  });

  it("恢复在线：任一成功请求触发恢复事件", async () => {
    await setCache("GET:/api/lyric", { lines: [] }, 3600);
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61 * 1000); // 过期缓存
    const changes = [];
    onOfflineChange((off) => changes.push(off));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await apiGet("/api/lyric", { cache: { ttl: 60, offline: true } });
    expect(isOffline()).toBe(true);
    // 网络恢复
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ ok: 1 })),
    );
    await apiGet("/api/ping");
    expect(isOffline()).toBe(false);
    expect(changes).toEqual([true, false]);
    vi.useRealTimers();
  });
});

describe("401 特判", () => {
  it("带 token 遇 401 → 清 token + 触发重配对事件", async () => {
    localStorage.setItem("qqplayer.token", "tok");
    const unauth = vi.fn();
    onUnauthorized(unauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ detail: "invalid token" }, 401)),
    );
    const r = await apiGet("/api/private");
    expect(r).toMatchObject({ ok: false, status: 401 });
    expect(localStorage.getItem("qqplayer.token")).toBeNull();
    expect(unauth).toHaveBeenCalledTimes(1);
  });

  it("无 token 遇 401（桌面场景）→ 不触发重配对事件", async () => {
    const unauth = vi.fn();
    onUnauthorized(unauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({}, 401)),
    );
    await apiGet("/api/x");
    expect(unauth).not.toHaveBeenCalled();
  });

  it("skip401（夸克登录 401 语义）→ token 保留、事件不触发", async () => {
    localStorage.setItem("qqplayer.token", "tok");
    const unauth = vi.fn();
    onUnauthorized(unauth);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okJson({ error: "quark_login_required", message: "需要登录夸克网盘" }, 401),
      ),
    );
    const r = await apiGet("/api/gequhai/download", { skip401: true });
    expect(r.status).toBe(401);
    expect(localStorage.getItem("qqplayer.token")).toBe("tok");
    expect(unauth).not.toHaveBeenCalled();
  });
});

describe("写路径 dirty 队列", () => {
  it("writeLocal 成功 → ok + 清队", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({})),
    );
    const result = await writeLocal({
      url: "/api/favorites/toggle",
      method: "POST",
      body: { path: "/a" },
    });
    expect(result).toBe("ok");
    expect(await getPendingOps()).toEqual([]);
  });

  it("writeLocal 网络失败 → queued + 保留队列（离线语义）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const result = await writeLocal({
      url: "/api/favorites/toggle",
      method: "POST",
      body: { path: "/a" },
    });
    expect(result).toBe("queued");
    const ops = await getPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].op.url).toBe("/api/favorites/toggle");
    expect(ops[0].payload).toEqual({ path: "/a" });
  });

  it("writeLocal HTTP 拒绝 → rejected + 清队（服务端为准）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ detail: "nope" }, 400)),
    );
    const result = await writeLocal({
      url: "/api/playlists/p1/songs",
      method: "POST",
      body: { path: "/a" },
    });
    expect(result).toBe("rejected");
    expect(await getPendingOps()).toEqual([]);
  });

  it("flushPendingOps：成功清队、失败保留", async () => {
    await enqueuePendingOp({ url: "/api/a", method: "POST" }, { x: 1 });
    const keptId = await enqueuePendingOp({ url: "/api/b", method: "POST" }, { x: 2 });
    const fetchMock = vi.fn(async (url) => {
      if (url === "/api/a") return okJson({});
      return okJson({}, 500); // /api/b 失败保留
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await flushPendingOps();
    expect(res).toEqual({ flushed: 1, kept: 1 });
    const ops = await getPendingOps();
    expect(ops.map((o) => o.id)).toEqual([keptId]);
  });

  it("flushPendingOps：空队列直接返回", async () => {
    expect(await flushPendingOps()).toEqual({ flushed: 0, kept: 0 });
  });

  it("apiPut/apiPost 便捷方法可用", async () => {
    const fetchMock = vi.fn(async () => okJson({}));
    vi.stubGlobal("fetch", fetchMock);
    await apiPut("/api/settings", { ui: {} });
    await apiPost("/api/now-playing", { path: "/a" });
    expect(fetchMock.mock.calls.map(([u, i]) => [u, i.method])).toEqual([
      ["/api/settings", "PUT"],
      ["/api/now-playing", "POST"],
    ]);
  });
});
