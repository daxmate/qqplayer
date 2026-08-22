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
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.preferences.setValue(true, forKey: "allowUniversalAccessFromFileURLs")
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController = controller.userContentController
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = controller
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.bounces = false
        controller.webView = webView
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

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        let server: PairingRecord
        let playerBridge = AVPlayerBridge()
        var loadedServerId: String
        var webView: WKWebView?
        private var webReady = false

        /// 排队待 Web 的事件（nativeReady 前不推，防事件早于适配层安装）
        private var pendingEvents: [(String, [String: Any])] = []

        let userContentController: WKUserContentController

        init(server: PairingRecord) {
            self.server = server
            self.loadedServerId = server.serverId
            userContentController = WKUserContentController()
            super.init()
            userContentController.add(self, name: "qqplayerIos")
            installUserScripts()
            playerBridge.onEvent = { [weak self] name, payload in
                self?.pushToWeb(event: name, payload: payload)
            }
            playerBridge.onRemoteCommand = { [weak self] cmd, t in
                var payload: [String: Any] = ["cmd": cmd]
                if let t { payload["t"] = t }
                self?.pushToWeb(event: "remoteCommand", payload: payload)
            }
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
                  postMessage: function(msg) {
                    try { window.webkit.messageHandlers.qqplayerIos.postMessage(msg); } catch (e) {}
                  }
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

        // MARK: 加载

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
            let index = www.appendingPathComponent("index.html")
            webView.loadFileURL(index, allowingReadAccessTo: www)
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
            switch cmd {
            case "nativeReady":
                webReady = true
                for (name, payload) in pendingEvents {
                    pushToWeb(event: name, payload: payload)
                }
                pendingEvents.removeAll()
            case "unauthorized":
                // 401：token 失效 → 清 Keychain 配对 → 回发现页重新配对
                DispatchQueue.main.async {
                    NotificationCenter.default.post(
                        name: .qqplayerTokenInvalid,
                        object: nil,
                        userInfo: ["serverId": self.server.serverId]
                    )
                }
            default:
                playerBridge.handleCommand(cmd, payload: body)
            }
        }

        // MARK: WKNavigationDelegate

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            // 页面就绪：确保适配层已挂（模块脚本加载完成后）；重复调用幂等
            webView.evaluateJavaScript("typeof window.qqplayerOnNativeEvent === 'function'") { [weak self] result, _ in
                guard let self, let ok = result as? Bool, ok else { return }
                if !self.webReady {
                    self.webReady = true
                    for (name, payload) in self.pendingEvents {
                        self.pushToWeb(event: name, payload: payload)
                    }
                    self.pendingEvents.removeAll()
                }
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            // 忽略 -999（页面重载/导航取消）
            if (error as NSError).code == NSURLErrorCancelled { return }
            print("[WebShell] didFail: \(error.localizedDescription)")
        }

        // MARK: Native → Web 事件

        func pushToWeb(event: String, payload: [String: Any]) {
            guard let webView else { return }
            let call = "window.qqplayerOnNativeEvent && window.qqplayerOnNativeEvent(\(WebShellView.jsonLiteral(event)), \(WebShellView.jsonLiteral(payload)))"
            if webReady {
                webView.evaluateJavaScript(call) { _, error in
                    if let error {
                        print("[WebShell] push \(event) 失败: \(error.localizedDescription)")
                    }
                }
            } else {
                pendingEvents.append((event, payload))
            }
        }
    }

    /// JSON 字面量编码（注入 evaluateJavaScript / 用户脚本安全）
    static func jsonLiteral(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              let str = String(data: data, encoding: .utf8)
        else {
            return "null"
        }
        return str
    }
}

extension Notification.Name {
    static let qqplayerTokenInvalid = Notification.Name("qqplayerTokenInvalid")
}
