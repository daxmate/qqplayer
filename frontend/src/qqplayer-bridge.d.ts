// QQPlayer iOS 壳注入的 window 全局对象类型声明（TS 化）。
// 壳（WKWebView documentStart 注入 / evaluateJavaScript）在运行时挂这些全局；
// 前端各模块（nativeAudioBridge.ts / sync.ts / Reader.vue 等）按此类型访问，
// 不改变任何运行时行为（纯类型声明，不产生 JS 产物）。
export {};

declare global {
  interface Window {
    /** iOS 壳 documentStart 注入的原生桥（postMessage 单向通道 + server/token 注入） */
    qqplayerIosBridge?: {
      postMessage?: (msg: unknown) => void;
      token?: string;
      server?: string;
    };
    /** Native → Web 事件入口（nativeAudioBridge.installNativeEventSink 独占安装） */
    qqplayerOnNativeEvent?: (event: string, payload?: Record<string, unknown>) => void;
    /** iOS 壳环境标记（壳注入 true；桌面浏览器没有） */
    qqplayerNative?: boolean;
  }
}
