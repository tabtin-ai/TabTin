import SwiftUI

private struct AutomationSelection: Hashable, Identifiable {
    let trackerId: String
    let runId: String?

    var id: String {
        "\(trackerId)|\(runId ?? "")"
    }
}

private enum AutomationRootNavigationRoute: Hashable {
    case notifications
}

enum AutomationTargetScopeResolution: Equatable {
    case waiting
    case ready
    case retry(String)
    case organizationUnavailable
    case workspaceUnavailable
}

/// 自动化深链只在 Organization 与 Workspace 列表都已成为权威快照后才能消费。
/// 抽成纯策略，防止加载中、失败和真正不存在三种状态再次被 UI 时序混为一谈。
enum AutomationTargetScopePolicy {
    static func resolve(
        target: AutomationDeepLinkTarget,
        organizationIds: Set<String>,
        selectedOrganizationId: String?,
        workspaceIds: Set<String>,
        isLoadingSpaces: Bool,
        hasLoadedSpaces: Bool,
        spacesLoadError: String?
    ) -> AutomationTargetScopeResolution {
        guard organizationIds.contains(target.organizationId) else {
            return .organizationUnavailable
        }
        guard selectedOrganizationId == target.organizationId,
              !isLoadingSpaces else {
            return .waiting
        }
        if let spacesLoadError, !spacesLoadError.isEmpty {
            return .retry(spacesLoadError)
        }
        guard hasLoadedSpaces else { return .waiting }
        let workspaceId = target.spaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !workspaceId.isEmpty, workspaceIds.contains(workspaceId) else {
            return .workspaceUnavailable
        }
        return .ready
    }
}

/// 自动化工作面同时服务一级入口与兼容模态入口。
struct AutomationRoot: View {
    let organizationId: String
    let workspaces: [Space]
    let onClose: (() -> Void)?
    let onOpenConversation: (ConversationTarget) -> Void
    let onRequestAgent: ((AutomationAuthoringRequest) -> Void)?
    let pendingAutomation: AutomationDeepLinkTarget?
    let onConsumeAutomation: ((AutomationDeepLinkTarget) -> Void)?
    let onUnavailableAutomation: ((AutomationDeepLinkTarget) -> Void)?
    let isWorkspaceScopeLoading: Bool
    /// 是否自带导航容器。
    ///
    /// 从任务页 `path.append(.automation)` push 进来时必须传 `false`：外层已经有
    /// `NavigationStack(path:)`，再自带一个就是 NavigationStack 套 NavigationStack，
    /// SwiftUI 的 `NavigationColumnState.boundPathChange` 会拿到类型不匹配的路径元素
    /// 直接 trap（EXC_BREAKPOINT，见 2026-08-02 崩溃报告）。模态弹出的旧调用点仍传
    /// `true`——那时它自己就是根，自带容器是对的。
    let providesNavigationContainer: Bool

    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var store: TabTrackerStore
    @State private var selection: AutomationSelection?
    @State private var selectedWorkspaceId: String?
    @State private var statusFilter: TrackerListStatusFilter = .all
    @State private var searchText = ""
    @State private var isSearchPresented = false
    @State private var authoringRequest: AutomationAuthoringRequest?
    @State private var creationDraft: MobileAutomationDraft?
    @State private var agents = MyAgentsStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var rootNavigationRoute: AutomationRootNavigationRoute?

    init(
        organizationId: String,
        workspaces: [Space],
        initialWorkspaceId: String? = nil,
        initialTrackerId: String? = nil,
        initialRunId: String? = nil,
        onClose: (() -> Void)? = nil,
        onOpenConversation: @escaping (ConversationTarget) -> Void,
        onRequestAgent: ((AutomationAuthoringRequest) -> Void)? = nil,
        pendingAutomation: AutomationDeepLinkTarget? = nil,
        onConsumeAutomation: ((AutomationDeepLinkTarget) -> Void)? = nil,
        onUnavailableAutomation: ((AutomationDeepLinkTarget) -> Void)? = nil,
        isWorkspaceScopeLoading: Bool = false,
        providesNavigationContainer: Bool = true
    ) {
        self.organizationId = organizationId
        self.workspaces = workspaces
        self.onClose = onClose
        self.onOpenConversation = onOpenConversation
        self.onRequestAgent = onRequestAgent
        self.pendingAutomation = pendingAutomation
        self.onConsumeAutomation = onConsumeAutomation
        self.onUnavailableAutomation = onUnavailableAutomation
        self.isWorkspaceScopeLoading = isWorkspaceScopeLoading
        self.providesNavigationContainer = providesNavigationContainer
        _store = State(initialValue: TabTrackerStore(organizationId: organizationId))
        _selectedWorkspaceId = State(initialValue: initialWorkspaceId)
        // pendingAutomation 必须先经过 Organization + Workspace 权威校验，
        // 不能在初始化阶段直接展示详情。
        _selection = State(initialValue: initialTrackerId.map {
            AutomationSelection(trackerId: $0, runId: initialRunId)
        })
    }

