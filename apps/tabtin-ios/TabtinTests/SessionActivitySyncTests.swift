import XCTest
@testable import Tabtin

/// ：`chat.session.activity.updated` 目录 upsert / 重排 / 跨组织忽略。
final class SessionActivitySyncTests: XCTestCase {
    func testActivityUpsertsUnknownSession() {
        var sessions: [RecentSession] = [
            RecentSession(
                id: "session-old",
                title: "旧会话",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-07-01T10:00:00Z"
            ),
        ]

        let applied = RecentSessionActivityPolicy.apply(
            patch: SessionActivityPatch(
                sessionId: "session-new",
                organizationId: "org-1",
                reason: "created",
                title: "新会话",
                status: "active",
                workspaceId: "ws-1",
                agentId: "agent-1",
                lastMessageAt: "2026-08-01T12:00:00Z",
                updatedAt: "2026-08-01T12:00:00Z",
                createdAt: "2026-08-01T12:00:00Z"
            ),
            selectedOrganizationId: "org-1",
            expectedStatus: "active",
            sessions: &sessions
        )

        XCTAssertTrue(applied)
        XCTAssertEqual(sessions.map(\.id), ["session-new", "session-old"])
        let inserted = sessions.first { $0.id == "session-new" }
        XCTAssertEqual(inserted?.title, "新会话")
        XCTAssertEqual(inserted?.workspaceId, "ws-1")
        XCTAssertEqual(inserted?.agentId, "agent-1")
        XCTAssertEqual(inserted?.lastMessageAt, "2026-08-01T12:00:00Z")
    }

    func testActivityBumpsLastMessageAtToFront() {
        var sessions: [RecentSession] = [
            RecentSession(
                id: "session-a",
                title: "靠前",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-08-01T12:00:00Z"
            ),
            RecentSession(
                id: "session-b",
                title: "靠后",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-07-01T10:00:00Z"
            ),
        ]

        let applied = RecentSessionActivityPolicy.apply(
            patch: SessionActivityPatch(
                sessionId: "session-b",
                organizationId: "org-1",
                reason: "message",
                lastMessageAt: "2026-08-01T13:00:00Z",
                updatedAt: "2026-08-01T13:00:00Z"
            ),
            selectedOrganizationId: "org-1",
            expectedStatus: "active",
            sessions: &sessions
        )

        XCTAssertTrue(applied)
        XCTAssertEqual(sessions.map(\.id), ["session-b", "session-a"])
        XCTAssertEqual(
            sessions.first { $0.id == "session-b" }?.lastMessageAt,
            "2026-08-01T13:00:00Z"
        )
        XCTAssertEqual(sessions.first { $0.id == "session-a" }?.title, "靠前")
    }

    func testActivityIgnoresCrossOrganizationEvents() {
        var sessions: [RecentSession] = [
            RecentSession(
                id: "session-a",
                title: "本组织",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-07-01T10:00:00Z"
            ),
        ]
        let before = sessions

        let applied = RecentSessionActivityPolicy.apply(
            patch: SessionActivityPatch(
                sessionId: "session-other",
                organizationId: "org-2",
                reason: "created",
                title: "别的组织",
                status: "active",
                lastMessageAt: "2026-08-01T15:00:00Z"
            ),
            selectedOrganizationId: "org-1",
            expectedStatus: "active",
            sessions: &sessions
        )

        XCTAssertFalse(applied)
        XCTAssertEqual(sessions.map(\.id), before.map(\.id))
        XCTAssertEqual(sessions.first?.title, "本组织")
    }

    func testExecutionAgentOverrideSurvivesStaleListReload() {
        let sessions = [
            RecentSession(
                id: "session-a",
                title: "任务",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-08-01T12:00:00Z",
                agentId: "agent-old",
                agentName: "旧 Agent",
                agentAvatar: "code-engineer"
            ),
        ]
        let overrides = [
            "session-a": RecentSessionExecutionAgentOverride(
                agentId: "agent-new",
                agentName: "冲浪版",
                agentAvatar: "web-researcher"
            ),
        ]

        let merged = RecentSessionExecutionAgentOverridePolicy.merging(
            sessions: sessions,
            overrides: overrides
        )

        XCTAssertTrue(merged.resolvedSessionIds.isEmpty)
        XCTAssertEqual(merged.sessions.first?.agentId, "agent-new")
        XCTAssertEqual(merged.sessions.first?.agentName, "冲浪版")
        XCTAssertEqual(merged.sessions.first?.agentAvatar, "web-researcher")
    }

