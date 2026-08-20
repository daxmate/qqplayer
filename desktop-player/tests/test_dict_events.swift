import Foundation

// ============================================================
// dict_events.swift 的轻量测试（不引入 XCTest）
// 入口用 @main（文件非 main.swift，顶层可执行代码受限；@main 是标准做法）
// 运行方式：swiftc dict_events.swift tests/test_dict_events.swift -o build/test_dict_events && ./build/test_dict_events
// 通过 → 打印 "test_dict_events: N passed" 并 exit(0)；失败 → 打印 FAIL 并 exit(1)
// ============================================================

@main
struct TestDictEvents {

    static var passed = 0

    static func expect(_ condition: Bool, _ name: String) {
        if condition {
            passed += 1
            print("  PASS  \(name)")
        } else {
            print("  FAIL  \(name)")
            exit(1)
        }
    }

    /// 期望的 JSON 字面量：与 JSONSerialization 默认输出一致（去掉 [ ] 后的单个字符串字面量）
    /// 注意默认输出会把 / 转义为 \/，中文/emoji 原样输出（UTF-8）
    static func jsonEscapedLiteral(_ s: String) -> String {
        let data = try! JSONSerialization.data(withJSONObject: [s])
        return String(String(data: data, encoding: .utf8)!.dropFirst().dropLast())
    }

    static func main() {
        print("test_dict_events: 开始")

        // ---- a. 普通多路径 ----
        let multi = ["/a/Oxford.mdx", "/b/Oxford.css"]
        let jsMulti = buildDictFilesEventJS(multi)
        expect(jsMulti.hasPrefix("window.dispatchEvent(new CustomEvent('qqplayer:nativeDictFiles',"),
               "普通多路径: 以 dispatchEvent + 事件名开头")
        expect(jsMulti.contains("detail: { paths: ["), "普通多路径: 含 detail.paths 结构")
        expect(jsMulti.contains("\"\\/a\\/Oxford.mdx\""), "普通多路径: 含第 1 个路径 JSON 字面量")
        expect(jsMulti.contains("\"\\/b\\/Oxford.css\""), "普通多路径: 含第 2 个路径 JSON 字面量")
        expect(jsMulti.hasSuffix("))"), "普通多路径: 以 )) 结尾")

        // ---- b. 空数组（取消选择 → 空数组） ----
        let jsEmpty = buildDictFilesEventJS([])
        expect(jsEmpty.contains("paths: []"), "空数组: 含 paths: []")

        // ---- c. 特殊字符路径 ----
        let specials: [String] = [
            "/a/it's.mdx",        // 单引号（JSON 不转义，位于双引号字符串内合法）
            "/a/back\\slash.mdx", // 反斜杠（JSON 需转义为 \\）
            "/词典/牛津.mdx",      // 中文
            "/a/📖.mdx",          // emoji
            "/a/my dict.mdx",     // 空格
        ]
        for p in specials {
            let js = buildDictFilesEventJS([p])
            expect(js.contains(jsonEscapedLiteral(p)),
                   "特殊字符: JSON 转义字面量在输出中 -> \(p)")
            expect(!js.contains("\\u"),
                   "特殊字符: 未使用 \\uXXXX 转义 -> \(p)")
        }
        expect(buildDictFilesEventJS(["/a/back\\slash.mdx"]).contains("back\\\\slash"),
               "特殊字符: 反斜杠双重转义（back\\\\slash）")
        expect(buildDictFilesEventJS(["/词典/牛津.mdx"]).contains("词典"),
               "特殊字符: 中文原样输出")
        expect(buildDictFilesEventJS(["/a/📖.mdx"]).contains("📖"),
               "特殊字符: emoji 原样输出")
        expect(buildDictFilesEventJS(["/a/my dict.mdx"]).contains("my dict.mdx"),
               "特殊字符: 空格路径原样输出")

        // ---- d. 注入串合理性 ----
        let evil = "/a/x</script><script>alert(1)</script>.mdx"
        let jsEvil = buildDictFilesEventJS([evil])
        expect(jsEvil.contains(jsonEscapedLiteral(evil)), "注入串: JSON 转义字面量在输出中")
        expect(!jsEvil.contains("\n"), "注入串: 输出无未转义换行")
        expect(!jsEvil.contains("</script>"), "注入串: </script> 已转义（<\\/script>），无裸标签")
        expect(jsEvil.contains("<\\/script>"), "注入串: 含转义后的 <\\/script>")
        expect(jsEvil.hasSuffix("))"), "注入串: 仍以 )) 结尾")

        print("test_dict_events: \(passed) passed")
        exit(0)
    }
}
