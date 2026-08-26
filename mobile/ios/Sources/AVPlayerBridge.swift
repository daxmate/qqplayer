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
/// - 播放核心状态机（Pass 3 架构层）：pendingSeek/playAfterSeek/中断策略/播放状态收拢到
///     PlayerStateMachine（纯模型，可测）——本类只按状态机返回值执行 AVPlayer 副作用/推事件。
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

    /// 音频中断（来电/其他 app 抢占/系统语音）恢复 + seek 串行化 + 播放状态：
    /// Pass 3 抽成纯模型 PlayerStateMachine（可测）——pendingSeek/playAfterSeek/中断策略
    /// 都收在状态机里，本类只按返回值执行 AVPlayer 副作用/推事件。
    private var machine = PlayerStateMachine()
    private var interruptionObserver: NSObjectProtocol?

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
            guard let self, let event = self.machine.itemEnded() else { return }
            self.push(event, [:])
        }
        // 播放/暂停状态（含 remote/线控/插拔耳机中断恢复）统一回传 Web；
        // 缓冲等待（waitingToPlayAtSpecifiedRate）不算暂停，避免网络抖一下 UI 闪暂停。
        // seek 期间（状态机 isSeeking）不推 paused：精确 seek 会短暂 rate=0，
        // 误推 paused 会乱序覆盖 Web 侧播放状态（跟唱高亮卡死/跳句后状态错乱，2026-08-23）。
        rateObservation = player.observe(\.rate, options: [.new]) { [weak self] p, _ in
            guard let self else { return }
            let isWaiting = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
            if let event = self.machine.rateChanged(rate: Double(p.rate), isWaiting: isWaiting) {
                self.push(event, ["t": self.playerTime()])
            }
        }
    }

    // MARK: - Web 命令入口（从 WKScriptMessage 解析）

    /// Web 命令处理器类型：bridge 实例 + payload（静态表存闭包，不捕获 self）
    typealias CommandHandler = (AVPlayerBridge, [String: Any]) -> Void

    /// 命令分发映射表（Pass 3 架构层：switch → 显式映射表，行为零变化）。
    /// cmd 字符串 → handler；不在表里的未知命令由 handleCommand 静默忽略
    /// （桌面壳消息如 pickLibrary/lyric 等也走这里）。
    static let commandHandlers: [String: CommandHandler] = [
        "load": { bridge, payload in
            if let urlString = payload["url"] as? String, let url = URL(string: urlString) {
                bridge.load(url: url)
            }
        },
        "play": { bridge, _ in
            // seek 进行中（状态机 isSeeking）：标记待播，seek 完成回调里再 play（跳句/断点恢复场景）
            let wasSeeking = bridge.machine.isSeeking
            bridge.machine.requestPlay()
            guard !wasSeeking else { return }
            bridge.player.play()
            bridge.metadataManager.updateNowPlayingPlaybackState()
        },
        "pause": { bridge, _ in
            bridge.machine.requestPause()
            bridge.player.pause()
            bridge.metadataManager.updateNowPlayingPlaybackState()
        },
        "seek": { bridge, payload in
            if let t = payload["t"] as? Double {
                bridge.seek(to: CMTime(seconds: max(0, t), preferredTimescale: 600))
            } else if let t = payload["t"] as? Int {
                bridge.seek(to: CMTime(seconds: max(0, Double(t)), preferredTimescale: 600))
            }
        },
        "setVolume": { bridge, payload in
            if let v = payload["v"] as? Double {
                bridge.player.volume = Float(min(1, max(0, v)))
            }
        },
        "setRate": { bridge, payload in
            if let r = payload["r"] as? Double {
                bridge.player.defaultRate = Float(r)
                if bridge.player.rate > 0 { bridge.player.rate = Float(r) }
                bridge.metadataManager.updateNowPlayingPlaybackState()
            }
        },
        "setMetadata": { bridge, payload in
            bridge.metadataManager.applyMetadata(payload)
        },
        "setPlaying": { bridge, payload in
            if let p = payload["playing"] as? Bool {
                bridge.metadataManager.updateNowPlayingPlaybackState(playing: p)
            }
        },
        "setQueue": { bridge, payload in
            // 播放顺序快照：前端 selectSong 后同步 → RemoteCommandManager 持有，
            // 锁屏/线控后台切歌由原生直接执行（Web 挂起时不依赖 JS）
            bridge.remoteCommands.handleSetQueue(payload)
        },
    ]

    func handleCommand(_ cmd: String, payload: [String: Any]) {
        // 未知命令静默忽略（桌面壳消息如 pickLibrary/lyric 等也走这里）
        guard let handler = Self.commandHandlers[cmd] else { return }
        handler(self, payload)
    }

    // MARK: - 播放原语

    /// seek + 完成回调：完成前到达的 play 请求延迟到 seek 完成后执行（状态机 playAfterSeek）。
    /// 重复 seek 会覆盖进行中的 seek（AVPlayer 自动取消前一个 seek；状态机 seeking 标记幂等）。
    private func seek(to time: CMTime) {
        machine.seekStarted()
        player.seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                let shouldPlay = self.machine.playAfterSeek
                let isPausedNow = self.player.rate == 0
                    && self.player.timeControlStatus != .waitingToPlayAtSpecifiedRate
                let event = self.machine.seekFinished(shouldPlay: shouldPlay, isPausedNow: isPausedNow)
                if shouldPlay {
                    self.player.play()
                    self.metadataManager.updateNowPlayingPlaybackState()
                } else if let event {
                    // seek 完成后仍是暂停（跳转暂停场景）：seek 期间 rate=0 的 paused 被抑制，
                    // 这里补推一次，Web 侧暂停状态不错失
                    self.push(event, ["t": self.playerTime()])
                }
            }
        }
    }

    private func load(url: URL) {
        machine.itemLoaded() // 状态机回 loading（item 替换；loadedmetadata 由 status 观察推）
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

    // MARK: - 时间观察（≈250ms 一次，驱动 Web timeupdate）
    // 锁屏进度不在此更新：Apple 官方（WWDC 2022 Meet NowPlayingUI）明确系统会按
    // 上次 elapsedTime + playbackRate 自动推算进度，周期性整体重建 nowPlayingInfo
    // 是反模式——每秒 4 次 flood 会淹没 CarPlay/手表的 artwork 更新（2026-08-26 封面停首图根因）

    private func setupTimeObserver() {
        let interval = CMTime(seconds: 0.25, preferredTimescale: 600)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] _ in
            guard let self else { return }
            let t = self.playerTime()
            let d = self.playerDuration()
            self.push("timeupdate", ["t": t, "duration": d])
            // 锁屏/手表进度由系统自动推算；播放/暂停/seek/切歌/中断恢复由事件驱动更新（见各调用点）
        }
    }

    // MARK: - 事件推送

    private func push(_ name: String, _ payload: [String: Any]) {
        onEvent?(name, payload)
    }

    /// 状态机事件 → 原生 → Web 推送（事件名由 PushEvent 决定）
    private func push(_ event: PushEvent, _ payload: [String: Any]) {
        push(event.name, payload)
    }

    // MARK: - 音频会话（后台播放）

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true)
        // 音频中断（来电/其他 app 抢占/系统语音）→ 结束后自动恢复播放。
        // 音乐播放器惯例：只要中断前在播就恢复（系统 Music 同行为）；手动暂停后被打断不恢复。
        // 中断策略在 PlayerStateMachine（InterruptionPolicy 语义）：began 记录，ended 决定。
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
                let rate = self.player.rate
                let isWaiting = self.player.timeControlStatus == .waitingToPlayAtSpecifiedRate
                // 中断前正在播放（排除缓冲等待）→ 结束后恢复；系统已暂停 AVPlayer，
                // 暂停态同步 Web（避免 UI 停留播放态）
                if let event = self.machine.interruptionBegan(
                    wasPlaying: rate > 0 && !isWaiting, isWaiting: isWaiting) {
                    self.push(event, ["t": self.playerTime()])
                }
            case .ended:
                if self.machine.interruptionEnded() != nil {
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
