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
