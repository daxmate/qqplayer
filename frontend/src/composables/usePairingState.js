// 配对状态判定（iOS 壳未连接引导页，2026-08-26）
//
// 契约（与 T4a iOS 壳对齐）：
// - 未连接 = 仅 iOS 壳环境（window.qqplayerNative 存在）且 server 为空
//   （localStorage 的 qqplayer.server 与桥对象 qqplayerIosBridge.server 均空）
// - 桌面浏览器没有 server 是正常同源场景，绝不显示引导页 → 恒 false
// - macOS 壳（qqplayerNative 存在但无 qqplayerIosBridge）也不属于 iOS 未连接场景：
//   server 来自桌面进程内注入，走同一判定（有 server → false；无 server 理论上
//   不该出现，出现也按未连接处理——与 iOS 壳行为一致）
//
// 配对成功后原生注入 server + reload → 引导页自然消失（无需轮询/监听）。

/** 是否处于「iOS 壳已启动但尚未连接桌面端」状态（仅壳环境；桌面浏览器恒 false） */
export function isShellUnpaired() {
  try {
    if (typeof window === "undefined" || !window.qqplayerNative) return false; // 桌面浏览器：正常同源，非未连接
    const ls = localStorage.getItem("qqplayer.server");
    const bridge = window.qqplayerIosBridge?.server;
    return !ls && !bridge;
  } catch {
    return false; // localStorage 不可用等异常场景：不拦主界面
  }
}
