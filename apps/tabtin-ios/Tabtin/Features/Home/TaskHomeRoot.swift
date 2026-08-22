import SwiftUI

/// 任务首页只让一种强类型路由进入 NavigationStack。
/// 避免 SwiftUI 在会话与个人页两种异构值之间比较 NavigationPath 时触发
/// `AnyNavigationPath.Error.comparisonTypeMismatch`。
enum TaskHomeRoute: Hashable {
    case conversation(ConversationTarget)
    case automation
    case archived
    case notifications
    case account(AccountGlobalPushDestination)
}

enum TaskHomeAutomationEntryPolicy {
    static func organizationId(from selectedOrganizationId: String?) -> String? {
        guard let selectedOrganizationId else { return nil }
        let organizationId = selectedOrganizationId
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !organizationId.isEmpty else { return nil }
        return organizationId
    }
}

enum TaskHomeSessionActionPolicy {
    static func canArchive(status: String?) -> Bool {
        status?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() != "archived"
    }
}

/// 任务首页：对齐 Electron 任务域侧栏语义。
///
/// - 导航栏：左上三横杠菜单（开账户侧栏）、中间「任务」、右上通知（固定不随列表滚动）
/// - 顶栏下侧次级动作条：自动化（钉钉式 icon+文字）
/// - 组织切换只留账户侧栏；顶栏不再放组织切换器
/// - 可滚动区：只读设备状态条、Workspace 筛选行（左）+ 新任务（右）、任务列表
/// - 设备状态条不筛选会话；离线说明由会话内 Composer 承担，列表页不重复播报
struct TaskHomeRoot: View {
    @State private var sessionsStore = RecentSessionsStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var router = MainRouter.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var accountDrawerCoordinator = AccountDrawerCoordinator.shared
    @State private var path: [TaskHomeRoute] = []
    @State private var showNoWorkspaceAlert = false
    @State private var sessionPendingRename: RecentSession?
    @State private var renameTitle = ""
    @State private var sessionPendingArchive: RecentSession?
    @State private var sessionPendingDelete: RecentSession?
    /// 状态筛选入口已下线；列表固定看活跃任务，只按 Workspace 过滤。
    private let scope: TaskHomeScope = .all
    @SceneStorage("taskHome.workspaceId") private var storedWorkspaceId: String = ""

    /// 空串是「未筛选」的存储表示——SceneStorage 不接受 Optional<String>。
    private var selectedWorkspaceId: String? {
        get { storedWorkspaceId.isEmpty ? nil : storedWorkspaceId }
        nonmutating set { storedWorkspaceId = newValue ?? "" }
    }

    private var executionWorkspaces: [Space] {
        workspace.spaces.filter { space in
            space.isExecutionSpace && space.isArchived != true
        }
    }

    private var deviceItems: [TaskHomeDevicePolicy.DeviceItem] {
        let devices = Dictionary(
            executionWorkspaces.compactMap { space -> (String, RuntimeDevice)? in
                guard let device = workspace.executionDevice(for: space) else { return nil }
                return (device.id, device)
            },
            uniquingKeysWith: { first, _ in first }
        )
        return TaskHomeDevicePolicy.items(
            workspaceDeviceIds: executionWorkspaces.map(\.executionDeviceId),
            devices: devices.values.map {
                (id: $0.id, name: $0.name, isOffline: !$0.isAvailableForExecution)
            },
            fallbackName: L10n.SpaceList.unnamedDevice
        )
    }

    private var orderedSessions: [RecentSession] {
        RecentSessionActivityPolicy.sortByActivity(sessionsStore.sessions)
    }

    /// 当前范围内的会话，扁平按时间倒序——不再按 Workspace 切段。
    /// 只按 Workspace 过滤；运行范围固定为活跃任务。
    private var visibleSessions: [RecentSession] {
        orderedSessions.filter { session in
            let state = presentationState(for: session)
            guard scope.matches(state: state, session: session) else { return false }
            guard let selectedWorkspaceId else { return true }
            return session.executionWorkspaceId == selectedWorkspaceId
        }
    }

    /// 置顶必须跟着范围走——否则选「已归档」时置顶的活跃任务照样露在顶部，
    /// 用户看到的内容和标题声称的范围对不上。
    private var pinnedSessions: [RecentSession] {
        visibleSessions.filter(\.isPinned)
    }

