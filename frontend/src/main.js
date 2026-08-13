import { createApp } from "vue";
import App from "./App.vue";
import "./style.css";
// amll 歌词组件基础样式（体积小，全局引入；组件本体走异步按需加载）
import "@applemusic-like-lyrics/core/style.css";

createApp(App).mount("#app");
