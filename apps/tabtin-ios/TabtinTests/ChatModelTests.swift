import XCTest
@testable import Tabtin

final class ChatModelTests: XCTestCase {
    func testDecodesPromotionCreditAndBuildsInlineSummary() throws {
        let model = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "doubao-seed",
          "display_name": "豆包 Seed",
          "promotion_credit": {
            "eligible": true,
            "remaining_credits": 8000,
            "total_credits": 10000
          }
        }
        """.utf8))

        XCTAssertEqual(model.promotionCredit?.remainingCredits, 8000)
        XCTAssertEqual(model.promotionCredit?.totalCredits, 10000)
        XCTAssertNotNil(model.promotionCreditSummary)
        XCTAssertTrue(model.promotionCreditSummary?.contains("赠享") == true)
        XCTAssertTrue(model.promotionCreditSummary?.contains("点券") == true)
    }

    func testMissingPromotionCreditRemainsCompatible() throws {
        let model = try JSONDecoder().decode(ChatModel.self, from: Data("""
        { "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF", "name": "kimi" }
        """.utf8))

        XCTAssertNil(model.promotionCredit)
        XCTAssertNil(model.promotionCreditSummary)
    }

    func testDocumentInputCapabilityIsFailClosedAndMatchesElectronPrecedence() throws {
        let topLevel = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "kimi",
          "supports_document_input": true
        }
        """.utf8))
        let resolvedFallback = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FE",
          "name": "kimi",
          "resolved_capabilities": { "supports_document_input": true }
        }
        """.utf8))
        let topLevelOverride = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FD",
          "name": "text-only",
          "supports_document_input": false,
          "resolved_capabilities": { "supports_document_input": true }
        }
        """.utf8))
        let missing = try JSONDecoder().decode(ChatModel.self, from: Data("""
        { "id": "6F9619FF-8B86-D011-B42D-00C04FC964FC", "name": "legacy" }
        """.utf8))

        XCTAssertTrue(topLevel.supportsDocumentInput)
        XCTAssertTrue(resolvedFallback.supportsDocumentInput)
        XCTAssertFalse(topLevelOverride.supportsDocumentInput)
        XCTAssertFalse(missing.supportsDocumentInput)
    }

    func testModelSourceDistinguishesPlatformAndByokWithLegacyFallback() throws {
        func decode(scope: String?) throws -> ChatModel {
            let scopeField = scope.map { ", \"provider_scope\": \"\($0)\"" } ?? ""
            return try JSONDecoder().decode(ChatModel.self, from: Data("""
            { "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF", "name": "model"\(scopeField) }
            """.utf8))
        }

        XCTAssertEqual(try decode(scope: "global").source, .platform)
        XCTAssertEqual(try decode(scope: "organization").source, .organizationByok)
        XCTAssertEqual(try decode(scope: "user").source, .userByok)
        XCTAssertEqual(try decode(scope: nil).source, .platform)
        XCTAssertEqual(try decode(scope: "future-scope").source, .platform)
    }

    func testOnlyEligibleSettledModelRequestsPromotionCreditRefresh() throws {
        let model = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "doubao-seed",
          "promotion_credit": { "eligible": true, "remaining_credits": 10 }
        }
        """.utf8))

        XCTAssertTrue(ChatModelStore.shouldRefreshPromotionCredit(
            modelId: model.id,
            availableModels: [model]
        ))
        XCTAssertFalse(ChatModelStore.shouldRefreshPromotionCredit(
            modelId: "ordinary-model",
            availableModels: [model]
        ))
    }

    func testDecodesRuntimeProfileThinkingAndHidesWhenUnsupported() throws {
        let supported = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "claude-sonnet",
          "context_window_tokens": 200000,
          "context_tiers": [
            {"id":"standard","label":"200K","is_default":true,"is_user_selectable":true},
            {"id":"long_1m","label":"1M","is_user_selectable":true,"tags":["beta"]}
          ],
          "runtime_profile": {
            "thinking": {
              "supported": true,
              "modes": ["off", "standard", "deep"],
              "default_mode": "standard"
            }
          }
        }
        """.utf8))

        XCTAssertTrue(supported.showsRuntimeSettings)
        XCTAssertTrue(supported.canSelectContextTier)
        XCTAssertEqual(supported.thinkingCapability?.modes, [.off, .standard, .deep])
        XCTAssertEqual(supported.thinkingCapability?.defaultMode, .standard)
        XCTAssertEqual(
            ComposerRuntimeSettingsProjection.runtimeSummary(
                model: supported,
                selectedTierId: "long_1m",
                selectedThinkingMode: .deep
            ),
            "1M · 深度"
        )

        let forced = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "kimi",
          "context_window_tokens": 256000,
          "runtime_profile": {
            "thinking": {
              "supported": true,
              "modes": ["standard", "deep"],
              "default_mode": "standard"
            }
          }
        }
        """.utf8))
        XCTAssertEqual(forced.thinkingCapability?.modes, [.standard, .deep])
        XCTAssertFalse(forced.canSelectContextTier)
        XCTAssertTrue(forced.showsContextLengthSection)

        let unsupported = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "gpt",
          "context_window_tokens": 128000,
          "runtime_profile": {
            "thinking": { "supported": false, "modes": [], "default_mode": "off" }
          }
        }
        """.utf8))
        XCTAssertNil(unsupported.thinkingCapability)
        XCTAssertTrue(unsupported.showsRuntimeSettings)
        XCTAssertEqual(
            ComposerRuntimeSettingsProjection.formatContextWindowLabel(128000),
            "128K"
        )
    }

    func testThinkingModeV2TransportBodyShape() {
        let overrides = ChatModelParamOverrides.thinkingModeV2(.deep)
        XCTAssertEqual(overrides.transportDictionary["v"] as? Int, 2)
        XCTAssertEqual(overrides.transportDictionary["thinking_mode"] as? String, "deep")
        XCTAssertNil(overrides.transportDictionary["reasoning_effort"])
    }

    func testThinkingModeWritePreservesPerformanceProfile() throws {
        let existing = try JSONDecoder().decode(ChatModelParamOverrides.self, from: Data("""
        {"v":2,"thinking_mode":"standard","performance_profile":"fast"}
        """.utf8))
        let merged = ChatModelParamOverrides.thinkingModeV2(.deep, preserving: existing)
        XCTAssertEqual(merged.thinkingMode, .deep)
        XCTAssertEqual(merged.performanceProfile, "fast")
        XCTAssertEqual(merged.transportDictionary["performance_profile"] as? String, "fast")
        XCTAssertNil(merged.transportDictionary["reasoning_effort"])
    }

    func testClampsRuntimeSelectionToModelCapability() throws {
        let model = try JSONDecoder().decode(ChatModel.self, from: Data("""
        {
          "id": "6F9619FF-8B86-D011-B42D-00C04FC964FF",
          "name": "claude",
          "context_tiers": [
            {"id":"standard","label":"200K","is_default":true,"is_user_selectable":true},
            {"id":"long_1m","label":"1M","is_user_selectable":true}
          ],
          "runtime_profile": {
            "thinking": {
              "supported": true,
              "modes": ["standard", "deep"],
              "default_mode": "standard"
            }
          }
        }
        """.utf8))

        let clamped = ComposerRuntimeSettingsProjection.clampedSelection(
            model: model,
            selectedTierId: "missing",
            selectedThinkingMode: .off
        )
        XCTAssertEqual(clamped.contextTierId, "standard")
        XCTAssertEqual(clamped.thinkingMode, .standard)
    }
}
