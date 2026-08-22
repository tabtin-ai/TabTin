import SwiftUI

private enum MessagesNavigationRoute: Hashable {
    case imConversation(IMConversationTarget)
    case taskConversation(ConversationTarget)
    case contacts
    case notifications
    case account(AccountGlobalPushDestination)
}

enum IMConversationSearchFeedback: Equatable {
    case none
    case loading
    case failure(String)

    static func resolve(query: String, isSearching: Bool, error: String?) -> Self {
        guard !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return .none
        }
        if isSearching { return .loading }
        if let error, !error.isEmpty { return .failure(error) }
        return .none
    }
}

/// 合并会话标题/摘要命中与服务端消息全文检索结果，保持会话首次出现的排序。
///
/// 这是消息目录的展示策略，不属于任何具体 IM 传输实现；放在页面真源旁，避免
/// Django Adapter 或未来传输实现的替换不影响搜索结果拼装。
func mergeIMConversationSearchRows(
    conversations: [IMConversation],
    messageResults: [IMMessageSearchResult],
    query: String,
    title: (IMConversation) -> String
) -> [(conversation: IMConversation, preview: String)] {
    let normalizedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedQuery.isEmpty else {
        return conversations.map { ($0, $0.lastMessagePreview) }
    }
    var rowsById: [String: (IMConversation, String)] = [:]
    var orderedIds: [String] = []
    for conversation in conversations where
        title(conversation).localizedCaseInsensitiveContains(normalizedQuery)
            || conversation.lastMessagePreview.localizedCaseInsensitiveContains(normalizedQuery) {
        rowsById[conversation.id] = (conversation, conversation.lastMessagePreview)
        orderedIds.append(conversation.id)
    }
    for result in messageResults {
        if rowsById[result.conversation.id] == nil { orderedIds.append(result.conversation.id) }
        rowsById[result.conversation.id] = (result.conversation, result.matchedMessagePreview)
    }
    return orderedIds.compactMap { rowsById[$0] }
}

/// 消息 Tab 根：对齐 Electron `SidebarIMPanel`。
///
/// 消息只管人与会话；项目已是独立的一级 Tab，这里不再嵌入项目列表或分段切换。
/// 通讯录、新建群聊放在顶栏下侧次级动作条；右上角只保留通知。
struct MessagesTabRoot: View {
    @State private var imStore = IMConversationStore.shared
    @State private var labelStore = IMConversationLabelStore.shared
    @State private var externalContactStore = ExternalContactDirectoryStore.shared
    @State private var notificationStore = NotificationStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var router = MainRouter.shared
    @State private var accountDrawerCoordinator = AccountDrawerCoordinator.shared
    @State private var path: [MessagesNavigationRoute] = []
    @State private var showCreateGroup = false
    @State private var conversationSearchQuery = ""

    private struct ConversationRow: Identifiable {
        let conversation: IMConversation
        let preview: String
        var id: String { conversation.id }
    }

    private var filteredConversations: [ConversationRow] {
        let sorted = imStore.conversations.sorted { lhs, rhs in
            if lhs.pinned != rhs.pinned {
                return lhs.pinned && !rhs.pinned
            }
            let lhsKey = sortKey(for: lhs)
            let rhsKey = sortKey(for: rhs)
            if lhsKey != rhsKey { return lhsKey > rhsKey }
            return lhs.id < rhs.id
        }
        return mergeIMConversationSearchRows(
            conversations: sorted,
            messageResults: imStore.searchResults,
            query: conversationSearchQuery,
            title: resolvedTitle
        )
        .filter { labelStore.matches($0.conversation) }
        .map { ConversationRow(conversation: $0.conversation, preview: $0.preview) }
    }

