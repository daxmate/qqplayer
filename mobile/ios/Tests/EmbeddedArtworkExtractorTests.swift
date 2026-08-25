import AVFoundation
import XCTest

@testable import QQPlayer

/// 内嵌封面提取（EmbeddedArtworkExtractor.artworkData）测试：
/// 用 AVMutableMetadataItem 构造各种 metadata 形态，无需真实音频文件。
/// 注意：commonKey 是只读派生属性（由 key+keySpace/identifier 映射而来），
/// 构造时设 key/keySpace/identifier，与 AVFoundation 真实加载路径一致。
final class EmbeddedArtworkExtractorTests: XCTestCase {
    private func makeItem(
        key: NSString? = nil,
        keySpace: AVMetadataKeySpace? = nil,
        identifier: AVMetadataIdentifier? = nil,
        data: Data? = nil
    ) -> AVMutableMetadataItem {
        let item = AVMutableMetadataItem()
        if let key { item.key = key }
        if let keySpace { item.keySpace = keySpace }
        if let identifier { item.identifier = identifier }
        if let data { item.value = data as NSData }
        return item
    }

    private let artworkData = Data([0x89, 0x50, 0x4E, 0x47]) // 假 PNG 头（提取器只关心 Data 存在）

    // MARK: - id3

    func testID3CommonKeyArtwork() {
        // MP3 常见 APIC：key=APIC + keySpace=id3 → commonKey 映射为 artwork
        let items = [makeItem(key: "APIC" as NSString, keySpace: .id3, data: artworkData)]
        XCTAssertEqual(EmbeddedArtworkExtractor.artworkData(from: items), artworkData)
    }

    func testID3AttachedPictureIdentifier() {
        // APIC 走 identifier（id3MetadataAttachedPicture）
        let items = [makeItem(identifier: AVMetadataIdentifier.id3MetadataAttachedPicture, data: artworkData)]
        XCTAssertEqual(EmbeddedArtworkExtractor.artworkData(from: items), artworkData)
    }

    // MARK: - iTunes / quickTime（commonKey 形态）

    func testITunesCommonKeyArtwork() {
        // M4A 常见 covr：key=covr + keySpace=iTunes → commonKey 映射为 artwork
        let items = [makeItem(key: "covr" as NSString, keySpace: .iTunes, data: artworkData)]
        XCTAssertEqual(EmbeddedArtworkExtractor.artworkData(from: items), artworkData)
    }

    func testQuickTimeCommonKeyArtwork() {
        // quickTimeMetadataArtwork（mdta/com.apple.quicktime.artwork）→ commonKey 映射为 artwork
        let items = [makeItem(identifier: AVMetadataIdentifier.quickTimeMetadataArtwork, data: artworkData)]
        XCTAssertEqual(EmbeddedArtworkExtractor.artworkData(from: items), artworkData)
    }

    // MARK: - 兜底语义（遍历扫描）

    func testSkipsNonArtworkItemsThenFindsArtwork() {
        // 前面的非封面 item 跳过，扫到后面的封面 item（commonMetadata 兜底的遍历语义）
        let title = makeItem(key: "TIT2" as NSString, keySpace: .id3, data: Data("title".utf8))
        let artwork = makeItem(key: "APIC" as NSString, keySpace: .id3, data: artworkData)
        XCTAssertEqual(EmbeddedArtworkExtractor.artworkData(from: [title, artwork]), artworkData)
    }

    func testSkipsItemWithNilDataValue() {
        // 命中条件满足但 dataValue 为 nil（如 APIC 无数据）→ 跳过继续找
        let empty = makeItem(key: "APIC" as NSString, keySpace: .id3)
        let artwork = makeItem(key: "APIC" as NSString, keySpace: .id3, data: artworkData)
        XCTAssertEqual(EmbeddedArtworkExtractor.artworkData(from: [empty, artwork]), artworkData)
    }

    // MARK: - 无封面

    func testNoArtworkReturnsNil() {
        let title = makeItem(key: "TIT2" as NSString, keySpace: .id3, data: Data("title".utf8))
        let artist = makeItem(key: "TPE1" as NSString, keySpace: .id3, data: Data("artist".utf8))
        XCTAssertNil(EmbeddedArtworkExtractor.artworkData(from: [title, artist]))
    }

    func testEmptyItemsReturnsNil() {
        XCTAssertNil(EmbeddedArtworkExtractor.artworkData(from: []))
    }
}
