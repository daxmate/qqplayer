import Combine
import Foundation
import Network

/// 发现的桌面端服务器（mDNS）
struct DiscoveredServer: Identifiable, Equatable {
    let serviceName: String   // mDNS 服务名（hostname）
    var host: String?         // 解析出的 IP（nil = 解析中/失败）
    var port: UInt16
    var txtVersion: String?
    var txtName: String?

    var id: String { serviceName + (host ?? "") + String(port) }
    /// 展示名：TXT name 优先，其次服务名（去 .local 后缀）
    var displayName: String {
        if let n = txtName, !n.isEmpty { return n }
        return serviceName.replacingOccurrences(of: ".local", with: "")
    }
    /// 服务器标识（Keychain serverId）：ip:port
    var serverId: String {
        host.map { "\($0):\(port)" } ?? "\(serviceName):\(port)"
    }
    /// 基础 URL
    var baseURL: String {
        host.map { "http://\($0):\(port)" } ?? "http://\(serviceName):\(port)"
    }
}

/// mDNS 发现：NWBrowser 搜 `_qqplayer._tcp`，结果逐台短连解析出 IP。
/// 模拟器与宿主共享网络栈，能看到本机后端广播；真机走局域网。
final class DiscoveryService: ObservableObject {
    static let shared = DiscoveryService()

    @Published var servers: [DiscoveredServer] = []
    @Published var isBrowsing = false

    private var browser: NWBrowser?
    private var resolveTasks: [String: DispatchWorkItem] = [:]
    private var activeConnections: [String: NWConnection] = [:]

    private init() {}

    func start() {
        guard browser == nil else { return }
        let params = NWParameters()
        params.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: "_qqplayer._tcp", domain: nil), using: params)
        b.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.isBrowsing = true
            case .failed, .cancelled:
                self?.isBrowsing = false
            default:
                break
            }
        }
        b.browseResultsChangedHandler = { [weak self] results, _ in
            self?.updateServers(Array(results))
        }
        browser = b
        b.start(queue: .main)
    }

    func stop() {
        browser?.cancel()
        browser = nil
        isBrowsing = false
        for conn in activeConnections.values { conn.cancel() }
        activeConnections.removeAll()
        for task in resolveTasks.values { task.cancel() }
        resolveTasks.removeAll()
    }

    private func updateServers(_ results: [NWBrowser.Result]) {
        var list: [DiscoveredServer] = []
        for result in results {
            guard case .service(let name, _, _, _) = result.endpoint else { continue }
            var s = DiscoveredServer(serviceName: name, host: nil, port: 17627)
            // TXT 记录：NWBrowser 结果不带 TXT，通过短连解析时顺带读不了 TXT；
            // 版本/名称做 best-effort：连接成功时从 HTTP /api/settings 拿不到——保持 nil，
            // 名称用服务名即可（桌面端广播的服务名即 hostname）。
            list.append(s)
            resolveHost(for: s)
        }
        // 保持已解析的 host 信息（避免列表闪烁；端口以解析结果为准，mDNS 广播端口可能非 17627）
        servers = list.map { fresh in
            var s = fresh
            if let old = servers.first(where: { $0.serviceName == fresh.serviceName }),
               let h = old.host {
                s.host = h
                s.port = old.port
            }
            return s
        }
    }

    /// 短连解析 IP：NWConnection 连 service endpoint，ready 后从 currentPath 取远端 IP。
    /// 5s 超时放弃（该机器后端没开/不可达）。
    private func resolveHost(for server: DiscoveredServer) {
        let key = server.serviceName + String(server.port)
        // 已在解析中则跳过
        if activeConnections[key] != nil || resolveTasks[key] != nil { return }
        let endpoint = NWEndpoint.service(
            name: server.serviceName,
            type: "_qqplayer._tcp",
            domain: "local",
            interface: nil
        )
        let conn = NWConnection(to: endpoint, using: .tcp)
        activeConnections[key] = conn
        var resolved = false
        conn.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                resolved = true
                let (ip, port) = self?.extractEndpoint(from: conn.currentPath?.remoteEndpoint) ?? (nil, nil)
                self?.applyHost(ip, port: port, serviceName: server.serviceName, key: key)
                conn.cancel()
            case .failed, .cancelled:
                self?.activeConnections[key] = nil
            default:
                break
            }
        }
        let timeout = DispatchWorkItem { [weak self] in
            if !resolved {
                conn.cancel()
                self?.activeConnections[key] = nil
            }
        }
        resolveTasks[key] = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: timeout)
        conn.start(queue: .main)
    }

    /// 从已解析的远端端点取 IP + 实际端口（mDNS 广播端口可能非默认 17627）
    private func extractEndpoint(from endpoint: NWEndpoint?) -> (String?, UInt16?) {
        guard case .hostPort(let host, let port) = endpoint else { return (nil, nil) }
        let ip: String?
        switch host {
        case .ipv4(let addr):
            // IPv4Address 的字符串表示会带接口 scope 后缀（如 "192.168.31.118%en0"），
            // 直接拼 URL 会非法（badURL）导致配对请求永远发不出去（2026-08-24 真机 mDNS 配对根因）；
            // 截掉 % 之后的部分只留纯 IP。
            ip = addr.debugDescription.split(separator: "%").first.map(String.init)
        case .ipv6(let addr):
            ip = "[\(addr.debugDescription.split(separator: "%").first ?? Substring(""))]"
        @unknown default:
            ip = nil
        }
        return (ip, port.rawValue)
    }

    private func applyHost(_ ip: String?, port: UInt16?, serviceName: String, key: String) {
        activeConnections[key] = nil
        resolveTasks[key] = nil
        guard let ip else { return }
        for idx in servers.indices where servers[idx].serviceName == serviceName {
            servers[idx].host = ip
            if let port { servers[idx].port = port }
        }
    }
}
