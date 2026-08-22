import UIKit
import XCTest
@testable import Tabtin

final class WorkspaceModelsTests: XCTestCase {
    func testWorkspaceMemorySettingsDecodeOfficialDefaultAndMemberPermission() throws {
        let data = Data(
            """
            {
              "workspace_scope": "organization",
              "auto_memory_enabled": true,
              "memory_model_mode": "official_default",
              "memory_model": null,
              "can_update": false
            }
            """.utf8
        )

        let settings = try JSONDecoder().decode(WorkspaceMemorySettings.self, from: data)

        XCTAssertTrue(settings.autoMemoryEnabled)
        XCTAssertEqual(settings.memoryModelMode, .officialDefault)
        XCTAssertFalse(settings.canUpdate)
        XCTAssertTrue(settings.hasAvailableExplicitModel(in: []))
    }

    func testWorkspaceMemoryExplicitModelUsesExactUUIDAndNeedsReselectionWhenUnavailable() throws {
        let modelId = "11111111-1111-4111-8111-111111111111"
        let data = Data(
            """
            {
              "workspace_scope": "personal",
              "auto_memory_enabled": true,
              "memory_model_mode": "explicit_model",
              "memory_model": {
                "id": "\(modelId)",
                "display_name": "个人 Kimi",
                "provider_scope": "user",
                "provider_display_name": "我的渠道"
              },
              "can_update": true
            }
            """.utf8
        )

        let settings = try JSONDecoder().decode(WorkspaceMemorySettings.self, from: data)

        XCTAssertEqual(settings.memoryModel?.id, modelId)
        XCTAssertFalse(settings.hasAvailableExplicitModel(in: []))
        XCTAssertTrue(settings.hasAvailableExplicitModel(in: [try XCTUnwrap(settings.memoryModel)]))
    }

    func testWorkspaceMemoryExplicitModeWithoutModelNeedsReselection() throws {
        let data = Data(
            """
            {
              "workspace_scope": "personal",
              "auto_memory_enabled": false,
              "memory_model_mode": "explicit_model",
              "memory_model": null,
              "can_update": true
            }
            """.utf8
        )

        let settings = try JSONDecoder().decode(WorkspaceMemorySettings.self, from: data)

        XCTAssertFalse(settings.hasAvailableExplicitModel(in: []))
    }

    func testWorkspaceMemoryCandidateGroupsDoNotExposeCredentials() throws {
        let data = Data(
            """
            {
              "workspace_scope": "personal",
              "items": [
                {
                  "id": "11111111-1111-4111-8111-111111111111",
                  "display_name": "Kimi",
                  "provider_scope": "user",
                  "provider_display_name": "我的渠道"
                }
              ]
            }
            """.utf8
        )

        let catalog = try JSONDecoder().decode(WorkspaceMemoryModelCatalog.self, from: data)

        XCTAssertEqual(catalog.items.first?.providerScope, .user)
        XCTAssertEqual(WorkspaceMemoryProviderScope.global.groupTitle, "TabTin 官方")
        XCTAssertEqual(WorkspaceMemoryProviderScope.user.groupTitle, "我的模型")
        XCTAssertEqual(WorkspaceMemoryProviderScope.organization.groupTitle, "组织模型")
    }

    func testWorkspaceMemoryUpdatePayloadsKeepLegacyAndChatModelFieldsOut() {
        let organizationId = "22222222-2222-4222-8222-222222222222"
        let modelId = "11111111-1111-4111-8111-111111111111"
        let toggle = WorkspaceMemoryUpdatePayload.toggle(
            organizationId: organizationId,
            enabled: false
        )
        let explicit = WorkspaceMemoryUpdatePayload.explicit(
            organizationId: organizationId,
            modelId: modelId
        )

        XCTAssertEqual(toggle["auto_memory_enabled"] as? Bool, false)
        XCTAssertNil(toggle["memory_model_id"])
        XCTAssertEqual(explicit["memory_model_id"] as? String, modelId)
        XCTAssertNil(explicit["model_name"])
        XCTAssertNil(explicit["provider_name"])
        XCTAssertNil(explicit["enabled"])
    }

    func testOrganizationAvatarUsesSettingsLogoAndIgnoresLegacyEmojiIcon() throws {
        let data = Data(
            """
            {
              "id": "org-1",
              "name": "TabTin",
              "icon": "🏢",
              "settings": {"logo_url": "https://cdn.example.com/org.png"}
            }
            """.utf8
        )

        let organization = try JSONDecoder().decode(Organization.self, from: data)

        XCTAssertEqual(organization.logoURL?.absoluteString, "https://cdn.example.com/org.png")
        XCTAssertTrue(organization.hasCustomLogo)
    }

