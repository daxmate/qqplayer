import CryptoKit
import Foundation

/// 资产下载管理器（阶段3）：Web 同步清单的本地缓存落地。
/// - 存储根：Documents/qqplayer-assets/<path>（path = audio/<sha256>.m4a 等相对路径）
/// - 断点续传：.part 临时文件 + Range 请求；服务端忽略 Range（回 200）或 416 时自动从头重下
/// - 校验：CryptoKit SHA256；已知 size 先比对；不匹配删 .part 重下（含首下共 3 次尝试）
/// - 并发 ≤ 3；cancelDownloads 清队列 + 取消进行中
/// - 事件闭包全部回主线程（WebShellView Coordinator 桥接 → pushToWeb）
final class DownloadManager: NSObject, URLSessionDataDelegate {
    /// 下载请求（来自 Web syncDownload 消息）
    struct Request {
        let url: URL          // 绝对 URL（http/https）
        let path: String      // 沙盒相对路径，如 audio/<sha256>.m4a
        let sha256: String    // 期望 hex
        let size: Int64?      // 可选：已知大小先比对
    }

    /// 单任务状态（class：队列 → 进行中 同一实例迁移，属性原地更新）
    private final class Item {
        let url: URL
        let path: String
        let sha256: String
        let size: Int64?
        let fileURL: URL      // 最终文件
        let partURL: URL      // 临时文件 .part（断点续传载体）
        var received: Int64 = 0          // 本次会话已接收（不含续传起点）
        var resumeOffset: Int64 = 0      // 续传起点（.part 已有字节数）
        var total: Int64 = 0             // 期望总长（未知为 0）
        var attempts = 1                 // 已尝试次数（含本次，校验失败重下）
        var lastProgressEmit: TimeInterval = 0

        init(url: URL, path: String, sha256: String, size: Int64?, fileURL: URL, partURL: URL) {
            self.url = url
            self.path = path
            self.sha256 = sha256
            self.size = size
            self.fileURL = fileURL
            self.partURL = partURL
        }
    }

    // MARK: - 事件闭包（均在主线程回调）

    /// 进度：path, received（累计字节）, total（0=未知）
    var onProgress: ((String, Int64, Int64) -> Void)?
    /// 完成/失败：path, ok, sha256, localURL, error
    var onDone: ((String, Bool, String, String?, String?) -> Void)?
    /// 资产查询结果：path, exists, localURL
    var onAssetStatus: ((String, Bool, String?) -> Void)?

    // MARK: - 状态

