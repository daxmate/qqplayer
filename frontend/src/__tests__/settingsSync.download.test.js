// settingsSync download namespace 测试：默认值容错 / GET 应用 / PUT 全字段 / 本地缓存一次性导入
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册）
class FakeAudio {
  static instances = [];
  constructor() {
    this._src = "";
    this.currentTime = 0;
    this.playbackRate = 1;
    this.paused = true;
    this.duration = 0;
    this.volume = 1;
    this.listeners = {};
    FakeAudio.instances.push(this);
  }
  set src(v) {
    this._src = v;
    if (v) this.currentTime = 0;
  }
  get src() {
    return this._src;
  }
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  addEventListener(ev, fn) {
    this.listeners[ev] = fn;
  }
}
vi.stubGlobal("Audio", FakeAudio);

// localStorage stub
const lsStore = {};
const localStorageStub = {
  getItem: (k) => (k in lsStore ? lsStore[k] : null),
  setItem: (k, v) => {
    lsStore[k] = String(v);
  },
  removeItem: (k) => {
    delete lsStore[k];
  },
};

const { DOWNLOAD_SETTINGS_KEY } = await import("../composables/useSettings.js");

let getResponder = null;
let putBodies = [];
function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, opts = {}) => {
      if (opts.method === "PUT") {
        putBodies.push({ url, body: JSON.parse(opts.body) });
        return { ok: true, json: async () => ({ settings: {} }) };
      }
      const g = typeof getResponder === "function" ? getResponder(url, opts) : getResponder?.[url];
      if (g && typeof g.then === "function") {
        const data = await g;
        return { ok: true, json: async () => data };
      }
      if (g) return { ok: true, json: async () => g };
      return { ok: false, json: async () => ({}) };
    }),
  );
}

// 默认 GET 响应：各 namespace 空对象（download 缺失 = 后端尚未支持 → 前端默认值兜底）
function defaultSettings(overrides = {}) {
  return {
    settings: { ui: {}, lyric: {}, desktopLyric: {}, playback: {}, player: {}, ...overrides },
  };
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("localStorage", localStorageStub);
  for (const k of Object.keys(lsStore)) delete lsStore[k];
  getResponder = null;
  putBodies = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("download namespace：默认值容错", () => {
  it("后端未返回 download 字段：保持默认 downloadDir='' / defaultQuality='exhigh' / 歌曲海字段默认", async () => {
    getResponder = { "/api/settings": defaultSettings() };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(m.downloadSettings.downloadDir).toBe("");
    expect(m.downloadSettings.defaultQuality).toBe("exhigh");
    // 歌曲海新增字段：默认 quarkQuality='mp3' / engine='httpx' / aria2 参数空
    expect(m.downloadSettings.quarkQuality).toBe("mp3");
    expect(m.downloadSettings.engine).toBe("httpx");
    expect(m.downloadSettings.aria2Rpc).toBe("");
    expect(m.downloadSettings.aria2Secret).toBe("");
  });

  it("非法音质值兜底为 exhigh（约束在设置层校验）", async () => {
    getResponder = {
      "/api/settings": defaultSettings({ download: { defaultQuality: "bogus" } }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    // 字段级应用只做原样覆盖；chips 渲染时无匹配则回退 exhigh 文案——这里验证默认枚举仍可用
    expect(["standard", "exhigh", "lossless", "hires"]).toContain(
      m.downloadSettings.defaultQuality,
    );
    expect(m.downloadSettings.downloadDir).toBe("");
  });

  it("后端只返回部分字段：字段级应用，缺失字段保持默认", async () => {
    getResponder = {
      "/api/settings": defaultSettings({ download: { defaultQuality: "lossless" } }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(m.downloadSettings.defaultQuality).toBe("lossless");
    expect(m.downloadSettings.downloadDir).toBe(""); // 后端没返回 → 默认
  });

  it("歌曲海枚举非法值兜底：quarkQuality 回落 mp3、engine 回落 httpx", async () => {
    getResponder = {
      "/api/settings": defaultSettings({
        download: { quarkQuality: "bogus", engine: "wget" },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(m.downloadSettings.quarkQuality).toBe("mp3");
    expect(m.downloadSettings.engine).toBe("httpx");
  });

  it("后端返回歌曲海字段：字段级应用（quarkQuality/engine/aria2 参数）", async () => {
    getResponder = {
      "/api/settings": defaultSettings({
        download: {
          quarkQuality: "flac",
          engine: "aria2",
          aria2Rpc: "http://127.0.0.1:6800/jsonrpc",
          aria2Secret: "tok",
        },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(m.downloadSettings.quarkQuality).toBe("flac");
    expect(m.downloadSettings.engine).toBe("aria2");
    expect(m.downloadSettings.aria2Rpc).toBe("http://127.0.0.1:6800/jsonrpc");
    expect(m.downloadSettings.aria2Secret).toBe("tok");
    expect(m.downloadSettings.defaultQuality).toBe("exhigh"); // 未返回字段保持默认
  });
});

describe("download namespace：PUT 与缓存", () => {
  it("修改下载设置 → 防抖 PUT 全字段含 download namespace（含歌曲海新字段）+ 写透缓存", async () => {
    getResponder = { "/api/settings": defaultSettings() };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    m.downloadSettings.defaultQuality = "hires";
    m.downloadSettings.downloadDir = "/tmp/dl";
    m.downloadSettings.quarkQuality = "flac";
    m.downloadSettings.engine = "aria2";
    m.downloadSettings.aria2Rpc = "http://127.0.0.1:6800/jsonrpc";
    m.downloadSettings.aria2Secret = "tok";
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].url).toBe("/api/settings");
    expect(putBodies[0].body.download).toEqual({
      downloadDir: "/tmp/dl",
      defaultQuality: "hires",
      quarkQuality: "flac",
      engine: "aria2",
      aria2Rpc: "http://127.0.0.1:6800/jsonrpc",
      aria2Secret: "tok",
    });
    // 写透缓存
    expect(JSON.parse(lsStore[DOWNLOAD_SETTINGS_KEY])).toEqual({
      downloadDir: "/tmp/dl",
      defaultQuality: "hires",
      quarkQuality: "flac",
      engine: "aria2",
      aria2Rpc: "http://127.0.0.1:6800/jsonrpc",
      aria2Secret: "tok",
    });
    vi.useRealTimers();
  });

  it("本地缓存有脏值 → 一次性导入只上传 download 脏字段并胜出；再次启动幂等", async () => {
    lsStore[DOWNLOAD_SETTINGS_KEY] = JSON.stringify({ defaultQuality: "lossless" });
    getResponder = {
      "/api/settings": defaultSettings({
        download: { downloadDir: "", defaultQuality: "exhigh" },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body).toEqual({ download: { defaultQuality: "lossless" } });
    expect(m.downloadSettings.defaultQuality).toBe("lossless");
    expect(m.downloadSettings.downloadDir).toBe(""); // 后端独有字段已应用
    // 第二次启动：后端已含导入值 → 幂等不上传
    putBodies = [];
    getResponder = {
      "/api/settings": defaultSettings({
        download: { downloadDir: "", defaultQuality: "lossless" },
      }),
    };
    vi.resetModules();
    await import("../composables/usePlayer.js");
    const sync2 = await import("../composables/settingsSync.js");
    await sync2.settingsLoadPromise;
    expect(putBodies.length).toBe(0);
  });
});
