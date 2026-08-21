//! 媒体键（Windows SMTC）——本期占位，不做原生绑定
//!
//! 背景：macOS 壳用 MediaPlayer 框架（MPRemoteCommandCenter + MPNowPlayingInfoCenter）绑定
//! 系统媒体键/控制中心。Windows 侧对应的是 SMTC（System Media Transport Controls，
//! Windows.Media.Control / GlobalSystemMediaTransportControlsSession）。
//!
//! 本期决策：**不做原生媒体键绑定**。
//! WebView2 基于 Chromium，页面 MediaSession API（navigator.mediaSession）预期会被
//! WebView2 自动桥接到 Windows SMTC（Chromium 在 Windows 上默认集成 SMTC）。
//! 待 spike 验证：
//!   1. 前端设 MediaMetadata / setActionHandler（play/pause/next/prev/seek）后，
//!      系统媒体浮层（Win+K 媒体控制）是否自动出现并可操作
//!   2. 若验证失败（WebView2 未桥接 SMTC），需自写 SMTC 绑定：
//!      - 引入 `windows` crate（Windows.Media.Control 等 WinRT API），
//!        轮询 GlobalSystemMediaTransportControlsSession 播放状态 + 处理按钮事件
//!      - 届时在本模块实现，lib.rs 注册回调，命令经 POST /api/player/action 转发
//!        （对齐 macOS sendAction：play/pause/togglePlay/next/prev/seek）
//!
//! 注意：不要引入 windows crate（本期不写原生绑定），依赖保持轻量。
