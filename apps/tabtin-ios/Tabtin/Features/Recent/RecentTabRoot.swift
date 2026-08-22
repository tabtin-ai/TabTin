import SwiftUI

/// 「最近」tab 根（消费视角）：跨 Agent 的近期会话聚合列表，每条带 agent/space 信息。
/// 数据源 RecentSessionsStore（`/chat/sessions/all`）。点选带具体 sessionId 进会话。
///
/// 采用 NavigationStack push（对齐 dev/ios）：点会话后进入系统导航栈里的聊天页，
/// 返回手势 / 顶栏返回均由系统处理。切团队时清缓存并清空导航路径。
struct RecentTabRoot: View {
    @State private var store = RecentSessionsStore.shared
    @State private var imStore = IMConversationStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var path = NavigationPath()
    @State private var selectedSection: RecentSection = .conversations
    @State private var archiveTarget: RecentSession?

    var body: some View {
        NavigationStack(path: $path) {
            content
                .ttRootNavigationTitle(L10n.Recent.title)
                .background(.tt.bgCanvasDefault)
                .ttToolbarBackground()
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                            path.append(NotificationCenterRoute.center)
                        }
                    }
                }
                .navigationDestination(for: ConversationTarget.self) { target in
                    ConversationScreen(target: target, onBack: {
                        path.removeLast()
                    }, onOpenConversation: { forkedTarget in
                        path.append(forkedTarget)
                    })
                }
                .navigationDestination(for: IMConversationTarget.self) { target in
                    IMConversationScreen(
                        conversationId: target.conversationId,
                        title: target.title,
                        onOpenConversation: { path.append($0) },
                        onOpenChatSession: { path.append($0) }
                    )
                }
                .navigationDestination(for: NotificationCenterRoute.self) { _ in
                    NotificationCenterScreen(onOpenConversation: { target in
                        path = NavigationPath()
                        path.append(target)
                    }, onOpenIMConversation: { target in
                        selectedSection = .messages
                        path = NavigationPath()
                        path.append(target)
                    })
                }
        }
        .task(id: workspace.selectedOrganizationId) {
            store.clearForOrganizationSwitch()
            imStore.clear()
            if let orgId = workspace.selectedOrganizationId {
                imStore.loadConversations(organizationId: orgId)
                CentrifugoClient.shared.connect()  // 幂等：登录后建立实时通道（personal + 会话）
            }
            async let recentReload: Void = store.reload()
            async let notificationReload: Void = notificationStore.activate(
                organizationId: workspace.selectedOrganizationId
            )
            _ = await (recentReload, notificationReload)
        }
        .onChange(of: workspace.selectedOrganizationId) { _, _ in
            path = NavigationPath()
        }
        .alert(L10n.Agent.archiveSession, isPresented: Binding(
            get: { archiveTarget != nil },
            set: { if !$0 { archiveTarget = nil } }
        )) {
            Button(L10n.Agent.archiveSession, role: .destructive) {
                guard let session = archiveTarget else { return }
                archiveTarget = nil
                Task { await store.archive(session: session) }
            }
            Button(L10n.Common.cancel, role: .cancel) { archiveTarget = nil }
        } message: {
            Text(L10n.Agent.archiveSessionConfirm(archiveTarget?.displayTitle))
        }
        .alert(L10n.Agent.operationFailed, isPresented: Binding(
            get: { store.mutationError != nil },
            set: { if !$0 { store.clearMutationError() } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { store.clearMutationError() }
        } message: {
            Text(store.mutationError ?? "")
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            Picker(L10n.Recent.title, selection: $selectedSection) {
                ForEach(RecentSection.allCases) { section in
                    Text(section.title)
                        .accessibilityLabel(section.accessibilityLabel(unreadCount: imStore.aggregateUnreadCount))
                        .tag(section)
                }
            }
            .pickerStyle(.segmented)
            .overlay {
                // UISegmentedControl 不支持带样式的复合 label，因此角标仍用浮层；
                // 但浮层按全部分段等宽切槽，角标由「消息」槽位自身承载，避免新增分段后漂到最右侧。
                HStack(spacing: 0) {
                    ForEach(RecentSection.allCases) { section in
                        Color.clear
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .overlay(alignment: .trailing) {
                                if let badgeText = section.unreadBadgeText(
                                    unreadCount: imStore.aggregateUnreadCount
                                ) {
                                    Text(badgeText)
                                        .font(.tt.captionMedium)
                                        .foregroundStyle(.tt.textOnAccent)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 1)
                                        .background(Capsule().fill(Color.red))
                                        .padding(.trailing, 10)
                                }
                            }
                    }
                }
                .allowsHitTesting(false)
                .accessibilityHidden(true)
            }
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)

            sectionList
        }
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }

    @ViewBuilder
    private var sectionList: some View {
        switch selectedSection {
        case .conversations:
            inboxList(
                isLoading: store.isLoading,
                loadError: store.loadError,
                entries: agentEntries,
                emptyTitle: L10n.Recent.emptyTitle,
                emptyDescription: L10n.Recent.emptyDescription,
                emptySystemImage: "bubble.left.and.bubble.right",
                onRefresh: reloadAgent
            )
        case .messages:
            inboxList(
                isLoading: imStore.isLoading,
                loadError: imStore.loadError,
                entries: imEntries,
                emptyTitle: L10n.Recent.messagesEmptyTitle,
                emptyDescription: L10n.Recent.messagesEmptyDescription,
                emptySystemImage: "message",
                onRefresh: reloadIM
            )
        case .contacts:
            ContactsSectionView { path.append($0) }
        }
    }

    /// 两段共用的列表骨架：加载/工作区错误/加载错误/空态/内容。
    /// 空态与错误只在该段自身无数据时占位，避免另一段的状态串台。
    @ViewBuilder
    private func inboxList(
        isLoading: Bool,
        loadError: String?,
        entries: [InboxEntry],
        emptyTitle: String,
        emptyDescription: String,
        emptySystemImage: String,
        onRefresh: @escaping () async -> Void
    ) -> some View {
        List {
            if (isLoading || workspace.isLoadingOrganizations), entries.isEmpty {
                placeholderRow {
                    ProgressView(L10n.Recent.loading)
                        .frame(maxWidth: .infinity, minHeight: 360)
                }
            } else if let workspaceError = workspace.errorMessage,
                      workspace.selectedOrganizationId == nil,
                      entries.isEmpty {
                placeholderRow {
                    errorState(workspaceError)
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else if let err = loadError, entries.isEmpty {
                placeholderRow {
                    errorState(err)
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else if entries.isEmpty {
                placeholderRow {
                    emptyState(title: emptyTitle, description: emptyDescription, systemImage: emptySystemImage)
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else {
                ForEach(entries) { entry in
                    row(for: entry)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .refreshable { await onRefresh() }
    }

    /// Agent 会话，按最近活动时间倒序。
    private var agentEntries: [InboxEntry] {
        store.sessions.map { InboxEntry.agent($0) }.sorted { $0.sortValue > $1.sortValue }
    }

    /// TabChat IM 会话，按最近活动时间倒序。
    private var imEntries: [InboxEntry] {
        imStore.conversations.map { InboxEntry.im($0) }.sorted { $0.sortValue > $1.sortValue }
    }

    @ViewBuilder
    private func row(for entry: InboxEntry) -> some View {
        switch entry {
        case .agent(let session):
            if let target = target(for: session) {
                NavigationLink(value: target) {
                    RecentSessionRow(session: session, source: sourceKind(for: session))
                }
                .buttonStyle(.plain)
                .contextMenu {
                    archiveMenu(for: session)
                }
                .listRowBackground(Color.clear)
            } else {
                RecentSessionRow(session: session, source: sourceKind(for: session))
                    .opacity(0.5)
                    .contextMenu {
                        archiveMenu(for: session)
                    }
                    .listRowBackground(Color.clear)
            }
        case .im(let conversation):
            NavigationLink(value: IMConversationTarget(conversationId: conversation.id, title: conversation.name)) {
                IMInboxRow(conversation: conversation)
            }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
        }
    }

    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private func target(for session: RecentSession) -> ConversationTarget? {
        RecentConversationTargetResolver.resolve(
            session,
            fallbackOrganizationId: workspace.selectedOrganizationId
        )
    }

    private func sourceKind(for session: RecentSession) -> RecentSourceKind {
        session.projectId == nil ? .space : .project
    }

    @ViewBuilder
    private func archiveMenu(for session: RecentSession) -> some View {
        Button(role: .destructive) {
            archiveTarget = session
        } label: {
            Label(L10n.Agent.archiveSession, systemImage: "archivebox")
        }
        .disabled(store.mutatingSessionIds.contains(session.id))
    }

    private func emptyState(title: String, description: String, systemImage: String) -> some View {
        ContentUnavailableView {
            Label(title, systemImage: systemImage)
        } description: {
            Text(description)
        }
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message) { Task { await reloadCurrentSection() } }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, TTSpacing.xl)
    }

    /// 错误态「重试」按当前段刷新对应数据源。
    private func reloadCurrentSection() async {
        switch selectedSection {
        case .conversations: await reloadAgent()
        case .messages: await reloadIM()
        case .contacts:
            if let orgId = workspace.selectedOrganizationId {
                await workspace.loadMembers(organizationId: orgId)
            } else {
                await workspace.loadOrganizations()
            }
        }
    }

    /// 「会话」段下拉刷新：拉 Agent 会话。
    private func reloadAgent() async {
        guard workspace.selectedOrganizationId != nil else {
            // Organization 恢复成功会触发上方 `.task(id:)` 重新拉取；这里先恢复工作区，
            // 避免在没有 organization_id 时继续发一个必然 no-op 的请求。
            await workspace.loadOrganizations()
            return
        }
        await store.reload()
    }

    /// 「消息」段下拉刷新：拉 TabChat IM 会话。
    private func reloadIM() async {
        guard let orgId = workspace.selectedOrganizationId else {
            await workspace.loadOrganizations()
            return
        }
        await imStore.reload(organizationId: orgId)
    }
}

/// 「最近」tab 三段：对话 / 消息 / 通讯录。
enum RecentSection: String, CaseIterable, Identifiable {
    case conversations
    case messages
    case contacts

    var id: String { rawValue }
    var title: String {
        switch self {
        case .conversations: return L10n.Recent.segmentConversations
        case .messages: return L10n.Recent.segmentMessages
        case .contacts: return L10n.Recent.segmentContacts
        }
    }

    func accessibilityLabel(unreadCount: Int) -> String {
        guard self == .messages, unreadCount > 0 else { return title }
        return "\(title)，\(unreadCount) 条未读"
    }

    /// 聚合未读只属于「消息」分段；视觉最多显示 99+，无未读时不占布局。
    func unreadBadgeText(unreadCount: Int) -> String? {
        guard self == .messages, unreadCount > 0 else { return nil }
        return unreadCount > 99 ? "99+" : "\(unreadCount)"
    }
}

/// 收件箱条目：Agent 会话与 TabChat IM 会话混排，按最近活动时间排序。
private enum InboxEntry: Identifiable {
    case agent(RecentSession)
    case im(IMConversation)

    var id: String {
        switch self {
        case .agent(let session): return "agent:\(session.id)"
        case .im(let conversation): return "im:\(conversation.id)"
        }
    }

    /// 排序键：最近活动时间的 ISO8601 串（同格式下字典序≈时间序），缺失排最后。
    var sortValue: String {
        switch self {
        case .agent(let session): return session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? ""
        case .im(let conversation): return conversation.lastMessageAt ?? conversation.createdAt
        }
    }
}

private enum RecentSourceKind {
    case space
    case project

    var title: String {
        self == .project ? L10n.Project.sourceProject : L10n.Project.sourceSpace
    }
}

private struct RecentSessionRow: View {
    let session: RecentSession
    let source: RecentSourceKind

    private var hasPendingInteraction: Bool {
        PendingInteractionStore.shared.hasPendingForSession(session.id)
    }

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            avatar

            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(session.displayTitle)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)

                    if session.hasActiveTask {
                        Circle().fill(.tt.bgAccent).frame(width: 6, height: 6)
                    } else if session.hasUnreadReply {
                        // 未读回复指示：Agent 回完但用户还没看（与 Android AllConversationsScreen 同口径）
                        Circle().fill(.tt.textCritical).frame(width: 6, height: 6)
                    }

                    if hasPendingInteraction {
                        PendingInteractionPill()
                    }

                    Spacer(minLength: 0)

                    if let time = session.displayTime {
                        Text(time)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }

                if let sourceName = sourceName, !sourceName.isEmpty {
                    HStack(spacing: TTSpacing.xs) {
                        Text("[\(source.title)]")
                            .font(.tt.captionMedium)
                            .foregroundStyle(source == .project ? .tt.iconAccent : .tt.textSecondary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(
                                source == .project
                                    ? Color.tt.bgAccent.opacity(0.10)
                                    : Color.tt.bgSubtleSecondary,
                                in: Capsule()
                            )
                        Text(sourceName)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textSecondary)
                            .lineLimit(1)
                    }
                }

                if let preview = session.lastMessagePreview, !preview.isEmpty {
                    Text(preview)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, TTSpacing.sm)
        .contentShape(Rectangle())
    }

    private var avatar: some View {
        IdentityColorAvatar(
            name: session.agentName ?? sourceName ?? "?",
            // 会话列表暂无稳定 agent_id；用名称种子保证同 Agent 同色，缺省回落 session.id。
            seed: session.agentName ?? session.id,
            imageUrl: session.agentAvatar,
            size: 40
        )
    }

    private var sourceName: String? {
        source == .project ? (session.projectName ?? session.spaceName) : session.spaceName
    }
}

/// 任务域的组织级归档列表。查看不会改变会话状态；恢复和永久删除由用户显式触发。
struct ArchivedConversationsScreen: View {
    let onOpenConversation: (ConversationTarget) -> Void

    @State private var store = RecentSessionsStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var restoreTarget: RecentSession?
    @State private var deleteTarget: RecentSession?
    @State private var searchText = ""
    @State private var selectedWorkspaceId: String?

    private var executionWorkspaces: [Space] {
        workspace.spaces.filter { $0.isExecutionSpace && $0.isArchived != true }
    }

    private var queryKey: String {
        [workspace.selectedOrganizationId, selectedWorkspaceId, searchText]
            .compactMap { $0 }
            .joined(separator: "|")
    }

    var body: some View {
        Group {
            if store.isLoading && store.sessions.isEmpty {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.loadError, store.sessions.isEmpty {
                TTErrorStateView(message: error) { Task { await reload() } }
                    .padding(.horizontal, TTSpacing.xl)
            } else if store.sessions.isEmpty {
                ContentUnavailableView("暂无归档对话", systemImage: "archivebox")
            } else {
                List {
                    ForEach(store.sessions) { session in
                        archivedRow(session)
                            .listRowBackground(Color.clear)
                            .swipeActions(edge: .leading, allowsFullSwipe: false) {
                                Button {
                                    restoreTarget = session
                                } label: {
                                    Label("恢复", systemImage: "arrow.uturn.backward")
                                }
                                .tint(.tt.bgAccent)
                            }
                            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                                Button(role: .destructive) {
                                    deleteTarget = session
                                } label: {
                                    Label("永久删除", systemImage: "trash")
                                }
                            }
                            .contextMenu {
                                Button {
                                    restoreTarget = session
                                } label: {
                                    Label("恢复到任务列表", systemImage: "arrow.uturn.backward")
                                }
                                Button(role: .destructive) {
                                    deleteTarget = session
                                } label: {
                                    Label("永久删除", systemImage: "trash")
                                }
                            }
                    }

                    if store.isLoadingMore {
                        HStack {
                            Spacer()
                            ProgressView()
                            Spacer()
                        }
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                    } else if store.hasMore {
                        Button("加载更多") { Task { await store.loadMore() } }
                            .frame(maxWidth: .infinity)
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                    }
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable { await reload() }
            }
        }
        .background(.tt.bgCanvasDefault)
        .navigationTitle("已归档")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .searchable(text: $searchText, prompt: "搜索已归档对话")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        selectedWorkspaceId = nil
                    } label: {
                        Label("全部 Workspace", systemImage: selectedWorkspaceId == nil ? "checkmark" : "")
                    }
                    ForEach(executionWorkspaces) { space in
                        Button {
                            selectedWorkspaceId = space.id
                        } label: {
                            Label(space.name, systemImage: selectedWorkspaceId == space.id ? "checkmark" : "")
                        }
                    }
                } label: {
                    Image(systemName: selectedWorkspaceId == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel("筛选 Workspace")
            }
        }
        .task(id: queryKey) {
            if !searchText.isEmpty {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled else { return }
            }
            await reload()
        }
        .alert("恢复这个对话？", isPresented: Binding(
            get: { restoreTarget != nil },
            set: { if !$0 { restoreTarget = nil } }
        )) {
            Button("恢复") {
                guard let session = restoreTarget else { return }
                restoreTarget = nil
                Task { await store.restore(session: session) }
            }
            Button("取消", role: .cancel) { restoreTarget = nil }
        }
        .alert("永久删除这个对话？", isPresented: Binding(
            get: { deleteTarget != nil },
            set: { if !$0 { deleteTarget = nil } }
        )) {
            Button("永久删除", role: .destructive) {
                guard let session = deleteTarget else { return }
                deleteTarget = nil
                Task { _ = await store.delete(session: session) }
            }
            Button("取消", role: .cancel) { deleteTarget = nil }
        } message: {
            Text("此操作不可恢复。")
        }
        .alert("操作未完成", isPresented: Binding(
            get: { store.mutationError != nil },
            set: { if !$0 { store.clearMutationError() } }
        )) {
            Button("知道了", role: .cancel) { store.clearMutationError() }
        } message: {
            Text(store.mutationError ?? "")
        }
    }

    private func archivedRow(_ session: RecentSession) -> some View {
        Button {
            guard let target = RecentConversationTargetResolver.resolve(
                session,
                fallbackOrganizationId: workspace.selectedOrganizationId
            ) else { return }
            onOpenConversation(target)
        } label: {
            HStack(spacing: TTSpacing.md) {
                Image(systemName: "archivebox")
                    .font(.tt.body)
                    .foregroundStyle(.tt.textSecondary)
                    .frame(width: 40, height: 40)
                    .background(.tt.bgSubtleSecondary, in: RoundedRectangle(cornerRadius: TTRadius.md))

                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(session.displayTitle)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)

                    HStack(spacing: TTSpacing.xs) {
                        if let workspaceName = session.spaceName, !workspaceName.isEmpty {
                            Text(workspaceName)
                                .lineLimit(1)
                        }
                        if let time = session.displayTime {
                            Text(time)
                        }
                    }
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                }

                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
            .padding(.vertical, TTSpacing.sm)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(store.mutatingSessionIds.contains(session.id))
    }

    private func reload() async {
        guard workspace.selectedOrganizationId != nil else {
            await workspace.loadOrganizations()
            return
        }
        let normalizedKeyword = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        await store.reload(
            keyword: normalizedKeyword.isEmpty ? nil : normalizedKeyword,
            status: "archived",
            workspaceId: selectedWorkspaceId
        )
    }
}
