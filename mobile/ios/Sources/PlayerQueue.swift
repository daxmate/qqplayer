import Foundation

/// 播放顺序快照纯模型（Pass 3 架构层；仅依赖 Foundation，不碰 AVFoundation/MediaPlayer，可测）：
/// 前端 setQueue 同步的歌曲快照 + 当前游标，锁屏/线控后台切歌（playQueueRelative）的
/// 索引环绕移动、越界夹取与 stream 歌跳过规则都收在这里——RemoteCommandManager 只负责
/// 桥接与执行器回调，队列逻辑不再散落在组件里。
struct PlayerQueue {
    /// 歌曲快照（前端同步顺序；元素为歌曲 dict：url/title/artist/album）
    private(set) var songs: [[String: Any]] = []
    /// 当前游标（songs 下标；快照为空时为 0）
    private(set) var index = 0

    /// 快照是否为空（空 → next/prev 走 Web 兑底，原生不切歌）
    var isEmpty: Bool { songs.isEmpty }

    /// 快照长度（游标环绕/夹取用）
    var count: Int { songs.count }

    /// 当前歌曲元数据（快照为空 → nil）
    var currentSong: [String: Any]? {
        songs.isEmpty ? nil : songs[index]
    }

    /// 当前歌曲可播放 URL：url 字段为空（stream 歌）→ nil。
    /// MVP 限制（历史语义，测试已固化）：stream 歌 url 为空时跳过播放，但游标已前进——
    /// 下次切歌从新位置开始（流媒体直链有时效，后台无法离线取）。
    var currentSongURL: URL? {
        guard let urlString = currentSong?["url"] as? String, !urlString.isEmpty,
              let url = URL(string: urlString) else { return nil }
        return url
    }

    /// 快照替换（setQueue）：songs 非空 → 替换 + index 越界夹取到 [0, count-1]；
    /// 空数组/非数组 → 清空快照、游标归 0（next/prev 走 Web 兑底）。
    mutating func replace(songs: [[String: Any]], index: Int) {
        if songs.isEmpty {
            self.songs = []
            self.index = 0
        } else {
            self.songs = songs
            self.index = min(max(0, index), songs.count - 1)
        }
    }

    /// 相对移动 delta 步（复用 QueueCursor 环绕语义）：空快照不动返回 false；
    /// 否则游标环绕移动返回 true，新位置歌曲可用 currentSong/currentSongURL 读取。
    /// 注意：stream 歌跳过规则在调用方（currentSongURL 为 nil → 跳过播放但游标已前进）。
    @discardableResult
    mutating func advance(_ delta: Int) -> Bool {
        guard !songs.isEmpty else { return false }
        var cursor = QueueCursor(index: index)
        guard cursor.advance(delta, count: songs.count) else { return false }
        index = cursor.index
        return true
    }
}
