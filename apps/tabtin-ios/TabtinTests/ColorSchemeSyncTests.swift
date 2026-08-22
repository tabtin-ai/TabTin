import XCTest
@testable import Tabtin

final class ColorSchemeSyncTests: XCTestCase {
    func testDefaultIsOrange() {
        XCTAssertEqual(ColorSchemeId.default, .orange)
        XCTAssertEqual(ColorSchemeId.default.rawValue, "orange")
    }

    func testResolveUnknownFallsBackToDefault() {
        XCTAssertEqual(ColorSchemeId.resolve(nil), .orange)
        XCTAssertEqual(ColorSchemeId.resolve("not-a-scheme"), .orange)
        XCTAssertEqual(ColorSchemeId.resolve("orange"), .orange)
    }

    func testAllSchemesHaveDistinctAccent() {
        var accents = Set<UInt>()
        for id in ColorSchemeId.allCases {
            let accent = ColorSchemePalette.tokens(for: id).bgAccent.light
            XCTAssertFalse(accents.contains(accent), "scheme \(id) accent collides")
            accents.insert(accent)
        }
        XCTAssertEqual(accents.count, ColorSchemeId.allCases.count)
    }

    func testOrangeAccentPreservesLegacyIOSBaseline() {
        let tokens = ColorSchemePalette.tokens(for: .orange)
        XCTAssertEqual(tokens.bgAccent.light, 0xE07E29)
        XCTAssertEqual(tokens.bgAccent.dark, 0xE6944C)
    }

    func testReconcileRemoteWinsWhenNewer() {
        var applied: ColorSchemeId?
        var pushed: ColorSchemeId?
        UISettingsSync.reconcile(
            localValue: ColorSchemeId.orange,
            localUpdatedAt: 100,
            remote: UISettingEnvelope(value: .blue, updatedAt: 200),
            applyRemote: { value, _ in applied = value },
            pushLocal: { value, _ in pushed = value }
        )
        XCTAssertEqual(applied, .blue)
        XCTAssertNil(pushed)
    }

    func testReconcileLocalWinsWhenNewer() {
        var applied: ColorSchemeId?
        var pushed: (ColorSchemeId, Int64)?
        UISettingsSync.reconcile(
            localValue: ColorSchemeId.teal,
            localUpdatedAt: 300,
            remote: UISettingEnvelope(value: .blue, updatedAt: 200),
            applyRemote: { value, _ in applied = value },
            pushLocal: { value, ts in pushed = (value, ts) }
        )
        XCTAssertNil(applied)
        XCTAssertEqual(pushed?.0, .teal)
        XCTAssertEqual(pushed?.1, 300)
    }

    func testReconcileMissingRemotePushesLocal() {
        var pushed: ColorSchemeId?
        UISettingsSync.reconcile(
            localValue: ColorSchemeId.sky,
            localUpdatedAt: 0,
            remote: nil,
            applyRemote: { _, _ in XCTFail("should not apply") },
            pushLocal: { value, _ in pushed = value }
        )
        XCTAssertEqual(pushed, .sky)
    }

    func testParseColorSchemeEnvelope() {
        let settings: [String: [String: Any]] = [
            "colorScheme": ["value": "violet", "updatedAt": 1_700_000_000_000],
            "theme": ["value": "dark", "updatedAt": 1],
        ]
        let envelope = UISettingsSync.parseColorSchemeEnvelope(from: settings)
        XCTAssertEqual(envelope?.value, .violet)
        XCTAssertEqual(envelope?.updatedAt, 1_700_000_000_000)
    }

    func testExtractSettingsMapFromWSPayloadShape() {
        let payload: [String: Any] = [
            "data": [
                "settings": [
                    "colorScheme": ["value": "rose", "updatedAt": 42],
                ],
            ],
        ]
        let map = UISettingsSync.extractSettingsMap(from: payload)
        XCTAssertEqual(UISettingsSync.parseColorSchemeEnvelope(from: map)?.value, .rose)
    }
}
