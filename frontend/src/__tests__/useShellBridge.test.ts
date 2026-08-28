// useShellBridge 统一壳桥测试：mock window 三种模式（tauri / webkit / null）
// 覆盖 report / pickLibrary / pickDictFiles / startDragging / on 的解绑与事件派发（tauri 模式 CustomEvent 转发）
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { useShellBridge } from "../composables/useShellBridge.js";

// 每个用例前清空壳环境（jsdom 默认无 __TAURI_INTERNALS__ / webkit）
function clearShellEnv() {
  delete window.__TAURI_INTERNALS__;
  delete window.__TAURI__;
  delete window.webkit;
}

beforeEach(clearShellEnv);
afterEach(clearShellEnv);

describe("模式探测", () => {
  it("无任何壳 → null（浏览器直连）", () => {
    expect(useShellBridge().mode).toBeNull();
  });

  it("window.__TAURI_INTERNALS__ → tauri", () => {
    window.__TAURI_INTERNALS__ = {};
    expect(useShellBridge().mode).toBe("tauri");
  });

  it("window.webkit.messageHandlers.native → webkit", () => {
    window.webkit = { messageHandlers: { native: { postMessage: vi.fn() } } };
    expect(useShellBridge().mode).toBe("webkit");
  });

  it("tauri 优先于 webkit（__TAURI_INTERNALS__ 先判）", () => {
    window.__TAURI_INTERNALS__ = {};
    window.webkit = { messageHandlers: { native: { postMessage: vi.fn() } } };
    expect(useShellBridge().mode).toBe("tauri");
  });
});

describe("report", () => {
  it("webkit → postMessage(msg)（保持现状）", () => {
    const post = vi.fn();
    window.webkit = { messageHandlers: { native: { postMessage: post } } };
    useShellBridge().report({ type: "lyric", show: false });
    expect(post).toHaveBeenCalledWith({ type: "lyric", show: false });
  });

  it("tauri → invoke('report', { msg })", async () => {
    window.__TAURI_INTERNALS__ = {};
    const invoke = vi.fn(async () => ({}));
    window.__TAURI__ = { core: { invoke }, event: { listen: vi.fn() } };
    await useShellBridge().report({ type: "closeMini" });
    expect(invoke).toHaveBeenCalledWith("report", { msg: { type: "closeMini" } });
  });

  it("tauri invoke 失败静默（catch 后不抛）", async () => {
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = {
      core: { invoke: vi.fn(async () => Promise.reject(new Error("shell dead"))) },
      event: { listen: vi.fn() },
    };
    await expect(useShellBridge().report({ type: "openMini" })).resolves.toBeUndefined();
  });

  it("null → noop 不抛", () => {
    expect(() => useShellBridge().report({ type: "x" })).not.toThrow();
  });
});

describe("pickLibrary", () => {
  it('webkit → postMessage("pickLibrary")（字符串，保持现状）', () => {
    const post = vi.fn();
    window.webkit = { messageHandlers: { native: { postMessage: post } } };
    useShellBridge().pickLibrary();
    expect(post).toHaveBeenCalledWith("pickLibrary");
  });

  it("tauri → invoke('pick_library')", async () => {
    window.__TAURI_INTERNALS__ = {};
    const invoke = vi.fn(async () => ({}));
    window.__TAURI__ = { core: { invoke }, event: { listen: vi.fn() } };
    await useShellBridge().pickLibrary();
    expect(invoke).toHaveBeenCalledWith("pick_library");
  });

  it("null → noop 不抛", () => {
    expect(() => useShellBridge().pickLibrary()).not.toThrow();
  });
});

describe("pickDictFiles", () => {
  it('webkit → postMessage({ type: "pickDictFiles" })（保持现状）', () => {
    const post = vi.fn();
    window.webkit = { messageHandlers: { native: { postMessage: post } } };
    useShellBridge().pickDictFiles();
    expect(post).toHaveBeenCalledWith({ type: "pickDictFiles" });
  });

  it("tauri → invoke('pick_dict_files')", async () => {
    window.__TAURI_INTERNALS__ = {};
    const invoke = vi.fn(async () => ({}));
    window.__TAURI__ = { core: { invoke }, event: { listen: vi.fn() } };
    await useShellBridge().pickDictFiles();
    expect(invoke).toHaveBeenCalledWith("pick_dict_files");
  });

  it("null → noop 不抛", () => {
    expect(() => useShellBridge().pickDictFiles()).not.toThrow();
  });
});

