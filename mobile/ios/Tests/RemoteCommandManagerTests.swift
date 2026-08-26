import XCTest

@testable import QQPlayer

/// RemoteCommandManager（Pass 2 从 AVPlayerBridge 拆出）测试：搬移后行为不变——
/// setQueue 快照夹取/清空、playQueueRelative 队列切歌（load/play/applyMetadata/songChanged/
/// 锁屏态同步）、无队列兑底转发 Web、play/pause/toggle/seek 命令处理器。
/// 播放动作走闭包接缝（AVPlayer 在 Bridge 手里），测试用 Recorder 记录回调验证接缝语义。
final class RemoteCommandManagerTests: XCTestCase {
    /// 记录闭包回调调用（模拟 Bridge 侧执行器，验证组件 → Bridge 接缝行为）
    private final class Recorder {
        var loads: [URL] = []
        var plays = 0
        var pauses = 0
        var playingStates: [Bool?] = []
        var metadata: [[String: Any]] = []
        var events: [(String, [String: Any])] = []
        var seeks: [TimeInterval] = []
        var fallbacks: [String] = []
        var isPlayingValue = false
    }

    private func makeManager(recorder: Recorder) -> RemoteCommandManager {
        let m = RemoteCommandManager()
        m.onLoad = { recorder.loads.append($0) }
        m.onPlay = { recorder.plays += 1 }
        m.onPause = { recorder.pauses += 1 }
        m.isPlaying = { recorder.isPlayingValue }
        m.onApplyMetadata = { recorder.metadata.append($0) }
        m.onPushEvent = { recorder.events.append(($0, $1)) }
        m.onUpdatePlaybackState = { recorder.playingStates.append($0) }
        m.onSeek = { recorder.seeks.append($0) }
        m.onFallbackCommand = { recorder.fallbacks.append($0) }
        return m
    }

    // MARK: - setQueue 快照

    func testSetQueueStoresSongsAndClampsIndex() {
        let m = makeManager(recorder: Recorder())
        let songs: [[String: Any]] = [["url": "a"], ["url": "b"], ["url": "c"]]
        m.handleSetQueue(["songs": songs, "index": 1])
        XCTAssertEqual(m.queue.count, 3)
        XCTAssertEqual(m.queueIndex, 1)
        // 越界 index 夹取到边界（min(max(0, raw), count-1)）
        m.handleSetQueue(["songs": songs, "index": 99])
        XCTAssertEqual(m.queueIndex, 2)
        m.handleSetQueue(["songs": songs, "index": -5])
        XCTAssertEqual(m.queueIndex, 0)
    }

    func testSetQueueEmptyOrInvalidClearsSnapshot() {
        let m = makeManager(recorder: Recorder())
        let songs: [[String: Any]] = [["url": "a"]]
        m.handleSetQueue(["songs": songs, "index": 0])
        XCTAssertEqual(m.queue.count, 1)
        // 空数组 → 清空快照（next/prev 走 Web 兑底）
        m.handleSetQueue(["songs": [], "index": 0])
        XCTAssertTrue(m.queue.isEmpty)
        XCTAssertEqual(m.queueIndex, 0)
        // 非数组 → 清空快照
        m.handleSetQueue(["songs": "not-array"])
        XCTAssertTrue(m.queue.isEmpty)
        XCTAssertEqual(m.queueIndex, 0)
    }

    // MARK: - playQueueRelative 原生队列切歌

