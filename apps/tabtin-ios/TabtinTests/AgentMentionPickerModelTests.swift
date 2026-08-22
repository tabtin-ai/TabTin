import XCTest
@testable import Tabtin

/// 可编排的假会话服务：记录 binding 调用，可选让 binding 抛错。
private actor FakeConversationService: IMConversationServing {
    var agentsToReturn: [IMAgentSummary]
    var bindingsToReturn: [IMConversationAgentBinding]
    var addShouldFail: Bool
    private(set) var bindAgentCalls: [(String, String)] = []
    private(set) var updateAgentBindingCalls: [(String, String)] = []
    private(set) var searchCalls: [String] = []

    init(
        agents: [IMAgentSummary] = [],
        bindings: [IMConversationAgentBinding] = [],
        addShouldFail: Bool = false
    ) {
        self.agentsToReturn = agents
        self.bindingsToReturn = bindings
        self.addShouldFail = addShouldFail
    }

    func fetchDetail(conversationId: String) async throws -> IMConversationDetail {
        // 模型不调用 detail，占位即可。
        throw URLError(.unsupportedURL)
    }

    func searchAgents(organizationId: String, query: String) async throws -> [IMAgentSummary] {
        searchCalls.append(query)
        return agentsToReturn
    }

    func bindAgent(
        conversationId: String,
        agentId: String,
        workspaceId: String
    ) async throws -> IMConversationAgentBinding {
        bindAgentCalls.append((agentId, workspaceId))
        if addShouldFail { throw URLError(.badServerResponse) }
        return IMConversationAgentBinding(
            agentId: agentId,
            workspaceId: workspaceId,
            workspaceName: "执行现场",
            boundByUserId: "owner",
            boundAt: nil,
            canRebind: true,
            isExecutable: true
        )
    }

    func listAgentBindings(conversationId: String) async throws -> [IMConversationAgentBinding] {
        bindingsToReturn
    }

    func updateAgentBinding(
        conversationId: String,
        agentId: String,
        workspaceId: String
    ) async throws -> IMConversationAgentBinding {
        updateAgentBindingCalls.append((agentId, workspaceId))
        if addShouldFail { throw URLError(.badServerResponse) }
        return IMConversationAgentBinding(
            agentId: agentId,
            workspaceId: workspaceId,
            workspaceName: "新执行现场",
            boundByUserId: "owner",
            boundAt: nil,
            canRebind: true,
            isExecutable: true
        )
    }

}

@MainActor
final class AgentMentionPickerModelTests: XCTestCase {
    func testHumanGroupMembersCanAddAgent() {
        let members = [
            IMMember(userId: "member", role: 1),
            IMMember(userId: "admin", role: 2),
            IMMember(userId: "owner", role: 3),
            IMMember(memberType: IMMemberType.agent.rawValue, agentId: "agent", role: 3),
        ]
        let group = IMConversationDetail(
            id: "group", organizationId: "org", type: IMConversationType.group.rawValue,
            members: members
        )
        let externalGroup = IMConversationDetail(
            id: "external", organizationId: "org", type: IMConversationType.group.rawValue,
            members: members, isExternal: true
        )
        let teamSpaceChannel = IMConversationDetail(
            id: "channel",
            organizationId: "org",
            isTeamSpaceChannel: true,
            type: IMConversationType.group.rawValue,
            members: members
        )
        let directMessage = IMConversationDetail(
            id: "dm", organizationId: "org", type: IMConversationType.dm.rawValue,
            members: members
        )

        XCTAssertTrue(IMGroupAgentMembershipPolicy.canAddAgent(to: group, currentUserId: "member"))
        XCTAssertTrue(IMGroupAgentMembershipPolicy.canAddAgent(to: group, currentUserId: "admin"))
        XCTAssertTrue(IMGroupAgentMembershipPolicy.canAddAgent(to: group, currentUserId: "owner"))
        XCTAssertFalse(IMGroupAgentMembershipPolicy.canAddAgent(to: group, currentUserId: "agent"))
        XCTAssertFalse(IMGroupAgentMembershipPolicy.canAddAgent(to: externalGroup, currentUserId: "owner"))
        XCTAssertFalse(IMGroupAgentMembershipPolicy.canAddAgent(to: teamSpaceChannel, currentUserId: "owner"))
        XCTAssertFalse(
            IMGroupAgentMembershipPolicy.canAddAgent(
                to: group,
                currentUserId: "owner",
                catalogIsExternal: true
            )
        )
        XCTAssertFalse(IMGroupAgentMembershipPolicy.canAddAgent(to: directMessage, currentUserId: "owner"))
    }