    private let maxConcurrent = 3
    private let maxAttempts = 3            // 含首下最多 3 次（校验失败重下 ≤2 次）
    private let stateLock = NSLock()
    private var queue: [Item] = []
    private var active: [URLSessionDataTask: Item] = [:]
    private var handles: [URLSessionDataTask: FileHandle] = [:]
    private let storageRoot: URL

    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 60
        return URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }()

    override init() {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        storageRoot = docs.appendingPathComponent("qqplayer-assets", isDirectory: true)
        super.init()
    }

    /// 释放资源（Coordinator deinit 调用；URLSession 强持有 delegate，必须显式 invalidate 断环）
    func shutdown() {
        session.invalidateAndCancel()
        for (_, handle) in handles {
            try? handle.close()
        }
        handles.removeAll()
        stateLock.lock()
        active.removeAll()
        queue.removeAll()
        stateLock.unlock()
    }

    /// 相对路径合法性（防路径穿越；Web 侧 path 应为 audio/… / dicts/… / books/…）
    static func isSafePath(_ path: String) -> Bool {
        !path.isEmpty && !path.hasPrefix("/") && !path.contains("..")
    }

    /// 存储根绝对路径（调试/展示用）
    var storageRootPath: String { storageRoot.path }

    // MARK: - 对外 API

    /// 批量入队。已存在且校验通过 → 立即回 done（不下载）。
    func enqueue(_ requests: [Request]) {
        for r in requests {
            guard Self.isSafePath(r.path) else { continue }
            let fileURL = storageRoot.appendingPathComponent(r.path)
            let item = Item(
                url: r.url, path: r.path, sha256: r.sha256.lowercased(), size: r.size,
                fileURL: fileURL,
                partURL: fileURL.appendingPathExtension("part")
            )
            // 去重：已在队列/进行中 → 跳过
            stateLock.lock()
            let dup = queue.contains { $0.path == r.path } || active.values.contains { $0.path == r.path }
            stateLock.unlock()
            if dup { continue }
            // 最终文件已存在：size/哈希校验通过 → 直接完成；不通过 → 删除重下
            if FileManager.default.fileExists(atPath: item.fileURL.path) {
                if let size = r.size, fileSize(item.fileURL) != size {
                    try? FileManager.default.removeItem(at: item.fileURL)
                } else if let hash = sha256(of: item.fileURL), hash == item.sha256 {
                    emitDone(item, ok: true, sha256: hash, localURL: item.fileURL.absoluteString, error: nil)
                    continue
                } else {
                    try? FileManager.default.removeItem(at: item.fileURL)
                }
            }
            // .part 已完整（上次下载完未落盘）→ 校验后直接落盘
            if !FileManager.default.fileExists(atPath: item.fileURL.path),
               let size = r.size, fileSize(item.partURL) >= size {
                if let hash = sha256(of: item.partURL), hash == item.sha256 {
                    try? FileManager.default.moveItem(at: item.partURL, to: item.fileURL)
                    emitDone(item, ok: true, sha256: hash, localURL: item.fileURL.absoluteString, error: nil)
                    continue
                }
                try? FileManager.default.removeItem(at: item.partURL)
            }
            stateLock.lock()
            queue.append(item)
            stateLock.unlock()
            startNextIfPossible()
        }
    }

    /// 取消全部：清未开始队列 + 取消进行中任务；被取消任务回 done(ok=false, error="cancelled")
    func cancelAll() {
        var pending: [Item] = []
        stateLock.lock()
        pending = queue
        queue.removeAll()
        let tasks = Array(active.keys)
        stateLock.unlock()
        for task in tasks {
            task.cancel()
        }
        for item in pending {
            emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: "cancelled")
        }
    }

    /// 查本地资产（异步经 onAssetStatus 回传）
    func checkAsset(path: String) {
        guard Self.isSafePath(path) else {
            DispatchQueue.main.async { [weak self] in
                self?.onAssetStatus?(path, false, nil)
            }
            return
        }
        let url = storageRoot.appendingPathComponent(path)
        let exists = FileManager.default.fileExists(atPath: url.path)
        DispatchQueue.main.async { [weak self] in
            self?.onAssetStatus?(path, exists, exists ? url.absoluteString : nil)
        }
    }

    // MARK: - 调度

    private func startNextIfPossible() {
        var toStart: [URLSessionDataTask] = []
        stateLock.lock()
        while active.count < maxConcurrent, let item = queue.first {
            queue.removeFirst()
            let task = makeDataTask(for: item)
            active[task] = item
            toStart.append(task)
        }
        stateLock.unlock()
        for task in toStart {
            task.resume()
        }
    }

    private func makeDataTask(for item: Item) -> URLSessionDataTask {
        let partSize = fileSize(item.partURL)
        if partSize == 0 {
            try? FileManager.default.removeItem(at: item.partURL)
        }
        var request = URLRequest(url: item.url)
        request.timeoutInterval = 60
        if partSize > 0 {
            item.resumeOffset = partSize
            item.received = 0
            request.setValue("bytes=\(partSize)-", forHTTPHeaderField: "Range")
        } else {
            item.resumeOffset = 0
            item.received = 0
        }
        item.total = item.size ?? 0
        // 续传起点进度立即上报一次（Web 秒见进度条起点）
        emitProgress(item, received: item.resumeOffset, total: item.total)
        return session.dataTask(with: request)
    }

    // MARK: - URLSessionDataDelegate

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask,
                    didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let item = active[dataTask] else {
            completionHandler(.cancel)
            return
        }
        if let http = response as? HTTPURLResponse {
            guard http.statusCode < 400 else {
                // 4xx/5xx：失败（.part 保留，供下次续传；416 由 didReceive data 前的分支处理）
                active.removeValue(forKey: dataTask)
                closeHandle(for: dataTask)
                completionHandler(.cancel)
                emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: "HTTP \(http.statusCode)")
                startNextIfPossible()
                return
            }
            if item.resumeOffset > 0 {
                if http.statusCode == 200 || http.statusCode == 416 {
                    // 200：服务端忽略 Range → 从头重下；416：范围越界（.part 异常/完整）→ 从头
                    item.resumeOffset = 0
                    item.received = 0
                    try? FileManager.default.removeItem(at: item.partURL)
                }
            }
            let contentLength = http.expectedContentLength
            if contentLength > 0 {
                item.total = item.resumeOffset > 0 ? item.resumeOffset + contentLength : contentLength
            } else {
                item.total = item.size ?? 0
            }
        }
        guard openHandle(for: dataTask, item: item) else {
            active.removeValue(forKey: dataTask)
            completionHandler(.cancel)
            emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: "无法打开临时文件")
            startNextIfPossible()
            return
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let item = active[dataTask], let handle = handles[dataTask] else { return }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            active.removeValue(forKey: dataTask)
            closeHandle(for: dataTask)
            emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: "写入失败: \(error.localizedDescription)")
            startNextIfPossible()
            return
        }
        item.received += Int64(data.count)
        // 节流：≥300ms 一次进度事件（防 evaluateJavaScript 刷屏）
        let now = ProcessInfo.processInfo.systemUptime
        if now - item.lastProgressEmit >= 0.3 {
            item.lastProgressEmit = now
            emitProgress(item, received: item.resumeOffset + item.received, total: item.total)
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let dataTask = task as? URLSessionDataTask,
              let item = active.removeValue(forKey: dataTask) else { return }
        closeHandle(for: dataTask)
        if let error {
            if (error as NSError).code == NSURLErrorCancelled {
                emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: "cancelled")
            } else {
                // 网络错误：保留 .part，下次 syncDownload 续传
                emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: error.localizedDescription)
            }
            startNextIfPossible()
            return
        }
        verifyAndFinalize(item)
        startNextIfPossible()
    }

    // MARK: - 校验与落盘

    private func verifyAndFinalize(_ item: Item) {
        if let size = item.size, fileSize(item.partURL) != size {
            retry(item, reason: "size 不匹配（期望 \(size)，实际 \(fileSize(item.partURL))）")
            return
        }
        guard let hash = sha256(of: item.partURL) else {
            retry(item, reason: "临时文件读取失败")
            return
        }
        guard hash == item.sha256 else {
            retry(item, reason: "sha256 不匹配")
            return
        }
        try? FileManager.default.removeItem(at: item.fileURL)
        do {
            try FileManager.default.moveItem(at: item.partURL, to: item.fileURL)
        } catch {
            emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: "落盘失败: \(error.localizedDescription)")
            return
        }
        emitDone(item, ok: true, sha256: hash, localURL: item.fileURL.absoluteString, error: nil)
    }

    /// 校验失败：删 .part 重下（≤2 次）；超限判失败
    private func retry(_ item: Item, reason: String) {
        guard item.attempts < maxAttempts else {
            try? FileManager.default.removeItem(at: item.partURL)
            emitDone(item, ok: false, sha256: item.sha256, localURL: nil, error: reason)
            return
        }
        item.attempts += 1
        try? FileManager.default.removeItem(at: item.partURL)
        item.received = 0
        item.resumeOffset = 0
        item.total = item.size ?? 0
        stateLock.lock()
        queue.insert(item, at: 0) // 重下优先
        stateLock.unlock()
        startNextIfPossible()
    }

    // MARK: - 文件与哈希

    private func openHandle(for task: URLSessionDataTask, item: Item) -> Bool {
        let dir = item.partURL.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: item.partURL.path) {
            FileManager.default.createFile(atPath: item.partURL.path, contents: nil)
        }
        guard let handle = try? FileHandle(forWritingTo: item.partURL) else { return false }
        do {
            try handle.seekToEnd()
        } catch {
            try? handle.close()
            return false
        }
        handles[task] = handle
        return true
    }

    private func closeHandle(for task: URLSessionDataTask) {
        try? handles.removeValue(forKey: task)?.close()
    }

    private func fileSize(_ url: URL) -> Int64 {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let size = attrs[.size] as? NSNumber else { return 0 }
        return size.int64Value
    }

    /// 流式 SHA256（大文件分块读，避免整读内存爆炸）
    private func sha256(of url: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        var hasher = SHA256()
        while true {
            guard let chunk = try? handle.read(upToCount: 1 << 20), !chunk.isEmpty else { break }
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - 事件（回主线程）

    private func emitProgress(_ item: Item, received: Int64, total: Int64) {
        let path = item.path
        DispatchQueue.main.async { [weak self] in
            self?.onProgress?(path, received, total)
        }
    }

    private func emitDone(_ item: Item, ok: Bool, sha256: String, localURL: String?, error: String?) {
        let path = item.path
        let hash = sha256
        DispatchQueue.main.async { [weak self] in
            self?.onDone?(path, ok, hash, localURL, error)
        }
    }
}