    var body: some View {
        Group {
            if !providesNavigationContainer {
                // 宿主已经有导航栈：只出内容，详情 push 到宿主栈上。
                embeddedLayout
            } else if AutomationLayoutPolicy.mode(isRegularWidth: horizontalSizeClass == .regular) == .split {
                regularLayout
            } else {
                compactLayout
            }
        }
        .task(id: workspaceScopeKey) {
            validateWorkspaceSelection()
            store.stopRealtime()
            store.startRealtime(workspaceIds: availableWorkspaces.map(\.id))
            async let agentsLoad: Void = agents.load(organizationId: organizationId)
            async let trackersLoad: Void = store.loadTrackers(workspaceId: selectedWorkspaceId)
            async let previewLoad: Void = store.loadSchedulePreview(workspaceId: selectedWorkspaceId)
            _ = await (agentsLoad, trackersLoad, previewLoad)
        }
        .onDisappear { store.stopRealtime() }
        .task(id: "\(searchText)|\(statusFilter.rawValue)") {
            guard !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || statusFilter != .all else { return }
            await store.loadAllRemainingTrackers()
        }
        .task(id: pendingAutomationScopeKey) {
            await consumePendingAutomationIfPossible(pendingAutomation)
        }
        .sheet(item: $authoringRequest) { request in
            AutomationAuthoringSheet(
                request: request,
                canHandOffToAgent: onRequestAgent != nil && request.workspaceId != nil,
                onHandOff: {
                    authoringRequest = nil
                    onRequestAgent?(request)
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(item: $creationDraft) { draft in
            MobileAutomationEditorSheet(
                draft: draft,
                agents: agents.agents.filter { $0.isActive != false },
                workspaces: availableWorkspaces,
                store: store,
                initialWorkspaceId: selectedWorkspaceId,
                onCreated: {
                    Task { await store.loadTrackers(workspaceId: selectedWorkspaceId) }
                }
            )
            .presentationDetents([.large])
        }
        .onAppear {
            // 深链/首帧已有 selection 时 onChange 不会触发，对齐 Messages 等根做首帧上报。
            reportTabPushed()
        }
        .onChange(of: selection) { _, _ in
            reportTabPushed()
        }
        .onChange(of: rootNavigationRoute) { _, _ in
            reportTabPushed()
        }
        .onChange(of: horizontalSizeClass) { _, _ in
            reportTabPushed()
        }
        .onDisappear {
            // 嵌入任务栈时由 TaskHomeRoot.path.count 收口；模态不参与主 Tab 底栏契约。
            guard AutomationTabBarPushReporting.shouldReportToMainRouter(
                providesNavigationContainer: providesNavigationContainer,
                isModal: onClose != nil
            ) else { return }
            MainRouter.shared.setTabPushed(.tasks, pushed: false)
        }
    }

    /// 仅「自带 NavigationStack 的独立自动化根」上报：stack 下详情 / 通知算 push；
    /// split 分栏选中详情不算。嵌入任务页时禁止写入，避免覆盖宿主 path.count。
    private func reportTabPushed() {
        guard AutomationTabBarPushReporting.shouldReportToMainRouter(
            providesNavigationContainer: providesNavigationContainer,
            isModal: onClose != nil
        ) else { return }
        let isStack = AutomationLayoutPolicy.mode(
            isRegularWidth: horizontalSizeClass == .regular
        ) == .stack
        let pushed = rootNavigationRoute != nil
            || (isStack && selection != nil)
        MainRouter.shared.setTabPushed(.tasks, pushed: pushed)
    }

    private var availableWorkspaces: [Space] {
        workspaces.filter { $0.isExecutionSpace && $0.isArchived != true }
    }

    private var workspaceScopeKey: String {
        availableWorkspaces.map(\.id).sorted().joined(separator: "|")
    }

    /// 搜索词或状态筛选生效时算「在找特定的一条」。
    private var isFiltering: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || statusFilter != .all
    }

    private var pendingAutomationScopeKey: String {
        [
            pendingAutomation?.id ?? "none",
            workspaceScopeKey,
            isWorkspaceScopeLoading ? "loading" : "ready",
        ].joined(separator: "|")
    }

    private var compactLayout: some View {
        NavigationStack {
            listContent
                .searchable(
                    text: $searchText,
                    isPresented: $isSearchPresented,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "搜索自动化任务"
                )
                .ttRootNavigationTitle(MainNavTab.automation.title)
                .ttToolbarBackground()
                .toolbar { compactToolbar }
                .navigationDestination(item: $selection) { selection in
                    detailScreen(selection)
                }
                .navigationDestination(item: $rootNavigationRoute) { route in
                    rootDestination(route)
                }
        }
    }

    /// 嵌入宿主导航栈：不自带容器。`navigationDestination` 会挂到最近的祖先
    /// NavigationStack（即任务页那个），详情照常 push、返回手势照常可用。
    private var embeddedLayout: some View {
        listContent
            .searchable(
                text: $searchText,
                isPresented: $isSearchPresented,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "搜索自动化"
            )
            .navigationTitle(MainNavTab.automation.title)
            .navigationBarTitleDisplayMode(.inline)
            .ttToolbarBackground()
            .toolbar { embeddedToolbar }
            .navigationDestination(item: $selection) { selection in
                detailScreen(selection)
            }
            .navigationDestination(item: $rootNavigationRoute) { route in
                rootDestination(route)
            }
    }

    /// 嵌入模式只留「新建」：通知铃与头像是任务页根导航栏的常驻入口，
    /// push 进来后再挂一份是重复语义。
    @ToolbarContentBuilder
    private var embeddedToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                startCreate()
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("新建自动化")
        }
    }

