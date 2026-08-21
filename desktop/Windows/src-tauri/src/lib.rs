// QQPlayer Tauri 壳（Windows 主目标，Linux 顺带）
//
// 架构对照 macOS Swift 壳（desktop/macOS/main.swift）：
//   - BackendLauncher 契约：探测 17627 → 有外部服务直连（开发模式）/
//     无则 spawn 内置后端（PyInstaller onedir）→ 轮询 /api/settings → 建窗
//   - 三窗口：main（主窗）+ mini（迷你）+ lyric（歌词），事件按窗口路由
//   - 前端桥接：window.__TAURI__ 探测（vs macOS webkit.messageHandlers）
//
// 阶段 3 待实现（见任务包）：BackendLauncher、三窗口创建、事件路由、
// 媒体键 spike（WebView MediaSession → SMTC 自动桥接验证）。

use tauri::Manager;

/// 迷你窗/歌词窗整窗拖动：前端 pointerdown 过滤控件后调此命令
/// （与 macOS 壳 useShellDrag.js → performDrag 同构）
#[tauri::command]
fn start_dragging(window: tauri::Window) {
    let _ = window.start_dragging();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![start_dragging])
        .setup(|app| {
            // 阶段 3：BackendLauncher::start(app) —— 探测/spawn 内置后端 + 健康检查
            Ok(())
        })
        .on_window_event(|window, event| {
            // 阶段 3：迷你窗 ✕/歌词窗 ✕ = 隐藏不退出（对齐 macOS 行为）
            let _ = (window, event);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
