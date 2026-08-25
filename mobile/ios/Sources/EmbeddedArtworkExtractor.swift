import AVFoundation

/// 内嵌封面提取（可测纯逻辑）：从 metadata items 里找第一张封面图数据。
/// 命中条件：commonKey == artwork（所有容器统一键）或 id3 APIC 标识符；dataValue 为 nil 跳过。
/// 供 AVPlayerBridge.loadEmbeddedArtwork 逐格式调用（id3/iTunes/quickTime + commonMetadata 兑底）。
enum EmbeddedArtworkExtractor {
    static func artworkData(from items: [AVMetadataItem]) -> Data? {
        for item in items
            where item.commonKey == .commonKeyArtwork
            || item.identifier == AVMetadataIdentifier.id3MetadataAttachedPicture {
            if let data = item.dataValue {
                return data
            }
        }
        return nil
    }
}
