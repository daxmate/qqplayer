import SwiftUI

/// 发现 / 配对页：mDNS 列出局域网桌面端 → 点选发起配对 → 桌面端确认 → token 存 Keychain → 连接。
/// 已配对服务器显示"已连接"，可切换（多桌面）。
struct DiscoveryView: View {
    @EnvironmentObject private var pairingStore: PairingStore
    @ObservedObject private var discovery = DiscoveryService.shared

    @State private var pairingSession: PairingSession?
    @State private var errorMessage: String?
    @State private var showManualAdd = false
    @State private var manualAddress = ""

    var body: some View {
        NavigationStack {
            List {
                Section {
                    ForEach(discovery.servers) { server in
                        serverRow(server)
                    }
                    if discovery.servers.isEmpty {
                        HStack(spacing: 10) {
                            ProgressView()
                            Text(discovery.isBrowsing ? "正在搜索局域网桌面端…" : "未找到 QQPlayer 桌面端")
                                .foregroundColor(.secondary)
                        }
                        .padding(.vertical, 8)
                    }
                } header: {
                    Text("局域网桌面端（\(discovery.servers.count)）")
                }

                if !pairingStore.servers.isEmpty {
                    Section("已配对") {
                        ForEach(pairingStore.servers) { record in
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(record.serverName)
                                    Text(record.url)
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                                Spacer()
                                if pairingStore.currentServer?.serverId == record.serverId {
                                    Text("当前")
                                        .font(.caption)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 3)
                                        .background(Color.green.opacity(0.2))
                                        .cornerRadius(6)
                                } else {
                                    Button("连接") {
                                        pairingStore.connect(record)
                                    }
                                    .font(.caption)
                                }
                            }
                            .swipeActions {
                                Button("断开", role: .destructive) {
                                    pairingStore.disconnect(record.serverId)
                                }
                            }
                        }
                    }
                }
                Section {
                    Button {
                        manualAddress = ""
                        showManualAdd = true
                    } label: {
                        Label("手动添加服务器", systemImage: "plus.circle")
                    }
                } footer: {
                    Text("mDNS 未发现时手动输入桌面端 IP:端口（如 192.168.1.5:17627）")
                }
            }
            .navigationTitle("QQPlayer")
            .alert("手动添加服务器", isPresented: $showManualAdd) {
                TextField("192.168.1.5:17627", text: $manualAddress)
                    .keyboardType(.numbersAndPunctuation)
                    .autocorrectionDisabled()
                    .autocapitalization(.none)
                Button("配对", action: startManualPairing)
                Button("取消", role: .cancel) {}
            } message: {
                Text("输入桌面端 QQPlayer 的 IP 与端口")
            }
            .refreshable {
                discovery.stop()
                discovery.start()
            }
            .overlay(alignment: .bottom) {
                if let session = pairingSession {
                    pairingSheet(session)
                }
                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Color.red.opacity(0.85))
                        .cornerRadius(8)
                        .padding(.bottom, 12)
                }
            }
            .alert("配对失败", isPresented: Binding(
                get: { pairingSession?.phase == .failed },
                set: { if !$0 { pairingSession = nil } }
            )) {
                Button("好", role: .cancel) { pairingSession = nil }
            } message: {
                Text(pairingSession?.errorText ?? "")
            }
        }
        .onAppear {
            discovery.start()
        }
        .onDisappear {
            // 连接成功切走后停止发现（切换页再次 onAppear 会重启）
        }
    }

    // MARK: - 行

    private func serverRow(_ server: DiscoveredServer) -> some View {
        let paired = pairingStore.isPaired(server.serverId)
        return HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .font(.title3)
                .foregroundColor(.accentColor)
            VStack(alignment: .leading, spacing: 2) {
                Text(server.displayName)
                    .lineLimit(1)
                if let host = server.host {
                    Text("\(host):\(server.port)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                } else {
                    Text("解析中…")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            Spacer()
            if paired {
                Text("已连接")
                    .font(.caption)
                    .foregroundColor(.green)
            } else {
                Button("配对") {
                    startPairing(with: server)
                }
                .font(.caption)
                .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 2)
    }

    // MARK: - 配对流程

    /// 手动输入 IP:端口发起配对（mDNS 不可用/未发现时的兜底入口）
    private func startManualPairing() {
        let addr = manualAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !addr.isEmpty else {
            errorMessage = "地址不能为空"
            return
        }
        let parts = addr.split(separator: ":")
        let host = parts.first.map(String.init) ?? addr
        let port = parts.count > 1 ? (UInt16(parts[1]) ?? 17627) : 17627
        let server = DiscoveredServer(serviceName: host, host: host, port: port)
        startPairing(with: server)
    }

    private func startPairing(with server: DiscoveredServer) {
        guard let host = server.host else {
            errorMessage = "服务器地址尚未解析，请稍候重试"
            return
        }
        errorMessage = nil
        // 用 stableURL（hostname.local）配对：主机 IP 变化后配对记录不失效；手动输入 IP 时退化为 IP URL
        let session = PairingSession(server: server, baseURL: server.stableURL)
        pairingSession = session
        Task {
            await runPairing(session)
        }
    }

    private func runPairing(_ session: PairingSession) async {
        // 1. 发起请求
        let result = await PairingClient.request(
            baseURL: session.baseURL,
            deviceId: pairingStore.deviceId,
            deviceName: pairingStore.deviceName
        )
        switch result {
        case .success(let requestId):
            session.requestId = requestId
            await pollStatus(session)
        case .failure(.rateLimited):
            session.phase = .failed
            session.errorText = "配对请求过于频繁，请稍后再试（桌面端限流）"
        case .failure(.network):
            session.phase = .failed
            session.errorText = "无法连接 \(session.baseURL)，请确认桌面端已启动"
        case .failure(.http(let code)):
            session.phase = .failed
            session.errorText = "桌面端返回错误（HTTP \(code)）"
        case .failure:
            session.phase = .failed
            session.errorText = "配对发起失败，请重试"
        }
    }

    private func pollStatus(_ session: PairingSession) async {
        session.phase = .waiting
        // pending 最长 5 分钟；每 2s 轮询一次，超 5 分钟按 expired 处理
        let deadline = Date().addingTimeInterval(5 * 60 + 10)
        while Date() < deadline && session.phase == .waiting {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            let status = await PairingClient.status(baseURL: session.baseURL, requestId: session.requestId ?? "")
            switch status {
            case .approved(let token):
                guard let token, !token.isEmpty else {
                    session.phase = .failed
                    session.errorText = "配对确认成功但未拿到 token，请重新配对"
                    return
                }
                // 存 Keychain + 连接
                let record = PairingRecord(
                    serverId: session.server.serverId,
                    serverName: session.server.displayName,
                    url: session.baseURL,
                    token: token,
                    deviceName: pairingStore.deviceName,
                    lastConnectedAt: Date().timeIntervalSince1970
                )
                await MainActor.run {
                    pairingStore.savePairing(server: record)
                    pairingSession = nil
                }
                return
            case .rejected:
                session.phase = .failed
                session.errorText = "桌面端拒绝了配对请求"
            case .expired, .unknown:
                session.phase = .failed
                session.errorText = "配对请求已过期，请重新发起"
            case .pending:
                break
            }
        }
        if session.phase == .waiting {
            session.phase = .failed
            session.errorText = "配对等待超时（桌面端未确认），请重试"
        }
    }

    // MARK: - 配对中 UI

    private func pairingSheet(_ session: PairingSession) -> some View {
        VStack(spacing: 14) {
            switch session.phase {
            case .waiting:
                ProgressView()
                    .scaleEffect(1.2)
                Text("请在桌面端确认配对")
                    .font(.headline)
                Text(session.server.displayName)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                Text("请求已发送，等待桌面端弹窗确认…")
                    .font(.footnote)
                    .foregroundColor(.secondary)
                Button("取消") {
                    pairingSession = nil
                }
                .font(.footnote)
            default:
                EmptyView()
            }
        }
        .padding(24)
        .frame(maxWidth: 280)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
        .shadow(radius: 12)
    }
}

/// 一次配对会话状态
final class PairingSession: ObservableObject {
    enum Phase: Equatable {
        case waiting
        case failed
    }

    let server: DiscoveredServer
    let baseURL: String
    @Published var phase: Phase = .waiting
    @Published var errorText = ""
    var requestId: String?

    init(server: DiscoveredServer, baseURL: String) {
        self.server = server
        self.baseURL = baseURL
    }
}
