// iOS 原生播放桥适配层（阶段2 核心，2026-08-22 定案③）
//
// 职责：window.qqplayerIosBridge（iOS 壳 documentStart 注入）存在时，
// 用「Audio 语义代理」替换 playerCore 的 audio 原语——播放/暂停/seek/音量/变速/
// 元数据全部转发原生 AVPlayer；原生 timeupdate/playing/paused/ended 事件在代理上
// 派发标准 DOM 事件，playerCore 的 bindAudioEvents 逻辑零改动驱动 UI（歌词/进度/统计）。
//
// 关键点：
// - 桌面浏览器 / macOS 壳（无 qqplayerIosBridge）→ isNativePlayback() 恒 false，
//   所有函数空转，行为完全不变
// - 相对路径解析：/api/xxx → 桌面服务器绝对 URL；/api/stream/proxy?url=… →
//   解码出上游直链（AVPlayer 无 CORS 限制，不需要同源代理）
// - 锁屏元数据：currentSong 变化由 playerCore 调 nativeSendMetadata() 推送
// - 401：apiClient onUnauthorized → 通知壳清 Keychain token 回配对页（绝不静默）

import { isOffline, onOfflineChange, onUnauthorized } from "../utils/apiClient.js";

const BRIDGE_KEY = "qqplayerIosBridge";

/** 当前是否存在 iOS 原生播放桥 */
export function isNativePlayback() {
  if (typeof window === "undefined") return false;
  return !!window[BRIDGE_KEY];
}

/** 原生桥对象（不存在返回 null） */
export function nativeBridge() {
  if (typeof window === "undefined") return null;
  return window[BRIDGE_KEY] || null;
}

/** Web → Native 消息（fire-and-forget，失败静默） */
export function nativePost(msg: Record<string, unknown>) {
  const b = nativeBridge();
  if (!b || typeof b.postMessage !== "function") return;
  try {
    b.postMessage(msg);
  } catch {
    /* 静默 */
  }
}

// ---------- 原生状态镜像（事件推送驱动，供代理同步读取） ----------
const nativeState: {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  ended: boolean;
} = {
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  ended: false,
};

// ---------- 通用原生事件订阅（sync 等模块注册，避免各自抢占 qqplayerOnNativeEvent） ----------
// window.qqplayerOnNativeEvent 是全局唯一事件入口（本模块 installNativeEventSink 安装）；
// 播放事件（timeupdate/playing/…）走上面的 listeners，其余事件（syncAssetProgress /
// syncAssetDone / assetStatus / appState 等）经 onNativeEvent 分发给订阅者——
// 订阅方无需关心事件入口的归属，也不会出现多个模块争相覆盖入口的双处理问题。
// 订阅回调参数用 never：任意「payload 具体形状」的订阅函数都能注册（contravariance：
// never 可赋给任何类型），派发时以 Record<string, unknown> 实参调用（内部单点收窄）。
// 订阅方的参数类型不会被收窄，保持各自的事件契约不变。
type NativeEventHandler = (payload: never) => void;

const nativeEventHandlers = new Map<string, Set<NativeEventHandler>>(); // name → Set<fn(payload)>

/** 订阅某类原生事件（syncAssetProgress/syncAssetDone/assetStatus/appState…）；返回取消订阅函数 */
export function onNativeEvent(name: string, fn: NativeEventHandler) {
  if (typeof fn !== "function") return () => {};
  if (!nativeEventHandlers.has(name)) nativeEventHandlers.set(name, new Set());
  nativeEventHandlers.get(name)!.add(fn);
  return () => {
    nativeEventHandlers.get(name)?.delete(fn);
  };
}

function dispatchNativeEvent(name: string, payload: Record<string, unknown>) {
  const set = nativeEventHandlers.get(name);
  if (!set || !set.size) return;
  for (const fn of [...set]) {
    try {
      // 派发实参为 Record<string, unknown>（订阅方各自收窄自己的 payload 形状）
      (fn as (payload: Record<string, unknown>) => void)(payload);
    } catch {
      /* 单个订阅者异常不拖垮派发 */
    }
  }
}

// ---------- 事件派发（模拟 DOM EventTarget，playerCore bindAudioEvents 直接挂） ----------
/** 代理上派发的 DOM 风格事件对象（{type, target, ...payload}，对齐 Audio 事件语义） */
export interface NativeAudioEvent {
  type: string;
  target: NativeAudioProxy;
  [key: string]: unknown;
}

