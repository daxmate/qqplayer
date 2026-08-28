// 浏览器环境（无 window.qqplayerNative）no-op 验证：独立文件保证模块全新加载（无壳 init 残留）
// 壳桥接（useNativeCtxMenu）在浏览器里必须零副作用——右键行为完全由现有 @contextmenu.prevent 菜单接管。
import { describe, expect, it } from "vitest";

describe("useNativeCtxMenu 浏览器 no-op", () => {
  it("init 不挂监听、不装 __qqCtxMenu、不产生任何消息", async () => {
    expect(window.qqplayerNative).toBeUndefined();
    const { initNativeCtxMenu } = await import("../composables/useNativeCtxMenu.js");
    initNativeCtxMenu();
    // 浏览器环境：全局 API 未安装
    expect(window.__qqCtxMenu).toBeUndefined();
    // 右键 mousedown 不抛错、不产生 postMessage（浏览器无 webkit 桥，天然不可达）
    const ev = new MouseEvent("mousedown", { bubbles: true, button: 2, clientX: 10, clientY: 10 });
    document.body.dispatchEvent(ev);
    expect(window.webkit).toBeUndefined();
  });
});
