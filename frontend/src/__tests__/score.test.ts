// score.js 单元测试：匹配度打分 + 类别优先级
import { describe, expect, it } from "vitest";
import { matchScore, kindRank } from "../utils/score.js";

describe("matchScore", () => {
  it("空 query 返回 0", () => {
    expect(matchScore("", "晴天")).toBe(0);
    expect(matchScore("   ", "晴天")).toBe(0);
    expect(matchScore(null, "晴天")).toBe(0);
    expect(matchScore(undefined, "晴天")).toBe(0);
  });

  it("前缀命中 > 包含命中 > 不中", () => {
    const prefix = matchScore("晴", "晴天");
    const contain = matchScore("晴", "小晴天");
    const none = matchScore("晴", "阴天");
    expect(prefix).toBe(100);
    expect(contain).toBe(50);
    expect(none).toBe(0);
    expect(prefix).toBeGreaterThan(contain);
    expect(contain).toBeGreaterThan(none);
  });

  it("完全相等在基础前缀分上额外 +20", () => {
    expect(matchScore("晴天", "晴天")).toBe(120);
  });

  it("空文本返回 0", () => {
    expect(matchScore("a", "")).toBe(0);
    expect(matchScore("a", null)).toBe(0);
    expect(matchScore("a", undefined)).toBe(0);
  });

  it("normalize 互通：简体/繁体", () => {
    expect(matchScore("周杰伦", "周杰倫")).toBe(120); // 简查繁
    expect(matchScore("周杰倫", "周杰伦")).toBe(120); // 繁查简
    expect(matchScore("晴", "小晴天")).toBe(50); // 繁体包含
  });

  it("normalize 互通：带声调字母", () => {
    expect(matchScore("e", "éclair")).toBe(100); // é 剥离声调
    expect(matchScore("é", "Eclair")).toBe(100); // 大写 + 声调
    expect(matchScore("cafe", "café")).toBe(120); // 归一化后完全相等（含完全相等加分）
  });
});

describe("kindRank", () => {
  it("五类优先级：本地 < 在线 < 歌手 < 专辑 < 设置", () => {
    expect(kindRank("song")).toBe(0);
    expect(kindRank("online")).toBe(1);
    expect(kindRank("artist")).toBe(2);
    expect(kindRank("album")).toBe(3);
    expect(kindRank("setting")).toBe(4);
  });

  it("未知类别给最大排名（排最后）", () => {
    expect(kindRank("unknown")).toBeGreaterThan(kindRank("setting"));
  });
});
