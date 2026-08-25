import AVFoundation
import MediaPlayer
import UIKit

/// AVPlayer 播放桥（阶段2 核心）：Web → Native 的播放原语。
/// - load/play/pause/seek/setVolume/setRate 由 Web 桥消息驱动
/// - 事件回传（Web 侧 playerCore 适配层消费）：
///     loadedmetadata {duration} / playing {t} / paused {t} / ended / timeupdate {t, duration}
/// - 锁屏 Now Playing：元数据（标题/歌手/专辑/封面）+ 进度；MPRemoteCommandCenter
///   （play/pause/toggle/next/prev/changePlaybackPosition + 耳机线控）→ 统一回传 Web 执行
///   （Web 是队列/切歌逻辑的真源，原生只转发命令，避免双端状态分叉）。
final class AVPlayerBridge {
    private let player = AVPlayer()
    /// Bearer token（配对鉴权）：AVPlayer 拉流/短音频时附加 Authorization 头。
    /// 真机 401 根因（2026-08-23）：127.0.0.1 免鉴权模拟器正常，真机必须带 token。
    var authToken: String?
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var didEndObserver: NSObjectProtocol?
    private var rateObservation: NSKeyValueObservation?

    /// 原生 → Web 事件（name, JSON payload）；由 WebShellController 桥接到 evaluateJavaScript
    var onEvent: ((String, [String: Any]) -> Void)?
    /// 远端命令 → Web（cmd: play|pause|toggle|next|prev|seekto）
    var onRemoteCommand: ((String, Double?) -> Void)?

    private var nowPlayingArtwork: MPMediaItemArtwork?
    /// 当前 item 的内嵌封面（APIC 预读缓存）：无线 CarPlay 脱离 Mac 网络且封面无缓存时
    /// 唯一不依赖网络的封面来源；切歌时清空、新歌预读完成后填充（旧歌结果丢弃防乱序）。
    private var embeddedArtwork: MPMediaItemArtwork?

    /// 音频中断（来电/其他 app 抢占/系统语音）恢复状态：began 时记录中断前是否在播放，
    /// ended 后据此自动恢复（手动暂停后被打断不恢复）。
    private var resumeAfterInterruption = false
    private var interruptionObserver: NSObjectProtocol?

    /// 当前加载的 URL（setMetadata 时确认封面归属）
    private(set) var currentURL: URL?

    /// seek 串行化状态（2026-08-23 跟唱跳句竞态修复）：
    /// Web 侧 currentTime setter 与 play() 是两个独立桥消息，AVPlayer.seek 异步完成前
    /// 若收到 play → 从旧位置开始播（"下一句没用"/乱跳）。
    /// 这里：seek 到达记 pendingSeek，完成回调里若期间收到过 play 请求则接着播放。
    private var pendingSeek: CMTime?
    private var playAfterSeek = false

