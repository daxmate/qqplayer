import AVFoundation
import UIKit

/// AVPlayer 播放桥（阶段2 核心）：Web → Native 的播放原语。
/// - load/play/pause/seek/setVolume/setRate 由 Web 桥消息驱动
/// - 事件回传（Web 侧 playerCore 适配层消费）：
///     loadedmetadata {duration} / playing {t} / paused {t} / ended / timeupdate {t, duration}
///     songChanged {index}（原生后台切歌后推送，Web 对齐状态不重新 load）
/// - 锁屏 Now Playing / 远端命令（play/pause/toggle/next/prev/changePlaybackPosition + 耳机线控）
///   → **原生直接执行**：后台锁屏时 WKWebView 的 JS 被 iOS 挂起，转发 Web 的命令要等回前台
///   才执行（已实锤）——原生持有前端同步的播放顺序快照（setQueue），后台切歌/播放/暂停/seek
///   直接操作 AVPlayer。Web 仍是队列/切歌逻辑真源（app 内操作零变化），切歌后推 songChanged，
///   前端跟随对齐。
/// - 组件（Pass 2 结构拆分，纯搬移）：
///     RemoteCommandManager —— MPRemoteCommandCenter 注册/回调 + setQueue 快照 + playQueueRelative
///     MetadataManager —— 封面/锁屏元数据（applyMetadata/内嵌封面预读/异步拉取/进度同步）
///   AVPlayer 在本类手里，组件通过闭包回调驱动播放/只读状态（见 init 接线）。
final class AVPlayerBridge {
    private let player = AVPlayer()
    /// Bearer token（配对鉴权）：AVPlayer 拉流/短音频时附加 Authorization 头。
    /// 真机 401 根因（2026-08-23）：127.0.0.1 免鉴权模拟器正常，真机必须带 token。
    /// 同步转发给 MetadataManager（异步拉封面同样需要鉴权）。
    var authToken: String? {
        didSet { metadataManager.authToken = authToken }
    }
    private var timeObserver: Any?
    private var statusObservation: NSKeyValueObservation?
    private var didEndObserver: NSObjectProtocol?
    private var rateObservation: NSKeyValueObservation?

    /// 锁屏/线控远端命令 + 原生队列切歌执行器（Pass 2 拆分组件）
    private let remoteCommands = RemoteCommandManager()
    /// 封面/锁屏元数据管理（Pass 2 拆分组件）
    private let metadataManager = MetadataManager()

    /// 原生 → Web 事件（name, JSON payload）；由 WebShellController 桥接到 evaluateJavaScript
    var onEvent: ((String, [String: Any]) -> Void)?
    /// 远端命令 → Web（cmd: play|pause|toggle|next|prev|seekto）
    var onRemoteCommand: ((String, Double?) -> Void)?

    /// 音频中断（来电/其他 app 抢占/系统语音）恢复状态机：began 时记录中断前是否在播放，
    /// ended 后据此自动恢复（手动暂停后被打断不恢复）。纯逻辑在 InterruptionPolicy（可测）。
    private var interruptionPolicy = InterruptionPolicy()
    private var interruptionObserver: NSObjectProtocol?

    /// seek 串行化状态（2026-08-23 跟唱跳句竞态修复）：
    /// Web 侧 currentTime setter 与 play() 是两个独立桥消息，AVPlayer.seek 异步完成前
    /// 若收到 play → 从旧位置开始播（"下一句没用"/乱跳）。
    /// 这里：seek 到达记 pendingSeek，完成回调里若期间收到过 play 请求则接着播放。
    private var pendingSeek: CMTime?
    private var playAfterSeek = false

    init() {
        configureAudioSession()
        setupTimeObserver()
        // 组件接线：AVPlayer/播放状态在本类手里，组件通过闭包回调驱动/只读（纯搬移，行为零变化）
        metadataManager.currentRate = { [weak self] in Double(self?.player.rate ?? 0) }
        metadataManager.currentTime = { [weak self] in self?.playerTime() ?? 0 }
        metadataManager.currentDuration = { [weak self] in self?.playerDuration() ?? 0 }
        metadataManager.currentItem = { [weak self] in self?.player.currentItem }
        remoteCommands.onLoad = { [weak self] url in self?.load(url: url) }
        remoteCommands.onPlay = { [weak self] in self?.player.play() }
        remoteCommands.onPause = { [weak self] in self?.player.pause() }
        remoteCommands.isPlaying = { [weak self] in (self?.player.rate ?? 0) > 0 }
        remoteCommands.onApplyMetadata = { [weak self] meta in self?.metadataManager.applyMetadata(meta) }
        remoteCommands.onPushEvent = { [weak self] name, payload in self?.push(name, payload) }
        remoteCommands.onUpdatePlaybackState = { [weak self] playing in
            self?.metadataManager.updateNowPlayingPlaybackState(playing: playing)
        }
        remoteCommands.onSeek = { [weak self] t in
            self?.seek(to: CMTime(seconds: t, preferredTimescale: 600))
        }
        remoteCommands.onFallbackCommand = { [weak self] cmd in self?.onRemoteCommand?(cmd, nil) }
        remoteCommands.install()
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
                metadataManager.updateNowPlayingPlaybackState()
            }
        case "pause":
            player.pause()
            metadataManager.updateNowPlayingPlaybackState()
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
                metadataManager.updateNowPlayingPlaybackState()
            }
        case "setMetadata":
            metadataManager.applyMetadata(payload)
        case "setPlaying":
            if let p = payload["playing"] as? Bool {
                metadataManager.updateNowPlayingPlaybackState(playing: p)
            }
        case "setQueue":
            // 播放顺序快照：前端 selectSong 后同步 → RemoteCommandManager 持有，
            // 锁屏/线控后台切歌由原生直接执行（Web 挂起时不依赖 JS）
            remoteCommands.handleSetQueue(payload)
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
                    self.metadataManager.updateNowPlayingPlaybackState()
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
        let item = makeItem(url: url)
        statusObservation?.invalidate()
        metadataManager.embeddedArtwork = nil // 上一首的内嵌封面作废，等新歌预读
        player.replaceCurrentItem(with: item)
        metadataManager.loadEmbeddedArtwork(for: item) // 异步预读内嵌封面（applyMetadata 兑底用）
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
                self?.metadataManager.updateNowPlaying(duration: duration)
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
            self.metadataManager.updateNowPlayingProgress(t: t, duration: d, rate: Double(self.player.rate))
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
                self.interruptionPolicy.began(wasPlaying: self.player.rate > 0
                    && self.player.timeControlStatus != .waitingToPlayAtSpecifiedRate)
                // 系统已暂停 AVPlayer；同步 Web 暂停态（避免 UI 停留播放态）
                if self.player.rate == 0
                    && self.player.timeControlStatus != .waitingToPlayAtSpecifiedRate {
                    self.push("paused", ["t": self.playerTime()])
                }
            case .ended:
                if self.interruptionPolicy.ended() {
                    try? AVAudioSession.sharedInstance().setActive(true)
                    self.player.play()
                    self.metadataManager.updateNowPlayingPlaybackState()
                    // 恢复事件回传 Web（中断期间前端已收到 paused，需恢复播放态）
                    self.push("playing", ["t": self.playerTime()])
                }
            @unknown default:
                break
            }
        }
    }
}
