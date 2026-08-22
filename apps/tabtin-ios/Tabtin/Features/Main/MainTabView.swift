import SwiftUI
import UIKit

/// 主界面：iOS 18 原生 TabView 同时承载 iPhone 底栏与 iPad 侧栏。
///
/// ``MainNavTab.primaryTabs`` 里的根始终挂载，Tab 切换不会销毁各自
/// NavigationStack、筛选或草稿状态。项目入口暂时不在 primaryTabs 里。
struct MainTabView: View {
    @SceneStorage("tabtin.main.selectedTab")
    private var storedSelectedTabRawValue = MainNavTab.tasks.rawValue
    // 只读：消息与项目已是各自的一级 Tab，这个键不再写入，仅用于把合并期
    // 存过 "collaboration" 的场景还原到用户上次真正停留的工作面。
    @SceneStorage("tabtin.collaboration.selectedSection.v2")
    private var storedCollaborationSectionRawValue = ""

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    @State private var router = MainRouter.shared
    @State private var imStore = IMConversationStore.shared
    @State private var projectStore = ProjectStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var didRestoreSceneSelection = false

    /// 与目的地 `ttTabBarHidden` 同口径：仅 phone + compact（nil 亦按 compact）在 push 时藏底栏。
    private var shouldHideTabBar: Bool {
        router.selectedTabHasPushedChild
            && TTTabBarVisibilityPolicy.shouldHide(
                requested: true,
                isPhone: UIDevice.current.userInterfaceIdiom == .phone,
                isCompactWidth: horizontalSizeClass.map { $0 == .compact }
            )
    }

