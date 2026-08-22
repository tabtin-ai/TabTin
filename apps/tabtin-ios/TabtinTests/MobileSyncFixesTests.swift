import XCTest
@testable import Tabtin

final class MobileSyncFixesTests: XCTestCase {
    @MainActor
    func testInviteDeepLinkPersistsUntilAuthenticatedPresentation() throws {
        let suite = "InviteDeepLinkCoordinatorTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let url = try XCTUnwrap(URL(string: "tabtin://invite/team%2Ftoken"))

        let coordinator = InviteDeepLinkCoordinator(
            defaults: defaults,
            defaultsKey: "pending"
        )
        XCTAssertTrue(coordinator.receive(url))
        XCTAssertNil(coordinator.inviteForPresentation(
            isAuthenticated: false,
            hasProfile: false,
            needsInviteCode: false
        ))

        let restored = InviteDeepLinkCoordinator(
            defaults: defaults,
            defaultsKey: "pending"
        )
        XCTAssertEqual(restored.pendingInvite?.token, "team/token")
        XCTAssertEqual(
            restored.inviteForPresentation(
                isAuthenticated: true,
                hasProfile: true,
                needsInviteCode: false
            )?.token,
            "team/token"
        )
    }

    func testInviteDeepLinkRejectsUntrustedWebHost() throws {
        let trusted = try XCTUnwrap(URL(string: "https://web-test.example.com/invite/token-1"))
        let untrusted = try XCTUnwrap(URL(string: "https://attacker.invalid/invite/token-1"))

        XCTAssertEqual(InviteDeepLinkParser.parse(trusted)?.token, "token-1")
        XCTAssertNil(InviteDeepLinkParser.parse(untrusted))
    }

    func testPreprodInviteSchemeIsRegisteredAndParsed() throws {
        let url = try XCTUnwrap(URL(string: "tabtin-preprod://invite/team%2Ftoken"))
        let infoPlist = try sourceText("Tabtin/Resources/Info.plist")

        XCTAssertEqual(InviteDeepLinkParser.parse(url)?.token, "team/token")
        XCTAssertTrue(infoPlist.contains("<string>tabtin-preprod</string>"))
    }

    func testInvitationLinkUsesCurrentWebEnvironment() {
        XCTAssertEqual(
            InvitationLink.url(token: "invite-token", webBaseURL: "https://web-test.example.com"),
            "https://web-test.example.com/invite/invite-token"
        )
        XCTAssertEqual(
            InvitationLink.url(token: " invite/token ", webBaseURL: "https://web.example.com/"),
            "https://web.example.com/invite/invite%2Ftoken"
        )
    }

    func testAgentDetailKeepsDeactivateActionOutsideTabSpecificContent() throws {
        let source = try sourceText("Tabtin/Features/Main/AgentDetailScreen.swift")
        let detailSection = try XCTUnwrap(source.range(of: "private func detail(_ agent: OrganizationAgent)"))
        let sectionContent = try XCTUnwrap(source.range(of: "@ViewBuilder\n    private var sectionContent"))
        let detailBody = String(source[detailSection.lowerBound..<sectionContent.lowerBound])

        XCTAssertTrue(detailBody.contains("if agent.isDefault != true"))
        XCTAssertFalse(detailBody.contains("selectedSection == .recentTasks"))
    }

    func testLoginErrorsUseTopHintInsteadOfBlockingAlert() throws {
        let source = try sourceText("Tabtin/Features/Auth/LoginView.swift")

        XCTAssertTrue(source.contains("loginErrorHint"))
        XCTAssertTrue(source.contains(".offset(y: LoginLayout.headerHeight)"))
        XCTAssertFalse(source.contains(".alert(L10n.Auth.loginFailed"))
    }

    func testDebugNetworkingDefaultsToTestEnvironment() {
        #if DEBUG || DEBUGSWIFT_ENABLED
        XCTAssertEqual(AppConfig.configuredAPIBaseURL, AppConfig.testAPIBaseURL)
        XCTAssertEqual(AppConfig.configuredWSBaseURL, AppConfig.testWSBaseURL)
        XCTAssertEqual(AppConfig.configuredWebBaseURL, AppConfig.testWebBaseURL)
        #endif
    }