    /// 「需要你」与置顶互斥：已置顶的待办只出现在置顶区，避免 List 重复 id。
    private var needsYouSessions: [RecentSession] {
        let pinnedIds = Set(pinnedSessions.map(\.id))
        return visibleSessions.filter {
            !pinnedIds.contains($0.id)
                && TaskRowStatusPresentation.needsUserAction(presentationState(for: $0))
        }
    }

    private var restSessions: [RecentSession] {
        let pinnedIds = Set(pinnedSessions.map(\.id))
        let needsYouIds = Set(needsYouSessions.map(\.id))
        return visibleSessions.filter {
            !needsYouIds.contains($0.id) && !pinnedIds.contains($0.id)
        }
    }

    /// 置顶 / 需要你 两段语义在前，其余按时间落桶。
    private var sessionGroups: [TaskHomeSessionGrouping.Group] {
        TaskHomeSessionGrouping.groups(
            pinned: pinnedSessions,
            needsYou: needsYouSessions,
            rest: restSessions
        )
    }

    private func presentationState(for session: RecentSession) -> AgentRunPresentationState {
        TaskHomeSessionStatusPolicy.presentation(
            for: session,
            resolvedRunStatus: sessionsStore.resolvedRunStatus(for: session),
            statusOverride: TaskHomeSessionStatusPolicy.override(
                for: session,
                notifications: notificationStore.notifications
            ),
            hasPendingInteraction: PendingInteractionStore.shared.hasPendingForSession(session.id)
        )
    }

    private var sessionReloadTaskKey: String {
        [
            scope.rawValue,
            selectedWorkspaceId ?? "",
            scope.wireStatus ?? "",
            scope.wireRunStatus ?? "",
        ].joined(separator: "|")
    }

    var body: some View {
        taskHomeDialogs
    }

    private var taskHomeDialogs: some View {
        taskHomeLifecycle
            .alert("暂无可用 Workspace", isPresented: $showNoWorkspaceAlert) {
                Button("知道了", role: .cancel) {}
            } message: {
                Text("请先创建或加入一个可执行 Workspace，再开始新任务。")
            }
            .alert("重命名会话", isPresented: Binding(
                get: { sessionPendingRename != nil },
                set: { if !$0 { sessionPendingRename = nil } }
            )) {
                TextField("会话名称", text: $renameTitle)
                Button("取消", role: .cancel) { sessionPendingRename = nil }
                Button("保存") {
                    guard let session = sessionPendingRename else { return }
                    sessionPendingRename = nil
                    Task { await sessionsStore.rename(session: session, title: renameTitle) }
                }
            } message: {
                Text("名称会同步到该会话。")
            }
            .confirmationDialog("归档会话？", isPresented: Binding(
                get: { sessionPendingArchive != nil },
                set: { if !$0 { sessionPendingArchive = nil } }
            ), titleVisibility: .visible) {
                Button("归档") {
                    guard let session = sessionPendingArchive else { return }
                    sessionPendingArchive = nil
                    Task { await sessionsStore.archive(session: session) }
                }
                Button("取消", role: .cancel) { sessionPendingArchive = nil }
            } message: {
                Text("归档后任务仍保留在列表中，并标记为“已归档”。")
            }
            .confirmationDialog("删除会话？", isPresented: Binding(
                get: { sessionPendingDelete != nil },
                set: { if !$0 { sessionPendingDelete = nil } }
            ), titleVisibility: .visible) {
                Button("删除", role: .destructive) {
                    guard let session = sessionPendingDelete else { return }
                    sessionPendingDelete = nil
                    Task { _ = await sessionsStore.delete(session: session) }
                }
                Button("取消", role: .cancel) { sessionPendingDelete = nil }
            } message: {
                Text("删除后无法恢复。")
            }
            .alert("操作未完成", isPresented: Binding(
                get: { sessionsStore.mutationError != nil },
                set: { if !$0 { sessionsStore.clearMutationError() } }
            )) {
                Button("知道了", role: .cancel) { sessionsStore.clearMutationError() }
            } message: {
                Text(sessionsStore.mutationError ?? "请稍后重试。")
            }
    }

