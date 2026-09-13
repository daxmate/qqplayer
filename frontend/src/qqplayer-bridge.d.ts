// 壳注入的 window 全局对象类型声明（TS 化）。
// Tauri 壳（Windows / Linux）在运行时挂这些全局（main.ts 检测到 __TAURI_INTERNALS__ 后补注入
// window.qqplayerNative）；前端各模块按此类型访问，不改变任何运行时行为
//（纯类型声明，不产生 JS 产物）。
export {};

declare global {
  interface Window {
    /** 壳环境标记（Tauri 壳注入 true；桌面浏览器没有） */
    qqplayerNative?: boolean;
    /** Tauri 壳运行时标记（main.ts 检测到后补注入 qqplayerNative） */
    __TAURI_INTERNALS__?: unknown;
  }
}