    private var searchFeedback: IMConversationSearchFeedback {
        IMConversationSearchFeedback.resolve(
            query: conversationSearchQuery,
            isSearching: imStore.isSearching,
            error: imStore.searchError
        )
    }

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                PrimaryTabSecondaryBar(
                    items: [
                        PrimaryTabSecondaryBarItem(
                            id: "contacts",
                            title: L10n.Recent.segmentContacts,
                            assetName: IMPrimaryNavIcon.contacts.assetName
                        ) {
                            path.append(.contacts)
                        },
                        PrimaryTabSecondaryBarItem(
                            id: "createGroup",
                            title: L10n.Messages.createGroup,
                            assetName: IMPrimaryNavIcon.createGroup.assetName,
                            isEnabled: workspace.selectedOrganizationId != nil
                        ) {
                            showCreateGroup = true
                        },
                    ]
                )
                PrimaryTabSearchField(
                    text: $conversationSearchQuery,
                    prompt: L10n.Messages.searchPlaceholder
                )
                conversationLabelFilterBar
                content
            }
            .ttRootNavigationTitle(L10n.Common.tabMessages)
            .background(.tt.bgCanvasDefault)
            .ttToolbarBackground()
            .toolbar {
                AccountDrawerToolbarLeadingItem()
                ToolbarItemGroup(placement: .topBarTrailing) {
                    NotificationBellButton(unreadCount: notificationStore.unreadCount) {
                        path.append(.notifications)
                    }
                }
            }
            .navigationDestination(for: MessagesNavigationRoute.self) { route in
                switch route {
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
                case .contacts:
                    ContactsSectionView { path.append(.imConversation($0)) }
                        .navigationTitle(L10n.Recent.segmentContacts)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar(.hidden, for: .tabBar)
                case .notifications:
                    NotificationCenterScreen(onOpenConversation: { target in
                        path = []
                        router.openConversation(target)
                    }, onOpenIMConversation: { target in
                        path = [.imConversation(target)]
                    })
                    .toolbar(.hidden, for: .tabBar)
                case .account(let destination):
                    AccountGlobalPushDestinationScreen(
                        destination: destination,
                        onOpenConversation: { target in
                            path = []
                            router.openConversation(target)
                        },
                        onOpenIMConversation: { target in
                            path = []
                            path.append(.imConversation(target))
                        }
                    )
                    .toolbar(.hidden, for: .tabBar)
                }
            }
        }
        .onChange(of: workspace.selectedOrganizationId) { _, _ in
            path = []
            showCreateGroup = false
        }
        .task(id: conversationSearchQuery) {
            guard let organizationId = workspace.selectedOrganizationId else { return }
            await imStore.searchMessages(
                organizationId: organizationId,
                query: conversationSearchQuery
            )
        }
        .onChange(of: router.messagesTabActivationID) { _, _ in
            // TabView 会保留消息页实例，不能依赖 `onAppear` 或 Tab 值变化。
            // 统一由路由层记录每次进入（包括重复点按），确保置顶、未读和最后一条消息及时一致。
            Task { await reloadIM() }
        }
        .onChange(of: path.count) { _, count in
            router.setTabPushed(.messages, pushed: count > 0)
        }
        .onChange(of: router.pendingIMConversation) { _, pending in
            consumePendingIMConversation(pending)
        }
        .onChange(of: accountDrawerCoordinator.pendingGlobalPushDestination) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onChange(of: router.selectedTab) { _, _ in
            consumePendingAccountGlobalPush()
        }
        .onAppear {
            router.setTabPushed(.messages, pushed: path.count > 0)
            consumePendingIMConversation(router.pendingIMConversation)
            consumePendingAccountGlobalPush()
        }
        .task(id: workspace.selectedOrganizationId) {
            guard let organizationId = workspace.selectedOrganizationId, !organizationId.isEmpty else {
                externalContactStore.clear()
                labelStore.clear()
                return
            }
            // 冷启动可能直接恢复到消息 Tab；不能依赖任务页或会话详情先建立实时通道。
            CentrifugoClient.shared.connect()
            await labelStore.load(organizationId: organizationId)
            await externalContactStore.reload(organizationId: organizationId)
            await workspace.loadMembers(organizationId: organizationId)
        }
        .sheet(isPresented: $showCreateGroup) {
            if let organizationId = workspace.selectedOrganizationId, !organizationId.isEmpty {
                CreateGroupSheet(organizationId: organizationId) { target in
                    path = [.imConversation(target)]
                    Task { await imStore.reload(organizationId: organizationId) }
                }
            }
        }
        .alert(L10n.Messages.actionNotSaved, isPresented: Binding(
            get: { imStore.pinActionError != nil || imStore.muteActionError != nil },
            set: {
                if !$0 {
                    imStore.dismissPinActionError()
                    imStore.dismissMuteActionError()
                }
            }
        )) {
            Button(L10n.Common.confirm, role: .cancel) {
                imStore.dismissPinActionError()
                imStore.dismissMuteActionError()
            }
        } message: {
            Text(imStore.muteActionError ?? imStore.pinActionError ?? "")
        }
    }

    private func consumePendingAccountGlobalPush() {
        guard router.selectedTab == .messages,
              let destination = accountDrawerCoordinator.pendingGlobalPushDestination else { return }
        path.append(.account(destination))
        accountDrawerCoordinator.completeGlobalPushNavigation(destination)
    }

    private var content: some View {
        conversationList
            .ttDismissKeyboardOnContentTap()
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
    }

    @ViewBuilder
    private var conversationLabelFilterBar: some View {
        if !labelStore.labels.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: TTSpacing.sm) {
                    if !labelStore.selectedLabelIds.isEmpty {
                        Button {
                            labelStore.selectedLabelIds = []
                        } label: {
                            Label("全部", systemImage: "xmark")
                                .font(.tt.captionMedium)
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tt.textSecondary)
                    }
                    ForEach(labelStore.labels, id: \.id) { (label: IMConversationLabel) in
                        let selected = labelStore.selectedLabelIds.contains(label.id)
                        Button {
                            labelStore.toggleFilter(label.id)
                        } label: {
                            HStack(spacing: 4) {
                                if !selected {
                                    Circle()
                                        .fill(Color(hex: label.color))
                                        .frame(width: 7, height: 7)
                                }
                                Text(label.name)
                                    .lineLimit(1)
                            }
                            .font(.tt.captionMedium)
                            .foregroundStyle(selected ? Color.white : Color.tt.textSecondary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 5)
                            .background(
                                selected ? Color(hex: label.color) : Color.tt.bgSubtle,
                                in: Capsule()
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.xs)
            }
            .overlay(alignment: .bottom) { Divider().opacity(0.25) }
        }
    }

    @ViewBuilder
    private var conversationList: some View {
        List {
            Section {
                if (imStore.isLoading || workspace.isLoadingOrganizations), filteredConversations.isEmpty {
                    placeholderRow {
                        ProgressView(L10n.Recent.loading)
                            .frame(maxWidth: .infinity, minHeight: 360)
                    }
                } else if let workspaceError = workspace.errorMessage,
                          workspace.selectedOrganizationId == nil,
                          filteredConversations.isEmpty {
                    placeholderRow {
                        errorState(workspaceError) { Task { await reloadIM() } }
                            .frame(maxWidth: .infinity, minHeight: 420)
                    }
                } else if let err = imStore.loadError, filteredConversations.isEmpty {
                    placeholderRow {
                        errorState(err) { Task { await reloadIM() } }
                            .frame(maxWidth: .infinity, minHeight: 420)
                    }
                } else if searchFeedback == .loading, filteredConversations.isEmpty {
                    placeholderRow {
                        ProgressView(L10n.Common.loading)
                            .frame(maxWidth: .infinity, minHeight: 360)
                    }
                } else if case .failure(let error) = searchFeedback,
                          filteredConversations.isEmpty {
                    placeholderRow {
                        errorState(error) { retryConversationSearch() }
                            .frame(maxWidth: .infinity, minHeight: 420)
                    }
                } else if filteredConversations.isEmpty {
                    placeholderRow {
                        ContentUnavailableView {
                            Label(L10n.Recent.messagesEmptyTitle, systemImage: "message")
                        } description: {
                            Text(L10n.Recent.messagesEmptyDescription)
                        }
                        .frame(maxWidth: .infinity, minHeight: 420)
                    }
                } else {
                    searchFeedbackRow
                    ForEach(filteredConversations) { row in
                        let conversation = row.conversation
                        Button {
                            path.append(.imConversation(IMConversationTarget(
                                conversationId: conversation.id,
                                title: resolvedTitle(for: conversation)
                            )))
                        } label: {
                            IMInboxRow(conversation: conversation, previewOverride: row.preview)
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            Button {
                                Task { await imStore.togglePin(conversationId: conversation.id) }
                            } label: {
                                Label(
                                    conversation.pinned ? L10n.Home.unpinConversation : L10n.Home.pinConversation,
                                    systemImage: conversation.pinned ? "pin.slash" : "pin"
                                )
                            }
                            .disabled(imStore.isTogglingPin(conversationId: conversation.id))

                            Button {
                                Task { await imStore.toggleMute(conversationId: conversation.id) }
                            } label: {
                                Label(
                                    conversation.isMuted ? L10n.Messages.unmute : L10n.Messages.mute,
                                    systemImage: conversation.isMuted ? "bell" : "bell.slash"
                                )
                            }
                            .disabled(imStore.isTogglingMute(conversationId: conversation.id))
                        }
                        .listRowBackground(Color.clear)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                Task { await imStore.togglePin(conversationId: conversation.id) }
                            } label: {
                                Label(
                                    conversation.pinned ? L10n.Home.unpinConversation : L10n.Home.pinConversation,
                                    systemImage: conversation.pinned ? "pin.slash" : "pin"
                                )
                            }
                            .tint(conversation.pinned ? .gray : .tt.bgAccent)
                            .disabled(imStore.isTogglingPin(conversationId: conversation.id))
                        }
                    }
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 0, for: .scrollContent)
        .contentMargins(.bottom, 0, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .refreshable { await reloadIM() }
    }

    private func resolvedTitle(for conversation: IMConversation) -> String {
        let peerDisplayName = conversation.dmPeerUserId.flatMap { id in
            workspace.members.first { $0.userId == id }?.displayName
                ?? externalContactStore.contact(peerUserId: id)?.displayName
        }
        return IMConversationTitlePolicy.resolve(
            conversationName: conversation.name,
            isDirectMessage: conversation.conversationType == .dm,
            peerDisplayName: peerDisplayName,
            directMessageFallback: L10n.Messages.directMessage,
            conversationFallback: L10n.Messages.unnamedConversation
        )
    }

    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    @ViewBuilder
    private var searchFeedbackRow: some View {
        switch searchFeedback {
        case .none:
            EmptyView()
        case .loading:
            HStack(spacing: TTSpacing.sm) {
                ProgressView()
                    .controlSize(.small)
                Text(L10n.Common.loading)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        case .failure(let error):
            HStack(spacing: TTSpacing.sm) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.tt.textCritical)
                Text(error)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)
                Spacer(minLength: TTSpacing.sm)
                Button(L10n.Common.retry) { retryConversationSearch() }
                    .buttonStyle(.borderless)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
    }

    private func errorState(_ message: String, retry: @escaping () -> Void) -> some View {
        TTErrorStateView(message: message, onRetry: retry)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, TTSpacing.xl)
    }

    private func retryConversationSearch() {
        guard let organizationId = workspace.selectedOrganizationId else { return }
        Task {
            await imStore.searchMessages(
                organizationId: organizationId,
                query: conversationSearchQuery
            )
        }
    }

    private func reloadIM() async {
        guard let orgId = workspace.selectedOrganizationId else {
            externalContactStore.clear()
            await workspace.loadOrganizations()
            return
        }
        await externalContactStore.reload(organizationId: orgId)
        await labelStore.load(organizationId: orgId)
        await imStore.reload(organizationId: orgId)
    }

    private func consumePendingIMConversation(_ pending: IMConversationTarget?) {
        guard let pending else { return }
        path = [.imConversation(pending)]
        router.pendingIMConversation = nil
    }

    private func sortKey(for conversation: IMConversation) -> String {
        conversation.lastMessageAt ?? conversation.createdAt
    }
}