    private var taskHomeLifecycle: some View {
        navigationRoot
            .task(id: workspace.selectedOrganizationId) {
                sessionsStore.clearForOrganizationSwitch()
                if let organizationId = workspace.selectedOrganizationId {
                    CentrifugoClient.shared.connect()
                    // 先拉 Workspace 再校验 SceneStorage：冷启动换组织时旧 workspaceId
                    // 仍在，并行 reload 会带着失效筛选打空列表。
                    await workspace.loadSpaces()
                    sanitizeSelectedWorkspaceId()
                    // 列表脸按 agentId 查组织 Agent 缓存；进任务页就预热，避免全表默认脸。
                    await MyAgentsStore.shared.ensureLoaded(organizationId: organizationId)
                    await reloadSessions()
                } else {
                    await workspace.loadOrganizations()
                }
            }
            .onChange(of: workspace.selectedOrganizationId) { _, _ in
                path = []
                selectedWorkspaceId = nil
            }
            .onChange(of: workspace.spacesLoadedOrganizationId) { _, _ in
                sanitizeSelectedWorkspaceId()
            }
            .onChange(of: workspace.spaces.map(\.id)) { _, _ in
                sanitizeSelectedWorkspaceId()
            }
            .task(id: sessionReloadTaskKey) {
                guard workspace.selectedOrganizationId != nil else { return }
                await reloadSessions()
            }
            .onChange(of: path.count) { _, count in
                router.setTabPushed(.tasks, pushed: count > 0)
                // 从对话 / 子页 pop 回列表时重拉，带上最新 primary_surface。
                if count == 0 {
                    Task { await reloadSessions() }
                }
            }
            .onChange(of: router.pendingConversation) { _, pending in
                consumePending(pending)
            }
            .onChange(of: router.pendingAutomation?.id) { _, _ in
                openAutomationIfPending()
            }
            .onChange(of: accountDrawerCoordinator.pendingGlobalPushDestination) { _, _ in
                consumePendingAccountGlobalPush()
            }
            .onChange(of: router.selectedTab) { _, _ in
                consumePendingAccountGlobalPush()
            }
            .onAppear {
                consumePending(router.pendingConversation)
                openAutomationIfPending()
                consumePendingAccountGlobalPush()
                if path.isEmpty {
                    Task { await reloadSessions() }
                }
            }
    }

