import XCTest
@testable import Tabtin

final class ConversationRuntimeConfigurationTests: XCTestCase {
    func testSelectableAgentModesMatchSharedContract() {
        XCTAssertEqual(ChatAgentMode.allCases.map(\.rawValue), ["ask", "agent", "plan", "group"])
    }

    func testApprovalModesMatchSharedContract() {
        XCTAssertEqual(
            ChatApprovalMode.allCases.map(\.rawValue),
            ["always_ask", "auto", "full_access"]
        )
    }

    func testLegacyYoloMigratesToAgentAndAutoWhenAllowed() {
        let configuration = ConversationRuntimeConfiguration.migrating(
            agentMode: "yolo",
            approvalMode: nil,
            permitsRelaxedApproval: true
        )

        XCTAssertEqual(configuration.agentMode, .agent)
        XCTAssertEqual(configuration.approvalMode, .auto)
    }

    func testRelaxedApprovalValuesAreClampedWhenOrganizationDisallowsThem() {
        for rawApprovalMode in [nil, "auto", "full_access"] {
            let configuration = ConversationRuntimeConfiguration.migrating(
                agentMode: "yolo",
                approvalMode: rawApprovalMode,
                permitsRelaxedApproval: false
            )

            XCTAssertEqual(configuration.agentMode, .agent)
            XCTAssertEqual(configuration.approvalMode, .alwaysAsk)
        }
    }

    func testPayloadExplicitlyFreezesRuntimeConfigurationModelAndBlocks() {
        let payload = ConversationRuntimeConfiguration(
            agentMode: .plan,
            approvalMode: .fullAccess
        ).chatSendPayload(
            sessionId: "session-1",
            message: "ship it",
            clientEventId: "event-1",
            modelId: "model-1",
            blocks: [["type": "doc_selection", "doc_id": "doc-1"]],
            userTimeZone: "Asia/Shanghai"
        )

        XCTAssertEqual(payload["agent_mode"] as? String, "plan")
        XCTAssertEqual(payload["approval_mode"] as? String, "full_access")
        XCTAssertEqual(payload["model_id"] as? String, "model-1")
        XCTAssertEqual(
            payload["blocks"] as? [[String: String]],
            [["type": "doc_selection", "doc_id": "doc-1"]]
        )
    }

    func testAttachmentOnlyPayloadKeepsEmptyMessageAndImageBlock() {
        let payload = ConversationRuntimeConfiguration(
            agentMode: .agent,
            approvalMode: .alwaysAsk
        ).chatSendPayload(
            sessionId: "session-1",
            message: "",
            clientEventId: "event-1",
            modelId: "model-1",
            blocks: [[
                "type": "image",
                "file_id": "file-1",
                "mime_type": "image/jpeg",
            ]],
            userTimeZone: "Asia/Shanghai"
        )

        XCTAssertEqual(payload["message"] as? String, "")
        let blocks = payload["blocks"] as? [[String: Any]]
        XCTAssertEqual(blocks?.first?["type"] as? String, "image")
        XCTAssertEqual(blocks?.first?["file_id"] as? String, "file-1")
    }

    func testInvalidValuesFallBackToSafeDefaults() {
        let configuration = ConversationRuntimeConfiguration.migrating(
            agentMode: "unsupported-mode",
            approvalMode: "unsafe-mode",
            permitsRelaxedApproval: true
        )

        XCTAssertEqual(configuration.agentMode, .agent)
        XCTAssertEqual(configuration.approvalMode, .alwaysAsk)
    }

    func testExistingSessionUsesFrozenExecutionScopeInsteadOfEntryScope() {
        let entry = ConversationExecutionScope.entry(
            workspaceId: "entry-workspace",
            projectId: "entry-project",
            organizationId: "entry-org"
        )

        let scope = ConversationExecutionScope.resolvingFrozenSession(
            workspaceId: "frozen-workspace",
            projectId: nil,
            organizationId: "frozen-org",
            fallback: entry
        )

        XCTAssertEqual(scope.workspaceId, "frozen-workspace")
        XCTAssertNil(scope.projectId)
        XCTAssertEqual(scope.organizationId, "frozen-org")
    }

    func testMissingLegacySessionWorkspaceFallsBackToEntryScope() {
        let entry = ConversationExecutionScope.entry(
            workspaceId: "current-workspace",
            projectId: "current-project",
            organizationId: "current-org"
        )

        XCTAssertEqual(
            ConversationExecutionScope.resolvingFrozenSession(
                workspaceId: nil,
                projectId: nil,
                organizationId: nil,
                fallback: entry
            ),
            entry
        )
    }
}
