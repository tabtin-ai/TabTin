import XCTest
@testable import Tabtin

final class PushServiceTests: XCTestCase {
    func testTokenUploadRetryPolicyUsesBoundedBackoff() {
        XCTAssertEqual(PushTokenUploadRetryPolicy.delay(afterFailure: 0), 2)
        XCTAssertEqual(PushTokenUploadRetryPolicy.delay(afterFailure: 1), 10)
        XCTAssertEqual(PushTokenUploadRetryPolicy.delay(afterFailure: 2), 30)
        XCTAssertEqual(PushTokenUploadRetryPolicy.delay(afterFailure: 3), 120)
        XCTAssertNil(PushTokenUploadRetryPolicy.delay(afterFailure: 4))
    }

    func testAgentActionPushCarriesOrganizationConversationAndMessageRoute() {
        let ext = """
        {
          "scene": "interaction_requested",
          "organization_id": "organization-b",
          "workspace_id": "workspace-b",
          "project_id": "project-b",
          "session_id": "session-9",
          "message_id": "message-7"
        }
        """

        XCTAssertEqual(
            AgentPushRouteIntent.parse(ext),
            AgentPushRouteIntent(
                organizationId: "organization-b",
                workspaceId: "workspace-b",
                projectId: "project-b",
                sessionId: "session-9",
                messageId: "message-7"
            )
        )
    }

    func testAgentActionPushSwitchesOrganizationBeforeOpeningConversation() {
        let intent = AgentPushRouteIntent(
            organizationId: "organization-b",
            workspaceId: "workspace-b",
            projectId: nil,
            sessionId: "session-9",
            messageId: nil
        )

        XCTAssertEqual(
            AgentPushNavigationPlanner.nextStep(
                for: intent,
                isSessionReady: true,
                hasLoadedOrganizations: true,
                availableOrganizationIds: ["organization-a", "organization-b"],
                selectedOrganizationId: "organization-a"
            ),
            .selectOrganization("organization-b")
        )
        XCTAssertEqual(
            AgentPushNavigationPlanner.nextStep(
                for: intent,
                isSessionReady: true,
                hasLoadedOrganizations: true,
                availableOrganizationIds: ["organization-a", "organization-b"],
                selectedOrganizationId: "organization-b"
            ),
            .openConversation(intent)
        )
    }

    func testAgentActionPushWithoutMessageFallsBackToConversationBottom() throws {
        let ext = """
        {
          "scene": "interaction_requested",
          "organization_id": "organization-b",
          "space_id": "workspace-b",
          "session_id": "session-9"
        }
        """

        let intent = try XCTUnwrap(AgentPushRouteIntent.parse(ext))
        XCTAssertNil(intent.messageId)
        XCTAssertEqual(intent.workspaceId, "workspace-b")
    }

    func testNativeAPNsPayloadReadsExtensionString() {
        let ext = #"{"scene":"interaction_requested","session_id":"session-9"}"#

        XCTAssertEqual(
            APNsPushPayload.extensionJSON(from: ["ext": ext]),
            ext
        )
    }

    func testNativeAPNsPayloadNormalizesExtensionObject() throws {
        let ext = try XCTUnwrap(APNsPushPayload.extensionJSON(from: [
            "ext": [
                "scene": "im_message",
                "organization_id": "organization-b",
                "conversation_id": "conversation-7",
            ],
        ]))

        XCTAssertEqual(IMPushRouteIntent.parse(ext)?.conversationId, "conversation-7")
    }
}
