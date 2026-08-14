// vue-i18n 实例（legacy: false 组合式 API）
// 组件内用 useI18n().t()；composables / 非组件环境用 i18n.global.t()
import { createI18n } from "vue-i18n";
import zhCN from "./zh-CN/index.js";

const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: "zh-CN",
  messages: {
    "zh-CN": zhCN,
  },
});

export default i18n;
