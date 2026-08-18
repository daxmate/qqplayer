import { createApp } from "vue";
import App from "./App.vue";
import i18n from "./locales/i18n.js";
import ToastContainer from "./components/ToastContainer.vue";
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

// 全局 toast 容器：挂到 body 级独立容器（不侵入 App 组件树）
// ToastContainer 内部 Teleport 到 body，任意组件通过 useToast() 触发
const toastHost = document.createElement("div");
toastHost.id = "toast-host";
document.body.appendChild(toastHost);
createApp(ToastContainer).use(i18n).mount(toastHost);
