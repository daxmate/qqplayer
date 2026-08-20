// App.vue 面板圆角规则回归测试
// 兜底：纯 CSS 视觉规则（jsdom 无法断言 computed style），这里直接断言源码中
// 关键组合规则存在且值正确，防止未来重构圆角逻辑时误删/误改。
import { describe, expect, it } from "vitest";
import AppSource from "../App.vue?raw";

// 提取 <style> 块内容（scoped 样式）
const styleMatch = AppSource.match(/<style[^>]*>([\s\S]*?)<\/style>/);
const style = styleMatch ? styleMatch[1] : "";

// 规范化：去掉注释和空白，方便断言
const compact = style.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");

function ruleFor(selector) {
  // 在规范化的样式中定位 "selector" 出现位置，取其后第一个 {...} 块
  const sel = selector.startsWith(".") ? selector : "." + selector;
  const idx = compact.indexOf(sel);
  if (idx === -1) return null;
  const open = compact.indexOf("{", idx);
  if (open === -1) return null;
  const close = compact.indexOf("}", open);
  if (close === -1) return null;
  return compact.slice(open + 1, close).trim();
}

describe("App.vue 面板圆角规则", () => {
  it("控制区收起 + 有边栏时歌词面板右下角为圆角（贴窗口底边）", () => {
    // 连播模式：has-music + no-controls
    const rule = ruleFor("main.continuous.has-music.no-controls .lyric-panel");
    expect(rule).not.toBeNull();
    expect(rule).toContain("border-radius: 0 16px 16px 0");
  });

  it("控制区收起 + 有播放列表时歌词面板右下角为圆角", () => {
    const rule = ruleFor("main.continuous.has-playlist.no-controls .lyric-panel");
    expect(rule).not.toBeNull();
    expect(rule).toContain("border-radius: 0 16px 16px 0");
  });

  it("跟唱模式：控制区收起 + 有边栏时歌词面板右下角为圆角", () => {
    const rule = ruleFor("main.karaoke.has-music.no-controls .karaoke-panel");
    expect(rule).not.toBeNull();
    expect(rule).toContain("border-radius: 0 16px 16px 0");
  });

  it("有边栏但控制条显示时歌词面板右下角保持直角（与控制条交汇）", () => {
    const rule = ruleFor("main.continuous.has-music .lyric-panel");
    expect(rule).not.toBeNull();
    expect(rule).toContain("border-radius: 0 16px 0 0");
  });
});
