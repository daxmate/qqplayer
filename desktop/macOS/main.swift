// QQPlayer.app 三合一壳：主窗口 + 迷你窗 + 桌面歌词（同进程三窗口）
//   - 主窗口：NSWindow 标准窗口（Dock 常规 app），WKWebView 加载 localhost:17627/
//   - 迷你窗：NSPanel 无边框/置顶/不抢焦点，WKWebView 加载 /mini.html（可交互）
//   - 桌面歌词：NSPanel 无边框/透明/置顶/不抢焦点，WKWebView 加载 /desktop-lyric.html（纯显示）
// 三窗口共用一个消息通道 "native"，壳内按 message.webView 区分来源路由
// 合并自 desktop-player / desktop-mini / desktop-lyric 三个独立壳
//
// URL schemes（一个 app 注册三个，外部调起都进同一进程）：
//   qqplayer://      → 显示主窗口
//   qqplayermini://  → 显示迷你窗
//   qqplayerlyric:// → 显示桌面歌词
//
// 编译: swiftc main.swift -o QQPlayer -framework Cocoa -framework WebKit -framework MediaPlayer
//   （build.sh 负责完整打包 .app）

import Cocoa
import MediaPlayer
import WebKit

let BACKEND_BASE = "http://localhost:17627"

// ============ 迷你窗面板（无边框 / 置顶 / 可聚焦） ============
final class MiniPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// 迷你窗顶部拖动条：鼠标事件自己处理（拖动窗口 / 双击关闭面板），不挡下方 WebView 交互
final class DragBarView: NSView {
    var onDoubleClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            onDoubleClick?()
            return
        }
        window?.performDrag(with: event)
    }
    override func mouseDragged(with event: NSEvent) {
        // performDrag 内部处理
    }
}

// ============ 桌面歌词面板（无边框 / 透明 / 置顶） ============
final class LyricPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

// 歌词纯显示 WebView：不拦截鼠标事件（hitTest 返回 nil），
// 让窗口 isMovableByWindowBackground 拖动 + 双击手势能收到事件（歌词页无需网页交互）
final class LyricWebView: WKWebView {
    override func hitTest(_ point: NSPoint) -> NSView? {
        return nil
    }
}

// 歌词鼠标覆盖层：盖在 WebView 最上层，吃掉所有鼠标事件（拖动 / 双击关闭面板）
final class DragOverlayView: NSView {
    var onDoubleClick: (() -> Void)?
    override func mouseDown(with event: NSEvent) {
        if event.clickCount >= 2 {
            onDoubleClick?()
            return
        }
        window?.performDrag(with: event)
    }
    override func mouseDragged(with event: NSEvent) {
        // performDrag 内部处理
    }
}

// ============ 主窗口 WebView：右键菜单扩展（阅读器 + 歌曲列表/侧边栏歌单） ============
// 阅读器（Reader.vue）激活且有选中文本时，在系统右键菜单顶部追加应用项：
//   查词 "xxx" / 高亮（黄绿蓝粉子菜单）/ 添加笔记… / 分隔线
// 其余情况：歌曲列表/侧边栏歌单右键（前端 mousedown 上报 ctxState）→ 注入播放/收藏/加歌单等应用项；
// 无上下文或上下文过期 → 原样保留系统菜单（迷你窗 / 歌词窗仍用普通 WKWebView，不受影响）。
// 菜单点击通过 evaluateJavaScript 调前端全局 API（window.__qqReaderMenu?.* / window.__qqCtxMenu?.*，失败静默）。
final class MainWebView: WKWebView {
    // 阅读器状态缓存：前端经 "native" 通道推送 { type: 'readerState', active, hasSelection, text, hasHighlight }
    static var readerActive = false
    static var readerHasSelection = false
    static var readerSelectedText = ""
    static var readerHasHighlight = false
    // 当前选区已有高亮的样式（"highlight" 底色 | "underline" 下划线 | nil 无高亮），驱动右键菜单「下划线」项标题
    static var readerHighlightStyle: String?

    // 歌曲列表/侧边栏歌单右键菜单上下文缓存：前端 mousedown(button===2) 时经 "native" 通道推送
    // { type: 'ctxState', kind: 'song'|'playlist'|nil, path, songIndex, playlistId, songName, isFav, hasPath, canGoArtist, canGoAlbum }
    // willOpenMenu 时按 kind 注入菜单项；kind 为 nil（空白区右键）或上下文过期 → 不注入，保留系统菜单
    static var ctxKind: String?
    static var ctxPath: String?
    static var ctxSongIndex = -1
    static var ctxPlaylistId: String?
    static var ctxSongName = ""
    static var ctxIsFav = false
    static var ctxHasPath = false
    static var ctxCanGoArtist = false
    static var ctxCanGoAlbum = false
    static var ctxTimestamp: TimeInterval = 0

    // 上下文保鲜窗口（秒）：超过视为过期，不注入自定义项（防右键后长时间未开菜单误用旧上下文）
    private static let ctxFreshWindow: TimeInterval = 10

    // 本地化：跟随系统语言（zh* → 中文，其余英文）；英文查词用 "Dictionary" 避免与系统 Look Up 混淆
    private static let isChinese: Bool = {
        if let lang = Locale.preferredLanguages.first, lang.lowercased().hasPrefix("zh") {
            return true
        }
        return false
    }()

    override func willOpenMenu(_ menu: NSMenu, with event: NSEvent) {
        super.willOpenMenu(menu, with: event)
        // 阅读器激活 → 阅读器菜单（原逻辑）；否则 → 歌曲列表/侧边栏歌单右键菜单（有新鲜上下文时注入）
        if MainWebView.readerActive {
            insertReaderMenuItems(into: menu, zh: MainWebView.isChinese)
            return
        }
        insertCtxMenuItems(into: menu)
    }