    var body: some View {
        AccountDrawerHost {
            TabView(selection: selectedTabBinding) {
                ForEach(MainNavTab.primaryTabs) { tab in
                    Tab(value: tab) {
                        // toolbar(for: .tabBar) 挂在 Tab 内容上才生效；挂在 TabView 根上会被忽略，
                        // 去掉目的地 ttTabBarHidden 后就会出现「对话页底栏常驻」。
                        tabRoot(for: tab)
                            .toolbar(shouldHideTabBar ? .hidden : .visible, for: .tabBar)
                            .transaction(value: shouldHideTabBar) { transaction in
                                transaction.disablesAnimations = true
                            }
                    } label: {
                        Label {
                            Text(tab.title)
                        } icon: {
                            Image(tab.iconAsset)
                                .resizable()
                                .renderingMode(.template)
                                .scaledToFit()
                                .frame(width: 22, height: 22)
                        }
                    }
                    .badge(badgeCount(for: tab))
                }
            }
            .tabViewStyle(.sidebarAdaptable)
            .tint(.tt.bgAccent)
        }
        .onAppear {
            restoreSceneSelectionIfNeeded()
            AccountDrawerCoordinator.shared.consumePendingGlobalDestinationIfReady()
            PerfTrace.markInteractive("MainTabView")
            Task { @MainActor in
                try? await Task.sleep(for: .milliseconds(500))
                KeyboardWarmer.warmIfNeeded()
            }
            #if DEBUG
            if AccountDrawerLiveHarness.isEnabled {
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(800))
                    _ = await AccountDrawerLiveHarness.run()
                }
            }
            #endif
        }
        .onChange(of: router.selectedTab) { _, tab in
            if tab.isPrimary {
                storedSelectedTabRawValue = tab.rawValue
            }
        }
        .task(id: workspace.selectedOrganizationId) {
            let organizationId = workspace.selectedOrganizationId
            // 默认首屏已从「最近」切为「任务」，不能再把 IM 列表 / personal realtime
            // 的启动绑定在消息子域是否被点开。否则用户留在任务页时，协作 badge 会停在
            // 初始值，直到第一次手动进入消息页才恢复更新。
            if let organizationId, !organizationId.isEmpty {
                imStore.loadConversations(organizationId: organizationId)
            } else {
                imStore.clear()
            }
            // 项目数据属于主界面级缓存：只在 Organization 边界清空。
            // 项目根本身不再承担加载职责，切换系统 Tab 时可直接恢复已有页面与列表。
            projectStore.clearForOrganizationSwitch()
            async let projectsLoad: Void = projectStore.load(organizationId: organizationId)
            async let notificationsLoad: Void = notificationStore.activate(organizationId: organizationId)
            _ = await (projectsLoad, notificationsLoad)
        }
        .task {
            await InvitationService.shared.loadMyPendingInvitations()
        }
        .alert(item: Binding(
            get: { imStore.personalNotice },
            set: { if $0 == nil { imStore.dismissPersonalNotice() } }
        )) { notice in
            let agentName = notice.agentName.isEmpty ? "AI" : notice.agentName
            let title = notice.kind == .aiError
                ? L10n.Messages.aiReplyFailed(agentName)
                : L10n.Messages.aiSuggestTaskTitle
            let detail = notice.kind == .aiError
                ? notice.reason
                : L10n.Messages.aiSuggestTaskDescription(agentName)
            let buttonTitle = notice.kind == .aiSuggestTask && notice.conversationId != nil
                ? "查看会话"
                : L10n.Common.confirm
            return Alert(
                title: Text(title),
                message: detail.isEmpty ? nil : Text(detail),
                dismissButton: .default(Text(buttonTitle)) {
                    if notice.kind == .aiSuggestTask, let conversationId = notice.conversationId {
                        let conversationTitle = imStore.conversations
                            .first(where: { $0.id == conversationId })?
                            .name
                            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        MainRouter.shared.openIMConversation(IMConversationTarget(
                            conversationId: conversationId,
                            title: conversationTitle.isEmpty ? "消息" : conversationTitle
                        ))
                    }
                    imStore.dismissPersonalNotice()
                }
            )
        }
    }

    /// 通过自定义 Binding 把系统 Tab 的每次选择都交给 Router。
    ///
    /// 与 `onChange` 不同，重复点按当前「消息」Tab 时 setter 仍有机会执行，
    /// Router 会递增激活序号，保留「再点一次就刷新会话列表」的语义。
    private var selectedTabBinding: Binding<MainNavTab> {
        Binding(
            get: {
                // 项目等暂时下线的入口可能仍留在 Router / 旧 Scene 状态里；
                // TabView 只挂 primaryTabs，selection 必须落在可见项上。
                router.selectedTab.isPrimary ? router.selectedTab : .tasks
            },
            set: { tab in
                guard tab.isPrimary else { return }
                storedSelectedTabRawValue = tab.rawValue
                router.selectTab(tab)
            }
        )
    }

    /// 未读消息只落在消息 Tab，待处理项目邀请只落在项目 Tab：
    /// 角标指向哪个 Tab，用户点进去就该看到对应的事，不再混算成一个总数。
    private func badgeCount(for tab: MainNavTab) -> Int {
        switch tab {
        case .messages: return max(0, imStore.aggregateUnreadCount)
        case .projects: return max(0, projectStore.pendingInvitations.count)
        default: return 0
        }
    }

    @ViewBuilder
    private func tabRoot(for tab: MainNavTab) -> some View {
        switch tab {
        case .tasks:
            TaskHomeRoot()
        case .cloudDocs:
            CloudDocsTabRoot()
        case .automation:
            EmptyView()
        case .agents:
            AgentsTabRoot()
        case .messages:
            MessagesTabRoot()
        case .projects:
            ProjectsTabRoot()
        case .recent, .profile:
            EmptyView()
        }
    }

    /// 一级 Tab 由父根统一恢复，子根不各自读取 SceneStorage。
    ///
    /// 冷启动深链时子根可能先消费 pending，若子根再读旧值就会把新导航意图覆盖掉。
    /// Router 的程序化修订号即使在 pending 已被清空后仍会保留新意图，
    /// 因而是恢复是否安全的权威判断。
    private func restoreSceneSelectionIfNeeded() {
        guard !didRestoreSceneSelection else { return }
        didRestoreSceneSelection = true

        // 启动期深链比上次 Scene 选择优先，不能把待打开会话 / 资源切走。
        let hasPendingNavigation = router.pendingConversation != nil
            || router.pendingIMConversation != nil
            || router.pendingWorkspaceId != nil
            || router.pendingResource != nil
            || router.pendingAutomation != nil
        guard let restoredTab = MainNavigationRestorePolicy.restoration(
            storedTabRawValue: storedSelectedTabRawValue,
            storedCollaborationSectionRawValue: storedCollaborationSectionRawValue,
            currentTab: router.selectedTab,
            hasPendingNavigation: hasPendingNavigation,
            programmaticNavigationRevision: router.programmaticNavigationRevision
        ) else {
            persistCurrentNavigation()
            return
        }
        // Scene 恢复不是一次用户重新点按，直接赋值可避免消息页重复激活。
        router.selectedTab = restoredTab
        persistCurrentNavigation()
    }

    private func persistCurrentNavigation() {
        if router.selectedTab.isPrimary {
            storedSelectedTabRawValue = router.selectedTab.rawValue
        }
    }
}
