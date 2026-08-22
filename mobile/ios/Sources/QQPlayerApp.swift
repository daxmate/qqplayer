import SwiftUI

/// 当前场景生命周期状态（App.onChange 写入；Web 就绪时补发一次，避免 Web 端误以为 active）
enum ScenePhaseStore {
    static var current = "active"

    static func name(of phase: ScenePhase) -> String {
        switch phase {
        case .active: return "active"
        case .inactive: return "inactive"
        case .background: return "background"
        @unknown default: return "inactive"
        }
    }
}

@main
struct QQPlayerApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var pairingStore = PairingStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(pairingStore)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { newPhase in
            // 生命周期变化 → WebShell Coordinator（appState 事件）
            ScenePhaseStore.current = ScenePhaseStore.name(of: newPhase)
            NotificationCenter.default.post(
                name: .qqplayerScenePhase,
                object: nil,
                userInfo: ["state": ScenePhaseStore.current]
            )
        }
    }
}
