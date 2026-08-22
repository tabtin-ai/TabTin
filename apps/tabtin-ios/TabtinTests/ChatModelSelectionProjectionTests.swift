import XCTest
@testable import Tabtin

final class ChatModelSelectionProjectionTests: XCTestCase {
    func testModelSelectionIsDisabledWhileRunIsActive() {
        XCTAssertFalse(
            ConversationModelSelectionPolicy.canSelect(
                hasActiveRun: true,
                isSwitchingModel: false
            )
        )
    }

    func testModelSelectionIsAvailableWhenConversationIsIdle() {
        XCTAssertTrue(
            ConversationModelSelectionPolicy.canSelect(
                hasActiveRun: false,
                isSwitchingModel: false
            )
        )
    }

    func testAgentChangeUsesTheNewAgentsPreferredModel() {
        XCTAssertEqual(
            ConversationModelSelectionPolicy.modelIdAfterAgentChange(
                preferredModelId: "doubao-model",
                currentModelId: "kimi-model",
                availableModelIds: Set(["kimi-model", "doubao-model"])
            ),
            "doubao-model"
        )
    }

    func testAgentChangeKeepsCurrentModelWhenPreferenceIsUnavailable() {
        XCTAssertEqual(
            ConversationModelSelectionPolicy.modelIdAfterAgentChange(
                preferredModelId: "retired-model",
                currentModelId: "kimi-model",
                availableModelIds: Set(["kimi-model", "doubao-model"])
            ),
            "kimi-model"
        )
    }

    func testExistingSessionRestoresCurrentModelBeforeDefaults() {
        XCTAssertEqual(
            ConversationModelSelectionPolicy.restoredModelId(
                currentModelId: "current",
                defaultModelId: "session-default",
                catalogDefaultModelId: "catalog-default"
            ),
            "current"
        )
    }

    func testExistingSessionFallsBackWithoutTreatingBlankAsSelection() {
        XCTAssertEqual(
            ConversationModelSelectionPolicy.restoredModelId(
                currentModelId: "  ",
                defaultModelId: "session-default",
                catalogDefaultModelId: "catalog-default"
            ),
            "session-default"
        )
        XCTAssertEqual(
            ConversationModelSelectionPolicy.restoredModelId(
                currentModelId: nil,
                defaultModelId: nil,
                catalogDefaultModelId: "catalog-default"
            ),
            "catalog-default"
        )
    }

    private func decodeModel(_ payload: [String: Any]) throws -> ChatModel {
        let data = try JSONSerialization.data(withJSONObject: payload)
        return try JSONDecoder().decode(ChatModel.self, from: data)
    }

    func testSearchesElectronParityFieldsAndPreservesProviderOrder() throws {
        let claude = try decodeModel([
            "id": "11111111-1111-4111-8111-111111111111",
            "name": "claude-sonnet",
            "model_name": "anthropic/claude-sonnet",
            "display_name": "Claude Sonnet",
            "provider": "anthropic",
            "provider_display_name": "Anthropic",
            "supports_function_calling": true,
        ])
        let gpt = try decodeModel([
            "id": "22222222-2222-4222-8222-222222222222",
            "name": "gpt-5",
            "display_name": "GPT-5",
            "provider": "openai",
            "provider_display_name": "OpenAI",
            "supports_function_calling": false,
            "supports_vision": true,
            "is_default": true,
        ])

        let groups = ModelSelectionProjection.groups(
            models: [claude, gpt],
            providers: ["openai": try JSONDecoder().decode(ChatModelProviderMetadata.self, from: Data("{\"display_name\":\"OpenAI 平台\"}".utf8))],
            query: "anthropic"
        )
        XCTAssertEqual(groups.map(\.title), ["Anthropic"])
        XCTAssertEqual(groups.first?.models.map(\.id), [claude.id])

        XCTAssertTrue(ModelSelectionProjection.matches(claude, query: "claude-sonnet"))
        XCTAssertTrue(ModelSelectionProjection.matches(claude, query: "anthropic/claude"))
        XCTAssertTrue(ModelSelectionProjection.matches(gpt, query: "OpenAI"))
        XCTAssertEqual(ModelSelectionProjection.capabilityLabels(for: gpt), ["视觉", "文字"])
    }

    func testUsesCatalogProviderMetadataAndOnlyTruthfulCapabilities() throws {
        let model = try decodeModel([
            "id": "33333333-3333-4333-8333-333333333333",
            "name": "vision-model",
            "display_name": "Vision Model",
            "provider": "provider-key",
            "context_window_tokens": 200000,
            "context_tiers": [
                ["id": "standard", "label": "标准", "is_default": true, "is_user_selectable": true],
                ["id": "long", "label": "长上下文", "is_user_selectable": true, "tags": ["beta"]],
            ],
        ])
        let metadata = try JSONDecoder().decode(
            ChatModelProviderMetadata.self,
            from: Data("{\"display_name\":\"服务端 Provider 名\"}".utf8)
        )

        let groups = ModelSelectionProjection.groups(
            models: [model], providers: ["provider-key": metadata], query: ""
        )
        XCTAssertEqual(groups.first?.title, "服务端 Provider 名")
        XCTAssertEqual(ModelSelectionProjection.contextSummary(for: model), "200K 上下文")
        XCTAssertEqual(model.selectableContextTiers.map(\.id), ["standard", "long"])
        XCTAssertEqual(ModelSelectionProjection.capabilityLabels(for: model), ["文字"])
        XCTAssertEqual(ModelSelectionProjection.nextSendHint, "当前会话使用")
    }

    func testProviderIconURLUsesCurrentAPIOriginForRelativeCatalogPath() {
        XCTAssertEqual(
            ProviderIconURLResolver.resolve(
                "/api/services/llm/provider-icons/kimi",
                apiBaseURL: "http://192.168.1.20:6060/api"
            )?.absoluteString,
            "http://192.168.1.20:6060/api/services/llm/provider-icons/kimi"
        )
        XCTAssertEqual(
            ProviderIconURLResolver.resolve(
                "https://cdn.example.com/kimi.png",
                apiBaseURL: "http://127.0.0.1:6060/api"
            )?.absoluteString,
            "https://cdn.example.com/kimi.png"
        )
    }
}