    func testMemberManagementUsesConversationRoleAndAgentOwnership() {
        let admin = IMMember(userId: "admin", role: 2)
        let owner = IMMember(userId: "owner", role: 3)
        let member = IMMember(userId: "member", role: 1)
        let agent = IMMember(memberType: IMMemberType.agent.rawValue, agentId: "agent", role: 1)
        let group = IMConversationDetail(
            id: "group",
            organizationId: "org",
            type: IMConversationType.group.rawValue,
            members: [admin, owner, member, agent]
        )
        let ownedBinding = IMConversationAgentBinding(
            agentId: "agent",
            workspaceId: "workspace",
            workspaceName: "执行现场",
            boundByUserId: "member",
            boundAt: nil,
            canRebind: true,
            isExecutable: true
        )

        XCTAssertTrue(IMConversationMemberManagementPolicy.canRemove(
            from: group, currentUserId: "admin", member: member, binding: nil
        ))
        XCTAssertFalse(IMConversationMemberManagementPolicy.canRemove(
            from: group, currentUserId: "admin", member: owner, binding: nil
        ))
        XCTAssertFalse(IMConversationMemberManagementPolicy.canRemove(
            from: group, currentUserId: "admin", member: admin, binding: nil
        ))
        XCTAssertFalse(IMConversationMemberManagementPolicy.canRemove(
            from: group, currentUserId: "member", member: admin, binding: nil
        ))
        XCTAssertTrue(IMConversationMemberManagementPolicy.canRemove(
            from: group, currentUserId: "member", member: agent, binding: ownedBinding
        ))
        XCTAssertFalse(IMConversationMemberManagementPolicy.canRemove(
            from: IMConversationDetail(
                id: "channel",
                organizationId: "org",
                isTeamSpaceChannel: true,
                type: IMConversationType.group.rawValue,
                members: [admin, member]
            ),
            currentUserId: "admin",
            member: member,
            binding: nil
        ))
    }

    func testAddOnlyModeExcludesExistingAgentsWithoutHidingMentionCandidates() async {
        let svc = FakeConversationService(agents: [
            IMAgentSummary(id: "a1", name: "已在群"),
            IMAgentSummary(id: "a2", name: "可添加"),
        ])
        let model = AgentMentionPickerModel(
            conversationId: "c1", organizationId: "o1",
            existingAgentIds: ["a1"], service: svc
        )

        await model.load()

        XCTAssertEqual(model.agents(for: .mention).map(\.id), ["a1", "a2"])
        XCTAssertEqual(model.agents(for: .addOnly).map(\.id), ["a2"])
    }

    func testPickExistingMemberSkipsAddAgents() async {
        let svc = FakeConversationService(bindings: [
            IMConversationAgentBinding(
                agentId: "a1", workspaceId: "ws-1", workspaceName: "执行现场",
                boundByUserId: "owner", boundAt: nil, canRebind: true, isExecutable: true
            ),
        ])
        let model = AgentMentionPickerModel(
            conversationId: "c1", organizationId: "o1",
            existingAgentIds: ["a1"], service: svc
        )
        await model.loadBindings()
        let ok = await model.pick(IMAgentSummary(id: "a1", name: "已在群"))
        XCTAssertTrue(ok, "已在会话的 Agent 可直接作 mention")
        let calls = await svc.bindAgentCalls
        XCTAssertTrue(calls.isEmpty, "已在会话不应再次创建 binding")
    }

    func testStaleExistingBindingMustRebindBeforeMention() async {
        let svc = FakeConversationService(bindings: [
            IMConversationAgentBinding(
                agentId: "a1", workspaceId: "ws-old", workspaceName: "离线现场",
                boundByUserId: "owner", boundAt: nil, canRebind: true, isExecutable: false
            ),
        ])
        let model = AgentMentionPickerModel(
            conversationId: "c1", organizationId: "o1",
            existingAgentIds: ["a1"], service: svc
        )
        let agent = IMAgentSummary(id: "a1", name: "已在群")

        await model.loadBindings()
        let directPick = await model.pick(agent)
        XCTAssertFalse(directPick, "失效 binding 不能直接 mention")
        let reboundPick = await model.pick(agent, workspaceId: "ws-new")
        XCTAssertTrue(reboundPick)

        let calls = await svc.updateAgentBindingCalls
        XCTAssertEqual(calls.map { [$0.0, $0.1] }, [["a1", "ws-new"]])
        XCTAssertTrue(model.canMentionDirectly(agent))
    }

    func testPickNewAgentAddsMemberBeforeMention() async {
        let svc = FakeConversationService()
        let model = AgentMentionPickerModel(
            conversationId: "c1", organizationId: "o1",
            existingAgentIds: [], service: svc
        )
        let agent = IMAgentSummary(id: "a2", name: "新 Agent")

        let ok = await model.pick(agent, workspaceId: "ws-1")
        XCTAssertTrue(ok)
        XCTAssertTrue(model.isMember(agent))
        XCTAssertNil(model.pickError)
        let calls = await svc.bindAgentCalls
        XCTAssertEqual(calls.map { [$0.0, $0.1] }, [["a2", "ws-1"]], "新 Agent 必须绑定执行现场后再插入 mention")
    }

    func testPickFailureCanBeDismissed() async {
        let svc = FakeConversationService(addShouldFail: true)
        let model = AgentMentionPickerModel(
            conversationId: "c1", organizationId: "o1",
            existingAgentIds: [], service: svc
        )
        let ok = await model.pick(IMAgentSummary(id: "a3", name: "未派驻"), workspaceId: "ws-1")
        XCTAssertFalse(ok)
        XCTAssertNotNil(model.pickError)
        XCTAssertFalse(model.isMember(IMAgentSummary(id: "a3", name: "未派驻")))

        model.clearPickError()
        XCTAssertNil(model.pickError, "关闭 alert 后应清空提示")
    }
}
