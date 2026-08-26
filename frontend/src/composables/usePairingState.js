// 配对状态判定（iOS 壳未连接引导页，2026-08-26；8-26 深夜修复 macOS 壳误判）
//
// 契约（与 T4a iOS 壳对齐）：
// - 未连接 = 仅 iOS 壳环境（window.qqplayerIosBridge 存在）且 server 为空
//   （localStorage 的 qqplayer.server 与桥对象 qqplayerIosBridge.server 均空）
// - 桌面浏览器没有 server 是正常同源场景，绝不显示引导页 → 恒 false
// - macOS 壳只注入 window.qqplayerNative（不含 qqplayerIosBridge，server 不写
//   localStorage），必须排除——否则被误判未连接、全屏引导页挡住桌面版（2026-08-26 真机事故）
//
// 配对成功后 iOS 原生注入 server + reload → 引导页自然消失（无需轮询/监听）。

/** 是否处于「iOS 壳已启动但尚未连接桌面端」状态（仅 iOS 壳；桌面浏览器/macOS 壳恒 false） */
export function isShellUnpaired() {
  try {
    // iOS 壳专属桥标记：macOS 壳（仅 qqplayerNative）与桌面浏览器都无此桥 → 不拦截
    if (typeof window === "undefined" || !window.qqplayerIosBridge) return false;
    const ls = localStorage.getItem("qqplayer.server");
    const bridge = window.qqplayerIosBridge?.server;
    return !ls && !bridge;
  } catch {
    return false; // localStorage 不可用等异常场景：不拦主界面
  }
}
