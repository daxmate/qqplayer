import XCTest

/// 桥契约测试（iOS 壳侧，单一事实源 docs/ios-bridge-contract.json）
///
/// 与 frontend/src/__tests__/iosBridgeContract.test.js（前端侧）配套：
/// 双向覆盖校验，任何一端增删命令/事件而不同步契约即红。
///
/// 扫描范围（壳源码，正则提取，不 import 业务代码）：
///   - Web→Native cmd：WebShellView.swift 的 `case "xxx"` 分发（含 `case "a", "b", "c":`
///     多值 case 行）+ AVPlayerBridge.swift commandHandlers 映射表键 + `cmd == "playAudio"` 特例
///     （自动排除 jsonLiteral 的转义字符 case `"\""`/`"\\"`/`"\n"` 等——引号内要求字母开头）
///   - Native→Web event：WebShellView pushToWeb(event:) 字面量 + AVPlayerBridge push("xxx")
///     + RemoteCommandManager onPushEvent?("xxx") + PlayerStateMachine PushEvent case 名
///
/// 契约状态语义（见契约 JSON statusEnum）：
///   - active：双端均有，双向包含校验（壳⊆契约 && 契约active⊆壳）
///   - legacy：前端仍可能发送但壳不处理（http）——只校验「壳确实不处理」
///   - shellOnly：壳处理但前端当前无发送方（nativeLog）——与 active 同规则参与校验
final class BridgeContractTests: XCTestCase {
    // MARK: - 定位契约文件（#filePath → 向上找仓库根 docs/ios-bridge-contract.json）

    /// 仓库根（含 docs/ios-bridge-contract.json 的祖先目录）；找不到返回 nil
    private static var repoRootURL: URL? {
        var dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0 ..< 6 {
            let candidate = dir.appendingPathComponent("docs/ios-bridge-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return dir
            }
            dir = dir.deletingLastPathComponent()
        }
        return nil
    }

    private static var sourcesDir: URL? {
        repoRootURL?.appendingPathComponent("mobile/ios/Sources")
    }

    // MARK: - 契约加载

    private struct Contract {
        let webCmdNames: Set<String>
        let activeWebCmdNames: Set<String>
        let legacyWebCmdNames: Set<String>
        let nativeEventNames: Set<String>
    }

    private static func loadContract() -> Contract? {
        guard let root = repoRootURL else { return nil }
        let contractURL = root.appendingPathComponent("docs/ios-bridge-contract.json")
        guard let data = try? Data(contentsOf: contractURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let webCmd = obj["webCmd"] as? [[String: Any]],
              let nativeEvent = obj["nativeEvent"] as? [[String: Any]]
        else {
            return nil
        }
        let names = { (list: [[String: Any]]) in
            Set(list.compactMap { $0["name"] as? String })
        }
        let isLegacy = { (entry: [String: Any]) in (entry["status"] as? String) == "legacy" }
        return Contract(
            webCmdNames: names(webCmd),
            activeWebCmdNames: Set(webCmd.filter { !isLegacy($0) }.compactMap { $0["name"] as? String }),
            legacyWebCmdNames: Set(webCmd.filter { isLegacy($0) }.compactMap { $0["name"] as? String }),
            nativeEventNames: names(nativeEvent)
        )
    }

    // MARK: - 壳源码扫描

    private static func readSource(_ name: String) -> String {
        guard let dir = sourcesDir else { return "" }
        let url = dir.appendingPathComponent(name)
        return (try? String(contentsOf: url, encoding: .utf8)) ?? ""
    }

    /// 正则提取第一捕获组（全部匹配）
    private static func matches(_ pattern: String, in text: String) -> Set<String> {
        guard let re = try? NSRegularExpression(pattern: pattern) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        var out = Set<String>()
        for m in re.matches(in: text, range: range) {
            guard m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: text) else { continue }
            out.insert(String(text[r]))
        }
        return out
    }

    /// 提取所有含 `case "` 的行里的引号字面量（兼容 `case "a", "b", "c":` 多值行）
    private static func caseLiterals(in text: String) -> Set<String> {
        var out = Set<String>()
        let wordRe = try! NSRegularExpression(pattern: "\"([a-zA-Z][a-zA-Z0-9]*)\"")
        for line in text.split(separator: "\n") where line.contains("case \"") {
            let lineStr = String(line)
            let range = NSRange(lineStr.startIndex..., in: lineStr)
            for m in wordRe.matches(in: lineStr, range: range) {
                guard m.numberOfRanges > 1, let r = Range(m.range(at: 1), in: lineStr) else { continue }
                out.insert(String(lineStr[r]))
            }
        }
        return out
    }

