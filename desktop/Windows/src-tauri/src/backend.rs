//! 后端子进程生命周期（打包版自包含，契约照搬 macOS 壳 desktop/macOS/main.swift 的 BackendLauncher）
//!
//! 启动契约：
//!   1. probe_external()：GET http://localhost:17627/api/settings，1.5s 超时，HTTP 200 即认为外部服务在跑
//!   2. 无外部服务 → 找内置后端：可执行文件同目录 `backend/qqplayer-backend`（Windows 是 `.exe`）→ spawn
//!   3. wait_ready()：0.5s 间隔轮询 /api/settings，最多 15s
//!   4. terminate()：只杀自己拉起的（spawn 成功才记录 pid）；Windows 用 taskkill /T /F 杀进程树
//!      （PyInstaller 后端可能带子进程，裸 kill 只杀父）；其他平台 SIGTERM 等 2s 再 SIGKILL
//!
//! 外部服务（开发模式）绝不 terminate——退出只清理自己拉起的子进程。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

/// 后端服务基址（FastAPI，localhost:17627）
pub const BACKEND_BASE: &str = "http://localhost:17627";
/// 健康检查探针路径
const PROBE_PATH: &str = "/api/settings";
/// 外部服务探测超时
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
/// 内置后端健康检查总超时
const READY_TIMEOUT: Duration = Duration::from_secs(15);
/// Windows CREATE_NO_WINDOW：spawn 的子进程不弹控制台窗口
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 后端启动结果（对齐 macOS BackendStartResult）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendStartResult {
    /// 外部服务（开发模式）在跑 → 直连，不 spawn
    External,
    /// 内置后端已拉起并通过健康检查
    Embedded,
    /// 无外部服务且应用目录内无内置后端
    NoEmbedded,
    /// 内置后端 spawn 失败
    SpawnFailed,
    /// 内置后端 15s 内未就绪
    Timeout,
}

/// 内置后端文件名（平台相关：Windows 带 .exe，其余无后缀）
pub fn backend_exe_name() -> &'static str {
    if cfg!(windows) {
        "qqplayer-backend.exe"
    } else {
        "qqplayer-backend"
    }
}

/// 在给定可执行文件目录下找内置后端：`<exe_dir>/backend/qqplayer-backend[.exe]`
pub fn embedded_backend_path_in(exe_dir: &Path) -> Option<PathBuf> {
    let path = exe_dir.join("backend").join(backend_exe_name());
    path.is_file().then_some(path)
}

/// 当前可执行文件同目录的内置后端路径（std::env::current_exe() 的父目录 + backend/）
pub fn embedded_backend_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    embedded_backend_path_in(dir)
}

/// QQPlayer 数据目录（日志等）：
/// - Windows: `%LOCALAPPDATA%/QQPlayer`（回退 USERPROFILE\AppData\Local\QQPlayer）
/// - 其他: `$XDG_DATA_HOME/QQPlayer`（未设则 `$HOME/.local/share/QQPlayer`）
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            if !local.is_empty() {
                return PathBuf::from(local).join("QQPlayer");
            }
        }
        if let Ok(profile) = std::env::var("USERPROFILE") {
            if !profile.is_empty() {
                return PathBuf::from(profile)
                    .join("AppData")
                    .join("Local")
                    .join("QQPlayer");
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
            if !xdg.is_empty() {
                return PathBuf::from(xdg).join("QQPlayer");
            }
        }
        if let Ok(home) = std::env::var("HOME") {
            if !home.is_empty() {
                return PathBuf::from(home)
                    .join(".local")
                    .join("share")
                    .join("QQPlayer");
            }
        }
    }
    PathBuf::from(".").join("QQPlayer")
}

/// 日志目录 `<data_dir>/logs`（不存在先创建）
pub fn logs_dir() -> PathBuf {
    let dir = data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// GET 探针：目标返回 HTTP 200 即认为服务存活（连接拒绝/超时/非 200 都算不活）
fn probe_alive(url: &str, timeout: Duration) -> bool {
    match ureq::get(url).timeout(timeout).call() {
        Ok(resp) => resp.status() == 200,
        Err(ureq::Error::Status(code, _)) => code == 200,
        Err(_) => false,
    }
}

/// POST JSON（忽略响应体，仅关心是否 2xx 成功）
pub fn post_json(url: &str, body: &serde_json::Value) -> bool {
    match ureq::post(url)
        .timeout(Duration::from_secs(3))
        .send_json(body)
    {
        Ok(resp) => resp.status() == 200,
        Err(ureq::Error::Status(code, _)) => code == 200,
        Err(_) => false,
    }
}

/// 迷你窗状态上报（主页面顶栏开关轮询点亮/熄灭，对齐 macOS reportMiniStatus）
pub fn report_mini_status(running: bool) {
    let _ = post_json(
        &format!("{BACKEND_BASE}/api/mini/status"),
        &serde_json::json!({ "running": running }),
    );
}

// ---- 子进程杀法（平台差异） ----

/// 杀掉 pid 对应的进程：
/// - Windows: `taskkill /PID <pid> /T /F`（/T 杀进程树——PyInstaller 后端可能带子进程）
/// - 其他: SIGTERM → 等 2s → SIGKILL（对齐 macOS terminateSpawned）
#[cfg(windows)]
fn kill_pid(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        // taskkill 自身也是控制台程序，加 CREATE_NO_WINDOW 防止它的窗口闪现
        .creation_flags(CREATE_NO_WINDOW)
        .status();
}

#[cfg(not(windows))]
fn kill_pid(pid: u32) {
    let _ = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
    std::thread::sleep(Duration::from_secs(2));
    let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
}

/// 回收子进程（防僵尸）；限时等不到就强杀兜底
fn reap_child(child: &mut Child) {
    let deadline = std::time::Instant::now() + Duration::from_secs(3);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return;
            }
        }
    }
}

