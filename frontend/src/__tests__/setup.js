// 测试全局 setup：所有 mount 组件自动带 i18n 插件（@vue/test-utils config.global.plugins）
import { config } from "@vue/test-utils";
import i18n from "../locales/i18n.js";

config.global.plugins = [i18n];
