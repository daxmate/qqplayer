/// 播放核心状态机（Pass 3 架构层；纯模型，不依赖 AVPlayer/AVAudioSession，可测）。
/// 状态：idle / loading / playing / paused / ended；seeking 是过渡标记（不单独成态）。
///
/// 职责（把散落在 AVPlayerBridge 的隐式播放状态收拢）：
/// - pendingSeek / playAfterSeek 语义归入（seek 期间抑制 paused 推送、seek 完成补推/续播，
///   2026-08-23 跟唱跳句竞态修复的串行化逻辑）
/// - 音频中断恢复（复用 InterruptionPolicy 语义：中断前在播 → 结束后恢复；手动暂停后被打断不恢复）
/// - 每个迁移方法返回「要推的事件」（playing/paused/ended）或 nil；新状态读 state。
///
/// AVPlayer 副作用留在 AVPlayerBridge（壳层只管执行，状态机不碰播放器）：
/// rate 观察 / seek / load / 中断回调由 Bridge 驱动本机，按返回值推事件。
/// 事件推送与原实现逐一对齐（行为零变化）：
/// - playing：rate > 0 观察 / 中断结束后恢复
/// - paused：rate == 0 且非 seek 且非缓冲等待的观察 / seek 完成补推（跳转暂停场景）/ 中断开始
/// - ended：播完（didPlayToEnd）
struct PlayerStateMachine {
    enum State: Equatable {
        case idle // 无 item / 未开始
        case loading // item 加载中（load 后、首次播放前）
        case playing
        case paused
        case ended
    }

    /// 状态机当前状态（迁移方法更新；测试/外部只读）
    private(set) var state: State = .idle

    /// seek 串行化过渡标记（等价原 pendingSeek != nil）：seek 期间抑制 rate=0 的 paused 误推
    private(set) var isSeeking = false

    /// seek 期间收到 play 请求 → seek 完成后续播（等价原 playAfterSeek）
    private(set) var playAfterSeek = false

    /// 音频中断恢复（原 InterruptionPolicy 语义，内嵌复用：began 记录中断前状态，ended 决定恢复）
    private var interruptionPolicy = InterruptionPolicy()

    /// item 替换（load）→ loading（不推事件；loadedmetadata 由 Bridge 的 item status 观察推）
    mutating func itemLoaded() {
        state = .loading
    }

    /// 播放意图（play 命令 / 远端 play / toggle 播）：
    /// seek 中 → 只置 playAfterSeek（seek 完成回调里再 play，跳句/断点恢复场景）；
    /// 否则 state → playing。均不推事件——播放动作后 rate 观察自然推 playing（与原实现一致）。
    @discardableResult
    mutating func requestPlay() -> PushEvent? {
        if isSeeking {
            playAfterSeek = true
            return nil
        }
        state = .playing
        return nil
    }

    /// 暂停意图（pause 命令 / 远端 pause / toggle 停）：state → paused，不推事件（rate 观察推）。
    @discardableResult
    mutating func requestPause() -> PushEvent? {
        state = .paused
        return nil
    }

    /// seek 开始：置 seeking 过渡标记（抑制 seek 期间 rate=0 的 paused 误推）
    @discardableResult
    mutating func seekStarted() -> PushEvent? {
        isSeeking = true
        return nil
    }

    /// seek 完成：清 seeking。shouldPlay（seek 中收到过 play）→ 续播（state → playing，
    /// 不推事件，播放动作后 rate 观察推 playing）；否则若 isPausedNow（seek 后仍在暂停且非
    /// 缓冲等待）→ 补推 paused（seek 期间被抑制的那次，Web 侧暂停状态不错失）；
    /// 播放中 seek 完成 → 不推（rate 观察自然推 playing）。
    @discardableResult
    mutating func seekFinished(shouldPlay: Bool, isPausedNow: Bool) -> PushEvent? {
        isSeeking = false
        if shouldPlay {
            playAfterSeek = false
            state = .playing
            return nil
        }
        guard isPausedNow else { return nil }
        state = .paused
        return .paused
    }

    /// 播放速率观察（Bridge 的 rate KVO 驱动）：rate > 0 → playing；
    /// rate == 0 且非 seek 且非缓冲等待 → paused（缓冲等待 waitingToPlayAtSpecifiedRate
    /// 不算暂停，避免网络抖一下 UI 闪暂停）；seek 中 → 抑制（精确 seek 会短暂 rate=0）。
    mutating func rateChanged(rate: Double, isWaiting: Bool) -> PushEvent? {
        if rate > 0 {
            state = .playing
            return .playing
        }
        if isSeeking || isWaiting { return nil }
        state = .paused
        return .paused
    }

    /// 播完 → ended（推 ended；Web 侧走自动切歌/单曲循环逻辑）
    @discardableResult
    mutating func itemEnded() -> PushEvent? {
        state = .ended
        return .ended
    }

    /// 中断开始：记录中断前是否在播（wasPlaying = rate > 0 且非缓冲等待，调用方算好）；
    /// 系统已暂停 AVPlayer——暂停态（非缓冲）同步推 paused（避免 UI 停留播放态）；
    /// 中断前在播/缓冲等待 → 不推。
    mutating func interruptionBegan(wasPlaying: Bool, isWaiting: Bool) -> PushEvent? {
        interruptionPolicy.began(wasPlaying: wasPlaying)
        if wasPlaying || isWaiting { return nil }
        state = .paused
        return .paused
    }

    /// 中断结束：中断前在播 → 恢复（返回 .playing，Bridge 执行 play 并推 playing）；
    /// 手动暂停后被打断 → 不恢复（nil）。一次性：无论是否恢复都重置（避免重复恢复）。
    mutating func interruptionEnded() -> PushEvent? {
        guard interruptionPolicy.ended() else { return nil }
        state = .playing
        return .playing
    }
}

/// 状态机输出的待推事件：name 即原生 → Web 事件名（t 等 payload 由调用方 Bridge 附加）
enum PushEvent: Equatable {
    case playing
    case paused
    case ended

    var name: String {
        switch self {
        case .playing: return "playing"
        case .paused: return "paused"
        case .ended: return "ended"
        }
    }
}
