//! 三窗口：main（tauri.conf.json 定义，可见性由就绪回调控制）+ mini（运行时创建）+ lyric（运行时创建）
//!
//! 对齐 macOS 壳（desktop/macOS/main.swift）：
//! - 迷你窗：无边框/透明/置顶/不占任务栏/不可缩放，380×140，加载 /mini.html
//! - 桌面歌词：无边框/透明/置顶/不占任务栏/可缩放，460×140，加载 /desktop-lyric.html
//! - URL 带时间戳防缓存：WebView2 同 WKWebView 会缓存页面（macOS 壳的教训）
//! - 窗口 ✕ 由 lib.rs 的 on_window_event 统一处理（prevent_close + hide，隐藏不退出）
//! - mini 窗口整体拖动：前端调 start_dragging 命令（透明无边框窗口没有系统标题栏）

use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::backend::{launcher_log, BACKEND_BASE};

/// 当前 unix 时间戳（URL 防缓存参数 v=）
pub fn cache_buster() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "0".to_string())
}

/// 后端页面 URL（附时间戳防 WebView2 磁盘缓存）
pub fn page_url(page: &str) -> String {
    format!("{BACKEND_BASE}/{page}?v={}", cache_buster())
}

/// 运行时创建迷你窗（label "mini"）。初始隐藏，等前端 openMini / restore 调起。
pub fn create_mini(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        "mini",
        WebviewUrl::External(page_url("mini.html").parse().unwrap()),
    )
    .title("QQPlayer 迷你窗")
    .inner_size(380.0, 140.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false) // 无边框透明窗默认 shadow=true 会带 1px 白边 + Win11 圆角（对齐 macOS 壳纯透明）
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;
    Ok(())
}

/// 运行时创建桌面歌词窗（label "lyric"）。初始隐藏，等前端 lyric 开关调起。
pub fn create_lyric(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(
        app,
        "lyric",
        WebviewUrl::External(page_url("desktop-lyric.html").parse().unwrap()),
    )
    .title("QQPlayer 桌面歌词")
    .inner_size(460.0, 140.0)
    .resizable(true)
    .decorations(false)
    .transparent(true)
    .shadow(false) // 无边框透明窗默认 shadow=true 会带 1px 白边 + Win11 圆角（对齐 macOS 壳纯透明）
    .always_on_top(true)
    .skip_taskbar(true)
    .visible(false)
    .build()?;
    Ok(())
}

/// 显示窗口（存在才动）
pub fn show_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 隐藏窗口（存在才动）
pub fn hide_window(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.hide();
    }
}

/// 后端就绪回调：显示主窗口（conf 里 visible:false，避免后端未起时闪现加载失败页）。
/// dev 与 release 模式都导航到后端源：前端全部用相对路径 fetch（/api/library 等），
/// release 下从 tauri://localhost 资源协议加载会把请求打到资源服务器，SPA 回退返回
/// index.html（`<!doctype html>`）导致解析报错；后端 StaticFiles html=True 在 / 返回
/// index.html，内容与打包 dist 一致。WebView2 会缓存页面 → 带新时间戳重导航。
pub fn reveal_main(app: &AppHandle) {
    let Some(main) = app.get_webview_window("main") else {
        return;
    };
    let url = page_url("");
    launcher_log(&format!("reveal_main: navigate main -> {url}"));
    if let Ok(u) = url.parse() {
        let _ = main.navigate(u);
    }
    let _ = main.show();
    let _ = main.set_focus();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_buster_is_numeric() {
        let v = cache_buster();
        assert!(v.parse::<u64>().is_ok(), "时间戳应为纯数字: {v}");
    }

    #[test]
    fn page_url_has_timestamp_and_page() {
        let url = page_url("mini.html");
        assert!(
            url.starts_with("http://127.0.0.1:17627/mini.html?v="),
            "URL 结构不对: {url}"
        );
        let v = url.split("v=").nth(1).unwrap();
        assert!(v.parse::<u64>().is_ok());
    }
}
