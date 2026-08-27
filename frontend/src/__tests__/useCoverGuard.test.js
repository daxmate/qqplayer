// useCoverGuard 契约测试（P2-A）：zoneMap 映射 + coverVisible 布尔判断
//
// 契约（写死，改实现需同步改这里）：
//   1. zoneMap：large → "showCover"、list → "showListCover"（唯一映射处）
//   2. coverVisible(zone) 严格等于 !!uiSettings[zoneMap[zone]]（开关开/关各测）
import { describe, it, expect, beforeEach } from "vitest";
import { uiSettings } from "../composables/useSettings.js";
import { coverVisible, zoneMap } from "../composables/useCoverGuard.ts";

describe("useCoverGuard 契约：zoneMap 映射 + coverVisible 布尔判断", () => {
  beforeEach(() => {
    uiSettings.showCover = true;
    uiSettings.showListCover = true;
  });

  it("zoneMap 每个 zone 对应正确设置字段（唯一映射处）", () => {
    expect(zoneMap.large).toBe("showCover");
    expect(zoneMap.list).toBe("showListCover");
  });

  it("coverVisible('large') 跟随 showCover：开 → true，关 → false", () => {
    expect(coverVisible("large")).toBe(true);
    uiSettings.showCover = false;
    expect(coverVisible("large")).toBe(false);
    uiSettings.showCover = true;
    expect(coverVisible("large")).toBe(true);
  });

  it("coverVisible('list') 跟随 showListCover：开 → true，关 → false", () => {
    expect(coverVisible("list")).toBe(true);
    uiSettings.showListCover = false;
    expect(coverVisible("list")).toBe(false);
    uiSettings.showListCover = true;
    expect(coverVisible("list")).toBe(true);
  });

  it("两个 zone 相互独立（大封面/列表封面开关互不影响）", () => {
    uiSettings.showCover = false;
    expect(coverVisible("large")).toBe(false);
    expect(coverVisible("list")).toBe(true);

    uiSettings.showCover = true;
    uiSettings.showListCover = false;
    expect(coverVisible("large")).toBe(true);
    expect(coverVisible("list")).toBe(false);
  });
});
