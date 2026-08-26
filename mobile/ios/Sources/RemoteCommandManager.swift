import MediaPlayer

/// 锁屏/线控远端命令 + 原生队列切歌执行器（AVPlayerBridge 拆分组件，纯搬移，行为零变化）。
/// - MPRemoteCommandCenter 注册/回调（play/pause/toggle/next/prev/changePlaybackPosition）
/// - 播放顺序快照（setQueue，前端同步）+ 后台切歌（playQueueRelative + QueueCursor 环绕游标）
/// AVPlayer/播放状态在 AVPlayerBridge 手里，组件不持有播放器——所有播放动作通过闭包回调
/// 交给 Bridge 执行（onLoad/onPlay/onPause/isPlaying/onApplyMetadata/onPushEvent/
/// onUpdatePlaybackState/onSeek），无队列兑底命令（next/prev）走 onFallbackCommand 转发 Web。
final class RemoteCommandManager {
    /// 播放顺序快照（前端 setQueue 同步；锁屏/线控后台切歌用，Web 挂起时不依赖 JS）
    private(set) var queue: [[String: Any]] = []
    private(set) var queueIndex = 0

    // MARK: - Bridge 执行器（闭包回调；AVPlayer 在 Bridge 手里，组件只发指令）

    /// 加载并替换当前 item（Bridge.load：makeItem/内嵌封面预读/loadedmetadata 推送）
    var onLoad: ((URL) -> Void)?
    /// 原始 play（不改锁屏态；调用方按需同步）
    var onPlay: (() -> Void)?
    /// 原始 pause（不改锁屏态；调用方按需同步）
    var onPause: (() -> Void)?
    /// 当前是否在播放（toggle 判定用；player.rate > 0）
    var isPlaying: (() -> Bool)?
    /// 锁屏元数据应用（Bridge → MetadataManager.applyMetadata）
    var onApplyMetadata: (([String: Any]) -> Void)?
    /// 原生 → Web 事件推送（songChanged）
    var onPushEvent: ((String, [String: Any]) -> Void)?
    /// 锁屏播放态同步（updateNowPlayingPlaybackState）
    var onUpdatePlaybackState: ((Bool?) -> Void)?
    /// 锁屏 seek（Bridge.seek：pendingSeek 串行化）
    var onSeek: ((TimeInterval) -> Void)?
    /// 兑底：未同步队列（旧客户端/未选歌）→ 转发 Web 执行（前端仍是队列真源）
    var onFallbackCommand: ((String) -> Void)?

    // MARK: - 队列快照（Web 命令入口 setQueue）

    /// 播放顺序快照：前端 selectSong 后同步（songs 数组 + 当前 index）→
    /// 锁屏/线控后台切歌由原生直接执行（Web 挂起时不依赖 JS）
    func handleSetQueue(_ payload: [String: Any]) {
        if let songs = payload["songs"] as? [[String: Any]], !songs.isEmpty {
            queue = songs
            let raw = (payload["index"] as? Int) ?? 0
            queueIndex = min(max(0, raw), queue.count - 1) // 越界夹取
        } else {
            // 容错：songs 非数组/空数组 → 清空快照（next/prev 走 Web 兑底）
            queue = []
            queueIndex = 0
        }
    }

    // MARK: - 原生队列切歌执行器

    /// 锁屏/线控后台切歌：按 queue 快照相对移动（Web 挂起时原生独立执行）。
    /// 复用 Bridge.load（embeddedArtwork 预读/loadedmetadata 推送）+ applyMetadata（payload dict 直接可用）。
    /// stream 歌 url 为空 → 跳过（MVP 限制：后台切歌只覆盖本地歌，流媒体直链有时效无法离线取）。
    func playQueueRelative(_ delta: Int) {
        guard !queue.isEmpty else { return }
        var cursor = QueueCursor(index: queueIndex)
        guard cursor.advance(delta, count: queue.count) else { return }
        queueIndex = cursor.index
        let meta = queue[queueIndex]
        guard let urlString = meta["url"] as? String, !urlString.isEmpty,
              let url = URL(string: urlString) else { return } // stream 歌 url 为空：跳过（MVP 限制）
        onLoad?(url)
        onPlay?() // 锁屏切歌即播放（前端 songChanged 对齐为播放态）
        onApplyMetadata?(meta)
        onPushEvent?("songChanged", ["index": queueIndex])
        onUpdatePlaybackState?(true)
    }

    // MARK: - MPRemoteCommandCenter 注册

    /// 注册锁屏/耳机线控命令（MPRemoteCommandCenter.shared()，app 生命周期内常驻）。
    /// 命令处理器是独立方法（handlePlay/handlePause/…），这里只注册薄包装——测试可直接调处理器。
    func install() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.isEnabled = true
        center.pauseCommand.isEnabled = true
        center.togglePlayPauseCommand.isEnabled = true
        center.nextTrackCommand.isEnabled = true
        center.previousTrackCommand.isEnabled = true
        center.changePlaybackPositionCommand.isEnabled = true

        center.playCommand.addTarget { [weak self] _ in
            self?.handlePlay()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.handlePause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.handleToggle()
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.handleNext()
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.handlePrevious()
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            self?.handleChangePlaybackPosition(event)
            return .success
        }
    }

    // MARK: - 命令处理器（install 注册；测试直接调用）

    func handlePlay() {
        onPlay?()
        onUpdatePlaybackState?(nil)
    }

    func handlePause() {
        onPause?()
        onUpdatePlaybackState?(nil)
    }

    func handleToggle() {
        if isPlaying?() ?? false {
            onPause?()
        } else {
            onPlay?()
        }
        onUpdatePlaybackState?(nil)
    }

    func handleNext() {
        if queue.isEmpty {
            // 兑底：未同步队列（旧客户端/未选歌）→ 转发 Web 执行（前端仍是队列真源）
            onFallbackCommand?("next")
        } else {
            playQueueRelative(1)
        }
    }

    func handlePrevious() {
        if queue.isEmpty {
            onFallbackCommand?("prev")
        } else {
            playQueueRelative(-1)
        }
    }

    func handleChangePlaybackPosition(_ event: MPRemoteCommandEvent) {
        let t = (event as? MPChangePlaybackPositionCommandEvent)?.positionTime ?? 0
        handleSeek(to: t)
    }

    /// 锁屏进度拖动 → Bridge.seek（pendingSeek 串行化：seek 完成前到达的 play 延迟执行）
    func handleSeek(to t: TimeInterval) {
        onSeek?(t)
    }
}