const listeners = new Map<string, Set<(event: NativeAudioEvent) => void>>();
// {once:true} 包装映射：原始 fn → 包装 fn。模拟 DOM 的 once 语义（触发即自移除），
// 且 removeEventListener 传原始 fn 也能移除包装后的监听器（2026-08-26：此前 once 选项
// 被直接丢弃，监听器挂上即永久存活——loadedmetadata 泄漏劫持新歌的帮凶之一）。
const onceWrappers = new Map<
  (event: NativeAudioEvent) => void,
  (event: NativeAudioEvent) => void
>();

function addListener(
  type: string,
  fn: (event: NativeAudioEvent) => void,
  options?: { once?: boolean },
) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  let entry: (event: NativeAudioEvent) => void = fn;
  if (options && options.once) {
    entry = (event) => {
      removeListener(type, entry);
      fn(event);
    };
    onceWrappers.set(fn, entry);
  }
  listeners.get(type)!.add(entry);
}

function removeListener(type: string, fn: (event: NativeAudioEvent) => void) {
  const actual = onceWrappers.get(fn) || fn;
  onceWrappers.delete(fn);
  listeners.get(type)?.delete(actual);
}

function emit(type: string, payload: Record<string, unknown> = {}) {
  const set = listeners.get(type);
  if (!set) return;
  // 有监听器必然已 createNativeAudioProxy（监听器只经代理挂载），target 非空
  const event: NativeAudioEvent = { type, target: proxy!, ...payload };
  for (const fn of [...set]) {
    try {
      fn(event);
    } catch {
      /* 单个监听器异常不拖垮派发 */
    }
  }
}

// ---------- 相对路径 → 桌面服务器绝对 URL ----------
function serverBase() {
  try {
    return localStorage.getItem("qqplayer.server") || "";
  } catch {
    return "";
  }
}

/** 配对 token：localStorage 优先，桥对象兜底（与 apiClient.authToken 同源策略，file:// 下桥注入更可靠） */
function authToken() {
  try {
    const t = localStorage.getItem("qqplayer.token");
    if (t) return t;
  } catch {
    /* 忽略 */
  }
  try {
    const b = nativeBridge();
    return b && typeof b.token === "string" ? b.token : "";
  } catch {
    return "";
  }
}

