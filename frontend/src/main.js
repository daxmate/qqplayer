// Tauri 壳（Windows/Linux）等价于 Swift 原生壳：统一补注入 qqplayerNative 标记。
// 背景：macOS Swift 壳在 WKWebView 注入 window.qqplayerNative=true（main.swift atDocumentStart），
// Tauri 壳没有这个标记，而前端大量逻辑（迷你窗/桌面歌词开关、选库、右键菜单、拖拽等）
// 靠它区分"壳内 vs 浏览器"——缺失时退化为 URL scheme 调起分支（qqplayermini:// 等），
// Windows/Linux 未注册 scheme → 面板静默打不开。此处检测到 Tauri 运行时补注入，
// 所有壳分支（内部已统一走 useShellBridge 三端桥）即刻在 Windows/Linux 生效。
if (typeof window !== "undefined" && window.__TAURI_INTERNALS__ && !window.qqplayerNative) {
  window.qqplayerNative = true;
}

import { createApp } from "vue";
import App from "./App.vue";
import i18n from "./locales/i18n.js";
import ToastContainer from "./components/ToastContainer.vue";
import { initNativeCtxMenu } from "./composables/useNativeCtxMenu.js";
import { installPullRevealStatusBar } from "./composables/usePullRevealStatusBar.js";
import "./style.css";
import "./mobile.css"; // 移动端（<1024px）布局与触摸适配（全部规则在断点内，桌面零影响）
// amll 歌词组件基础样式（体积小，全局引入；组件本体走异步按需加载）
import "@applemusic-like-lyrics/core/style.css";

// 全局取消浏览器默认右键菜单（input/textarea/contenteditable 输入框保留系统菜单：复制/粘贴/拼写）。
// 自定义右键菜单组件用 @contextmenu.prevent 自行 preventDefault 弹菜单，与此监听不冲突。
document.addEventListener("contextmenu", (e) => {
  const el =
    e.target instanceof Element ? e.target.closest("input, textarea, [contenteditable]") : null;
  if (!el) e.preventDefault();
});

createApp(App).use(i18n).mount("#app");

// Swift 壳右键菜单桥接（歌曲列表/侧边栏歌单）：壳内挂 mousedown 检测 + window.__qqCtxMenu；
// 浏览器（无 window.qqplayerNative）内部直接返回，不挂任何监听，右键行为零影响。
initNativeCtxMenu();

// iOS 壳：顶部状态条下拉召唤（平时隐藏，页面顶部下拉才浮现）。仅 iOS 壳生效，其他环境 no-op。
installPullRevealStatusBar();

// 全局 toast 容器：挂到 body 级独立容器（不侵入 App 组件树）
// ToastContainer 内部 Teleport 到 body，任意组件通过 useToast() 触发
const toastHost = document.createElement("div");
toastHost.id = "toast-host";
document.body.appendChild(toastHost);
createApp(ToastContainer).use(i18n).mount(toastHost);
