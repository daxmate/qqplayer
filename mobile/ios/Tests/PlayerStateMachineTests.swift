import XCTest

@testable import QQPlayer

/// 播放核心状态机（PlayerStateMachine，Pass 3 从 AVPlayerBridge 抽出）测试：
/// 状态迁移表、事件决定、中断恢复（InterruptionPolicy 语义）、跟唱跳句 seek 竞态回归。
/// 事件推送与原 AVPlayerBridge 实现逐一对齐（行为零变化）。
final class PlayerStateMachineTests: XCTestCase {
    // MARK: - 测试辅助：构造到指定状态

    /// 迁移表（from → 方法 → (期望 state, 期望事件 or nil)）。
    /// 所有迁移方法在任何状态都可调用（不崩溃）；事件决定与原实现一致：
    /// 播放动作（play/pause 命令）不直接推事件（由 rate 观察推）、seek 完成续播不推
    /// （rate 观察推）、seek 中 rate=0 抑制 paused、缓冲等待不算暂停。
    func testMigrationTable() {
        // 起点：idle
        var idle = PlayerStateMachine()
        idle.itemLoaded() // Void（无事件）
        XCTAssertEqual(idle.state, .loading)

        // 起点：loading
        var loading = PlayerStateMachine()
        loading.itemLoaded()
        XCTAssertEqual(loading.requestPlay(), nil)
        XCTAssertEqual(loading.state, .playing)
        loading.itemLoaded()
        XCTAssertEqual(loading.requestPause(), nil)
        XCTAssertEqual(loading.state, .paused)

        // 起点：playing
        var playing = PlayerStateMachine()
        playing.itemLoaded()
        playing.requestPlay()
        XCTAssertEqual(playing.itemEnded(), .ended)
        XCTAssertEqual(playing.state, .ended)
        playing.itemLoaded()
        playing.requestPlay()
        XCTAssertEqual(playing.requestPause(), nil)
        XCTAssertEqual(playing.state, .paused)

        // 起点：paused
        var paused = PlayerStateMachine()
        paused.itemLoaded()
        paused.requestPause()
        XCTAssertEqual(paused.requestPlay(), nil)
        XCTAssertEqual(paused.state, .playing)

        // 起点：ended → play 重播（不重新 load 场景）
        var ended = PlayerStateMachine()
        ended.itemLoaded()
        ended.requestPlay()
        ended.itemEnded()
        XCTAssertEqual(ended.requestPlay(), nil)
        XCTAssertEqual(ended.state, .playing)
    }

    // MARK: - 事件决定（rate 观察驱动）

    func testRateChangedPositivePushesPlaying() {
        var m = PlayerStateMachine()
        XCTAssertEqual(m.rateChanged(rate: 1.0, isWaiting: false), .playing)
        XCTAssertEqual(m.state, .playing)
    }

    func testRateChangedZeroPushesPaused() {
        var m = PlayerStateMachine()
        m.requestPlay()
        XCTAssertEqual(m.rateChanged(rate: 0, isWaiting: false), .paused)
        XCTAssertEqual(m.state, .paused)
    }

    func testRateChangedZeroWhileBufferingSuppressesPaused() {
        // 缓冲等待（waitingToPlayAtSpecifiedRate）不算暂停，避免网络抖一下 UI 闪暂停
        var m = PlayerStateMachine()
        m.requestPlay()
        XCTAssertEqual(m.rateChanged(rate: 0, isWaiting: true), nil)
        XCTAssertEqual(m.state, .playing, "缓冲等待不改变状态")
    }

    func testRateChangedZeroDuringSeekSuppressesPaused() {
        // seek 期间（精确 seek 短暂 rate=0）不推 paused（2026-08-23 跟唱状态错乱根因）
        var m = PlayerStateMachine()
        m.requestPlay()
        m.seekStarted()
        XCTAssertEqual(m.rateChanged(rate: 0, isWaiting: false), nil)
        XCTAssertEqual(m.state, .playing)
    }

    func testItemEndedPushesEnded() {
        var m = PlayerStateMachine()
        m.itemLoaded()
        m.requestPlay()
        XCTAssertEqual(m.itemEnded(), .ended)
        XCTAssertEqual(m.state, .ended)
    }

    // MARK: - seek 串行化（跟唱跳句竞态回归，2026-08-23）

    func testSeekWhilePausedThenNoPlaySupplementsPaused() {
        // 跳转暂停场景：seek 完成仍是暂停 → 补推 paused（seek 期间被抑制的那次）
        var m = PlayerStateMachine()
        m.requestPause()
        m.seekStarted()
        XCTAssertEqual(m.rateChanged(rate: 0, isWaiting: false), nil, "seek 中 rate=0 不推 paused")
        let event = m.seekFinished(shouldPlay: false, isPausedNow: true)
        XCTAssertEqual(event, .paused, "seek 完成补推 paused")
        XCTAssertEqual(m.state, .paused)
    }

