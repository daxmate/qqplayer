// QQPlayer 桌面歌词悬浮窗（Swift 原生壳）
// NSPanel：无边框 / 透明 / 置顶 / 不占 Dock / 可拖动 / 双击关闭
// WKWebView 加载 localhost:17627/desktop-lyric（歌词 UI 全走 Web 页）
// URL scheme: qqplayerlyric:// 调起本 app
//
// 编译: swiftc main.swift -o QQPlayerLyric -framework Cocoa -framework WebKit
//   （build.sh 负责完整打包 .app）

import Cocoa
import WebKit

// ============ 歌词悬浮窗面板 ============
final class LyricPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// ============ App 入口 ============
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: LyricPanel!
    var webView: WKWebView!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 透明无边框置顶面板
        window = LyricPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 140),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .floating        // 置顶
        window.isMovableByWindowBackground = true  // 拖动
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        // 双击关闭
        window.isReleasedWhenClosed = false
        let doubleClick = NSClickGestureRecognizer(target: self, action: #selector(onDoubleClick(_:)))
        doubleClick.numberOfClicksRequired = 2
        window.contentView?.addGestureRecognizer(doubleClick)

        // WKWebView（透明背景）
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        config.userContentController = controller
        webView = WKWebView(frame: window.contentView!.bounds, configuration: config)
        webView.setValue(false, forKey: "drawsBackground") // 透明
        webView.autoresizingMask = [.width, .height]
        webView.allowsMagnification = false
        window.contentView?.addSubview(webView)

        // 加载歌词页（后端 launchd 常驻 localhost:17627）
        if let url = URL(string: "http://localhost:17627/desktop-lyric.html") {
            webView.load(URLRequest(url: url))
        }

        // 放右上角附近，避免挡内容
        if let screen = NSScreen.main {
            let vf = screen.visibleFrame
            let size = window.frame.size
            window.setFrameOrigin(NSPoint(x: vf.maxX - size.width - 40, y: vf.maxY - size.height - 60))
        }
        window.orderFrontRegardless()
    }

    @objc func onDoubleClick(_ sender: Any?) {
        NSApp.terminate(nil)
    }

    // 网页端可调用 window.webkit.messageHandlers.native.postMessage("close") 关闭
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? String, body == "close" {
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // URL scheme 调起处理（qqplayerlyric://open）：应用已在运行则激活窗口
    func application(_ application: NSApplication, open urls: [URL]) {
        window?.orderFrontRegardless()
    }
}

// ============ 入口 ============
let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory) // 不占 Dock
app.run()