    func testPlayQueueRelativeLoadsPlaysAndPublishes() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        let songs: [[String: Any]] = [
            ["url": "http://127.0.0.1:9/1.mp3", "title": "A"],
            ["url": "http://127.0.0.1:9/2.mp3", "title": "B"],
        ]
        m.handleSetQueue(["songs": songs, "index": 0])
        m.playQueueRelative(1)
        XCTAssertEqual(r.loads, [URL(string: "http://127.0.0.1:9/2.mp3")!])
        XCTAssertEqual(r.plays, 1, "锁屏切歌即播放")
        XCTAssertEqual(r.metadata.count, 1)
        XCTAssertEqual(r.metadata[0]["title"] as? String, "B")
        // songChanged 推送新 index（Web 对齐状态不重新 load）
        XCTAssertEqual(r.events.first?.0, "songChanged")
        XCTAssertEqual(r.events.first?.1["index"] as? Int, 1)
        XCTAssertEqual(r.playingStates, [true], "切歌后锁屏态同步为播放")
        XCTAssertEqual(m.queueIndex, 1)
    }

    func testPlayQueueRelativeEmptyQueueDoesNothing() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        m.playQueueRelative(1)
        m.playQueueRelative(-1)
        XCTAssertTrue(r.loads.isEmpty)
        XCTAssertEqual(r.plays, 0)
        XCTAssertTrue(r.events.isEmpty)
        XCTAssertTrue(r.fallbacks.isEmpty, "playQueueRelative 不走 Web 兑底（兑底在 handleNext/Previous）")
        XCTAssertEqual(m.queueIndex, 0)
    }

    func testPlayQueueRelativeWrapsAround() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        let songs: [[String: Any]] = [["url": "u1"], ["url": "u2"], ["url": "u3"]]
        m.handleSetQueue(["songs": songs, "index": 2])
        m.playQueueRelative(1) // 队尾 +1 → 队首
        XCTAssertEqual(m.queueIndex, 0)
        XCTAssertEqual(r.loads, [URL(string: "u1")!])
        m.playQueueRelative(-1) // 队首 -1 → 队尾
        XCTAssertEqual(m.queueIndex, 2)
        XCTAssertEqual(r.loads.last, URL(string: "u3")!)
    }

    func testPlayQueueRelativeStreamSongSkipsPlaybackButAdvancesCursor() {
        // 既有行为（MVP 限制）：stream 歌 url 为空 → 不 load/不 play，但游标已前进；
        // 下次切歌从新位置开始（历史语义，搬移后不变）
        let r = Recorder()
        let m = makeManager(recorder: r)
        let songs: [[String: Any]] = [
            ["url": "http://127.0.0.1:9/ok.mp3", "title": "本地歌"],
            ["url": "", "title": "stream 歌"],
            ["url": "http://127.0.0.1:9/ok2.mp3", "title": "本地歌2"],
        ]
        m.handleSetQueue(["songs": songs, "index": 0])
        m.playQueueRelative(1)
        XCTAssertEqual(m.queueIndex, 1, "游标已前进")
        XCTAssertTrue(r.loads.isEmpty, "stream 歌不 load")
        XCTAssertEqual(r.plays, 0)
        m.playQueueRelative(1)
        XCTAssertEqual(m.queueIndex, 2)
        XCTAssertEqual(r.loads, [URL(string: "http://127.0.0.1:9/ok2.mp3")!], "跨过 stream 歌继续切")
    }

    // MARK: - next/prev 命令（含无队列兑底）

    func testHandleNextWithoutQueueFallsBackToWeb() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        m.handleNext()
        XCTAssertEqual(r.fallbacks, ["next"])
        XCTAssertTrue(r.events.isEmpty)
    }

    func testHandlePreviousWithoutQueueFallsBackToWeb() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        m.handlePrevious()
        XCTAssertEqual(r.fallbacks, ["prev"])
    }

    func testHandleNextWithQueueAdvances() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        let songs: [[String: Any]] = [["url": "u1"], ["url": "u2"]]
        m.handleSetQueue(["songs": songs, "index": 0])
        m.handleNext()
        XCTAssertEqual(m.queueIndex, 1)
        XCTAssertEqual(r.loads, [URL(string: "u2")!])
        XCTAssertEqual(r.events.first?.0, "songChanged")
        XCTAssertTrue(r.fallbacks.isEmpty)
    }

    // MARK: - play/pause/toggle/seek 命令处理器

    func testHandlePlayAndPauseSyncPlaybackState() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        m.handlePlay()
        XCTAssertEqual(r.plays, 1)
        XCTAssertEqual(r.pauses, 0)
        XCTAssertEqual(r.playingStates, [nil], "播放后同步锁屏态（playing 参数 nil → 读当前 rate）")
        m.handlePause()
        XCTAssertEqual(r.plays, 1)
        XCTAssertEqual(r.pauses, 1)
        XCTAssertEqual(r.playingStates, [nil, nil])
    }

    func testHandleToggleFollowsIsPlaying() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        r.isPlayingValue = true
        m.handleToggle()
        XCTAssertEqual(r.pauses, 1)
        XCTAssertEqual(r.plays, 0)
        r.isPlayingValue = false
        m.handleToggle()
        XCTAssertEqual(r.pauses, 1)
        XCTAssertEqual(r.plays, 1)
    }

    func testHandleSeekForwardsPosition() {
        let r = Recorder()
        let m = makeManager(recorder: r)
        m.handleSeek(to: 42.5)
        XCTAssertEqual(r.seeks, [42.5])
    }
}
