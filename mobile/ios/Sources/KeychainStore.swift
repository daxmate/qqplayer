import Foundation
import Security

/// Keychain 封装：本机设备 UUID + 多桌面配对记录（按 serverId 维度存 JSON）。
/// - 设备 UUID：首次启动生成并持久化（kSecClassGenericPassword），配对时作为 device_id 上报
/// - 配对记录：每个 serverId 一条（{url, token, serverName, lastConnectedAt}）
enum KeychainStore {
    private static let deviceService = "com.daxmate.qqplayer.device"
    private static let serverService = "com.daxmate.qqplayer.server"

    // MARK: 设备 UUID

    /// 本机持久化设备 UUID（首次生成；Keychain 在重装/恢复后保留）
    static func deviceId() -> String {
        if let existing = read(service: deviceService, account: "deviceId"), !existing.isEmpty {
            return existing
        }
        let newId = UUID().uuidString.lowercased()
        _ = write(service: deviceService, account: "deviceId", value: newId)
        return newId
    }

    // MARK: 配对记录

    /// 保存一条配对记录（同一 serverId 覆盖更新）
    @discardableResult
    static func saveServer(_ record: PairingRecord) -> Bool {
        guard let data = try? JSONEncoder().encode(record) else { return false }
        return write(service: serverService, account: record.serverId, value: String(data: data, encoding: .utf8) ?? "")
    }

    /// 读取全部已配对服务器
    static func loadServers() -> [PairingRecord] {
        // Keychain 不支持按 service 枚举的简单 API（kSecMatchLimitAll + 匹配 service 可行），
        // 这里用保守方案：设备上最多几十台桌面，逐个已知 key 读不现实（无法枚举 service 前缀），
        // 改用 kSecClassGenericPassword 全量枚举过滤 service。
        var records: [PairingRecord] = []
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
        for item in items {
            guard let service = item[kSecAttrService as String] as? String,
                  service == serverService,
                  let account = item[kSecAttrAccount as String] as? String,
                  let data = read(service: serverService, account: account),
                  let record = try? JSONDecoder().decode(PairingRecord.self, from: Data(data.utf8))
            else { continue }
            records.append(record)
        }
        return records
    }

    /// 删除某台服务器的配对（token 即刻弃用；桌面端撤销走 API）
    @discardableResult
    static func deleteServer(_ serverId: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: serverService,
            kSecAttrAccount as String: serverId,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    // MARK: 基础读写

    private static func write(service: String, account: String, value: String) -> Bool {
        let data = Data(value.utf8)
        // 先删后写（不存在则直接 add）
        let deleteQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(deleteQuery as CFDictionary)
        let addQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        return SecItemAdd(addQuery as CFDictionary, nil) == errSecSuccess
    }

    private static func read(service: String, account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

/// 一台已配对桌面服务器的记录（Keychain JSON 持久化）
struct PairingRecord: Codable, Identifiable, Equatable {
    /// 服务器标识：ip:port（发现时确定）
    var serverId: String
    /// 展示名（mDNS 服务名 / hostname）
    var serverName: String
    /// 基础 URL：http://ip:port
    var url: String
    /// 配对 token（Bearer）
    var token: String
    var deviceName: String
    var lastConnectedAt: Double

    var id: String { serverId }
}
