// 统一壳桥：探测运行环境 → 同一套 API 适配两种原生壳（Tauri 2 Windows / WebKit macOS Swift），
// 浏览器直连模式静默降级（全部 noop）。webkit 模式行为与改造前 100% 一致（macOS 壳在产线使用）。
//
// 模块级单例：useShellBridge() 始终返回同一实例；mode 与各方法在调用时实时探测
// （window.__TAURI_INTERNALS__ → tauri；window.webkit.messageHandlers.native → webkit；否则 null），
// 不缓存探测结果——测试可在 beforeEach 里切换 window 形态，产线环境探测结果天然稳定。
//
// 事件桥（on()）：tauri 壳 emit 的 'library-changed' / 'dict-files' 转成前端同名 window
// CustomEvent（qqplayer:nativelibrary / qqplayer:nativeDictFiles）派发，前端两种模式统一用
// window.addEventListener(webEventName) 监听，现有监听逻辑一行不改。

/** 壳环境：'tauri'（Tauri 2 桌面壳）| 'webkit'（macOS Swift 壳）| null（浏览器直连） */
export type ShellMode = "tauri" | "webkit" | null;

/** tauri 壳事件对象（listen 回调入参；payload 为壳 emit 的任意数据） */
interface TauriEvent {
  payload?: unknown;
}

