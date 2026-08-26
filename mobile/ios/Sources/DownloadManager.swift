import CryptoKit
import Foundation
import Network

/// 资产下载管理器（阶段3）：Web 同步清单的本地缓存落地。
/// - 存储根：Documents/qqplayer-assets/<path>（path = audio/<sha256>.m4a 等相对路径）
/// - 断点续传：.part 临时文件 + Range 请求；服务端忽略 Range（回 200）或 416 时自动从头重下
/// - 校验：CryptoKit SHA256；已知 size 先比对；不匹配删 .part 重下（含首下共 3 次尝试）
/// - 并发 ≤ 3；cancelDownloads 清队列 + 取消进行中
/// - 事件闭包全部回主线程（WebShellView Coordinator 桥接 → pushToWeb）
/// - 资产注册表：Documents/meta/assets.json（{path: {sha256, size}} 原子写）；
///   下载完成/已存在校验通过时写入，删除时移除（assetIndex 桥命令全量回推）
/// - 仅 Wi-Fi：syncDownload items 带 wifiOnly 时，蜂窝/无网下挂起不启动（状态视为 queued，
///   不发进度）；NWPathMonitor 检测到 Wi-Fi 自动恢复；已在下载的任务不打断
final class DownloadManager: NSObject, URLSessionDataDelegate {
    /// 下载请求（来自 Web syncDownload 消息）
    struct Request {
        let url: URL          // 绝对 URL（http/https）
        let path: String      // 沙盒相对路径，如 audio/<sha256>.m4a
        let sha256: String    // 期望 hex
        let size: Int64?      // 可选：已知大小先比对
        let wifiOnly: Bool?   // 可选：仅 Wi-Fi 下载（前端每次请求带开关状态；nil → 落回管理器当前开关）
    }

    /// 单任务状态（class：队列 → 进行中 同一实例迁移，属性原地更新）
    private final class Item {
        let url: URL
        let path: String
        let sha256: String
        let size: Int64?
        let wifiOnly: Bool    // 仅 Wi-Fi 下载（入队时固化：r.wifiOnly ?? 管理器当前开关）
        let fileURL: URL      // 最终文件
        let partURL: URL      // 临时文件 .part（断点续传载体）
        var received: Int64 = 0          // 本次会话已接收（不含续传起点）
        var resumeOffset: Int64 = 0      // 续传起点（.part 已有字节数）
        var total: Int64 = 0             // 期望总长（未知为 0）
        var attempts = 1                 // 已尝试次数（含本次，校验失败重下）
        var lastProgressEmit: TimeInterval = 0

        init(url: URL, path: String, sha256: String, size: Int64?, wifiOnly: Bool, fileURL: URL, partURL: URL) {
            self.url = url
            self.path = path
            self.sha256 = sha256
            self.size = size
            self.wifiOnly = wifiOnly
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
    private let sessionConfig: URLSessionConfiguration
    private let pathProvider: NetworkPathProviding

    /// 仅 Wi-Fi 下载开关（setWifiOnly 桥命令设置；syncDownload items 未带 wifiOnly 时的兜底）
    private(set) var wifiOnly = false

    /// 资产注册表锁（独立于 stateLock：deleteAssets 后台线程与下载完成可能并发访问）
    private let registryLock = NSLock()
    private var registry: [String: AssetRecord] = [:]
    private var registryLoaded = false

    private lazy var session: URLSession = {
        URLSession(configuration: sessionConfig, delegate: self, delegateQueue: nil)
    }()

    /// 默认入口（App 内）：Documents/qqplayer-assets + 真机 NWPathMonitor + 默认 session 配置
    convenience override init() {
        // Documents 目录由系统保证存在且恒含首条目，first! 安全（同 MetaStore 先例）
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
        self.init(
            storageRoot: docs.appendingPathComponent("qqplayer-assets", isDirectory: true),
            pathProvider: NWPathMonitorProvider()
        )
    }

    /// 定制入口（测试用）：临时目录 + 注入网络路径提供者 + 注入 session 配置（URLProtocol mock）
    /// + 注入注册表 URL（默认 Documents/meta/assets.json）
    init(storageRoot: URL, pathProvider: NetworkPathProviding, sessionConfig: URLSessionConfiguration? = nil, registryURL: URL? = nil) {
        self.storageRoot = storageRoot
        self.pathProvider = pathProvider
        self.sessionConfig = sessionConfig ?? Self.makeDefaultSessionConfig()
        if let registryURL {
            self.registryURL = registryURL
        } else {
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first!
            self.registryURL = docs.appendingPathComponent("meta", isDirectory: true).appendingPathComponent("assets.json")
        }
        super.init()
        // 网络路径变化（如蜂窝 → Wi-Fi）→ 重新调度被挂起的 wifiOnly 任务
        pathProvider.onPathChange = { [weak self] _ in
            self?.startNextIfPossible()
        }
        pathProvider.start()
    }

    private static func makeDefaultSessionConfig() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = 60
        return config
    }

