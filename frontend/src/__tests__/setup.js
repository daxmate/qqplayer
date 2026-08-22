// 测试全局 setup：所有 mount 组件自动带 i18n 插件（@vue/test-utils config.global.plugins）
import { beforeEach } from "vitest";
import { config } from "@vue/test-utils";
import i18n from "../locales/i18n.js";
import { clearCache, clearPendingOps } from "../utils/cacheDb.js";
import { resetApiClientState } from "../utils/apiClient.js";

config.global.plugins = [i18n];

// 数据层隔离：缓存与 dirty 队列是模块级单例（jsdom 无 IndexedDB 时走内存实现），
// 跨测试残留会污染 fetch mock 断言（如缓存命中导致不再发请求、遗留队列触发回放）——
// 每个测试前清空缓存表/队列并复位 apiClient 在线状态。
beforeEach(async () => {
  await Promise.all([clearCache(), clearPendingOps()]);
  resetApiClientState();
});