/// 从消息页直接创建群聊。服务端从当前会话推导创建者，客户端只选择其余组织成员，
/// 因而不会把「我」漏传或重复传入成员列表。
enum IMCreateGroupErrorPresentation: Equatable {
    case quotaExceeded
    case generic(String)

    static func resolve(_ error: Error) -> Self {
        let code = (error as? APIError)?.businessCode?.uppercased()
        if code == "ENTITLEMENT_GROUP_LIMIT_EXCEEDED" {
            return .quotaExceeded
        }
        return .generic(error.localizedDescription)
    }

    var localizedMessage: String {
        switch self {
        case .quotaExceeded:
            return L10n.Messages.groupLimitExceeded
        case .generic(let message):
            return message
        }
    }
}

struct IMGroupCreationAttempt: Equatable, Sendable {
    let organizationId: String
    let name: String
    let memberIds: [String]
    let externalContactIds: [String]
    let clientRequestId: String
}

func resolveIMGroupCreationAttempt(
    previous: IMGroupCreationAttempt?,
    organizationId: String,
    name: String,
    memberIds: [String],
    externalContactIds: [String],
    requestIdFactory: () -> String = { UUID().uuidString }
) -> IMGroupCreationAttempt {
    let normalizedMembers = Array(Set(memberIds.filter { !$0.isEmpty })).sorted()
    let normalizedExternalContacts = Array(Set(externalContactIds.filter { !$0.isEmpty })).sorted()
    if let previous,
       previous.organizationId == organizationId,
       previous.name == name,
       previous.memberIds == normalizedMembers,
       previous.externalContactIds == normalizedExternalContacts {
        return previous
    }
    return IMGroupCreationAttempt(
        organizationId: organizationId,
        name: name,
        memberIds: normalizedMembers,
        externalContactIds: normalizedExternalContacts,
        clientRequestId: requestIdFactory()
    )
}

