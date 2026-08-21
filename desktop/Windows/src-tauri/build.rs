fn main() {
    // AppManifest：把自定义命令注册进 ACL（生成 allow-<command> 权限）。
    // 关键：不注册的话，外部 http 源（主窗口从 127.0.0.1:17627 加载）调 invoke
    // 会被 Tauri 2 的远程源守卫无条件拒绝（本地 tauri:// 源默认放行，远程源必须
    // 有 ACL 授权）。capabilities/default.json 里同时要引用这些 allow-* 权限。
    let attrs = tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::default().commands(&[
            "start_dragging",
            "pick_library",
            "pick_dict_files",
            "report",
        ]),
    );
    tauri_build::try_build(attrs).expect("error while building tauri application");
}
