// nativeAudioBridge 适配层测试：iOS 原生播放桥（window.qqplayerIosBridge 存在时启用）
// - 桌面浏览器（无桥）：isNativePlayback() false，全部函数空转/不安装
// - 有桥：Audio 代理语义（src/play/pause/seek/volume/rate）+ 事件派发 + 相对路径解析
//   + 远端命令路由 + 401 通知
//
// 注意：nativeAudioBridge 有模块级状态（proxy 单例/listeners/事件入口），且模块加载时
// 就按「当时是否有桥」决定是否安装事件入口 → 每个用例用 vi.resetModules() + 动态
// import 拿全新实例（原 .js 版用 ?t= query 作缓存破坏，TS 化后 query 会骗过 oxc 的
// 扩展名检测把 .ts 当 JS 解析，故改用 resetModules，语义等价），全程只用该实例的
// 导出（不混静态导入），保证状态隔离。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

type BridgeModule = typeof import("../composables/nativeAudioBridge.ts");

/** 代理发往原生桥的消息形状（测试断言只读 cmd + 各命令字段；index signature 兜其余） */
type BridgePost = { cmd: string; [key: string]: unknown };

/** 拿全新模块实例（重置模块注册表后动态导入） */
async function freshBridge(): Promise<BridgeModule> {
  vi.resetModules();
  return import("../composables/nativeAudioBridge.ts");
}

// localStorage stub（与既有测试同款：Node 实验性 localStorage 在无 --localstorage-file 时不可用）
const lsStore: Record<string, string> = {};
const localStorageStub = {
  getItem: (k: string) => (k in lsStore ? lsStore[k] : null),
  setItem: (k: string, v: string) => {
    lsStore[k] = String(v);
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};

function resetLS() {
  for (const k of Object.keys(lsStore)) delete lsStore[k];
}

describe("nativeAudioBridge 桌面环境（无 qqplayerIosBridge）", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", localStorageStub);
    delete window.qqplayerIosBridge;
    delete window.qqplayerOnNativeEvent;
    resetLS();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isNativePlayback() 为 false，不安装事件入口", async () => {
    const m = await freshBridge();
    expect(m.isNativePlayback()).toBe(false);
    expect(window.qqplayerOnNativeEvent).toBeUndefined();
  });

  it("resolveNativeUrl 无服务器 base 时原样返回相对路径", async () => {
    const m = await freshBridge();
    expect(m.resolveNativeUrl("/api/cover?path=x")).toBe("/api/cover?path=x");
  });

  it("resolveNativeUrl 无服务器 base 时有 token 也不附加", async () => {
    localStorage.setItem("qqplayer.token", "tok-desk");
    const m = await freshBridge();
    expect(m.resolveNativeUrl("/api/cover?path=x")).toBe("/api/cover?path=x");
  });
});