    func testOrganizationDefaultAvatarUsesFirstCharacterInsteadOfUserInitials() throws {
        let data = Data(#"{"id":"org-1","name":"天工团队"}"#.utf8)

        let organization = try JSONDecoder().decode(Organization.self, from: data)

        XCTAssertEqual(organization.avatarFallbackText, "天")
    }

    func testOrganizationMembersPutOwnerFirstAndKeepOtherServerOrder() throws {
        let data = Data(
            """
            [
              {"id":"m-editor","user_id":"editor","role":"editor"},
              {"id":"m-viewer","user_id":"viewer","role":"viewer"},
              {"id":"m-owner","user_id":"owner","role":"owner"},
              {"id":"m-admin","user_id":"admin","role":"admin"}
            ]
            """.utf8
        )

        let members = try JSONDecoder().decode([OrganizationMember].self, from: data)
        XCTAssertEqual(
            OrganizationMemberPresentation.ownerFirst(members).map(\.userId),
            ["owner", "editor", "viewer", "admin"]
        )
    }

    func testOrganizationMemberActionsFollowRoleHierarchy() {
        XCTAssertTrue(OrganizationMemberActions.canManage(
            operatorRole: .owner,
            targetRole: .admin,
            isCurrentUser: false,
            isPersonalOrganization: false
        ))
        XCTAssertTrue(OrganizationMemberActions.canManage(
            operatorRole: .admin,
            targetRole: .editor,
            isCurrentUser: false,
            isPersonalOrganization: false
        ))
        XCTAssertFalse(OrganizationMemberActions.canManage(
            operatorRole: .admin,
            targetRole: .admin,
            isCurrentUser: false,
            isPersonalOrganization: false
        ))
        XCTAssertFalse(OrganizationMemberActions.canManage(
            operatorRole: .owner,
            targetRole: .editor,
            isCurrentUser: true,
            isPersonalOrganization: false
        ))
        XCTAssertFalse(OrganizationMemberActions.canManage(
            operatorRole: .owner,
            targetRole: .editor,
            isCurrentUser: false,
            isPersonalOrganization: true
        ))
    }

    func testUsageCreditsFormattingMatchesElectronPrecisionContract() {
        let locale = Locale(identifier: "en_US")

        XCTAssertEqual(WorkspaceNumberFormat.formatUsageCredits("0", locale: locale), "0")
        XCTAssertEqual(WorkspaceNumberFormat.formatUsageCredits("0.0049", locale: locale), "0.0049")
        XCTAssertEqual(WorkspaceNumberFormat.formatUsageCredits("0.4", locale: locale), "0.40")
        XCTAssertEqual(WorkspaceNumberFormat.formatUsageCredits("1234.567", locale: locale), "1,234.57")
        XCTAssertEqual(WorkspaceNumberFormat.formatUsageCredits("invalid", locale: locale), "0")
    }

    func testUsageDashboardDoesNotTruncateBackendModelRanking() {
        XCTAssertEqual(UsageDashboardPresentation.modelRankLimit, 20)
    }

    func testAgentAvatarPresetsAppendFunctionVariantsWithoutChangingLegacyOrder() {
        XCTAssertEqual(
            AgentAvatarPreset.allCases.map(\.rawValue),
            [
                "general-assistant",
                "code-engineer",
                "doc-writer",
                "data-analyst",
                "web-researcher",
                "slide-designer",
                "office-secretary",
                "function-general-assistant",
                "function-code-engineer",
                "function-doc-writer",
                "function-data-analyst",
                "function-web-researcher",
                "function-slide-designer",
                "function-office-secretary",
            ]
        )
        XCTAssertEqual(AgentAvatarPreset.allCases.first, .generalAssistant)
        XCTAssertNil(AgentAvatarPreset(rawValue: "unknown-avatar"))
    }

    func testFunctionAgentAvatarPresetsHaveDistinctLabelsAndBundledImages() {
        let functionPresets: [AgentAvatarPreset] = [
            .functionGeneralAssistant,
            .functionCodeEngineer,
            .functionDocWriter,
            .functionDataAnalyst,
            .functionWebResearcher,
            .functionSlideDesigner,
            .functionOfficeSecretary,
        ]

        XCTAssertEqual(Set(functionPresets.map(\.label)).count, functionPresets.count)
        XCTAssertTrue(functionPresets.allSatisfy { $0.label.hasPrefix("功能简笔·") })
        for preset in functionPresets {
            XCTAssertNotNil(UIImage(named: preset.imageName), "Missing bundled image: \(preset.imageName)")
        }
    }

    func testExecutionSpaceDecodesTypeAndIndependentBindings() throws {
        let data = Data(
            """
            {
              "id": "space-1",
              "organization_id": "organization-1",
              "type": "workspace",
              "agent_id": "agent-legacy",
              "execution_agent_id": "agent-primary",
              "bound_device_id": "device-bound",
              "control_device_id": "device-control",
              "name": "Mobile App",
              "status": "active"
            }
            """.utf8
        )

        let space = try JSONDecoder().decode(Space.self, from: data)

        XCTAssertEqual(space.type, "workspace")
        XCTAssertTrue(space.isExecutionSpace)
        XCTAssertFalse(space.isProject)
        XCTAssertEqual(space.primaryAgentId, "agent-primary")
        XCTAssertEqual(space.executionDeviceId, "device-control")
    }

    func testProjectTypeDoesNotMasqueradeAsExecutionSpace() throws {
        let data = Data(
            """
            {
              "id": "project-1",
              "organization_id": "organization-1",
              "type": "team_space",
              "name": "Launch Project"
            }
            """.utf8
        )

        let space = try JSONDecoder().decode(Space.self, from: data)

        XCTAssertTrue(space.isProject)
        XCTAssertFalse(space.isExecutionSpace)
        XCTAssertNil(space.primaryAgentId)
        XCTAssertNil(space.executionDeviceId)
    }

    func testLegacySpaceWithoutTypeRemainsExecutionSpaceCompatible() throws {
        let data = Data(
            """
            {
              "id": "legacy-space",
              "organization_id": "organization-1",
              "agent_id": "agent-1",
              "bound_device_id": "device-1",
              "name": "Legacy Space"
            }
            """.utf8
        )

        let space = try JSONDecoder().decode(Space.self, from: data)

        XCTAssertNil(space.type)
        XCTAssertTrue(space.isExecutionSpace)
        XCTAssertFalse(space.isProject)
        XCTAssertEqual(space.primaryAgentId, "agent-1")
        XCTAssertEqual(space.executionDeviceId, "device-1")
    }

    func testAgentSummaryTrimsDisplayName() throws {
        let data = Data(
            """
            {
              "id": "agent-1",
              "organization_id": "organization-1",
              "name": "  小塔  ",
              "type": "bot",
              "is_active": true
            }
            """.utf8
        )

        let agent = try JSONDecoder().decode(AgentSummary.self, from: data)

        XCTAssertEqual(agent.displayName, "小塔")
    }

    func testWorkspaceSummaryDecodesWorkspaceOwnedRulesAndLimits() throws {
        let data = Data(
            """
            {
              "id": "workspace-1",
              "organization_id": "organization-1",
              "name": "移动端研发",
              "description": "日常开发现场",
              "working_dir": "/Users/me/mobile",
              "working_dir_type": "code",
              "custom_rules": "仅在当前 Workspace 使用中文",
              "execution_limits": {
                "max_iterations_per_run": 24,
                "max_credits_per_run": 3.5
              }
            }
            """.utf8
        )

        let workspace = try JSONDecoder().decode(WorkspaceSummary.self, from: data)

        XCTAssertEqual(workspace.customRules, "仅在当前 Workspace 使用中文")
        XCTAssertEqual(workspace.executionLimits?.maxIterationsPerRun, 24)
        XCTAssertEqual(workspace.executionLimits?.maxCreditsPerRun, "3.5")
        XCTAssertEqual(workspace.workingDirType, "code")
        XCTAssertEqual(workspace.description, "日常开发现场")
        let space = workspace.asSpace()
        XCTAssertEqual(space.description, "日常开发现场")
        XCTAssertTrue(space.isExecutionSpace)
    }

    /// B1：ConversationScreen 仍按 Space 解 `GET /context/workspaces/{id}`，须认 device_id。
    func testSpaceDecodesWorkspaceDetailDeviceIdAsExecutionDevice() throws {
        let data = Data(
            """
            {
              "id": "workspace-1",
              "organization_id": "organization-1",
              "name": "Home",
              "working_dir": "/Users/me/tabtin",
              "device_id": "device-bound",
              "is_home": true,
              "agent_id": null,
              "execution_agent_id": null
            }
            """.utf8
        )

        let space = try JSONDecoder().decode(Space.self, from: data)

        XCTAssertEqual(space.type, "workspace")
        XCTAssertTrue(space.isExecutionSpace)
        XCTAssertEqual(space.boundDeviceId, "device-bound")
        XCTAssertEqual(space.controlDeviceId, "device-bound")
        XCTAssertEqual(space.executionDeviceId, "device-bound")
        XCTAssertEqual(space.isDefault, true)
    }

    func testContextSpacePathAliasesToWorkspace() {
        XCTAssertEqual(
            Endpoints.Context.workspace("ws-1"),
            "/context/workspaces/ws-1"
        )
        // 弃用 alias 仍须指向正典路径，直到调用方清零后可删。
        XCTAssertEqual(
            Endpoints.Context.space("ws-1"),
            Endpoints.Context.workspace("ws-1")
        )
        XCTAssertEqual(Endpoints.Skills.visible, "/skills/visible")
        XCTAssertEqual(
            Endpoints.Skills.enable("user:demo"),
            "/skills/user%3Ademo/enable"
        )
        XCTAssertEqual(
            Endpoints.Skills.config("app:tabdoc/export"),
            "/skills/config/app%3Atabdoc%2Fexport"
        )
    }

    func testAgentTemplateListDecodesCreationChoices() throws {
        let data = Data(
            """
            {
              "templates": [
                {
                  "id": "researcher",
                  "version": "1",
                  "name": "{owner}的研究助手",
                  "tagline": "整理资料并给出结论",
                  "skills": ["browser", "documents"]
                }
              ],
              "total": 1
            }
            """.utf8
        )

        let response = try JSONDecoder().decode(AgentTemplateListResponse.self, from: data)

        XCTAssertEqual(response.templates.count, 1)
        XCTAssertEqual(response.templates[0].displayName(ownerName: "阿庭"), "阿庭的研究助手")
        XCTAssertEqual(response.templates[0].skills ?? [], ["browser", "documents"])
    }
}

final class SharedSessionExecutionTargetPolicyTests: XCTestCase {
    func testSharedSessionTimelineHidesRuntimeContextAndCompactionSummary() {
        let messages = [
            ChatMessage(id: "user", role: .user, text: "真实问题"),
            ChatMessage(
                id: "environment",
                role: .system,
                messageKind: "environment_context",
                text: "current_model: internal"
            ),
            ChatMessage(
                id: "compaction",
                role: .user,
                messageKind: "compaction_summary",
                text: "内部压缩摘要"
            ),
            ChatMessage(id: "assistant", role: .assistant, text: "正常回复"),
        ]

        XCTAssertEqual(
            SharedSessionMessageVisibility.filter(messages).map(\.id),
            ["user", "assistant"]
        )
    }

