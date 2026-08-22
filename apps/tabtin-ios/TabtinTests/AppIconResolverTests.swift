import XCTest
@testable import Tabtin

final class AppIconResolverTests: XCTestCase {
    func testBundledAssetAppIdsHaveCatalogEntries() {
        for appId in AppIconResolver.bundledAssetAppIds {
            let assetName = AppIconResolver.assetName(for: appId)
            XCTAssertEqual(assetName, AppIconResolver.resolveAssetName(appId: appId),
                           "缺少 App 图标资产：\(appId) → \(assetName)")
            XCTAssertNotNil(
                UIImage(named: assetName),
                "\(appId) 映射到不存在的 AppIcon asset：\(assetName)"
            )
        }
    }

    func testResolvePrefersAssetWhenPresent() {
        let ref = AppIconResolver.resolve(appId: "tabdoc", manifestIcon: "file-text")
        guard case .asset(let name) = ref else {
            return XCTFail("tabdoc 应优先走品牌资产")
        }
        XCTAssertEqual(name, "AppIconTabdoc")
    }

    func testResolveContentGlyphPrefersBareResourceAssets() {
        let cases = [
            (appId: "tabdoc", manifestIcon: "file-text", assetName: "AppGlyphTabdoc"),
            (appId: "tabdata", manifestIcon: "table", assetName: "AppGlyphTabdata"),
            (appId: "tabweb", manifestIcon: "globe", assetName: "AppGlyphTabweb"),
        ]

        for value in cases {
            XCTAssertNotNil(
                UIImage(named: value.assetName),
                "缺少资源列表内容图标资产：\(value.assetName)"
            )
            XCTAssertEqual(
                AppIconResolver.resolveContentGlyph(
                    appId: value.appId,
                    manifestIcon: value.manifestIcon
                ),
                .asset(value.assetName)
            )
        }
    }

    func testResolveContentGlyphNormalizesBuiltinAppId() {
        XCTAssertEqual(
            AppIconResolver.resolveContentGlyph(
                appId: "  TABDOC\n",
                manifestIcon: "file-text"
            ),
            .asset("AppGlyphTabdoc")
        )
    }

    func testResolveContentGlyphKeepsExistingFallbackContract() {
        XCTAssertEqual(
            AppIconResolver.resolveContentGlyph(
                appId: "tabphone",
                manifestIcon: "smartphone"
            ),
            .system("iphone")
        )
    }

    func testResolveFallsBackToSystemImageWhenNoAsset() {
        let ref = AppIconResolver.resolve(appId: "tabphone", manifestIcon: "smartphone")
        guard case .system(let name) = ref else {
            return XCTFail("无 SVG 的 builtin 应走 SF Symbol fallback")
        }
        XCTAssertEqual(name, "iphone")
    }

    func testAssetNameCapitalizesAppId() {
        XCTAssertEqual(AppIconResolver.assetName(for: "tabdata"), "AppIconTabdata")
        XCTAssertEqual(AppIconResolver.assetName(for: "terminal"), "AppIconTerminal")
    }
}