    private var regularLayout: some View {
        NavigationSplitView {
            listContent
                .searchable(
                    text: $searchText,
                    isPresented: $isSearchPresented,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "搜索自动化任务"
                )
                .ttRootNavigationTitle(MainNavTab.automation.title)
                .ttToolbarBackground()
                .toolbar { regularSidebarToolbar }
                .navigationDestination(item: $rootNavigationRoute) { route in
                    rootDestination(route)
                }
                .navigationSplitViewColumnWidth(min: 280, ideal: 340, max: 420)
        } detail: {
            if let selection {
                detailScreen(selection)
            } else {
                ContentUnavailableView(
                    "选择一个自动化任务",
                    systemImage: "clock.arrow.trianglehead.counterclockwise.rotate.90",
                    description: Text("查看运行状态、最近记录和关联会话。")
                )
                .background(.tt.bgCanvasDefault)
            }
        }
    }

    private var listContent: some View {
        VStack(spacing: 0) {
            filterBar
            // 搜索 / 筛状态时不出排期：那时用户在找某一条，近期排期是干扰。
            if !isFiltering {
                TrackerSchedulePreviewSection(
                    occurrences: store.schedulePreview,
                    truncated: store.schedulePreviewTruncated,
                    isLoading: store.isLoadingSchedulePreview
                ) { occurrence in
                    selection = AutomationSelection(trackerId: occurrence.trackerId, runId: nil)
                }
            }
            trackerList
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .ttDismissKeyboardOnContentTap()
        }
        .background(.tt.bgCanvasDefault)
        .refreshable {
            async let trackers: Void = store.loadTrackers(workspaceId: selectedWorkspaceId)
            async let preview: Void = store.loadSchedulePreview(workspaceId: selectedWorkspaceId)
            _ = await (trackers, preview)
        }
    }

    private var filterBar: some View {
        HStack(spacing: TTSpacing.sm) {
            Menu {
                Button {
                    changeWorkspace(nil)
                } label: {
                    if selectedWorkspaceId == nil {
                        Label("全部工作空间", systemImage: "checkmark")
                    } else {
                        Text("全部工作空间")
                    }
                }
                ForEach(availableWorkspaces) { space in
                    Button {
                        changeWorkspace(space.id)
                    } label: {
                        if selectedWorkspaceId == space.id {
                            Label(space.name, systemImage: "checkmark")
                        } else {
                            Text(space.name)
                        }
                    }
                }
            } label: {
                filterPill(title: selectedWorkspaceName, icon: "square.grid.2x2")
            }
            .frame(maxWidth: .infinity)
            .accessibilityLabel("工作空间筛选：\(selectedWorkspaceName)")

            Menu {
                ForEach(TrackerListStatusFilter.allCases) { status in
                    Button {
                        statusFilter = status
                    } label: {
                        if status == statusFilter {
                            Label(status.title, systemImage: "checkmark")
                        } else {
                            Text(status.title)
                        }
                    }
                }
            } label: {
                filterPill(title: statusFilter.title, icon: "line.3.horizontal.decrease.circle")
            }
            .frame(maxWidth: .infinity)
            .accessibilityLabel("状态筛选：\(statusFilter.title)")
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.tt.bgCanvasDefault)
    }

