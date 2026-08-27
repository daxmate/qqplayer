import CryptoKit
import XCTest

@testable import QQPlayer

/// DownloadManager 资产底座测试（T2）：
/// ① 资产注册表（下载完成写入 / 已存在校验通过写入 / 删除后移除，含 scope 前缀清理）
/// ② assetsSize byType 分类统计（audio/covers/lyric/books/dicts/meta/other）
/// ③ deleteAssets paths 精确删除 + 注册表同步
/// ④ wifiOnly：蜂窝挂起不启动、切 Wi-Fi 自动启动、普通项不被阻塞、落回管理器开关
/// 全部走临时目录注入 + URLProtocol mock，不碰真实 Documents 沙盒、不发真实网络请求。
final class DownloadManagerTests: XCTestCase {
    // CI 模拟器慢：删除/下载链（文件+注册表+主线程回调）偶发 >5s，5s 超时导致同型 flaky
    // （testDeleteAssetsPathsRemovesFilesAndRegistry / testDeleteAssetsInvalidPathsAreIgnored 连续 3 次超时）。
    // 统一放宽到 15s，避免再次误报。
    private let waitTimeout: TimeInterval = 15

    /// 可控网络路径提供者：isWifi 由测试设置，onPathChange 手动触发（模拟 NWPathMonitor 回调）
    private final class MockPathProvider: NetworkPathProviding {
        private(set) var isWifi: Bool
        var onPathChange: ((Bool) -> Void)?
        private(set) var started = false
        private(set) var stopped = false

        init(isWifi: Bool) {
            self.isWifi = isWifi
        }

        func start() { started = true }
        func stop() { stopped = true }

        /// 切换网络状态并触发路径变化回调（模拟 NWPathMonitor pathUpdateHandler）
        func setWifi(_ wifi: Bool) {
            isWifi = wifi
            onPathChange?(wifi)
        }
    }

    /// URLProtocol mock：固定响应体 + Content-Length，命中即完成
    private final class MockURLProtocol: URLProtocol {
        static var responseData = Data()
        static var responseStatus = 200

        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

        override func startLoading() {
            let response = HTTPURLResponse(
                url: request.url!,
                statusCode: Self.responseStatus,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Length": "\(Self.responseData.count)"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Self.responseData)
            client?.urlProtocolDidFinishLoading(self)
        }

        override func stopLoading() {}
    }

    // MARK: - 工具

    private var tempRoot: URL!
    private var assetsRoot: URL!
    private var registryURL: URL!

    override func setUp() {
        super.setUp()
        tempRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("qqplayer-dm-tests-\(UUID().uuidString)", isDirectory: true)
        assetsRoot = tempRoot.appendingPathComponent("qqplayer-assets", isDirectory: true)
        registryURL = tempRoot.appendingPathComponent("meta", isDirectory: true).appendingPathComponent("assets.json")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tempRoot)
        super.tearDown()
    }

