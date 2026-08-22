//! invoke 命令 + 前端消息分发（对齐 macOS 壳 handleMainMessage / handleMiniMessage）
//!
//! 前端经 `window.__TAURI__.core.invoke` 调用的命令：
//! - `start_dragging`：整窗拖动（透明无边框窗口没有系统标题栏）
//! - `pick_library`：原生选文件夹 → POST /api/library → emit `library-changed`
//! - `pick_dict_files`：原生多选词典文件（不设扩展名过滤，沿用 macOS 约定）→ emit `dict-files`
//! - `report`：三窗口共用的消息通道（对齐 macOS "native" 通道），按 msg["type"] 分发：
//!   openMini / closeMini / restore / lyric / close / resize / nativeDrag /
//!   readerState / ctxState（二期右键菜单预留，本期只存不用）/ qqlog

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Window};

use crate::backend::{logs_dir, post_json, BACKEND_BASE};

// ============ 内存状态（二期右键菜单预留，本期只存不用） ============

/// 阅读器状态（字段对齐 macOS MainWebView.reader* 静态变量）
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct ReaderState {
    pub active: bool,
    pub has_selection: bool,
    pub text: String,
    pub has_highlight: bool,
    pub highlight_style: Option<String>,
}

/// 歌曲列表/侧边栏歌单右键上下文（字段对齐 macOS MainWebView.ctx* 静态变量）
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub struct CtxState {
    pub kind: Option<String>,
    pub path: Option<String>,
    pub song_index: i64,
    pub playlist_id: Option<String>,
    pub song_name: String,
    pub is_fav: bool,
    pub has_path: bool,
    pub can_go_artist: bool,
    pub can_go_album: bool,
}

/// 壳共享状态（tauri manage 托管）
#[derive(Default)]
pub struct ShellState {
    pub reader: Mutex<ReaderState>,
    pub ctx: Mutex<CtxState>,
}

// ============ report 分发（纯逻辑，可单测） ============

/// report 消息解析结果
#[derive(Debug, Clone, PartialEq)]
pub enum ReportAction {
    /// openMini：显示迷你窗 + 隐藏主窗
    OpenMini,
    /// closeMini / restore：隐藏迷你窗 + 显示主窗
    CloseMini,
    /// lyric：show true/false → 显示/隐藏桌面歌词
    Lyric(bool),
    /// close（迷你窗自身）：只隐藏迷你窗
    HideMini,
    /// resize：改迷你窗/歌词窗宽高
    Resize { width: f64, height: f64 },
    /// nativeDrag：整窗拖动
    NativeDrag,
    /// readerState：缓存阅读器状态
    StoreReader(ReaderState),
    /// ctxState：缓存右键上下文
    StoreCtx(CtxState),
    /// qqlog：网页 console 落盘
    Log { level: String, msg: String },
    /// 未知 type / 缺 type / 参数不合法 → 忽略
    Ignore,
}

/// 解析 resize 的 width/height（纯逻辑，可单测）
pub fn parse_resize(msg: &serde_json::Value) -> Option<(f64, f64)> {
    let w = msg.get("width")?.as_f64()?;
    let h = msg.get("height")?.as_f64()?;
    Some((w, h))
}

/// 迷你窗尺寸钳制（对齐 macOS：宽 280..900，高 80..400）
pub fn clamp_mini_size(w: f64, h: f64) -> (f64, f64) {
    (w.clamp(280.0, 900.0), h.clamp(80.0, 400.0))
}

/// 歌词窗尺寸钳制（对齐 macOS：宽 200..1200，高 60..600）
pub fn clamp_lyric_size(w: f64, h: f64) -> (f64, f64) {
    (w.clamp(200.0, 1200.0), h.clamp(60.0, 600.0))
}

/// 解析 readerState 消息
pub fn parse_reader_state(msg: &serde_json::Value) -> ReaderState {
    ReaderState {
        active: msg.get("active").and_then(|v| v.as_bool()).unwrap_or(false),
        has_selection: msg
            .get("hasSelection")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        text: msg
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        has_highlight: msg
            .get("hasHighlight")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        highlight_style: msg
            .get("highlightStyle")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    }
}

