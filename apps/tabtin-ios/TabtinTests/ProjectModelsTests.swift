import XCTest
@testable import Tabtin

final class ProjectModelsTests: XCTestCase {
    func testProjectDetailDecodesCompanionWorkspaceSeparately() throws {
        let data = Data(
            """
            {
              "id": "project-1",
              "organization_id": "organization-1",
              "type": "team_space",
              "name": "Mobile Launch",
              "description": "  Ship the mobile client  ",
              "status": "active",
              "member_count": 4,
              "my_workspace": {
                "id": "workspace-1",
                "name": "My Mobile Workspace",
                "working_dir": "/Users/me/mobile",
                "control_device_id": "device-1",
                "control_device_status": "online",
                "is_companion": true
              }
            }
            """.utf8
        )

        let project = try JSONDecoder().decode(Project.self, from: data)

        XCTAssertEqual(project.name, "Mobile Launch")
        XCTAssertEqual(project.displayDescription, "Ship the mobile client")
        XCTAssertEqual(project.memberCount, 4)
        XCTAssertEqual(project.myWorkspace?.id, "workspace-1")
        XCTAssertEqual(project.myWorkspace?.workingDir, "/Users/me/mobile")
    }

    func testPendingInvitationKeepsProjectIdentityWithoutExecutionFields() throws {
        let data = Data(
            """
            {
              "project_id": "project-1",
              "project_name": "Mobile Launch",
              "organization_id": "organization-1",
              "role": "editor",
              "inviter_name": "Ada",
              "invited_at": "2026-07-18T00:00:00Z"
            }
            """.utf8
        )

        let invitation = try JSONDecoder().decode(PendingProjectInvitation.self, from: data)

        XCTAssertEqual(invitation.id, "project-1")
        XCTAssertEqual(invitation.projectName, "Mobile Launch")
        XCTAssertEqual(invitation.role, "editor")
    }

    func testDiscussionDefaultsReadOnlyPresentationFields() throws {
        let data = Data(
            """
            {
              "id": "channel-1",
              "organization_id": "organization-1",
              "space_id": "project-1",
              "is_team_space_channel": true,
              "name": "#general"
            }
            """.utf8
        )

        let discussion = try JSONDecoder().decode(ProjectDiscussion.self, from: data)

        XCTAssertTrue(discussion.isTeamSpaceChannel)
        XCTAssertFalse(discussion.isArchived)
        XCTAssertEqual(discussion.unreadCount, 0)
    }

    func testActivityMetadataDecodesForTimeline() throws {
        let data = Data(
            """
            {
              "id": "activity-1",
              "event_type": "agent_run_completed",
              "actor_user_id": "user-1",
              "actor_name": "Ada",
              "target_type": "agent_run",
              "target_id": "run-1",
              "target_name": "Release audit",
              "metadata": { "session_id": "session-1" },
              "created_at": "2026-07-18T00:00:00Z"
            }
            """.utf8
        )

        let event = try JSONDecoder().decode(ProjectActivityEvent.self, from: data)

        XCTAssertEqual(event.eventType, "agent_run_completed")
        XCTAssertEqual(event.metadata?["session_id"]?.stringValue, "session-1")
    }

    func testMembershipDecodesFormalAgentResponsibility() throws {
        let data = Data(
            """
            {
              "id": "membership-1",
              "space_id": "project-1",
              "agent_id": "agent-1",
              "role": "editor",
              "is_active": true,
              "role_label": "Quality Lead",
              "responsibility": "Own release quality and evidence",
              "persona_override": "Be strict"
            }
            """.utf8
        )

        let membership = try JSONDecoder().decode(ProjectMembership.self, from: data)

        XCTAssertEqual(membership.agentId, "agent-1")
        XCTAssertEqual(membership.roleLabel, "Quality Lead")
        XCTAssertEqual(membership.responsibility, "Own release quality and evidence")
    }

