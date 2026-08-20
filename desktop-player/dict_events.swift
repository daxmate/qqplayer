import Foundation

/// 词典文件多选结果 → 前端 CustomEvent JS 字符串（供 evaluateJavaScript 执行）
///
/// 输出：window.dispatchEvent(new CustomEvent('qqplayer:nativeDictFiles', { detail: { paths: [...] } }))
/// 路径数组用 JSONSerialization 序列化后去掉首尾 [ ] 内嵌（与 notifyFrontendLibraryChanged 同款技巧）：
/// JSON 转义保证路径里的引号/反斜杠/换行等不会破坏 JS 语句；空数组 → paths: []。
func buildDictFilesEventJS(_ paths: [String]) -> String {
    let json = try! JSONSerialization.data(withJSONObject: paths)
    let s = String(data: json, encoding: .utf8)!
    let inner = s.dropFirst().dropLast() // ["/a","/b"] → "/a","/b"（JSON 转义，默认 / 转义为 \/）
    return "window.dispatchEvent(new CustomEvent('qqplayer:nativeDictFiles', { detail: { paths: [\(inner)] } }))"
}