export function resolveNativeUrl(url: string): string {
  if (!url || typeof url !== "string") return url;
  // http(s) 与 file（本地资产）都是绝对 URL，原样传给原生播放（第三方直链不加 token）
  if (/^(https?|file):\/\//i.test(url)) return url;
  // 同源代理 URL → 解出上游直链（AVPlayer 直接拉，跨域无 CORS 限制；直链是外部 URL，不加 token）
  const m = url.match(/^\/api\/stream\/proxy\?url=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      /* 回退原样 */
    }
  }
  const base = serverBase();
  if (!base) return url;
  let full = base.replace(/\/+$/, "") + (url.startsWith("/") ? url : "/" + url);
  // 原生资源（AVPlayer 拉流 / URLSession 拉锁屏封面）带不了 Authorization header
  // → token 附加 query（与 apiClient.resolveServerUrl 对齐；后端中间件支持 ?token=；
  //   2026-08-23 真机锁屏封面 401 根因）。URL 已有 query 时用 & 连接。
  const token = authToken();
  if (token) {
    full += (full.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
  }
  return full;
}

// ---------- Audio 代理（对 playerCore 呈现原生 Audio 元素语义） ----------
let proxy: NativeAudioProxy | null = null;

export interface NativeAudioProxy {
  src: string;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  volume: number;
  muted: boolean;
  playbackRate: number;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  addEventListener(
    type: string,
    fn: (event: NativeAudioEvent) => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: string, fn: (event: NativeAudioEvent) => void): void;
  removeAttribute(attr: string): void;
}

export function createNativeAudioProxy(): NativeAudioProxy {
  if (proxy) return proxy;
  const p = {} as NativeAudioProxy;
  let srcValue = "";
  let volumeValue = 1;
  let rateValue = 1;
  let mutedValue = false;

  Object.defineProperties(p, {
    src: {
      get: () => srcValue,
      set: (v: string) => {
        srcValue = v ? String(v) : "";
        if (srcValue) {
          // 换源重置进度/时长镜像：模拟浏览器 <audio> 换 src 后 currentTime 归零。
          // 否则原生新 item 首个 timeupdate 到达前，currentTime 残留上一首歌的进度——
          // maybePrefetchAsset「切本地播放保留进度」会捕获错误位置，新歌从接近尾部
          // 开始播（甚至越界被 clamp 到尾部立即 ended = 直接跳过），2026-08-25 根因。
          nativeState.currentTime = 0;
          nativeState.duration = 0;
          nativeState.ended = false;
          nativePost({ cmd: "load", url: resolveNativeUrl(srcValue) });
        }
      },
    },
    currentTime: {
      get: () => nativeState.currentTime,
      set: (t: number) => {
        if (typeof t !== "number" || !Number.isFinite(t)) return;
        const v = Math.max(0, t);
        nativeState.currentTime = v;
        nativePost({ cmd: "seek", t: v });
      },
    },
    duration: {
      get: () => nativeState.duration,
    },
    paused: {
      get: () => !nativeState.isPlaying,
    },
    ended: {
      get: () => nativeState.ended,
    },
    volume: {
      get: () => volumeValue,
      set: (v: number) => {
        volumeValue = Math.min(1, Math.max(0, Number(v) || 0));
        nativePost({ cmd: "setVolume", v: volumeValue });
      },
    },
    muted: {
      get: () => mutedValue,
      set: (v: boolean) => {
        mutedValue = !!v;
        nativePost({ cmd: "setVolume", v: mutedValue ? 0 : volumeValue });
      },
    },
    playbackRate: {
      get: () => rateValue,
      set: (r: number) => {
        rateValue = Number(r) || 1;
        nativePost({ cmd: "setRate", r: rateValue });
      },
    },
  });

  p.play = () => {
    // 同步本地播放意图：原生事件回传前 currentKaraokeIndex 等本地逻辑立即感知
    // （否则句末暂停瞬间按"下一句"会因 isPlaying 仍为 true 走播放分支 → 定位下一句再 +1 = 跳两句）
    nativeState.isPlaying = true;
    nativeState.ended = false;
    nativePost({ cmd: "play" });
    return Promise.resolve();
  };
  p.pause = () => {
    nativeState.isPlaying = false;
    nativePost({ cmd: "pause" });
  };
  p.load = () => {};
  p.addEventListener = addListener;
  p.removeEventListener = removeListener;
  p.removeAttribute = (attr: string) => {
    if (attr === "src") srcValue = "";
  };

  proxy = p;
  return p;
}

/** 当前代理实例（原生模式下供 playerCore 引用；非原生模式返回 null） */
export function getNativeAudioProxy() {
  return proxy;
}

// ---------- Native → Web 事件入口（壳 evaluateJavaScript 调用） ----------
// window.qqplayerOnNativeEvent('timeupdate', {t, duration})
// 远端命令（锁屏/耳机线控）也走这里：remoteCommand {cmd: play|pause|toggle|next|prev|seekto}
export function installNativeEventSink() {
  if (typeof window === "undefined" || window.qqplayerOnNativeEvent) return;
  window.qqplayerOnNativeEvent = (event, payload = {}) => {
    switch (event) {
      case "timeupdate": {
        const t = typeof payload.t === "number" ? payload.t : nativeState.currentTime;
        const d = typeof payload.duration === "number" ? payload.duration : 0;
        nativeState.currentTime = t;
        if (d > 0 && nativeState.duration !== d) {
          nativeState.duration = d;
          emit("loadedmetadata", { duration: d });
        }
        emit("timeupdate", {});
        break;
      }
      case "playing":
        nativeState.isPlaying = true;
        nativeState.ended = false;
        nativePost({ cmd: "setPlaying", playing: true });
        emit("play", {});
        break;
      case "paused":
        nativeState.isPlaying = false;
        nativePost({ cmd: "setPlaying", playing: false });
        emit("pause", {});
        break;
      case "ended":
        nativeState.isPlaying = false;
        nativeState.ended = true;
        nativePost({ cmd: "setPlaying", playing: false });
        emit("ended", {});
        break;
      case "loadedmetadata":
        if (typeof payload.duration === "number" && payload.duration > 0) {
          nativeState.duration = payload.duration;
        }
        emit("loadedmetadata", { duration: nativeState.duration });
        break;
      case "remoteCommand":
        handleRemoteCommand(payload);
        break;
      case "songChanged":
        // 原生后台切歌（锁屏/线控）：index = 播放顺序快照（setQueue）中的新位置
        handleSongChanged(payload);
        break;
      default:
        // 通用事件（sync 资产进度/回执、appState 生命周期等）转给订阅者
        dispatchNativeEvent(event, payload);
        break;
    }
  };
}

// ---------- 远端命令（锁屏/耳机线控）→ playerCore 执行 ----------
// 壳 MPRemoteCommandCenter 收到 play/pause/next/prev/seekto → 推 remoteCommand →
// playerCore 注册处理器（与桌面 MediaSession 同一套动作，队列/切歌逻辑完全复用）
let remoteCommandHandler: ((cmd: string, t?: number) => void) | null = null;

export function registerRemoteCommandHandler(fn: (cmd: string, t?: number) => void) {
  remoteCommandHandler = fn;
}

function handleRemoteCommand(payload: Record<string, unknown> = {}) {
  if (!remoteCommandHandler) return;
  const cmd = payload.cmd;
  const t = typeof payload.t === "number" ? payload.t : undefined;
  if (cmd === "play") remoteCommandHandler("play", t);
  else if (cmd === "pause") remoteCommandHandler("pause", t);
  else if (cmd === "toggle") remoteCommandHandler("toggle", t);
  else if (cmd === "next") remoteCommandHandler("next", t);
  else if (cmd === "prev") remoteCommandHandler("prev", t);
  else if (cmd === "seekto") remoteCommandHandler("seekto", t);
}

// ---------- 原生切歌事件（锁屏/线控后台切歌）→ playerCore 对齐状态 ----------
// 壳 playQueueRelative 切歌成功后推 songChanged {index}（前端不重新 load，只对齐）。
let nativeSongChangedHandler: ((index: number) => void) | null = null;

export function registerNativeSongChangedHandler(fn: (index: number) => void) {
  nativeSongChangedHandler = fn;
}

function handleSongChanged(payload: Record<string, unknown> = {}) {
  if (!nativeSongChangedHandler) return;
  const index = typeof payload.index === "number" ? payload.index : -1;
  if (index >= 0) nativeSongChangedHandler(index);
}

// ---------- 封面 URL 解析（单一真源） ----------
// song.coverUrl 优先（流媒体网络图）；否则本地歌 path → 服务器 /api/cover 绝对 URL
//（token 附加同 resolveNativeUrl）；都没有返回 ""。
export interface LockScreenSong {
  name?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  path?: string;
}

export function resolveCoverURL(song: LockScreenSong | null | undefined) {
  if (!song) return "";
  if (song.coverUrl) return song.coverUrl;
  if (song.path) return resolveNativeUrl("/api/cover?path=" + encodeURIComponent(song.path));
  return "";
}

// ---------- 锁屏元数据（currentSong 变化 → 原生 Now Playing） ----------
// coverOverride（可选第二参数）：调用方已解析好的封面（data: URL / 本地缓存 URL），优先于
// resolveCoverURL 的 song.coverUrl 与远程兜底；同步签名保持兼容（老调用只传 song）。
export function nativeSendMetadata(song: LockScreenSong | null | undefined, coverOverride = "") {
  if (!song) {
    nativePost({ cmd: "setMetadata", title: "", artist: "", album: "", coverUrl: "" });
    return;
  }
  const cover = coverOverride || resolveCoverURL(song);
  nativePost({
    cmd: "setMetadata",
    title: song.name || "",
    artist: song.artist || "",
    album: song.album || "",
    coverUrl: cover,
  });
}

/** 同步主机可达性状态 → 原生状态条（hostStatus 桥命令 {online: bool}）。
 *  启动探测完成后（App.vue）显式调用一次；offline 变化由下方订阅自动推送；
 *  非原生环境 no-op。 */
export function syncHostStatus() {
  if (!isNativePlayback()) return;
  nativePost({ cmd: "hostStatus", online: !isOffline() });
}

// ---------- 安装（原生模式下模块加载即挂 401 通知 + 事件入口） ----------
if (isNativePlayback()) {
  installNativeEventSink();
  // 401（token 失效）→ 壳清 Keychain 回配对页
  onUnauthorized(() => {
    nativePost({ cmd: "unauthorized" });
  });
  // 主机可达性 → 状态条：offline 变化即推送（启动探测完成时 App.vue 也会
  // 显式 syncHostStatus() 一次，保证探测结果落状态条）
  onOfflineChange((off: boolean) => {
    nativePost({ cmd: "hostStatus", online: !off });
  });
}