    /// 释放资源（Coordinator deinit 调用；URLSession 强持有 delegate，必须显式 invalidate 断环）
    func shutdown() {
        session.invalidateAndCancel()
        pathProvider.stop()
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
                wifiOnly: r.wifiOnly ?? wifiOnly,
                fileURL: fileURL,
                partURL: fileURL.appendingPathExtension("part")
            )
            // 去重：已在队列/进行中 → 跳过
            stateLock.lock()
            let dup = queue.contains { $0.path == r.path } || active.values.contains { $0.path == r.path }
            stateLock.unlock()
            if dup { continue }
            // 最终文件已存在：size/哈希校验通过 → 直接完成并写注册表；不通过 → 删除重下
            // size 未知（0）时不比对大小（避免把已存在文件误删）
            if FileManager.default.fileExists(atPath: item.fileURL.path) {
                let hash = sha256(of: item.fileURL)
                if let size = r.size, size > 0, fileSize(item.fileURL) != size {
                    try? FileManager.default.removeItem(at: item.fileURL)
                } else if contentHashMatches(item, hash: hash) {
                    registerAsset(path: item.path, sha256: hash ?? "", size: fileSize(item.fileURL))
                    emitDone(item, ok: true, sha256: hash ?? "", localURL: item.fileURL.absoluteString, error: nil)
                    continue
                } else {
                    try? FileManager.default.removeItem(at: item.fileURL)
                }
            }
            // .part 已完整（上次下载完未落盘）→ 校验后直接落盘并写注册表
            // 注意：size 未知（0）时不能做此判断——fileSize(part)>=0 恒真会把不存在的 .part 误判为完整
            if !FileManager.default.fileExists(atPath: item.fileURL.path),
               let size = r.size, size > 0, fileSize(item.partURL) >= size {
                let hash = sha256(of: item.partURL)
                if contentHashMatches(item, hash: hash) {
                    try? FileManager.default.moveItem(at: item.partURL, to: item.fileURL)
                    registerAsset(path: item.path, sha256: hash ?? "", size: fileSize(item.fileURL))
                    emitDone(item, ok: true, sha256: hash ?? "", localURL: item.fileURL.absoluteString, error: nil)
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

    /// 删除本地资产。scope: "all"|"audio"|"books"|"dicts"
    /// 只允许删除 storageRoot 下的对应子目录（audio/、books/、dicts/）；scope 非法 → no-op。
    /// 删除前 cancelAll()（避免删掉正在写的文件）；整目录移除，删完不留 .part。
    /// 后台执行避免阻塞主线程；completion 在主线程回调（WebShellView 回推 assetsDeleted 用）。
    func deleteAssets(scope: String, completion: (() -> Void)? = nil) {
        let subdirs: [String]?
        switch scope {
        case "all": subdirs = ["audio", "books", "dicts"]
        case "audio": subdirs = ["audio"]
        case "books": subdirs = ["books"]
        case "dicts": subdirs = ["dicts"]
        default: subdirs = nil
        }
        guard let subdirs else { return }  // 非法 scope → no-op
        cancelAll()
        let fm = FileManager.default
        let root = storageRoot
        let rootPrefix = root.path + "/"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            for sub in subdirs {
                let dir = root.appendingPathComponent(sub, isDirectory: true)
                // 纵深防御：白名单子目录也再校验一次仍在 storageRoot 之下
                guard dir.path.hasPrefix(rootPrefix) else { continue }
                try? fm.removeItem(at: dir)
            }
            // 注册表同步：移除被删子目录（audio/ 等前缀）下的全部条目
            self?.unregisterAssets(prefixes: subdirs.map { $0 + "/" })
            DispatchQueue.main.async {
                completion?()
            }
        }
    }

    /// 精确删除：按路径删除指定资产（deleteAssets {paths: [...]} 桥命令，孤儿清理用）。
    /// 每个 path 经 isSafePath 校验（纵深防御再校验解析后仍在 storageRoot 之下）；
    /// 逐个删除最终文件与 .part；同步移除注册表条目。删除前 cancelAll()（同 scope 删除）。
    /// 后台执行；completion 在主线程回调（WebShellView 回推 assetsDeleted 用）。
    func deleteAssets(paths: [String], completion: (() -> Void)? = nil) {
        let valid = paths.filter(Self.isSafePath)
        guard !valid.isEmpty else {
            DispatchQueue.main.async {
                completion?()
            }
            return
        }
        cancelAll()
        let fm = FileManager.default
        let root = storageRoot
        let rootPrefix = root.path + "/"
        DispatchQueue.global(qos: .utility).async { [weak self] in
            for p in valid {
                let fileURL = root.appendingPathComponent(p)
                guard fileURL.path.hasPrefix(rootPrefix) else { continue }
                try? fm.removeItem(at: fileURL)
                try? fm.removeItem(at: fileURL.appendingPathExtension("part"))
            }
            self?.unregisterAssets(paths: valid)
            DispatchQueue.main.async {
                completion?()
            }
        }
    }

    /// 本地资产总占用（字节）：storageRoot 递归求和全部文件（含子目录；.part 也计入）
    func assetsSize() -> Int64 {
        guard let enumerator = FileManager.default.enumerator(
            at: storageRoot, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return 0 }
        var total: Int64 = 0
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                  values.isRegularFile == true,
                  let size = values.fileSize else { continue }
            total += Int64(size)
        }
        return total
    }