/** tauri 壳运行时全局（window.__TAURI__，Tauri 2 注入） */
interface TauriGlobal {
  core?: { invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  event?: { listen?: (event: string, handler: (event: TauriEvent) => void) => Promise<unknown> };
}

/** WebKit（macOS Swift 壳）消息桥全局（window.webkit） */
interface WebkitShellGlobal {
  messageHandlers?: { native?: { postMessage?: (message: unknown) => void } };
}

declare global {
  interface Window {
    /** Tauri 2 壳环境标记（壳注入；与 window.__TAURI__ 同生命周期） */
    __TAURI_INTERNALS__?: unknown;
    /** Tauri 2 运行时 API（core.invoke / event.listen） */
    __TAURI__?: TauriGlobal;
    /** macOS Swift 壳的 WebKit 消息桥 */
    webkit?: WebkitShellGlobal;
  }
}

// tauri 壳事件名 → 前端 window 事件名（CustomEvent）映射（与 SettingsModal/DictManagerModal 现有监听一致）
const TAURI_EVENT_MAP: Record<string, string> = {
  "qqplayer:nativelibrary": "library-changed",
  "qqplayer:nativeDictFiles": "dict-files",
};

/** 实时探测当前壳环境（每次调用重新判定，测试友好） */
function detectMode(): ShellMode {
  if (typeof window === "undefined") return null;
  if (window.__TAURI_INTERNALS__) return "tauri";
  if (window.webkit?.messageHandlers?.native) return "webkit";
  return null;
}

/** tauri invoke 安全封装：invoke 缺失/失败一律静默（返回已 catch 的 Promise，杜绝 unhandled rejection） */
function tauriInvoke(cmd: string, args?: unknown): Promise<unknown> {
  try {
    const p =
      args === undefined
        ? window.__TAURI__?.core?.invoke?.(cmd)
        : window.__TAURI__?.core?.invoke?.(cmd, args);
    return Promise.resolve(p).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** tauri 壳事件监听：listen 返回 Promise<UnlistenFn>，解绑函数在就绪后调用真实 unlisten */
function tauriListen(tauriEvent: string, onPayload: (event: TauriEvent) => void): () => void {
  let unlisten: () => void = () => {};
  try {
    const p = window.__TAURI__?.event?.listen?.(tauriEvent, onPayload);
    if (p?.then) {
      p.then((fn) => {
        if (typeof fn === "function") unlisten = fn as () => void;
      }).catch(() => {});
    }
  } catch {
    /* 壳事件监听失败静默 */
  }
  return () => {
    try {
      unlisten();
    } catch {
      /* 解绑失败静默 */
    }
  };
}

/**
 * 通用壳消息上报（lyric/closeMini/openMini/readerState/ctxState/nativeDrag…）
 * - tauri → invoke('report', { msg })（返回 Promise，catch 静默）
 * - webkit → postMessage(msg)（保持现状）
 * - null → noop
 */
function report(msg: unknown) {
  const m = detectMode();
  if (m === "tauri") return tauriInvoke("report", { msg });
  if (m === "webkit") {
    window.webkit?.messageHandlers?.native?.postMessage?.(msg);
  }
  // null：浏览器直连，静默 noop
}

/** 统一壳桥实例结构（useShellBridge() 返回值；模块级单例） */
export interface ShellBridge {
  /** 当前壳环境：'tauri' | 'webkit' | null（每次访问实时探测） */
  readonly mode: ShellMode;
  /** 通用壳消息上报（tauri invoke('report') / webkit postMessage / null noop） */
  report: (msg: unknown) => void;
  /** 选库（tauri invoke('pick_library') / webkit postMessage("pickLibrary") / null noop） */
  pickLibrary: () => void;
  /** 选词典文件（tauri invoke('pick_dict_files') / webkit postMessage({ type: "pickDictFiles" }) / null noop） */
  pickDictFiles: () => void;
  /** 整窗拖动：等价 report({ type: "nativeDrag" }) */
  startDragging: () => void;
  /** 壳事件监听，返回解绑函数（tauri 转发 CustomEvent / webkit 直接 addEventListener / null noop） */
  on: (webEventName: string, handler: (event: Event) => void) => () => void;
}

/** 桥实例（模块级单例） */
const shellBridge: ShellBridge = {
  /** 当前壳环境：'tauri' | 'webkit' | null（每次访问实时探测） */
  get mode() {
    return detectMode();
  },

  report,

  /**
   * 选库：
   * - tauri → invoke('pick_library')（壳选完文件夹会 POST /api/library 并 emit 'library-changed' 事件）
   * - webkit → postMessage("pickLibrary")（现状，字符串消息）
   * - null → noop
   */
  pickLibrary() {
    const m = detectMode();
    if (m === "tauri") return tauriInvoke("pick_library");
    if (m === "webkit") {
      window.webkit?.messageHandlers?.native?.postMessage?.("pickLibrary");
    }
  },

  /**
   * 选词典文件：
   * - tauri → invoke('pick_dict_files')（壳 emit 'dict-files' 事件，payload 含 paths）
   * - webkit → postMessage({ type: "pickDictFiles" })（现状）
   * - null → noop
   */
  pickDictFiles() {
    const m = detectMode();
    if (m === "tauri") return tauriInvoke("pick_dict_files");
    if (m === "webkit") {
      window.webkit?.messageHandlers?.native?.postMessage?.({ type: "pickDictFiles" });
    }
  },

  /** 整窗拖动：等价 report({ type: "nativeDrag" }) */
  startDragging() {
    return report({ type: "nativeDrag" });
  },

  /**
   * 壳事件监听，返回解绑函数：
   * - tauri：listen('library-changed' | 'dict-files')，收到后 window.dispatchEvent(new CustomEvent(webEventName, { detail: payload }))
   *   ——调用点两种模式统一用 window.addEventListener(webEventName)，现有监听逻辑一行不改；
   *   handler 同步收到同一 CustomEvent（与 webkit 模式消费方式一致）
   * - webkit：直接 window.addEventListener(webEventName, handler)（macOS 壳本来就用 evaluateJavaScript dispatch CustomEvent）
   * - null → 返回 noop 解绑函数
   */
  on(webEventName: string, handler: (event: Event) => void) {
    const m = detectMode();
    if (m === "tauri") {
      const tauriEvent = TAURI_EVENT_MAP[webEventName] || webEventName;
      return tauriListen(tauriEvent, (event) => {
        const payload = event?.payload;
        const ce = new CustomEvent(webEventName, { detail: payload });
        window.dispatchEvent(ce);
        if (typeof handler === "function") handler(ce);
      });
    }
    if (m === "webkit") {
      window.addEventListener(webEventName, handler);
      return () => window.removeEventListener(webEventName, handler);
    }
    return () => {};
  },
};

/** 模块级单例：任何调用点拿到同一桥实例 */
export function useShellBridge(): ShellBridge {
  return shellBridge;
}
