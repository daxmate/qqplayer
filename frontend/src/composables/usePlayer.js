// QQPlayer 播放器组合式函数（barrel 聚合层）
// 原 1970 行单文件按职责拆分（2026-08-13）：
//   playerCore.js — 播放内核（audio/state/播放控制/队列/统计/媒体键/快捷键/面板/库/选歌/nowPlaying/mini/恢复播放/音频事件/均衡器音频图）
//   useSettings.js — 歌词/UI/桌面歌词三套设置 + 主题应用
//   useEq.js       — 均衡器对外 API（预设/滑杆/校验）
//   useLyric.js    — 歌词加载/手动歌词/行定位/跟唱锚点
//   useAbLoop.js   — AB 区间循环 + 单句循环 + 跟唱句末处理
//   useLibrary.js  — 收藏/歌单
// 保留本文件作为聚合出口：现有组件与测试的 import 路径不变；
// 后续新任务直接 import 具体模块（如 AB 循环改 useAbLoop.js）。
export * from "./playerCore.js";
export * from "./uiState.ts";
export * from "./useSettings.js";
export * from "./useEq.js";
export * from "./useLyric.js";
export * from "./useAbLoop.js";
export * from "./useLibrary.js";