private struct CreateGroupSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var workspace = WorkspaceStore.shared
    @State private var name = ""
    @State private var memberQuery = ""
    @State private var selectedMemberIds: Set<String> = []
    @State private var externalContacts: [ExternalContact] = []
    @State private var selectedExternalContactIds: Set<String> = []
    @State private var isCreating = false
    @State private var actionError: String?
    @State private var pendingCreationAttempt: IMGroupCreationAttempt?

    let organizationId: String
    let onCreated: (IMConversationTarget) -> Void
    private let conversationService: IMConversationServing

    init(
        organizationId: String,
        conversationService: IMConversationServing = IMConversationService(),
        onCreated: @escaping (IMConversationTarget) -> Void
    ) {
        self.organizationId = organizationId
        self.conversationService = conversationService
        self.onCreated = onCreated
    }

    private var currentUserId: String? { AuthService.shared.currentUser?.id }

    private var candidates: [OrganizationMember] {
        workspace.members
            .filter { !$0.userId.isEmpty && $0.userId != currentUserId }
            .sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            }
    }

    private var filteredCandidates: [OrganizationMember] {
        let query = memberQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return candidates }
        return candidates.filter { member in
            [member.displayName, member.user?.nickname, member.user?.username, member.user?.email]
                .compactMap { $0?.lowercased() }
                .contains { $0.contains(query) }
        }
    }

    private var filteredExternalContacts: [ExternalContact] {
        let query = memberQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return externalContacts }
        return externalContacts.filter {
            $0.displayName.lowercased().contains(query)
                || $0.peerOrganizationName.lowercased().contains(query)
        }
    }

    private var trimmedName: String {
        String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    }

    private var canCreate: Bool {
        !isCreating && !trimmedName.isEmpty
            && (!selectedMemberIds.isEmpty || !selectedExternalContactIds.isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section(L10n.Messages.groupName) {
                    TextField(L10n.Messages.groupNamePlaceholder, text: $name)
                        .textInputAutocapitalization(.sentences)
                        .onChange(of: name) { _, value in
                            if value.count > 200 { name = String(value.prefix(200)) }
                        }
                }

                Section {
                    Text(L10n.Messages.groupIncludesYou)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)

                    HStack(spacing: TTSpacing.sm) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.tt.textTertiary)
                        TextField(L10n.Recent.contactsFilter, text: $memberQuery)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }

                    if workspace.isLoadingMembers && candidates.isEmpty {
                        HStack(spacing: TTSpacing.sm) {
                            ProgressView().controlSize(.small)
                            Text(L10n.Common.loading)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                        }
                    } else if let error = workspace.errorMessage, candidates.isEmpty {
                        VStack(alignment: .leading, spacing: TTSpacing.sm) {
                            Text(error)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textCritical)
                            Button(L10n.Common.retry) { Task { await loadMembers() } }
                        }
                    } else if filteredCandidates.isEmpty {
                        Text(L10n.Recent.contactsEmptyDescription)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    } else {
                        ForEach(filteredCandidates) { member in
                            memberButton(member)
                        }
                        if !filteredExternalContacts.isEmpty {
                            Text("外部联系人")
                                .font(.tt.metaSemibold)
                                .foregroundStyle(.tt.textSecondary)
                                .padding(.top, TTSpacing.sm)
                            ForEach(filteredExternalContacts) { contact in
                                externalContactButton(contact)
                            }
                        }
                    }
                } header: {
                    Text(L10n.Messages.groupMembers)
                } footer: {
                    Text(L10n.Messages.groupMembersSelected(
                        selectedMemberIds.count + selectedExternalContactIds.count
                    ))
                }
            }
            .navigationTitle(L10n.Messages.createGroup)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                        .disabled(isCreating)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L10n.Common.create) { Task { await createGroup() } }
                        .disabled(!canCreate)
                }
            }
        }
        .task(id: organizationId) { await loadMembers() }
        .onChange(of: candidates.map(\.userId)) { _, ids in
            selectedMemberIds.formIntersection(Set(ids))
        }
        .onChange(of: externalContacts.map(\.contactId)) { _, ids in
            selectedExternalContactIds.formIntersection(Set(ids))
        }
        .alert(L10n.Messages.createGroup, isPresented: Binding(
            get: { actionError != nil },
            set: { if !$0 { actionError = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { actionError = nil }
        } message: {
            Text(actionError ?? "")
        }
    }

    private func memberButton(_ member: OrganizationMember) -> some View {
        let isSelected = selectedMemberIds.contains(member.userId)
        return Button {
            if isSelected {
                selectedMemberIds.remove(member.userId)
            } else {
                selectedMemberIds.insert(member.userId)
            }
        } label: {
            HStack(spacing: TTSpacing.sm) {
                IdentityColorAvatar(
                    name: member.displayName,
                    seed: member.userId,
                    imageUrl: member.avatar,
                    size: 34
                )
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(member.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if let subtitle = member.subtitle {
                        Text(subtitle)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: TTSpacing.sm)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? .tt.iconAccent : .tt.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(member.displayName)
        .accessibilityValue(isSelected ? L10n.Common.confirm : L10n.Common.cancel)
    }

    private func externalContactButton(_ contact: ExternalContact) -> some View {
        let isSelected = selectedExternalContactIds.contains(contact.contactId)
        return Button {
            if isSelected {
                selectedExternalContactIds.remove(contact.contactId)
            } else {
                selectedExternalContactIds.insert(contact.contactId)
            }
        } label: {
            HStack(spacing: TTSpacing.sm) {
                IdentityColorAvatar(
                    name: contact.displayName,
                    seed: contact.peerUserId,
                    imageUrl: contact.avatarURL,
                    size: 34
                )
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(contact.displayName.isEmpty ? contact.peerUserId : contact.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Text(contact.peerOrganizationName)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: TTSpacing.sm)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? .tt.iconAccent : .tt.textTertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(contact.displayName)
        .accessibilityValue(isSelected ? L10n.Common.confirm : L10n.Common.cancel)
    }

    private func loadMembers() async {
        await workspace.loadMembers(organizationId: organizationId)
        externalContacts = (try? await ExternalContactService.shared.list(organizationId: organizationId))?
            .filter { $0.relationship == "friend" }
            .sorted {
                $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
            } ?? []
    }

    private func createGroup() async {
        guard !trimmedName.isEmpty else {
            actionError = L10n.Messages.groupNameRequired
            return
        }
        guard !selectedMemberIds.isEmpty || !selectedExternalContactIds.isEmpty else {
            actionError = L10n.Messages.groupMembersRequired
            return
        }
        guard !isCreating else { return }

        isCreating = true
        defer { isCreating = false }
        let attempt = resolveIMGroupCreationAttempt(
            previous: pendingCreationAttempt,
            organizationId: organizationId,
            name: trimmedName,
            memberIds: selectedMemberIds.sorted(),
            externalContactIds: selectedExternalContactIds.sorted()
        )
        pendingCreationAttempt = attempt
        do {
            let conversationId: String
            if attempt.externalContactIds.isEmpty {
                conversationId = try await conversationService.createGroup(
                    organizationId: attempt.organizationId,
                    name: attempt.name,
                    memberIds: attempt.memberIds,
                    clientRequestId: attempt.clientRequestId
                )
            } else {
                conversationId = try await conversationService.createExternalGroup(
                    organizationId: attempt.organizationId,
                    name: attempt.name,
                    memberIds: attempt.memberIds,
                    externalContactIds: attempt.externalContactIds,
                    clientRequestId: attempt.clientRequestId
                )
            }
            guard !conversationId.isEmpty else {
                actionError = L10n.Messages.groupCreateFailed
                return
            }
            pendingCreationAttempt = nil
            onCreated(IMConversationTarget(conversationId: conversationId, title: attempt.name))
            dismiss()
        } catch {
            actionError = IMCreateGroupErrorPresentation.resolve(error).localizedMessage
        }
    }
}
