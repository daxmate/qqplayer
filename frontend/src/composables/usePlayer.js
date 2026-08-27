// QQPlayer 播放器组合式函数（barrel 聚合层）
// 原 1970 行单文件按职责拆分（2026-08-13）：
//   playerState.ts — 播放器核心状态（state/playbackSettings 单例 + 共享类型）
//   audioEngine.ts — 音频域（audio 元素/均衡器音频图/音量/切歌淡入淡出/音频事件）
//   queueEngine.ts — 队列域（队列/连播模式/歌曲列表/队列顺序/自动刷新/流媒体/选歌/iOS 本地优先）
//   playbackEngine.ts — 播放域（播放设置归一化/模式记忆/toast/播放会话/播放控制/恢复播放/跟唱 ticker）
//   shortcuts.ts — 键盘快捷键
//   mediaSession.ts — 系统媒体键（MediaSession + iOS 远端命令/原生切歌跟随）
//   miniControl.ts — 迷你窗/桌面歌词
//   useSettings.js — 歌词/UI/桌面歌词三套设置 + 主题应用
//   useEq.js       — 均衡器对外 API（预设/滑杆/校验）
//   useLyric.js    — 歌词加载/手动歌词/行定位/跟唱锚点
//   useAbLoop.js   — AB 区间循环 + 单句循环 + 跟唱句末处理
//   useLibrary.js  — 收藏/歌单
// 保留本文件作为聚合出口：现有组件与测试的 import 路径不变；
// 后续新任务直接 import 具体模块（如 AB 循环改 useAbLoop.js）。
// 注：多域重名导出已逐个核对（_reset*/setup*/stop* 系列均互不重名，见 P1-2 批次2 报告），
// export * 无歧义覆盖。
export * from "./playerState.ts";
export * from "./audioEngine.ts";
export * from "./queueEngine.ts";
export * from "./playbackEngine.ts";
export * from "./shortcuts.ts";
export * from "./mediaSession.ts";
export * from "./miniControl.ts";
export * from "./uiState.ts";
export * from "./useSettings.js";
export * from "./useEq.js";
export * from "./useLyric.js";
export * from "./useAbLoop.js";
export * from "./useLibrary.js";