    private func filterPill(title: String, icon: String) -> some View {
        Label(title, systemImage: icon)
            .font(.tt.meta)
            .foregroundStyle(.tt.textSecondary)
            .padding(.horizontal, TTSpacing.sm)
            .frame(maxWidth: .infinity, minHeight: 44)
            .background(.tt.bgSubtle, in: Capsule())
            .lineLimit(1)
    }

    @ViewBuilder
    private var trackerList: some View {
        let trackers = TrackerListProjection.filtered(
            store.trackers,
            searchText: searchText,
            status: statusFilter
        )

        if store.isLoading && store.trackers.isEmpty {
            ProgressView("加载自动化任务…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = store.loadError, store.trackers.isEmpty {
            errorState(error)
        } else if trackers.isEmpty {
            emptyState(hasFilters: !searchText.isEmpty || statusFilter != .all)
        } else {
            List {
                ForEach(trackers) { tracker in
                    let isSelected = selection?.trackerId == tracker.id
                    Button {
                        open(trackerId: tracker.id, runId: nil)
                    } label: {
                        trackerRow(tracker)
                    }
                    .buttonStyle(.plain)
                    .listRowBackground(
                        horizontalSizeClass == .regular && isSelected
                            ? Color.tt.bgAccent.opacity(0.1)
                            : Color.clear
                    )
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityHint("查看详情和运行记录")
                    .onAppear {
                        guard tracker.id == trackers.last?.id else { return }
                        Task { await store.loadMoreTrackers() }
                    }
                }
                if store.isLoadingMore {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .listRowBackground(Color.clear)
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .contentMargins(.top, 0, for: .scrollContent)
            .scrollDismissesKeyboard(.interactively)
        }
    }

    @ViewBuilder
    private func trackerRow(_ tracker: Tracker) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: tracker.triggerType.displayIcon)
                .foregroundStyle(.tt.iconAccent)
                .frame(width: 28, height: 44)
                .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(tracker.name.isEmpty ? "未命名自动化任务" : tracker.name)
                    .font(dynamicTypeSize.isAccessibilitySize ? .tt.meta : .tt.captionMedium)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 1)
                    .fixedSize(horizontal: false, vertical: true)

                Text(subtitle(for: tracker))
                    .font(dynamicTypeSize.isAccessibilitySize ? .tt.caption : .tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)

                if dynamicTypeSize.isAccessibilitySize {
                    TrackerStatusBadge(status: tracker.status)
                        .padding(.top, TTSpacing.xxs)
                }
            }

            Spacer(minLength: TTSpacing.xs)

            if !dynamicTypeSize.isAccessibilitySize {
                TrackerStatusBadge(status: tracker.status)
            }