    private func workspace(
        id: String,
        organizationId: String = "organization-1",
        type: String? = "workspace",
        isArchived: Bool? = false,
        isDefault: Bool? = nil,
        agentId: String? = nil
    ) -> Space {
        Space(
            id: id,
            organizationId: organizationId,
            type: type,
            agentId: agentId,
            name: id,
            isArchived: isArchived,
            isDefault: isDefault
        )
    }

    private func agent(
        id: String,
        isActive: Bool? = true,
        isDefault: Bool? = nil
    ) -> OrganizationAgent {
        OrganizationAgent(
            id: id,
            organizationId: "organization-1",
            name: id,
            displayNameRaw: nil,
            type: "bot",
            isActive: isActive,
            isDefault: isDefault,
            goal: nil,
            customRules: nil,
            icon: nil,
            settings: nil,
            templateId: nil,
            updatedAt: nil,
            createdAt: nil
        )
    }

    func testUnboundDefaultWorkspaceRemainsAvailableForFork() {
        let candidates = SharedSessionExecutionTargetPolicy.workspaces(
            from: [
                workspace(id: "default", isDefault: true),
                workspace(id: "archived", isArchived: true),
                workspace(id: "project", type: "team_space"),
                workspace(id: "other-org", organizationId: "organization-2"),
            ],
            organizationId: "organization-1"
        )

        XCTAssertEqual(candidates.map(\.id), ["default"])
        XCTAssertNil(candidates[0].primaryAgentId)
        XCTAssertEqual(SharedSessionExecutionTargetPolicy.defaultWorkspace(in: candidates)?.id, "default")
    }

    func testDefaultActiveAgentIsPreselected() {
        let candidates = SharedSessionExecutionTargetPolicy.agents(
            from: [
                agent(id: "inactive", isActive: false),
                agent(id: "first"),
                agent(id: "default", isDefault: true),
            ],
            organizationId: "organization-1"
        )

        XCTAssertEqual(candidates.map(\.id), ["first", "default"])
        XCTAssertEqual(SharedSessionExecutionTargetPolicy.defaultAgent(in: candidates)?.id, "default")
    }
}
