/// 音频中断恢复策略（纯状态机，可测试；不依赖 AVPlayer/AVAudioSession）。
/// 音乐播放器惯例：中断前在播 → 结束后恢复（系统 Music 同行为）；手动暂停后被打断 → 不恢复。
/// AVPlayerBridge.configureAudioSession 驱动：began 时记录中断前状态，ended 时决定是否恢复。
struct InterruptionPolicy {
    private var wasPlaying = false

    /// 中断开始：记录中断前是否正在播放（调用方算好 wasPlaying = rate > 0 且非缓冲等待）
    mutating func began(wasPlaying: Bool) {
        self.wasPlaying = wasPlaying
    }

    /// 中断结束：返回是否需要恢复播放；无论是否恢复都重置状态（一次性，避免重复恢复）
    mutating func ended() -> Bool {
        defer { wasPlaying = false }
        return wasPlaying
    }
}

/// 播放队列游标（纯逻辑，可测试）：锁屏/线控后台切歌（playQueueRelative）的
/// 索引环绕移动。count<=0 返回 false（不动）；否则 index 环绕移动返回 true。
struct QueueCursor {
    private(set) var index: Int

    /// 相对移动 delta 步；count 为队列长度。count<=0 时队列无效，index 不变返回 false。
    mutating func advance(_ delta: Int, count: Int) -> Bool {
        guard count > 0 else { return false }
        index = (index + delta + count) % count
        return true
    }
}

/// 封面获取策略决策（纯逻辑，可测试）：applyMetadata 里「data: URL 同步解码 /
/// 内嵌封面兑底 + 异步覆盖 / 纯异步」三分支的选择。
enum CoverDecision {
    /// data:image/ URL：同步解码即时有封面（不走异步，无「先空后补」窗口）
    case syncDataURL
    /// 非 data: URL 且已有内嵌封面：先同步用内嵌兑底（CarPlay 即时刷新），再异步拉图覆盖
    case embeddedThenAsync
    /// 无内嵌封面：纯异步拉取，成功后覆盖
    case asyncOnly

    static func decide(coverUrl: String, hasEmbedded: Bool) -> CoverDecision {
        if coverUrl.hasPrefix("data:image/") {
            return .syncDataURL
        }
        return hasEmbedded ? .embeddedThenAsync : .asyncOnly
    }
}
