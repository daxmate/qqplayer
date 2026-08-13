import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
import "./mobile.css"; // 移动端（<1024px）布局与触摸适配（全部规则在断点内，桌面零影响）
// amll 歌词组件基础样式（体积小，全局引入；组件本体走异步按需加载）
import "@applemusic-like-lyrics/core/style.css";

createApp(App).mount("#app");
