// 搜索归一化层单元测试
import { describe, expect, it } from "vitest";
import { normalizeText, normalizeQuery, matchQuery } from "../utils/searchNormalize.js";

describe("normalizeText", () => {
  it("简体输入保持原样", () => {
    expect(normalizeText("爱你一万年")).toBe("爱你一万年");
  });

  it("繁体转简体：常用一字多繁字（發/髮→发）", () => {
    expect(normalizeText("發財")).toBe("发财");
    expect(normalizeText("頭髮")).toBe("头发");
  });

  it("繁体转简体：台→台、后→后、裏→里", () => {
    expect(normalizeText("臺灣")).toBe("台湾");
    expect(normalizeText("後面")).toBe("后面");
    expect(normalizeText("裏面")).toBe("里面");
    expect(normalizeText("皇后")).toBe("皇后"); // 词级：皇后不变
  });

  it("繁体短语整体转换", () => {
    expect(normalizeText("愛你一萬年")).toBe("爱你一万年");
    expect(normalizeText("五月天-溫柔")).toBe("五月天-温柔");
  });

  it("带声调拉丁字母剥离变音（é→e、ā→a、ü→u）", () => {
    expect(normalizeText("café")).toBe("cafe");
    expect(normalizeText("Māori")).toBe("maori");
    expect(normalizeText("für")).toBe("fur");
    expect(normalizeText("ǖnǚ")).toBe("unu"); // 多重组合标记
  });

  it("全角转半角（ＡＢＣ→abc、１２３→123、全角空格→空格）", () => {
    expect(normalizeText("ＡＢＣ")).toBe("abc");
    expect(normalizeText("１２３")).toBe("123");
    expect(normalizeText("ＡＢＣ１２３")).toBe("abc123");
    expect(normalizeText("a\u3000b")).toBe("a b");
  });

  it("混合场景：繁体 + 声调 + 全角一次归一化", () => {
    expect(normalizeText("ＡＢＣ 愛你一萬年")).toBe("abc 爱你一万年");
    expect(normalizeText("Līve ＨＡＰＰＹ 快樂")).toBe("live happy 快乐");
  });

  it("大小写归一", () => {
    expect(normalizeText("Mayday")).toBe("mayday");
  });

  it("空值/边界输入", () => {
    expect(normalizeText("")).toBe("");
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });
});

describe("normalizeQuery", () => {
  it("trim + 归一化", () => {
    expect(normalizeQuery("  發財  ")).toBe("发财");
    expect(normalizeQuery("  CAFÉ ")).toBe("cafe");
  });

  it("空/空白查询归一化为空串", () => {
    expect(normalizeQuery("")).toBe("");
    expect(normalizeQuery("   ")).toBe("");
    expect(normalizeQuery(null)).toBe("");
  });
});

describe("matchQuery", () => {
  it("简体文本 + 繁体查询命中", () => {
    expect(matchQuery("温柔", "溫柔")).toBe(true);
    expect(matchQuery("五月天", "五月天")).toBe(true);
    expect(matchQuery("头发", "髮")).toBe(true);
  });

  it("繁体文本 + 简体查询命中", () => {
    expect(matchQuery("溫柔", "温柔")).toBe(true);
    expect(matchQuery("臺灣", "台湾")).toBe(true);
    expect(matchQuery("後面", "后面")).toBe(true);
  });

  it("带声调查询命中无调文本", () => {
    expect(matchQuery("resume", "résumé")).toBe(true);
    expect(matchQuery("cafe", "café")).toBe(true);
    expect(matchQuery("maori", "Māori")).toBe(true);
    expect(matchQuery("māori", "maori")).toBe(true);
  });

  it("全角查询命中半角文本", () => {
    expect(matchQuery("abc123", "ＡＢＣ１２３")).toBe(true);
  });

  it("混合场景", () => {
    expect(matchQuery("愛你一萬年 - 五月天", "爱你一万年")).toBe(true);
    expect(matchQuery("爱你一万年 - 五月天", "愛你一萬年")).toBe(true);
  });

  it("子串匹配：部分歌名可命中", () => {
    expect(matchQuery("ヤキモチ", "キモ")).toBe(true);
  });

  it("无匹配返回 false", () => {
    expect(matchQuery("知足", "温柔")).toBe(false);
    expect(matchQuery("abc", "def")).toBe(false);
  });

  it("空查询恒为 false（调用方保证空查询显示全部）", () => {
    expect(matchQuery("知足", "")).toBe(false);
    expect(matchQuery("知足", "   ")).toBe(false);
  });

  it("大小写不敏感", () => {
    expect(matchQuery("Mayday", "mayday")).toBe(true);
  });
});
