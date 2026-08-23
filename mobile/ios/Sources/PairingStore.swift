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
    var deviceName: String {
        UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name
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
