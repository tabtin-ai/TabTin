import XCTest
@testable import Tabtin

final class NotificationTargetResolverTests: XCTestCase {
    func testDesktopOnlyNotificationFlagUsesWireMetadata() {
        XCTAssertTrue(
            notification(metadata: ["desktop_only": AnyCodable(true)]).isDesktopOnly
        )
        XCTAssertFalse(notification().isDesktopOnly)
    }

    func testNotificationFilterOrderMatchesSharedMobileContract() {
        XCTAssertEqual(
            MobileNotificationFilter.allCases,
            [.all, .pending, .task, .collaboration, .organization, .system]
        )
    }

    func testNotificationCategoryContractMatchesAndroid() {
        let cases: [(String, MobileNotificationCategory)] = [
            ("agent.task.completed", .task),
            ("tracker.run.failed", .task),
            ("im.message", .collaboration),
            ("tabdoc.comment.mention", .collaboration),
            ("tabdata.row.updated", .collaboration),
            ("resource_shared", .collaboration),
            ("resource_access_request", .collaboration),
            ("tabmail.received", .collaboration),
            ("tabinbox.received", .collaboration),
            ("tabinbox.route", .collaboration),
            ("organization.invitation", .organization),
            ("team_space.member_added", .organization),
            ("invite_received", .organization),
            ("member_added", .organization),
            ("role_changed", .organization),
            ("ownership_transfer", .organization),
            ("quota_warning", .system),
            ("future.event", .system),
        ]

        for (type, expected) in cases {
            XCTAssertEqual(
                MobileNotificationPresentationPolicy.category(for: type),
                expected,
                type
            )
        }
    }

    func testPendingFilterUsesSharedActionContractAndUrgentPriority() {
        for type in [
            "agent.hitl.waiting",
            "agent.task.error",
            "tracker.run.failed",
            "resource_access_request",
            "organization.invitation",
            "invite_received",
        ] {
            XCTAssertTrue(
                MobileNotificationPresentationPolicy.isPending(notification(type: type)),
                type
            )
        }

        XCTAssertTrue(
            MobileNotificationPresentationPolicy.isPending(
                notification(type: "future.event", priority: "urgent")
            )
        )
        XCTAssertFalse(
            MobileNotificationPresentationPolicy.isPending(
                notification(type: "agent.task.completed", priority: "high")
            )
        )
    }

    func testResolvedResourceAccessLeavesPendingAndCannotReopenApproval() {
        let requestId = "request-1"
        let pending = notification(
            id: "access-1",
            type: "resource_access_request",
            metadata: [
                "request_id": AnyCodable(requestId),
                "behavior": AnyCodable("action_required"),
            ]
        )
        let resolved = notification(
            id: "access-1",
            type: "resource_access_request",
            metadata: [
                "request_id": AnyCodable(requestId),
                "resolved": AnyCodable(true),
                "request_status": AnyCodable("approved"),
                "behavior": AnyCodable("notification_only"),
            ],
            isRead: true
        )

        XCTAssertTrue(MobileNotificationPresentationPolicy.isPending(pending))
        XCTAssertFalse(MobileNotificationPresentationPolicy.isPending(resolved))
        XCTAssertTrue(
            MobileNotificationPresentationPolicy.hasPendingResourceAccessRequest(
                in: [pending],
                requestId: requestId
            )
        )
        XCTAssertFalse(
            MobileNotificationPresentationPolicy.hasPendingResourceAccessRequest(
                in: [resolved],
                requestId: requestId
            )
        )
        XCTAssertEqual(MobileNotificationTargetResolver.resolve(resolved), .unsupported)
    }

    func testFilterProjectionPreservesTimeFlowOrder() {
        let first = notification(id: "first", type: "im.message")
        let second = notification(id: "second", type: "tabdoc.comment.mention")
        let third = notification(id: "third", type: "tracker.run.completed")

        XCTAssertEqual(
            MobileNotificationPresentationPolicy.filtered(
                [first, second, third],
                by: .collaboration
            ).map(\.id),
            ["first", "second"]
        )
    }

