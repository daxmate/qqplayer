import { describe, it, expect, vi, beforeEach } from "vitest";
import { uiSettings } from "../composables/useSettings.js";
import {
  COVER_MIN,
  COVER_MAX,
  COVER_DEFAULT,
  centerH,
  vh,
  winW,
  isManual,
  adaptiveSize,
  coverSizePx,
  mobileCoverSize,
  startCoverDrag,
  resetCoverSize,
} from "../composables/useCoverSize.js";

// 重置模块级状态（centerH/vh/winW 是模块级 ref，测试间隔离）
function setEnv(center, viewportH, viewportW) {
  centerH.value = center;
  vh.value = viewportH;
  winW.value = viewportW;
}

describe("useCoverSize 自适应公式", () => {
  beforeEach(() => {
    uiSettings.coverSize = 0;
    uiSettings.showCover = true;
    setEnv(900, 900, 1440);
  });

  it("未测量（首帧）→ 默认 340", () => {
    centerH.value = 0;
    vh.value = 0;
    expect(adaptiveSize.value).toBe(COVER_DEFAULT);
  });

  it("大屏（center 900px）：min(46vh,340) = 340", () => {
    expect(adaptiveSize.value).toBe(340);
  });

  it("小屏（center 481px，1024x768）：保底歌词 220 → 封面 481-220-12=249", () => {
    setEnv(481, 768, 1024);
    expect(adaptiveSize.value).toBe(249);
  });

  it("极端矮窗（center 300px）：下限 140 兜底", () => {
    setEnv(300, 500, 1200);
    expect(adaptiveSize.value).toBe(COVER_MIN);
  });

  it("高窗 46vh 限制生效（vh 1500 → 690，超 340 cap）", () => {
    setEnv(1400, 1500, 1920);
    expect(adaptiveSize.value).toBe(340);
  });
});

describe("useCoverSize 手动模式 + 硬保护", () => {
  beforeEach(() => {
    uiSettings.coverSize = 0;
    uiSettings.showCover = true;
    setEnv(900, 900, 1440);
  });

  it("coverSize>0 → isManual true", () => {
    uiSettings.coverSize = 300;
    expect(isManual.value).toBe(true);
  });

  it("手动 300px → coverSizePx 300", () => {
    uiSettings.coverSize = 300;
    expect(coverSizePx.value).toBe(300);
  });

  it("手动超出范围被 clamp（500 → 420）", () => {
    uiSettings.coverSize = 500;
    expect(coverSizePx.value).toBe(COVER_MAX);
  });

  it("手动低于下限被 clamp（50 → 140）", () => {
    uiSettings.coverSize = 50;
    expect(coverSizePx.value).toBe(COVER_MIN);
  });

  it("手动值受歌词硬保护：center 400 → 上限 400-160-12=228", () => {
    setEnv(400, 700, 1280);
    uiSettings.coverSize = 300;
    expect(coverSizePx.value).toBe(228);
  });

  it("自适应模式 → coverSizePx 跟随 adaptiveSize", () => {
    setEnv(481, 768, 1024);
    expect(coverSizePx.value).toBe(249);
  });
});

describe("useCoverSize 拖拽", () => {
  beforeEach(() => {
    uiSettings.coverSize = 0;
    uiSettings.showCover = true;
    setEnv(900, 900, 1440);
  });

  it("拖拽中实时尺寸生效（向上拖 = 变大）", () => {
    // startCoverDrag 需要 event 对象；用合成 pointerdown
    const e = { clientY: 500, preventDefault: vi.fn() };
    startCoverDrag(e);
    // 模拟 pointermove：上移 100px → dragStartSize(340) + 100 = 440 → clamp 420
    const move = new Event("pointermove");
    Object.defineProperty(move, "clientY", { value: 400 });
    window.dispatchEvent(move);
    expect(coverSizePx.value).toBe(COVER_MAX);
    // 松手提交
    window.dispatchEvent(new Event("pointerup"));
    expect(uiSettings.coverSize).toBe(COVER_MAX);
  });

  it("showCover 关 → 拖拽被忽略", () => {
    uiSettings.showCover = false;
    const e = { clientY: 500, preventDefault: vi.fn() };
    startCoverDrag(e);
    expect(uiSettings.coverSize).toBe(0);
  });
});

describe("useCoverSize 恢复默认 + 移动端映射", () => {
  beforeEach(() => {
    uiSettings.coverSize = 0;
    uiSettings.showCover = true;
    setEnv(900, 900, 1440);
  });

  it("resetCoverSize → 0（回自适应）", () => {
    uiSettings.coverSize = 320;
    resetCoverSize();
    expect(uiSettings.coverSize).toBe(0);
    expect(isManual.value).toBe(false);
  });

  it("移动端自适应（0）→ mobileCoverSize 0（走 CSS 默认）", () => {
    expect(mobileCoverSize.value).toBe(0);
  });

  it("移动端手动 340 → 52vw 基准（390 宽 → 202.8 → 203）", () => {
    uiSettings.coverSize = 340;
    setEnv(900, 900, 390);
    expect(mobileCoverSize.value).toBe(203);
  });

  it("移动端手动 200 → 按比例缩小（390 宽 → 119）", () => {
    uiSettings.coverSize = 200;
    setEnv(900, 900, 390);
    expect(mobileCoverSize.value).toBe(119);
  });
});
