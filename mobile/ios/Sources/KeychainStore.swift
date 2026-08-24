import Foundation
import Security

/// Keychain 封装：本机设备 UUID + 多桌面配对记录（按 serverId 维度存 JSON）。
/// - 设备 UUID：首次启动生成并持久化（kSecClassGenericPassword），配对时作为 device_id 上报
/// - 配对记录：每个 serverId 一条（{url, token, serverName, lastConnectedAt}）
///
/// 双写兜底（2026-08-23）：模拟器/开发机覆盖安装时 Keychain 偶发被清空（免签名构建
/// 行为不稳定），配对记录与 deviceId 同时写一份到沙盒 Documents（pairing.json），
/// Keychain 读不到时从文件恢复并回填 Keychain。卸载重装两者都清（标准行为，需重新配对）。
enum KeychainStore {
    private static let deviceService = "com.daxmate.qqplayer.device"
    private static let serverService = "com.daxmate.qqplayer.server"

    /// 沙盒兜底文件（Documents/pairing.json）：{deviceId, records: [PairingRecord]}
    private static var backupURL: URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return docs.appendingPathComponent("pairing.json")
    }

    private struct BackupFile: Codable {
        var deviceId: String?
        var records: [PairingRecord]
    }

    // MARK: 设备 UUID

    /// 本机持久化设备 UUID（首次生成；Keychain 在重装/恢复后保留）
    ///
    /// 生成链：Keychain → 文件兜底 → identifierForVendor（重装后仍稳定，绑定设备而非安装）
    /// → 随机 UUID（最后兑底）。2026-08-24：兑底从随机 UUID 改为 identifierForVendor，
    /// 否则卸载重装后 device_id 变化，桌面端把同一台设备当成新设备反复累积配对记录。
    static func deviceId() -> String {
        if let existing = read(service: deviceService, account: "deviceId"), !existing.isEmpty {
            return existing
        }
        if let backed = loadBackup().deviceId, !backed.isEmpty {
            _ = write(service: deviceService, account: "deviceId", value: backed)
            return backed
        }
        let newId = stableFallbackId()
        _ = write(service: deviceService, account: "deviceId", value: newId)
        saveBackup(deviceId: newId)
        return newId
    }

    /// 稳定兑底设备 ID：identifierForVendor 优先（同设备卸载重装后不变），不可用才随机。
    private static func stableFallbackId() -> String {
        if let vid = UIDevice.current.identifierForVendor?.uuidString.lowercased(),
           !vid.isEmpty {
            return vid
        }
        return UUID().uuidString.lowercased()
    }

    // MARK: 配对记录

    /// 保存一条配对记录（同一 serverId 覆盖更新）
    @discardableResult
    static func saveServer(_ record: PairingRecord) -> Bool {
        guard let data = try? JSONEncoder().encode(record) else { return false }
        let ok = write(service: serverService, account: record.serverId, value: String(data: data, encoding: .utf8) ?? "")
        // 文件兜底：合并当前记录（同 serverId 覆盖）后落盘
        var backup = loadBackup()
        backup.records.removeAll { $0.serverId == record.serverId }
        backup.records.append(record)
        saveBackup(backup)
        return ok
    }

    /// 读取全部已配对服务器（Keychain 优先；空则从文件恢复并回填 Keychain）
    static func loadServers() -> [PairingRecord] {
        let fromKeychain = loadServersFromKeychain()
        if !fromKeychain.isEmpty { return fromKeychain }
        let fromFile = loadBackup().records
        if !fromFile.isEmpty {
            // 回填 Keychain（下次 Keychain 可用时直接命中）
            for r in fromFile {
                if let data = try? JSONEncoder().encode(r) {
                    _ = write(service: serverService, account: r.serverId, value: String(data: data, encoding: .utf8) ?? "")
                }
            }
            return fromFile.sorted { $0.lastConnectedAt > $1.lastConnectedAt }
        }
        return []
    }

    private static func loadServersFromKeychain() -> [PairingRecord] {
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
        var backup = loadBackup()
        backup.records.removeAll { $0.serverId == serverId }
        saveBackup(backup)
        return status == errSecSuccess || status == errSecItemNotFound
    }

    // MARK: 文件兜底

    private static func loadBackup() -> BackupFile {
        guard let data = try? Data(contentsOf: backupURL),
              let file = try? JSONDecoder().decode(BackupFile.self, from: data)
        else {
            return BackupFile(deviceId: nil, records: [])
        }
        return file
    }

    private static func saveBackup(_ file: BackupFile) {
        guard let data = try? JSONEncoder().encode(file) else { return }
        try? data.write(to: backupURL, options: .atomic)
    }

    private static func saveBackup(deviceId: String) {
        var file = loadBackup()
        file.deviceId = deviceId
        saveBackup(file)
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
        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status != errSecSuccess {
            print("[Keychain] SecItemAdd failed: \(status) (\(Self.statusText(status))) service=\(service)")
        }
        return status == errSecSuccess
    }

    private static func statusText(_ status: OSStatus) -> String {
        if let msg = SecCopyErrorMessageString(status, nil) as String? {
            return msg
        }
        return "OSStatus \(status)"
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
