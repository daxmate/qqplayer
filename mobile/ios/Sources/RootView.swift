import SwiftUI

/// 根视图：主界面永远可达（配对只是连接确认，不是进入主界面的前置条件）。
///   已配对 —— ConnectedView(server:) 正常连接桌面端
///   未配对/401 清配对 —— ConnectedView(server: nil) 进入"未连接"模式（前端引导页 + 配对入口）
struct RootView: View {
    @EnvironmentObject private var pairingStore: PairingStore
    /// 配对失效提示（非 nil 时弹 alert）：Web 401 不再静默踢回发现页，先告知用户再清配对
    @State private var invalidServerName: String?

    var body: some View {
        // 无论是否配对都进主界面；server 为 nil 时 ConnectedView 显示"未连接"模式
        ConnectedView(server: pairingStore.currentServer)
            .onReceive(NotificationCenter.default.publisher(for: .qqplayerTokenInvalid)) { note in
                // Web 401：token 失效 → 弹「配对已失效」提示 → 清配对 →
                // currentServer 变 nil → 主界面自动切"未连接"模式（不踢回发现页）
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

/// 主界面：前端 WebView 全屏 + 顶部状态条（连接状态/切换服务器/未连接配对入口）。
/// server 为 nil（未连接模式）：前端显示"未连接"引导页，状态条灰点"未连接桌面端"，
/// 点击状态条或前端引导页"去配对"按钮（openPairing 通知）→ 打开配对 sheet。
struct ConnectedView: View {
    @EnvironmentObject private var pairingStore: PairingStore
    /// 当前配对记录（nil = 未连接模式）
    let server: PairingRecord?
    @State private var showSwitch = false
    /// 状态条浮层显示标记：默认隐藏，前端下拉（pullRevealStatusBar）显示，3s 后自动收回
    @State private var showStatusBar = false
    /// 自动收回任务（连续下拉重置）
    @State private var statusBarHideTask: Task<Void, Never>?

    var body: some View {
        // WebView 全屏铺满（顶部状态栏区 + 底部 home indicator 区都由前端背景覆盖）：
        // 安全区外的区域露 SwiftUI 容器底色（黑/白）会跟页面背景不连续，参考图是背景铺满全屏。
        // 顶部状态条（已连接/未连接/切换服务器）改为浮层：平时完全隐藏（不占视觉、不与页面风格冲突），
        // 前端页面顶部下拉时（pullRevealStatusBar 通知）滑入显示，3s 后自动收回。
        WebShellView(server: server)
            .ignoresSafeArea()
            .overlay(alignment: .top) {
                statusBarOverlay
            }
            .sheet(isPresented: $showSwitch) {
                DiscoveryView()
            }
            .onChange(of: pairingStore.currentServer?.serverId) { _ in
                showSwitch = false // 切换/重新配对成功后收起选择页
            }
            .ignoresSafeArea(.keyboard)
            .onReceive(NotificationCenter.default.publisher(for: .qqplayerPullRevealStatusBar)) { _ in
                revealStatusBar()
            }
            .onReceive(NotificationCenter.default.publisher(for: .qqplayerOpenPairing)) { _ in
                // 前端"未连接"引导页"去配对"按钮 → 打开配对 sheet（未连接/已连接都响应）
                showSwitch = true
            }
    }

    /// 状态条浮层：圆角胶囊（不再通栏毛玻璃色块），平时滑出屏幕外不可见；
    /// 隐藏时禁止命中（allowsHitTesting(false)），不拦截页面触摸。
    /// 已连接：绿点 + 服务器名 + 切换按钮；未连接：灰点 + "未连接桌面端"，点击整条打开配对。
    private var statusBarOverlay: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(server == nil ? Color.gray : Color.green)
                .frame(width: 8, height: 8)
            if let server {
                Text("已连接 \(server.serverName)")
                    .font(.footnote)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                Spacer()
                Button {
                    showSwitch = true
                } label: {
                    Image(systemName: "arrow.triangle.2.circlepath")
                        .font(.footnote)
                }
                .accessibilityLabel("切换服务器")
            } else {
                Text("未连接桌面端")
                    .font(.footnote)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                Spacer()
                Image(systemName: "plus.circle")
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .offset(y: showStatusBar ? 0 : -80)
        .opacity(showStatusBar ? 1 : 0)
        .allowsHitTesting(showStatusBar)
        .contentShape(Rectangle())
        .onTapGesture {
            // 未连接模式：点击状态条 → 打开配对 sheet（已连接模式仍由切换按钮触发）
            if server == nil {
                showSwitch = true
            }
        }
    }

    /// 显示状态条并重置 3s 自动收回计时（连续下拉重置，不会提前消失）
    private func revealStatusBar() {
        statusBarHideTask?.cancel()
        withAnimation(.spring(duration: 0.35)) {
            showStatusBar = true
        }
        statusBarHideTask = Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard !Task.isCancelled else { return }
            await MainActor.run {
                withAnimation(.easeOut(duration: 0.25)) {
                    showStatusBar = false
                }
            }
        }
    }
}