    private func makeSessionConfig() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        return config
    }

    private func sha256Hex(of data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func makeManager(pathProvider: NetworkPathProviding) -> DownloadManager {
        DownloadManager(
            storageRoot: assetsRoot,
            pathProvider: pathProvider,
            sessionConfig: makeSessionConfig(),
            registryURL: registryURL
        )
    }

    private func writeAsset(_ relPath: String, data: Data) throws {
        let url = assetsRoot.appendingPathComponent(relPath)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url)
    }

    // MARK: - ① 资产注册表

    func testRegistryWrittenOnDownloadComplete() throws {
        MockURLProtocol.responseData = Data(repeating: 0xAB, count: 128)
        let sha = sha256Hex(of: MockURLProtocol.responseData)
        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }

        let done = expectation(description: "done")
        manager.onDone = { path, ok, _, _, _ in
            if path == "audio/abc.m4a", ok { done.fulfill() }
        }
        let url = URL(string: "http://mock.local/audio/abc.m4a")!
        manager.enqueue([.init(url: url, path: "audio/abc.m4a", sha256: sha, size: 128, wifiOnly: false)])

        wait(for: [done], timeout: waitTimeout)

        // 注册表文件已原子落盘：{path: {sha256, size}}
        let data = try Data(contentsOf: registryURL)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: [String: Any]])
        let record = try XCTUnwrap(json["audio/abc.m4a"])
        XCTAssertEqual(record["sha256"] as? String, sha)
        XCTAssertEqual(record["size"] as? Int, 128)
        // 落盘文件确实存在（moveItem 完成）
        XCTAssertTrue(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("audio/abc.m4a").path))

        // assetIndex 回推全量（path/sha256/size）
        let index = manager.assetIndex()
        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index[0]["path"] as? String, "audio/abc.m4a")
        XCTAssertEqual(index[0]["sha256"] as? String, sha)
        XCTAssertEqual(index[0]["size"] as? Int64, 128)
    }

    func testRegistryWrittenForExistingVerifiedFile() throws {
        // 已存在且校验通过 → 直接 done（不下载），同时写注册表
        let data = Data(repeating: 0xCD, count: 256)
        let sha = sha256Hex(of: data)
        try writeAsset("audio/exists.m4a", data: data)

        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }

        let done = expectation(description: "done-direct")
        manager.onDone = { path, ok, _, _, _ in
            if path == "audio/exists.m4a", ok { done.fulfill() }
        }
        let url = URL(string: "http://mock.local/audio/exists.m4a")!
        manager.enqueue([.init(url: url, path: "audio/exists.m4a", sha256: sha, size: 256, wifiOnly: false)])

        wait(for: [done], timeout: waitTimeout)

        let index = manager.assetIndex()
        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index[0]["path"] as? String, "audio/exists.m4a")
        XCTAssertEqual(index[0]["sha256"] as? String, sha)
        XCTAssertEqual(index[0]["size"] as? Int64, 256)
    }

    func testRegistryEmptyWhenNoAssets() {
        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }
        XCTAssertTrue(manager.assetIndex().isEmpty)
    }

    // MARK: - ② assetsSize byType

    func testAssetsSizeByType() throws {
        let files: [(String, Int)] = [
            ("audio/a.m4a", 100),
            ("covers/c.jpg", 50),
            ("lyric/l.lrc", 20),
            ("books/b.epub", 200),
            ("dicts/d.json", 30),
            ("meta/m.json", 10),
            ("stray.txt", 5), // 根目录散文件 → other
            ("unknown/x.bin", 15), // 未知子目录 → other
        ]
        for (rel, size) in files {
            try writeAsset(rel, data: Data(repeating: 0, count: size))
        }

        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }

        let info = manager.assetsSizeByType()
        XCTAssertEqual(info.total, 430)
        XCTAssertEqual(info.byType["audio"], 100)
        XCTAssertEqual(info.byType["covers"], 50)
        XCTAssertEqual(info.byType["lyric"], 20)
        XCTAssertEqual(info.byType["books"], 200)
        XCTAssertEqual(info.byType["dicts"], 30)
        XCTAssertEqual(info.byType["meta"], 10)
        XCTAssertEqual(info.byType["other"], 20)
        // 旧 total 接口保持一致（兼容旧前端只读 total）
        XCTAssertEqual(manager.assetsSize(), 430)
    }

    func testAssetsSizeByTypeEmpty() {
        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }
        let info = manager.assetsSizeByType()
        XCTAssertEqual(info.total, 0)
        XCTAssertEqual(info.byType["audio"], 0)
        XCTAssertEqual(info.byType["covers"], 0)
        XCTAssertEqual(info.byType["lyric"], 0)
        XCTAssertEqual(info.byType["books"], 0)
        XCTAssertEqual(info.byType["dicts"], 0)
        XCTAssertEqual(info.byType["meta"], 0)
        XCTAssertEqual(info.byType["other"], 0)
    }

    func testAssetsSizeByTypeViaSymlinkedRoot() throws {
        // 真机场景（2026-08-27）：iOS 沙盒路径含 symlink（/var → /private/var），
        // enumerator 返回解析后路径（/private/var/...），与 storageRoot（/var/...）前缀
        // 不一致 → 旧实现按 pathComponents 开头索引取顶层目录错位 → 全部归 other。
        // macOS /tmp → /private/tmp 同型，可本地复现：storageRoot 用未解析 /tmp 路径，
        // 枚举返回 /private/tmp/...（实测前缀不同但枚举成功）→ 类型必须按倒数第二段分类。
        let root = URL(fileURLWithPath: "/tmp/qqplayer-dm-symlink-\(UUID().uuidString)/qqplayer-assets")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("audio"), withIntermediateDirectories: true)
        try Data(repeating: 0, count: 100).write(to: root.appendingPathComponent("audio/a.m4a"))
        try Data(repeating: 0, count: 5).write(to: root.appendingPathComponent("stray.txt"))

        let manager = DownloadManager(
            storageRoot: root,
            pathProvider: MockPathProvider(isWifi: true),
            sessionConfig: makeSessionConfig(),
            registryURL: registryURL
        )
        defer {
            manager.shutdown()
            try? FileManager.default.removeItem(at: root)
        }

        let info = manager.assetsSizeByType()
        XCTAssertEqual(info.total, 105)
        XCTAssertEqual(info.byType["audio"], 100, "symlink 前缀差异下 audio 子目录必须正确分类（真机全归 other 根因回归）")
        XCTAssertEqual(info.byType["other"], 5)
    }

    // MARK: - ③ deleteAssets paths 精确删除

    func testDeleteAssetsPathsRemovesFilesAndRegistry() throws {
        let data = Data(repeating: 0xEF, count: 64)
        let sha = sha256Hex(of: data)
        try writeAsset("audio/keep.m4a", data: data)
        try writeAsset("books/orphan.epub", data: data)

        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }
        // 预置注册表（模拟之前下载完成已写入）
        manager.registerAsset(path: "audio/keep.m4a", sha256: sha, size: 64)
        manager.registerAsset(path: "books/orphan.epub", sha256: sha, size: 64)

        let deleted = expectation(description: "deleted")
        manager.deleteAssets(paths: ["books/orphan.epub"]) {
            deleted.fulfill()
        }
        wait(for: [deleted], timeout: waitTimeout)

        // 指定文件删除、未指定保留
        XCTAssertFalse(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("books/orphan.epub").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("books/orphan.epub.part").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("audio/keep.m4a").path))
        // 注册表同步移除对应条目
        let index = manager.assetIndex()
        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index[0]["path"] as? String, "audio/keep.m4a")
    }

    func testScopeDeleteRemovesRegistryEntries() throws {
        try writeAsset("audio/a.m4a", data: Data(repeating: 1, count: 8))
        try writeAsset("books/b.epub", data: Data(repeating: 2, count: 8))

        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }
        manager.registerAsset(path: "audio/a.m4a", sha256: "a", size: 8)
        manager.registerAsset(path: "books/b.epub", sha256: "b", size: 8)

        let deleted = expectation(description: "scope-deleted")
        manager.deleteAssets(scope: "audio") { deleted.fulfill() }
        wait(for: [deleted], timeout: waitTimeout)

        XCTAssertFalse(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("audio").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("books/b.epub").path))
        let index = manager.assetIndex()
        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index[0]["path"] as? String, "books/b.epub")
    }

    func testDeleteAssetsInvalidPathsAreIgnored() throws {
        let data = Data(repeating: 0x77, count: 16)
        try writeAsset("audio/safe.m4a", data: data)
        let manager = makeManager(pathProvider: MockPathProvider(isWifi: true))
        defer { manager.shutdown() }
        manager.registerAsset(path: "audio/safe.m4a", sha256: "s", size: 16)

        // 路径穿越/非法路径 → 安全忽略，不删任何文件
        let deleted = expectation(description: "deleted")
        manager.deleteAssets(paths: ["../evil.m4a", "/abs.m4a", "audio/../escape.m4a"]) { deleted.fulfill() }
        wait(for: [deleted], timeout: waitTimeout)

        XCTAssertTrue(FileManager.default.fileExists(atPath: assetsRoot.appendingPathComponent("audio/safe.m4a").path))
        XCTAssertEqual(manager.assetIndex().count, 1)
    }

    // MARK: - ④ wifiOnly

    func testWifiOnlyHoldsOnCellularThenStartsOnWifi() throws {
        MockURLProtocol.responseData = Data(repeating: 0x11, count: 64)
        let sha = sha256Hex(of: MockURLProtocol.responseData)
        let provider = MockPathProvider(isWifi: false) // 蜂窝
        let manager = makeManager(pathProvider: provider)
        defer { manager.shutdown() }

        var doneEvents: [String] = []
        let started = expectation(description: "done-after-wifi")
        manager.onDone = { path, ok, _, _, _ in
            doneEvents.append("\(path):\(ok)")
            if path == "audio/wifi.m4a", ok { started.fulfill() }
        }

        let url = URL(string: "http://mock.local/audio/wifi.m4a")!
        manager.enqueue([.init(url: url, path: "audio/wifi.m4a", sha256: sha, size: 64, wifiOnly: true)])

        // 蜂窝 + wifiOnly → 挂起不启动（无进度/完成事件，队列保留）
        XCTAssertEqual(manager.queuedCount, 1)
        XCTAssertEqual(manager.activeCount, 0)
        XCTAssertTrue(doneEvents.isEmpty)

        // 切 Wi-Fi → 自动启动并完成
        provider.setWifi(true)
        wait(for: [started], timeout: waitTimeout)
        XCTAssertEqual(manager.queuedCount, 0)
        XCTAssertEqual(doneEvents, ["audio/wifi.m4a:true"])
    }

    func testNonWifiItemStartsWhileWifiOnlyItemHeld() throws {
        MockURLProtocol.responseData = Data(repeating: 0x22, count: 32)
        let sha = sha256Hex(of: MockURLProtocol.responseData)
        let manager = makeManager(pathProvider: MockPathProvider(isWifi: false))
        defer { manager.shutdown() }

        let plainDone = expectation(description: "plain-done")
        manager.onDone = { path, ok, _, _, _ in
            if path == "audio/plain.m4a", ok { plainDone.fulfill() }
        }

        // 队首是 wifiOnly（被挂起），后面的普通项不应被阻塞
        let wifiURL = URL(string: "http://mock.local/audio/wifi.m4a")!
        let plainURL = URL(string: "http://mock.local/audio/plain.m4a")!
        manager.enqueue([
            .init(url: wifiURL, path: "audio/wifi.m4a", sha256: sha, size: 32, wifiOnly: true),
            .init(url: plainURL, path: "audio/plain.m4a", sha256: sha, size: 32, wifiOnly: false),
        ])

        wait(for: [plainDone], timeout: waitTimeout)
        // wifiOnly 项仍被挂起，普通项已完成并写入注册表
        XCTAssertEqual(manager.queuedCount, 1)
        let index = manager.assetIndex()
        XCTAssertEqual(index.count, 1)
        XCTAssertEqual(index[0]["path"] as? String, "audio/plain.m4a")
    }

    func testWifiOnlyFallsBackToManagerSetting() {
        let provider = MockPathProvider(isWifi: false)
        let manager = makeManager(pathProvider: provider)
        defer { manager.shutdown() }

        // setWifiOnly 开启后，items 未带 wifiOnly（nil）→ 落回管理器开关
        manager.setWifiOnly(true)
        let url = URL(string: "http://mock.local/audio/fallback.m4a")!
        manager.enqueue([.init(url: url, path: "audio/fallback.m4a", sha256: "", size: nil, wifiOnly: nil)])

        XCTAssertEqual(manager.queuedCount, 1)
        XCTAssertEqual(manager.activeCount, 0)

        // 关闭开关 → 任务重新调度（当前 Wi-Fi 则开始）；此处仍蜂窝 → 依旧挂起
        manager.setWifiOnly(false)
        XCTAssertEqual(manager.queuedCount, 1)
    }
}