    func testExecutionAgentOverrideClearsWhenListCatchesUp() {
        let sessions = [
            RecentSession(
                id: "session-a",
                title: "任务",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-08-01T12:00:00Z",
                agentId: "agent-new",
                agentName: nil,
                agentAvatar: nil
            ),
        ]
        let overrides = [
            "session-a": RecentSessionExecutionAgentOverride(
                agentId: "agent-new",
                agentName: "冲浪版",
                agentAvatar: "web-researcher"
            ),
        ]

        let merged = RecentSessionExecutionAgentOverridePolicy.merging(
            sessions: sessions,
            overrides: overrides
        )

        XCTAssertEqual(merged.resolvedSessionIds, ["session-a"])
        XCTAssertEqual(merged.sessions.first?.agentId, "agent-new")
        XCTAssertEqual(merged.sessions.first?.agentName, "冲浪版")
        XCTAssertEqual(merged.sessions.first?.agentAvatar, "web-researcher")
    }

    func testActivityAgentSwitchReplacesStaleAvatar() {
        var sessions: [RecentSession] = [
            RecentSession(
                id: "session-a",
                title: "任务",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-08-01T12:00:00Z",
                agentId: "agent-old",
                agentName: "旧 Agent",
                agentAvatar: "code-engineer"
            ),
        ]

        let applied = RecentSessionActivityPolicy.apply(
            patch: SessionActivityPatch(
                sessionId: "session-a",
                organizationId: "org-1",
                reason: "agent_switched",
                agentId: "agent-new",
                agentName: "冲浪版",
                agentAvatar: "web-researcher",
                updatedAt: "2026-08-01T13:00:00Z"
            ),
            selectedOrganizationId: "org-1",
            expectedStatus: "active",
            sessions: &sessions
        )

        XCTAssertTrue(applied)
        let row = sessions.first { $0.id == "session-a" }
        XCTAssertEqual(row?.agentId, "agent-new")
        XCTAssertEqual(row?.agentName, "冲浪版")
        XCTAssertEqual(row?.agentAvatar, "web-researcher")
    }

    func testActivityAgentIdOnlyClearsStaleFace() {
        var sessions: [RecentSession] = [
            RecentSession(
                id: "session-a",
                title: "任务",
                status: "active",
                organizationId: "org-1",
                lastMessageAt: "2026-08-01T12:00:00Z",
                agentId: "agent-old",
                agentName: "旧 Agent",
                agentAvatar: "code-engineer"
            ),
        ]

        let applied = RecentSessionActivityPolicy.apply(
            patch: SessionActivityPatch(
                sessionId: "session-a",
                organizationId: "org-1",
                reason: "message",
                agentId: "agent-new"
            ),
            selectedOrganizationId: "org-1",
            expectedStatus: "active",
            sessions: &sessions
        )

        XCTAssertTrue(applied)
        let row = sessions.first { $0.id == "session-a" }
        XCTAssertEqual(row?.agentId, "agent-new")
        XCTAssertNil(row?.agentName)
        XCTAssertNil(row?.agentAvatar)
    }

    func testRecentSessionValueChangesWhenExecutionAgentFaceChanges() {
        let before = RecentSession(
            id: "session-a",
            title: "任务",
            status: "active",
            organizationId: "org-1",
            agentId: "agent-old",
            agentName: "旧 Agent",
            agentAvatar: "web-researcher"
        )
        let after = RecentSession(
            id: "session-a",
            title: "任务",
            status: "active",
            organizationId: "org-1",
            agentId: "agent-new",
            agentName: "代码版",
            agentAvatar: "code-engineer"
        )

        XCTAssertNotEqual(before, after)
    }

    func testActivityEnvelopeParsesNonEmptyFieldsOnly() throws {
        let envelope = try JSONDecoder().decode(
            WSEnvelope.self,
            from: Data(
                """
                {
                  "v": 1,
                  "type": "chat.session.activity.updated",
                  "request_id": "req-activity",
                  "ts": 1,
                  "device_id": "server",
                  "role": "server",
                  "payload": {
                    "session_id": "session-8605",
                    "organization_id": "org-8605",
                    "reason": "message",
                    "title": "跨端标题",
                    "status": "active",
                    "workspace_id": "ws-8605",
                    "project_id": null,
                    "agent_id": "",
                    "last_message_at": "2026-08-01T14:00:00Z",
                    "updated_at": "2026-08-01T14:00:00Z",
                    "created_at": "2026-07-01T08:00:00Z",
                    "thread_id": "thread-1"
                  }
                }
                """.utf8
            )
        )

        let patch = try XCTUnwrap(SessionActivityPatch(envelope: envelope))
        XCTAssertEqual(patch.sessionId, "session-8605")
        XCTAssertEqual(patch.organizationId, "org-8605")
        XCTAssertEqual(patch.title, "跨端标题")
        XCTAssertEqual(patch.workspaceId, "ws-8605")
        XCTAssertNil(patch.projectId)
        XCTAssertNil(patch.agentId)
        XCTAssertEqual(patch.lastMessageAt, "2026-08-01T14:00:00Z")
        XCTAssertEqual(patch.threadId, "thread-1")
    }
}
