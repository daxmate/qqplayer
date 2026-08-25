import Combine
import Foundation
import UIKit

/// 全局配对状态：已配对服务器列表、当前连接、Keychain 读写。
/// 多桌面支持：Keychain 按 serverId 存多组 (url, token)，发现列表里已配对显示"已连接"，可切换。
final class PairingStore: ObservableObject {
    static let shared = PairingStore()

    @Published var servers: [PairingRecord] = []
    /// 当前连接的服务器（nil = 未连接/发现页）
    @Published var currentServer: PairingRecord?

    /// 本机设备 UUID（配对上报 device_id）
    let deviceId: String

    private init() {
        deviceId = KeychainStore.deviceId()
        servers = KeychainStore.loadServers().sorted { $0.lastConnectedAt > $1.lastConnectedAt }
        currentServer = servers.first
    }

    /// 本机展示名（配对上报 device_name）
    ///
    /// iOS 16+ 隐私限制：未申请 user-assigned-device-name entitlement 时
    /// UIDevice.current.name 恒返回通用名（"iPhone"/"iPad"），拿不到用户设置的真实设备名；
    /// 此时回退到硬件型号名（如 "iPhone 16 Pro"），避免列表里全是 "iPhone"（2026-08-24）。
    var deviceName: String {
        let name = UIDevice.current.name
        let genericNames: Set<String> = ["iPhone", "iPad", "iPod touch", "Apple TV"]
        if name.isEmpty || genericNames.contains(name) {
            return Self.modelName
        }
        return name
    }

    /// 硬件型号展示名（uname machine identifier → 型号名；未知标识符原样返回）
    static var modelName: String {
        var system = utsname()
        uname(&system)
        let mirror = Mirror(reflecting: system.machine)
        let identifier = mirror.children.reduce(into: "") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            partial.append(String(UnicodeScalar(UInt8(value))))
        }
        let map: [String: String] = [
            "iPhone17,1": "iPhone 16 Pro",
            "iPhone17,2": "iPhone 16 Pro Max",
            "iPhone17,3": "iPhone 16",
            "iPhone17,4": "iPhone 16 Plus",
            "iPhone17,5": "iPhone 16e",
            "iPhone16,1": "iPhone 15 Pro",
            "iPhone16,2": "iPhone 15 Pro Max",
            "iPhone16,3": "iPhone 15",
            "iPhone16,4": "iPhone 15 Plus",
            "iPhone15,2": "iPhone 14 Pro",
            "iPhone15,3": "iPhone 14 Pro Max",
            "iPhone14,7": "iPhone 14",
            "iPhone14,8": "iPhone 14 Plus",
            "iPad14,5": "iPad Air 11 (M2)",
            "iPad13,18": "iPad Pro 11 (M2)",
            "x86_64": "Simulator",
            "arm64": "Simulator",
        ]
        return map[identifier] ?? identifier
    }

    /// 连接某台服务器（已配对：直接切换；记录最近连接）
    func connect(_ record: PairingRecord) {
        var updated = record
        updated.lastConnectedAt = Date().timeIntervalSince1970
        KeychainStore.saveServer(updated)
        if let idx = servers.firstIndex(where: { $0.serverId == record.serverId }) {
            servers[idx] = updated
        } else {
            servers.append(updated)
        }
        currentServer = updated
    }

    /// 保存新配对结果（桌面 approve 后）
    func savePairing(server: PairingRecord) {
        connect(server)
    }

    /// 存量迁移：已配对记录是 IP 形式 URL（http://<ip>:…）且与 mDNS 解析出的 IP 一致时，
    /// 升级为 hostname.local URL + 稳定 serverId——主机 IP 变化后配对记录不再失效。
    /// 幂等：已迁移记录（hostname URL）不匹配 IP 前缀自动跳过；重复解析同一 IP 也不会重复迁移。
    /// 触发：DiscoveryService.applyHost 每次成功解析后调用（IP 变化后新 IP 与旧记录不匹配的场景，
    /// 留给用户在发现列表重新配对一次——新配对直接存 hostname URL，之后永久免疫）。
    func migrateToHostnameURL(ifMatching discovered: DiscoveredServer) {
        guard let host = discovered.host, !host.isEmpty else { return }
        let stable = discovered.stableURL
        // stableURL 与 baseURL 相同（手动 IP 输入场景）→ 无需迁移
        guard stable.hasPrefix("http://"), stable != discovered.baseURL else { return }
        for idx in servers.indices {
            let record = servers[idx]
            // 仅迁移 IP 形式 URL 且 IP 与当前解析一致
            guard record.url.hasPrefix("http://\(host):") else { continue }
            let migrated = PairingRecord(
                serverId: discovered.serverId,
                serverName: record.serverName,
                url: stable,
                token: record.token,
                deviceName: record.deviceName,
                lastConnectedAt: record.lastConnectedAt
            )
            _ = KeychainStore.deleteServer(record.serverId)
            _ = KeychainStore.saveServer(migrated)
            servers[idx] = migrated
            if currentServer?.serverId == record.serverId {
                currentServer = migrated
            }
        }
    }

    /// token 失效（401）或用户主动断开：清 token 回到发现页
    func disconnect(_ serverId: String) {
        _ = KeychainStore.deleteServer(serverId)
        servers.removeAll { $0.serverId == serverId }
        if currentServer?.serverId == serverId {
            currentServer = nil
        }
    }

    /// 是否已配对某服务器（发现列表"已连接"标记）
    func isPaired(_ serverId: String) -> Bool {
        servers.contains { $0.serverId == serverId }
    }
}
