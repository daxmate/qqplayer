// 未连接引导页组件测试（原 iOS 壳未连接场景）
//
// iOS 壳 2026-09-13 退役：isShellUnpaired 判定（usePairingState）与 App.vue 全屏覆盖接入
// 随壳一并移除（引导页在新宿主里不会出现）；本文件保留组件的静态渲染覆盖
// （组件本体暂留仓库，入口已不再挂载）。
import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import NoConnectionView from "../components/NoConnectionView.vue";

describe("NoConnectionView 引导页（静态渲染）", () => {
  it("渲染标题/说明/手动提示/底部说明（默认 zh-CN）", () => {
    const wrapper = mount(NoConnectionView);
    expect(wrapper.find(".nc-title").text()).toBe("未连接桌面端");
    expect(wrapper.find(".nc-desc").text()).toContain("连接桌面端 QQPlayer");
    expect(wrapper.find(".nc-hint").text()).toContain("手动输入 IP");
    expect(wrapper.find(".nc-footer").text()).toContain("本机内容不受影响");
    wrapper.unmount();
  });
});
