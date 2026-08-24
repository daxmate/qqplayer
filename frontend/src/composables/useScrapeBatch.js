// 批量刮削（POST /api/tags/scrape-batch）
//
// 契约（后端并行开发中，接口未合并时 mock 容错）：
//   body: {"paths": ["..."]} 多选批量 | {"mode": "library"} 一键整库
//   返回: {
//     "enabled": bool,          // batch_enabled=false 时后端防御返回 false
//     "truncated": bool,
//     "results": [{"path","status":"written|skipped|failed","reason","written":[...],"candidates":n}],
//     "summary": {"total","written","skipped","failed"}
//   }
//
// 结果面板（ScrapeResultModal.vue）读取同一份状态；Playlist / SettingsModal 共用入口。
import { reactive } from "vue";
import { apiPost } from "../utils/apiClient.js";
import i18n from "../locales/i18n.js";

export const scrapeBatchState = reactive({
  open: false, // 结果面板开关
  loading: false, // 请求进行中
  enabled: true, // 后端是否允许批量刮削（false → 面板提示去设置开启）
  truncated: false, // 明细被截断（结果太多只返回部分）
  results: [], // [{path,status,reason,written,candidates}]
  summary: { total: 0, written: 0, skipped: 0, failed: 0 },
  error: "", // 请求级错误（非空时面板显示错误态，不展示明细）
});

export function openScrapeResult() {
  scrapeBatchState.open = true;
}

export function closeScrapeResult() {
  scrapeBatchState.open = false;
}

/**
 * 执行批量刮削：payload = {paths: [...]} 或 {mode: "library"}
 * 完成后打开结果面板（enabled=false / 错误也打开，面板内提示）。
 */
export async function runScrapeBatch(payload) {
  if (scrapeBatchState.loading) return;
  scrapeBatchState.loading = true;
  scrapeBatchState.error = "";
  scrapeBatchState.enabled = true;
  scrapeBatchState.truncated = false;
  scrapeBatchState.results = [];
  scrapeBatchState.summary = { total: 0, written: 0, skipped: 0, failed: 0 };
  try {
    const r = await apiPost("/api/tags/scrape-batch", payload);
    if (!r.ok) {
      const data = r.data || {};
      scrapeBatchState.error =
        data.detail || data.message || r.message || i18n.global.t("scrape.batchError");
      scrapeBatchState.open = true;
      return;
    }
    const d = r.data || {};
    scrapeBatchState.enabled = d.enabled !== false;
    scrapeBatchState.truncated = !!d.truncated;
    scrapeBatchState.results = Array.isArray(d.results) ? d.results : [];
    const s = d.summary || {};
    scrapeBatchState.summary = {
      total: Number(s.total) || 0,
      written: Number(s.written) || 0,
      skipped: Number(s.skipped) || 0,
      failed: Number(s.failed) || 0,
    };
    scrapeBatchState.open = true;
  } catch (e) {
    scrapeBatchState.error = (e && e.message) || i18n.global.t("scrape.batchError");
    scrapeBatchState.open = true;
  } finally {
    scrapeBatchState.loading = false;
  }
}
