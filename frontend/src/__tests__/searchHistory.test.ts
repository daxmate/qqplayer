// searchHistory 模块单元测试（任务 D：搜索历史，存后端统一设置 ui.searchHistory）
// 覆盖：10 条截断 / 去重置顶 / 单删 / 清空 / 空白不记 /
// 镜像同步（uiSettings 变化 → history ref 自动更新，模拟 settingsSync GET 覆盖）/
// loadHistory 重新同步 / 非法值防御
import { beforeEach, describe, expect, it } from "vitest";
import {
  history,
  loadHistory,
  addHistory,
  removeHistory,
  clearHistory,
} from "../composables/searchHistory.js";
import { uiSettings } from "../composables/useSettings.js";

beforeEach(() => {
  uiSettings.searchHistory = []; // 重置（模块级单例，防用例间污染）
});

describe("addHistory", () => {
  it("最新在前，超过 10 条截断（保留最近 10 条）", () => {
    for (let i = 1; i <= 12; i++) addHistory(`词${i}`);
    expect(uiSettings.searchHistory).toHaveLength(10);
    expect(uiSettings.searchHistory[0]).toBe("词12"); // 最新在头部
    expect(uiSettings.searchHistory[9]).toBe("词3");
    expect(uiSettings.searchHistory).not.toContain("词1");
    expect(uiSettings.searchHistory).not.toContain("词2");
  });

  it("去重：重复词移到最前，不重复存储", () => {
    addHistory("晴天");
    addHistory("五月天");
    addHistory("晴天");
    expect(uiSettings.searchHistory).toEqual(["晴天", "五月天"]);
  });

  it("空白不记：空串 / 纯空格 / null / undefined / 非字符串", () => {
    addHistory("");
    addHistory("   ");
    addHistory(null);
    addHistory(undefined);
    addHistory(42);
    expect(uiSettings.searchHistory).toEqual([]);
  });

  it("记录前 trim 输入", () => {
    addHistory("  晴天  ");
    expect(uiSettings.searchHistory).toEqual(["晴天"]);
  });
});

describe("removeHistory / clearHistory", () => {
  it("单删：只删匹配项，其余顺序不变；不存在的词无副作用", () => {
    addHistory("a");
    addHistory("b");
    addHistory("c");
    removeHistory("b");
    expect(uiSettings.searchHistory).toEqual(["c", "a"]);
    removeHistory("不存在");
    expect(uiSettings.searchHistory).toEqual(["c", "a"]);
  });

  it("清空全部", () => {
    addHistory("a");
    addHistory("b");
    clearHistory();
    expect(uiSettings.searchHistory).toEqual([]);
  });
});

describe("history ref 镜像", () => {
  it("变更同步到 history ref（组件渲染出口）", () => {
    addHistory("晴天");
    addHistory("五月天");
    expect(history.value).toEqual(["五月天", "晴天"]);
  });

  it("uiSettings.searchHistory 外部变化（settingsSync GET 覆盖）→ history 自动同步", () => {
    // 模拟后端 GET 返回的历史（含非法条目，后端已校验，这里防御性清洗）
    uiSettings.searchHistory = ["甲", 42, "", "乙"] as unknown as string[];
    expect(history.value).toEqual(["甲", 42, "", "乙"]); // 镜像原样（清洗由后端负责）
    uiSettings.searchHistory = ["丙"];
    expect(history.value).toEqual(["丙"]);
  });

  it("loadHistory 从 uiSettings 重新同步", () => {
    uiSettings.searchHistory = ["甲", "乙"];
    loadHistory();
    expect(history.value).toEqual(["甲", "乙"]);
  });

  it("非法值防御：uiSettings.searchHistory 被置为非数组 → 操作不崩、镜像为空", () => {
    uiSettings.searchHistory = "晴天,五月天" as unknown as string[]; // 不应发生（后端校验），防御处理
    expect(history.value).toEqual([]);
    addHistory("好歌"); // 基于空列表追加
    expect(uiSettings.searchHistory).toEqual(["好歌"]);
  });
});
