import UIKit
import WebKit

/// 无系统长按菜单的 WKWebView（2026-08-23 阶段4 查词 UX 修复）：
///
/// 问题：阅读器长按/选词默认弹出 iOS 系统编辑菜单（查询/拷贝/共享），
/// 其中"查询"走 UIReferenceLibraryViewController（系统词典），与项目 MDX 词典无关，
/// 且抢占交互导致 Web 侧 SelectionToolbar（查词/高亮/生词本）出不来。
///
/// 方案：canPerformAction 全 false 隐藏系统编辑菜单——选区手势行为不受影响
/// （长按仍选中单词），Web 侧 400ms 选区轮询检测到后显示自家工具栏；
/// 功能覆盖无损失（工具栏含查词/高亮/笔记/搜索/拷贝）。
/// 注意：配对输入是原生 DiscoveryView（TextField 不走此 WebView），
/// Web 输入框粘贴菜单受影响可接受；若未来 Web 设置页需要系统编辑菜单再按需放行。
final class NoMenuWebView: WKWebView {
    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        false
    }
}