    func testRecentProjectSessionUsesCompanionWorkspaceInsteadOfProjectedSpace() throws {
        let data = Data(
            """
            {
              "id": "session-1",
              "title": "Release audit",
              "organization_id": "organization-1",
              "space_id": "project-1",
              "workspace_id": "workspace-1",
              "space_name": "Allen's Space",
              "project_id": "project-1",
              "project_name": "Mobile Launch",
              "agent_id": "agent-1"
            }
            """.utf8
        )

        let session = try JSONDecoder().decode(RecentSession.self, from: data)

        XCTAssertEqual(session.workspaceId, "workspace-1")
        XCTAssertEqual(session.executionWorkspaceId, "workspace-1")
        XCTAssertEqual(session.spaceName, "Allen's Space")
        XCTAssertEqual(session.projectId, "project-1")
        XCTAssertEqual(session.projectName, "Mobile Launch")
        XCTAssertEqual(session.agentId, "agent-1")

        let target = try XCTUnwrap(
            RecentConversationTargetResolver.resolve(session, fallbackOrganizationId: nil)
        )
        XCTAssertEqual(target.workspaceId, "workspace-1")
        XCTAssertEqual(target.projectId, "project-1")
        XCTAssertEqual(target.agentId, "agent-1")
    }

    func testRecentProjectSessionWithoutWorkspaceIsNotNavigable() throws {
        let data = Data(
            """
            {
              "id": "session-1",
              "organization_id": "organization-1",
              "space_id": "project-1",
              "project_id": "project-1"
            }
            """.utf8
        )

        let session = try JSONDecoder().decode(RecentSession.self, from: data)

        XCTAssertNil(RecentConversationTargetResolver.resolve(session, fallbackOrganizationId: nil))
    }

    func testProjectSessionWithoutExecutionWorkspaceDoesNotTreatProjectAsWorkspace() throws {
        let session = try JSONDecoder().decode(RecentSession.self, from: Data(
            """
            {
              "id": "observer-session",
              "space_id": "project-1",
              "project_id": "project-1"
            }
            """.utf8
        ))

        XCTAssertNil(session.executionWorkspaceId)
    }

    func testRecentSessionQueryNormalizesSearchAndBuildsServerPaginationParameters() {
        let query = RecentSessionsQuery(keyword: "  release audit  ", status: nil, limit: 0)

        XCTAssertEqual(query.keyword, "release audit")
        XCTAssertNil(query.status)
        XCTAssertEqual(query.limit, 1)
        XCTAssertEqual(
            query.parameters(organizationId: "org-1", offset: -4),
            ["organization_id": "org-1", "limit": "1", "offset": "0", "keyword": "release audit"]
        )
    }

    func testRecentSessionsQueryEmitsWorkspaceAndRunStatusParameters() {
        let query = RecentSessionsQuery(
            keyword: nil, status: "active", workspaceId: "ws-1", runStatus: "waiting_user"
        )
        let params = query.parameters(organizationId: "org-1", offset: 0)
        XCTAssertEqual(params["workspace_id"], "ws-1")
        XCTAssertEqual(params["run_status"], "waiting_user")
        XCTAssertEqual(params["status"], "active")
    }

    func testRecentSessionsQueryOmitsBlankFilters() {
        let query = RecentSessionsQuery(
            keyword: nil, status: "active", workspaceId: "   ", runStatus: nil
        )
        let params = query.parameters(organizationId: "org-1", offset: 0)
        XCTAssertNil(params["workspace_id"])
        XCTAssertNil(params["run_status"])
    }

    /// 筛选变化必须改变 query 的相等性，否则 store 的 generation 守卫不会重拉。
    func testRecentSessionsQueryEqualityAccountsForNewFilters() {
        let base = RecentSessionsQuery(keyword: nil, status: "active")
        let scoped = RecentSessionsQuery(keyword: nil, status: "active", workspaceId: "ws-1")
        XCTAssertNotEqual(base, scoped)
    }

    func testRecentSessionDecodesSearchMatchContextAndPaginationMergeDeduplicates() throws {
        let first = try JSONDecoder().decode(RecentSession.self, from: Data("""
        {"id":"session-1","title":"One","search_match_context":"…release evidence…"}
        """.utf8))
        let duplicate = try JSONDecoder().decode(RecentSession.self, from: Data("""
        {"id":"session-1","title":"Updated"}
        """.utf8))
        let second = try JSONDecoder().decode(RecentSession.self, from: Data("""
        {"id":"session-2","title":"Two"}
        """.utf8))

        XCTAssertEqual(first.searchMatchContext, "…release evidence…")
        XCTAssertEqual(
            RecentSessionsListPolicy.appendUnique(existing: [first], incoming: [duplicate, second]).map(\.id),
            ["session-1", "session-2"]
        )
    }
}
