// QQPlayer Tauri 壳（Windows 主目标，Linux 顺带）
//
// 架构对照 macOS Swift 壳（desktop/macOS/main.swift）：
//   - backend.rs  BackendLauncher：探测 17627 → 有外部服务直连（开发模式）/
//     无则 spawn 内置后端（backend/qqplayer-backend[.exe]，PyInstaller onedir）→
//     轮询 /api/settings（0.5s × ≤15s）→ 就绪后建窗；退出只 terminate 自己拉起的
//   - windows.rs 三窗口：main（tauri.conf.json 定义）+ mini（运行时创建）+ lyric（运行时创建），
//     窗口 ✕ → prevent_close + hide（隐藏不退出，对齐 macOS；只有显式退出才退）
//   - commands.rs invoke 命令：start_dragging / pick_library / pick_dict_files / report
//     （report = 三窗口共用消息通道，对齐 macOS "native" 通道，按 msg["type"] 分发）
//   - media.rs   媒体键占位：本期不做原生绑定（WebView2 MediaSession → SMTC 待 spike）
//
// 后端启动时序（对齐 macOS applicationDidFinishLaunching）：
//   后台线程 探测→spawn→健康检查（不阻塞主线程/事件循环），就绪后经 run_on_main_thread
//   回调主线程：显示主窗口 + 建迷你窗/歌词窗 + POST /api/mini/status {"running": true}；
//   失败则弹 tauri-plugin-dialog 错误框（含日志路径）后退出。
//   退出路径（RunEvent::ExitRequested）：POST {"running": false} + backend.terminate()。

mod backend;
mod commands;
mod media;
mod windows;

use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent, WindowEvent};

use backend::{BackendLauncher, BackendStartResult};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(commands::ShellState::default())
        .invoke_handler(tauri::generate_handler![
            commands::start_dragging,
            commands::pick_library,
            commands::pick_dict_files,
            commands::report
        ])
        .setup(|app| {
            // 主窗口运行时创建（conf 不再定义）：builder 才有 on_page_load——页面加载诊断日志，
            // 排查“页面没加载 vs IPC 被拦”关键分叉（conf 创建的窗口无法挂载）。
            // 初始不可见，后端就绪后由 reveal_main 导航（带时间戳防缓存）并显示。
            let main_win = tauri::WebviewWindowBuilder::new(
                app,
                "main",
                tauri::WebviewUrl::External(
                    windows::page_url("")
                        .parse()
                        .expect("invalid backend page url"),
                ),
            )
            .title("QQPlayer")
            .inner_size(1200.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .center()
            .visible(false)
            .on_page_load(|_window, payload| {
                // 页面加载诊断日志（定位“页面没加载 vs IPC 被拦”等启动链路问题）
                crate::backend::launcher_log(&format!(
                    "main page_load: {:?} {}",
                    payload.event(),
                    payload.url()
                ));
            })
            .build()
            .expect("failed to create main window");
            drop(main_win);

            // 后端子进程生命周期托管：启动线程写入、退出路径读取，共用一把锁
            let launcher = Arc::new(Mutex::new(BackendLauncher::new()));
            app.manage(launcher.clone());

            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let result = {
                    let mut guard = launcher.lock().unwrap();
                    guard.start()
                };
                let handle2 = handle.clone();
                let _ = handle.run_on_main_thread(move || {
                    match result {
                        BackendStartResult::External | BackendStartResult::Embedded => {
                            // 就绪后才建迷你窗/歌词窗（主窗口由 conf 创建、visible:false，此处显示）
                            let _ = windows::create_mini(&handle2);
                            let _ = windows::create_lyric(&handle2);
                            windows::reveal_main(&handle2);
                            // 迷你窗状态上报：主页面顶栏迷你按钮靠它点亮（对齐 macOS reportMiniStatus）
                            backend::report_mini_status(true);
                        }
                        BackendStartResult::NoEmbedded
                        | BackendStartResult::SpawnFailed
                        | BackendStartResult::Timeout => {
                            show_backend_failure(&handle2, result);
                            handle2.exit(1);
                        }
                    }
                });
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 窗口 ✕（三窗一致）：prevent_close + hide —— 隐藏不退出（对齐 macOS；
            // 只有显式退出命令/进程终止才退）。隐藏 ≠ 销毁，窗口还在，事件循环不触发退出。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 退出路径：上报迷你窗停止 + 清理自己拉起的后端子进程
            if let RunEvent::ExitRequested { .. } = event {
                backend::report_mini_status(false);
                if let Some(launcher) = app_handle.try_state::<Arc<Mutex<BackendLauncher>>>() {
                    if let Ok(mut guard) = launcher.lock() {
                        guard.terminate();
                    }
                }
            }
        });
}

/// 后端启动失败：弹错误框（含原因 + 日志路径）后由调用方退出（对齐 macOS showBackendFailureAlert）
/// 环境变量 QQPLAYER_NO_DIALOG=1 时跳过弹框直接退出（CI 冒烟用——runner 上无人点对话框，
/// 弹框会永久阻塞；命令行诊断场景也不需要弹框）
fn show_backend_failure(app: &tauri::AppHandle, result: BackendStartResult) {
    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

    let log_hint = format!(
        "日志：{}",
        backend::logs_dir().join("pkg-backend.log").display()
    );
    let detail = match result {
        BackendStartResult::NoEmbedded => {
            format!(
                "本地服务（http://localhost:17627）未响应，且应用目录内未找到内置后端（backend/qqplayer-backend{}）。\n请先启动开发版后端，或使用带内置后端的打包版。",
                if cfg!(windows) { ".exe" } else { "" }
            )
        }
        BackendStartResult::SpawnFailed => "本地服务未响应，且内置后端启动失败。".to_string(),
        BackendStartResult::Timeout => "内置后端已拉起但 15 秒内未就绪。".to_string(),
        BackendStartResult::External | BackendStartResult::Embedded => return, // 正常路径不会进来
    };
    if std::env::var("QQPLAYER_NO_DIALOG").map(|v| v == "1").unwrap_or(false) {
        eprintln!("[qqplayer-shell] 后端启动失败: {detail} {log_hint}");
        // 同时落盘（GUI 应用 stderr 不可见，冒烟脚本靠它拿根因）
        crate::backend::launcher_log(&format!("show_backend_failure(no-dialog): {detail}"));
        return;
    }
    let message = format!("无法连接 QQPlayer 后端服务\n\n{detail}\n{log_hint}\n\n应用即将退出。");
    app.dialog()
        .message(message)
        .title("无法连接 QQPlayer 后端服务")
        .kind(MessageDialogKind::Error)
        .blocking_show();
}