    func testSeekWhilePlayingNoPushOnCompletion() {
        // 播放中 seek：完成不推（rate 观察自然推 playing）；状态保持 playing
        var m = PlayerStateMachine()
        m.requestPlay()
        m.seekStarted()
        XCTAssertEqual(m.seekFinished(shouldPlay: false, isPausedNow: false), nil)
        XCTAssertEqual(m.state, .playing)
    }

    func testSeekThenPlayResumesAfterSeek() {
        // 跟唱跳句核心竞态：seek 中收到 play → seek 完成后续播（playAfterSeek），
        // 不补推 paused（播放动作后 rate 观察推 playing）
        var m = PlayerStateMachine()
        m.requestPause()
        m.seekStarted()
        XCTAssertEqual(m.requestPlay(), nil, "seek 中 play：只标记待播，不推事件")
        XCTAssertTrue(m.playAfterSeek, "seek 中 play → playAfterSeek 置位")
        let event = m.seekFinished(shouldPlay: true, isPausedNow: true)
        XCTAssertEqual(event, nil, "续播不补推 paused（Bridge 执行 play，rate 观察推 playing）")
        XCTAssertEqual(m.state, .playing)
        XCTAssertFalse(m.playAfterSeek, "playAfterSeek 一次性消费")
    }

    func testSeekThenPauseStillResumesIfPlayArrivedBeforePause() {
        // seek 中 play 后又 pause：playAfterSeek 仍生效（原实现 pause 不清 playAfterSeek）
        var m = PlayerStateMachine()
        m.requestPause()
        m.seekStarted()
        m.requestPlay() // 先 play
        m.requestPause() // 后 pause（原实现：不改变 playAfterSeek）
        XCTAssertTrue(m.playAfterSeek)
        XCTAssertEqual(m.seekFinished(shouldPlay: true, isPausedNow: true), nil)
        XCTAssertEqual(m.state, .playing)
    }

    func testRepeatedSeekOverwritesAndClearsOnCompletion() {
        // 重复 seek：seeking 标记幂等；完成后清除
        var m = PlayerStateMachine()
        m.requestPause()
        m.seekStarted()
        m.seekStarted()
        m.seekStarted()
        XCTAssertTrue(m.isSeeking)
        m.seekFinished(shouldPlay: false, isPausedNow: true)
        XCTAssertFalse(m.isSeeking, "seek 完成清 seeking 标记")
        XCTAssertEqual(m.state, .paused)
    }

    // MARK: - 中断恢复（复用 InterruptionPolicy 语义）

    func testInterruptionBeganWhilePlayingNoPush() {
        // 中断前在播：不推 paused（结束后恢复播放，前端保持播放态）
        var m = PlayerStateMachine()
        m.requestPlay()
        XCTAssertEqual(m.interruptionBegan(wasPlaying: true, isWaiting: false), nil)
    }

    func testInterruptionBeganWhilePausedPushesPaused() {
        // 中断前暂停（系统已暂停 AVPlayer）：同步推 paused（避免 UI 停留播放态）
        var m = PlayerStateMachine()
        m.requestPause()
        XCTAssertEqual(m.interruptionBegan(wasPlaying: false, isWaiting: false), .paused)
        XCTAssertEqual(m.state, .paused)
    }

    func testInterruptionBeganWhileBufferingNoPush() {
        // 缓冲等待不算播放也不算暂停：不推（中断恢复语义同「非在播」）
        var m = PlayerStateMachine()
        m.requestPlay()
        XCTAssertEqual(m.interruptionBegan(wasPlaying: false, isWaiting: true), nil)
    }

    func testInterruptionEndedResumesAfterPlayingInterruption() {
        // 中断前在播 → 结束后恢复（推 playing，Bridge 执行 play + 推事件）
        var m = PlayerStateMachine()
        m.requestPlay()
        m.interruptionBegan(wasPlaying: true, isWaiting: false)
        XCTAssertEqual(m.interruptionEnded(), .playing)
        XCTAssertEqual(m.state, .playing)
    }

    func testInterruptionEndedDoesNotResumeAfterManualPause() {
        // 手动暂停后被打断 → 不恢复（音乐播放器惯例）
        var m = PlayerStateMachine()
        m.requestPause()
        m.interruptionBegan(wasPlaying: false, isWaiting: false)
        XCTAssertEqual(m.interruptionEnded(), nil)
    }

    func testInterruptionEndedResets() {
        // ended 后重置：再次 ended 不再恢复（避免重复恢复）
        var m = PlayerStateMachine()
        m.requestPlay()
        m.interruptionBegan(wasPlaying: true, isWaiting: false)
        XCTAssertEqual(m.interruptionEnded(), .playing)
        XCTAssertEqual(m.interruptionEnded(), nil, "ended 后重置：第二次不再恢复")
    }

    func testRepeatedInterruptionBeganOverwrites() {
        // 连续两次中断开始（罕见但可能）：第二次覆盖第一次
        var m = PlayerStateMachine()
        m.requestPlay()
        m.interruptionBegan(wasPlaying: true, isWaiting: false)
        m.interruptionBegan(wasPlaying: false, isWaiting: false)
        XCTAssertEqual(m.interruptionEnded(), nil, "第二次 began(false) 覆盖第一次 → 不恢复")
    }
}