    /// 本地资产占用统计（assetsSize 桥命令回执扩展）：
    /// total = 全部文件（同 assetsSize()，兼容旧前端只读 total）；
    /// byType 按 storageRoot 顶层子目录递归求和（audio/covers/lyric/books/dicts/meta），
    /// 根目录散文件与未知子目录 → other；各类型无目录则为 0。
    func assetsSizeByType() -> (total: Int64, byType: [String: Int64]) {
        let knownTypes = ["audio", "covers", "lyric", "books", "dicts", "meta"]
        var byType: [String: Int64] = ["other": 0]
        for t in knownTypes {
            byType[t] = 0
        }
        var total: Int64 = 0
        guard let enumerator = FileManager.default.enumerator(
            at: storageRoot, includingPropertiesForKeys: [.fileSizeKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return (0, byType) }
        let rootDepth = storageRoot.pathComponents.count
        for case let url as URL in enumerator {
            guard let values = try? url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey]),
                  values.isRegularFile == true,
                  let size = values.fileSize else { continue }
            total += Int64(size)
            // 顶层目录（相对 storageRoot）→ 类型；根目录直属文件 → other
            let comps = url.pathComponents
            let top = comps.count > rootDepth ? comps[rootDepth] : "other"
            let type = knownTypes.contains(top) ? top : "other"
            byType[type, default: 0] += Int64(size)
        }
        return (total, byType)
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