describe("startDragging", () => {
  it('webkit → postMessage({ type: "nativeDrag" })', () => {
    const post = vi.fn();
    window.webkit = { messageHandlers: { native: { postMessage: post } } };
    useShellBridge().startDragging();
    expect(post).toHaveBeenCalledWith({ type: "nativeDrag" });
  });

  it("tauri → invoke('report', { msg: { type: \"nativeDrag\" } })", async () => {
    window.__TAURI_INTERNALS__ = {};
    const invoke = vi.fn(async () => ({}));
    window.__TAURI__ = { core: { invoke }, event: { listen: vi.fn() } };
    await useShellBridge().startDragging();
    expect(invoke).toHaveBeenCalledWith("report", { msg: { type: "nativeDrag" } });
  });

  it("null → noop 不抛", () => {
    expect(() => useShellBridge().startDragging()).not.toThrow();
  });
});

describe("on（壳事件监听）", () => {
  it("webkit → 直接 window.addEventListener，解绑后不再收到", () => {
    window.webkit = { messageHandlers: { native: { postMessage: vi.fn() } } };
    const handler = vi.fn();
    const off = useShellBridge().on("qqplayer:nativelibrary", handler);

    window.dispatchEvent(new CustomEvent("qqplayer:nativelibrary", { detail: { path: "/x" } }));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({ path: "/x" });

    off();
    window.dispatchEvent(new CustomEvent("qqplayer:nativelibrary", { detail: { path: "/x" } }));
    expect(handler).toHaveBeenCalledTimes(1); // 解绑后不再触发
  });

  it("tauri → listen('library-changed') 并转发 window CustomEvent('qqplayer:nativelibrary')", async () => {
    window.__TAURI_INTERNALS__ = {};
    const unlisten = vi.fn();
    const tauriCb: { current: ((payload: unknown) => void) | null } = { current: null };
    window.__TAURI__ = {
      core: { invoke: vi.fn() },
      event: {
        listen: vi.fn(async (evt, cb) => {
          expect(evt).toBe("library-changed");
          tauriCb.current = cb;
          return unlisten;
        }),
      },
    };

    const handler = vi.fn();
    const off = useShellBridge().on("qqplayer:nativelibrary", handler);

    // 壳 emit 'library-changed' → 前端收到 CustomEvent('qqplayer:nativelibrary', { detail: payload })
    const spy = vi.fn();
    window.addEventListener("qqplayer:nativelibrary", spy);
    tauriCb.current!({ payload: { path: "/music" } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].detail).toEqual({ path: "/music" });
    // handler 同步收到同一 CustomEvent
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({ path: "/music" });

    // 解绑：等 listen 的 Promise 解析出 unlisten 后调用
    await Promise.resolve();
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("tauri → listen('dict-files') 并转发 window CustomEvent('qqplayer:nativeDictFiles')", async () => {
    window.__TAURI_INTERNALS__ = {};
    const tauriCb: { current: ((payload: unknown) => void) | null } = { current: null };
    window.__TAURI__ = {
      core: { invoke: vi.fn() },
      event: {
        listen: vi.fn(async (evt, cb) => {
          expect(evt).toBe("dict-files");
          tauriCb.current = cb;
          return vi.fn();
        }),
      },
    };
    useShellBridge().on("qqplayer:nativeDictFiles", vi.fn());

    const spy = vi.fn();
    window.addEventListener("qqplayer:nativeDictFiles", spy);
    tauriCb.current!({ payload: { paths: ["/a.dict"] } });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].detail).toEqual({ paths: ["/a.dict"] });
  });

  it("tauri listen 拒绝 → 不抛，解绑 noop", async () => {
    window.__TAURI_INTERNALS__ = {};
    window.__TAURI__ = {
      core: { invoke: vi.fn() },
      event: { listen: vi.fn(async () => Promise.reject(new Error("no event"))) },
    };
    const off = useShellBridge().on("qqplayer:nativelibrary", vi.fn());
    await Promise.resolve();
    expect(() => off()).not.toThrow();
  });

  it("null → 返回 noop 解绑函数，不挂监听", () => {
    const handler = vi.fn();
    const off = useShellBridge().on("qqplayer:nativelibrary", handler);
    expect(() => off()).not.toThrow();
    window.dispatchEvent(new CustomEvent("qqplayer:nativelibrary", { detail: {} }));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("模块级单例", () => {
  it("useShellBridge() 多次调用返回同一实例", () => {
    expect(useShellBridge()).toBe(useShellBridge());
  });
});
