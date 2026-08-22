import XCTest
@testable import Tabtin

@MainActor
final class ConversationDraftSessionCoordinatorTests: XCTestCase {
    private actor CreationCounter {
        private var calls = 0

        func create() async throws -> String {
            calls += 1
            try await Task.sleep(for: .milliseconds(20))
            return "session-\(calls)"
        }

        func count() -> Int { calls }
    }

    private actor RetryCounter {
        private var calls = 0

        func create() throws -> String {
            calls += 1
            if calls == 1 { throw TestError.expected }
            return "session-retry"
        }

        func count() -> Int { calls }
    }

    private enum TestError: Error {
        case expected
    }

    private func makeCoordinator() -> ConversationDraftSessionCoordinator {
        ConversationDraftSessionCoordinator(
            draft: ConversationDraftState(
                id: "draft-stable-id",
                workspaceId: "workspace-id",
                organizationId: "organization-id",
                agentId: "agent-id",
                projectId: nil
            )
        )
    }

    func testDraftIdStaysStableBeforeSessionCreation() {
        let coordinator = makeCoordinator()

        XCTAssertEqual(coordinator.draftId, "draft-stable-id")
        XCTAssertNil(coordinator.sessionId)
    }

    func testConcurrentSessionResolutionCreatesOnlyOneSession() async throws {
        let coordinator = makeCoordinator()
        let counter = CreationCounter()

        let first = Task { @MainActor in
            try await coordinator.ensureSession { try await counter.create() }
        }
        let second = Task { @MainActor in
            try await coordinator.ensureSession { try await counter.create() }
        }

        let firstId = try await first.value
        let secondId = try await second.value
        let creationCount = await counter.count()

        XCTAssertEqual(firstId, "session-1")
        XCTAssertEqual(secondId, "session-1")
        XCTAssertEqual(creationCount, 1)
    }

    func testFailedCreationCanBeRetriedWithoutReplacingDraft() async throws {
        let coordinator = makeCoordinator()
        let counter = RetryCounter()

        do {
            _ = try await coordinator.ensureSession {
                try await counter.create()
            }
            XCTFail("expected creation failure")
        } catch TestError.expected {
            // expected
        }

        let sessionId = try await coordinator.ensureSession {
            try await counter.create()
        }
        let retryCount = await counter.count()

        XCTAssertEqual(sessionId, "session-retry")
        XCTAssertEqual(coordinator.draftId, "draft-stable-id")
        XCTAssertEqual(retryCount, 2)
    }

    func testFirstSendGateRejectsRepeatedTapUntilFinished() {
        let coordinator = makeCoordinator()

        XCTAssertTrue(coordinator.beginFirstSend())
        XCTAssertFalse(coordinator.beginFirstSend())
        coordinator.finishFirstSend()
        XCTAssertTrue(coordinator.beginFirstSend())
    }

    func testAgentSelectionChangesDraftBeforeFirstSend() {
        let coordinator = makeCoordinator()

        XCTAssertTrue(coordinator.selectAgent(id: "agent-next"))
        XCTAssertEqual(coordinator.agentId, "agent-next")
        XCTAssertEqual(coordinator.draft.agentId, "agent-next")
    }

    func testExecutionWorkspaceSelectionUpdatesDraftBeforeFirstSend() {
        let coordinator = makeCoordinator()

        XCTAssertTrue(
            coordinator.selectExecutionWorkspace(
                workspaceId: " workspace-next ",
                organizationId: " organization-next ",
                projectId: " project-next "
            )
        )
        XCTAssertEqual(coordinator.draftId, "draft-stable-id")
        XCTAssertEqual(coordinator.draft.workspaceId, "workspace-next")
        XCTAssertEqual(coordinator.draft.organizationId, "organization-next")
        XCTAssertEqual(coordinator.draft.projectId, "project-next")
        XCTAssertEqual(coordinator.agentId, "agent-id")
    }

    func testExecutionWorkspaceSelectionIsLockedDuringAndAfterFirstSend() async throws {
        let coordinator = makeCoordinator()
        let counter = CreationCounter()

        XCTAssertTrue(coordinator.beginFirstSend())
        XCTAssertFalse(
            coordinator.selectExecutionWorkspace(
                workspaceId: "workspace-during-send",
                organizationId: "organization-during-send",
                projectId: nil
            )
        )
        coordinator.finishFirstSend()

        _ = try await coordinator.ensureSession { try await counter.create() }

        XCTAssertFalse(
            coordinator.selectExecutionWorkspace(
                workspaceId: "workspace-after-session",
                organizationId: "organization-after-session",
                projectId: nil
            )
        )
        XCTAssertEqual(coordinator.draft.workspaceId, "workspace-id")
    }

    func testAgentSelectionIsLockedDuringAndAfterFirstSend() async throws {
        let coordinator = makeCoordinator()
        let counter = CreationCounter()

        XCTAssertTrue(coordinator.beginFirstSend())
        XCTAssertFalse(coordinator.selectAgent(id: "agent-during-send"))
        coordinator.finishFirstSend()

        _ = try await coordinator.ensureSession { try await counter.create() }

        XCTAssertFalse(coordinator.selectAgent(id: "agent-after-session"))
        XCTAssertEqual(coordinator.agentId, "agent-id")
    }

    func testRestoreReusesStableDraftAndPendingSession() async throws {
        let coordinator = makeCoordinator()
        let counter = CreationCounter()

        XCTAssertTrue(
            coordinator.restore(
                draftId: "draft-restored",
                agentId: "agent-restored",
                pendingSessionId: "session-existing"
            )
        )

        let sessionId = try await coordinator.ensureSession { try await counter.create() }

        XCTAssertEqual(coordinator.draftId, "draft-restored")
        XCTAssertEqual(coordinator.agentId, "agent-restored")
        XCTAssertEqual(sessionId, "session-existing")
        let createCount = await counter.count()
        XCTAssertEqual(createCount, 0)
    }

    func testRotateDraftIdentityForConflictRetryMintsNewId() {
        let coordinator = makeCoordinator()
        let original = coordinator.draftId

        let rotated = coordinator.rotateDraftIdentityForConflictRetry()

        XCTAssertNotNil(rotated)
        XCTAssertNotEqual(rotated, original)
        XCTAssertEqual(coordinator.draftId, rotated)
        XCTAssertNil(coordinator.sessionId)
        XCTAssertEqual(coordinator.draft.workspaceId, "workspace-id")
        XCTAssertEqual(coordinator.agentId, "agent-id")
    }

    func testRotateDraftIdentityRejectedAfterSessionBound() async throws {
        let coordinator = makeCoordinator()
        let counter = CreationCounter()
        _ = try await coordinator.ensureSession { try await counter.create() }

        XCTAssertNil(coordinator.rotateDraftIdentityForConflictRetry())
        XCTAssertEqual(coordinator.draftId, "draft-stable-id")
    }
}
