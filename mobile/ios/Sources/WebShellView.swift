import SwiftUI
import WebKit

/// 前端壳：WKWebView 加载 bundle 内 www/index.html（file:// 离线可用）。
/// - 注入（documentStart）：window.qqplayerNative=true（壳标记，桌面壳语义一致）
///   + window.qqplayerIosBridge（播放桥，postMessage → "qqplayerIos" handler）
///   + localStorage 设 qqplayer.server / qqplayer.token（apiClient 读取；file:// 下 localStorage 可用）
/// - WKPreferences：allowFileAccessFromFileURLs + allowUniversalAccessFromFileURLs
///   （file:// 页面 fetch 桌面服务器 http 需跨源，后者绕 CORS——内容为自捆绑代码，信任模型同桌面壳）
/// - 消息桥：Web → Native（play/pause/seek/setVolume/setRate/setMetadata/…）→ AVPlayerBridge
/// - 事件回传：Native → Web 走 evaluateJavaScript 调 window.qqplayerOnNativeEvent(name, payload)
struct WebShellView: UIViewRepresentable {
    let server: PairingRecord

    func makeUIView(context: Context) -> WKWebView {
        let controller = context.coordinator
        let config = WKWebViewConfiguration()
        // file:// 页面允许跨源 fetch（iOS 壳加载本地前端 + 远程桌面 API 的必要配置）
        // 注意：allowUniversalAccessFromFileURLs 是 macOS 专属 key，iOS 上 KVC 会崩，不能写
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController = controller.userContentController
        let webView = NoMenuWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = controller
        webView.uiDelegate = controller
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.bounces = false
        // 触摸立即派发 JS（默认 delaysContentTouches=true 会吞掉 iframe 内 touchstart，
        // 滑动翻页/触摸事件收不到；设 false 后手势判定不再延迟事件）
        webView.scrollView.delaysContentTouches = false
        webView.scrollView.canCancelContentTouches = false
        // 左右滑动翻页（iOS 原生手势：iframe 内 touch 事件在 WKWebView 里不可靠）。
        // UISwipeGestureRecognizer 要求快速滑动（慢速拖动不触发，真机反馈"迟钝"）→
        // 换 UIPanGestureRecognizer：水平主方向接管（shouldBegin 判断），ended 按
        // 位移/速度判定翻页——慢速拖动、快速轻扫都能翻（垂直滚动留给 WebView）。
        let panSwipe = UIPanGestureRecognizer(target: controller, action: #selector(Coordinator.onPanSwipe))
        panSwipe.delegate = controller
        webView.addGestureRecognizer(panSwipe)
        controller.webView = webView
        controller.injectServer(controller.server) // 先注入（user script 在页面加载前就位）再加载
        controller.loadFrontend() // 首次加载（服务器切换时由 updateUIView 重新加载）
        return webView
    }

    func updateUIView(_ uiView: WKWebView, context: Context) {
        // 服务器切换时（server 变化）重新注入并刷新
        if context.coordinator.loadedServerId != server.serverId {
            context.coordinator.loadedServerId = server.serverId
            context.coordinator.injectServer(server)
            context.coordinator.loadFrontend()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(server: server)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIGestureRecognizerDelegate {
        let server: PairingRecord
        let playerBridge = AVPlayerBridge()
        let downloadManager = DownloadManager()
        var loadedServerId: String
        var webView: WKWebView?
        private var webReady = false

        /// 排队待 Web 的事件（nativeReady 前不推，防事件早于适配层安装）
        private var pendingEvents: [(String, [String: Any])] = []

        /// scenePhase → appState 事件（App 侧 NotificationCenter 中转）
        private var scenePhaseObserver: NSObjectProtocol?
        /// hasAsset 请求的 requestId 队列（path → [requestId]，逐个消费）
        private var pendingAssetStatus: [String: [String]] = [:]
        /// metaLoad 请求的 requestId → kind（回执时回带；对齐 hasAsset 的 requestId 回执模式）
        private var pendingMetaLoads: [String: String] = [:]

        let userContentController: WKUserContentController

        init(server: PairingRecord) {
            self.server = server
            self.loadedServerId = server.serverId
            playerBridge.authToken = server.token  // AVPlayer 拉流鉴权（真机 401 修复）
            userContentController = WKUserContentController()
            super.init()
            userContentController.add(self, name: "qqplayerIos")
            installUserScripts()
            playerBridge.onEvent = { [weak self] name, payload in
                self?.pushToWeb(event: name, payload: payload)
            }
            playerBridge.onRemoteCommand = { [weak self] cmd, t in
                // 诊断日志：锁屏/线控命令到达原生（nativecmd.log 沙盒 + 后端 /api/debuglog 双通道；
                // 后端上报不依赖 WebView——后台锁屏时 JS 可能挂起，原生通道是唯一可靠时间线）
                WebShellView.appendNativeLog("remoteCmd \(cmd)" + (t.map { " t=\($0)" } ?? ""))
                self?.reportNativeCmd(cmd, t)
                var payload: [String: Any] = ["cmd": cmd]
                if let t { payload["t"] = t }
                self?.pushToWeb(event: "remoteCommand", payload: payload)
            }
            // 下载管理器事件 → Web（syncAssetProgress / syncAssetDone / assetStatus）
            downloadManager.onProgress = { [weak self] path, received, total in
                self?.pushToWeb(event: "syncAssetProgress", payload: ["path": path, "received": received, "total": total])
            }
            downloadManager.onDone = { [weak self] path, ok, sha256, localURL, error in
                var payload: [String: Any] = ["path": path, "ok": ok, "sha256": sha256]
                if let localURL { payload["localURL"] = localURL }
                if let error { payload["error"] = error }
                self?.pushToWeb(event: "syncAssetDone", payload: payload)
            }
            downloadManager.onAssetStatus = { [weak self] path, exists, localURL in
                guard let self else { return }
                var payload: [String: Any] = ["path": path, "exists": exists]
                if let localURL { payload["localURL"] = localURL }
                if var ids = self.pendingAssetStatus[path], !ids.isEmpty {
                    payload["requestId"] = ids.removeFirst()
                    self.pendingAssetStatus[path] = ids.isEmpty ? nil : ids
                }
                self.pushToWeb(event: "assetStatus", payload: payload)
            }
            // scenePhase 变化（App 生命周期）→ appState 事件
            scenePhaseObserver = NotificationCenter.default.addObserver(
                forName: .qqplayerScenePhase, object: nil, queue: .main
            ) { [weak self] note in
                guard let state = note.userInfo?["state"] as? String else { return }
                self?.pushToWeb(event: "appState", payload: ["state": state])
            }
        }

        deinit {
            if let scenePhaseObserver {
                NotificationCenter.default.removeObserver(scenePhaseObserver)
            }
            downloadManager.shutdown()
        }

        // MARK: 注入脚本

        private func installUserScripts() {
            // 壳标记 + iOS 播放桥（Web 适配层检测 window.qqplayerIosBridge）
            let bridgeJS = """
            (function() {
              try {
                window.qqplayerNative = true;
                window.qqplayerIosBridge = {
                  version: 1,
                  postMessage: function(msg) {
                    try { window.webkit.messageHandlers.qqplayerIos.postMessage(msg); } catch (e) {}
                  }
                };
              } catch (e) {}
            })();
            """
            userContentController.addUserScript(
                WKUserScript(source: bridgeJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
            injectServer(server)
        }

        /// localStorage 注入（apiClient 启动即读；随配对记录变化重新注入）
        func injectServer(_ record: PairingRecord) {
            let js = """
            (function() {
              try {
                localStorage.setItem('qqplayer.server', \(WebShellView.jsonLiteral(record.url)));
                localStorage.setItem('qqplayer.token', \(WebShellView.jsonLiteral(record.token)));
              } catch (e) {}
            })();
            """
            userContentController.removeAllUserScripts()
            let shellJS = """
            (function() {
              try {
                window.qqplayerNative = true;
                window.qqplayerIosBridge = {
                  version: 1,
                  server: \(WebShellView.jsonLiteral(record.url)),
                  token: \(WebShellView.jsonLiteral(record.token)),
                  postMessage: function(msg) {
                    try { window.webkit.messageHandlers.qqplayerIos.postMessage(msg); } catch (e) {}
                  }
                };
                window.qqplayerHttpCallback = function(id, status, bodyText) {
                  var p = window.__qqpHttpPending && window.__qqpHttpPending[id];
                  if (p) { delete window.__qqpHttpPending[id]; p(status, bodyText); }
                };
              } catch (e) {}
            })();
            """
            userContentController.addUserScript(
                WKUserScript(source: shellJS, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
            userContentController.addUserScript(
                WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true)
            )
        }

        /// 兑底重注入：页面加载完成后 evaluateJavaScript 重设 server/token（双写 localStorage + bridge）。
        /// documentStart user script 在页面已加载（updateUIView 后注入）时会错过，必须这里补。
        func reinjectServer() {
            guard let webView else { return }
            let js = """
            (function() {
              try {
                localStorage.setItem('qqplayer.server', \(WebShellView.jsonLiteral(server.url)));
                localStorage.setItem('qqplayer.token', \(WebShellView.jsonLiteral(server.token)));
                if (window.qqplayerIosBridge) {
                  window.qqplayerIosBridge.server = \(WebShellView.jsonLiteral(server.url));
                  window.qqplayerIosBridge.token = \(WebShellView.jsonLiteral(server.token));
                }
              } catch (e) {}
            })();
            """
            webView.evaluateJavaScript(js) { _, _ in }
        }

        // MARK: 加载

        /// 本地迷你 HTTP 服务器（serve bundle 内 www/，WKWebView 以 http:// 加载）。
        /// 绕开 file:// 的 fetch 跨源 / localStorage / IndexedDB 硬限制（2026-08-22 换路定案）。
        private lazy var localServer: MiniHTTPServer? = {
            guard let www = Bundle.main.resourceURL?.appendingPathComponent("www") else { return nil }
            let assets = URL(fileURLWithPath: downloadManager.storageRootPath, isDirectory: true)
            return MiniHTTPServer(root: www, assetsRoot: assets)
        }()
        private var localServerPort: UInt16 = 0

        func loadFrontend() {
            guard let webView else { return }
            webReady = false
            pendingEvents.removeAll()
            guard let www = Bundle.main.resourceURL?.appendingPathComponent("www"),
                  FileManager.default.fileExists(atPath: www.appendingPathComponent("index.html").path)
            else {
                // 缺前端产物：显示提示（build.sh 未跑 / 未打包）
                webView.loadHTMLString(
                    "<html><body style='font-family:-apple-system;padding:40px;text-align:center;color:#888'>" +
                        "前端资源缺失：请先运行 mobile/ios/build.sh（构建并复制 www）</body></html>",
                    baseURL: nil
                )
                return
            }
            // 启动本地服务器（幂等）并加载 http://127.0.0.1:port/index.html
            if localServerPort == 0, let srv = localServer, srv.start() {
                localServerPort = srv.port
            }
            guard localServerPort > 0 else {
                webView.loadHTMLString(
                    "<html><body style='font-family:-apple-system;padding:40px;text-align:center;color:#888'>" +
                        "本地服务器启动失败</body></html>",
                    baseURL: nil
                )
                return
            }
            if let url = URL(string: "http://127.0.0.1:\(localServerPort)/index.html") {
                webView.load(URLRequest(url: url))
            }
        }

        // MARK: WKScriptMessageHandler（Web → Native）

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard message.name == "qqplayerIos" else { return }
            let body: [String: Any]
            if let dict = message.body as? [String: Any] {
                body = dict
            } else if let str = message.body as? String,
                      let data = str.data(using: .utf8),
                      let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                body = obj
            } else {
                return
            }
            guard let cmd = body["cmd"] as? String else { return }
            // 桥消息按域分路由（各域 handler 见下方 extension；纯搬移，行为零变化）
            switch cmd {
            case "nativeReady", "nativeLog", "pullRevealStatusBar":
                handleUILifecycleCommand(cmd, body: body)
            case "syncDownload", "hasAsset", "cancelDownloads", "deleteAssets", "assetsSize", "assetIndex", "setWifiOnly":
                handleSyncCommand(cmd, body: body)
            case "metaSave", "metaLoad":
                handleMetaCommand(cmd, body: body)
            case "unauthorized":
                handlePairingCommand(cmd)
            default:
                handlePlaybackCommand(cmd, body: body) // playAudio + 播放命令透传（含未知命令静默）
            }
        }

        // MARK: WKUIDelegate

        /// 禁长按链接/图片的系统 context menu 预览（iOS 13+）：阅读器交互统一走 Web 工具栏
        func webView(
            _ webView: WKWebView,
            contextMenuConfigurationFor element: WKContextMenuElementInfo,
            completionHandler: @escaping (UIContextMenuConfiguration?) -> Void
        ) {
            completionHandler(nil)
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation?) {
            // 移除 WebKit 内部菜单交互：iOS 16+ 选区编辑菜单由 UIEditMenuInteraction 驱动
            // （WebKit bug 244149 无官方禁用 API；移除后选区拖拽手柄保留、不再弹系统菜单）
            stripSystemMenuInteractions(from: webView)
            // 页面就绪：确保适配层已挂（模块脚本加载完成后）；重复调用幂等
            webView.evaluateJavaScript("typeof window.qqplayerOnNativeEvent === 'function'") { [weak self] result, _ in
                guard let self, let ok = result as? Bool, ok else { return }
                if !self.webReady {
                    self.webReady = true
                    self.flushPendingEvents()
                }
                // 兑底重注入：documentStart user script 可能错过（页面已加载），
                // 这里再设一次 bridge.server/token + localStorage（apiClient 读得到）
                self.reinjectServer()
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation?, withError error: Error) {
            // 忽略 -999（页面重载/导航取消）
            if (error as NSError).code == NSURLErrorCancelled { return }
            WebShellView.appendNativeLog("[WebShell] didFail: \(error.localizedDescription)")
        }

        /// 递归移除 WKWebView 内部菜单交互（UIEditMenuInteraction / UIContextMenuInteraction）：
        /// iOS 16+ 文本选区编辑菜单（含“拷贝高亮标记的链接”）由 UIEditMenuInteraction 呈现，
        /// WebKit 未提供禁用 API（bug 244149）；移除后选区/拖拽手柄不受影响，仅系统菜单不再弹出。
        private func stripSystemMenuInteractions(from view: UIView) {
            for sub in view.subviews {
                for interaction in sub.interactions {
                    if interaction is UIEditMenuInteraction || interaction is UIContextMenuInteraction {
                        sub.removeInteraction(interaction)
                    }
                }
                stripSystemMenuInteractions(from: sub)
            }
        }

        // MARK: 滑动翻页（UIPanGestureRecognizer → Web swipe 事件 → Reader 翻页）

        @objc func onPanSwipe(_ g: UIPanGestureRecognizer) {
            guard g.state == .ended, let webView else { return }
            let v = g.velocity(in: webView)
            let t = g.translation(in: webView)
            guard abs(v.x) > abs(v.y) else { return }  // 水平主导才翻页（垂直留给滚动）
            // 慢速拖动：位移足够也翻；快速轻扫：速度达标即翻（UISwipe 只认快速滑动 → 迟钝）
            if abs(t.x) > 40 || abs(v.x) > 250 {
                pushToWeb(event: "swipe", payload: ["dir": v.x > 0 ? "right" : "left"])
            }
        }

        // UIGestureRecognizerDelegate：水平主方向的拖动才接管（垂直滚动、慢速拖选不受影响）
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard let pan = gestureRecognizer as? UIPanGestureRecognizer, let webView else { return true }
            let v = pan.velocity(in: webView)
            return abs(v.x) > abs(v.y)
        }

        // MARK: Native → Web 事件

        /// 就绪后统一冲刷排队事件；并补发当前生命周期状态（Web 适配层一就绪即知，不用等变化）
        private func flushPendingEvents() {
            for (name, payload) in pendingEvents {
                pushToWeb(event: name, payload: payload)
            }
            pendingEvents.removeAll()
            pushToWeb(event: "appState", payload: ["state": ScenePhaseStore.current])
        }

        func pushToWeb(event: String, payload: [String: Any]) {
            guard let webView else { return }
            let call = "window.qqplayerOnNativeEvent && window.qqplayerOnNativeEvent(\(WebShellView.jsonLiteral(event)), \(WebShellView.jsonLiteral(payload)))"
            if webReady {
                webView.evaluateJavaScript(call) { _, error in
                    if let error {
                        WebShellView.appendNativeLog("[WebShell] push \(event) 失败: \(error.localizedDescription)")
                    }
                }
            } else {
                pendingEvents.append((event, payload))
            }
        }

        /// 锁屏/线控命令上报桌面后端（/api/debuglog；不依赖 WebView，后台锁屏也能到达）。
        /// fire-and-forget：失败静默（内网开发端点，不影响播放）。
        private func reportNativeCmd(_ cmd: String, _ t: Double?) {
            var base = server.url
            if base.hasSuffix("/") { base.removeLast() }
            guard let url = URL(string: base + "/api/debuglog") else { return }
            var req = URLRequest(url: url)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !server.token.isEmpty {
                req.setValue("Bearer \(server.token)", forHTTPHeaderField: "Authorization")
            }
            let line = "native remoteCmd \(cmd)" + (t.map { " t=\($0)" } ?? "")
            req.httpBody = try? JSONSerialization.data(withJSONObject: ["line": line])
            URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
        }
    }

    /// 诊断日志（追加写 Documents/meta/nativecmd.log；模拟器沙盒直读，真机连 Mac 可读）。
    /// 与前端 debuglog.json（dbgLog → nativeMetaSave）互补：nativecmd.log 记原生侧决策/桥消息。
    static func appendNativeLog(_ line: String) {
        guard let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("meta", isDirectory: true) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("nativecmd.log")
        let ts = ISO8601DateFormatter().string(from: Date())
        if let h = try? FileHandle(forWritingTo: url) {
            h.seekToEndOfFile()
            h.write(Data("\(ts) \(line)\n".utf8))
            try? h.close()
        } else {
            try? Data("\(ts) \(line)\n".utf8).write(to: url)
        }
    }

    /// JSON 字面量编码（注入 evaluateJavaScript / 用户脚本安全）
    static func jsonLiteral(_ value: Any) -> String {
        // 字符串：手动 JSON 转义。NSJSONSerialization 对顶层 String 不支持（isValidJSONObject=false，
        // data(withJSONObject:) 还会抛 NSException——try? 拦不住），必须绕过。
        if let s = value as? String {
            var out = "\""
            for c in s.unicodeScalars {
                switch c {
                case "\"": out += "\\\""
                case "\\": out += "\\\\"
                case "\n": out += "\\n"
                case "\r": out += "\\r"
                case "\t": out += "\\t"
                default:
                    // \u2028/\u2029 是 JS 行终止符，不转义会让 evaluateJavaScript 语法错误
                    if c.value < 0x20 || c.value == 0x2028 || c.value == 0x2029 {
                        out += String(format: "\\u%04x", c.value)
                    } else {
                        out.unicodeScalars.append(c)
                    }
                }
            }
            out += "\""
            return out
        }
        // 其余（数组/字典/数字/布尔）：NSJSONSerialization 序列化，NaN/Infinity 先净化
        // （NSJSONSerialization 遇到 NaN 同样抛 NSException，try? 拦不住，必须提前替换）
        func sanitize(_ v: Any) -> Any {
            if let n = v as? NSNumber {
                let d = n.doubleValue
                if d.isNaN || d.isInfinite { return NSNull() }
                return n
            }
            if let dict = v as? [String: Any] {
                return dict.mapValues { sanitize($0) }
            }
            if let arr = v as? [Any] {
                return arr.map { sanitize($0) }
            }
            return v
        }
        let safe = sanitize(value)
        guard let data = try? JSONSerialization.data(withJSONObject: safe),
              let str = String(data: data, encoding: .utf8)
        else {
            return "null"
        }
        return str
    }
}

// MARK: - Coordinator 桥消息分域（Pass 2 结构拆分：userContentController 按域路由，纯搬移）

// MARK: 桥消息分域 · 生命周期/UI（nativeReady / nativeLog / pullRevealStatusBar）

extension WebShellView.Coordinator {
    /// 生命周期/UI 域：nativeReady（适配层就绪）、nativeLog（前端诊断日志）、
    /// pullRevealStatusBar（顶部状态条浮层）
    private func handleUILifecycleCommand(_ cmd: String, body: [String: Any]) {
        switch cmd {
        case "nativeReady":
            webReady = true
            flushPendingEvents()
        case "nativeLog":
            // 前端诊断日志转发（nativecmd.log 追加；排故用）
            if let line = body["line"] as? String {
                WebShellView.appendNativeLog("web: \(line)")
            }
        default:
            // pullRevealStatusBar：前端页面顶部下拉 → 召唤顶部状态条浮层（平时隐藏，3s 后自动收回）
            NotificationCenter.default.post(name: .qqplayerPullRevealStatusBar, object: nil)
        }
    }
}

// MARK: 桥消息分域 · 同步/资产（syncDownload / hasAsset / cancelDownloads / deleteAssets / assetsSize / assetIndex / setWifiOnly）

extension WebShellView.Coordinator {
    /// 同步/资产域：批量下载、本地资产查询/删除/占用、取消下载
    private func handleSyncCommand(_ cmd: String, body: [String: Any]) {
        switch cmd {
        case "syncDownload":
            // 批量下载资产：{url, path, sha256, size?}[]（path 为沙盒相对路径）
            guard let items = body["items"] as? [[String: Any]] else { break }
            var requests: [DownloadManager.Request] = []
            for it in items {
                guard let urlString = it["url"] as? String,
                      let url = URL(string: urlString),
                      url.scheme == "http" || url.scheme == "https",
                      let path = it["path"] as? String,
                      let sha256 = it["sha256"] as? String,
                      DownloadManager.isSafePath(path)
                else { continue }
                let size = (it["size"] as? NSNumber)?.int64Value
                // wifiOnly：前端每次请求带当前开关状态；未带 → nil（落回 DownloadManager 当前开关）
                let wifiOnly = it["wifiOnly"] as? Bool
                requests.append(DownloadManager.Request(url: url, path: path, sha256: sha256, size: size, wifiOnly: wifiOnly))
            }
            downloadManager.enqueue(requests)
        case "hasAsset":
            // 查本地资产：回传 assetStatus {requestId, path, exists, localURL}
            if let path = body["path"] as? String,
               let requestId = body["requestId"] as? String,
               DownloadManager.isSafePath(path) {
                pendingAssetStatus[path, default: []].append(requestId)
                downloadManager.checkAsset(path: path)
            }
        case "cancelDownloads":
            downloadManager.cancelAll()
        case "deleteAssets":
            // 删除本地资产：{paths: ["audio/xx.m4a", ...]} 精确删除（孤儿清理）
            // 或 {scope: "all"|"audio"|"books"|"dicts"} 整类删除；
            // 完成后回推 assetsDeleted（paths/scope 原样回显，便于前端对账）
            if let paths = body["paths"] as? [String] {
                downloadManager.deleteAssets(paths: paths) { [weak self] in
                    self?.pushToWeb(event: "assetsDeleted", payload: ["paths": paths])
                }
            } else if let scope = body["scope"] as? String {
                downloadManager.deleteAssets(scope: scope) { [weak self] in
                    self?.pushToWeb(event: "assetsDeleted", payload: ["scope": scope])
                }
            }
        case "assetIndex":
            // 全部已下载资产索引（sha256 对比做"可更新"检测）→ 回推 assetIndex {assets: [{path, sha256, size}]}
            pushToWeb(event: "assetIndex", payload: ["assets": downloadManager.assetIndex()])
        case "setWifiOnly":
            // 仅 Wi-Fi 下载开关（fire-and-forget，无回执）
            if let on = body["on"] as? Bool {
                downloadManager.setWifiOnly(on)
            }
        default:
            // assetsSize：本地资产占用 → 回推 assetsSize {total, byType}（字节，Int64 → JS number）
            let info = downloadManager.assetsSizeByType()
            var payload: [String: Any] = ["total": info.total]
            payload["byType"] = info.byType
            pushToWeb(event: "assetsSize", payload: payload)
        }
    }
}

// MARK: 桥消息分域 · 元数据（metaSave / metaLoad）

extension WebShellView.Coordinator {
    /// 元数据域：Documents/meta/{kind}.json 兜底写/读（前端 IndexedDB 失效兑底）
    private func handleMetaCommand(_ cmd: String, body: [String: Any]) {
        switch cmd {
        case "metaSave":
            // 元数据文件兜底写：{kind, json} → Documents/meta/{kind}.json 原子写
            // （fire-and-forget；失败静默，前端不依赖回执）
            if let kind = body["kind"] as? String,
               let json = body["json"] as? String {
                MetaStore.save(kind: kind, json: json)
            }
        default:
            // metaLoad：元数据文件兜底读：{kind, requestId} → 回推 metaLoaded {requestId, kind, json?}
            // （文件缺失/损坏 → 无 json 字段；前端 8s 超时兜底）
            if let kind = body["kind"] as? String,
               let requestId = body["requestId"] as? String {
                pendingMetaLoads[requestId] = kind
                let json = MetaStore.load(kind: kind)
                pendingMetaLoads.removeValue(forKey: requestId)
                var payload: [String: Any] = ["requestId": requestId, "kind": kind]
                if let json {
                    payload["json"] = json
                }
                pushToWeb(event: "metaLoaded", payload: payload)
            }
        }
    }
}

// MARK: 桥消息分域 · 配对/鉴权（unauthorized）

extension WebShellView.Coordinator {
    /// 配对/鉴权域：401 → token 失效 → 清 Keychain 配对 → 回发现页重新配对
    private func handlePairingCommand(_ cmd: String) {
        guard cmd == "unauthorized" else { return }
        DispatchQueue.main.async {
            NotificationCenter.default.post(
                name: .qqplayerTokenInvalid,
                object: nil,
                userInfo: ["serverId": self.server.serverId]
            )
        }
    }
}

// MARK: 桥消息分域 · 播放（playAudio + 播放命令透传）

extension WebShellView.Coordinator {
    /// 播放域：playAudio（词典短音频原生播放）+ 其余播放命令透传 AVPlayerBridge
    /// （load/play/pause/seek/setVolume/setRate/setMetadata/setPlaying/setQueue；
    /// 未知命令静默忽略——桌面壳消息如 pickLibrary/lyric 等也走这里）
    private func handlePlaybackCommand(_ cmd: String, body: [String: Any]) {
        if cmd == "playAudio" {
            // 词典发音等短音频：原生 AVPlayer 直接播放（不弹系统播放器 UI）
            if let urlString = body["url"] as? String, let url = URL(string: urlString),
               url.scheme == "http" || url.scheme == "https" {
                playerBridge.playAudioFile(url)
            }
            return
        }
        // 诊断日志：Web 命令到达原生（load/play/pause/seek/setMetadata…），
        // 与 remoteCmd 对照：锁屏命令是否穿透 WebView 到达播放器（后台 JS 挂起时这里会缺失）
        if cmd == "load" || cmd == "play" || cmd == "pause" || cmd == "seek" {
            WebShellView.appendNativeLog("webCmd \(cmd)")
            reportNativeCmd(cmd, nil)
        }
        playerBridge.handleCommand(cmd, payload: body)
    }
}

extension Notification.Name {
    static let qqplayerTokenInvalid = Notification.Name("qqplayerTokenInvalid")
    static let qqplayerScenePhase = Notification.Name("qqplayerScenePhase")
    static let qqplayerPullRevealStatusBar = Notification.Name("qqplayerPullRevealStatusBar")
}
