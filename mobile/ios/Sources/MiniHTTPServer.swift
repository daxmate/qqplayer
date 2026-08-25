import Foundation
import Network

/// 极简静态文件 HTTP 服务器（127.0.0.1 随机端口，serve bundle 内 www/ + 沙盒资产目录）。
///
/// 目的：让 WKWebView 以 http:// 加载本地前端，绕开 file:// 的三个硬限制——
/// fetch http 跨源被拒 / localStorage 不可靠 / IndexedDB 不可靠。
/// 零第三方依赖（Network.framework），只支持 GET 静态文件 + 基础 MIME + 路径穿越防护。
///
/// 路由：
///   /             → root（bundle 内 www/）
///   /native-assets/...   → assetsRoot（Documents/qqplayer-assets/，离线资产：音频/EPUB/词典）
final class MiniHTTPServer {
    private let listener: NWListener
    private let root: URL
    private let assetsRoot: URL?
    private let queue = DispatchQueue(label: "qqplayer.miniserver")
    private(set) var port: UInt16
    private var started = false

    /// 固定端口：WKWebView 加载 http://127.0.0.1:17888（个人场景端口冲突概率极低；
    /// 被占时 init 抛错返回 nil，界面显示启动失败提示）。
    static let fixedPort: UInt16 = 17888

    /// 需要嗅探文件头真实格式的图片扩展名（封面缓存 .jpg 可能存 PNG 数据）。
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp"]

