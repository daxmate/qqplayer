// QQPlayer 迷你窗（Swift 原生壳）
// NSPanel：无边框 / 置顶 / 不占 Dock / 可拖动 / 双击拖动条关闭
// 结构：顶部 24px 拖动条（拖动 + 双击关闭），下方 WKWebView 正常交互（播放控制按钮）
// WKWebView 加载 localhost:17627/mini.html（封面 + 控制条，UI 全走 Web 页）
// URL scheme: qqplayermini:// 调起本 app
//
// 编译: swiftc main.swift -o QQPlayerMini -framework Cocoa -framework WebKit
//   （build.sh 负责完整打包 .app）

import Cocoa
import WebKit

// ============ 迷你窗面板 ============
final class MiniPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// 顶部拖动条：鼠标事件自己处理（拖动窗口 / 双击退出），不挡下方 WebView 交互
final class DragBarView: NSView {
    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            NSApp.terminate(nil)
            return
        }
        window?.performDrag(with: event)
    }
    override func mouseDragged(with event: NSEvent) {
        // performDrag 内部处理
    }
}

// ============ App 入口 ============
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    var window: MiniPanel!
    var webView: WKWebView!

    // 向后端上报迷你窗运行状态（主播放器顶栏开关轮询点亮/熄灭）
    // 退出时同步等待请求发出（进程即将结束，异步可能来不及）
    func reportStatus(_ running: Bool) {
        guard let url = URL(string: "http://localhost:17627/api/mini/status") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["running": running])
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 1.5)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 透明无边框置顶面板
        window = MiniPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 140),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .floating        // 置顶
        window.isMovableByWindowBackground = true  // 空白区拖动兜底
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false

        // 顶部拖动条（24px，圆角面板视觉上盖在内容区上方）
        let dragBar = DragBarView(frame: NSRect(x: 0, y: 140 - 24, width: 380, height: 24))
        dragBar.autoresizingMask = [.width, .minYMargin]
        window.contentView?.addSubview(dragBar)

        // WKWebView（透明背景；迷你窗需要点击控制按钮，事件直接透给网页）
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        config.userContentController = controller
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 380, height: 140 - 24), configuration: config)
        webView.setValue(false, forKey: "drawsBackground") // 透明
        webView.autoresizingMask = [.width, .height]
        webView.allowsMagnification = false
        window.contentView?.addSubview(webView, positioned: .below, relativeTo: dragBar)

        // 加载迷你页（后端 launchd 常驻 localhost:17627）
        if let url = URL(string: "http://localhost:17627/mini.html") {
            webView.load(URLRequest(url: url))
        }

        // 放右下角附近
        if let screen = NSScreen.main {
            let vf = screen.visibleFrame
            let size = window.frame.size
            window.setFrameOrigin(NSPoint(x: vf.maxX - size.width - 30, y: vf.minY + 30))
        }
        window.orderFrontRegardless()
        reportStatus(true) // 通知主播放器：迷你窗已运行，顶栏开关点亮
    }

    // 网页端消息：
    //   postMessage("close") 或 {type:"close"} → 退出；
    //   {type:"resize", width, height} → 调整窗口大小（左下角锚定，向上向右延伸）
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
                // 左下角不动（迷你窗贴屏幕底边），只改宽高
                let origin = window.frame.origin
                let newFrame = NSRect(x: origin.x, y: origin.y, width: max(280, min(900, w)), height: max(80, min(400, h)))
                window.setFrame(newFrame, display: true, animate: true)
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        reportStatus(false)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    // URL scheme 调起处理（qqplayermini://open）：应用已在运行则激活窗口
    func application(_ application: NSApplication, open urls: [URL]) {
        window?.orderFrontRegardless()
    }
}

// ============ App 入口 ============
var gDelegate: AppDelegate?

let app = NSApplication.shared
let delegate = AppDelegate()
gDelegate = delegate
app.delegate = delegate
app.setActivationPolicy(.accessory) // 不占 Dock

// 拦截 SIGTERM/SIGINT（pkill / 系统关机等场景）：先上报迷你窗退出状态再退出。
// 注意：SIGTERM 直接终止进程不会走 applicationWillTerminate，必须在这里兜底。
// 实现：C signal handler 只做 async-signal-safe 的事（写标记文件），
// 主线程 Timer 检测到标记后优雅退出（网络请求不能在信号 handler 里做）。
// （DispatchSourceSignal 在本环境实测不触发 handler，故不用）
let EXIT_FLAG = "/tmp/qqplayer-mini-exit.flag"

func installExitFlagHandler() {
    signal(SIGTERM) { _ in
        let fd = open(EXIT_FLAG, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        if fd >= 0 { close(fd) }
    }
    signal(SIGINT) { _ in
        let fd = open(EXIT_FLAG, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        if fd >= 0 { close(fd) }
    }
}
installExitFlagHandler()

// 主线程轮询标记：检测到退出信号 → 上报状态 → 退出
Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: EXIT_FLAG) {
        try? FileManager.default.removeItem(atPath: EXIT_FLAG)
        gDelegate?.reportStatus(false)
        exit(0)
    }
}

app.run()
