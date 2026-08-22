import XCTest
@testable import Tabtin

final class ConversationAgentSelectionPolicyTests: XCTestCase {
    func testPersonalWorkspaceFormalSessionCanChangeAgent() {
        XCTAssertTrue(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace: false,
                isFirstSendInFlight: false,
                isUpdating: false
            )
        )
    }

    func testProjectCompanionWorkspaceRemainsMutable() {
        XCTAssertTrue(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace: false,
                isFirstSendInFlight: false,
                isUpdating: false
            ),
            "Project 的个人执行 Workspace 不应因为 Session 带 project_id 而被锁定"
        )
    }

    func testTeamSpaceAndTransitionStatesAreLocked() {
        XCTAssertFalse(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace: true,
                isFirstSendInFlight: false,
                isUpdating: false
            )
        )
        XCTAssertFalse(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace: false,
                isFirstSendInFlight: true,
                isUpdating: false
            )
        )
        XCTAssertFalse(
            ConversationAgentSelectionPolicy.canChange(
                isTeamSpace: false,
                isFirstSendInFlight: false,
                isUpdating: true
            )
        )
    }
}
