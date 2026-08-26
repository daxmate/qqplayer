import AVFoundation
import MediaPlayer
import UIKit

/// 锁屏/封面元数据管理（AVPlayerBridge 拆分组件，纯搬移，行为零变化）。
/// - applyMetadata（前端 setMetadata 驱动）：标题/歌手/专辑/封面 → MPNowPlayingInfoCenter
/// - 封面策略（CoverDecision）：data: URL 同步解码 / 内嵌封面兑底 + 异步覆盖 / 纯异步
/// - 内嵌封面预读（APIC 预读缓存）+ 异步拉取（loadArtwork，Bearer 鉴权）
/// - 锁屏进度/播放态同步（updateNowPlaying / updateNowPlayingProgress / updateNowPlayingPlaybackState）
/// AVPlayer 在 AVPlayerBridge 手里，组件不持有播放器——当前状态（rate/时间/currentItem）
/// 通过闭包只读回调（currentRate/currentTime/currentDuration/currentItem）获取。
final class MetadataManager {
    /// 当前 item 的内嵌封面（APIC 预读缓存）：无线 CarPlay 脱离 Mac 网络且封面无缓存时
    /// 唯一不依赖网络的封面来源；切歌时清空、新歌预读完成后填充（旧歌结果丢弃防乱序）。
    var embeddedArtwork: MPMediaItemArtwork?

    private var nowPlayingArtwork: MPMediaItemArtwork?

    // MARK: - Bridge 状态只读回调（AVPlayer 在 Bridge 手里，组件只读当前值）

    /// 当前播放速率（player.rate）
    var currentRate: (() -> Double)?
    /// 当前播放时间（player.currentTime().seconds）
    var currentTime: (() -> Double)?
    /// 当前 item 时长（player.currentItem?.duration.seconds）
    var currentDuration: (() -> Double)?
    /// 当前 item（loadEmbeddedArtwork 完成时校验是否已切歌）
    var currentItem: (() -> AVPlayerItem?)?

    /// Bearer token（配对鉴权）：异步拉取封面（/api/cover）时附加 Authorization 头。
    /// 真机 401 根因（2026-08-23）：127.0.0.1 免鉴权模拟器正常，真机必须带 token。
    var authToken: String?

    // MARK: - 锁屏 Now Playing

