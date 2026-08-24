import SwiftUI

/// 根视图状态机：
///   discovery  —— 无配对/401 后：发现列表 + 配对流程
///   connected  —— 已配对：前端 WebView 全屏 + 顶部连接状态条
struct RootView: View {
    @EnvironmentObject private var pairingStore: PairingStore
    /// 配对失效提示（非 nil 时弹 alert）：Web 401 不再静默踢回发现页，先告知用户再清配对
    @State private var invalidServerName: String?

    var body: some View {
        Group {
            if let server = pairingStore.currentServer {
                ConnectedView(server: server)
            } else {
                DiscoveryView()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .qqplayerTokenInvalid)) { note in
            // Web 401：token 失效 → 弹「配对已失效」提示 → 清配对回发现页重新配对
            let serverId = (note.userInfo?["serverId"] as? String) ?? pairingStore.currentServer?.serverId ?? ""
            guard !serverId.isEmpty else { return }
            invalidServerName = pairingStore.currentServer?.serverName ?? ""
            pairingStore.disconnect(serverId)
        }
        .alert("配对已失效", isPresented: Binding(
            get: { invalidServerName != nil },
            set: { if !$0 { invalidServerName = nil } }
        )) {
            Button("好", role: .cancel) {}
        } message: {
            if let name = invalidServerName, !name.isEmpty {
                Text("服务器「\(name)」已移除本设备的配对，请重新配对")
            } else {
                Text("该设备已被桌面端移除，请重新配对")
            }
        }
    }
}

/// 已连接：前端全屏 + 顶部状态条（连接状态/切换服务器）
struct ConnectedView: View {
    @EnvironmentObject private var pairingStore: PairingStore
    let server: PairingRecord
    @State private var showSwitch = false

    var body: some View {
        // WebView 全屏铺满（顶部状态栏区 + 底部 home indicator 区都由前端背景覆盖）：
        // 安全区外的区域露 SwiftUI 容器底色（黑/白）会跟页面背景不连续，参考图是背景铺满全屏。
        // 顶部状态条用 safeAreaInset 浮在 WebView 上：既保留连接状态/切换入口，又把自身高度
        // 自动并入 WebView 的 safe area——前端 env(safe-area-inset-top) 随之增大，标题等内容
        // 自动下移避让，不会被状态条压住（viewport-fit=cover + 前端 safe-area padding 兜底）。
        WebShellView(server: server)
            .ignoresSafeArea()
            .safeAreaInset(edge: .top, spacing: 0) {
                statusBar
            }
            .sheet(isPresented: $showSwitch) {
                DiscoveryView()
            }
            .onChange(of: pairingStore.currentServer?.serverId) { _ in
                showSwitch = false // 切换/重新配对成功后收起选择页
            }
            .ignoresSafeArea(.keyboard)
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(Color.green)
                .frame(width: 8, height: 8)
            Text("已连接 \(server.serverName)")
                .font(.footnote)
                .foregroundColor(.secondary)
                .lineLimit(1)
            Spacer()
            Button {
                showSwitch = true
            } label: {
                Image(systemName: "arrow.triangle.2.circlepath")
                    .font(.footnote)
            }
            .accessibilityLabel("切换服务器")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }
}