    init() {
        configureAudioSession()
        setupTimeObserver()
        setupRemoteCommands()
        // 播完 → ended 事件（Web 侧走自动切歌/单曲循环逻辑）
        didEndObserver = NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            self?.push("ended", [:])
        }
        // 播放/暂停状态（含 remote/线控/插拔耳机中断恢复）统一回传 Web；
        // 缓冲等待（waitingToPlayAtSpecifiedRate）不算暂停，避免网络抖一下 UI 闪暂停。
        // seek 期间（pendingSeek 非 nil）不推 paused：精确 seek 会短暂 rate=0，
        // 误推 paused 会乱序覆盖 Web 侧播放状态（跟唱高亮卡死/跳句后状态错乱，2026-08-23）。
        rateObservation = player.observe(\.rate, options: [.new]) { [weak self] p, _ in
            guard let self else { return }
            if p.rate > 0 {
                self.push("playing", ["t": self.playerTime()])
            } else if self.pendingSeek == nil && p.timeControlStatus != .waitingToPlayAtSpecifiedRate {
                self.push("paused", ["t": self.playerTime()])
            }
        }
    }

    // MARK: - Web 命令入口（从 WKScriptMessage 解析）

    func handleCommand(_ cmd: String, payload: [String: Any]) {
        switch cmd {
        case "load":
            if let urlString = payload["url"] as? String, let url = URL(string: urlString) {
                load(url: url)
            }
        case "play":
            if pendingSeek != nil {
                // seek 进行中：标记待播，seek 完成回调里再 play（跳句/断点恢复场景）
                playAfterSeek = true
            } else {
                player.play()
                updateNowPlayingPlaybackState()
            }
        case "pause":
            player.pause()
            updateNowPlayingPlaybackState()
        case "seek":
            if let t = payload["t"] as? Double {
                seek(to: CMTime(seconds: max(0, t), preferredTimescale: 600))
            } else if let t = payload["t"] as? Int {
                seek(to: CMTime(seconds: max(0, Double(t)), preferredTimescale: 600))
            }
        case "setVolume":
            if let v = payload["v"] as? Double {
                player.volume = Float(min(1, max(0, v)))
            }
        case "setRate":
            if let r = payload["r"] as? Double {
                player.defaultRate = Float(r)
                if player.rate > 0 { player.rate = Float(r) }
                updateNowPlayingPlaybackState()
            }
        case "setMetadata":
            applyMetadata(payload)
        case "setPlaying":
            if let p = payload["playing"] as? Bool {
                updateNowPlayingPlaybackState(playing: p)
            }
        default:
            break // 未知命令静默忽略（桌面壳消息如 pickLibrary/lyric 等也走这里）
        }
    }

    // MARK: - 播放原语

    /// seek + 完成回调：完成前到达的 play 请求延迟到 seek 完成后执行。
    /// 重复 seek 会覆盖 pendingSeek（AVPlayer 自动取消前一个 seek）。
    private func seek(to time: CMTime) {
        pendingSeek = time
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.pendingSeek = nil
                if self.playAfterSeek {
                    self.playAfterSeek = false
                    self.player.play()
                    self.updateNowPlayingPlaybackState()
                } else if self.player.rate == 0
                    && self.player.timeControlStatus != .waitingToPlayAtSpecifiedRate {
                    // seek 完成后仍是暂停（跳转暂停场景）：seek 期间 rate=0 的 paused 被抑制，
                    // 这里补推一次，Web 侧暂停状态不错失
                    self.push("paused", ["t": self.playerTime()])
                }
            }
        }
    }

    private func load(url: URL) {
        currentURL = url
        let item = makeItem(url: url)
        statusObservation?.invalidate()
        embeddedArtwork = nil // 上一首的内嵌封面作废，等新歌预读
        player.replaceCurrentItem(with: item)
        loadEmbeddedArtwork(for: item) // 异步预读内嵌封面（applyMetadata 兑底用）
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            guard item.status == .readyToPlay else {
                if item.status == .failed {
                    self?.push("error", ["message": item.error?.localizedDescription ?? "load failed"])
                }
                return
            }
            let duration = item.duration.seconds
            if duration.isFinite && duration > 0 {
                self?.push("loadedmetadata", ["duration": duration])
                self?.updateNowPlaying(duration: duration)
            }
        }
    }

    /// 构造 AVPlayerItem：有 token 时用 AVURLAsset 附加 Authorization 头（真机鉴权）
    private func makeItem(url: URL) -> AVPlayerItem {
        guard let token = authToken, !token.isEmpty else {
            return AVPlayerItem(url: url)
        }
        let asset = AVURLAsset(url: url, options: [
            // 字面量 key（常量 AVURLAssetHTTPHeaderFieldsKey 在精简 SDK 下不可见，实为同一字符串）
            "AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer \(token)"],
        ])
        return AVPlayerItem(asset: asset)
    }

    /// 词典发音等短音频（独立 AVPlayer 实例，不干扰主播放器状态/事件；无 UI 直接出声）。
    /// iOS 26 WKWebView 里 HTMLAudioElement.play() 会弹系统媒体播放器界面，词典查词
    /// 发音改走原生播放（2026-08-23 阶段4）。
    private var audioFxPlayer: AVPlayer?
    func playAudioFile(_ url: URL) {
        audioFxPlayer?.pause()
        let item = makeItem(url: url)
        audioFxPlayer = AVPlayer(playerItem: item)
        audioFxPlayer?.play()
    }

    func playerTime() -> Double {
        let t = player.currentTime().seconds
        return t.isFinite ? t : 0
    }

    private func playerDuration() -> Double {
        let d = player.currentItem?.duration.seconds ?? 0
        return (d.isFinite && d > 0) ? d : 0
    }

    // MARK: - 时间观察（≈250ms 一次，驱动 Web timeupdate + 锁屏进度）

    private func setupTimeObserver() {
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
            guard let self else { return }
            let t = self.playerTime()
            let d = self.playerDuration()
            self.push("timeupdate", ["t": t, "duration": d])
            self.updateNowPlayingProgress(t: t, duration: d, rate: Double(self.player.rate))
        }
    }

    // MARK: - 事件推送

    private func push(_ name: String, _ payload: [String: Any]) {
        onEvent?(name, payload)
    }

    // MARK: - 音频会话（后台播放）

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
        // 音频中断（来电/其他 app 抢占/系统语音）→ 结束后自动恢复播放。
        // 音乐播放器惯例：只要中断前在播就恢复（系统 Music 同行为）；手动暂停后被打断不恢复。
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] note in
            guard let self,
                  let typeRaw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: typeRaw) else { return }
            switch type {
            case .began:
                // 中断前正在播放（排除缓冲等待）→ 结束后恢复
                self.resumeAfterInterruption = (self.player.rate > 0
                    && self.player.timeControlStatus != .waitingToPlayAtSpecifiedRate)
                // 系统已暂停 AVPlayer；同步 Web 暂停态（避免 UI 停留播放态）
                if self.player.rate == 0
                    && self.player.timeControlStatus != .waitingToPlayAtSpecifiedRate {
                    self.push("paused", ["t": self.playerTime()])
                }
            case .ended:
                if self.resumeAfterInterruption {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    self.player.play()
                    self.updateNowPlayingPlaybackState()
                    // 恢复事件回传 Web（中断期间前端已收到 paused，需恢复播放态）
                    self.push("playing", ["t": self.playerTime()])
                }
                self.resumeAfterInterruption = false
            @unknown default:
                break
            }
        }
    }

    // MARK: - 锁屏 Now Playing

    private func applyMetadata(_ payload: [String: Any]) {
        let title = payload["title"] as? String ?? ""
        let artist = payload["artist"] as? String ?? ""
        let album = payload["album"] as? String ?? ""
        let cover = payload["coverUrl"] as? String ?? ""
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title.isEmpty ? "QQPlayer" : title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyAlbumTitle: album,
            MPNowPlayingInfoPropertyPlaybackRate: player.rate,
        ]
        // 先保留旧封面兑底：任何时刻 nowPlayingInfo 都带 artwork 键，
        // 避免「先同步发布无封面信息、后异步补图」顶掉旧封面——锁屏会刷新，
        // 但 CarPlay 车机大多不刷新异步补的图（2026-08-25 真机空白根因 A）。
        if let existing = MPNowPlayingInfoCenter.default().nowPlayingInfo?[MPMediaItemPropertyArtwork] {
            info[MPMediaItemPropertyArtwork] = existing
        } else if let art = nowPlayingArtwork {
            info[MPMediaItemPropertyArtwork] = art
        }
        let duration = playerDuration()
        if duration > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = playerTime()
        }
        if !cover.isEmpty {
            // data: URL 同步解码即时有封面（不走异步，无「先空后补」窗口）；
            // 解码失败/http 封面 → 先同步用内嵌封面兑底（CarPlay 即时刷新，不依赖网络/缓存），
            // 再异步 loadArtwork 拉远程/本地图，成功后覆盖（锁屏会刷新到更佳图）。
            let decoded = cover.hasPrefix("data:image/") ? decodeArtwork(cover) : nil
            if let art = decoded {
                nowPlayingArtwork = art
                info[MPMediaItemPropertyArtwork] = art
            } else if let embedded = embeddedArtwork {
                nowPlayingArtwork = embedded
                info[MPMediaItemPropertyArtwork] = embedded
                loadArtwork(cover) { [weak self] artwork in
                    guard let self else { return }
                    if let artwork {
                        self.nowPlayingArtwork = artwork
                        var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? info
                        updated[MPMediaItemPropertyArtwork] = artwork
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
                    }
                }
            } else {
                loadArtwork(cover) { [weak self] artwork in
                    guard let self else { return }
                    if let artwork {
                        self.nowPlayingArtwork = artwork
                        var updated = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? info
                        updated[MPMediaItemPropertyArtwork] = artwork
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = updated
                    }
                }
            }
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func updateNowPlaying(duration: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyPlaybackDuration] = duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = playerTime()
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func updateNowPlayingProgress(t: Double, duration: Double, rate: Double) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        if duration > 0 { info[MPMediaItemPropertyPlaybackDuration] = duration }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = t
        info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func updateNowPlayingPlaybackState(playing: Bool? = nil) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        let p = playing ?? (player.rate > 0)
        info[MPNowPlayingInfoPropertyPlaybackRate] = p ? player.rate : 0
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = playerTime()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

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
    private func loadEmbeddedArtwork(for item: AVPlayerItem) {
        let asset = item.asset
        Task {
            var artworkData: Data?
            // MP3 常见 id3 APIC；M4A 走 iTunes；其余容器 commonMetadata 兑底
            let formats: [AVMetadataFormat] = [.id3Metadata, .iTunesMetadata, .quickTimeMetadata]
            for format in formats {
                if let items = try? await asset.loadMetadata(for: format) {
                    for m in items where m.commonKey == .commonKeyArtwork
                        || m.identifier == AVMetadataIdentifier.id3MetadataAttachedPicture {
                        if let data = m.dataValue {
                            artworkData = data
                            break
                        }
                    }
                }
                if artworkData != nil { break }
            }
            if artworkData == nil, let items = try? await asset.load(.commonMetadata) {
                for m in items where m.commonKey == .commonKeyArtwork {
                    if let data = m.dataValue {
                        artworkData = data
                        break
                    }
                }
            }
            guard let data = artworkData, let img = UIImage(data: data) else { return }
            let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
            await MainActor.run {
                guard self.player.currentItem === item else { return } // 已切歌：丢弃
                self.embeddedArtwork = art
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

    // MARK: - 远端命令（锁屏/耳机线控）→ 转发 Web

    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true

        center.playCommand.addTarget { [weak self] _ in
            self?.onRemoteCommand?("play", nil)
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.onRemoteCommand?("pause", nil)
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.onRemoteCommand?("toggle", nil)
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.onRemoteCommand?("next", nil)
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.onRemoteCommand?("prev", nil)
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            let t = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime ?? 0
            self?.onRemoteCommand?("seekto", t)
            return .success
        }
    }
}