describe("nativeAudioBridge iOS 原生环境（有 qqplayerIosBridge）", () => {
  let posts: BridgePost[];
  let m: BridgeModule;

  beforeEach(async () => {
    vi.stubGlobal("localStorage", localStorageStub);
    posts = [];
    localStorage.setItem("qqplayer.server", "http://192.168.1.50:17627");
    window.qqplayerIosBridge = {
      // mock 边界单点收窄：原生桥实参是任意 unknown，测试侧按消息形状记录
      postMessage: (msg: unknown) => posts.push(msg as BridgePost),
    };
    m = await freshBridge();
  });

  afterEach(() => {
    delete window.qqplayerIosBridge;
    delete window.qqplayerOnNativeEvent;
    resetLS();
    vi.unstubAllGlobals();
  });

  it("isNativePlayback() 为 true", () => {
    expect(m.isNativePlayback()).toBe(true);
  });

  it("resolveNativeUrl：相对 /api 路径 → 服务器绝对 URL", () => {
    expect(m.resolveNativeUrl("/api/audio?path=%2Fm.mp3")).toBe(
      "http://192.168.1.50:17627/api/audio?path=%2Fm.mp3",
    );
  });

  it("resolveNativeUrl：stream/proxy 解出上游直链（AVPlayer 免代理）", () => {
    const enc = encodeURIComponent("http://m.example.com/a.mp3");
    expect(m.resolveNativeUrl(`/api/stream/proxy?url=${enc}`)).toBe("http://m.example.com/a.mp3");
  });

  it("resolveNativeUrl：绝对 URL 原样", () => {
    expect(m.resolveNativeUrl("https://x.com/a.mp3")).toBe("https://x.com/a.mp3");
  });

  it("resolveNativeUrl：有 token 时相对路径附加 token（已有 query 用 &）", async () => {
    localStorage.setItem("qqplayer.token", "tok-123");
    const m2 = await freshBridge();
    expect(m2.resolveNativeUrl("/api/cover?path=%2Fm.mp3")).toBe(
      "http://192.168.1.50:17627/api/cover?path=%2Fm.mp3&token=tok-123",
    );
    // 无 query 的相对路径 → 用 ?
    expect(m2.resolveNativeUrl("/api/audio")).toBe(
      "http://192.168.1.50:17627/api/audio?token=tok-123",
    );
  });

  it("resolveNativeUrl：有 token 时绝对 URL / 上游直链不加 token", async () => {
    localStorage.setItem("qqplayer.token", "tok-123");
    const m2 = await freshBridge();
    expect(m2.resolveNativeUrl("https://x.com/a.mp3")).toBe("https://x.com/a.mp3");
    const enc = encodeURIComponent("http://m.example.com/a.mp3");
    expect(m2.resolveNativeUrl(`/api/stream/proxy?url=${enc}`)).toBe("http://m.example.com/a.mp3");
  });

  it("authToken 兑底：localStorage 无 token 时读桥对象 token", async () => {
    window.qqplayerIosBridge = {
      postMessage: (msg: unknown) => posts.push(msg as BridgePost),
      server: "http://192.168.1.50:17627",
      token: "bridge-tok",
    };
    const m2 = await freshBridge();
    expect(m2.resolveNativeUrl("/api/cover")).toBe(
      "http://192.168.1.50:17627/api/cover?token=bridge-tok",
    );
  });

  it("代理 src 赋值 → 发 load 命令（已解析绝对 URL）", () => {
    const p = m.createNativeAudioProxy();
    p.src = "/api/audio?path=%2Fm.mp3";
    expect(posts).toEqual([
      { cmd: "load", url: "http://192.168.1.50:17627/api/audio?path=%2Fm.mp3" },
    ]);
  });

  it("代理换 src（新歌 load）→ 进度/时长/ended 镜像清零（残留进度不污染新歌）", () => {
    const p = m.createNativeAudioProxy();
    // 上一首歌播到 230s / duration 240（原生 timeupdate 镜像）
    window.qqplayerOnNativeEvent!("timeupdate", { t: 230, duration: 240 });
    expect(p.currentTime).toBe(230);
    // 切新歌：换源镜像必须归零，否则 maybePrefetchAsset 切本地时捕获残留进度 →
    // 新歌从接近尾部开始 / 越界被 clamp 到尾部立即 ended（2026-08-25 播放 bug 根因）
    p.src = "/api/audio?path=%2Fnew.mp3";
    expect(p.currentTime).toBe(0);
    expect(p.duration).toBe(0);
    expect(p.ended).toBe(false);
  });

  it("代理 play/pause/seek/volume/rate → 对应命令", () => {
    const p = m.createNativeAudioProxy();
    p.play();
    p.pause();
    p.currentTime = 12.5;
    p.volume = 0.7;
    p.playbackRate = 1.25;
    expect(posts).toEqual([
      { cmd: "play" },
      { cmd: "pause" },
      { cmd: "seek", t: 12.5 },
      { cmd: "setVolume", v: 0.7 },
      { cmd: "setRate", r: 1.25 },
    ]);
  });

  it("代理 getter：paused/duration/currentTime 读原生状态镜像", () => {
    const p = m.createNativeAudioProxy();
    expect(p.paused).toBe(true);
    // 原生推 playing + timeupdate（模块加载时已装事件入口）
    window.qqplayerOnNativeEvent!("playing", { t: 1 });
    window.qqplayerOnNativeEvent!("timeupdate", { t: 30, duration: 210 });
    expect(p.paused).toBe(false);
    expect(p.duration).toBe(210);
    expect(p.currentTime).toBe(30);
  });

  it("事件派发：timeupdate/playing/ended 触发对应 DOM 事件", () => {
    const p = m.createNativeAudioProxy();
    const events: string[] = [];
    for (const type of ["timeupdate", "play", "pause", "ended", "loadedmetadata"]) {
      p.addEventListener(type, (e) => events.push(e.type));
    }
    window.qqplayerOnNativeEvent!("timeupdate", { t: 5, duration: 100 });
    window.qqplayerOnNativeEvent!("playing", { t: 5 });
    window.qqplayerOnNativeEvent!("paused", { t: 6 });
    window.qqplayerOnNativeEvent!("ended", {});
    expect(events).toEqual(["loadedmetadata", "timeupdate", "play", "pause", "ended"]);
  });

  it("addEventListener once:true：触发一次后自移除（不再响应后续事件）", () => {
    const p = m.createNativeAudioProxy();
    const fn = vi.fn();
    p.addEventListener("loadedmetadata", fn, { once: true });
    window.qqplayerOnNativeEvent!("loadedmetadata", { duration: 100 });
    window.qqplayerOnNativeEvent!("loadedmetadata", { duration: 100 });
    expect(fn).toHaveBeenCalledTimes(1); // once 语义：第二次不触发
  });

  it("addEventListener once:true + removeEventListener(原始 fn)：映射移除生效", () => {
    const p = m.createNativeAudioProxy();
    const fn = vi.fn();
    p.addEventListener("loadedmetadata", fn, { once: true });
    p.removeEventListener("loadedmetadata", fn); // 传原始引用（非包装引用）也能移除
    window.qqplayerOnNativeEvent!("loadedmetadata", { duration: 100 });
    expect(fn).not.toHaveBeenCalled();
  });

  it("addEventListener 不带 once：多次触发多次调用（常规监听不受影响）", () => {
    const p = m.createNativeAudioProxy();
    const fn = vi.fn();
    p.addEventListener("loadedmetadata", fn);
    window.qqplayerOnNativeEvent!("loadedmetadata", { duration: 100 });
    window.qqplayerOnNativeEvent!("loadedmetadata", { duration: 100 });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("远端命令：registerRemoteCommandHandler 收到 play/pause/next/prev/seekto/toggle", () => {
    const calls: Array<[string, number | undefined]> = [];
    m.registerRemoteCommandHandler((cmd, t) => calls.push([cmd, t]));
    window.qqplayerOnNativeEvent!("remoteCommand", { cmd: "play" });
    window.qqplayerOnNativeEvent!("remoteCommand", { cmd: "pause" });
    window.qqplayerOnNativeEvent!("remoteCommand", { cmd: "next" });
    window.qqplayerOnNativeEvent!("remoteCommand", { cmd: "prev" });
    window.qqplayerOnNativeEvent!("remoteCommand", { cmd: "seekto", t: 42 });
    window.qqplayerOnNativeEvent!("remoteCommand", { cmd: "toggle" });
    expect(calls).toEqual([
      ["play", undefined],
      ["pause", undefined],
      ["next", undefined],
      ["prev", undefined],
      ["seekto", 42],
      ["toggle", undefined],
    ]);
  });

  it("songChanged：registerNativeSongChangedHandler 收到 index（原生后台切歌跟随）", () => {
    const calls: number[] = [];
    m.registerNativeSongChangedHandler((index) => calls.push(index));
    window.qqplayerOnNativeEvent!("songChanged", { index: 3 });
    expect(calls).toEqual([3]);
    // 非法 index（缺省/负数）不回调
    window.qqplayerOnNativeEvent!("songChanged", {});
    window.qqplayerOnNativeEvent!("songChanged", { index: -1 });
    expect(calls).toEqual([3]);
  });

  it("nativeSendMetadata：本地歌 → coverUrl 解析为服务器绝对 URL", () => {
    m.nativeSendMetadata({ name: "歌", artist: "艺人", album: "专", path: "/m/a.mp3" });
    const msg = posts.find((p) => p.cmd === "setMetadata")!; // 断言存在：测试语义要求已发 setMetadata
    expect(msg.title).toBe("歌");
    expect(msg.artist).toBe("艺人");
    expect(msg.coverUrl).toBe("http://192.168.1.50:17627/api/cover?path=%2Fm%2Fa.mp3");
  });

  it("nativeSendMetadata：本地歌封面 URL 附加 token（真机锁屏鉴权）", async () => {
    localStorage.setItem("qqplayer.token", "tok-abc");
    const m2 = await freshBridge();
    m2.nativeSendMetadata({ name: "歌", artist: "艺人", album: "专", path: "/m/a.mp3" });
    const msg = posts.find((p) => p.cmd === "setMetadata")!; // 断言存在：测试语义要求已发 setMetadata
    expect(msg.coverUrl).toBe(
      "http://192.168.1.50:17627/api/cover?path=%2Fm%2Fa.mp3&token=tok-abc",
    );
  });

  it("nativeSendMetadata：流媒体歌用网络封面 URL 原样", () => {
    m.nativeSendMetadata({ name: "s", coverUrl: "https://img.example.com/c.jpg" });
    const msg = posts.find((p) => p.cmd === "setMetadata")!; // 断言存在：测试语义要求已发 setMetadata
    expect(msg.coverUrl).toBe("https://img.example.com/c.jpg");
  });

  it("nativeSendMetadata：coverOverride 优先——本地缓存 URL 不解析远程（CarPlay 封面修复）", () => {
    const local = "http://127.0.0.1:17888/native-assets/audio/abc.m4a";
    m.nativeSendMetadata({ name: "歌", path: "/m/a.mp3" }, local);
    const msg = posts.find((p) => p.cmd === "setMetadata")!; // 断言存在：测试语义要求已发 setMetadata
    expect(msg.coverUrl).toBe(local); // 直接透传，不走 /api/cover 远程兜底
  });

  it("nativeSendMetadata：coverOverride 传空串时回退 song.coverUrl / 远程兜底（兼容老调用）", () => {
    m.nativeSendMetadata({ name: "s", coverUrl: "https://img.example.com/c.jpg" }, "");
    expect(posts.filter((p) => p.cmd === "setMetadata").at(-1)!.coverUrl).toBe(
      "https://img.example.com/c.jpg",
    );
    m.nativeSendMetadata({ name: "s", path: "/m/b.mp3" }, "");
    expect(posts.filter((p) => p.cmd === "setMetadata").at(-1)!.coverUrl).toBe(
      "http://192.168.1.50:17627/api/cover?path=%2Fm%2Fb.mp3",
    );
  });
});
