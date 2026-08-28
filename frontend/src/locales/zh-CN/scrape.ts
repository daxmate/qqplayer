// 批量刮削（ScrapeResultModal.vue + useScrapeBatch.js）
export default {
  scrape: {
    resultTitle: "批量刮削结果",
    resultCount: "共 {n} 首",
    notEnabled: "批量刮削未启用，请在设置中开启",
    truncated: "结果较多，仅展示部分明细",
    batchError: "批量刮削失败，请稍后重试",
    summary: {
      written: "成功",
      skipped: "跳过",
      failed: "失败",
    },
    status: {
      written: "已写入",
      skipped: "跳过",
      failed: "失败",
    },
    detail: {
      reason: "原因",
      written: "写入字段",
      candidates: "候选数",
      other: "其他",
    },
  },
};
