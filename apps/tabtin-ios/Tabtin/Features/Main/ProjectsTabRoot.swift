import SwiftUI

private enum ProjectsNavigationRoute: Hashable {
    case project(ProjectRoute)
    case imConversation(IMConversationTarget)
    case taskConversation(ConversationTarget)
    case notifications
    case account(AccountGlobalPushDestination)
}

/// 项目 Tab 根：对齐 Electron projects 域。
///
/// 项目是独立的一级工作面，不再挂在消息页的二级分段下：
/// 列表、搜索词与导航栈都归本根自己持有，切到消息页再切回来仍是原样。
struct ProjectsTabRoot: View {
    @State private var projectStore = ProjectStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var router = MainRouter.shared
    @State private var accountDrawerCoordinator = AccountDrawerCoordinator.shared
    @State private var path: [ProjectsNavigationRoute] = []
    @State private var searchQuery = ""
    @State private var isSearchPresented = false

    var body: some View {
        NavigationStack(path: $path) {
            content
                .searchable(
                    text: $searchQuery,
                    isPresented: $isSearchPresented,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: L10n.Project.searchPlaceholder
                )
                .ttRootNavigationTitle(L10n.Common.tabProjects)
                .background(.tt.bgCanvasDefault)
                .ttToolbarBackground()
                .toolbar {
                    AccountDrawerToolbarLeadingItem()
                    ToolbarItem(placement: .topBarTrailing) {
                        NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                            path.append(.notifications)
                        }
                    }
                }
                .navigationDestination(for: ProjectsNavigationRoute.self) { route in
                    switch route {
                    case .project(let projectRoute):
                        if let project = projectStore.project(id: projectRoute.projectId) {
                            ProjectDetailScreen(
                                project: project,
                                onStartTask: { prompt, agentId, workspace in
                                    MainRouter.shared.openConversation(ConversationTarget(
                                        title: project.name,
                                        workspaceId: workspace.id,
                                        organizationId: project.organizationId,
                                        // nil 时让统一 Composer 在草稿中选择 Agent。
                                        agentId: agentId,
                                        projectId: project.id,
                                        startsNewSession: true,
                                        initialMessage: prompt
                                    ))
                                },
                                onOpenIMConversation: {
                                    path.append(.imConversation($0))
                                }
                            )
                            .id(project.id)
                            .toolbar(.hidden, for: .tabBar)
                        } else {
                            ContentUnavailableView(
                                L10n.Project.detailNotFound,
                                systemImage: "folder.badge.questionmark"
                            )
                        }
                    case .imConversation(let target):
                        IMConversationScreen(
                            conversationId: target.conversationId,
                            title: target.title,
                            onOpenConversation: {
                                path.append(.imConversation($0))
                            },
                            onOpenChatSession: {
                                path.append(.taskConversation($0))
                            }
                        )
                        .toolbar(.hidden, for: .tabBar)
                    case .taskConversation(let target):
                        ConversationScreen(
                            target: target,
                            onBack: {
                                if !path.isEmpty { path.removeLast() }
                            },
                            onOpenConversation: { forkedTarget in
                                path.append(.taskConversation(forkedTarget))
                            }
                        )
                        .toolbar(.hidden, for: .tabBar)
                    case .notifications:
                        NotificationCenterScreen(onOpenConversation: { target in
                            path = []
                            MainRouter.shared.openConversation(target)
                        }, onOpenIMConversation: { target in
                            path = [.imConversation(target)]
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
                                path = [.imConversation(target)]
                            }
                        )
                        .toolbar(.hidden, for: .tabBar)
                    }
                }
        }
        .onChange(of: workspace.selectedOrganizationId) { _, _ in
            path = []
        }
        .onChange(of: path.count) { _, count in
            router.setTabPushed(.projects, pushed: count > 0)
        }
        .onChange(of: accountDrawerCoordinator.pendingGlobalPushDestination) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onChange(of: router.selectedTab) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onAppear {
            router.setTabPushed(.projects, pushed: path.count > 0)
            consumePendingAccountGlobalPush()
        }
    }

    private var content: some View {
        ProjectListView(
            searchQuery: searchQuery,
            listHeader: nil
        ) { project in
            path.append(.project(ProjectRoute(projectId: project.id)))
        }
        .ttDismissKeyboardOnContentTap()
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }

    private func consumePendingAccountGlobalPush() {
        guard router.selectedTab == .projects,
              let destination = accountDrawerCoordinator.pendingGlobalPushDestination else { return }
        path.append(.account(destination))
        accountDrawerCoordinator.completeGlobalPushNavigation(destination)
    }
}

struct ProjectRoute: Hashable {
    let projectId: String
}
