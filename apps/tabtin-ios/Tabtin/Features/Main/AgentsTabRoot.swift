import SwiftUI

/// AI 分身一级域：可进入组织级技能库，也可在分身详情管理其携带的技能。
struct AgentsTabRoot: View {
    @State private var notificationStore = NotificationStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var router = MainRouter.shared
    @State private var accountDrawerCoordinator = AccountDrawerCoordinator.shared
    @State private var path: [AgentsTabRoute] = []
    @State private var searchQuery = ""
    @State private var activeAgentSheet: MyAgentsSheet?
    @State private var showNoWorkspaceAlert = false
    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                PrimaryTabSecondaryBar(
                    items: [
                        PrimaryTabSecondaryBarItem(
                            id: "skills",
                            title: CapabilityMarketTab.skills.title,
                            assetName: TaskPrimaryNavIcon.skills.assetName
                        ) {
                            path.append(.capabilityMarket(.skills))
                        },
                        PrimaryTabSecondaryBarItem(
                            id: "connectors",
                            title: CapabilityMarketTab.connectors.title,
                            assetName: CapabilityGlyphKind.connector.assetName
                        ) {
                            path.append(.capabilityMarket(.connectors))
                        },
                    ]
                )
                PrimaryTabSearchField(
                    text: $searchQuery,
                    prompt: L10n.Project.myAgentsSearchPlaceholder
                )
                agentWorkspaceContent
            }
            .ttRootNavigationTitle(L10n.Common.tabAgents)
            .background(.tt.bgCanvasDefault)
            .ttToolbarBackground()
            .alert("暂无可用 Workspace", isPresented: $showNoWorkspaceAlert) {
                Button("知道了", role: .cancel) {}
            } message: {
                Text("请先创建或加入一个可执行 Workspace，再开始新任务。")
            }
            .toolbar {
                AccountDrawerToolbarLeadingItem()
                ToolbarItemGroup(placement: .topBarTrailing) {
                    Button {
                        activeAgentSheet = .create
                    } label: {
                        Image(systemName: "plus")
                            .font(.tt.iconSubtitle)
                    }
                    .accessibilityLabel(L10n.Project.myAgentsCreate)

                    NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                        path.append(.notifications)
                    }
                }
            }
            .navigationDestination(for: AgentsTabRoute.self) { route in
                switch route {
                case .agentDetail(let agentId):
                    AgentDetailScreen(
                        agentId: agentId,
                        initialAgent: MyAgentsStore.shared.agents.first(where: { $0.id == agentId }),
                        onOpenConversation: { MainRouter.shared.openConversation($0) },
                        onDeactivated: {
                            guard !path.isEmpty else { return }
                            path.removeLast()
                        }
                    )
                    .toolbar(.hidden, for: .tabBar)
                case .workspace(let spaceId):
                    if let space = workspace.spaces.first(where: { $0.id == spaceId }) {
                        SpaceSessionsView(
                            space: space,
                            onOpen: { MainRouter.shared.openConversation($0) }
                        )
                        .toolbar(.hidden, for: .tabBar)
                    } else {
                        ContentUnavailableView(
                            "工作空间不可用",
                            systemImage: "square.stack.3d.up.slash",
                            description: Text("该工作空间可能已归档、删除，或尚未同步完成。")
                        )
                        .toolbar(.hidden, for: .tabBar)
                    }
                case .capabilityMarket(let initialTab):
                    if let organizationId = workspace.selectedOrganizationId {
                        MobileSkillLibraryScreen(
                            organizationId: organizationId,
                            initialMarketTab: initialTab,
                            onStartTask: startNewTask
                        )
                        .toolbar(.hidden, for: .tabBar)
                    } else {
                        ContentUnavailableView(
                            "暂时无法打开\(initialTab.title)",
                            systemImage: "puzzlepiece.extension",
                            description: Text("请先选择一个组织。")
                        )
                        .toolbar(.hidden, for: .tabBar)
                    }
                case .notifications:
                    NotificationCenterScreen(onOpenConversation: { target in
                        path = []
                        MainRouter.shared.openConversation(target)
                    }, onOpenIMConversation: { target in
                        MainRouter.shared.openIMConversation(target)
                    })
                    .toolbar(.hidden, for: .tabBar)
                case .account(let destination):
                    AccountGlobalPushDestinationScreen(
                        destination: destination,
                        onOpenConversation: { target in
                            path = []
                            MainRouter.shared.openConversation(target)
                        },
                        onOpenIMConversation: { target in
                            path = []
                            MainRouter.shared.openIMConversation(target)
                        }
                    )
                    .toolbar(.hidden, for: .tabBar)
                }
            }
        }
        .onChange(of: path.count) { _, count in
            MainRouter.shared.setTabPushed(.agents, pushed: count > 0)
        }
        .onChange(of: accountDrawerCoordinator.pendingGlobalPushDestination) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onChange(of: router.selectedTab) { _, _ in
            consumePendingAccountGlobalPush()
            consumePendingWorkspace()
        }
        .onChange(of: router.pendingWorkspaceId) { _, _ in
            consumePendingWorkspace()
        }
        .onAppear {
            consumePendingAccountGlobalPush()
            consumePendingWorkspace()
        }
    }

    private var agentWorkspaceContent: some View {
        MyAgentsListView(
            searchQuery: searchQuery,
            listHeader: nil,
            activeSheet: $activeAgentSheet,
            onOpenDetail: { path.append(.agentDetail(agentId: $0.id)) }
        )
        .ttDismissKeyboardOnContentTap()
    }

    private func startNewTask(initialMessage: String, agentId: String?) {
        let executionWorkspaces = workspace.spaces.filter {
            $0.isExecutionSpace && $0.isArchived != true
        }
        guard let selectedWorkspace = NewTaskWorkspacePolicy.resolve(
            workspaces: executionWorkspaces,
            selectedWorkspaceId: nil,
            recentWorkspaceId: UserDefaults.standard.string(forKey: ComposeSheet.lastWorkspaceKey)
        ) else {
            showNoWorkspaceAlert = true
            return
        }

        path = []
        UserDefaults.standard.set(selectedWorkspace.id, forKey: ComposeSheet.lastWorkspaceKey)
        MainRouter.shared.openConversation(ConversationTarget(
            title: selectedWorkspace.name,
            workspaceId: selectedWorkspace.id,
            organizationId: selectedWorkspace.organizationId,
            agentId: agentId,
            startsNewSession: true,
            initialMessage: initialMessage
        ))
    }

    private func consumePendingAccountGlobalPush() {
        guard router.selectedTab == .agents,
              let destination = accountDrawerCoordinator.pendingGlobalPushDestination else { return }
        path.append(.account(destination))
        accountDrawerCoordinator.completeGlobalPushNavigation(destination)
    }

    private func consumePendingWorkspace() {
        guard router.selectedTab == .agents,
              let spaceId = router.pendingWorkspaceId else { return }
        Task { @MainActor in
            if !workspace.spaces.contains(where: { $0.id == spaceId }) {
                await workspace.loadSpaces()
            }
            guard workspace.spaces.contains(where: { $0.id == spaceId }) else {
                router.consumeWorkspace(spaceId)
                router.presentNavigationNotice("该工作空间可能已归档、删除，或尚未同步完成。")
                return
            }
            path = [.workspace(spaceId: spaceId)]
            router.consumeWorkspace(spaceId)
        }
    }

}

private enum AgentsTabRoute: Hashable {
    case agentDetail(agentId: String)
    case workspace(spaceId: String)
    case capabilityMarket(CapabilityMarketTab)
    case notifications
    case account(AccountGlobalPushDestination)
}
