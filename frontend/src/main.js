import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";

// 引擎检测：WKWebView（Swift 壳）的 UA 含 AppleWebKit 但不含 Chrome
// → 加 webkit class，用于对 WebKit 做渲染管线适配（如字号瞬切避免每帧 layout）
if (/AppleWebKit/.test(navigator.userAgent) && !/Chrome|Edg\//.test(navigator.userAgent)) {
  document.documentElement.classList.add("webkit");
}

createApp(App).mount("#app");
