import Foundation

/// 配对 API 客户端（桌面端 ① 定案接口）：
///   POST /api/pairing/request {device_id, device_name, device_type} → {request_id}
///   GET  /api/pairing/request/{id}/status → {status: pending|approved|rejected|expired}（approved 附 token，仅一次）
///   GET  /api/pairing/devices（可选手动撤销）
/// 全部走明文 HTTP（家庭局域网信任，定案）；白名单免鉴权，无需 token。
enum PairingClient {
    /// 发起配对；限流 429 时返回 .rateLimited
    static func request(baseURL: String, deviceId: String, deviceName: String) async -> Result<String, PairingError> {
        guard let url = URL(string: baseURL + "/api/pairing/request") else {
            return .failure(.badURL)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 8
        let body: [String: String] = [
            "device_id": deviceId,
            "device_name": deviceName,
            "device_type": "ios",
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 429 { return .failure(.rateLimited) }
            guard (200..<300).contains(status) else { return .failure(.http(status)) }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let requestId = obj["request_id"] as? String, !requestId.isEmpty
            else { return .failure(.badResponse) }
            return .success(requestId)
        } catch {
            return .failure(.network)
        }
    }

    /// 查询配对状态；approved 时返回 token
    static func status(baseURL: String, requestId: String) async -> PairStatus {
        guard let url = URL(string: baseURL + "/api/pairing/request/\(requestId)/status") else {
            return .unknown
        }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8
        do {
            let (data, resp) = try await URLSession.shared.data(for: req)
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            if status == 404 { return .unknown }
            guard (200..<300).contains(status),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let st = obj["status"] as? String
            else { return .unknown }
            switch st {
            case "approved":
                return .approved(token: obj["token"] as? String)
            case "rejected":
                return .rejected
            case "expired":
                return .expired
            default:
                return .pending
            }
        } catch {
            return .unknown
        }
    }
}

enum PairingError: Error, Equatable {
    case badURL
    case badResponse
    case network
    case http(Int)
    case rateLimited
}

enum PairStatus: Equatable {
    case pending
    case approved(token: String?)
    case rejected
    case expired
    case unknown
}