    // ---- 阅读器右键菜单（原逻辑，从 willOpenMenu 抽出保持可读性） ----
    // 仅阅读器激活时追加应用项（选区缓存为空也插入——系统右键自动选词瞬间前端 400ms 轮询
    // 可能还没上报，点击动作由前端从 DOM 实时读选区兜底，见 __qqReaderMenu）
    private func insertReaderMenuItems(into menu: NSMenu, zh: Bool) {
        // 查词 "xxx"（选中词截断 30 字符，超长加 …；选区缓存为空时仅显示固定标题）
        let text = MainWebView.readerSelectedText
        let truncated = text.isEmpty ? "" : (text.count > 30 ? String(text.prefix(30)) + "…" : text)
        let lookupTitle = zh ? (truncated.isEmpty ? "查词" : "查词 \"\(truncated)\"") : (truncated.isEmpty ? "Dictionary" : "Dictionary \"\(truncated)\"")
        let lookupItem = NSMenuItem(title: lookupTitle, action: #selector(lookupAction(_:)), keyEquivalent: "")
        lookupItem.target = self

        // 高亮/颜色（子菜单：五色圆点，颜色字符串存 representedObject；色值与前端 HIGHLIGHT_COLOR_HEX 一致）
        // 已有高亮（readerHasHighlight）→ 显示「颜色」子菜单改色（iBooks 行为）；无高亮 → 「高亮」新建
        let hasHL = MainWebView.readerHasHighlight
        let highlightItem = NSMenuItem(
            title: hasHL ? (zh ? "颜色" : "Color") : (zh ? "高亮" : "Highlight"),
            action: nil, keyEquivalent: "")
        let colorSubmenu = NSMenu()
        let colors: [(color: String, nsColor: NSColor)] = [
            ("yellow", NSColor(calibratedRed: 0.965, green: 0.827, blue: 0.176, alpha: 1)), // #f6d32d
            ("green", NSColor(calibratedRed: 0.482, green: 0.769, blue: 0.498, alpha: 1)), // #7bc47f
            ("blue", NSColor(calibratedRed: 0.392, green: 0.710, blue: 0.965, alpha: 1)), // #64b5f6
            ("pink", NSColor(calibratedRed: 0.949, green: 0.545, blue: 0.690, alpha: 1)), // #f28bb0
            ("purple", NSColor(calibratedRed: 0.702, green: 0.533, blue: 1.0, alpha: 1)), // #b388ff
        ]
        for c in colors {
            let item = NSMenuItem(
                title: "",
                action: hasHL ? #selector(recolorAction(_:)) : #selector(highlightAction(_:)),
                keyEquivalent: "")
            item.target = self
            item.representedObject = c.color
            item.image = MainWebView.colorDotImage(c.nsColor)
            item.toolTip = zh ? Self.colorNameZh(c.color) : c.color
            colorSubmenu.addItem(item)
        }
        highlightItem.submenu = colorSubmenu

        // 下划线（iBooks 语义：下划线也是高亮的一种，一个部分只能有一种标注）
        // 已有下划线 → 标题变「移除下划线」（点击走前端 toggle 矩阵 = 移除）；否则 → 「下划线」（点击 = 新建）
        let isUnderline = MainWebView.readerHighlightStyle == "underline"
        let underlineItem = NSMenuItem(
            title: isUnderline ? (zh ? "移除下划线" : "Remove Underline") : (zh ? "下划线" : "Underline"),
            action: #selector(underlineAction(_:)), keyEquivalent: "")
        underlineItem.target = self

        // 移除高亮（仅当选区已有高亮时显示；无高亮隐藏，避免误删）
        var removeItem: NSMenuItem?
        if MainWebView.readerHasHighlight {
            removeItem = NSMenuItem(title: zh ? "移除高亮" : "Remove Highlight", action: #selector(removeAction(_:)), keyEquivalent: "")
            removeItem?.target = self
        }

        // 书内搜索选中词
        let searchItem = NSMenuItem(title: zh ? "搜索" : "Search", action: #selector(searchAction(_:)), keyEquivalent: "")
        searchItem.target = self

        // 添加笔记…
        let noteItem = NSMenuItem(title: zh ? "添加笔记…" : "Add Note…", action: #selector(noteAction(_:)), keyEquivalent: "")
        noteItem.target = self

        // 按序插入：查词 / 高亮 / 下划线 / 移除高亮* / 搜索 / 笔记 / 分隔线（移除项条件显示）
        var idx = 0
        menu.insertItem(lookupItem, at: idx); idx += 1
        menu.insertItem(highlightItem, at: idx); idx += 1
        menu.insertItem(underlineItem, at: idx); idx += 1
        if let removeItem { menu.insertItem(removeItem, at: idx); idx += 1 }
        menu.insertItem(searchItem, at: idx); idx += 1
        menu.insertItem(noteItem, at: idx); idx += 1
        menu.insertItem(.separator(), at: idx)
    }

    // ---- 歌曲列表 / 侧边栏歌单右键菜单（前端 ctxState 驱动） ----
    // 歌曲行：播放 / 下一首播放 / 收藏(取消收藏) / 添加到歌单… / ─ / 编辑标签/刮削* / 移到废纸篓* / 进歌手* / 进专辑*
    // 歌单项：播放 / 重命名 / 删除（* 按 canGoArtist / canGoAlbum / hasPath 条件显示，同 ContextMenu.vue）
    private func insertCtxMenuItems(into menu: NSMenu) {
        // 无上下文（空白区右键）或上下文过期 → 不注入，保留系统菜单
        guard Date().timeIntervalSince1970 - MainWebView.ctxTimestamp <= MainWebView.ctxFreshWindow,
              let kind = MainWebView.ctxKind else { return }
        let zh = MainWebView.isChinese
        var idx = 0
        if kind == "song" {
            menu.insertItem(ctxItem(zh ? "播放" : "Play", #selector(ctxPlayAction(_:))), at: idx); idx += 1
            menu.insertItem(ctxItem(zh ? "下一首播放" : "Play Next", #selector(ctxPlayNextAction(_:))), at: idx); idx += 1
            let favTitle = MainWebView.ctxIsFav
                ? (zh ? "取消收藏" : "Unfavorite")
                : (zh ? "收藏" : "Favorite")
            menu.insertItem(ctxItem(favTitle, #selector(ctxToggleFavAction(_:))), at: idx); idx += 1
            menu.insertItem(ctxItem(zh ? "添加到歌单…" : "Add to Playlist…", #selector(ctxAddPlaylistAction(_:))), at: idx); idx += 1
            menu.insertItem(.separator(), at: idx); idx += 1
            if MainWebView.ctxHasPath {
                menu.insertItem(ctxItem(zh ? "编辑标签/刮削" : "Edit Tags", #selector(ctxEditTagsAction(_:))), at: idx); idx += 1
                menu.insertItem(ctxItem(zh ? "移到废纸篓" : "Move to Trash", #selector(ctxRemoveAction(_:))), at: idx); idx += 1
            }
            if MainWebView.ctxCanGoArtist {
                menu.insertItem(ctxItem(zh ? "进歌手" : "Go to Artist", #selector(ctxGoArtistAction(_:))), at: idx); idx += 1
            }
            if MainWebView.ctxCanGoAlbum {
                menu.insertItem(ctxItem(zh ? "进专辑" : "Go to Album", #selector(ctxGoAlbumAction(_:))), at: idx); idx += 1
            }
        } else if kind == "playlist" {
            menu.insertItem(ctxItem(zh ? "播放" : "Play", #selector(ctxPlayAction(_:))), at: idx); idx += 1
            menu.insertItem(ctxItem(zh ? "重命名" : "Rename", #selector(ctxRenameAction(_:))), at: idx); idx += 1
            menu.insertItem(ctxItem(zh ? "删除" : "Delete", #selector(ctxDeletePlaylistAction(_:))), at: idx); idx += 1
        }
    }

    /// 菜单项快捷构造（target 固定为 self，与阅读器菜单一致）
    private func ctxItem(_ title: String, _ action: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
        item.target = self
        return item
    }

    // ---- 歌曲列表/歌单菜单点击 → 前端 JS（optional chaining，调用失败静默） ----
    @objc private func ctxPlayAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.play()")
    }

    @objc private func ctxPlayNextAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.playNext()")
    }

    @objc private func ctxToggleFavAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.toggleFav()")
    }

    @objc private func ctxAddPlaylistAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.addPlaylist()")
    }

    @objc private func ctxRemoveAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.remove()")
    }

    @objc private func ctxEditTagsAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.editTags()")
    }

    @objc private func ctxGoArtistAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.goArtist()")
    }

    @objc private func ctxGoAlbumAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.goAlbum()")
    }

    @objc private func ctxRenameAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.rename()")
    }

    @objc private func ctxDeletePlaylistAction(_ sender: Any?) {
        callJS("window.__qqCtxMenu?.delete()")
    }

    // ---- 菜单点击 → 前端 JS（optional chaining，调用失败静默） ----
    @objc private func lookupAction(_ sender: Any?) {
        callJS("window.__qqReaderMenu?.lookup()")
    }

    @objc private func highlightAction(_ sender: Any?) {
        let color = (sender as? NSMenuItem)?.representedObject as? String ?? "yellow"
        callJS("window.__qqReaderMenu?.highlight('\(color)')")
    }

    @objc private func recolorAction(_ sender: Any?) {
        let color = (sender as? NSMenuItem)?.representedObject as? String ?? "yellow"
        callJS("window.__qqReaderMenu?.recolor('\(color)')")
    }

    @objc private func underlineAction(_ sender: Any?) {
        callJS("window.__qqReaderMenu?.underline()")
    }

    @objc private func removeAction(_ sender: Any?) {
        callJS("window.__qqReaderMenu?.remove()")
    }

    @objc private func searchAction(_ sender: Any?) {
        callJS("window.__qqReaderMenu?.search()")
    }

    @objc private func noteAction(_ sender: Any?) {
        callJS("window.__qqReaderMenu?.note()")
    }

    private func callJS(_ js: String) {
        // evaluateJavaScript 必须在主线程；菜单回调已在主线程，dispatch 兜底
        DispatchQueue.main.async { [weak self] in
            self?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // ---- 色块辅助 ----------------

    /// 画一个实心圆点（菜单色块），尺寸 14×14（含 1pt 内边距）
    private static func colorDotImage(_ color: NSColor, size: CGFloat = 14) -> NSImage {
        let img = NSImage(size: NSSize(width: size, height: size))
        img.lockFocus()
        color.setFill()
        NSBezierPath(ovalIn: NSRect(x: 1, y: 1, width: size - 2, height: size - 2)).fill()
        img.unlockFocus()
        return img
    }

    /// 颜色名（tooltip 悬停提示，避免纯色块不可读）
    private static func colorNameZh(_ color: String) -> String {
        switch color {
        case "yellow": return "黄"
        case "green": return "绿"
        case "blue": return "蓝"
        case "pink": return "粉"
        case "purple": return "紫"
        default: return color
        }
    }
}

// ============ 后端子进程生命周期（打包版自包含，DMG 分发用） ============
// 启动契约：先探测 localhost:17627（launchd 开发版）→ 有则直连、绝不 spawn；
// 无则拉起 Bundle 内 Contents/Resources/backend/qqplayer-backend（PyInstaller onedir）→
// 轮询 /api/settings 健康检查（0.5s 间隔，最多 15s）→ 就绪后才建窗口；
// 退出只 terminate 自己拉起的子进程（SIGTERM，2s 未退 SIGKILL），外部服务一概不碰。
enum BackendStartResult {
    case external        // 外部服务（launchd 开发版）在跑 → 直连
    case embedded        // 内置后端已拉起并通过健康检查
    case noEmbedded      // 无外部服务且 Bundle 内无内置后端（开发模式异常）
    case spawnFailed     // 内置后端启动失败（exec 错误）
    case timeout         // 内置后端 15s 内未就绪
}

final class BackendLauncher {
    private(set) var spawnedProcess: Process?
    private let probeURL = URL(string: "\(BACKEND_BASE)/api/settings")!

    // 探测外部服务：GET /api/settings，1.5s 超时；200 即认为在跑
    func probeExternal() -> Bool {
        let sem = DispatchSemaphore(value: 0)
        var alive = false
        var req = URLRequest(url: probeURL)
        req.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let r = resp as? HTTPURLResponse, r.statusCode == 200 { alive = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return alive
    }

    // Bundle 内内置后端路径：<Bundle.main.resourceURL>/backend/qqplayer-backend（动态获取，不硬编码绝对路径）
    func embeddedBackendURL() -> URL? {
        guard let res = Bundle.main.resourceURL else { return nil }
        let url = res.appendingPathComponent("backend/qqplayer-backend")
        return FileManager.default.isExecutableFile(atPath: url.path) ? url : nil
    }

    // 拉起内置后端：env 继承；stdout/stderr → ~/Library/Logs/qqplayer/pkg-backend.log（目录不存在先建）
    func launchEmbedded() -> Process? {
        guard let exe = embeddedBackendURL() else { return nil }
        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/qqplayer")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logPath = logDir.appendingPathComponent("pkg-backend.log")
        FileManager.default.createFile(atPath: logPath.path, contents: nil)
        guard let fh = FileHandle(forWritingAtPath: logPath.path) else { return nil }

        let p = Process()
        p.executableURL = exe
        p.currentDirectoryURL = exe.deletingLastPathComponent()
        p.standardOutput = fh
        p.standardError = fh
        do {
            try p.run()
        } catch {
            try? fh.close()
            return nil
        }
        spawnedProcess = p
        return p
    }

    // 健康检查：0.5s 间隔轮询 /api/settings，最多 timeout 秒
    func waitReady(timeout: TimeInterval = 15) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if probeExternal() { return true }
            Thread.sleep(forTimeInterval: 0.5)
        }
        return probeExternal()
    }

    // 启动编排：探测 → 有外部服务直连 / 无则 spawn 内置 + 健康检查
    func start() -> BackendStartResult {
        if probeExternal() { return .external }
        guard embeddedBackendURL() != nil else { return .noEmbedded }
        guard launchEmbedded() != nil else { return .spawnFailed }
        return waitReady() ? .embedded : .timeout
    }

    // 退出清理：只杀自己拉起的（spawnedProcess 非 nil 才动），外部服务绝不碰
    func terminateSpawned() {
        guard let p = spawnedProcess else { return }
        spawnedProcess = nil
        guard p.isRunning else { return }
        p.terminate() // SIGTERM
        // 2s 后仍未退出 → SIGKILL（同步等待，保证退出路径上能生效）
        let deadline = Date().addingTimeInterval(2)
        while p.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        if p.isRunning {
            kill(p.processIdentifier, SIGKILL)
        }
    }
}

// ============ App 入口 ============
final class AppDelegate: NSObject, NSApplicationDelegate, WKScriptMessageHandler, WKUIDelegate {
    // 三窗口
    var mainWindow: NSWindow!
    var mainWebView: WKWebView!
    var miniPanel: MiniPanel!
    var miniWebView: WKWebView!
    var lyricPanel: LyricPanel!
    var lyricWebView: WKWebView!

    // 迷你窗面板当前可见（同步后端 /api/mini/status，主页面顶栏开关轮询点亮）
    var miniVisible = false

    // 媒体键 / 控制中心
    var nowPlayingTimer: Timer?
    var lastNowPlayingPath: String?
    var lastNowPlayingKey = ""

    // ============ 后端子进程生命周期（打包版自包含） ============
    let backendLauncher = BackendLauncher()

    // 启动失败弹窗（含日志路径提示），点「退出」后终止 app
    func showBackendFailureAlert(_ result: BackendStartResult) {
        let logHint = "日志：~/Library/Logs/qqplayer/pkg-backend.log"
        let detail: String
        switch result {
        case .noEmbedded:
            detail = "本地服务（http://localhost:17627）未响应，且应用包内未找到内置后端（Contents/Resources/backend/qqplayer-backend）。\n请先启动开发版后端（launchd 服务），或使用带内置后端的打包版。"
        case .spawnFailed:
            detail = "本地服务未响应，且内置后端启动失败。\n\(logHint)"
        case .timeout:
            detail = "内置后端已拉起但 15 秒内未就绪。\n\(logHint)"
        case .external, .embedded:
            return
        }
        let alert = NSAlert()
        alert.messageText = "无法连接 QQPlayer 后端服务"
        alert.informativeText = detail + "\n\n应用即将退出。"
        alert.alertStyle = .critical
        alert.addButton(withTitle: "退出")
        alert.runModal()
    }

    // ============ 应用启动 ============
    func applicationDidFinishLaunching(_ notification: Notification) {
        // 后端启动时序：探测外部服务（launchd 开发版）→ 无则拉起 Bundle 内置后端 → 健康检查。
        // 全部在后台队列完成（探测 ≤2s + 健康检查 ≤15s），主线程不阻塞、app 不闪退；
        // 就绪后才建窗口/load URL（现有三窗口流程不变）；失败弹 NSAlert 后退出。
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            let result = self.backendLauncher.start()
            DispatchQueue.main.async {
                switch result {
                case .external, .embedded:
                    break
                case .noEmbedded, .spawnFailed, .timeout:
                    self.showBackendFailureAlert(result)
                    NSApp.terminate(nil)
                    return
                }
                self.setupMainWindow()
                self.setupMiniPanel()
                self.setupLyricPanel()

                self.setupMainMenu()
                self.setupRemoteCommands()
                self.startNowPlayingPoll()

                self.mainWindow.makeKeyAndOrderFront(nil)
                NSApp.activate(ignoringOtherApps: true)
            }
        }
    }

    // 加载页面：URL 附加时间戳绕过 WKWebView 磁盘缓存（WKWebView 不尊重 URLRequest.cachePolicy，
    // 页面更新后不强制刷新会一直用旧缓存——今天验证时 mini 面板就加载了旧版 html）
    func loadURL(_ urlString: String, into webView: WKWebView) {
        let sep = urlString.contains("?") ? "&" : "?"
        let v = Int(Date().timeIntervalSince1970)
        if let url = URL(string: "\(urlString)\(sep)v=\(v)") {
            webView.load(URLRequest(url: url))
        }
    }

    // ---- 主窗口 ----
    func setupMainWindow() {
        // 标准可缩放窗口 + 位置/大小记忆
        mainWindow = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        mainWindow.title = "QQPlayer 小千千"
        mainWindow.setFrameAutosaveName("QQPlayerMainWindow")
        mainWindow.isReleasedWhenClosed = false
        mainWindow.center()

        // WKWebView：允许自动播放（启动恢复上次播放）；注入原生环境标记
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        controller.addUserScript(
            WKUserScript(
                source: "window.qqplayerNative = true;",
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        // 诊断用：console 转发到壳日志文件（~/Library/Logs/qqplayer/webview-console.log）
        controller.addUserScript(
            WKUserScript(
                source: """
                (function() {
                  function send(level, args) {
                    try {
                      var parts = [];
                      for (var i = 0; i < args.length; i++) {
                        var a = args[i];
                        if (typeof a === 'string') parts.push(a);
                        else if (a instanceof Error) parts.push('Error: ' + a.message);
                        else { try { parts.push(JSON.stringify(a)); } catch (e) { parts.push(String(a)); } }
                      }
                      window.webkit.messageHandlers.native.postMessage({ type: 'qqlog', level: level, msg: parts.join(' ') });
                    } catch (e) {}
                  }
                  var origLog = console.log, origWarn = console.warn, origErr = console.error;
                  console.log = function() { send('log', arguments); origLog.apply(console, arguments); };
                  console.warn = function() { send('warn', arguments); origWarn.apply(console, arguments); };
                  console.error = function() { send('error', arguments); origErr.apply(console, arguments); };
                  window.addEventListener('error', function(e) {
                    send('error', ['PAGEERROR: ' + (e.message || '') + ' @ ' + (e.filename || '') + ':' + (e.lineno || '')]);
                  });
                  window.addEventListener('unhandledrejection', function(e) {
                    send('error', ['UNHANDLED: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason))]);
                  });
                })();
                """,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
        )
        config.userContentController = controller

        mainWebView = MainWebView(frame: mainWindow.contentView!.bounds, configuration: config)
        mainWebView.autoresizingMask = [.width, .height]
        mainWebView.allowsMagnification = false
        mainWebView.uiDelegate = self
        mainWindow.contentView?.addSubview(mainWebView)

        loadURL(BACKEND_BASE, into: mainWebView)
    }

    // ---- 迷你窗 ----
    func setupMiniPanel() {
        // 透明无边框置顶面板
        miniPanel = MiniPanel(
            contentRect: NSRect(x: 0, y: 0, width: 380, height: 140),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        miniPanel.isOpaque = false
        miniPanel.backgroundColor = .clear
        miniPanel.hasShadow = true
        miniPanel.level = .floating        // 置顶
        miniPanel.isMovableByWindowBackground = true  // 空白区拖动兜底
        miniPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        miniPanel.hidesOnDeactivate = false
        miniPanel.isReleasedWhenClosed = false

        // 顶部拖动条（24px，圆角面板视觉上盖在内容区上方）
        let dragBar = DragBarView(frame: NSRect(x: 0, y: 140 - 24, width: 380, height: 24))
        dragBar.autoresizingMask = [.width, .minYMargin]
        dragBar.onDoubleClick = { [weak self] in self?.hideMiniPanel() }
        miniPanel.contentView?.addSubview(dragBar)

        // WKWebView（透明背景；迷你窗需要点击控制按钮，事件直接透给网页）
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        config.userContentController = controller
        miniWebView = WKWebView(
            frame: NSRect(x: 0, y: 0, width: 380, height: 140 - 24),
            configuration: config
        )
        miniWebView.setValue(false, forKey: "drawsBackground") // 透明
        miniWebView.autoresizingMask = [.width, .height]
        miniWebView.allowsMagnification = false
        miniWebView.uiDelegate = self
        miniPanel.contentView?.addSubview(miniWebView, positioned: .below, relativeTo: dragBar)

        loadURL("\(BACKEND_BASE)/mini.html", into: miniWebView)

        // 初始放右下角附近（不显示，等调起）
        if let screen = NSScreen.main {
            let vf = screen.visibleFrame
            let size = miniPanel.frame.size
            miniPanel.setFrameOrigin(NSPoint(x: vf.maxX - size.width - 30, y: vf.minY + 30))
        }
    }

    // ---- 桌面歌词 ----
    func setupLyricPanel() {
        // 透明无边框置顶面板
        lyricPanel = LyricPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 140),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        lyricPanel.isOpaque = false
        lyricPanel.backgroundColor = .clear
        lyricPanel.hasShadow = true
        lyricPanel.level = .floating        // 置顶
        lyricPanel.isMovableByWindowBackground = true  // 拖动（覆盖层走 performDrag，此属性兜底）
        lyricPanel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        lyricPanel.hidesOnDeactivate = false
        lyricPanel.isReleasedWhenClosed = false
        let doubleClick = NSClickGestureRecognizer(target: self, action: #selector(onLyricDoubleClick(_:)))
        doubleClick.numberOfClicksRequired = 2
        lyricPanel.contentView?.addGestureRecognizer(doubleClick)

        // WKWebView（透明背景；纯显示，不拦截鼠标事件）
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        controller.add(self, name: "native")
        config.userContentController = controller
        lyricWebView = LyricWebView(frame: lyricPanel.contentView!.bounds, configuration: config)
        lyricWebView.setValue(false, forKey: "drawsBackground") // 透明
        lyricWebView.autoresizingMask = [.width, .height]
        lyricWebView.allowsMagnification = false
        lyricWebView.uiDelegate = self
        lyricPanel.contentView?.addSubview(lyricWebView)

        // 鼠标覆盖层（盖在 webView 上，处理拖动/双击）
        let overlay = DragOverlayView(frame: lyricPanel.contentView!.bounds)
        overlay.autoresizingMask = [.width, .height]
        overlay.onDoubleClick = { [weak self] in self?.hideLyricPanel() }
        lyricPanel.contentView?.addSubview(overlay, positioned: .above, relativeTo: lyricWebView)

        loadURL("\(BACKEND_BASE)/desktop-lyric.html", into: lyricWebView)

        // 初始放右上角附近（不显示，等调起）
        if let screen = NSScreen.main {
            let vf = screen.visibleFrame
            let size = lyricPanel.frame.size
            lyricPanel.setFrameOrigin(NSPoint(x: vf.maxX - size.width - 40, y: vf.maxY - size.height - 60))
        }
    }

    @objc func onLyricDoubleClick(_ sender: Any?) {
        hideLyricPanel()
    }

    // ============ 窗口互切 ============
    func showMainWindow() {
        mainWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        // 互斥守卫：主窗口被任何路径调起（Dock 点击/URL scheme/restore）时隐藏迷你窗，
        // 保证 main/mini 任意时刻只显示一个（对齐 Windows 壳 on_window_event Focused 守卫；
        // hideMiniPanel 幂等，closeMini 路径重复调用无副作用）
        hideMiniPanel()
    }

    func showMiniPanel() {
        miniPanel?.orderFrontRegardless()
        reportMiniStatus(true)
    }

    func hideMiniPanel() {
        miniPanel?.orderOut(nil)
        reportMiniStatus(false)
    }

    func showLyricPanel() {
        lyricPanel?.orderFrontRegardless()
        notifyFrontendLyricState(true)
    }

    func hideLyricPanel() {
        lyricPanel?.orderOut(nil)
        notifyFrontendLyricState(false)
    }

    // ============ 迷你窗状态上报（主页面顶栏开关轮询点亮） ============
    func reportMiniStatus(_ running: Bool) {
        miniVisible = running
        reportMiniStatusSync(running)
    }

    func reportMiniStatusSync(_ running: Bool) {
        guard let url = URL(string: "\(BACKEND_BASE)/api/mini/status") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["running": running])
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { _, _, _ in sem.signal() }.resume()
        _ = sem.wait(timeout: .now() + 1.5)
    }

    // 歌词面板显示状态回写主页面（原生关闭 ✕/双击 后面板与设置开关保持同步）
    func notifyFrontendLyricState(_ enabled: Bool) {
        let js = "window.dispatchEvent(new CustomEvent('qqplayer:lyricstate', { detail: { enabled: \(enabled) } }))"
        DispatchQueue.main.async { [weak self] in
            self?.mainWebView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // 整窗拖动：网页按住非控件区域 → 壳内原生 performDrag（系统级拖窗体验）
    func performNativeDrag(for panel: NSPanel) {
        let loc = panel.mouseLocationOutsideOfEventStream
        if let ev = NSEvent.mouseEvent(
            with: .leftMouseDown,
            location: loc,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: panel.windowNumber,
            context: nil,
            eventNumber: 0,
            clickCount: 1,
            pressure: 1
        ) {
            panel.performDrag(with: ev)
        }
    }

    // ============ 菜单 ============
    func setupMainMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "关于 QQPlayer",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(.separator())
        appMenu.addItem(
            withTitle: "退出 QQPlayer",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "显示")
        viewMenu.addItem(
            withTitle: "刷新页面",
            action: #selector(reloadPage(_:)),
            keyEquivalent: "r"
        )
        viewItem.submenu = viewMenu

        let winItem = NSMenuItem()
        mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "窗口")
        winMenu.addItem(
            withTitle: "最小化",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        winMenu.addItem(
            withTitle: "关闭窗口",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
        winItem.submenu = winMenu

        NSApp.mainMenu = mainMenu
    }

    // 刷新页面：重新 loadURL（新时间戳绕过 WKWebView 磁盘缓存），主窗/迷你窗/歌词窗一起刷
    @objc func reloadPage(_ sender: Any?) {
        loadURL(BACKEND_BASE, into: mainWebView)
        if miniPanel != nil, miniWebView != nil {
            loadURL("\(BACKEND_BASE)/mini.html", into: miniWebView)
        }
        if lyricPanel != nil, lyricWebView != nil {
            loadURL("\(BACKEND_BASE)/desktop-lyric.html", into: lyricWebView)
        }
    }

    // ============ 媒体键桥：系统媒体键 → 指令队列（主页面轮询执行） ============
    func setupRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.isEnabled = true
        c.playCommand.addTarget { [weak self] _ in
            self?.sendAction("play"); return .success
        }
        c.pauseCommand.isEnabled = true
        c.pauseCommand.addTarget { [weak self] _ in
            self?.sendAction("pause"); return .success
        }
        c.togglePlayPauseCommand.isEnabled = true
        c.togglePlayPauseCommand.addTarget { [weak self] _ in
            self?.sendAction("togglePlay"); return .success
        }
        c.nextTrackCommand.isEnabled = true
        c.nextTrackCommand.addTarget { [weak self] _ in
            self?.sendAction("next"); return .success
        }
        c.previousTrackCommand.isEnabled = true
        c.previousTrackCommand.addTarget { [weak self] _ in
            self?.sendAction("prev"); return .success
        }
        c.changePlaybackPositionCommand.isEnabled = true
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            if let ev = e as? MPChangePlaybackPositionCommandEvent {
                self?.sendAction("seek", value: ev.positionTime)
            }
            return .success
        }
    }

    func sendAction(_ action: String, value: Double? = nil) {
        var body: [String: Any] = ["action": action]
        if let v = value { body["value"] = v }
        var req = URLRequest(url: URL(string: "\(BACKEND_BASE)/api/player/action")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: req).resume()
    }

    // ============ 控制中心信息：1s 轮询 now-playing ============
    func startNowPlayingPoll() {
        nowPlayingTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.refreshNowPlaying()
        }
    }

    func refreshNowPlaying() {
        var req = URLRequest(url: URL(string: "\(BACKEND_BASE)/api/now-playing")!)
        req.timeoutInterval = 2
        URLSession.shared.dataTask(with: req) { [weak self] data, _, _ in
            guard let self,
                  let data,
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let path = obj["path"] as? String,
                  !path.isEmpty else { return }
            let title = obj["name"] as? String ?? "未知歌曲"
            let artist = obj["artist"] as? String ?? "未知歌手"
            let duration = obj["duration"] as? Double ?? 0
            let currentTime = obj["currentTime"] as? Double ?? 0
            let playing = obj["isPlaying"] as? Bool ?? false
            let key = "\(path)|\(title)|\(artist)|\(duration)"
            var info: [String: Any] = [
                MPMediaItemPropertyTitle: title,
                MPMediaItemPropertyArtist: artist,
                MPMediaItemPropertyPlaybackDuration: duration,
                MPNowPlayingInfoPropertyElapsedPlaybackTime: currentTime,
                MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            ]
            if key != self.lastNowPlayingKey {
                self.lastNowPlayingKey = key
                self.loadCover(path: path) { img in
                    if let img {
                        let art = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                        info[MPMediaItemPropertyArtwork] = art
                    }
                    DispatchQueue.main.async {
                        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
                    }
                }
                return
            }
            // 同曲：只更新进度/播放状态（封面已设，不重复加载）
            DispatchQueue.main.async {
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }.resume()
    }

    func loadCover(path: String, completion: @escaping (NSImage?) -> Void) {
        guard let enc = path.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed),
              let url = URL(string: "\(BACKEND_BASE)/api/cover?path=\(enc)") else {
            completion(nil); return
        }
        URLSession.shared.dataTask(with: url) { data, _, _ in
            guard let data, let img = NSImage(data: data) else {
                completion(nil); return
            }
            completion(img)
        }.resume()
    }

    // ============ WKUIDelegate：网页 <input type="file"> → 原生 NSOpenPanel ============
    // WKWebView 默认不弹文件选择框——不实现 runOpenPanel 则壳内点文件选择按钮无反应
    // （图书导入 .epub / 歌词上传等所有 input[type=file] 都走这里）
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        // 不限制文件类型：前端按 accept/扩展名自行过滤（如 .epub），限制反而挡其它用途
        panel.begin { response in
            if response == .OK {
                completionHandler(panel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    // ============ 文件选择桥：NSOpenPanel 选文件夹 → POST /api/library ============
    func pickLibrary() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "选择音乐库"
        panel.message = "选择要扫描的歌曲文件夹"
        panel.begin { [weak self] resp in
            guard resp == .OK, let url = panel.url else { return }
            self?.setLibrary(path: url.path)
        }
    }

    func setLibrary(path: String) {
        var req = URLRequest(url: URL(string: "\(BACKEND_BASE)/api/library")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["path": path])
        URLSession.shared.dataTask(with: req) { [weak self] _, _, _ in
            self?.notifyFrontendLibraryChanged(path)
        }.resume()
    }

    // 通知前端：设置弹窗「歌曲库文件夹」输入框与 state 实时同步（不依赖下次打开）
    func notifyFrontendLibraryChanged(_ path: String) {
        guard let json = try? JSONSerialization.data(withJSONObject: [path]),
              let s = String(data: json, encoding: .utf8) else { return }
        let escaped = s.dropFirst().dropLast() // ["/path"] → "/path"（JSON 转义）
        let js = "window.dispatchEvent(new CustomEvent('qqplayer:nativelibrary', { detail: { path: \(escaped) } }))"
        DispatchQueue.main.async { [weak self] in
            self?.mainWebView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // ============ 词典文件多选桥：NSOpenPanel 多选文件 → 回传绝对路径数组（链接原路径模式） ============
    // 与 <input type="file"> 的 runOpenPanel 不同：网页 File API 拿不到真实路径，链接模式需原生回传
    func pickDictFiles() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        panel.message = "选择词典文件（.mdx/.mdd/.css 等，可多选）"
        // 不设 allowedFileTypes：沿用现有约定，前端按 accept/扩展名自行过滤
        panel.begin { [weak self] resp in
            let paths = resp == .OK ? panel.urls.map { $0.path } : []
            self?.notifyFrontendDictFiles(paths)
        }
    }

    // 通知前端：词典「链接原路径」导入的绝对路径数组（取消 → 空数组）
    // JS 构造逻辑已抽到 dict_events.swift 的 buildDictFilesEventJS（可单测）
    func notifyFrontendDictFiles(_ paths: [String]) {
        let js = buildDictFilesEventJS(paths)
        DispatchQueue.main.async { [weak self] in
            self?.mainWebView?.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // ============ 网页消息（三窗口共用 "native" 通道，按来源路由） ============
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.webView === mainWebView {
            handleMainMessage(message)
        } else if message.webView === miniWebView {
            handleMiniMessage(message)
        } else if message.webView === lyricWebView {
            handleLyricMessage(message)
        }
    }

    // 主窗口页面消息
    func handleMainMessage(_ message: WKScriptMessage) {
        if let body = message.body as? String, body == "pickLibrary" {
            pickLibrary()
            return
        }
        guard let dict = message.body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "readerState":
            // 阅读器状态缓存（前端 Reader.vue 推送，驱动右键菜单插入逻辑）
            let active = dict["active"] as? Bool ?? false
            // 图书模式：隐藏迷你窗/桌面歌词（前端入口同步隐藏，此处兜底防漏关）
            if active && !MainWebView.readerActive {
                hideMiniPanel()
                hideLyricPanel()
            }
            MainWebView.readerActive = active
            MainWebView.readerHasSelection = dict["hasSelection"] as? Bool ?? false
            MainWebView.readerSelectedText = dict["text"] as? String ?? ""
            MainWebView.readerHasHighlight = dict["hasHighlight"] as? Bool ?? false
            // 高亮样式（"highlight" | "underline" | nil），供右键菜单「下划线」项动态标题
            MainWebView.readerHighlightStyle = dict["highlightStyle"] as? String
        case "ctxState":
            // 歌曲列表/侧边栏歌单右键上下文缓存（前端 useNativeCtxMenu mousedown(button===2) 上报，
            // 驱动 willOpenMenu 注入菜单项）。kind 为 null（空白区右键）→ as? String 得 nil → 清空上下文，
            // willOpenMenu 不再注入自定义项，原样保留系统菜单。
            MainWebView.ctxKind = dict["kind"] as? String
            MainWebView.ctxPath = dict["path"] as? String
            MainWebView.ctxSongIndex = dict["songIndex"] as? Int ?? -1
            MainWebView.ctxPlaylistId = dict["playlistId"] as? String
            MainWebView.ctxSongName = dict["songName"] as? String ?? ""
            MainWebView.ctxIsFav = dict["isFav"] as? Bool ?? false
            MainWebView.ctxHasPath = dict["hasPath"] as? Bool ?? false
            MainWebView.ctxCanGoArtist = dict["canGoArtist"] as? Bool ?? false
            MainWebView.ctxCanGoAlbum = dict["canGoAlbum"] as? Bool ?? false
            MainWebView.ctxTimestamp = Date().timeIntervalSince1970
        case "qqlog":
            // 诊断：网页 console 落盘（~/Library/Logs/qqplayer/webview-console.log）
            let level = dict["level"] as? String ?? "log"
            let msg = dict["msg"] as? String ?? ""
            let logDir = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent("Library/Logs/qqplayer")
            try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
            let f = logDir.appendingPathComponent("webview-console.log")
            let line = "[\(level)] \(msg)\n"
            if let h = try? FileHandle(forWritingTo: f) {
                h.seekToEndOfFile()
                h.write(line.data(using: .utf8)!)
                try? h.close()
            } else {
                try? line.data(using: .utf8)?.write(to: f)
            }
        case "openMini":
            // 打开迷你窗：显示迷你面板 + 主窗口自动隐藏
            showMiniPanel()
            mainWindow.orderOut(nil)
        case "closeMini":
            // 关闭迷你窗：隐藏面板 + 恢复主窗口（与 openMini 对称）
            hideMiniPanel()
            showMainWindow()
        case "pickDictFiles":
            // 词典管理「链接原路径」：原生多选 .mdx/.mdd/.css 等 → 回传绝对路径数组
            pickDictFiles()
        case "lyric":
            // 桌面歌词开关：按主页面状态显示/隐藏面板
            if let show = dict["show"] as? Bool {
                if show { showLyricPanel() } else { hideLyricPanel() }
            }
        default:
            break
        }
    }

    // 迷你窗页面消息
    func handleMiniMessage(_ message: WKScriptMessage) {
        if let body = message.body as? String, body == "close" {
            hideMiniPanel()
            return
        }
        guard let dict = message.body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "close":
            hideMiniPanel()
        case "restore":
            // 返回主窗口：迷你面板消失 + 主窗口出现
            hideMiniPanel()
            showMainWindow()
        case "resize":
            // 左下角不动（迷你窗贴屏幕底边），只改宽高
            if let w = dict["width"] as? Double, let h = dict["height"] as? Double {
                let origin = miniPanel.frame.origin
                let newFrame = NSRect(
                    x: origin.x, y: origin.y,
                    width: max(280, min(900, w)),
                    height: max(80, min(400, h))
                )
                miniPanel.setFrame(newFrame, display: true, animate: true)
            }
        case "nativeDrag":
            // 整窗拖动（网页按住非控件区域触发）
            performNativeDrag(for: miniPanel)
        default:
            break
        }
    }

    // 歌词页面消息
    func handleLyricMessage(_ message: WKScriptMessage) {
        if let body = message.body as? String, body == "close" {
            hideLyricPanel()
            return
        }
        guard let dict = message.body as? [String: Any], let type = dict["type"] as? String else { return }
        switch type {
        case "close":
            hideLyricPanel()
        case "resize":
            // 左上角不动，只改右下角（窗口悬浮在屏幕角落，改大时向下向右延伸）
            if let w = dict["width"] as? Double, let h = dict["height"] as? Double {
                let origin = lyricPanel.frame.origin
                let newFrame = NSRect(
                    x: origin.x, y: origin.y,
                    width: max(200, min(1200, w)),
                    height: max(60, min(600, h))
                )
                lyricPanel.setFrame(newFrame, display: true, animate: true)
            }
        default:
            break
        }
    }

    // ============ 窗口生命周期 ============
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showMainWindow() }
        return true
    }

    // URL scheme 调起（qqplayer / qqplayermini / qqplayerlyric 同一进程，按 scheme 显示对应窗口）
    // 关闭走 qqplayermini://close / qqplayerlyric://close（host == "close"，浏览器端关闭浮窗的通道）
    func application(_ application: NSApplication, open urls: [URL]) {
        for url in urls {
            let close = url.host == "close"
            switch url.scheme {
            case "qqplayer":
                showMainWindow()
            case "qqplayermini":
                if close {
                    hideMiniPanel()
                    showMainWindow()
                } else {
                    showMiniPanel()
                }
            case "qqplayerlyric":
                if close {
                    hideLyricPanel()
                } else {
                    showLyricPanel()
                }
            default:
                break
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        nowPlayingTimer?.invalidate()
        if miniVisible { reportMiniStatusSync(false) }
        // 只清理自己拉起的子进程（spawnedProcess 非 nil 才动），外部已有服务绝不 kill
        backendLauncher.terminateSpawned()
    }
}

// ============ 入口 ============
var gDelegate: AppDelegate?

let app = NSApplication.shared
let delegate = AppDelegate()
gDelegate = delegate
app.delegate = delegate
app.setActivationPolicy(.regular) // 标准 Dock 图标 app（主窗口要 Dock；迷你窗/歌词面板不占 Dock）

// 拦截 SIGTERM/SIGINT（pkill / 系统关机等场景）：先上报迷你窗退出状态再退出。
// SIGTERM 直接终止进程不会走 applicationWillTerminate，必须在这里兜底。
// 实现：C signal handler 只做 async-signal-safe 的事（写标记文件），
// 主线程 Timer 检测到标记后优雅退出（网络请求不能在信号 handler 里做）。
let EXIT_FLAG = "/tmp/qqplayer-exit.flag"

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

Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
    if FileManager.default.fileExists(atPath: EXIT_FLAG) {
        try? FileManager.default.removeItem(atPath: EXIT_FLAG)
        if gDelegate?.miniVisible == true {
            gDelegate?.reportMiniStatusSync(false)
        }
        // SIGTERM 路径直接 exit(0) 不触发 applicationWillTerminate，这里兜底清理自拉起的子进程
        gDelegate?.backendLauncher.terminateSpawned()
        exit(0)
    }
}

app.run()
