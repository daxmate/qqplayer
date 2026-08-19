// 统一 Settings 层（settingsSync.js + playerCore 桥）单元测试
// 覆盖：GET 字段级分发 / 防抖合并 PUT 全 namespace / loaded 防回写 / 一次性导入（脏字段上传 + 幂等）/
// rememberVolume·resumeLast 开关过滤 / 旧端点双写已删 / useSleepTimer 与 restoreLastPlayed 走统一层
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";

// Audio stub（jsdom 无 Audio 实现，必须在 import 前注册；与 usePlayer.test.js 同款）
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

// 设置 key 常量（模块体里动态导入——静态 import 会被提升到 Audio stub 注册之前，导致 playerCore 求值失败）
const {
  UI_SETTINGS_KEY,
  LYRIC_SETTINGS_KEY,
  PLAYBACK_SETTINGS_KEY,
  VOLUME_KEY,
  PANEL_KEY,
  CONTROLS_KEY,
  LAST_PLAYED_KEY,
  MODE_KEY,
} = await import("../composables/usePlayer.js");

// fetch stub：GET 走 getResponder（对象路由或函数；值可为 Promise），PUT 记录到 putBodies
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

// 默认 GET 响应：所有 namespace 空对象（后端"已合并默认值"由前端缺省兜底）
function defaultSettings(overrides = {}) {
  return {
    settings: { ui: {}, lyric: {}, desktopLyric: {}, playback: {}, player: {}, ...overrides },
  };
}

