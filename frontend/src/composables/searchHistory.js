// 搜索历史（模块级单例，存储于后端统一设置 ui.searchHistory）
//
// 架构（2026-08-16 需求变更）：不走 localStorage——settingsSync.js 统一设置层
// （GET/PUT /api/settings）为唯一真源，浏览器↔壳跨引擎同步。
// 本模块直接读写 uiSettings.searchHistory；settingsSync 的 deep watch 会自动防抖
// PUT 到后端，无需自行调 API。settingsSync 异步 GET 覆盖 uiSettings 后，
// 下方镜像 watch 自动同步到 history ref（组件渲染出口）。
// 变更语义：最新在前、最多 10 条、去重置顶、单删、清空。
import { ref, watch } from "vue";
import { uiSettings } from "./useSettings.js";

const MAX_ITEMS = 10;

// 响应式出口（组件渲染用）：镜像 uiSettings.searchHistory
export const history = ref([]);

// 镜像：uiSettings.searchHistory 变化（含 settingsSync GET 覆盖）→ 同步到 history
watch(
  () => uiSettings.searchHistory,
  (arr) => {
    history.value = Array.isArray(arr) ? [...arr] : [];
  },
  { immediate: true, flush: "sync" },
);

// 当前列表（防御：uiSettings 字段可能被外部置为非法值）
function currentList() {
  const arr = uiSettings.searchHistory;
  return Array.isArray(arr) ? arr : [];
}

/** 从 uiSettings 重新同步 history（打开搜索层时调用；正常由镜像 watch 自动同步） */
export function loadHistory() {
  history.value = [...currentList()];
  return history;
}

/** 记录一条搜索词：去重（重复移到最前）→ 插入头部 → 截断 MAX_ITEMS；空白不记 */
export function addHistory(term) {
  if (typeof term !== "string") return;
  const q = term.trim();
  if (!q) return;
  uiSettings.searchHistory = [q, ...currentList().filter((s) => s !== q)].slice(0, MAX_ITEMS);
}

/** 删除单条历史 */
export function removeHistory(term) {
  const q = String(term ?? "");
  uiSettings.searchHistory = currentList().filter((s) => s !== q);
}

/** 清空全部历史 */
export function clearHistory() {
  uiSettings.searchHistory = [];
}

export function useSearchHistory() {
  return { history, loadHistory, addHistory, removeHistory, clearHistory };
}
