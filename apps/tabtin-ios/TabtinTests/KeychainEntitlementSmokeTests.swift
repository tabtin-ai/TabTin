import Security
import XCTest
@testable import Tabtin

/// 见 support/mobile/PITFALLS.md #24：模拟器构建没带 entitlements 时，`SecItem*` 一律返回
/// -34018 errSecMissingEntitlement，登录写 token 全线失败。
///
/// 两条断言分工不同，别合并：
/// - `testBuildCarriesKeychainEntitlements` 卡**构建口径**——传了 CODE_SIGNING_ALLOWED=NO 就红。
/// - `testKeychainRoundTripSucceeds` 卡**存取能力**——真 Keychain 或模拟器兜底，任一条通即可。
final class KeychainEntitlementSmokeTests: XCTestCase {
    /// 直接问系统：本进程有没有 Keychain 访问组。有别的失败（比如查无此项）都算通过，
    /// 只有 -34018 说明产物没签名 / 没 entitlements。
    func testBuildCarriesKeychainEntitlements() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.tabtin.mobile.entitlement-probe",
            kSecAttrAccount as String: "probe",
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        let status = SecItemCopyMatching(query as CFDictionary, nil)

        XCTAssertNotEqual(
            status,
            errSecMissingEntitlement,
            "构建产物没有 entitlements：模拟器构建不要传 CODE_SIGNING_ALLOWED=NO"
        )
    }

    /// 用独立 service 名，不碰真实 token。
    func testKeychainRoundTripSucceeds() throws {
        let keychain = Keychain(service: "com.tabtin.mobile.entitlement-smoke")
        let key = "smoke_probe"

        try keychain.set("v1", key: key)
        XCTAssertEqual(try keychain.get(key), "v1")

        try keychain.set("v2", key: key)
        XCTAssertEqual(try keychain.get(key), "v2")

        try keychain.remove(key)
        XCTAssertNil(try keychain.get(key))
    }
}
