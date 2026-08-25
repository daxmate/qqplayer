import XCTest

@testable import QQPlayer

/// 音频中断恢复状态机（InterruptionPolicy）测试：
/// 中断前在播 → 结束后恢复；手动暂停后被打断 → 不恢复；恢复后重置。
final class InterruptionPolicyTests: XCTestCase {
    func testBeganWhilePlayingResumesOnEnd() {
        var policy = InterruptionPolicy()
        policy.began(wasPlaying: true)
        XCTAssertTrue(policy.ended(), "中断前在播 → ended 应恢复")
    }

    func testBeganWhilePausedDoesNotResumeOnEnd() {
        var policy = InterruptionPolicy()
        policy.began(wasPlaying: false)
        XCTAssertFalse(policy.ended(), "手动暂停后被打断 → ended 不应恢复")
    }

    func testEndedResetsState() {
        var policy = InterruptionPolicy()
        policy.began(wasPlaying: true)
        XCTAssertTrue(policy.ended())
        XCTAssertFalse(policy.ended(), "ended 后重置：再次 ended 不应再恢复（避免重复恢复）")
    }

    func testRepeatedBeganOverwritesPrevious() {
        // 连续两次中断开始（罕见但可能）：第二次 began 覆盖第一次
        var policy = InterruptionPolicy()
        policy.began(wasPlaying: true)
        policy.began(wasPlaying: false)
        XCTAssertFalse(policy.ended(), "第二次 began(false) 应覆盖第一次 → ended 不恢复")
    }

    func testEndedWithoutBeganDoesNotResume() {
        var policy = InterruptionPolicy()
        XCTAssertFalse(policy.ended(), "无 began 直接 ended → 不恢复")
    }
}
