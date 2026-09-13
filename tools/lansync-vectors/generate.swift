//
//  generate.swift  ——  Swift → 跨语言测试向量生成器（局域网同步协议）
//
//  编译（见 run.sh，绝对路径引用只读的 Swift 源码，产物落 /tmp，不污染仓库）：
//    swiftc -O -o $TMPDIR/lsv-gen \
//      tools/lansync-vectors/generate.swift tools/lansync-vectors/SupportShim.swift \
//      $SWIFT_REPO/QQPlayer/Sync/{DeviceID,SyncFrame,SyncCrypto,SyncIdentity}.swift
//
//  输入全部为**确定性种子**（SHA256(label#n) 拼接），无随机源 → 同一源码
//  永远产出同一份 vectors.json（幂等，见 README「幂等性」）。
//
//  向量来源（均为上游真实实现，未改动一行）：
//    DeviceID.make / formatted / base32Encode / base32Decode
//    SyncFrame.encode / decode
//    SyncHandshake.signingInput
//    SyncKeyExchange.deriveDirectionKeys
//    SyncCipher.nonceData / seal / open
//

import CryptoKit
import Foundation

// MARK: - 确定性工具

struct GenError: Error { let message: String }

func sha256Data(_ data: Data) -> Data { Data(SHA256.hash(data: data)) }

/// 确定性伪随机字节：SHA256("qqplayer-lansync-vectors/<label>#<block>") 依次拼接。
func seededBytes(_ label: String, count: Int) -> Data {
    var out = Data()
    var block = 0
    while out.count < count {
        out.append(sha256Data(Data("qqplayer-lansync-vectors/\(label)#\(block)".utf8)))
        block += 1
    }
    return out.prefix(count)
}

