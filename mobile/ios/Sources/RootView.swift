import SwiftUI

/// 根视图状态机：
///   discovery  —— 无配对/401 后：发现列表 + 配对流程
///   connected  —— 已配对：前端 WebView 全屏 + 顶部连接状态条
struct RootView: View {
    @EnvironmentObject private var pairingStore: PairingStore

    var body: some View {
        Group {
            if let server = pairingStore.currentServer {
                ConnectedView(server: server)
            } else {
                DiscoveryView()
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .qqplayerTokenInvalid)) { note in
            // Web 401：token 失效 → 清配对 → 回发现页重新配对（绝不静默）
            let serverId = (note.userInfo?["serverId"] as? String) ?? pairingStore.currentServer?.serverId ?? ""
            if !serverId.isEmpty {
                pairingStore.disconnect(serverId)
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
            WebShellView(server: server)
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