/// 解析 ctxState 消息
pub fn parse_ctx_state(msg: &serde_json::Value) -> CtxState {
    CtxState {
        kind: msg.get("kind").and_then(|v| v.as_str()).map(str::to_string),
        path: msg.get("path").and_then(|v| v.as_str()).map(str::to_string),
        song_index: msg.get("songIndex").and_then(|v| v.as_i64()).unwrap_or(-1),
        playlist_id: msg
            .get("playlistId")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        song_name: msg
            .get("songName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        is_fav: msg.get("isFav").and_then(|v| v.as_bool()).unwrap_or(false),
        has_path: msg
            .get("hasPath")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        can_go_artist: msg
            .get("canGoArtist")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        can_go_album: msg
            .get("canGoAlbum")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
    }
}

/// type → ReportAction 映射（纯逻辑，可单测）
pub fn classify_report(msg: &serde_json::Value) -> ReportAction {
    let Some(kind) = msg.get("type").and_then(|v| v.as_str()) else {
        return ReportAction::Ignore;
    };
    match kind {
        "openMini" => ReportAction::OpenMini,
        "closeMini" | "restore" => ReportAction::CloseMini,
        "lyric" => ReportAction::Lyric(msg.get("show").and_then(|v| v.as_bool()).unwrap_or(false)),
        "close" => ReportAction::HideMini,
        "resize" => match parse_resize(msg) {
            Some((width, height)) => ReportAction::Resize { width, height },
            None => ReportAction::Ignore,
        },
        "nativeDrag" => ReportAction::NativeDrag,
        "readerState" => ReportAction::StoreReader(parse_reader_state(msg)),
        "ctxState" => ReportAction::StoreCtx(parse_ctx_state(msg)),
        "qqlog" => ReportAction::Log {
            level: msg
                .get("level")
                .and_then(|v| v.as_str())
                .unwrap_or("log")
                .to_string(),
            msg: msg
                .get("msg")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        },
        _ => ReportAction::Ignore,
    }
}

// ============ 命令 ============

/// 整窗拖动：前端 pointerdown 过滤控件后调用（与 macOS 壳 useShellDrag.js → performDrag 同构）
#[tauri::command]
pub fn start_dragging(window: Window) {
    let _ = window.start_dragging();
}

/// 原生选文件夹 → POST /api/library → 成功后 emit `library-changed` 给 main 窗口
/// （对齐 macOS pickLibrary / setLibrary / notifyFrontendLibraryChanged）
#[tauri::command]
pub async fn pick_library(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app2.dialog().file().blocking_pick_folder()
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(path) = picked.and_then(|p| p.into_path().ok()) else {
        return Ok(()); // 用户取消
    };
    let path_str = path.to_string_lossy().to_string();
    let ok = post_json(
        &format!("{BACKEND_BASE}/api/library"),
        &serde_json::json!({ "path": path_str }),
    );
    if ok {
        let _ = app.emit_to(
            "main",
            "library-changed",
            serde_json::json!({ "path": path_str }),
        );
    }
    Ok(())
}

/// 原生多选词典文件（不设扩展名过滤，沿用 macOS 约定：前端按 accept/扩展名自行过滤）
/// → emit `dict-files` 给 main 窗口，payload `{ "paths": ["..."] }`（取消 → 空数组）
#[tauri::command]
pub async fn pick_dict_files(app: AppHandle) -> Result<(), String> {
    let app2 = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || {
        use tauri_plugin_dialog::DialogExt;
        app2.dialog().file().blocking_pick_files()
    })
    .await
    .map_err(|e| e.to_string())?;

    let paths: Vec<String> = picked
        .unwrap_or_default()
        .into_iter()
        .filter_map(|p| p.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    let _ = app.emit_to("main", "dict-files", serde_json::json!({ "paths": paths }));
    Ok(())
}

/// 三窗口共用的消息通道：按 msg["type"] 分发（对齐 macOS handleMainMessage / handleMiniMessage）
#[tauri::command]
pub fn report(app: AppHandle, window: Window, msg: serde_json::Value) {
    match classify_report(&msg) {
        ReportAction::OpenMini => {
            crate::windows::show_window(&app, "mini");
            crate::windows::hide_window(&app, "main");
            // 迷你窗实际显示才点亮主页面顶栏开关（对齐 macOS showMiniPanel）
            crate::backend::report_mini_status(true);
        }
        ReportAction::CloseMini => {
            crate::windows::hide_window(&app, "mini");
            crate::windows::show_window(&app, "main");
            // 迷你窗隐藏 → 开关熄灭（对齐 macOS hideMiniPanel）
            crate::backend::report_mini_status(false);
        }
        ReportAction::Lyric(show) => {
            if show {
                crate::windows::show_window(&app, "lyric");
            } else {
                crate::windows::hide_window(&app, "lyric");
            }
        }
        ReportAction::HideMini => {
            crate::windows::hide_window(&app, "mini");
            // 迷你窗自身关闭（✕/双击）→ 开关熄灭（对齐 macOS hideMiniPanel）
            crate::backend::report_mini_status(false);
        }
        ReportAction::Resize { width, height } => {
            // 缩放目标 = 发出消息的窗口（迷你窗或歌词窗，对齐 macOS 按窗口路由 resize）
            let label = window.label();
            let target = if matches!(label, "mini" | "lyric") {
                label
            } else {
                "mini"
            };
            let (w, h) = if target == "lyric" {
                clamp_lyric_size(width, height)
            } else {
                clamp_mini_size(width, height)
            };
            if let Some(win) = app.get_webview_window(target) {
                let _ = win.set_size(tauri::LogicalSize::new(w, h));
            }
        }
        ReportAction::NativeDrag => {
            let _ = window.start_dragging();
        }
        ReportAction::StoreReader(state) => {
            if let Some(s) = app.try_state::<ShellState>() {
                if let Ok(mut r) = s.reader.lock() {
                    *r = state;
                }
            }
        }
        ReportAction::StoreCtx(state) => {
            if let Some(s) = app.try_state::<ShellState>() {
                if let Ok(mut c) = s.ctx.lock() {
                    *c = state;
                }
            }
        }
        ReportAction::Log { level, msg } => append_webview_log(&level, &msg),
        ReportAction::Ignore => {}
    }
}

/// 网页 console 落盘：`<logs>/webview-console.log`，格式 `[level] msg\n`
/// （对齐 macOS qqlog 处理）
fn append_webview_log(level: &str, msg: &str) {
    use std::io::Write;
    let path = logs_dir().join("webview-console.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(f, "[{level}] {msg}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classify_report_maps_types() {
        assert_eq!(
            classify_report(&json!({"type": "openMini"})),
            ReportAction::OpenMini
        );
        // closeMini 与 restore 行为一致（隐藏迷你窗 + 显示主窗）
        assert_eq!(
            classify_report(&json!({"type": "closeMini"})),
            ReportAction::CloseMini
        );
        assert_eq!(
            classify_report(&json!({"type": "restore"})),
            ReportAction::CloseMini
        );
        assert_eq!(
            classify_report(&json!({"type": "close"})),
            ReportAction::HideMini
        );
        assert_eq!(
            classify_report(&json!({"type": "nativeDrag"})),
            ReportAction::NativeDrag
        );
        // lyric：show 缺省 → false（隐藏）
        assert_eq!(
            classify_report(&json!({"type": "lyric", "show": true})),
            ReportAction::Lyric(true)
        );
        assert_eq!(
            classify_report(&json!({"type": "lyric", "show": false})),
            ReportAction::Lyric(false)
        );
        assert_eq!(
            classify_report(&json!({"type": "lyric"})),
            ReportAction::Lyric(false)
        );
        // resize
        assert_eq!(
            classify_report(&json!({"type": "resize", "width": 400, "height": 160})),
            ReportAction::Resize {
                width: 400.0,
                height: 160.0
            }
        );
        assert_eq!(
            classify_report(&json!({"type": "resize"})),
            ReportAction::Ignore
        );
        assert_eq!(
            classify_report(&json!({"type": "resize", "width": "x", "height": 1})),
            ReportAction::Ignore
        );
        // 未知 / 缺 type
        assert_eq!(
            classify_report(&json!({"type": "no-such-type"})),
            ReportAction::Ignore
        );
        assert_eq!(classify_report(&json!({"foo": 1})), ReportAction::Ignore);
        assert_eq!(classify_report(&json!(null)), ReportAction::Ignore);
    }

    #[test]
    fn classify_report_reader_state() {
        let action = classify_report(&json!({
            "type": "readerState",
            "active": true,
            "hasSelection": true,
            "text": "hello world",
            "hasHighlight": false,
            "highlightStyle": null
        }));
        match action {
            ReportAction::StoreReader(s) => {
                assert!(s.active);
                assert!(s.has_selection);
                assert_eq!(s.text, "hello world");
                assert!(!s.has_highlight);
                assert_eq!(s.highlight_style, None);
            }
            other => panic!("期望 StoreReader，实际 {other:?}"),
        }
        // highlightStyle 有值时解析
        let action =
            classify_report(&json!({"type": "readerState", "highlightStyle": "underline"}));
        match action {
            ReportAction::StoreReader(s) => {
                assert_eq!(s.highlight_style.as_deref(), Some("underline"))
            }
            other => panic!("期望 StoreReader，实际 {other:?}"),
        }
    }

    #[test]
    fn classify_report_ctx_state() {
        let action = classify_report(&json!({
            "type": "ctxState",
            "kind": "song",
            "path": "/music/a.mp3",
            "songIndex": 3,
            "playlistId": "pl-1",
            "songName": "歌名",
            "isFav": true,
            "hasPath": true,
            "canGoArtist": true,
            "canGoAlbum": false
        }));
        match action {
            ReportAction::StoreCtx(s) => {
                assert_eq!(s.kind.as_deref(), Some("song"));
                assert_eq!(s.path.as_deref(), Some("/music/a.mp3"));
                assert_eq!(s.song_index, 3);
                assert_eq!(s.playlist_id.as_deref(), Some("pl-1"));
                assert_eq!(s.song_name, "歌名");
                assert!(s.is_fav);
                assert!(s.has_path);
                assert!(s.can_go_artist);
                assert!(!s.can_go_album);
            }
            other => panic!("期望 StoreCtx，实际 {other:?}"),
        }
        // kind 为 null（空白区右键）→ 清空上下文
        let action = classify_report(&json!({"type": "ctxState", "kind": null}));
        match action {
            ReportAction::StoreCtx(s) => assert_eq!(s.kind, None),
            other => panic!("期望 StoreCtx，实际 {other:?}"),
        }
    }

    #[test]
    fn classify_report_qqlog() {
        let action = classify_report(&json!({"type": "qqlog", "level": "warn", "msg": "hi"}));
        match action {
            ReportAction::Log { level, msg } => {
                assert_eq!(level, "warn");
                assert_eq!(msg, "hi");
            }
            other => panic!("期望 Log，实际 {other:?}"),
        }
        // level/msg 缺省
        let action = classify_report(&json!({"type": "qqlog"}));
        match action {
            ReportAction::Log { level, msg } => {
                assert_eq!(level, "log");
                assert_eq!(msg, "");
            }
            other => panic!("期望 Log，实际 {other:?}"),
        }
    }

    #[test]
    fn parse_resize_extracts_width_height() {
        assert_eq!(
            parse_resize(&json!({"width": 400, "height": 160})),
            Some((400.0, 160.0))
        );
        assert_eq!(parse_resize(&json!({"width": 400})), None);
        assert_eq!(parse_resize(&json!({"height": 160})), None);
        assert_eq!(parse_resize(&json!({"width": "x", "height": 1})), None);
        assert_eq!(parse_resize(&json!({})), None);
        // 整数也接受（serde_json 数字统一 as_f64）
        assert_eq!(
            parse_resize(&json!({"width": 400.5, "height": 140})),
            Some((400.5, 140.0))
        );
    }

    #[test]
    fn clamp_mini_size_bounds() {
        assert_eq!(clamp_mini_size(9999.0, 9999.0), (900.0, 400.0));
        assert_eq!(clamp_mini_size(1.0, 1.0), (280.0, 80.0));
        assert_eq!(clamp_mini_size(380.0, 140.0), (380.0, 140.0));
    }

    #[test]
    fn clamp_lyric_size_bounds() {
        assert_eq!(clamp_lyric_size(9999.0, 9999.0), (1200.0, 600.0));
        assert_eq!(clamp_lyric_size(1.0, 1.0), (200.0, 60.0));
        assert_eq!(clamp_lyric_size(460.0, 140.0), (460.0, 140.0));
    }
}
