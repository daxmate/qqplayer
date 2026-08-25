import XCTest

@testable import QQPlayer

/// 播放队列游标（QueueCursor）测试：锁屏/线控后台切歌（playQueueRelative）的
/// 索引环绕移动——前进/回退/越界环绕/单曲队列恒 0/空队列不动。
final class QueueCursorTests: XCTestCase {
    func testAdvanceForward() {
        var cursor = QueueCursor(index: 0)
        XCTAssertTrue(cursor.advance(1, count: 3), "前进应移动")
        XCTAssertEqual(cursor.index, 1)
    }

    func testAdvanceBackward() {
        var cursor = QueueCursor(index: 1)
        XCTAssertTrue(cursor.advance(-1, count: 3), "回退应移动")
        XCTAssertEqual(cursor.index, 0)
    }

    func testWrapAround() {
        // 越界环绕：队尾 +1 → 队首
        var cursor = QueueCursor(index: 2)
        XCTAssertTrue(cursor.advance(1, count: 3))
        XCTAssertEqual(cursor.index, 0)
        // 队首 -1 → 队尾
        var cursor2 = QueueCursor(index: 0)
        XCTAssertTrue(cursor2.advance(-1, count: 3))
        XCTAssertEqual(cursor2.index, 2)
    }

    func testSingleSongQueueStaysZero() {
        var cursor = QueueCursor(index: 0)
        XCTAssertTrue(cursor.advance(1, count: 1), "单曲队列前进应成功（停留 0）")
        XCTAssertEqual(cursor.index, 0)
        XCTAssertTrue(cursor.advance(-1, count: 1))
        XCTAssertEqual(cursor.index, 0)
    }

    func testEmptyQueueDoesNotMove() {
        // count<=0：队列无效，返回 false 且 index 不变
        var cursor = QueueCursor(index: 2)
        XCTAssertFalse(cursor.advance(1, count: 0))
        XCTAssertEqual(cursor.index, 2)
        XCTAssertFalse(cursor.advance(-1, count: 0))
        XCTAssertEqual(cursor.index, 2)
        XCTAssertFalse(cursor.advance(1, count: -1))
        XCTAssertEqual(cursor.index, 2)
    }
}
