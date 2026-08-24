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
        VStack(spacing: 0) {
            statusBar
            // 底部安全区（home indicator）交给前端 env(safe-area-inset-bottom) 处理：
            // WebView 铺满全屏，否则安全区外露 SwiftUI 容器黑底（viewport-fit=cover 只影响
            // 页面内布局，管不了 WebView frame）。前端各页已有 safe-area padding 兑底。
            WebShellView(server: server)
                .ignoresSafeArea(edges: .bottom)
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