    func applyMetadata(_ payload: [String: Any]) {
        let title = payload["title"] as? String ?? ""
        let artist = payload["artist"] as? String ?? ""
        let album = payload["album"] as? String ?? ""
        let cover = payload["coverUrl"] as? String ?? ""
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title.isEmpty ? "QQPlayer" : title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyAlbumTitle: album,
            MPNowPlayingInfoPropertyPlaybackRate: currentRate?() ?? 0,
        ]
        // 先保留旧封面兑底：任何时刻 nowPlayingInfo 都带 artwork 键，
        // 避免「先同步发布无封面信息、后异步补图」顶掉旧封面——锁屏会刷新，
        // 但 CarPlay 车机大多不刷新异步补的图（2026-08-25 真机空白根因 A）。
        if let existing = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork] {
            info[MPMediaItemPropertyArtwork] = existing
        } else if let art = nowPlayingArtwork {
            info[MPMediaItemPropertyArtwork] = art
        }
        let duration = currentDuration?() ?? 0
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime?() ?? 0
        }
        if !cover.isEmpty {
            // 封面策略决策（纯逻辑，CoverDecision 可测）：
            // data: URL 同步解码即时有封面（不走异步，无「先空后补」窗口）；
            // http 封面 → 先同步用内嵌封面兑底（CarPlay 即时刷新，不依赖网络/缓存），
            // 再异步 loadArtwork 拉远程/本地图，成功后覆盖（锁屏会刷新到更佳图）。
            switch CoverDecision.decide(coverUrl: cover, hasEmbedded: embeddedArtwork != nil) {
            case .syncDataURL:
                if let art = decodeArtwork(cover) {
                    nowPlayingArtwork = art
                    info[MPMediaItemPropertyArtwork] = art
                } else {
                    // 解码失败（坏 base64）：与历史 if/else 链一致，兑底内嵌 → 异步
                    applyEmbeddedFallback(cover: cover, info: &info)
                }
            case .embeddedThenAsync:
                applyEmbeddedFallback(cover: cover, info: &info)
            case .asyncOnly:
                fetchArtworkAsync(cover: cover, fallbackInfo: info)
            }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func updateNowPlaying(duration: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime?() ?? 0
        info[MPNowPlayingInfoPropertyPlaybackRate] = currentRate?() ?? 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func updateNowPlayingProgress(t: Double, duration: Double, rate: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    func updateNowPlayingPlaybackState(playing: Bool? = nil) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        let rate = currentRate?() ?? 0
        let p = playing ?? (rate > 0)
        info[MPNowPlayingInfoPropertyPlaybackRate] = p ? rate : 0
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = currentTime?() ?? 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    // MARK: - 封面图加载

    /// 封面图：data: URL 直接解码；http(s) 异步拉取（附加 Bearer 鉴权头——真机 /api/cover
    /// 401 兑底，2026-08-23）；相对路径按服务器 base 前缀补全（调用方已处理）
    private func loadArtwork(_ cover: String, completion: @escaping (MPMediaItemArtwork?) -> Void) {
        if cover.hasPrefix("data:image/") {
            completion(decodeArtwork(cover))
            return
        }
        guard let url = URL(string: cover), cover.hasPrefix("http") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url)
        // 与前端 resolveNativeUrl 的 ?token= 双保险：URLSession 拉图带 Authorization 头
        // （后端两者都认；第三方直链/本地资产无 token 时不带，保持原样）
        if let token = authToken, !token.isEmpty {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        URLSession.shared.dataTask(with: request) { data, _, _ in
            DispatchQueue.main.async {
                if let data, let img = UIImage(data: data) {
                    completion(MPMediaItemArtwork(boundsSize: img.size) { _ in img })
                } else {
                    completion(nil)
                }
            }
        }.resume()
    }

    /// 预读当前 item 的内嵌封面（APIC/artwork）：切歌后异步读音频文件元数据，
    /// 供 applyMetadata 兑底（无线 CarPlay 脱离 Mac 网络 + 封面无缓存时唯一可靠来源）。
    /// 读取是异步的：完成时若 item 已切换则丢弃结果（防旧歌封面覆盖新歌）。
    func loadEmbeddedArtwork(for item: AVPlayerItem) {
        let asset = item.asset
        Task {
            var artworkData: Data?
            // MP3 常见 id3 APIC；M4A 走 iTunes；其余容器 commonMetadata 兑底
            let formats: [AVMetadataFormat] = [.id3Metadata, .iTunesMetadata, .quickTimeMetadata]
            for format in formats {
                if let items = try? await asset.loadMetadata(for: format) {
                    artworkData = EmbeddedArtworkExtractor.artworkData(from: items)
                }
                if artworkData != nil { break }
            }
            if artworkData == nil, let items = try? await asset.load(.commonMetadata) {
                artworkData = EmbeddedArtworkExtractor.artworkData(from: items)
            }
            guard let data = artworkData, let img = UIImage(data: data) else { return }
            let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
            await MainActor.run {
                guard self.currentItem?() === item else { return } // 已切歌：丢弃
                self.embeddedArtwork = art
            }
        }
    }

    /// 内嵌兑底 + 异步覆盖（embeddedThenAsync 主路径 / sync 解码失败兑底共用）：
    /// 先同步写入内嵌封面（CarPlay 即时刷新，不依赖网络/缓存），
    /// 再异步拉远程/本地图，成功后覆盖（锁屏会刷新到更佳图）。
    private func applyEmbeddedFallback(cover: String, info: inout [String: Any]) {
        if let embedded = embeddedArtwork {
            nowPlayingArtwork = embedded
            info[MPMediaItemPropertyArtwork] = embedded
        }
        fetchArtworkAsync(cover: cover, fallbackInfo: info)
    }

    /// 异步拉取封面成功后覆盖 nowPlayingInfo（成功才覆盖；失败保留兑底图）
    private func fetchArtworkAsync(cover: String, fallbackInfo: [String: Any]) {
        loadArtwork(cover) { [weak self] artwork in
            guard let self else { return }
            if let artwork {
                self.nowPlayingArtwork = artwork
                var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? fallbackInfo
                updated[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
            }
        }
    }

    /// 同步解码 data:image/ 封面（base64）→ MPMediaItemArtwork；失败/非 data: 返回 nil。
    /// 供 applyMetadata 同步路径与 loadArtwork 复用。
    private func decodeArtwork(_ cover: String) -> MPMediaItemArtwork? {
        guard cover.hasPrefix("data:image/") else { return nil }
        let base64 = cover.split(separator: ",").dropFirst().joined(separator: ",")
        if let data = Data(base64Encoded: String(base64)), let img = UIImage(data: data) {
            return MPMediaItemArtwork(boundsSize: img.size) { _ in img }
        }
        return nil
    }
}
