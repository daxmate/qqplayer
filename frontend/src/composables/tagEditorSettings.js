// 标签编辑弹窗的设置联动：scraping.enabled_fields（字段选择）模块级缓存
//
// 背景：保存标签时，若后端设置里存在 scraping.enabled_fields（字段选择开关，设置 tab 由前端②做 UI），
// 只提交勾选字段（其余置 null = 后端不写）；设置未就绪/接口失败时提交全部字段（容错）。
// 读取方式：GET /api/library/settings 取 settings.scraping.enabled_fields，打开弹窗时拉一次，
// 缓存到模块级（避免每次弹窗都发请求）。
//
// 语义：
//   - 成功拿到数组（含空数组）→ 缓存 + 标记已加载（后续打开不再请求）
//   - 接口失败 / 返回无 enabled_fields → 保持未加载（下次打开重试；期间提交全部字段）

import { apiGet } from "../utils/apiClient.js";

let enabledFieldsCache = null; // null = 未加载 / 无字段选择配置
let loaded = false; // 是否已成功缓存过（成功后才免重复请求）

/** 拉取 enabled_fields（模块级缓存；幂等，未加载才真正发请求） */
export async function loadEnabledFields() {
  if (loaded) return;
  try {
    const r = await apiGet("/api/library/settings");
    if (r.ok) {
      const data = r.data || {};
      const ef = data?.settings?.scraping?.enabled_fields;
      if (Array.isArray(ef)) {
        enabledFieldsCache = ef;
        loaded = true;
      }
    }
  } catch {
    /* 接口失败：保持未加载（下次打开重试），提交全部字段兜底 */
  }
}

/** 当前生效的 enabled_fields（数组）或 null（不限制） */
export function getEnabledFields() {
  return Array.isArray(enabledFieldsCache) ? enabledFieldsCache : null;
}

/** 设置变更后失效缓存（前端②设置 tab 保存字段选择时调用，本轮未接入） */
export function invalidateEnabledFields() {
  enabledFieldsCache = null;
  loaded = false;
}

/** 测试隔离：清空模块级缓存 */
export function resetTagEditorSettings() {
  enabledFieldsCache = null;
  loaded = false;
}