    private var navigationRoot: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle(L10n.Home.title)
                .navigationBarTitleDisplayMode(.inline)
                .background(.tt.bgCanvasDefault)
                .ttToolbarBackground(color: .tt.bgSidebar)
                .toolbar {
                    AccountDrawerToolbarLeadingItem()
                    ToolbarItem(placement: .principal) {
                        VStack(spacing: 1) {
                            Text(L10n.Home.title)
                                .font(.tt.bodyMedium)
                                .foregroundStyle(.tt.textPrimary)
                            if let organizationName = workspace.selectedOrganization?.name
                                .trimmingCharacters(in: .whitespacesAndNewlines),
                               !organizationName.isEmpty {
                                Text(organizationName)
                                    .font(.tt.caption)
                                    .foregroundStyle(.tt.textTertiary)
                                    .lineLimit(1)
                            }
                        }
                        .accessibilityElement(children: .combine)
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                            path.append(.notifications)
                        }
                    }
                }
                .navigationDestination(for: TaskHomeRoute.self) { route in
                    switch route {
                    case .conversation(let target):
                        ConversationScreen(target: target, onBack: {
                            // 先清栈深度再 pop：Tab 根 + 目的地的 toolbar 同步放行，底栏在点击当下出现。
                            router.setTabPushed(.tasks, pushed: false)
                            if !path.isEmpty { path.removeLast() }
                        }, onOpenConversation: { forkedTarget in
                            path.append(.conversation(forkedTarget))
                        })
                        // 跟栈深度联动，勿写死 true：否则 pop 转场期间目的地仍按住 hidden。
                        .ttTabBarHidden(router.selectedTabHasPushedChild)
                    case .automation:
                        AutomationTabRoot()
                            .ttTabBarHidden(router.selectedTabHasPushedChild)
                    case .archived:
                        ArchivedConversationsScreen { target in
                            path.append(.conversation(target))
                        }
                        .ttTabBarHidden(router.selectedTabHasPushedChild)
                    case .notifications:
                        NotificationCenterScreen(onOpenConversation: { target in
                            path = [.conversation(target)]
                        }, onOpenIMConversation: { target in
                            path = []
                            router.openIMConversation(target)
                        })
                        .toolbar(.hidden, for: .tabBar)
                    case .account(let destination):
                        AccountGlobalPushDestinationScreen(
                            destination: destination,
                            onOpenConversation: { target in
                                path = [.conversation(target)]
                            },
                            onOpenIMConversation: { target in
                                path = []
                                router.openIMConversation(target)
                            }
                        )
                        .toolbar(.hidden, for: .tabBar)
                    }
                }
        }
    }

    private func consumePendingAccountGlobalPush() {
        guard router.selectedTab == .tasks,
              let destination = accountDrawerCoordinator.pendingGlobalPushDestination else { return }
        path.append(.account(destination))
        accountDrawerCoordinator.completeGlobalPushNavigation(destination)
    }

    private var content: some View {
        VStack(spacing: 0) {
            PrimaryTabSecondaryBar(
                items: [
                    PrimaryTabSecondaryBarItem(
                        id: "automation",
                        title: L10n.Home.automation,
                        assetName: TaskPrimaryNavIcon.automation.assetName
                    ) {
                        path.append(.automation)
                    },
                    PrimaryTabSecondaryBarItem(
                        id: "archived",
                        title: "已归档",
                        assetName: TaskPrimaryNavIcon.archived.assetName
                    ) {
                        path.append(.archived)
                    },
                ],
                background: .tt.bgSidebar
            )
            conversationList
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }

    /// 随列表一起滚动的页头：只读设备状态 + Workspace 范围。
    private var scrollHeader: some View {
        VStack(spacing: 0) {
            if TaskHomeDevicePolicy.shouldShowRail(items: deviceItems) {
                TaskHomeDeviceRail(items: deviceItems)
                    .padding(.top, TTSpacing.sm)
                    .padding(.bottom, TTSpacing.xs)
                    .background(.tt.bgSidebar)
            }
            scopeHeader
        }
    }

    private var scopeHeader: some View {
        HStack(alignment: .center, spacing: TTSpacing.md) {
            Menu {
                Button {
                    selectedWorkspaceId = nil
                } label: {
                    Label(
                        L10n.Home.filterAll,
                        systemImage: selectedWorkspaceId == nil ? "checkmark" : ""
                    )
                }
                ForEach(executionWorkspaces) { space in
                    Button {
                        selectedWorkspaceId = space.id
                    } label: {
                        Label(
                            space.name,
                            systemImage: selectedWorkspaceId == space.id ? "checkmark" : ""
                        )
                    }
                }
            } label: {
                HStack(spacing: TTSpacing.xxs) {
                    Text(scopeTitle)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                    Image(systemName: "chevron.down")
                        .font(.tt.iconCaption)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            .accessibilityLabel(L10n.Home.workspaceFilter)

            Spacer(minLength: TTSpacing.sm)

            newTaskButton
        }
        .padding(.horizontal, TTSpacing.lg)
        // 不再叠 vertical padding：新任务按钮自带 44pt 点击区，行高由它决定就够，
        // 再加上下留白会在范围行和第一个分段之间空出一大片。
        .background(.tt.bgCanvasDefault)
    }

    /// 选了具体 Workspace 时标题显示 Workspace 名，用户始终知道自己在看什么范围。
    private var scopeTitle: String {
        if let selectedWorkspaceId,
           let space = executionWorkspaces.first(where: { $0.id == selectedWorkspaceId }) {
            return space.name
        }
        return L10n.Home.filterAll
    }

    @ViewBuilder
    private var conversationList: some View {
        List {
            scrollHeader
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)

            if (sessionsStore.isLoading || workspace.isLoadingOrganizations), orderedSessions.isEmpty {
                placeholderRow {
                    ProgressView(L10n.Home.loading)
                        .frame(maxWidth: .infinity, minHeight: 80)
                        .padding(.vertical, TTSpacing.xxl)
                }
            } else if let workspaceError = workspace.errorMessage,
                      workspace.selectedOrganizationId == nil,
                      orderedSessions.isEmpty {
                placeholderRow {
                    errorState(workspaceError)
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else if let err = sessionsStore.loadError, orderedSessions.isEmpty {
                placeholderRow {
                    errorState(err)
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else if orderedSessions.isEmpty {
                placeholderRow {
                    emptyState
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else {
                ForEach(sessionGroups) { group in
                    bandHeader(group.band)
                    ForEach(group.sessions) {
                        taskSessionRow($0, isPinned: group.band == .pinned ? true : nil)
                    }
                }

                if sessionsStore.isLoadingMore {
                    HStack {
                        Spacer()
                        ProgressView("正在加载更多")
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                } else if sessionsStore.hasMore {
                    Button("加载更多") { Task { await sessionsStore.loadMore() } }
                        .frame(maxWidth: .infinity)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.plain)
        .listSectionSpacing(0)
        .scrollContentBackground(.hidden)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .ttBrandedRefreshable { await reload() }
    }

    /// 分段标题只是坐标，不是内容：弱色、无底、无计数徽章，让列表本身说话。
    private func bandHeader(_ band: TaskHomeSessionGrouping.Band) -> some View {
        HStack(spacing: TTSpacing.xs) {
            if band.showsPinGlyph {
                Image(systemName: "pin.fill")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textSecondary)
            }
            Text(band.title)
                .font(.tt.metaSemibold)
                .foregroundStyle(band == .needsYou ? .tt.textWarning : .tt.textSecondary)
            Spacer()
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, TTSpacing.md)
        .padding(.bottom, TTSpacing.xs)
        .listRowInsets(EdgeInsets())
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private func taskSessionRow(_ session: RecentSession, isPinned: Bool? = nil) -> some View {
        let pinned = isPinned ?? session.isPinned
        let statusOverride = TaskHomeSessionStatusPolicy.override(
            for: session,
            notifications: notificationStore.notifications
        )
        if let target = conversationTarget(for: session) {
            Button {
                notificationStore.acknowledgeAgentSession(session.id)
                path.append(.conversation(target))
            } label: {
                TaskHomeSessionRow(
                    session: session,
                    isPinned: pinned,
                    isMutating: sessionsStore.mutatingSessionIds.contains(session.id),
                    statusOverride: statusOverride,
                    resolvedRunStatus: sessionsStore.resolvedRunStatus(for: session)
                )
            }
            .buttonStyle(.plain)
            .disabled(sessionsStore.mutatingSessionIds.contains(session.id))
            .contextMenu { sessionActions(for: session, isPinned: pinned) }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            // 不画分隔线：44pt 头像本身就是每行的左边界，再加横线只会把列表切碎。
            .listRowSeparator(.hidden)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                Button {
                    Task { await sessionsStore.setPinned(session: session, pinned: !pinned) }
                } label: {
                        Label(
                            pinned ? L10n.Home.unpinConversation : L10n.Home.pinConversation,
                            systemImage: pinned ? "pin.slash" : "pin"
                        )
                }
                .tint(pinned ? .gray : .tt.bgAccent)

                if TaskHomeSessionActionPolicy.canArchive(status: session.status) {
                    Button(role: .destructive) {
                        sessionPendingArchive = session
                    } label: {
                        Label(L10n.Agent.archiveSession, systemImage: "archivebox")
                    }
                    .tint(.tt.textCritical)
                    .disabled(sessionsStore.mutatingSessionIds.contains(session.id))
                }
            }
        } else {
            TaskHomeSessionRow(
                session: session,
                isPinned: pinned,
                isMutating: sessionsStore.mutatingSessionIds.contains(session.id),
                statusOverride: statusOverride,
                resolvedRunStatus: sessionsStore.resolvedRunStatus(for: session)
            )
            .opacity(0.5)
            .contextMenu { sessionActions(for: session, isPinned: pinned) }
            .listRowInsets(EdgeInsets())
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if TaskHomeSessionActionPolicy.canArchive(status: session.status) {
                    Button(role: .destructive) {
                        sessionPendingArchive = session
                    } label: {
                        Label(L10n.Agent.archiveSession, systemImage: "archivebox")
                    }
                    .tint(.tt.textCritical)
                    .disabled(sessionsStore.mutatingSessionIds.contains(session.id))
                }
            }
        }
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(L10n.Home.emptyTitle, systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text(L10n.Home.emptyDescription)
        } actions: {
            newTaskButton
        }
    }

    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message) {
            Task { await reload() }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, TTSpacing.xl)
    }

    @ViewBuilder
    private func sessionActions(for session: RecentSession, isPinned: Bool) -> some View {
        Button(isPinned ? "取消置顶" : "置顶") {
            Task { await sessionsStore.setPinned(session: session, pinned: !isPinned) }
        }

        Button("重命名") {
            renameTitle = session.title ?? ""
            sessionPendingRename = session
        }

        if TaskHomeSessionActionPolicy.canArchive(status: session.status) {
            Button("归档") { sessionPendingArchive = session }
        }

        Button("删除", role: .destructive) { sessionPendingDelete = session }
    }

    private func conversationTarget(for session: RecentSession) -> ConversationTarget? {
        RecentConversationTargetResolver.resolve(
            session,
            fallbackOrganizationId: workspace.selectedOrganizationId
        )
    }

    /// 直接进草稿：新任务页可切换 Workspace，入口不再弹选择器。
    private var newTaskButton: some View {
        Button {
            startNewTask()
        } label: {
            HStack(spacing: TTSpacing.xxs) {
                TaskPrimaryNavIconView(icon: .newTask, size: 16, color: .tt.iconAccent)
                Text(L10n.Home.newTask)
                    .font(.tt.bodyMedium)
                    .foregroundStyle(.tt.textAccent)
            }
            .frame(minHeight: 44)
        }
        .accessibilityLabel(L10n.Home.newTask)
    }

    private func startNewTask(initialMessage: String? = nil, agentId: String? = nil) {
        // 0 个：居中提示；否则按筛选 / 最近 / 默认解析执行现场后直接进草稿。
        // 草稿页可再切换 Workspace，入口不再弹选择器。
        guard let workspace = NewTaskWorkspacePolicy.resolve(
            workspaces: executionWorkspaces,
            selectedWorkspaceId: selectedWorkspaceId,
            recentWorkspaceId: UserDefaults.standard.string(forKey: ComposeSheet.lastWorkspaceKey)
        ) else {
            showNoWorkspaceAlert = true
            return
        }
        openNewTaskDraft(
            workspace: workspace,
            initialMessage: initialMessage,
            agentId: agentId
        )
    }

    private func openNewTaskDraft(
        workspace: Space,
        initialMessage: String? = nil,
        agentId: String? = nil
    ) {
        UserDefaults.standard.set(workspace.id, forKey: ComposeSheet.lastWorkspaceKey)
        path.append(.conversation(ConversationTarget(
            title: workspace.name,
            workspaceId: workspace.id,
            organizationId: workspace.organizationId,
            agentId: agentId,
            startsNewSession: true,
            initialMessage: initialMessage
        )))
    }

    private func reload() async {
        if workspace.selectedOrganizationId == nil {
            await workspace.loadOrganizations()
            return
        }
        await workspace.loadSpaces()
        sanitizeSelectedWorkspaceId()
        await reloadSessions()
    }

    private func reloadSessions() async {
        await sessionsStore.reload(
            keyword: "",
            status: scope.wireStatus,
            workspaceId: selectedWorkspaceId,
            runStatus: scope.wireRunStatus
        )
    }

    /// 当前组织的可执行 Workspace 已就绪后，丢掉跨组织残留的 SceneStorage id。
    private func sanitizeSelectedWorkspaceId() {
        guard workspace.hasLoadedSpacesForSelectedOrganization else { return }

        let sanitized = TaskHomeListPolicy.sanitizedWorkspaceId(
            selected: selectedWorkspaceId,
            availableIds: Set(executionWorkspaces.map(\.id))
        )
        if sanitized != selectedWorkspaceId {
            selectedWorkspaceId = sanitized
        }
    }

    private func consumePending(_ pending: ConversationTarget?) {
        guard let pending else { return }
        path = [.conversation(pending)]
        router.pendingConversation = nil
    }

    private func openAutomationIfPending() {
        guard router.pendingAutomation != nil else { return }
        guard !path.contains(where: {
            if case .automation = $0 { return true }
            return false
        }) else { return }
        path.append(.automation)
    }

}

/// 新任务不因入口不同而漂移执行现场：调用方显式指定的 Workspace 优先，其次最近
/// 使用、组织默认，最后才取列表首项。没有可执行 Workspace 时返回 nil，由轻量引导承接。
enum NewTaskWorkspacePolicy {
    static func resolve(
        workspaces: [Space],
        selectedWorkspaceId: String?,
        recentWorkspaceId: String?
    ) -> Space? {
        for candidateId in [selectedWorkspaceId, recentWorkspaceId].compactMap({ $0 }) {
            if let workspace = workspaces.first(where: { $0.id == candidateId }) {
                return workspace
            }
        }
        return workspaces.first(where: { $0.isDefault == true }) ?? workspaces.first
    }
}