    func testLegacyLocalCentrifugoOverrideRepairsAPIWebSocketPort() {
        XCTAssertEqual(
            AppConfig.normalizedCentrifugoURL(
                "ws://192.168.31.100:6060/connection/websocket",
                forAPI: "http://192.168.31.100:6060/api"
            ),
            "ws://192.168.31.100:8100/connection/websocket"
        )
        XCTAssertEqual(
            AppConfig.normalizedCentrifugoURL(
                "wss://dev.example.com:7443/connection/websocket",
                forAPI: "https://dev.example.com:7443/api"
            ),
            "wss://dev.example.com:7443/connection/websocket"
        )
    }

    private func sourceText(_ relativePath: String) throws -> String {
        let iosRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try String(
            contentsOf: iosRoot.appendingPathComponent(relativePath),
            encoding: .utf8
        )
    }

    func testResourceDeepLinkParsesCompleteContextAndAliases() throws {
        let url = try XCTUnwrap(URL(string:
            "tabtin://resource/document_selection/folder%2Fdoc-1"
                + "?hint=tabdoc&title=Plan&organizationId=org-1&spaceId=space-1"
        ))

        XCTAssertEqual(
            ResourceDeepLinkParser.parse(url),
            .target(ResourceDeepLinkTarget(
                resourceType: "tabdoc",
                resourceId: "folder/doc-1",
                title: "Plan",
                locationHint: nil,
                organizationId: "org-1",
                spaceId: "space-1"
            ))
        )
    }

    func testResourceDeepLinkReportsMissingContextInsteadOfDroppingTarget() throws {
        let url = try XCTUnwrap(URL(string: "tabtin://resource/tabdata/table-1"))
        XCTAssertEqual(ResourceDeepLinkParser.parse(url), .missingContext)
    }

    func testResourceDeepLinkRejectsUntrustedHTTPHost() throws {
        let url = try XCTUnwrap(URL(string:
            "https://attacker.invalid/resource/tabdoc/doc-1?organization_id=org-1&space_id=space-1"
        ))
        XCTAssertNil(ResourceDeepLinkParser.parse(url))
    }

    func testDeactivatedAgentResponseDecodesBackendShape() throws {
        let data = Data(#"{"items":[{"id":"agent-1","name":"Researcher","type":"bot","created_at":"2026-07-01T00:00:00Z","deactivated_at":"2026-07-27T00:00:00Z"}],"total":1}"#.utf8)
        let response = try JSONDecoder().decode(DeactivatedOrganizationAgentListResponse.self, from: data)

        XCTAssertEqual(response.total, 1)
        XCTAssertEqual(response.items.first?.id, "agent-1")
        XCTAssertEqual(response.items.first?.deactivatedAt, "2026-07-27T00:00:00Z")
    }

    func testCloudMemoSummaryDecodesAITagsAndArchivedStatus() throws {
        let data = Data(#"{"id":"memo-1","space_id":"space-1","memo_type":"note","content_plaintext":"Idea","content_markdown":"Idea","tags":["manual"],"ai_tags":["research"],"source":"manual","status":"archived","is_pinned":false,"created_at":"2026-07-01T00:00:00Z","updated_at":"2026-07-27T00:00:00Z"}"#.utf8)
        let memo = try JSONDecoder().decode(CloudMemoSummary.self, from: data)

        XCTAssertEqual(memo.status, CloudMemoStatus.archived.rawValue)
        XCTAssertEqual(memo.aiTags, ["research"])
        XCTAssertEqual(memo.allTags, ["manual", "research"])
    }

    func testCloudMemoSummaryDefaultsMissingTagFields() throws {
        let data = Data(#"{"id":"memo-2","content_plaintext":"Draft"}"#.utf8)
        let memo = try JSONDecoder().decode(CloudMemoSummary.self, from: data)

        XCTAssertEqual(memo.tags, [])
        XCTAssertEqual(memo.aiTags, [])
        XCTAssertFalse(memo.isPinned)
    }

    @MainActor
    func testRouterOpensIMConversationInMessagesTab() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        let originalPending = router.pendingIMConversation
        let originalActivationID = router.messagesTabActivationID
        let originalNavigationRevision = router.programmaticNavigationRevision
        defer {
            router.selectedTab = originalTab
            router.pendingIMConversation = originalPending
        }

        let target = IMConversationTarget(conversationId: "im-1", title: "Design review")
        router.openIMConversation(target)

        XCTAssertEqual(router.selectedTab, .messages)
        XCTAssertEqual(router.pendingIMConversation, target)
        XCTAssertGreaterThan(router.messagesTabActivationID, originalActivationID)
        XCTAssertGreaterThan(router.programmaticNavigationRevision, originalNavigationRevision)
    }

    @MainActor
    func testRouterOpensWorkspaceBySpaceIdentityInAgentsTab() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        let originalPending = router.pendingWorkspaceId
        let originalNavigationRevision = router.programmaticNavigationRevision
        defer {
            router.selectedTab = originalTab
            router.pendingWorkspaceId = originalPending
        }

        router.openWorkspace(" workspace-1 ")

        XCTAssertEqual(router.selectedTab, .agents)
        XCTAssertEqual(router.pendingWorkspaceId, "workspace-1")
        XCTAssertGreaterThan(router.programmaticNavigationRevision, originalNavigationRevision)

        router.consumeWorkspace("agent-1")
        XCTAssertEqual(router.pendingWorkspaceId, "workspace-1")

        router.consumeWorkspace("workspace-1")
        XCTAssertNil(router.pendingWorkspaceId)
    }

    @MainActor
    func testRouterRefreshesMessagesWhenReselectingCurrentTab() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        let originalActivationID = router.messagesTabActivationID
        defer {
            router.selectedTab = originalTab
        }

        router.selectTab(.messages)
        let firstActivationID = router.messagesTabActivationID
        router.selectTab(.messages)

        XCTAssertEqual(router.selectedTab, .messages)
        XCTAssertGreaterThan(firstActivationID, originalActivationID)
        XCTAssertGreaterThan(router.messagesTabActivationID, firstActivationID)
    }

