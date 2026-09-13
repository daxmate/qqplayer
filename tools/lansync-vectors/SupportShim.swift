//
//  SupportShim.swift  ——  仅用于「独立编译 SyncCrypto.swift」的最小类型声明
//
//  背景：SyncCrypto.swift 的 makeHello / makePairRequest / validate 签名引用
//  SyncIdentity（Sync/SyncIdentity.swift，可独立编译）与 PairRequest /
//  PairingFailure（Sync/PairingModels.swift / Sync/PairingStateMachine.swift，
//  其中 PeerDevice 依赖 GRDB 模块，无法离线单文件编译）。
//
//  因此本文件只补齐**编译所需的最少声明**：PairRequest / PairingFailure。
//  字段与上游声明逐字对齐（见下方来源行号），向量生成从不调用这两条代码路径
//  （只用 SyncHandshake.signingInput / SyncCipher / SyncKeyExchange）。
//
//  上游来源（只读快照）：
//   - PairRequest:  QQPlayer/Sync/PairingModels.swift:45-60
//   - PairingFailure: QQPlayer/Sync/PairingStateMachine.swift:31-43
//

import Foundation

/// 与 PairingModels.swift:45 对齐（仅编译所需；未参与向量计算）
struct PairRequest: Codable, Equatable, Sendable {
    var clientDeviceID: String
    var clientPublicKey: String
    var nonceSignature: String
    var clientName: String?

    init(
        clientDeviceID: String,
        clientPublicKey: String,
        nonceSignature: String,
        clientName: String? = nil
    ) {
        self.clientDeviceID = clientDeviceID
        self.clientPublicKey = clientPublicKey
        self.nonceSignature = nonceSignature
        self.clientName = clientName
    }
}

/// 与 PairingStateMachine.swift:31 对齐（仅编译所需；未参与向量计算）
enum PairingFailure: Error, Equatable, Sendable {
    case invalidQRPayload(String)
    case invalidDeviceID(String)
    case invalidPublicKey
    case fingerprintMismatch
    case notAwaitingConfirmation
}
