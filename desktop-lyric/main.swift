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

// 纯显示 WebView：不拦截鼠标事件（hitTest 返回 nil），
// 让窗口的 isMovableByWindowBackground 拖动 + 双击关闭手势能收到事件。
// 歌词页无需网页交互（不选词/不右键），窗口事件优先。
final class LyricWebView: WKWebView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        return nil
    }
}

// 鼠标事件覆盖层：盖在 WebView 最上层，吃掉所有鼠标事件
// - 拖动：mouseDown 时调 window.performDrag（比 isMovableByWindowBackground 更底层、更稳）
// - 双击：clickCount == 2 → 退出 app
// 歌词页是纯显示页面，网页交互不需要，鼠标事件全部由本层处理
final class DragOverlayView: NSView {
    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            NSApp.terminate(nil)
            return
        }
        window?.performDrag(with: event)
    }
    override func mouseDragged(with event: NSEvent) {
        // performDrag 内部处理，这里无需额外动作
    }
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
        window.isMovableByWindowBackground = true  // 拖动（覆盖层走 performDrag，此属性兜底）
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        // 双击关闭（覆盖层 mouseDown 处理 clickCount==2，此处手势兜底）
        window.isReleasedWhenClosed = false
        let doubleClick = NSClickGestureRecognizer(target: self, action: #selector(onDoubleClick(_:)))
        doubleClick.numberOfClicksRequired = 2
        window.contentView?.addGestureRecognizer(doubleClick)

        // WKWebView（透明背景；纯显示，不拦截鼠标事件）
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        config.userContentController = controller
        webView = LyricWebView(frame: window.contentView!.bounds, configuration: config)
        webView.setValue(false, forKey: "drawsBackground") // 透明
        webView.autoresizingMask = [.width, .height]
        webView.allowsMagnification = false
        window.contentView?.addSubview(webView)

        // 鼠标覆盖层（盖在 webView 上，处理拖动/双击）
        let overlay = DragOverlayView(frame: window.contentView!.bounds)
        overlay.autoresizingMask = [.width, .height]
        window.contentView?.addSubview(overlay, positioned: .above, relativeTo: webView)

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

    // 网页端消息：
    //   postMessage("close") 或 {type:"close"} → 退出；
    //   {type:"resize", width, height} → 调整窗口大小（左上角锚定，右下角延伸）
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if let body = message.body as? String, body == "close" {
            NSApp.terminate(nil)
            return
        }
        if let dict = message.body as? [String: Any], let type = dict["type"] as? String {
            if type == "close" {
                NSApp.terminate(nil)
            } else if type == "resize",
                      let w = dict["width"] as? Double,
                      let h = dict["height"] as? Double {
                // 左上角不动，只改右下角（窗口悬浮在屏幕角落，改大时向下向右延伸）
                let origin = window.frame.origin
                let newFrame = NSRect(x: origin.x, y: origin.y, width: max(200, min(1200, w)), height: max(60, min(600, h)))
                window.setFrame(newFrame, display: true, animate: true)
            }
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
