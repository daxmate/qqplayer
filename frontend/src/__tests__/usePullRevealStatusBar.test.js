// 下拉召唤顶部状态条测试（iOS 壳）
// 覆盖：安装条件（仅 iOS 壳）/ 下拉超阈值触发 postMessage / 一次手势只触发一次 /
// 滚动容器不在顶部不触发 / 下拉不足阈值不触发 / 向上滑动不触发 / 手势结束可重新触发 /
// 重复 install 幂等不叠加监听。

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installPullRevealStatusBar } from "../composables/usePullRevealStatusBar.js";

function makeScrollable(top = 0) {
  const el = document.createElement("div");
  el.style.overflowY = "auto";
  el.scrollTop = top;
  document.body.appendChild(el);
  return el;
}

// 派发 touch 事件（冒泡到 document，listener 在 document 上）
function fireTouch(type, clientY, target) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: [{ clientY }] });
  Object.defineProperty(event, "target", { value: target });
  document.dispatchEvent(event);
}

// 一个完整手势序列：start → move（可多次）→ end
function gesture(target, startY, moveYs) {
  fireTouch("touchstart", startY, target);
  for (const y of moveYs) fireTouch("touchmove", y, target);
  fireTouch("touchend", startY, target);
}

describe("installPullRevealStatusBar", () => {
  let uninstall;
  let scroller;

  beforeEach(() => {
    scroller = makeScrollable();
  });

  afterEach(() => {
    uninstall?.();
    uninstall = null;
    scroller.remove();
    delete window.qqplayerIosBridge;
  });

  it("非 iOS 壳不安装监听：下拉不触发 postMessage", () => {
    uninstall = installPullRevealStatusBar(); // 无 qqplayerIosBridge → no-op
    const post = vi.fn();
    window.qqplayerIosBridge = { postMessage: post };
    gesture(scroller, 100, [160]); // 即使之后桥存在也不触发（监听未挂）
    expect(post).not.toHaveBeenCalled();
  });

  it("iOS 壳：滚动容器在顶部 + 下拉超阈值 → postMessage pullRevealStatusBar", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    gesture(scroller, 100, [160]); // dy=60 > 40
    expect(window.qqplayerIosBridge.postMessage).toHaveBeenCalledTimes(1);
    expect(window.qqplayerIosBridge.postMessage).toHaveBeenCalledWith({
      cmd: "pullRevealStatusBar",
    });
  });

  it("一次手势只触发一次（连续 move 不重复发）", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    gesture(scroller, 100, [150, 170, 200]); // 多次超过阈值
    expect(window.qqplayerIosBridge.postMessage).toHaveBeenCalledTimes(1);
  });

  it("手势结束后重新下拉可再次触发", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    gesture(scroller, 100, [160]); // 第一次触发
    gesture(scroller, 100, [170]); // 第二次触发
    expect(window.qqplayerIosBridge.postMessage).toHaveBeenCalledTimes(2);
  });

  it("滚动容器不在顶部（scrollTop>0）→ 不触发", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    scroller.scrollTop = 200;
    gesture(scroller, 100, [160]);
    expect(window.qqplayerIosBridge.postMessage).not.toHaveBeenCalled();
  });

  it("下拉不足阈值（dy<=40）→ 不触发", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    gesture(scroller, 100, [140]); // dy=40 未超过
    expect(window.qqplayerIosBridge.postMessage).not.toHaveBeenCalled();
  });

  it("向上滑动（dy 为负）→ 不触发", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    gesture(scroller, 160, [100]);
    expect(window.qqplayerIosBridge.postMessage).not.toHaveBeenCalled();
  });

  it("重复 install 幂等：不叠加监听（一次手势仍只触发一次）", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    const uninstall2 = installPullRevealStatusBar(); // 第二次应 no-op
    gesture(scroller, 100, [160]);
    expect(window.qqplayerIosBridge.postMessage).toHaveBeenCalledTimes(1);
    uninstall2();
  });

  it("卸载后不再触发", () => {
    window.qqplayerIosBridge = { postMessage: vi.fn() };
    uninstall = installPullRevealStatusBar();
    uninstall();
    gesture(scroller, 100, [160]);
    expect(window.qqplayerIosBridge.postMessage).not.toHaveBeenCalled();
  });
});