beforeEach(() => {
  vi.stubGlobal("Audio", FakeAudio); // afterEach 的 unstubAllGlobals 会还原 Audio，必须每个测试重新 stub
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

describe("统一 Settings 层：GET 分发（load）", () => {
  it("GET 返回后字段级覆盖各 namespace（k in saved：后端没返回的字段保持现状）", async () => {
    getResponder = {
      "/api/settings": defaultSettings({
        ui: { theme: "dark", accent: "blue" },
        lyric: { fontSize: 24 },
        desktopLyric: { enabled: true, fontSize: 32 },
        playback: { fadeSec: 2, playMode: "shuffle" },
        player: {
          volume: 0.6,
          panel: false,
          controls: true,
          lastPlayed: { path: "/a.mp3", position: 12, ts: 9 },
        },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(m.uiSettings.theme).toBe("dark");
    expect(m.uiSettings.accent).toBe("blue");
    expect(m.lyricSettings.fontSize).toBe(24);
    expect(m.lyricSettings.showRoma).toBe(true); // 后端没返回 → 保持默认
    expect(m.desktopLyricSettings.enabled).toBe(true);
    expect(m.desktopLyricSettings.fontSize).toBe(32);
    expect(m.playbackSettings.fadeSec).toBe(2);
    expect(m.playbackSettings.playMode).toBe("shuffle");
    expect(m.state.playMode).toBe("shuffle"); // 播放模式随设置恢复（现有 sync watch）
    // player namespace
    expect(m.state.volume).toBe(0.6);
    expect(m.state.musicLibOpen).toBe(false);
    expect(m.state.controlsHidden).toBe(true);
    expect(m.lastPlayedState.path).toBe("/a.mp3");
    expect(m.lastPlayedState.position).toBe(12);
  });

  it("启动：同步读 localStorage 先生效（首屏不闪变），GET 后服务端字段覆盖、缓存写透", async () => {
    lsStore[UI_SETTINGS_KEY] = JSON.stringify({ theme: "light" });
    getResponder = {
      "/api/settings": defaultSettings({
        ui: { theme: "light", accent: "purple" }, // theme 与缓存一致 → 不脏
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    // 同步缓存已生效（首屏不闪变）
    expect(m.uiSettings.theme).toBe("light");
    await sync.settingsLoadPromise;
    expect(m.uiSettings.theme).toBe("light");
    expect(m.uiSettings.accent).toBe("purple"); // 服务端独有字段应用
    // 写透缓存：localStorage 已同步为最终值
    expect(JSON.parse(lsStore[UI_SETTINGS_KEY]).accent).toBe("purple");
  });

  it("mode：启动缓存首帧即恢复（不闪变），与后端一致时无脏冲突不误上传", async () => {
    lsStore[MODE_KEY] = "karaoke"; // 上次停在跟唱
    getResponder = {
      "/api/settings": defaultSettings({ player: { mode: "karaoke" } }), // 与缓存一致
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    expect(m.state.mode).toBe("karaoke"); // 首帧即恢复（同步读缓存种子）
    await sync.settingsLoadPromise;
    expect(m.state.mode).toBe("karaoke");
    expect(putBodies.length).toBe(0); // 无脏字段：不误上传
  });

  it("GET 返回 player.mode：无本地缓存时应用后端值（后端为真源）并写透缓存", async () => {
    let resolveGet;
    getResponder = {
      "/api/settings": new Promise((res) => {
        resolveGet = res;
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    expect(m.state.mode).toBe("continuous"); // 无缓存：默认连播（GET 返回前）
    resolveGet(defaultSettings({ player: { mode: "books" } }));
    await sync.settingsLoadPromise;
    expect(m.state.mode).toBe("books"); // 后端为真源：应用
    expect(lsStore[MODE_KEY]).toBe("books"); // 写透缓存
  });

  it("mode 启动缓存非法值回落 continuous", async () => {
    lsStore[MODE_KEY] = "hack";
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    expect(m.state.mode).toBe("continuous"); // 非法缓存被忽略
  });

  it("GET 失败：降级纯缓存模式（loaded 置真，后续变化照常 PUT 重试）", async () => {
    stubFetch(); // GET 返回 ok:false
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    m.uiSettings.theme = "light";
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(1); // loaded=true：允许 PUT
    expect(putBodies[0].url).toBe("/api/settings");
    vi.useRealTimers();
  });
});

describe("统一 Settings 层：防抖保存（save）", () => {
  it("修改设置：防抖 300ms 合并为一次 PUT，全 namespace 全字段（player 按开关过滤）", async () => {
    getResponder = {
      "/api/settings": defaultSettings({ playback: { rememberVolume: true, resumeLast: true } }),
    };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    m.uiSettings.theme = "light";
    m.lyricSettings.fontSize = 26;
    m.desktopLyricSettings.enabled = true;
    m.playbackSettings.fadeSec = 1;
    m.setVolume(0.4);
    m.toggleMusicLib();
    m.toggleControls();
    await nextTick();
    await vi.advanceTimersByTimeAsync(299);
    expect(putBodies.length).toBe(0); // 防抖中：未发送
    await vi.advanceTimersByTimeAsync(1);
    expect(putBodies.length).toBe(1); // 连续修改合并为一次
    const body = putBodies[0].body;
    expect(body.ui.theme).toBe("light");
    expect(body.lyric.fontSize).toBe(26);
    expect(body.desktopLyric.enabled).toBe(true);
    expect(body.playback.fadeSec).toBe(1);
    expect(body.player).toEqual({
      volume: 0.4,
      panel: false,
      controls: true,
      mode: "continuous",
    });
    // 写透缓存（同步）
    expect(JSON.parse(lsStore[UI_SETTINGS_KEY]).theme).toBe("light");
    expect(lsStore[VOLUME_KEY]).toBe("0.4");
    expect(JSON.parse(lsStore[PANEL_KEY]).musicLib).toBe(false);
    expect(lsStore[CONTROLS_KEY]).toBe("1");
    vi.useRealTimers();
  });

  it("loaded 防回写：GET 返回前修改不 PUT；GET 完成后正常 PUT（窗口内修改经导入保留）", async () => {
    let resolveGet;
    getResponder = {
      "/api/settings": new Promise((res) => {
        resolveGet = res;
      }),
    };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    // GET 仍在途：修改设置
    m.uiSettings.theme = "light";
    await nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(putBodies.length).toBe(0); // loaded=false：不 PUT（防止拉取结果触发回写覆盖后端）
    // GET 返回（后端 theme=dark，与窗口内修改冲突）
    resolveGet(defaultSettings({ ui: { theme: "dark" } }));
    await sync.settingsLoadPromise;
    // 窗口内修改视为"用户改过的旧数据"：一次性导入只上传脏字段并胜出
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body).toEqual({ ui: { theme: "light" } });
    expect(m.uiSettings.theme).toBe("light");
    vi.clearAllTimers();
    // 之后修改 → 正常防抖 PUT
    m.uiSettings.theme = "dark";
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(2);
    expect(putBodies[1].body.ui.theme).toBe("dark");
    vi.useRealTimers();
  });

  it("mode 变化：防抖 PUT 载荷含 player.mode，localStorage 缓存写透", async () => {
    getResponder = { "/api/settings": defaultSettings() };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    m.state.mode = "books"; // 切到阅读（App.vue switchMode / 快捷键任何赋值路径都被 watch 兜住）
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body.player.mode).toBe("books");
    expect(lsStore[MODE_KEY]).toBe("books"); // 写透缓存
    vi.useRealTimers();
  });

  it("player 状态变化（音量/面板/控制/上次播放）走统一层 PUT player namespace", async () => {
    getResponder = {
      "/api/settings": defaultSettings({
        playback: { resumeLast: true },
        player: { lastPlayed: { path: "/a.mp3", position: 12, ts: 1 } },
      }),
    };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    m.setVolume(0.3);
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body.player.volume).toBe(0.3);
    // saveLastPlayed → PUT lastPlayed
    m.state.currentSong = { path: "/b.mp3", name: "B" };
    const a = m.audio; // 当前活动元素（双元素：instances[last] 是裸元素）
    a._src = "/api/audio?path=/b.mp3";
    a.currentTime = 30;
    m.saveLastPlayed();
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(2);
    expect(putBodies[1].body.player.lastPlayed).toMatchObject({ path: "/b.mp3", position: 30 });
    // 写透缓存
    expect(JSON.parse(lsStore[LAST_PLAYED_KEY]).path).toBe("/b.mp3");
    vi.useRealTimers();
  });
});

describe("统一 Settings 层：一次性导入（字段级 diff）", () => {
  it("本地有脏值 → 只上传脏字段；上传成功后本地值胜出并写透；再次启动幂等不再上传", async () => {
    // 本地缓存：lyric 两字段与后端不同（脏）；ui 与后端一致（不脏）
    lsStore[LYRIC_SETTINGS_KEY] = JSON.stringify({ fontSize: 26, align: "center" });
    lsStore[UI_SETTINGS_KEY] = JSON.stringify({ theme: "dark", accent: "orange" });
    getResponder = {
      "/api/settings": defaultSettings({
        ui: { theme: "dark", accent: "orange" },
        lyric: { fontSize: 20, align: "left", showRoma: true },
      }),
    };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body).toEqual({ lyric: { fontSize: 26, align: "center" } }); // 只传脏字段
    // 上传成功 → 脏值落回 reactive（本地旧数据胜出）
    expect(m.lyricSettings.fontSize).toBe(26);
    expect(m.lyricSettings.align).toBe("center");
    expect(m.lyricSettings.showRoma).toBe(true); // 后端独有字段已应用
    // 缓存写透为最终值
    expect(JSON.parse(lsStore[LYRIC_SETTINGS_KEY]).fontSize).toBe(26);
    vi.clearAllTimers();
    // —— 第二次启动：后端已含导入值 → 无脏字段 → 不再上传（幂等）——
    putBodies = [];
    getResponder = {
      "/api/settings": defaultSettings({
        ui: { theme: "dark", accent: "orange" },
        lyric: { fontSize: 26, align: "center", showRoma: true },
      }),
    };
    vi.resetModules();
    await import("../composables/usePlayer.js");
    const sync2 = await import("../composables/settingsSync.js");
    await sync2.settingsLoadPromise;
    vi.clearAllTimers();
    expect(putBodies.length).toBe(0); // 幂等：不再上传
    vi.useRealTimers();
  });

  it("player 脏数据导入：volume/panel/controls 按开关上传并胜出", async () => {
    lsStore[VOLUME_KEY] = "0.5";
    lsStore[PANEL_KEY] = JSON.stringify({ musicLib: false, playlist: true });
    lsStore[CONTROLS_KEY] = "1";
    getResponder = {
      "/api/settings": defaultSettings({
        playback: { rememberVolume: true },
        player: { volume: 1.0, panel: true, controls: false, lastPlayed: null },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body).toEqual({ player: { volume: 0.5, panel: false, controls: true } });
    expect(m.state.volume).toBe(0.5);
    expect(m.state.musicLibOpen).toBe(false);
    expect(m.state.controlsHidden).toBe(true);
  });

  it("mode 脏数据导入：本地缓存合法且 ≠ 后端 → 上传并胜出；后端未返回 mode 不参与", async () => {
    lsStore[MODE_KEY] = "books"; // 本地旧缓存：上次停在阅读
    getResponder = {
      "/api/settings": defaultSettings({ player: { mode: "continuous" } }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body).toEqual({ player: { mode: "books" } }); // 只传脏字段
    expect(m.state.mode).toBe("books"); // 本地旧数据胜出
    expect(lsStore[MODE_KEY]).toBe("books"); // 写透缓存
    // 老后端兼容：后端没返回 mode → 不参与 diff（不上传）
    putBodies = [];
    getResponder = { "/api/settings": defaultSettings() }; // player 为空对象
    vi.resetModules();
    await import("../composables/usePlayer.js");
    const sync2 = await import("../composables/settingsSync.js");
    await sync2.settingsLoadPromise;
    expect(putBodies.length).toBe(0);
  });

  it("开关过滤导入：rememberVolume=false 不上传 volume；resumeLast=false 不上传 lastPlayed", async () => {
    lsStore[VOLUME_KEY] = "0.5";
    lsStore[LAST_PLAYED_KEY] = JSON.stringify({ path: "/a.mp3", position: 10, ts: 1 });
    getResponder = {
      "/api/settings": defaultSettings({
        playback: { rememberVolume: false, resumeLast: false },
        player: { volume: 1.0, panel: true, controls: false, lastPlayed: null },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    expect(putBodies.length).toBe(0); // 开关过滤后无脏字段：不上传
    expect(m.state.volume).toBe(1.0); // rememberVolume=false：忽略后端 volume（保持默认）
  });
});

describe("统一 Settings 层：开关语义", () => {
  it("rememberVolume=false / resumeLast=false：PUT player 不含 volume/lastPlayed；GET 忽略后端 volume", async () => {
    getResponder = {
      "/api/settings": defaultSettings({
        playback: { rememberVolume: false, resumeLast: false },
        player: {
          volume: 0.3,
          panel: false,
          controls: true,
          lastPlayed: { path: "/x.mp3", position: 5, ts: 1 },
        },
      }),
    };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    expect(m.state.volume).toBe(1.0); // rememberVolume=false：启动忽略后端 volume（默认 1.0）
    expect(m.state.musicLibOpen).toBe(false); // panel 不受开关影响
    expect(m.state.controlsHidden).toBe(true);
    expect(m.lastPlayedState.path).toBe("/x.mp3"); // 数据仍应用（恢复动作由 restoreLastPlayed 门控）
    m.setVolume(0.5);
    m.toggleMusicLib();
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body.player).toEqual({ panel: true, controls: true, mode: "continuous" }); // 无 volume/lastPlayed；mode 不受开关影响始终上传
    // 写透缓存同样按开关：不写音量
    expect(lsStore[VOLUME_KEY]).toBeUndefined();
    vi.useRealTimers();
  });
});

describe("统一 Settings 层：旧双写收敛", () => {
  it("theme/miniTheme/desktopLyric 修改只 PUT /api/settings，不再调 /api/ui/settings 与 /api/desktop-lyric/settings", async () => {
    const calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url, opts = {}) => {
        calls.push({
          url,
          method: opts.method || "GET",
          body: opts.body ? JSON.parse(opts.body) : null,
        });
        if (opts.method === "PUT") return { ok: true, json: async () => ({ settings: {} }) };
        return { ok: false, json: async () => ({}) };
      }),
    );
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    vi.clearAllTimers();
    calls.length = 0;
    m.uiSettings.theme = "light";
    m.uiSettings.miniTheme = "dark";
    m.desktopLyricSettings.enabled = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    const putCalls = calls.filter((c) => c.method === "PUT");
    expect(putCalls).toHaveLength(1);
    expect(putCalls[0].url).toBe("/api/settings");
    expect(putCalls[0].body.ui.theme).toBe("light");
    expect(putCalls[0].body.ui.miniTheme).toBe("dark");
    expect(putCalls[0].body.desktopLyric.enabled).toBe(true);
    expect(calls.some((c) => c.url === "/api/ui/settings")).toBe(false);
    expect(calls.some((c) => c.url === "/api/desktop-lyric/settings")).toBe(false);
    vi.useRealTimers();
  });
});

describe("统一 Settings 层：useSleepTimer / restoreLastPlayed 走统一层", () => {
  it("sleepTimer 字段随 playbackSettings 走统一层：缓存恢复 + GET 应用 + PUT 全字段", async () => {
    // 旧版 localStorage 数据（原始串）→ 启动由 loadPlaybackSettings 恢复（不再由 useSleepTimer 直接读）
    lsStore[PLAYBACK_SETTINGS_KEY] = JSON.stringify({ sleepTimerOn: true, sleepTimerMinutes: 45 });
    getResponder = {
      "/api/settings": defaultSettings({
        playback: { sleepTimerOn: true, sleepTimerMinutes: 45, playMode: "shuffle" },
      }),
    };
    stubFetch();
    vi.useFakeTimers();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sleep = await import("../composables/useSleepTimer.js");
    const sync = await import("../composables/settingsSync.js");
    // 同步缓存恢复（useSleepTimer 模块加载时即生效）
    expect(m.playbackSettings.sleepTimerOn).toBe(true);
    expect(m.playbackSettings.sleepTimerMinutes).toBe(45);
    await sync.settingsLoadPromise;
    // GET 应用后端 playback（sleepTimer 字段随 playbackSettings 一并同步）
    expect(m.playbackSettings.playMode).toBe("shuffle");
    expect(m.playbackSettings.sleepTimerOn).toBe(true);
    expect(m.playbackSettings.sleepTimerMinutes).toBe(45);
    vi.clearAllTimers();
    // 写透缓存（全字段含 sleepTimer 字段）
    expect(JSON.parse(lsStore[PLAYBACK_SETTINGS_KEY]).sleepTimerMinutes).toBe(45);
    // 修改 → PUT playback 全字段含 sleepTimer
    m.playbackSettings.sleepTimerMinutes = 90;
    await nextTick();
    await vi.advanceTimersByTimeAsync(350);
    expect(putBodies.length).toBe(1);
    expect(putBodies[0].body.playback.sleepTimerMinutes).toBe(90);
    expect(sleep.sleepTimer.active).toBe(false); // 运行态倒计时不持久化
    vi.useRealTimers();
  });

  it("restoreLastPlayed：数据源为统一层 player.lastPlayed（后端值）", async () => {
    getResponder = {
      "/api/settings": defaultSettings({
        playback: { resumeLast: true },
        player: {
          volume: 1,
          panel: true,
          controls: false,
          lastPlayed: { path: "/b.mp3", position: 42, ts: 1 },
        },
      }),
    };
    stubFetch();
    vi.resetModules();
    const m = await import("../composables/usePlayer.js");
    const sync = await import("../composables/settingsSync.js");
    await sync.settingsLoadPromise;
    m.state.songs = [
      { path: "/a.mp3", name: "A" },
      { path: "/b.mp3", name: "B" },
    ];
    await m.restoreLastPlayed();
    expect(m.state.currentSong.path).toBe("/b.mp3");
    const a = m.audio; // 当前活动元素（双元素：instances[last] 是裸元素）
    a.duration = 100;
    a.listeners["loadedmetadata"]();
    expect(a.currentTime).toBe(42);
  });
});