    init?(root: URL, assetsRoot: URL? = nil) {
        self.root = root
        self.assetsRoot = assetsRoot
        self.port = Self.fixedPort
        do {
            listener = try NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: Self.fixedPort)!)
        } catch {
            return nil
        }
    }

    /// 启动监听（127.0.0.1 固定端口）；成功返回 true。
    func start() -> Bool {
        guard !started else { return port > 0 }
        started = true
        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }
        listener.start(queue: queue)
        return port > 0
    }

    func stop() {
        listener.cancel()
    }

    // MARK: - 连接处理

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        receiveRequest(conn, buffer: Data())
    }

    private func receiveRequest(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, _ in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            // HTTP 请求头以 \r\n\r\n 结束
            if let range = buf.range(of: Data("\r\n\r\n".utf8)) {
                let head = String(data: buf[..<range.lowerBound], encoding: .utf8) ?? ""
                self.respond(to: head, conn: conn)
            } else if isComplete {
                conn.cancel()
            } else {
                self.receiveRequest(conn, buffer: buf)
            }
        }
    }

    private func respond(to head: String, conn: NWConnection) {
        // 请求行：GET /path HTTP/1.1
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines.first?.split(separator: " ") ?? []
        guard parts.count >= 2, parts[0] == "GET" else {
            send(conn, status: 405, contentType: "text/plain", body: "Method Not Allowed")
            return
        }
        var path = String(parts[1])
        if path.contains("?") { path = String(path.split(separator: "?").first ?? "") }
        if path.hasSuffix("/") { path += "index.html" }
        if path == "/" { path = "/index.html" }

        // /native-assets/ 前缀 → 沙盒资产目录（离线资产读取）；否则 www 内文件
        // 注意：不用 /assets/ —— vite 构建产物也用它（www/assets/*.js），会劫持前端资源。
        let fileURL: URL
        var allowedRoot = root.path
        if path.hasPrefix("/native-assets/") {
            guard let assetsRoot else {
                send(conn, status: 404, contentType: "text/plain", body: "Not Found")
                return
            }
            let rel = String(path.dropFirst("/native-assets/".count))
            // 路径穿越防护：拒绝 . / .. 段 + 标准路径必须在 assetsRoot 内
            let comps = rel.split(separator: "/", omittingEmptySubsequences: false)
            guard !comps.contains(where: { $0 == ".." || $0 == "." }) else {
                send(conn, status: 404, contentType: "text/plain", body: "Not Found")
                return
            }
            let base = assetsRoot.standardizedFileURL.path
            let candidate = assetsRoot.appendingPathComponent(rel).standardizedFileURL
            guard candidate.path.hasPrefix(base + "/") || candidate.path == base else {
                send(conn, status: 404, contentType: "text/plain", body: "Not Found")
                return
            }
            fileURL = candidate
            allowedRoot = base
        } else {
            fileURL = root.appendingPathComponent(path.hasPrefix("/") ? String(path.dropFirst()) : path)
        }
        guard fileURL.path.hasPrefix(allowedRoot),
              FileManager.default.fileExists(atPath: fileURL.path),
              let data = try? Data(contentsOf: fileURL) else {
            send(conn, status: 404, contentType: "text/plain", body: "Not Found")
            return
        }
        // Range 支持：AVPlayer 等 HTTP 流播放器硬性要求（探测时长 / seek 定位依赖
        // 206 + Content-Range；不支持时 duration 读取异常、seek 行为错乱——
        // 2026-08-25 已下载歌全部走本地 HTTP 流后“从接近尾部开始播/跳过”根因）。
        // 无 Range 头或非法时降级 200 全量（带 Accept-Ranges 声明能力）。
        // 图片扩展名时先嗅探文件头魔数——封面缓存统一命名 .jpg 但内容可能是
        // PNG（APIC 声明与实际数据不一致，按扩展名给 Content-Type 会解码失败）。
        let ext = fileURL.pathExtension
        let mime: String
        if Self.imageExtensions.contains(ext.lowercased()) {
            mime = sniffImageMime(fileURL) ?? mimeType(for: ext)
        } else {
            mime = mimeType(for: ext)
        }
        let rangeHeader = lines.first { $0.lowercased().hasPrefix("range:") }
        if let rangeHeader, let r = parseRange(rangeHeader, total: data.count) {
            let slice = data.subdata(in: r.start ..< (r.end + 1))
            send(conn, status: 206, contentType: mime, body: slice,
                 contentRange: "bytes \(r.start)-\(r.end)/\(data.count)")
        } else {
            send(conn, status: 200, contentType: mime, body: data)
        }
    }

    /// 解析 Range 请求头：bytes=start-end / bytes=start- / bytes=-suffix（最后 N 字节）。
    /// 返回闭区间 [start, end]（含端点）；非 bytes 单位 / 非法 / 越界返回 nil（调用方降级 200 全量）。
    private func parseRange(_ header: String, total: Int) -> (start: Int, end: Int)? {
        guard total > 0 else { return nil }
        let spec = header.split(separator: ":", maxSplits: 1).dropFirst().first?
            .trimmingCharacters(in: .whitespaces) ?? ""
        guard spec.lowercased().hasPrefix("bytes=") else { return nil }
        let value = String(spec.dropFirst("bytes=".count)).trimmingCharacters(in: .whitespaces)
        // 注意 omittingEmptySubsequences: false——"500-" 的尾部空段、"-100" 的头部空段都必须保留
        let comps = value.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        guard comps.count == 2 else { return nil }
        // bytes=-N：最后 N 字节（客户端不指定起点）
        if comps[0].isEmpty, let suffix = Int(comps[1]), suffix > 0 {
            let start = max(0, total - suffix)
            return (start, total - 1)
        }
        // bytes=start- 或 bytes=start-end
        guard let start = Int(comps[0]), start >= 0, start < total else { return nil }
        var end = total - 1
        if !comps[1].isEmpty, let e = Int(comps[1]) {
            end = min(e, total - 1)
        }
        guard end >= start else { return nil }
        return (start, end)
    }

    private func send(_ conn: NWConnection, status: Int, contentType: String, body: Data, contentRange: String? = nil) {
        let statusText: String
        switch status {
        case 200: statusText = "OK"
        case 206: statusText = "Partial Content"
        case 404: statusText = "Not Found"
        case 405: statusText = "Method Not Allowed"
        default: statusText = "Error"
        }
        var head = "HTTP/1.1 \(status) \(statusText)\r\n" +
            "Content-Type: \(contentType)\r\n" +
            "Content-Length: \(body.count)\r\n" +
            "Accept-Ranges: bytes\r\n" +
            "Connection: close\r\n\r\n"
        if let contentRange {
            head = "HTTP/1.1 \(status) \(statusText)\r\n" +
                "Content-Type: \(contentType)\r\n" +
                "Content-Length: \(body.count)\r\n" +
                "Content-Range: \(contentRange)\r\n" +
                "Accept-Ranges: bytes\r\n" +
                "Connection: close\r\n\r\n"
        }
        var out = Data(head.utf8)
        out.append(body)
        conn.send(content: out, completion: .contentProcessed { _ in
            conn.cancel()
        })
    }

    private func send(_ conn: NWConnection, status: Int, contentType: String, body: String) {
        send(conn, status: status, contentType: contentType, body: Data(body.utf8))
    }

    /// 按文件头魔数嗅探图片真实格式；只读头部 16 字节不整文件载入，
    /// 无法识别返回 nil（调用方回退扩展名判断）。
    private func sniffImageMime(_ fileURL: URL) -> String? {
        guard let handle = try? FileHandle(forReadingFrom: fileURL) else { return nil }
        defer { try? handle.close() }
        guard let headData = try? handle.read(upToCount: 16) else { return nil }
        let head = [UInt8](headData)
        guard head.count >= 12 else { return nil }
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return "image/png" }
        if head.starts(with: [0xFF, 0xD8, 0xFF]) { return "image/jpeg" }
        if head.starts(with: [0x47, 0x49, 0x46, 0x38]) { return "image/gif" }
        if head.starts(with: [0x52, 0x49, 0x46, 0x46]),
           Array(head[8 ..< 12]) == [0x57, 0x45, 0x42, 0x50] {
            return "image/webp"
        }
        if head.starts(with: [0x42, 0x4D]) { return "image/bmp" }
        return nil
    }

    private func mimeType(for ext: String) -> String {
        switch ext.lowercased() {
        case "html", "htm": return "text/html; charset=utf-8"
        case "js", "mjs": return "application/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json; charset=utf-8"
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "svg": return "image/svg+xml"
        case "webp": return "image/webp"
        case "ico": return "image/x-icon"
        case "woff": return "font/woff"
        case "woff2": return "font/woff2"
        case "ttf": return "font/ttf"
        case "mp3": return "audio/mpeg"
        case "m4a": return "audio/mp4"
        case "mp4": return "video/mp4"
        case "wav": return "audio/wav"
        case "txt": return "text/plain; charset=utf-8"
        case "xml": return "text/xml; charset=utf-8"
        case "pdf": return "application/pdf"
        case "epub": return "application/epub+zip"
        case "mdd": return "application/octet-stream"
        case "mdx": return "application/octet-stream"
        default: return "application/octet-stream"
        }
    }
}