    /// 仅 Wi-Fi 下载开关（setWifiOnly 桥命令；fire-and-forget 无回执）。
    /// 开启不影响已下载/进行中任务（简单版：只在启动前检查）；
    /// 关闭时若有被挂起的 wifiOnly 任务 → 立即重新调度（当前若是 Wi-Fi 即开始）。
    func setWifiOnly(_ on: Bool) {
        wifiOnly = on
        WebShellView.appendNativeLog("[Download] wifiOnly=\(on)")
        if !on {
            startNextIfPossible()
        }
    }

    /// 队列中等待启动的任务数（测试/调试）
    var queuedCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return queue.count
    }

    /// 进行中任务数（测试/调试）
    var activeCount: Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return active.count
    }

    // MARK: - 资产注册表（Documents/meta/assets.json）

    /// 注册表条目结构：{path: {sha256, size}}
    private struct AssetRecord: Codable {
        var sha256: String
        var size: Int64
    }

    private let registryURL: URL

    /// 全部已下载资产索引（assetIndex 桥命令回推）：[{path, sha256, size}]，按 path 排序。
    /// 注册表文件缺失/损坏 → 空数组（同 hasAsset 容错语义：不阻塞前端）。
    func assetIndex() -> [[String: Any]] {
        registryLock.lock()
        defer { registryLock.unlock() }
        loadRegistryIfNeeded()
        return registry
            .map { path, rec in ["path": path, "sha256": rec.sha256, "size": rec.size] }
            .sorted { ($0["path"] as? String ?? "") < ($1["path"] as? String ?? "") }
    }

    /// 注册表写入（下载完成 / 已存在校验通过 / .part 完整直接落盘后）：原子落盘
    func registerAsset(path: String, sha256: String, size: Int64) {
        registryLock.lock()
        defer { registryLock.unlock() }
        loadRegistryIfNeeded()
        registry[path] = AssetRecord(sha256: sha256, size: size)
        saveRegistry()
    }

    /// 注册表移除单条（删除单个文件后）
    func unregisterAsset(path: String) {
        registryLock.lock()
        defer { registryLock.unlock() }
        loadRegistryIfNeeded()
        if registry.removeValue(forKey: path) != nil {
            saveRegistry()
        }
    }

    /// 注册表批量移除（deleteAssets paths 精确删除后；一次落盘）
    func unregisterAssets(paths: [String]) {
        registryLock.lock()
        defer { registryLock.unlock() }
        loadRegistryIfNeeded()
        var changed = false
        for p in paths where registry.removeValue(forKey: p) != nil {
            changed = true
        }
        if changed {
            saveRegistry()
        }
    }

    /// 注册表按顶层前缀批量移除（deleteAssets scope 删除后；如 "audio/"）
    func unregisterAssets(prefixes: [String]) {
        registryLock.lock()
        defer { registryLock.unlock() }
        loadRegistryIfNeeded()
        let toRemove = registry.keys.filter { key in
            prefixes.contains { key.hasPrefix($0) }
        }
        for k in toRemove {
            registry.removeValue(forKey: k)
        }
        if !toRemove.isEmpty {
            saveRegistry()
        }
    }

    private func loadRegistryIfNeeded() {
        guard !registryLoaded else { return }
        registryLoaded = true
        guard let data = try? Data(contentsOf: registryURL),
              let decoded = try? JSONDecoder().decode([String: AssetRecord].self, from: data)
        else { return }
        registry = decoded
    }

    /// 注册表原子写（先 .tmp 再 rename，同 MetaStore 模式）；失败静默返回 false，不抛
    @discardableResult
    private func saveRegistry() -> Bool {
        guard let data = try? JSONEncoder().encode(registry) else { return false }
        let dir = registryURL.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let tmp = dir.appendingPathComponent("assets.json.tmp")
            if FileManager.default.fileExists(atPath: tmp.path) {
                try FileManager.default.removeItem(at: tmp)
            }
            try data.write(to: tmp)
            if FileManager.default.fileExists(atPath: registryURL.path) {
                try FileManager.default.removeItem(at: registryURL)
            }
            try FileManager.default.moveItem(at: tmp, to: registryURL)
            return true
        } catch {
            return false
        }
    }

    // MARK: - 调度

    private func startNextIfPossible() {
        var toStart: [URLSessionDataTask] = []
        stateLock.lock()
        while active.count < maxConcurrent {
            // Wi-Fi 限制：wifiOnly 且当前非 Wi-Fi（蜂窝/无网）→ 跳过不启动，任务保留在队列等待
            // （不发进度/完成事件，状态可视为 queued）；NWPathMonitor 切 Wi-Fi 时再次调度
            guard let idx = queue.firstIndex(where: { !$0.wifiOnly || pathProvider.isWifi }) else { break }
            let item = queue.remove(at: idx)
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
            WebShellView.appendNativeLog("[Download] didComplete error: \(error.localizedDescription)")
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
        // size 未知（0）时跳过大小校验（前端未提供 size 时传 0）
        if let size = item.size, size > 0, fileSize(item.partURL) != size {
            retry(item, reason: "size 不匹配（期望 \(size)，实际 \(fileSize(item.partURL))）")
            return
        }
        guard let hash = sha256(of: item.partURL) else {
            WebShellView.appendNativeLog("[Download] retry reason: 临时文件读取失败")
            retry(item, reason: "临时文件读取失败")
            return
        }
        guard contentHashMatches(item, hash: hash) else {
            WebShellView.appendNativeLog("[Download] retry reason: sha256 不匹配")
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
        // 校验通过落盘 → 写资产注册表（下载完成时机，先于 emitDone 保证事件到达时索引已就绪）
        registerAsset(path: item.path, sha256: hash, size: fileSize(item.fileURL))
        emitDone(item, ok: true, sha256: hash, localURL: item.fileURL.absoluteString, error: nil)
    }

    /// 内容校验：sha256 为空或非 64 位 hex（后端 manifest 暂未提供真实内容哈希时前端传空占位）
    /// → 跳过内容校验（size 校验仍生效）；真实内容校验待后端补 sha256 字段后启用
    private func contentHashMatches(_ item: Item, hash: String?) -> Bool {
        let expected = item.sha256
        if expected.isEmpty || expected.count != 64 { return true }
        guard let hash else { return false }
        return hash == expected
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

// MARK: - 网络路径提供者（Wi-Fi 限制可测性）

/// 网络路径抽象：DownloadManager 只依赖 isWifi + onPathChange；
/// 真机走 NWPathMonitor（NWPathMonitorProvider），测试注入可控 mock。
protocol NetworkPathProviding: AnyObject {
    /// 当前是否 Wi-Fi（蜂窝/无网/其他 → false）
    var isWifi: Bool { get }
    /// 路径变化回调（Wi-Fi 状态变化 → 重新调度被挂起的 wifiOnly 任务）
    var onPathChange: ((Bool) -> Void)? { get set }
    func start()
    func stop()
}

/// 真机实现：NWPathMonitor 监听 Wi-Fi/蜂窝（iOS 12+，deployment target 16 满足）。
/// 路径更新在主线程落地（DownloadManager 的事件回主线程约定一致）。
final class NWPathMonitorProvider: NetworkPathProviding {
    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "com.daxmate.qqplayer.network-path")
    private(set) var isWifi = false
    var onPathChange: ((Bool) -> Void)?

    init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let wifi = path.status == .satisfied && path.usesInterfaceType(.wifi)
            DispatchQueue.main.async {
                guard let self else { return }
                let changed = self.isWifi != wifi
                self.isWifi = wifi
                if changed {
                    self.onPathChange?(wifi)
                }
            }
        }
    }

    func start() {
        monitor.start(queue: monitorQueue)
    }

    func stop() {
        monitor.cancel()
    }
}
