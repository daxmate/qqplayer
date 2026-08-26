import XCTest

@testable import QQPlayer

/// Web 命令分发（Pass 3：switch → 显式映射表 commandHandlers）测试：
/// 已知命令全集都在映射表里（可分发）、未知命令静默忽略不崩溃。
final class BridgeCommandDispatchTests: XCTestCase {
    /// 已知命令全集（前端 playerCore/nativeAudioBridge 实际发送的命令，含 WebShellView 透传）
    private let knownCommands: Set<String> = [
        "load", "play", "pause", "seek", "setVolume", "setRate",
        "setMetadata", "setPlaying", "setQueue",
    ]

    func testAllKnownCommandsRegistered() {
        // 已知命令全集应全部注册（可分发）；映射表不应有预期外的命令
        XCTAssertEqual(Set(AVPlayerBridge.commandHandlers.keys), knownCommands)
    }

    func testKnownCommandsDispatchWithoutCrash() {
        // 每个已注册命令带 payload 调用不崩溃（空 payload = 容错路径）
        let bridge = AVPlayerBridge()
        for cmd in knownCommands {
            bridge.handleCommand(cmd, payload: [:])
        }
    }

    func testUnknownCommandSilentlyIgnored() {
        let bridge = AVPlayerBridge()
        // 桌面壳消息/历史未知命令 → 静默忽略不崩溃、无事件推送
        var events: [(String, [String: Any])] = []
        bridge.onEvent = { events.append(($0, $1)) }
        bridge.handleCommand("pickLibrary", payload: [:])
        bridge.handleCommand("lyric", payload: [:])
        bridge.handleCommand("totallyUnknown", payload: ["t": 1.0])
        XCTAssertTrue(events.isEmpty, "未知命令不产生任何原生 → Web 事件")
    }
}