    /// 壳 Web→Native cmd 全集（WebShellView case 分发 + AVPlayerBridge 映射表 + playAudio 特例）
    private static func scanShellWebCmds() -> Set<String> {
        let webShell = readSource("WebShellView.swift")
        let playerBridge = readSource("AVPlayerBridge.swift")
        var cmds = caseLiterals(in: webShell)
        cmds.formUnion(matches("\"([a-zA-Z][a-zA-Z0-9]*)\": \\{ bridge", in: playerBridge))
        cmds.formUnion(matches("cmd == \"([a-zA-Z][a-zA-Z0-9]*)\"", in: webShell)) // cmd == "playAudio"
        return cmds
    }

    /// 壳 Native→Web event 全集（pushToWeb / push("") / onPushEvent?("") / PushEvent case）
    private static func scanShellEvents() -> Set<String> {
        var events = matches(
            "pushToWeb\\(event: \"([a-zA-Z][a-zA-Z0-9]*)\"",
            in: readSource("WebShellView.swift")
        )
        events.formUnion(matches(
            "push\\(\"([a-zA-Z][a-zA-Z0-9]*)\"",
            in: readSource("AVPlayerBridge.swift")
        ))
        events.formUnion(matches(
            "onPushEvent\\?\\(\"([a-zA-Z][a-zA-Z0-9]*)\"",
            in: readSource("RemoteCommandManager.swift")
        ))
        events.formUnion(matches(
            "case (playing|paused|ended)",
            in: readSource("PlayerStateMachine.swift")
        ))
        return events
    }

    // MARK: - 测试

    func testContractJSONLoads() {
        guard let root = Self.repoRootURL else {
            XCTFail("找不到仓库根 docs/ios-bridge-contract.json（从 \(#filePath) 向上 6 层内）")
            return
        }
        guard let contract = Self.loadContract() else {
            XCTFail("契约 JSON 读取/解析失败：\(root.path)/docs/ios-bridge-contract.json")
            return
        }
        XCTAssertFalse(contract.webCmdNames.isEmpty, "webCmd 不应为空")
        XCTAssertFalse(contract.nativeEventNames.isEmpty, "nativeEvent 不应为空")
    }

    /// 壳每个 cmd ∈ 契约 webCmd（全量名含 legacy，legacy 条目也记录在契约里）
    func testShellCmdsAllInContract() {
        guard let contract = Self.loadContract() else {
            XCTFail("契约 JSON 加载失败")
            return
        }
        let shellCmds = Self.scanShellWebCmds()
        let extra = shellCmds.subtracting(contract.webCmdNames).sorted()
        XCTAssertTrue(extra.isEmpty, "壳源码有但契约没有的 cmd（缺契约条目）：\(extra)")
    }

    /// 契约 active 每个 cmd ∈ 壳分发（legacy 除外：前端仍发但壳有意不处理）
    func testContractActiveCmdsAllHandled() {
        guard let contract = Self.loadContract() else {
            XCTFail("契约 JSON 加载失败")
            return
        }
        let shellCmds = Self.scanShellWebCmds()
        let missing = contract.activeWebCmdNames.subtracting(shellCmds).sorted()
        XCTAssertTrue(missing.isEmpty, "契约 active 但壳源码没有分发的 cmd（缺实现或契约过期）：\(missing)")
    }

    /// legacy cmd：壳确实不处理（若将来真要处理，先把契约状态改成 active）
    func testLegacyCmdsNotHandledByShell() {
        guard let contract = Self.loadContract() else {
            XCTFail("契约 JSON 加载失败")
            return
        }
        let shellCmds = Self.scanShellWebCmds()
        let handled = contract.legacyWebCmdNames.intersection(shellCmds).sorted()
        XCTAssertTrue(handled.isEmpty, "legacy cmd 不应出现在壳分发里（请把契约状态改为 active）：\(handled)")
    }

    /// Native→Web 事件双向覆盖（壳事件 ⊆ 契约 && 契约 ⊆ 壳事件）
    func testNativeEventBidirectionalCoverage() {
        guard let contract = Self.loadContract() else {
            XCTFail("契约 JSON 加载失败")
            return
        }
        let shellEvents = Self.scanShellEvents()
        let extra = shellEvents.subtracting(contract.nativeEventNames).sorted()
        let missing = contract.nativeEventNames.subtracting(shellEvents).sorted()
        XCTAssertTrue(extra.isEmpty, "壳源码有但契约没有的 event（缺契约条目）：\(extra)")
        XCTAssertTrue(missing.isEmpty, "契约有但壳源码没发出的 event（缺实现或契约过期）：\(missing)")
    }
}