    @MainActor
    func testSelectingHiddenProjectsTabIsNoOpAndDoesNotReactivateMessages() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        defer { router.selectedTab = originalTab }

        router.selectTab(.messages)
        let activationIDAfterMessages = router.messagesTabActivationID
        // 项目暂时非 primary：selectTab 必须 no-op，不能误切走消息，也不能刷激活序号。
        router.selectTab(.projects)

        XCTAssertEqual(router.selectedTab, .messages)
        XCTAssertEqual(router.messagesTabActivationID, activationIDAfterMessages)
    }

    func testPrimaryNavigationHidesProjectsWhileUnreleased() {
        // 项目入口暂时不上线：底栏只保留四项；恢复时把 `.projects` 加回 primaryTabs。
        XCTAssertEqual(
            MainNavTab.primaryTabs,
            [.tasks, .cloudDocs, .agents, .messages]
        )
        XCTAssertFalse(MainNavTab.primaryTabs.contains(.projects))
        XCTAssertTrue(MainNavTab.hiddenTabs.contains(.projects))
    }

    func testPrimaryNavigationUsesDistinctSemanticBrandIcons() {
        XCTAssertEqual(
            MainNavTab.primaryTabs.map(\.iconAsset),
            [
                "MainNavTasks",
                "MainNavCloudDocs",
                "MainNavAgents",
                "MainNavMessages",
            ]
        )
        XCTAssertEqual(Set(MainNavTab.primaryTabs.map(\.iconAsset)).count, 4)
    }

    func testPrimaryNavigationBrandIconsExistInAssetCatalog() {
        for assetName in MainNavTab.primaryTabs.map(\.iconAsset) {
            XCTAssertNotNil(UIImage(named: assetName), "缺少图标资产 \(assetName)")
        }
    }

    @MainActor
    func testRouterOpensResourceInCloudDocsTab() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        let originalPending = router.pendingResource
        let originalNavigationRevision = router.programmaticNavigationRevision
        defer {
            router.selectedTab = originalTab
            router.pendingResource = originalPending
        }

        let target = ResourceDeepLinkTarget(
            resourceType: "tabdoc",
            resourceId: "doc-1",
            title: "Roadmap",
            locationHint: nil,
            organizationId: "org-1",
            spaceId: "workspace-1"
        )
        router.openResource(target)

        XCTAssertEqual(router.selectedTab, .cloudDocs)
        XCTAssertEqual(router.pendingResource, target)
        XCTAssertGreaterThan(router.programmaticNavigationRevision, originalNavigationRevision)
    }

    func testStageSixRestoresLegacyTabsToCurrentDomains() {
        // rawValue 会被写进 SceneStorage，是对外契约：改 case 名就会把存量用户存的
        // "cloudDocs" 打成解析失败、冷启掉回任务页（"cloud"/"apps" 两条迁移分支即前科）。
        XCTAssertEqual(MainNavTab.cloudDocs.rawValue, "cloudDocs")
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "cloudDocs"), .cloudDocs)

        XCTAssertEqual(MainNavTab.primaryTab(restoring: "home"), .tasks)
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "cloud"), .cloudDocs)
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "apps"), .cloudDocs)
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "messages"), .messages)
        // 项目暂时屏蔽：旧 Scene 存过 projects 时落到消息，避免冷启空白 Tab。
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "projects"), .messages)
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "agent"), .agents)
        XCTAssertEqual(MainNavTab.primaryTab(restoring: "automation"), .tasks)
        XCTAssertNil(MainNavTab.primaryTab(restoring: "profile"))
    }

    /// 合并期存过 "collaboration" 的用户，冷启要回到当时停留的那个工作面，
    /// 而不是一律掉进消息页。
    func testRestoresLegacyCollaborationShellToStoredWorkface() {
        // 项目暂时屏蔽：collaboration→projects 降级到消息。
        XCTAssertEqual(
            MainNavTab.restoration(
                forStoredRawValue: "collaboration",
                legacyCollaborationSectionRawValue: "projects"
            ),
            .messages
        )
        XCTAssertEqual(
            MainNavTab.restoration(
                forStoredRawValue: "collaboration",
                legacyCollaborationSectionRawValue: "messages"
            ),
            .messages
        )
        XCTAssertEqual(
            MainNavTab.restoration(
                forStoredRawValue: "collaboration",
                legacyCollaborationSectionRawValue: ""
            ),
            .messages
        )
    }

    func testMainNavigationRestorePolicyPriorityAndFallbackMatrix() {
        // 现存的一级 rawValue 直接还原，不再受合并期二级分段影响。
        XCTAssertEqual(
            MainNavigationRestorePolicy.restoration(
                storedTabRawValue: "messages",
                storedCollaborationSectionRawValue: "projects",
                currentTab: .tasks,
                hasPendingNavigation: false,
                programmaticNavigationRevision: 0
            ),
            .messages
        )

        XCTAssertEqual(
            MainNavigationRestorePolicy.restoration(
                storedTabRawValue: "collaboration",
                storedCollaborationSectionRawValue: "projects",
                currentTab: .tasks,
                hasPendingNavigation: false,
                programmaticNavigationRevision: 0
            ),
            .messages
        )

        XCTAssertNil(
            MainNavigationRestorePolicy.restoration(
                storedTabRawValue: "apps",
                storedCollaborationSectionRawValue: "projects",
                currentTab: .tasks,
                hasPendingNavigation: true,
                programmaticNavigationRevision: 0
            )
        )
        XCTAssertNil(
            MainNavigationRestorePolicy.restoration(
                storedTabRawValue: "apps",
                storedCollaborationSectionRawValue: "projects",
                currentTab: .tasks,
                hasPendingNavigation: false,
                programmaticNavigationRevision: 1
            )
        )

        XCTAssertEqual(
            MainNavigationRestorePolicy.restoration(
                storedTabRawValue: "apps",
                storedCollaborationSectionRawValue: "projects",
                currentTab: .tasks,
                hasPendingNavigation: false,
                programmaticNavigationRevision: 0
            ),
            .cloudDocs
        )

        for storedTabRawValue in ["unknown", "profile"] {
            XCTAssertEqual(
                MainNavigationRestorePolicy.restoration(
                    storedTabRawValue: storedTabRawValue,
                    storedCollaborationSectionRawValue: "messages",
                    currentTab: .tasks,
                    hasPendingNavigation: false,
                    programmaticNavigationRevision: 0
                ),
                .tasks
            )
        }
    }

    @MainActor
    func testRouterOpensAutomationTargetInTasksTab() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        let originalPending = router.pendingAutomation
        let originalNavigationRevision = router.programmaticNavigationRevision
        defer {
            router.selectedTab = originalTab
            router.pendingAutomation = originalPending
        }

        let target = AutomationDeepLinkTarget(
            organizationId: "org-1",
            spaceId: "workspace-1",
            trackerId: "tracker-1",
            runId: "run-1"
        )
        router.openAutomation(target)

        XCTAssertEqual(router.selectedTab, .tasks)
        XCTAssertEqual(router.pendingAutomation, target)
        XCTAssertGreaterThan(router.programmaticNavigationRevision, originalNavigationRevision)

        router.consumeAutomation(target)
        XCTAssertNil(router.pendingAutomation)
    }

    @MainActor
    func testDirectTabSelectionDoesNotAdvanceProgrammaticNavigationRevision() {
        let router = MainRouter.shared
        let originalTab = router.selectedTab
        let originalNavigationRevision = router.programmaticNavigationRevision
        defer { router.selectedTab = originalTab }

        router.selectTab(.cloudDocs)

        XCTAssertEqual(router.programmaticNavigationRevision, originalNavigationRevision)
    }

    func testTaskHomeSessionActionPolicyNormalizesArchivedStatus() {
        XCTAssertTrue(TaskHomeSessionActionPolicy.canArchive(status: nil))
        XCTAssertTrue(TaskHomeSessionActionPolicy.canArchive(status: "active"))
        XCTAssertFalse(TaskHomeSessionActionPolicy.canArchive(status: "archived"))
        XCTAssertFalse(TaskHomeSessionActionPolicy.canArchive(status: "  ArChIvEd \n"))
    }

    func testTabBarVisibilityPolicyOnlyHidesOnCompactPhoneWhenRequested() {
        for isPhone in [false, true] {
            for isCompactWidth: Bool? in [false, true] {
                XCTAssertFalse(
                    TTTabBarVisibilityPolicy.shouldHide(
                        requested: false,
                        isPhone: isPhone,
                        isCompactWidth: isCompactWidth
                    )
                )
            }
        }

        XCTAssertTrue(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: true,
                isCompactWidth: true
            )
        )
        XCTAssertFalse(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: true,
                isCompactWidth: false
            )
        )
        XCTAssertFalse(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: false,
                isCompactWidth: true
            )
        )
        XCTAssertFalse(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: false,
                isCompactWidth: false
            )
        )

        // 转场瞬间 size class 为 nil：phone 按 compact，避免底栏闪一下。
        XCTAssertTrue(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: true,
                isCompactWidth: nil
            )
        )
        XCTAssertFalse(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: false,
                isCompactWidth: nil
            )
        )
        XCTAssertFalse(
            TTTabBarVisibilityPolicy.shouldHide(
                requested: false,
                isPhone: true,
                isCompactWidth: nil
            )
        )
    }

    func testAutomationTargetScopePolicyResolutionMatrix() {
        let target = AutomationDeepLinkTarget(
            organizationId: "org-1",
            spaceId: "workspace-1",
            trackerId: "tracker-1",
            runId: nil
        )

        XCTAssertEqual(
            AutomationTargetScopePolicy.resolve(
                target: target,
                organizationIds: ["org-1"],
                selectedOrganizationId: "org-1",
                workspaceIds: [],
                isLoadingSpaces: true,
                hasLoadedSpaces: false,
                spacesLoadError: nil
            ),
            .waiting
        )
        XCTAssertEqual(
            AutomationTargetScopePolicy.resolve(
                target: target,
                organizationIds: ["org-1"],
                selectedOrganizationId: "org-1",
                workspaceIds: [],
                isLoadingSpaces: false,
                hasLoadedSpaces: false,
                spacesLoadError: "加载失败"
            ),
            .retry("加载失败")
        )
        XCTAssertEqual(
            AutomationTargetScopePolicy.resolve(
                target: target,
                organizationIds: ["org-1"],
                selectedOrganizationId: "org-1",
                workspaceIds: [],
                isLoadingSpaces: false,
                hasLoadedSpaces: false,
                spacesLoadError: nil
            ),
            .waiting
        )
        XCTAssertEqual(
            AutomationTargetScopePolicy.resolve(
                target: target,
                organizationIds: ["org-1"],
                selectedOrganizationId: "org-1",
                workspaceIds: ["workspace-1"],
                isLoadingSpaces: false,
                hasLoadedSpaces: true,
                spacesLoadError: nil
            ),
            .ready
        )
        XCTAssertEqual(
            AutomationTargetScopePolicy.resolve(
                target: target,
                organizationIds: ["org-1"],
                selectedOrganizationId: "org-1",
                workspaceIds: [],
                isLoadingSpaces: false,
                hasLoadedSpaces: true,
                spacesLoadError: nil
            ),
            .workspaceUnavailable
        )
        XCTAssertEqual(
            AutomationTargetScopePolicy.resolve(
                target: target,
                organizationIds: [],
                selectedOrganizationId: "org-1",
                workspaceIds: ["workspace-1"],
                isLoadingSpaces: false,
                hasLoadedSpaces: true,
                spacesLoadError: nil
            ),
            .organizationUnavailable
        )
    }

}