            Image(systemName: "chevron.right")
                .font(.tt.iconCaptionMedium)
                .foregroundStyle(.tt.textTertiary)
                .frame(width: 20)
                .frame(minHeight: 44)
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .frame(minHeight: 56)
    }

    @ToolbarContentBuilder
    private var compactToolbar: some ToolbarContent {
        if let onClose {
            ToolbarItem(placement: .topBarLeading) {
                Button("关闭", action: onClose)
                    .frame(minWidth: 44, minHeight: 44)
            }
        } else {
            AccountDrawerToolbarLeadingItem()
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                startCreate()
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("新建自动化任务")

            if onClose == nil {
                NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                    rootNavigationRoute = .notifications
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var regularSidebarToolbar: some ToolbarContent {
        if let onClose {
            ToolbarItem(placement: .topBarLeading) {
                Button("关闭", action: onClose)
                    .frame(minWidth: 44, minHeight: 44)
            }
        } else {
            AccountDrawerToolbarLeadingItem()
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button {
                startCreate()
            } label: {
                Image(systemName: "plus")
            }
            .accessibilityLabel("新建自动化任务")

            if onClose == nil {
                NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                    rootNavigationRoute = .notifications
                }
            }
        }
    }

    @ViewBuilder
    private func rootDestination(_ route: AutomationRootNavigationRoute) -> some View {
        switch route {
        case .notifications:
            NotificationCenterScreen(onOpenConversation: { target in
                rootNavigationRoute = nil
                onOpenConversation(target)
            }, onOpenIMConversation: { target in
                rootNavigationRoute = nil
                MainRouter.shared.openIMConversation(target)
            })
            .toolbar(.hidden, for: .tabBar)
        }
    }

    private func detailScreen(_ selection: AutomationSelection) -> some View {
        TrackerDetailScreen(
            store: store,
            trackerId: selection.trackerId,
            initialRunId: selection.runId,
            onOpenConversation: onOpenConversation,
            onRequestEdit: { tracker in
                authoringRequest = .edit(
                    tracker,
                    workspaceId: trackerWorkspaceId(tracker)
                )
            },
            showsCloseButton: false,
            onClose: onClose ?? {},
            onDeleted: {
                self.selection = nil
            }
        )
        // 与 MainTabView 栈深度契约叠加：详情 push 时双保险藏底栏。
        .ttTabBarHidden(true)
    }

    private func subtitle(for tracker: Tracker) -> String {
        var parts: [String] = []
        if let spaceName = tracker.spaceName, !spaceName.isEmpty {
            parts.append(spaceName)
        }
        parts.append(tracker.triggerType.displayLabel)
        if let next = TrackerDateFormatting.display(tracker.nextRunAt) {
            parts.append("下次 \(next)")
        } else if let last = TrackerDateFormatting.display(tracker.lastRunAt) {
            parts.append("上次 \(last)")
        }
        return parts.joined(separator: " · ")
    }

    private var selectedWorkspaceName: String {
        guard let selectedWorkspaceId,
              let space = availableWorkspaces.first(where: { $0.id == selectedWorkspaceId }) else {
            return "全部工作空间"
        }
        return space.name
    }

    private func startCreate() {
        creationDraft = MobileAutomationDraft()
    }

    private func changeWorkspace(_ workspaceId: String?) {
        guard workspaceId != selectedWorkspaceId else { return }
        selectedWorkspaceId = workspaceId
        selection = nil
        // 排期也是按 Workspace 收窄的，跟着一起换，别留着上一个现场的排期。
        Task {
            async let trackers: Void = store.loadTrackers(workspaceId: workspaceId)
            async let preview: Void = store.loadSchedulePreview(workspaceId: workspaceId)
            _ = await (trackers, preview)
        }
    }

    private func open(trackerId: String, runId: String?) {
        selection = AutomationSelection(trackerId: trackerId, runId: runId)
    }

    private func consumePendingAutomationIfPossible(
        _ target: AutomationDeepLinkTarget?
    ) async {
        guard let target, target.organizationId == organizationId else { return }
        // Organization 切换时 Workspace 会先清空再异步回填；必须等范围初始化完成，
        // 否则深链会在“全部工作空间”中提前消费，返回列表后也会落到错误范围。
        guard !isWorkspaceScopeLoading else { return }
        let targetWorkspaceId = target.spaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        if !targetWorkspaceId.isEmpty {
            guard availableWorkspaces.contains(where: { $0.id == targetWorkspaceId }) else {
                onUnavailableAutomation?(target)
                return
            }
            if selectedWorkspaceId != targetWorkspaceId {
                selectedWorkspaceId = targetWorkspaceId
                selection = nil
            }
            await store.loadTrackers(workspaceId: targetWorkspaceId)
        }
        guard !Task.isCancelled, pendingAutomation == target else { return }
        open(trackerId: target.trackerId, runId: target.runId)
        onConsumeAutomation?(target)
    }

    private func validateWorkspaceSelection() {
        guard let selectedWorkspaceId else { return }
        let validIds = Set(availableWorkspaces.map(\.id))
        guard !validIds.contains(selectedWorkspaceId) else { return }
        self.selectedWorkspaceId = nil
    }

    private func trackerWorkspaceId(_ tracker: Tracker) -> String? {
        [tracker.workspaceId, tracker.spaceId]
            .compactMap { value in
                let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                return normalized.isEmpty ? nil : normalized
            }
            .first
    }

    private func emptyState(hasFilters: Bool) -> some View {
        ContentUnavailableView {
            Label(
                hasFilters ? "没有匹配的自动化任务" : "还没有自动化任务",
                systemImage: "clock.badge.checkmark"
            )
        } description: {
            Text(hasFilters ? "试试更换工作空间、状态或搜索词。" : "可以交给 Agent 创建，或使用桌面端完成高级配置。")
        } actions: {
            Button("新建自动化任务") {
                startCreate()
            }
            .buttonStyle(.borderedProminent)
            .tint(.tt.bgAccent)
            .frame(minHeight: 44)
        }
    }

    private func errorState(_ message: String) -> some View {
        ContentUnavailableView {
            Label("无法加载自动化任务", systemImage: "exclamationmark.triangle")
        } description: {
            Text(message)
        } actions: {
            Button("重试") {
                Task { await store.loadTrackers(workspaceId: selectedWorkspaceId) }
            }
            .buttonStyle(.borderedProminent)
            .tint(.tt.bgAccent)
            .frame(minHeight: 44)
        }
    }
}

enum AutomationAuthoringRequest: Identifiable {
    case create(workspaceId: String?, workspaceName: String)
    case edit(Tracker, workspaceId: String?)

    var id: String {
        switch self {
        case let .create(workspaceId, _):
            return "create-\(workspaceId ?? "unscoped")"
        case let .edit(tracker, workspaceId):
            return "edit-\(tracker.id)-\(workspaceId ?? "unscoped")"
        }
    }

    var workspaceId: String? {
        switch self {
        case let .create(workspaceId, _), let .edit(_, workspaceId):
            return workspaceId
        }
    }

    var title: String {
        switch self {
        case .create: return "新建自动化任务"
        case .edit: return "编辑自动化"
        }
    }

    var message: String {
        switch self {
        case let .create(workspaceId, workspaceName):
            let scopeNotice = workspaceId == nil
                ? "\n\n交给 Agent 前，请先在列表的工作空间筛选中明确选择一个 Workspace。"
                : "\n\n当前范围：\(workspaceName)"
            return "移动端完整配置器仍在建设中。你可以把目标交给 Agent，或在桌面端配置触发条件、Skill 和执行 Agent。\(scopeNotice)"
        case let .edit(tracker, workspaceId):
            let scopeNotice = workspaceId == nil
                ? "\n\n当前无法确认这项自动化所属的 Workspace，因此暂不能交给 Agent。"
                : ""
            return "移动端完整编辑器仍在建设中。你可以让 Agent 调整“\(tracker.name)”，或在桌面端编辑高级配置。\(scopeNotice)"
        }
    }

    var agentPrompt: String {
        switch self {
        case let .create(_, workspaceName):
            return "请帮我在\(workspaceName)创建一个自动化任务。先问清楚目标、触发条件和执行内容，再让我确认。"
        case let .edit(tracker, _):
            return "请帮我调整自动化“\(tracker.name)”。先读取它的当前配置，说明准备修改的内容，再让我确认。"
        }
    }
}

/// 自动化新建 / 编辑表单。列表页与手机端日程页共用，故非 private。
struct AutomationAuthoringSheet: View {
    let request: AutomationAuthoringRequest
    let canHandOffToAgent: Bool
    let onHandOff: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: TTSpacing.lg) {
                    Image(systemName: "wand.and.stars")
                        .font(.tt.iconEmptyMD)
                        .foregroundStyle(.tt.iconAccent)
                    Text(request.message)
                        .font(.tt.body)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Spacer(minLength: TTSpacing.xl)

                    if canHandOffToAgent {
                        Button {
                            onHandOff()
                        } label: {
                            Label("交给 Agent", systemImage: "bubble.left.and.sparkles")
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(.tt.bgAccent)
                    }
                    Button("稍后再说") { dismiss() }
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(TTSpacing.lg)
            }
            .background(.tt.bgCanvasDefault)
            .navigationTitle(request.title)
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// 自动化工作面：以 Organization 为边界承载列表、详情和运行回链。
///
/// 从任务 Tab 右上角 push 进入；`AutomationRoot` 仍可作为旧调用点的模态工作面。
/// 这里不显示“关闭”，并在组织
/// 切换时用 `.id(organizationId)` 重建 Store，防止跨租户保留自动化状态。
struct AutomationTabRoot: View {
    @State private var workspace = WorkspaceStore.shared
    @State private var router = MainRouter.shared
    @State private var preparedAutomationTarget: AutomationDeepLinkTarget?
    @State private var pendingAutomationScopeError: String?

    private var executionWorkspaces: [Space] {
        workspace.spaces.filter { $0.isExecutionSpace && $0.isArchived != true }
    }

    var body: some View {
        Group {
            if let target = router.pendingAutomation,
               preparedAutomationTarget?.id != target.id {
                pendingAutomationPreparation(target)
            } else if let organizationId = TaskHomeAutomationEntryPolicy.organizationId(
                from: workspace.selectedOrganizationId
            ) {
                AutomationRoot(
                    organizationId: organizationId,
                    workspaces: executionWorkspaces,
                    initialWorkspaceId: nil,
                    onOpenConversation: { router.openConversation($0) },
                    onRequestAgent: startTask,
                    pendingAutomation: preparedAutomationTarget,
                    onConsumeAutomation: consumePreparedAutomation,
                    onUnavailableAutomation: automationTargetUnavailable,
                    isWorkspaceScopeLoading: workspace.isLoadingSpaces,
                    // 任务页是 push 进来的，宿主已有 NavigationStack。
                    providesNavigationContainer: false
                )
                .id(organizationId)
            } else {
                ContentUnavailableView {
                    Label("需要先选择组织", systemImage: "building.2")
                } description: {
                    Text(workspace.errorMessage ?? "自动化按组织隔离。选择组织后即可查看自动化与运行记录。")
                } actions: {
                    Button {
                        Task { await loadScope() }
                    } label: {
                        if workspace.isLoadingOrganizations {
                            ProgressView()
                                .frame(minWidth: 96, minHeight: 44)
                        } else {
                            Text("重新加载")
                                .frame(minHeight: 44)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.tt.bgAccent)
                    .disabled(workspace.isLoadingOrganizations)
                }
                .background(.tt.bgCanvasDefault)
            }
        }
        .task(id: workspace.selectedOrganizationId) {
            await loadScope()
        }
        .task(id: router.pendingAutomation?.id) {
            await preparePendingAutomationIfNeeded()
        }
    }

    private func loadScope() async {
        if workspace.organizations.isEmpty {
            await workspace.loadOrganizations()
        }
        if workspace.selectedOrganizationId != nil, workspace.spaces.isEmpty {
            await workspace.loadSpaces()
        }
    }

    private func preparePendingAutomationIfNeeded() async {
        guard let target = router.pendingAutomation else { return }
        preparedAutomationTarget = nil
        pendingAutomationScopeError = nil

        let needsOrganizationRefresh = workspace.organizations.isEmpty
            || !workspace.organizations.contains(where: { $0.id == target.organizationId })
        if needsOrganizationRefresh {
            await workspace.loadOrganizations()
        }
        guard !Task.isCancelled, router.pendingAutomation == target else { return }
        if needsOrganizationRefresh, let organizationError = workspace.errorMessage {
            pendingAutomationScopeError = organizationError
            return
        }
        guard workspace.hasLoadedOrganizations else {
            pendingAutomationScopeError = "尚未取得组织列表，请重试。"
            return
        }

        var loadedScopeDuringPreparation = false
        if workspace.selectedOrganizationId != target.organizationId {
            guard let organization = workspace.organizations.first(where: {
                $0.id == target.organizationId
            }) else {
                automationOrganizationUnavailable(target)
                return
            }
            await workspace.selectOrganization(organization)
            loadedScopeDuringPreparation = true
        } else if !workspace.hasLoadedSpacesForSelectedOrganization {
            await workspace.loadSpaces()
            loadedScopeDuringPreparation = true
        }

        guard !Task.isCancelled,
              router.pendingAutomation == target,
              workspace.selectedOrganizationId == target.organizationId else { return }

        let targetWorkspaceId = target.spaceId.trimmingCharacters(in: .whitespacesAndNewlines)
        let targetExists = executionWorkspaces.contains { $0.id == targetWorkspaceId }
        // 已有缓存但目标不在其中时，主动做一次权威刷新；新建 Workspace 的通知
        // 可能早于当前设备的旧缓存，不能直接按“不存在”处理。
        if !targetExists, !loadedScopeDuringPreparation {
            await workspace.loadSpaces()
        }

        guard !Task.isCancelled, router.pendingAutomation == target else { return }
        let resolution = AutomationTargetScopePolicy.resolve(
            target: target,
            organizationIds: Set(workspace.organizations.map(\.id)),
            selectedOrganizationId: workspace.selectedOrganizationId,
            workspaceIds: Set(executionWorkspaces.map(\.id)),
            isLoadingSpaces: workspace.isLoadingSpaces,
            hasLoadedSpaces: workspace.hasLoadedSpacesForSelectedOrganization,
            spacesLoadError: workspace.spacesLoadError
        )
        switch resolution {
        case .ready:
            preparedAutomationTarget = target
        case .retry(let message):
            pendingAutomationScopeError = message
        case .waiting:
            pendingAutomationScopeError = "尚未取得目标 Workspace，请重试。"
        case .organizationUnavailable:
            automationOrganizationUnavailable(target)
        case .workspaceUnavailable:
            automationTargetUnavailable(target)
        }
    }

    private func automationTargetUnavailable(_ target: AutomationDeepLinkTarget) {
        preparedAutomationTarget = nil
        pendingAutomationScopeError = nil
        router.consumeAutomation(target)
        router.presentNavigationNotice("目标自动化所属的 Workspace 已不可用。")
    }

    private func automationOrganizationUnavailable(_ target: AutomationDeepLinkTarget) {
        preparedAutomationTarget = nil
        pendingAutomationScopeError = nil
        router.consumeAutomation(target)
        router.presentNavigationNotice("目标自动化所属的组织已不可用。")
    }

    private func consumePreparedAutomation(_ target: AutomationDeepLinkTarget) {
        preparedAutomationTarget = nil
        pendingAutomationScopeError = nil
        router.consumeAutomation(target)
    }

    @ViewBuilder
    private func pendingAutomationPreparation(
        _ target: AutomationDeepLinkTarget
    ) -> some View {
        if let scopeError = pendingAutomationScopeError {
            ContentUnavailableView {
                Label("无法打开自动化", systemImage: "exclamationmark.triangle")
            } description: {
                Text(scopeError)
            } actions: {
                Button("重试") {
                    Task { await preparePendingAutomationIfNeeded() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)
                .frame(minHeight: 44)

                Button("留在自动化列表") {
                    router.consumeAutomation(target)
                    pendingAutomationScopeError = nil
                }
                .frame(minHeight: 44)
            }
            .background(.tt.bgCanvasDefault)
        } else {
            ProgressView("正在打开自动化…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.tt.bgCanvasDefault)
        }
    }

    private func startTask(request: AutomationAuthoringRequest) {
        guard let workspaceId = request.workspaceId else {
            router.presentNavigationNotice("请先在自动化列表中明确选择一个 Workspace，再交给 Agent。")
            return
        }
        guard let executionWorkspace = executionWorkspaces.first(where: { $0.id == workspaceId }) else {
            router.presentNavigationNotice("这项自动化所属的 Workspace 已不可用，请刷新列表或重新选择。")
            return
        }
        UserDefaults.standard.set(executionWorkspace.id, forKey: ComposeSheet.lastWorkspaceKey)
        router.openConversation(ConversationTarget(
            title: executionWorkspace.name,
            workspaceId: executionWorkspace.id,
            organizationId: executionWorkspace.organizationId,
            startsNewSession: true,
            initialMessage: request.agentPrompt
        ))
    }
}

/// 兼容旧调用点；入口与通知都复用同一套自动化工作面。
struct TrackerListSheet: View {
    let organizationId: String
    let spaceId: String
    let initialTrackerId: String?
    let initialRunId: String?
    let onClose: () -> Void
    @State private var workspace = WorkspaceStore.shared

    init(
        organizationId: String,
        spaceId: String,
        initialTrackerId: String? = nil,
        initialRunId: String? = nil,
        onClose: @escaping () -> Void
    ) {
        self.organizationId = organizationId
        self.spaceId = spaceId
        self.initialTrackerId = initialTrackerId
        self.initialRunId = initialRunId
        self.onClose = onClose
    }

    var body: some View {
        AutomationRoot(
            organizationId: organizationId,
            workspaces: workspace.spaces,
            initialWorkspaceId: spaceId,
            initialTrackerId: initialTrackerId,
            initialRunId: initialRunId,
            onClose: onClose,
            onOpenConversation: { target in
                onClose()
                MainRouter.shared.openConversation(target)
            }
        )
    }
}

// MARK: - Shared presentation

struct TrackerStatusBadge: View {
    let status: TrackerStatus

    var body: some View {
        Text(status.displayLabel)
            .font(.tt.captionMedium)
            .foregroundStyle(color)
            .padding(.horizontal, TTSpacing.xs)
            .padding(.vertical, 3)
            .background(color.opacity(0.12), in: Capsule())
    }

    private var color: Color {
        switch status {
        case .active: return .tt.textSuccess
        case .paused: return .tt.textWarning
        case .disabled, .archived: return .tt.textCritical
        case .draft, .unknown: return .tt.textTertiary
        }
    }
}

enum TrackerDateFormatting {
    private nonisolated(unsafe) static let isoWithFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return isoWithFraction.date(from: raw) ?? iso.date(from: raw)
    }

    static func display(_ raw: String?) -> String? {
        guard let date = parse(raw) else { return nil }
        let calendar = Calendar.current
        let format: Date.FormatStyle = calendar.isDate(date, equalTo: Date(), toGranularity: .year)
            ? .dateTime.month().day().hour().minute()
            : .dateTime.year().month().day().hour().minute()
        return date.formatted(format)
    }
}