func hexString(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

func base64String(_ data: Data) -> String { data.base64EncodedString() }

func dataFromHex(_ string: String) -> Data? {
    guard string.count % 2 == 0 else { return nil }
    var out = Data(capacity: string.count / 2)
    var index = string.startIndex
    while index < string.endIndex {
        let next = string.index(index, offsetBy: 2)
        guard let byte = UInt8(string[index ..< next], radix: 16) else { return nil }
        out.append(byte)
        index = next
    }
    return out
}

func jsonQuote(_ string: String) -> String {
    var out = ""
    for scalar in string.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return "\"\(out)\""
}

/// 完整 10B 帧头（AAD 来源，与 SyncFrame.encode 的头部字节一致）。
func frameHeader(type: SyncFrameType, flags: UInt8, payloadLength: Int) -> Data {
    var out = Data(capacity: SyncFrame.headerLength)
    out.append(SyncFrame.magic)
    var bigEndian = UInt32(payloadLength).bigEndian
    withUnsafeBytes(of: &bigEndian) { out.append(contentsOf: $0) }
    out.append(type.rawValue)
    out.append(flags)
    return out
}

/// 加密帧 payload 长度 = 12B nonce + 明文 + 16B tag（ChaChaPoly combined）。
let aeadOverhead = 28

// MARK: - 生成器

@main
enum LSVGenerator {
    static func main() throws {
        let environment = ProcessInfo.processInfo.environment
        let swiftRepo = environment["LSV_SWIFT_REPO"] ?? "/Users/dax/codes/qqplayer-swift"
        let swiftCommit = environment["LSV_SWIFT_COMMIT"] ?? "unknown"
        let arguments = CommandLine.arguments
        guard arguments.count > 1 else {
            throw GenError(message: "usage: lsv-gen <out-vectors.json>")
        }
        let outPath = arguments[1]

        // MARK: 身份（Ed25519）与 ephemeral（X25519）——全部确定性种子
        let hostIdentity = try SyncIdentity(privateKeyRaw: seededBytes("ed25519/host", count: 32))
        let clientIdentity = try SyncIdentity(privateKeyRaw: seededBytes("ed25519/client", count: 32))
        let thirdIdentity = try SyncIdentity(privateKeyRaw: seededBytes("ed25519/third", count: 32))

        let hostEph = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: seededBytes("x25519/host-eph", count: 32)
        )
        let clientEph = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: seededBytes("x25519/client-eph", count: 32)
        )
        let altA = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: seededBytes("x25519/alt-a", count: 32)
        )
        let altB = try Curve25519.KeyAgreement.PrivateKey(
            rawRepresentation: seededBytes("x25519/alt-b", count: 32)
        )

        var lines: [String] = []
        lines.append("{")
        lines.append("  \"generated_by\": \(jsonQuote("\(swiftRepo) @ \(swiftCommit)")),")

        // MARK: 1. device_ids（Ed25519 公钥指纹 → base32）
        let deviceIDInputs: [Data] = [
            hostIdentity.publicKeyRaw,
            clientIdentity.publicKeyRaw,
            Data(count: 32),
            Data((0 ..< 32).map { UInt8($0) }),
        ]
        var deviceIDStrings: [String] = []
        for input in deviceIDInputs {
            guard let id = DeviceID.make(fromPublicKeyData: input) else {
                throw GenError(message: "DeviceID.make 失败（输入非 32B）")
            }
            deviceIDStrings.append(
                "    { \"public_key_b64\": \(jsonQuote(base64String(input))), "
                    + "\"device_id\": \(jsonQuote(id)), "
                    + "\"formatted\": \(jsonQuote(DeviceID.formatted(id))) }"
            )
        }
        lines.append("  \"swift_files\": [\"DeviceID.swift\", \"SyncFrame.swift\", "
            + "\"SyncCrypto.swift\", \"SyncIdentity.swift\"],")
        lines.append("  \"device_ids\": [\n\(deviceIDStrings.joined(separator: ",\n"))\n  ],")

        // MARK: 2. base32（1-5 字节输入，无填充）
        let base32Inputs: [Data] = [
            Data([0x00]),
            Data([0x00, 0xFF]),
            Data([0xFF, 0x00, 0x01]),
            Data([0x1F, 0x2F, 0x3F, 0x4F]),
            Data([0xDE, 0xAD, 0xBE, 0xEF, 0x01]),
        ]
        var base32Strings: [String] = []
        for input in base32Inputs {
            let encoded = DeviceID.base32Encode(input)
            guard DeviceID.base32Decode(encoded) == input else {
                throw GenError(message: "base32 自洽校验失败：\(hexString(input))")
            }
            base32Strings.append(
                "    { \"bytes_hex\": \(jsonQuote(hexString(input))), \"encoded\": \(jsonQuote(encoded)) }"
            )
        }
        lines.append("  \"base32\": [\n\(base32Strings.joined(separator: ",\n"))\n  ],")

        // MARK: 3. nonces（12B = 4 零 + 8B 大端计数器）
        let nonceCounters: [UInt64] = [0, 1, 4_294_967_296, UInt64.max]
        var nonceStrings: [String] = []
        for counter in nonceCounters {
            let nonce = try SyncCipher.nonceData(forCounter: counter)
            nonceStrings.append(
                "    { \"counter\": \(counter), \"nonce_hex\": \(jsonQuote(hexString(nonce))) }"
            )
        }
        lines.append("  \"nonces\": [\n\(nonceStrings.joined(separator: ",\n"))\n  ],")

        // MARK: 4. hello_signature（signingInput = ephemeralPub ‖ peerDeviceID ‖ role）
        struct HelloRow {
            let seed: Data
            let publicKey: Data
            let ephemeralPublicKey: Data
            let peerDeviceID: String
            let role: String
        }
        let helloRows: [HelloRow] = [
            HelloRow(
                seed: hostIdentity.privateKeyRaw,
                publicKey: hostIdentity.publicKeyRaw,
                ephemeralPublicKey: hostEph.publicKey.rawRepresentation,
                peerDeviceID: clientIdentity.deviceID,
                role: SyncHello.roleHost
            ),
            HelloRow(
                seed: clientIdentity.privateKeyRaw,
                publicKey: clientIdentity.publicKeyRaw,
                ephemeralPublicKey: clientEph.publicKey.rawRepresentation,
                peerDeviceID: hostIdentity.deviceID,
                role: SyncHello.roleClient
            ),
            HelloRow(
                seed: clientIdentity.privateKeyRaw,
                publicKey: clientIdentity.publicKeyRaw,
                ephemeralPublicKey: clientEph.publicKey.rawRepresentation,
                peerDeviceID: "",
                role: SyncHello.roleClient
            ),
            HelloRow(
                seed: thirdIdentity.privateKeyRaw,
                publicKey: thirdIdentity.publicKeyRaw,
                ephemeralPublicKey: altA.publicKey.rawRepresentation,
                peerDeviceID: "",
                role: SyncHello.roleHost
            ),
        ]
        var helloStrings: [String] = []
        for row in helloRows {
            let input = SyncHandshake.signingInput(
                ephemeralPublicKeyRaw: row.ephemeralPublicKey,
                peerDeviceID: row.peerDeviceID,
                role: row.role
            )
            let signingKey = try Curve25519.Signing.PrivateKey(rawRepresentation: row.seed)
            let signature = try signingKey.signature(for: input)
            guard Curve25519.Signing.PublicKey.isValidSignatureForSelfCheck(
                signature, input: input, publicKeyRaw: row.publicKey
            ) else {
                throw GenError(message: "hello 自签自验失败（role=\(row.role)）")
            }
            helloStrings.append(
                "    { \"seed_b64\": \(jsonQuote(base64String(row.seed))), "
                    + "\"public_key_b64\": \(jsonQuote(base64String(row.publicKey))), "
                    + "\"ephemeral_public_key_b64\": \(jsonQuote(base64String(row.ephemeralPublicKey))), "
                    + "\"peer_device_id\": \(jsonQuote(row.peerDeviceID)), "
                    + "\"role\": \(jsonQuote(row.role)), "
                    + "\"signing_input_hex\": \(jsonQuote(hexString(input))), "
                    + "\"signature_b64\": \(jsonQuote(base64String(signature))) }"
            )
        }
        lines.append("  \"hello_signature\": [\n\(helloStrings.joined(separator: ",\n"))\n  ],")

        // MARK: 5. key_derivation（X25519 ECDH + HKDF-SHA256 → 双向密钥）
        let keyPairs: [(myPrivate: Curve25519.KeyAgreement.PrivateKey, peerPublic: Data)] = [
            (clientEph, hostEph.publicKey.rawRepresentation),
            (hostEph, clientEph.publicKey.rawRepresentation),
            (altA, altB.publicKey.rawRepresentation),
            (altB, altA.publicKey.rawRepresentation),
        ]
        var derivationStrings: [String] = []
        var firstClientToHost = Data()
        var firstHostToClient = Data()
        for (index, pair) in keyPairs.enumerated() {
            let keys = try SyncKeyExchange.deriveDirectionKeys(
                myEphemeralPrivateKey: pair.myPrivate,
                peerEphemeralPublicKeyRaw: pair.peerPublic
            )
            let clientToHost = keys.clientToHost.withUnsafeBytes { Data($0) }
            let hostToClient = keys.hostToClient.withUnsafeBytes { Data($0) }
            if index == 0 {
                firstClientToHost = clientToHost
                firstHostToClient = hostToClient
            }
            derivationStrings.append(
                "    { \"my_ephemeral_private_b64\": \(jsonQuote(base64String(pair.myPrivate.rawRepresentation))), "
                    + "\"peer_ephemeral_public_b64\": \(jsonQuote(base64String(pair.peerPublic))), "
                    + "\"client_to_host_hex\": \(jsonQuote(hexString(clientToHost))), "
                    + "\"host_to_client_hex\": \(jsonQuote(hexString(hostToClient))) }"
            )
        }
        // DH 对称性自证：两侧派生必须一致
        guard keyPairs.count >= 2,
              let left = try? SyncKeyExchange.deriveDirectionKeys(
                  myEphemeralPrivateKey: keyPairs[0].myPrivate,
                  peerEphemeralPublicKeyRaw: keyPairs[0].peerPublic
              ),
              let right = try? SyncKeyExchange.deriveDirectionKeys(
                  myEphemeralPrivateKey: keyPairs[1].myPrivate,
                  peerEphemeralPublicKeyRaw: keyPairs[1].peerPublic
              ),
              left.clientToHost.withUnsafeBytes({ Data($0) }) == right.clientToHost.withUnsafeBytes({ Data($0) }),
              left.hostToClient.withUnsafeBytes({ Data($0) }) == right.hostToClient.withUnsafeBytes({ Data($0) })
        else {
            throw GenError(message: "DH 对称性自证失败")
        }
        lines.append("  \"key_derivation\": [\n\(derivationStrings.joined(separator: ",\n"))\n  ],")

        // MARK: 6. aead（ChaCha20-Poly1305，nonce = SyncCipher.nonceData）
        func sealAEAD(key: Data, counter: UInt64, plaintext: Data, aad: Data) throws -> Data {
            let nonce = try ChaChaPoly.Nonce(data: try SyncCipher.nonceData(forCounter: counter))
            let box = try ChaChaPoly.seal(
                plaintext, using: SymmetricKey(data: key), nonce: nonce, authenticating: aad
            )
            return box.combined
        }
        let aeadFirstPlaintext = Data("qqplayer-sync/aead#1".utf8)
        let aeadFirstAAD = frameHeader(
            type: .fileMeta, flags: 1, payloadLength: aeadFirstPlaintext.count + aeadOverhead
        )
        let aeadSecondPlaintext = seededBytes("aead/payload/2", count: 32)
        let aeadSecondAAD = frameHeader(
            type: .fileChunk, flags: 1, payloadLength: aeadSecondPlaintext.count + aeadOverhead
        )
        let aeadThirdAAD = frameHeader(type: .peerLibraryResponse, flags: 1, payloadLength: aeadOverhead)
        let aeadFourthPlaintext = Data("abc".utf8)
        let aeadFourthAAD = frameHeader(type: .pairResponse, flags: 0, payloadLength: 3)

        // 负例：AAD 末字节翻转 1 bit → 认证必失败（不记密文，combined_hex 置空）
        var tamperedAAD = aeadFirstAAD
        tamperedAAD[tamperedAAD.startIndex + tamperedAAD.count - 1] ^= 0x01
        do {
            let box = try ChaChaPoly.SealedBox(
                combined: try sealAEAD(
                    key: firstClientToHost, counter: 1, plaintext: aeadFirstPlaintext, aad: aeadFirstAAD
                )
            )
            _ = try ChaChaPoly.open(
                box, using: SymmetricKey(data: firstClientToHost), authenticating: tamperedAAD
            )
            throw GenError(message: "AEAD 负例未被拒绝（AAD 篡改后仍通过认证）")
        } catch is GenError {
            throw GenError(message: "AEAD 负例未被拒绝（AAD 篡改后仍通过认证）")
        } catch {
            // 预期的 authenticationFailure
        }

        var aeadStrings: [String] = []
        func appendAEAD(
            key: Data, counter: UInt64, aad: Data, plaintext: Data, recordCiphertext: Bool
        ) throws {
            let combined = try sealAEAD(key: key, counter: counter, plaintext: plaintext, aad: aad)
            let combinedField = recordCiphertext ? jsonQuote(hexString(combined)) : "\"\""
            aeadStrings.append(
                "    { \"key_hex\": \(jsonQuote(hexString(key))), "
                    + "\"counter\": \(counter), "
                    + "\"aad_hex\": \(jsonQuote(hexString(aad))), "
                    + "\"plaintext_hex\": \(jsonQuote(hexString(plaintext))), "
                    + "\"combined_hex\": \(combinedField) }"
            )
        }
        try appendAEAD(
            key: firstClientToHost, counter: 1, aad: aeadFirstAAD,
            plaintext: aeadFirstPlaintext, recordCiphertext: true
        )
        try appendAEAD(
            key: firstClientToHost, counter: 4_294_967_296, aad: aeadSecondAAD,
            plaintext: aeadSecondPlaintext, recordCiphertext: true
        )
        try appendAEAD(
            key: firstHostToClient, counter: 7, aad: aeadThirdAAD,
            plaintext: Data(), recordCiphertext: true
        )
        try appendAEAD(
            key: firstClientToHost, counter: UInt64.max, aad: aeadFourthAAD,
            plaintext: aeadFourthPlaintext, recordCiphertext: true
        )
        try appendAEAD(
            key: firstClientToHost, counter: 1, aad: tamperedAAD,
            plaintext: aeadFirstPlaintext, recordCiphertext: false
        )
        lines.append("  \"aead\": [\n\(aeadStrings.joined(separator: ",\n"))\n  ],")

        // MARK: 7. frames（type 0/1/2 明文 + type 4/5/16 加密；长度前缀大端）
        struct FrameRow {
            let type: SyncFrameType
            let flags: UInt8
            let payload: Data
            let encoded: Data
            let plaintext: Data?
        }
        var sender = SyncCipher(key: SymmetricKey(data: firstClientToHost))

        func encryptedFrame(type: SyncFrameType, plaintext: Data) throws -> FrameRow {
            let aad = frameHeader(type: type, flags: 1, payloadLength: plaintext.count + aeadOverhead)
            let combined = try sender.seal(plaintext: plaintext, aad: aad)
            let frame = SyncFrame(type: type, flags: [.encrypted], payload: combined)
            return FrameRow(type: type, flags: 1, payload: combined, encoded: try frame.encode(), plaintext: plaintext)
        }
        func plaintextFrame(type: SyncFrameType, payload: Data) throws -> FrameRow {
            let frame = SyncFrame(type: type, flags: [], payload: payload)
            return FrameRow(type: type, flags: 0, payload: payload, encoded: try frame.encode(), plaintext: nil)
        }

        var frames: [FrameRow] = []
        frames.append(try plaintextFrame(type: .handshake, payload: Data("qqplayer-sync-hello".utf8)))
        frames.append(try plaintextFrame(type: .pairRequest, payload: Data()))
        frames.append(try plaintextFrame(type: .pairResponse, payload: Data((0 ..< 256).map { UInt8($0) })))
        frames.append(try encryptedFrame(type: .fileMeta, plaintext: Data("file-meta-payload".utf8)))
        frames.append(try encryptedFrame(type: .fileChunk, plaintext: Data((0 ..< 70000).map { UInt8($0 & 0xFF) })))
        frames.append(try encryptedFrame(type: .peerLibraryResponse, plaintext: Data()))

        var frameStrings: [String] = []
        for frame in frames {
            frameStrings.append(
                "    { \"type\": \(frame.type.rawValue), \"flags\": \(frame.flags), "
                    + "\"payload_hex\": \(jsonQuote(hexString(frame.payload))), "
                    + "\"encoded_hex\": \(jsonQuote(hexString(frame.encoded))) }"
            )
        }
        lines.append("  \"frames\": [\n\(frameStrings.joined(separator: ",\n"))\n  ]")
        lines.append("}")

        let json = lines.joined(separator: "\n") + "\n"
        try Data(json.utf8).write(to: URL(fileURLWithPath: outPath))

        // MARK: 自证 1：读回刚写出的文件 → SyncFrame.decode 比对 type/flags/payload
        let readBack = try Data(contentsOf: URL(fileURLWithPath: outPath))
        guard let root = try JSONSerialization.jsonObject(with: readBack) as? [String: Any] else {
            throw GenError(message: "自检失败：读回 JSON 无法解析")
        }
        guard let framesJSON = root["frames"] as? [[String: Any]] else {
            throw GenError(message: "自检失败：frames 缺失")
        }
        guard framesJSON.count == frames.count else {
            throw GenError(message: "自检失败：帧数不一致")
        }
        var opener = SyncCipher(key: SymmetricKey(data: firstClientToHost))
        var openedCount = 0
        for (index, entry) in framesJSON.enumerated() {
            guard let encodedHex = entry["encoded_hex"] as? String,
                  let payloadHex = entry["payload_hex"] as? String,
                  let typeValue = entry["type"] as? Int,
                  let flagsValue = entry["flags"] as? Int,
                  let encoded = dataFromHex(encodedHex),
                  let declaredPayload = dataFromHex(payloadHex)
            else {
                throw GenError(message: "自检失败：帧 #\(index) 字段缺失/格式非法")
            }
            let decoded = try SyncFrame.decode(from: encoded)
            guard decoded.frame.type.rawValue == UInt8(typeValue),
                  decoded.frame.flags.rawValue == UInt8(flagsValue),
                  decoded.frame.payload == declaredPayload,
                  decoded.consumed == encoded.count
            else {
                throw GenError(message: "自检失败：帧 #\(index) 编解码不一致")
            }
            // 头部大端长度前缀必须等于 payload 字节数
            guard UInt32(encoded[encoded.startIndex + 4]) << 24
                | UInt32(encoded[encoded.startIndex + 5]) << 16
                | UInt32(encoded[encoded.startIndex + 6]) << 8
                | UInt32(encoded[encoded.startIndex + 7]) == UInt32(decoded.frame.payload.count)
            else {
                throw GenError(message: "自检失败：帧 #\(index) 长度前缀非大端或与 payload 不符")
            }
            if decoded.frame.isEncrypted {
                guard let expected = frames[index].plaintext else {
                    throw GenError(message: "自检失败：帧 #\(index) 期望明文缺失")
                }
                let aad = Data(encoded.prefix(SyncFrame.headerLength))
                let plaintext = try opener.open(decoded.frame.payload, aad: aad)
                guard plaintext == expected else {
                    throw GenError(message: "自检失败：帧 #\(index) 解密明文不符")
                }
                openedCount += 1
            }
        }

        // MARK: 自证 2：读回 hello → 验签（公钥来自文件）
        guard let hellosJSON = root["hello_signature"] as? [[String: Any]] else {
            throw GenError(message: "自检失败：hello_signature 缺失")
        }
        for (index, entry) in hellosJSON.enumerated() {
            guard let publicKeyB64 = entry["public_key_b64"] as? String,
                  let signatureB64 = entry["signature_b64"] as? String,
                  let inputHex = entry["signing_input_hex"] as? String,
                  let ephemeralB64 = entry["ephemeral_public_key_b64"] as? String,
                  let role = entry["role"] as? String,
                  let peerDeviceID = entry["peer_device_id"] as? String,
                  let publicKeyData = Data(base64Encoded: publicKeyB64),
                  let signatureData = Data(base64Encoded: signatureB64),
                  let ephemeralData = Data(base64Encoded: ephemeralB64),
                  let inputData = dataFromHex(inputHex)
            else {
                throw GenError(message: "自检失败：hello #\(index) 字段缺失/格式非法")
            }
            let expectedInput = SyncHandshake.signingInput(
                ephemeralPublicKeyRaw: ephemeralData, peerDeviceID: peerDeviceID, role: role
            )
            guard expectedInput == inputData else {
                throw GenError(message: "自检失败：hello #\(index) signingInput 与字段不符")
            }
            let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyData)
            guard publicKey.isValidSignature(signatureData, for: inputData) else {
                throw GenError(message: "自检失败：hello #\(index) 验签失败")
            }
        }

        print("SELFCHECK OK: device_ids=\(deviceIDStrings.count) base32=\(base32Strings.count) "
            + "nonces=\(nonceStrings.count) hellos=\(hellosJSON.count) derivations=\(derivationStrings.count) "
            + "aead=\(aeadStrings.count) frames=\(framesJSON.count) (encrypted_opened=\(openedCount))")
        print("WROTE \(outPath)")
    }
}

extension Curve25519.Signing.PublicKey {
    /// 生成端自检：用 raw 公钥验证签名（CryptoKit 无静态入口，这里包一层）。
    static func isValidSignatureForSelfCheck(
        _ signature: Data, input: Data, publicKeyRaw: Data
    ) -> Bool {
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: publicKeyRaw) else {
            return false
        }
        return key.isValidSignature(signature, for: input)
    }
}
