import XCTest

@testable import QQPlayer

/// 播放顺序快照纯模型（PlayerQueue，Pass 3 从 RemoteCommandManager 抽出）测试：
/// 快照替换/越界夹取/空清空、游标环绕移动、stream 歌（url 空）跳过播放但游标前进。
/// 语义与 RemoteCommandManager 原实现一致（RemoteCommandManagerTests 已固化存量行为）。
final class PlayerQueueTests: XCTestCase {
    private func song(_ url: String, _ title: String) -> [String: Any] {
        ["url": url, "title": title]
    }

    // MARK: - 快照替换（setQueue 语义）

    func testReplaceStoresSongsAndClampsIndex() {
        var q = PlayerQueue()
        q.replace(songs: [song("a", "A"), song("b", "B"), song("c", "C")], index: 1)
        XCTAssertEqual(q.count, 3)
        XCTAssertEqual(q.index, 1)
        XCTAssertEqual(q.currentSong?["title"] as? String, "B")
        // 越界 index 夹取到边界（min(max(0, raw), count-1)）
        q.replace(songs: [song("a", "A"), song("b", "B"), song("c", "C")], index: 99)
        XCTAssertEqual(q.index, 2)
        q.replace(songs: [song("a", "A"), song("b", "B"), song("c", "C")], index: -5)
        XCTAssertEqual(q.index, 0)
    }

    func testReplaceEmptyOrInvalidClearsSnapshot() {
        var q = PlayerQueue()
        q.replace(songs: [song("a", "A")], index: 0)
        XCTAssertEqual(q.count, 1)
        // 空数组 → 清空快照（next/prev 走 Web 兑底）
        q.replace(songs: [], index: 0)
        XCTAssertTrue(q.isEmpty)
        XCTAssertEqual(q.index, 0)
        XCTAssertNil(q.currentSong, "空快照无当前歌")
        // 非数组（调用方传空）→ 清空快照
        q.replace(songs: [], index: 7)
        XCTAssertTrue(q.isEmpty)
        XCTAssertEqual(q.index, 0)
    }

    // MARK: - 游标相对移动（环绕，复用 QueueCursor 语义）

    func testAdvanceMovesCursorWithWrapAround() {
        var q = PlayerQueue()
        q.replace(songs: [song("u1", "1"), song("u2", "2"), song("u3", "3")], index: 0)
        XCTAssertTrue(q.advance(1))
        XCTAssertEqual(q.index, 1)
        XCTAssertTrue(q.advance(1))
        XCTAssertEqual(q.index, 2)
        XCTAssertTrue(q.advance(1), "队尾 +1 → 队首（环绕）")
        XCTAssertEqual(q.index, 0)
        XCTAssertTrue(q.advance(-1), "队首 -1 → 队尾（环绕）")
        XCTAssertEqual(q.index, 2)
    }

    func testAdvanceOnEmptyQueueDoesNothing() {
        var q = PlayerQueue()
        XCTAssertFalse(q.advance(1))
        XCTAssertFalse(q.advance(-1))
        XCTAssertEqual(q.index, 0)
    }

    func testAdvanceSingleSongStaysZero() {
        var q = PlayerQueue()
        q.replace(songs: [song("u1", "1")], index: 0)
        XCTAssertTrue(q.advance(1), "单曲队列前进应成功（停留 0）")
        XCTAssertEqual(q.index, 0)
        XCTAssertTrue(q.advance(-1))
        XCTAssertEqual(q.index, 0)
    }

    // MARK: - stream 歌跳过规则（url 空）

    func testStreamSongSkipPlaybackButCursorAdvances() {
        // 既有行为（MVP 限制）：stream 歌 url 为空 → 不播放（currentSongURL nil），
        // 但游标已前进；下次切歌从新位置开始（历史语义，RemoteCommandManagerTests 已固化）
        var q = PlayerQueue()
        q.replace(
            songs: [song("http://127.0.0.1:9/ok.mp3", "本地歌"), song("", "stream 歌"), song("http://127.0.0.1:9/ok2.mp3", "本地歌2")],
            index: 0
        )
        XCTAssertTrue(q.advance(1))
        XCTAssertEqual(q.index, 1, "游标已前进到 stream 歌")
        XCTAssertNil(q.currentSongURL, "stream 歌 url 为空 → 不可播放")
        XCTAssertTrue(q.advance(1))
        XCTAssertEqual(q.index, 2)
        XCTAssertEqual(q.currentSongURL, URL(string: "http://127.0.0.1:9/ok2.mp3"), "跨过 stream 歌继续切")
    }

    func testCurrentSongURLRequiresNonEmptyURL() {
        var q = PlayerQueue()
        q.replace(songs: [song("", "空 url")], index: 0)
        XCTAssertNil(q.currentSongURL)
        q.replace(songs: [song("https://example.com/a.mp3", "正常")], index: 0)
        XCTAssertEqual(q.currentSongURL, URL(string: "https://example.com/a.mp3"))
    }
}