/// 后端子进程生命周期管理
///
/// 线程安全：启动在后台线程执行，退出路径（主线程）调用 terminate()，
/// 因此整体包在 Mutex 里由 lib.rs 以 `Arc<Mutex<BackendLauncher>>` 托管。
pub struct BackendLauncher {
    /// 自己拉起的子进程（spawn 成功才记录；外部服务不在此列）
    spawned: Option<Child>,
}

impl Default for BackendLauncher {
    fn default() -> Self {
        Self::new()
    }
}

impl BackendLauncher {
    pub fn new() -> Self {
        Self { spawned: None }
    }

    fn probe_url(&self) -> String {
        format!("{BACKEND_BASE}{PROBE_PATH}")
    }

    /// 探测外部服务：GET /api/settings，1.5s 超时；200 即认为在跑
    pub fn probe_external(&self) -> bool {
        probe_alive(&self.probe_url(), PROBE_TIMEOUT)
    }

    /// 拉起内置后端：env 继承；stdout/stderr → `<logs>/pkg-backend.log`（目录不存在先建）
    fn launch_embedded(&mut self, exe: &Path) -> Option<()> {
        let log_path = logs_dir().join("pkg-backend.log");
        let log_file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&log_path)
            .ok()?;
        let err_file = log_file.try_clone().ok()?;

        let mut cmd = Command::new(exe);
        cmd.current_dir(exe.parent().unwrap_or_else(|| Path::new(".")));
        cmd.stdout(Stdio::from(log_file));
        cmd.stderr(Stdio::from(err_file));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let child = cmd.spawn().ok()?;
        self.spawned = Some(child);
        Some(())
    }

    /// 健康检查：0.5s 间隔轮询 /api/settings，最多 timeout 秒
    pub fn wait_ready(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        loop {
            if self.probe_external() {
                return true;
            }
            if std::time::Instant::now() >= deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
    }

    /// 启动编排：探测 → 有外部服务直连 / 无则 spawn 内置 + 健康检查
    pub fn start(&mut self) -> BackendStartResult {
        if self.probe_external() {
            return BackendStartResult::External;
        }
        let Some(exe) = embedded_backend_path() else {
            return BackendStartResult::NoEmbedded;
        };
        if self.launch_embedded(&exe).is_none() {
            return BackendStartResult::SpawnFailed;
        }
        if self.wait_ready(READY_TIMEOUT) {
            BackendStartResult::Embedded
        } else {
            BackendStartResult::Timeout
        }
    }

    /// 退出清理：只杀自己拉起的（spawned 非 None 才动），外部服务绝不碰
    pub fn terminate(&mut self) {
        let Some(mut child) = self.spawned.take() else {
            return;
        };
        kill_pid(child.id());
        reap_child(&mut child);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "qqp-tauri-test-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn backend_exe_name_platform_suffix() {
        let name = backend_exe_name();
        assert!(name.starts_with("qqplayer-backend"), "名字前缀不对: {name}");
        #[cfg(windows)]
        assert!(name.ends_with(".exe"), "Windows 需带 .exe 后缀: {name}");
        #[cfg(not(windows))]
        assert!(
            !name.ends_with(".exe"),
            "非 Windows 不应带 .exe 后缀: {name}"
        );
    }

    /// 内置后端路径解析：同目录同时放带/不带 .exe 两个文件时，按平台选正确的那个
    #[test]
    fn embedded_backend_path_resolves_platform_name() {
        let tmp = unique_temp_dir("resolve");
        let backend_dir = tmp.join("backend");
        std::fs::create_dir_all(&backend_dir).unwrap();
        std::fs::write(backend_dir.join("qqplayer-backend"), b"x").unwrap();
        std::fs::write(backend_dir.join("qqplayer-backend.exe"), b"x").unwrap();

        let resolved = embedded_backend_path_in(&tmp).expect("应解析到内置后端路径");
        #[cfg(windows)]
        assert_eq!(
            resolved.file_name().and_then(|n| n.to_str()),
            Some("qqplayer-backend.exe"),
            "Windows 应优先 .exe"
        );
        #[cfg(not(windows))]
        assert_eq!(
            resolved.file_name().and_then(|n| n.to_str()),
            Some("qqplayer-backend"),
            "非 Windows 不应带 .exe"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn embedded_backend_path_missing_returns_none() {
        let tmp = unique_temp_dir("missing");
        assert_eq!(embedded_backend_path_in(&tmp), None);
        // 目录存在但没有 backend/ 子目录
        let dir = tmp.join("nested");
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(embedded_backend_path_in(&dir), None);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn embedded_backend_path_uses_current_exe_parent() {
        // 冒烟：跟随 current_exe() 的父目录解析，不应 panic；测试环境大概率无内置后端 → None
        let _ = embedded_backend_path();
    }

    #[test]
    fn data_dir_points_to_qqplayer() {
        let dir = data_dir();
        assert!(
            dir.ends_with("QQPlayer"),
            "数据目录应落在 QQPlayer 下: {}",
            dir.display()
        );
    }
}
