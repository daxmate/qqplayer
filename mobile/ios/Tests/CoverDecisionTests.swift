import XCTest

@testable import QQPlayer

/// 封面获取策略决策（CoverDecision.decide）测试。
final class CoverDecisionTests: XCTestCase {
    func testDataURLAlwaysSyncDataURL() {
        // data:image/ 前缀 → 同步解码，无论有没有内嵌封面
        XCTAssertEqual(
            CoverDecision.decide(coverUrl: "data:image/png;base64,iVBORw0KGgo=", hasEmbedded: false),
            .syncDataURL
        )
        XCTAssertEqual(
            CoverDecision.decide(coverUrl: "data:image/jpeg;base64,/9j/4AAQ", hasEmbedded: true),
            .syncDataURL
        )
    }

    func testHttpWithEmbeddedUsesEmbeddedThenAsync() {
        XCTAssertEqual(
            CoverDecision.decide(coverUrl: "http://192.168.1.5:8080/api/cover?id=1", hasEmbedded: true),
            .embeddedThenAsync
        )
        XCTAssertEqual(
            CoverDecision.decide(coverUrl: "https://example.com/cover.jpg", hasEmbedded: true),
            .embeddedThenAsync
        )
    }

    func testHttpWithoutEmbeddedUsesAsyncOnly() {
        XCTAssertEqual(
            CoverDecision.decide(coverUrl: "http://192.168.1.5:8080/api/cover?id=1", hasEmbedded: false),
            .asyncOnly
        )
        XCTAssertEqual(
            CoverDecision.decide(coverUrl: "https://example.com/cover.jpg", hasEmbedded: false),
            .asyncOnly
        )
    }

    func testEmptyStringFollowsHasEmbedded() {
        // 空串无 data: 前缀 → 按实现语义走 hasEmbedded 分支
        XCTAssertEqual(CoverDecision.decide(coverUrl: "", hasEmbedded: false), .asyncOnly)
        XCTAssertEqual(CoverDecision.decide(coverUrl: "", hasEmbedded: true), .embeddedThenAsync)
    }
}
