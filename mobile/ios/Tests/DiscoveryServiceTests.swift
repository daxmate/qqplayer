import XCTest

@testable import QQPlayer

/// mDNS 发现/配对 URL 构造纯逻辑（T4a：IP 解析只用于列表展示，绝不是配对前置条件）。
final class DiscoveryServiceTests: XCTestCase {
    /// 解析中（host = nil）也能构造稳定配对 URL：hostname.local 由系统 mDNS 解析
    func testStableURLWithoutHostResolvesToHostname() {
        let server = DiscoveredServer(serviceName: "mac-mini.local", host: nil, port: 17627)
        XCTAssertEqual(server.stableURL, "http://mac-mini.local:17627")
    }

    /// 已解析出 IP：配对仍优先用 hostname.local（主机 IP 变化配对记录不失效）
    func testStableURLWithHostPrefersHostname() {
        let server = DiscoveredServer(serviceName: "mac-mini.local", host: "192.168.1.5", port: 17627)
        XCTAssertEqual(server.stableURL, "http://mac-mini.local:17627")
    }

    /// 手动输入 IP 场景（服务名即 IP）：stableURL 保持 IP 形式，不走 hostname.local
    func testStableURLForManualIPEntry() {
        let server = DiscoveredServer(serviceName: "192.168.1.5", host: "192.168.1.5", port: 17627)
        XCTAssertEqual(server.stableURL, "http://192.168.1.5:17627")
    }

    /// 服务名不带 .local 后缀（mDNS 广播形态之一）：stableURL 归一化后仍为 hostname.local
    func testStableURLWithoutLocalSuffix() {
        let server = DiscoveredServer(serviceName: "mac-mini", host: nil, port: 17627)
        XCTAssertEqual(server.stableURL, "http://mac-mini.local:17627")
    }
}
