import MediaPlayer
import UIKit
import XCTest

@testable import QQPlayer

/// MetadataManager（Pass 2 从 AVPlayerBridge 拆出）测试：搬移后行为不变——
/// applyMetadata 封面策略（data: URL 同步解码 / 内嵌兑底 / 纯异步）、坏 base64 兑底、
/// 空 cover 保留旧封面、锁屏进度/播放态/时长同步。
/// 播放器状态走闭包接缝（AVPlayer 在 Bridge 手里），测试用固定闭包值验证元数据写入。
final class MetadataManagerTests: XCTestCase {
    override func setUp() {
        super.setUp()
        // 单例隔离：每个用例从干净 nowPlayingInfo 开始（避免跨用例残留封面/进度）
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
    }

    /// 固定状态闭包：rate=1.5、当前时间=30s、时长=200s（模拟 Bridge 读 AVPlayer）
    private func makeManager() -> MetadataManager {
        let mgr = MetadataManager()
        mgr.currentRate = { 1.5 }
        mgr.currentTime = { 30 }
        mgr.currentDuration = { 200 }
        mgr.currentItem = { nil }
        return mgr
    }

    private func makeArtwork() -> MPMediaItemArtwork {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10))
        let img = renderer.image { ctx in
            UIColor.systemRed.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
        }
        return MPMediaItemArtwork(boundsSize: img.size) { _ in img }
    }

    private func makeDataURLCover() -> String {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20))
        let img = renderer.image { ctx in
            UIColor.systemBlue.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        return "data:image/png;base64,\(img.pngData()!.base64EncodedString())"
    }

    // MARK: - applyMetadata 封面策略

    func testApplyMetadataDataURLCoverDecodesSync() {
        let mgr = makeManager()
        mgr.applyMetadata(["coverUrl": makeDataURLCover()])
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual(info?[MPMediaItemPropertyTitle] as? String, "QQPlayer", "空标题 → 默认 QQPlayer")
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 1.5)
        XCTAssertEqual((info?[MPMediaItemPropertyPlaybackDuration] as? NSNumber)?.doubleValue, 200)
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 30)
        XCTAssertNotNil(info?[MPMediaItemPropertyArtwork], "data: URL 同步解码 → 应立即有封面")
    }

    func testApplyMetadataHttpCoverUsesEmbeddedFallbackSync() {
        let mgr = makeManager()
        mgr.embeddedArtwork = makeArtwork()
        mgr.applyMetadata(["coverUrl": "http://127.0.0.1:9/cover.jpg", "title": "T"])
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual(info?[MPMediaItemPropertyTitle] as? String, "T")
        XCTAssertNotNil(info?[MPMediaItemPropertyArtwork], "http 封面 + 内嵌 → 同步兑底，锁屏立即有图")
        // 异步拉取（127.0.0.1:9 连不上 → 失败）保留兑底图：不覆盖
    }

    func testApplyMetadataBadBase64FallsBackWithoutArtwork() {
        let mgr = makeManager()
        mgr.applyMetadata(["coverUrl": "data:image/png;base64,%%%not-base64%%%", "title": "T"])
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual(info?[MPMediaItemPropertyTitle] as? String, "T")
        XCTAssertNil(info?[MPMediaItemPropertyArtwork], "坏 base64 解码失败 → 无封面（无内嵌可兑底）")
    }

    func testApplyMetadataEmptyCoverKeepsExistingArtwork() {
        let mgr = makeManager()
        mgr.applyMetadata(["coverUrl": makeDataURLCover()]) // 先放一张封面
        let existing = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork]
        XCTAssertNotNil(existing)
        // 无 coverUrl → 保留旧封面兑底（避免异步补图窗口顶掉旧封面）
        mgr.applyMetadata(["title": "新歌"])
        let kept = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork]
        XCTAssertNotNil(kept)
    }

    // MARK: - 锁屏进度/播放态/时长同步

    func testUpdateNowPlayingSetsDurationElapsedAndRate() {
        let mgr = makeManager()
        mgr.updateNowPlaying(duration: 200)
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual((info?[MPMediaItemPropertyPlaybackDuration] as? NSNumber)?.doubleValue, 200)
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 30)
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 1.5)
    }

    func testUpdateNowPlayingProgressWritesFields() {
        let mgr = makeManager()
        // duration<=0 → 不写 duration（timeupdate 早期时长未知）
        mgr.updateNowPlayingProgress(t: 12, duration: 0, rate: 0)
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 12)
        XCTAssertNil(info?[MPMediaItemPropertyPlaybackDuration])
        mgr.updateNowPlayingProgress(t: 15, duration: 99, rate: 2)
        info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 15)
        XCTAssertEqual((info?[MPMediaItemPropertyPlaybackDuration] as? NSNumber)?.doubleValue, 99)
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 2)
    }

    func testUpdateNowPlayingPlaybackStateRespectsExplicitPlaying() {
        let mgr = makeManager() // currentRate = 1.5
        mgr.updateNowPlayingPlaybackState(playing: false)
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 0, "显式暂停 → rate 写 0")
        // playing 为 nil → 读当前 rate（1.5 > 0 → 播放态）
        mgr.updateNowPlayingPlaybackState(playing: nil)
        info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 1.5)
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyElapsedPlaybackTime] as? NSNumber)?.doubleValue, 30)
    }

    func testUpdateNowPlayingPlaybackStateWithStoppedRate() {
        let mgr = makeManager()
        mgr.currentRate = { 0 } // 播放器停了
        mgr.updateNowPlayingPlaybackState(playing: nil)
        let info = MPNowPlayingInfoCenter.default().nowPlayingInfo
        XCTAssertEqual((info?[MPNowPlayingInfoPropertyPlaybackRate] as? NSNumber)?.doubleValue, 0)
    }
}