    func testSourceContractUsesProductSourceInsteadOfScope() {
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.source(for: notification(type: "agent.task.completed")),
            .tabAgent
        )
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.source(for: notification(type: "tracker.run.completed")),
            .tabTracker
        )
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.source(for: notification(type: "im.message")),
            .tabChat
        )
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.source(for: notification(type: "tabdoc.comment.mention")),
            .tabDoc
        )
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.source(for: notification(type: "tabdata.row.updated")),
            .tabData
        )
        for type in ["tabinbox.received", "tabinbox.route"] {
            XCTAssertEqual(
                MobileNotificationPresentationPolicy.source(
                    for: notification(type: type, sourceExtensionId: "tabinbox")
                ),
                .tabInbox,
                type
            )
        }
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.source(
                for: notification(type: "future.event", sourceExtensionId: "extension-1")
            ),
            .extensionEvent
        )
    }

    func testWireScopePrefersNewFieldsAndKeepsLegacyHostHonest() throws {
        let item = try JSONDecoder().decode(MobileNotification.self, from: Data(#"""
        {
          "id":"notification-1","type":"tracker.run.completed","title":"done","body":"",
          "metadata":{"workspace_id":"workspace-metadata","project_id":"project-metadata"},
          "organization_id":"org-1","workspace_id":"workspace-root","project_id":"project-root",
          "space_id":"legacy-host","is_read":false,"created_at":"2026-07-17T10:00:00Z"
        }
        """#.utf8))

        XCTAssertEqual(item.workspaceId, "workspace-root")
        XCTAssertEqual(item.projectId, "project-root")
        XCTAssertEqual(item.legacyHostId, "legacy-host")
    }

    func testWireLegacyHostDoesNotMasqueradeAsWorkspace() throws {
        let item = try JSONDecoder().decode(MobileNotification.self, from: Data(#"""
        {
          "id":"notification-1","type":"resource_shared","title":"shared","body":"",
          "metadata":{},"organization_id":"org-1","space_id":"historical-project-host",
          "is_read":false,"created_at":"2026-07-17T10:00:00Z"
        }
        """#.utf8))

        XCTAssertNil(item.workspaceId)
        XCTAssertNil(item.projectId)
        XCTAssertEqual(item.legacyHostId, "historical-project-host")
    }

    func testSharedResourceWithoutHostStillResolvesForTrustedNotificationRouting() {
        let item = notification(
            type: "resource_shared",
            metadata: [
                "resource_type": AnyCodable("tabdoc"),
                "resource_id": AnyCodable("doc-1"),
            ],
            organizationId: "org-1"
        )

        guard case let .sharedResource(
            id, resourceType, _, organizationId, workspaceId, projectId, legacyHostId
        ) = MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected shared resource target")
        }
        XCTAssertEqual(id, "doc-1")
        XCTAssertEqual(resourceType, "tabdoc")
        XCTAssertEqual(organizationId, "org-1")
        XCTAssertNil(workspaceId)
        XCTAssertNil(projectId)
        XCTAssertNil(legacyHostId)

        let routeTarget = ResourceDeepLinkTarget(
            resourceType: resourceType,
            resourceId: id,
            title: nil,
            locationHint: nil,
            organizationId: "org-1",
            spaceId: nil
        )
        XCTAssertNil(routeTarget.spaceId)
    }

    func testExternalResourceURLStillRequiresLegacyHostContext() throws {
        let url = try XCTUnwrap(URL(string:
            "tabtin://resource/tabdoc/doc-1?organization_id=org-1"
        ))

        XCTAssertEqual(ResourceDeepLinkParser.parse(url), .missingContext)
    }

    func testMetadataNavigationLegacyHostIsAcceptedAtWireBoundary() {
        let item = notification(
            type: "system",
            metadata: [
                "navigate_to": AnyCodable([
                    "type": "resource-shared",
                    "id": "doc-1",
                    "resource_type": "tabdoc",
                    "space_id": "historical-project-host",
                ]),
            ],
            organizationId: "org-1"
        )

        guard case let .sharedResource(
            id, _, _, _, workspaceId, projectId, legacyHostId
        ) = MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected metadata navigate_to target")
        }
        XCTAssertEqual(id, "doc-1")
        XCTAssertNil(workspaceId)
        XCTAssertNil(projectId)
        XCTAssertEqual(legacyHostId, "historical-project-host")
    }

    func testNotificationContextPrefersProjectThenWorkspaceName() throws {
        let projectItem = try JSONDecoder().decode(MobileNotification.self, from: Data(#"""
        {
          "id":"notification-1","type":"agent.task.completed","title":"done","body":"",
          "metadata":{"workspace_name":"个人 Workspace","project_name":"移动端改版"},
          "organization_id":"org-1","is_read":false,"created_at":"2026-07-17T10:00:00Z"
        }
        """#.utf8))
        let workspaceItem = try JSONDecoder().decode(MobileNotification.self, from: Data(#"""
        {
          "id":"notification-2","type":"agent.task.completed","title":"done","body":"",
          "metadata":{"workspace_name":"个人 Workspace"},
          "organization_id":"org-1","is_read":false,"created_at":"2026-07-17T10:00:00Z"
        }
        """#.utf8))

        XCTAssertEqual(MobileNotificationPresentationPolicy.contextName(for: projectItem), "移动端改版")
        XCTAssertEqual(MobileNotificationPresentationPolicy.contextName(for: workspaceItem), "个人 Workspace")
    }

    func testLegacyTeamSpaceNotificationUsesProjectSemanticsWithoutMutatingWireCopy() throws {
        let item = try JSONDecoder().decode(MobileNotification.self, from: Data(#"""
        {
          "id":"notification-1","type":"team_space.member_added",
          "title":"你已加入团队 Space","body":"欢迎进入项目房间",
          "metadata":{"space_name":"移动端项目"},
          "organization_id":"org-1","space_id":"legacy-project-host",
          "is_read":false,"created_at":"2026-07-17T10:00:00Z"
        }
        """#.utf8))

        XCTAssertEqual(MobileNotificationPresentationPolicy.category(for: item.type), .organization)
        XCTAssertEqual(MobileNotificationPresentationPolicy.source(for: item), .organization)
        XCTAssertNil(item.workspaceId)
        XCTAssertEqual(item.projectId, "legacy-project-host")
        XCTAssertEqual(item.legacyHostId, "legacy-project-host")
        XCTAssertEqual(MobileNotificationPresentationPolicy.contextName(for: item), "移动端项目")
        XCTAssertEqual(MobileNotificationPresentationPolicy.displayTitle(for: item), "你已加入项目")
        XCTAssertEqual(MobileNotificationPresentationPolicy.displayBody(for: item), "欢迎进入项目")
        XCTAssertEqual(item.title, "你已加入团队 Space")
        XCTAssertEqual(item.body, "欢迎进入项目房间")
    }

    func testEveryLegacyTeamSpaceEventNormalizesChineseAndEnglishProjectCopy() {
        let item = notification(
            type: "team_space.member_removed",
            title: "已离开团队空间 / TEAM SPACE",
            body: "The Project Room is no longer available"
        )

        XCTAssertEqual(
            MobileNotificationPresentationPolicy.displayTitle(for: item),
            "已离开项目 / Project"
        )
        XCTAssertEqual(
            MobileNotificationPresentationPolicy.displayBody(for: item),
            "The project is no longer available"
        )
        XCTAssertEqual(item.title, "已离开团队空间 / TEAM SPACE")
        XCTAssertEqual(item.body, "The Project Room is no longer available")
    }

    func testConversationTitlePrefersNotificationSubtitle() {
        let item = notification(title: "任务已完成", body: "会话标题")

        XCTAssertEqual(item.conversationTitle, "会话标题")
    }

    func testConversationTitleFallsBackToNotificationTitleWhenSubtitleIsBlank() {
        let item = notification(title: "任务已完成", body: "  \n ")

        XCTAssertEqual(item.conversationTitle, "任务已完成")
    }

    func testExplicitChatTargetInheritsNotificationScope() throws {
        let item = notification(
            type: "agent.task.completed",
            metadata: [
                "workspace_id": AnyCodable("workspace-1"),
                "project_id": AnyCodable("project-1"),
            ],
            organizationId: "org-1",
            navigateTo: [
                "type": AnyCodable("chat-session"),
                "id": AnyCodable("session-1"),
                "messageId": AnyCodable("message-1"),
            ]
        )

        guard case let .chatSession(id, messageId, organizationId, workspaceId, projectId) =
            MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected chat-session target")
        }
        XCTAssertEqual(id, "session-1")
        XCTAssertEqual(messageId, "message-1")
        XCTAssertEqual(organizationId, "org-1")
        XCTAssertEqual(workspaceId, "workspace-1")
        XCTAssertEqual(projectId, "project-1")
    }

    func testChatNotificationMissingWorkspaceUsesAuthoritativeSessionScope() throws {
        let notificationTarget = MobileNotificationTarget.chatSession(
            id: "session-1",
            messageId: "message-1",
            organizationId: nil,
            workspaceId: nil,
            projectId: nil
        )
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "session-1",
            "organization_id": "org-session",
            "workspace_id": "workspace-session",
            "project_id": "project-session",
        ])
        let session = try JSONDecoder().decode(ChatSession.self, from: data)

        guard case let .chatSession(id, messageId, organizationId, workspaceId, projectId) =
            MobileNotificationChatSessionTargetResolver.resolve(
                notificationTarget,
                session: session
            ) else {
            return XCTFail("expected hydrated chat-session target")
        }

        XCTAssertEqual(id, "session-1")
        XCTAssertEqual(messageId, "message-1")
        XCTAssertEqual(organizationId, "org-session")
        XCTAssertEqual(workspaceId, "workspace-session")
        XCTAssertEqual(projectId, "project-session")
    }

    func testLegacyTrackerHostNormalizesIntoWorkspaceAndOverridesChatTarget() throws {
        let item = notification(
            type: "agent.task.completed",
            metadata: [
                "notification_target": AnyCodable("tracker"),
                "tracker_id": AnyCodable("tracker-1"),
                "run_id": AnyCodable("run-1"),
            ],
            organizationId: "org-1",
            legacyHostId: "space-1",
            navigateTo: [
                "type": AnyCodable("chat-session"),
                "id": AnyCodable("run-transcript"),
            ]
        )

        guard case let .tracker(id, runId, organizationId, workspaceId, projectId) =
            MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected tracker target")
        }
        XCTAssertEqual(id, "tracker-1")
        XCTAssertEqual(runId, "run-1")
        XCTAssertEqual(organizationId, "org-1")
        XCTAssertEqual(workspaceId, "space-1")
        XCTAssertNil(projectId)
    }

    func testExplicitIMConversationTargetResolves() throws {
        let item = notification(
            type: "im.message",
            organizationId: "org-1",
            navigateTo: [
                "type": AnyCodable("im-conversation"),
                "id": AnyCodable("conv-1"),
                "title": AnyCodable("项目群"),
                "messageId": AnyCodable("42"),
            ]
        )

        guard case let .imConversation(id, title, messageId, organizationId) =
            MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected im-conversation target")
        }
        XCTAssertEqual(id, "conv-1")
        XCTAssertEqual(title, "项目群")
        XCTAssertEqual(messageId, "42")
        XCTAssertEqual(organizationId, "org-1")
    }

    func testIMMessageFallsBackToConversationIdWhenNavigateToMissing() throws {
        let item = notification(
            type: "im.message",
            metadata: [
                "conversation_id": AnyCodable("conv-9"),
                "message_id": AnyCodable("7"),
            ],
            organizationId: "org-2"
        )

        guard case let .imConversation(id, _, messageId, organizationId) =
            MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected im-conversation fallback target")
        }
        XCTAssertEqual(id, "conv-9")
        XCTAssertEqual(messageId, "7")
        XCTAssertEqual(organizationId, "org-2")
    }

    func testTabInboxRouteResolvesLikeReceivedProductionNotification() throws {
        let metadata: [String: AnyCodable] = [
            "source_event_id": AnyCodable("mail-event-1"),
            "source_extension_id": AnyCodable("tabinbox"),
            "event_type": AnyCodable("email.received"),
            "message_id": AnyCodable("message-1"),
            "thread_id": AnyCodable("thread-1"),
        ]
        let receivedTarget = MobileNotificationTargetResolver.resolve(notification(
            type: "tabinbox.received",
            metadata: metadata,
            organizationId: "org-1",
            workspaceId: "workspace-1",
            projectId: "project-1"
        ))
        let routeTarget = MobileNotificationTargetResolver.resolve(notification(
            type: "tabinbox.route",
            metadata: metadata,
            organizationId: "org-1",
            workspaceId: "workspace-1",
            projectId: "project-1",
            sourceExtensionId: "tabinbox"
        ))

        XCTAssertEqual(routeTarget, receivedTarget)
        guard case let .app(
            appId, resourceId, _, route, organizationId, workspaceId, projectId, legacyHostId
        ) = routeTarget else {
            return XCTFail("expected TabMail app target")
        }
        XCTAssertEqual(appId, "tabmail")
        XCTAssertNil(resourceId)
        XCTAssertEqual(route, "message/message-1")
        XCTAssertEqual(organizationId, "org-1")
        XCTAssertEqual(workspaceId, "workspace-1")
        XCTAssertEqual(projectId, "project-1")
        XCTAssertNil(legacyHostId)
    }

    func testRemovedSharedResourceBecomesInformational() throws {
        let item = notification(
            type: "resource_shared",
            metadata: [
                "action": AnyCodable("removed"),
                "resource_type": AnyCodable("doc"),
                "resource_id": AnyCodable("doc-1"),
            ]
        )

        XCTAssertEqual(MobileNotificationTargetResolver.resolve(item), .unsupported)
    }

    func testResourceAccessRequestOpensApprovalTarget() throws {
        let item = notification(
            type: "resource_access_request",
            title: "syt 申请查看资源",
            body: "syt 申请查看（viewer）《P0》",
            metadata: [
                "request_id": AnyCodable("req-1"),
            ],
            organizationId: "org-1"
        )

        guard case let .resourceAccessRequest(request) =
            MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected resource access request target")
        }
        XCTAssertEqual(request.requestId, "req-1")
        XCTAssertEqual(request.title, "syt 申请查看资源")
        XCTAssertEqual(request.body, "syt 申请查看（viewer）《P0》")
        XCTAssertEqual(request.organizationId, "org-1")
    }

    func testUnknownTypeWithoutTargetBecomesInformational() throws {
        XCTAssertEqual(
            MobileNotificationTargetResolver.resolve(notification(type: "future.event")),
            .unsupported
        )
    }

    func testNotificationPanelTargetBecomesInformational() throws {
        let item = notification(
            type: "system",
            navigateTo: [
                "type": AnyCodable("notification-panel"),
                "id": AnyCodable("bell"),
            ]
        )
        XCTAssertEqual(MobileNotificationTargetResolver.resolve(item), .unsupported)
    }

    func testOrganizationInvitationOpensPersonalInvitationInbox() throws {
        let item = notification(type: "organization.invitation", organizationId: "invited-org")

        XCTAssertEqual(MobileNotificationTargetResolver.resolve(item), .invitation)
    }

    func testCrossOrganizationInvitationIsVisibleButOtherNotificationsStayScoped() throws {
        let invitation = notification(type: "organization.invitation", organizationId: "invited-org")
        let otherNotification = notification(type: "agent.task.completed", organizationId: "other-org")

        XCTAssertTrue(NotificationStore.isVisible(invitation, in: "current-org"))
        XCTAssertFalse(NotificationStore.isVisible(otherNotification, in: "current-org"))
    }

    func testCompletedTrackerDefaultsToConcreteArtifactWhenMobileCanOpenIt() throws {
        let item = notification(
            type: "tracker.run.completed",
            metadata: [
                "tracker_id": AnyCodable("tracker-1"),
                "skill_key": AnyCodable("tabdoc.summarize"),
                "artifact_ref": AnyCodable(["docId": "doc-1"]),
            ],
            organizationId: "org-1",
            legacyHostId: "space-1"
        )

        guard case let .app(appId, resourceId, _, _, _, _, _, legacyHostId) =
            MobileNotificationTargetResolver.resolve(item) else {
            return XCTFail("expected artifact app target")
        }
        XCTAssertEqual(appId, "tabdoc")
        XCTAssertEqual(resourceId, "doc-1")
        XCTAssertEqual(legacyHostId, "space-1")
    }

    func testTrackerCapabilitiesMissingDefaultsToReadOnlyActions() throws {
        let tracker = try makeTracker(status: "active", capabilities: nil)

        XCTAssertNil(tracker.capabilities)
        XCTAssertFalse(TrackerActionPolicy.canTrigger(tracker))
        XCTAssertNil(TrackerActionPolicy.lifecycleAction(for: tracker))
    }

    func testTrackerLifecycleMatrixMatchesDesktopSemantics() throws {
        let capabilities = ["can_edit": true, "can_trigger": true, "can_cancel": false]

        let active = try makeTracker(status: "active", capabilities: capabilities)
        XCTAssertTrue(TrackerActionPolicy.canTrigger(active))
        XCTAssertEqual(TrackerActionPolicy.lifecycleAction(for: active), .pause)

        let paused = try makeTracker(status: "paused", capabilities: capabilities)
        XCTAssertFalse(TrackerActionPolicy.canTrigger(paused))
        XCTAssertEqual(TrackerActionPolicy.lifecycleAction(for: paused), .resume)

        let disabled = try makeTracker(status: "disabled", capabilities: capabilities)
        XCTAssertEqual(TrackerActionPolicy.lifecycleAction(for: disabled), .resume)

        let draft = try makeTracker(status: "draft", capabilities: capabilities)
        XCTAssertEqual(TrackerActionPolicy.lifecycleAction(for: draft), .activate)
    }

    func testTrackerListProjectionFiltersSearchAndStatus() throws {
        let active = try makeTracker(
            id: "tracker-active",
            name: "日报整理",
            status: "active",
            spaceName: "内容工作空间",
            capabilities: nil
        )
        let paused = try makeTracker(
            id: "tracker-paused",
            name: "发布检查",
            status: "paused",
            spaceName: "研发工作空间",
            capabilities: nil
        )

        XCTAssertEqual(
            TrackerListProjection.filtered(
                [active, paused],
                searchText: "研发",
                status: .all
            ).map(\.id),
            ["tracker-paused"]
        )
        XCTAssertEqual(
            TrackerListProjection.filtered(
                [active, paused],
                searchText: "",
                status: .active
            ).map(\.id),
            ["tracker-active"]
        )
    }

    func testWaitingDeviceRunIsNonTerminalAndDisplayedHonestly() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "run-1",
            "tracker_id": "tracker-1",
            "status": "waiting_device",
            "capabilities": ["can_edit": false, "can_trigger": false, "can_cancel": true],
        ])
        let run = try JSONDecoder().decode(TrackerRun.self, from: data)

        XCTAssertEqual(run.status, .waitingDevice)
        XCTAssertEqual(run.status.displayLabel, "等待设备")
        XCTAssertFalse(run.status.isTerminal)
        XCTAssertTrue(TrackerActionPolicy.canCancel(run))
    }

    func testTrackerRunExecutionPolicyBlocksEveryNonTerminalLatestRun() throws {
        for status in ["pending", "running", "waiting_device", "waiting_checkpoint", "future_status"] {
            XCTAssertFalse(
                TrackerRunExecutionPolicy.canTrigger(latestRun: try makeRun(status: status)),
                "\(status) must block another manual run"
            )
        }

        for status in ["completed", "partial_failed", "failed", "cancelled"] {
            XCTAssertTrue(
                TrackerRunExecutionPolicy.canTrigger(latestRun: try makeRun(status: status)),
                "\(status) must restore manual triggering"
            )
        }
    }

    func testRunConversationTargetUsesAuthoritativeSessionWorkspace() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "session-1",
            "title": "自动化运行",
            "organization_id": "org-session",
            "workspace_id": "workspace-session",
            "project_id": "project-session",
            "agent_id": "agent-session",
        ])
        let session = try JSONDecoder().decode(ChatSession.self, from: data)
        let target = try XCTUnwrap(
            TrackerRunConversationTargetResolver.resolve(
                session: session,
                fallbackOrganizationId: "org-fallback"
            )
        )

        XCTAssertEqual(target.sessionId, "session-1")
        XCTAssertEqual(target.workspaceId, "workspace-session")
        XCTAssertEqual(target.organizationId, "org-session")
        XCTAssertEqual(target.projectId, "project-session")
        XCTAssertEqual(target.agentId, "agent-session")
    }

    func testAutomationUsesSplitLayoutAtRegularWidth() {
        XCTAssertEqual(AutomationLayoutPolicy.mode(isRegularWidth: true), .split)
        XCTAssertEqual(AutomationLayoutPolicy.mode(isRegularWidth: false), .stack)
    }

    func testConversationWorkspaceRequiresRegularAndEnoughAvailableWidthForSplit() {
        let threshold = ConversationTaskWorkspaceLayoutPolicy.minimumSplitWidth

        XCTAssertEqual(
            ConversationTaskWorkspaceLayoutPolicy.mode(
                availableWidth: threshold,
                isRegularWidth: true
            ),
            .split
        )
        XCTAssertEqual(
            ConversationTaskWorkspaceLayoutPolicy.mode(
                availableWidth: threshold - 1,
                isRegularWidth: true
            ),
            .compact
        )
        XCTAssertEqual(
            ConversationTaskWorkspaceLayoutPolicy.mode(
                availableWidth: threshold + 200,
                isRegularWidth: false
            ),
            .compact
        )
    }

    func testTaskHomeAutomationEntryRejectsMissingOrBlankOrganization() {
        XCTAssertNil(TaskHomeAutomationEntryPolicy.organizationId(from: nil))
        XCTAssertNil(TaskHomeAutomationEntryPolicy.organizationId(from: "  \n"))
        XCTAssertEqual(
            TaskHomeAutomationEntryPolicy.organizationId(from: " org-1 "),
            "org-1"
        )
    }

    private func notification(
        id: String = "notification-1",
        type: String = "system",
        title: String = "title",
        body: String = "body",
        metadata: [String: AnyCodable] = [:],
        organizationId: String = "",
        workspaceId: String? = nil,
        projectId: String? = nil,
        legacyHostId: String? = nil,
        priority: String? = nil,
        sourceExtensionId: String? = nil,
        navigateTo: [String: AnyCodable]? = nil,
        isRead: Bool = false
    ) -> MobileNotification {
        MobileNotification(
            id: id,
            type: type,
            title: title,
            body: body,
            metadata: metadata,
            organizationId: organizationId,
            workspaceId: workspaceId,
            projectId: projectId,
            legacyHostId: legacyHostId,
            priority: priority,
            category: nil,
            sourceExtensionId: sourceExtensionId,
            navigateTo: navigateTo,
            isRead: isRead,
            readAt: nil,
            createdAt: "2026-07-17T10:00:00Z"
        )
    }

    private func makeTracker(
        id: String = "tracker-1",
        name: String = "自动化",
        status: String,
        spaceName: String? = nil,
        capabilities: [String: Bool]?
    ) throws -> Tracker {
        var raw: [String: Any] = [
            "id": id,
            "name": name,
            "status": status,
        ]
        raw["space_name"] = spaceName
        raw["capabilities"] = capabilities
        let data = try JSONSerialization.data(withJSONObject: raw)
        return try JSONDecoder().decode(Tracker.self, from: data)
    }

    private func makeRun(status: String) throws -> TrackerRun {
        let data = try JSONSerialization.data(withJSONObject: [
            "id": "run-1",
            "tracker_id": "tracker-1",
            "status": status,
            "capabilities": ["can_cancel": true],
        ])
        return try JSONDecoder().decode(TrackerRun.self, from: data)
    }
}
