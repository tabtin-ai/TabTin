import SwiftUI

enum ContactsDirectoryTab: String, CaseIterable, Identifiable {
    case internalMembers
    case external
    case incoming
    case outgoing
    case blocked

    var id: String { rawValue }

    var title: String {
        switch self {
        case .internalMembers: "组织成员"
        case .external: "外部联系人"
        case .incoming: "收到的申请"
        case .outgoing: "发出的申请"
        case .blocked: "已拉黑"
        }
    }
}

struct ExternalContactGroups: Equatable {
    let friends: [ExternalContact]
    let blocked: [ExternalContact]
}

func groupExternalContacts(_ contacts: [ExternalContact]) -> ExternalContactGroups {
    ExternalContactGroups(
        friends: contacts.filter { $0.relationship == "friend" },
        blocked: contacts.filter { $0.relationship == "blocked" }
    )
}

enum ContactsDirectoryInvitationDirection {
    case incoming
    case outgoing
}

struct ContactsDirectoryState: Equatable {
    private(set) var organizationId: String?
    private(set) var generation = 0
    var contacts: [ExternalContact] = []
    var incomingInvitations: [ExternalContactInvitation] = []
    var outgoingInvitations: [ExternalContactInvitation] = []
    var contactsLoadError: String?
    var incomingInvitationsLoadError: String?
    var outgoingInvitationsLoadError: String?

    mutating func activate(organizationId: String?) {
        let normalized = Self.normalizedOrganizationId(organizationId)
        guard self.organizationId != normalized else { return }
        self.organizationId = normalized
        generation += 1
        contacts = []
        incomingInvitations = []
        outgoingInvitations = []
        contactsLoadError = nil
        incomingInvitationsLoadError = nil
        outgoingInvitationsLoadError = nil
    }

    func isActive(for selectedOrganizationId: String?) -> Bool {
        guard let selected = Self.normalizedOrganizationId(selectedOrganizationId) else { return false }
        return organizationId == selected
    }

    mutating func beginLoad(for selectedOrganizationId: String?) -> Int? {
        guard isActive(for: selectedOrganizationId) else { return nil }
        generation += 1
        contactsLoadError = nil
        incomingInvitationsLoadError = nil
        outgoingInvitationsLoadError = nil
        return generation
    }

    func isActive(for selectedOrganizationId: String?, generation: Int) -> Bool {
        self.generation == generation && isActive(for: selectedOrganizationId)
    }

    func owns(_ contact: ExternalContact, selectedOrganizationId: String?) -> Bool {
        guard let selected = Self.normalizedOrganizationId(selectedOrganizationId),
              organizationId == selected,
              contact.organizationId == selected else { return false }
        return contacts.contains { $0.contactId == contact.contactId }
    }

    func owns(
        _ invitation: ExternalContactInvitation,
        direction: ContactsDirectoryInvitationDirection,
        selectedOrganizationId: String?
    ) -> Bool {
        guard let selected = Self.normalizedOrganizationId(selectedOrganizationId),
              organizationId == selected else { return false }
        let scopedInvitations = switch direction {
        case .incoming: incomingInvitations
        case .outgoing: outgoingInvitations
        }
        return scopedInvitations.contains { $0.invitationId == invitation.invitationId }
    }

    private static func normalizedOrganizationId(_ organizationId: String?) -> String? {
        guard let normalized = organizationId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !normalized.isEmpty else { return nil }
        return normalized
    }
}

func canShowOrganizationMemberAddAction(canManage: Bool, isPersonalOrganization: Bool?) -> Bool {
    canManage && isPersonalOrganization == false
}

private func captureContactDirectoryResult<Value: Sendable>(
    _ operation: @escaping @Sendable () async throws -> Value
) async -> Result<Value, Error> {
    do {
        return .success(try await operation())
    } catch {
        return .failure(error)
    }
}

/// 消息 → 通讯录：对齐桌面端的组织成员、外部联系人、申请与黑名单分组。
struct ContactsSectionView: View {
    @State private var workspace = WorkspaceStore.shared
    @State private var externalContactStore = ExternalContactDirectoryStore.shared
    @State private var selectedTab: ContactsDirectoryTab = .internalMembers
    @State private var directoryState = ContactsDirectoryState()
    @State private var localQuery = ""
    @State private var isOpeningDM = false
    @State private var isLoadingDirectory = false
    @State private var isMutating = false
    @State private var actionMessage: String?
    @State private var blockedContactToast: String?
    @State private var blockedContactToastDismissTask: Task<Void, Never>?
    @State private var showAddExternalContact = false
    @State private var showAddOrganizationMember = false
    @State private var contactPendingRemoval: ExternalContact?
    @State private var acceptAsOrganization: [String: String] = [:]
    private let conversationService: IMConversationServing = IMConversationService()
    private let externalSearchQuery: Binding<String>?
    private let showsSearchField: Bool

    let onOpenConversation: (IMConversationTarget) -> Void

    init(
        searchQuery: Binding<String>? = nil,
        showsSearchField: Bool = true,
        onOpenConversation: @escaping (IMConversationTarget) -> Void
    ) {
        externalSearchQuery = searchQuery
        self.showsSearchField = showsSearchField
        self.onOpenConversation = onOpenConversation
    }

    private var currentUserId: String? { AuthService.shared.currentUser?.id }
    private var directoryIsCurrent: Bool {
        directoryState.isActive(for: workspace.selectedOrganizationId)
    }
    private var allExternalContacts: [ExternalContact] {
        directoryIsCurrent ? directoryState.contacts : []
    }
    private var incomingInvitations: [ExternalContactInvitation] {
        directoryIsCurrent ? directoryState.incomingInvitations : []
    }
    private var outgoingInvitations: [ExternalContactInvitation] {
        directoryIsCurrent ? directoryState.outgoingInvitations : []
    }
    private var externalContactsLoadError: String? {
        directoryIsCurrent ? directoryState.contactsLoadError : nil
    }
    private var incomingInvitationsLoadError: String? {
        directoryIsCurrent ? directoryState.incomingInvitationsLoadError : nil
    }
    private var outgoingInvitationsLoadError: String? {
        directoryIsCurrent ? directoryState.outgoingInvitationsLoadError : nil
    }
    private var externalContactGroups: ExternalContactGroups {
        groupExternalContacts(allExternalContacts)
    }
    private var externalContacts: [ExternalContact] {
        externalContactGroups.friends
    }
    private var blockedContacts: [ExternalContact] {
        externalContactGroups.blocked
    }
    private var isLoading: Bool {
        selectedTab == .internalMembers ? workspace.isLoadingMembers : isLoadingDirectory
    }
    private var loadError: String? {
        switch selectedTab {
        case .internalMembers: workspace.errorMessage
        case .external, .blocked: externalContactsLoadError
        case .incoming: incomingInvitationsLoadError
        case .outgoing: outgoingInvitationsLoadError
        }
    }
    private var queryText: String {
        externalSearchQuery?.wrappedValue ?? localQuery
    }
    private var searchQueryBinding: Binding<String> {
        externalSearchQuery ?? $localQuery
    }
    private var canAddOrganizationMember: Bool {
        canShowOrganizationMemberAddAction(
            canManage: workspace.canManage,
            isPersonalOrganization: workspace.selectedOrganization?.isPersonal
        )
    }

    private var filteredMembers: [OrganizationMember] {
        let q = queryText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let base = workspace.members.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        guard !q.isEmpty else { return base }
        return base.filter { member in
            let fields = [
                member.displayName,
                member.user?.nickname,
                member.user?.username,
                member.user?.email,
            ].compactMap { $0?.lowercased() }
            return fields.contains { $0.contains(q) }
        }
    }

    private var filteredExternalContacts: [ExternalContact] {
        let q = queryText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let base = externalContacts.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        guard !q.isEmpty else { return base }
        return base.filter {
            [$0.displayName, $0.peerUserId, $0.peerOrganizationName]
                .contains { $0.lowercased().contains(q) }
        }
    }

    private var filteredBlockedContacts: [ExternalContact] {
        filterContacts(blockedContacts)
    }

    private var filteredIncomingInvitations: [ExternalContactInvitation] {
        filterInvitations(incomingInvitations)
    }

    private var filteredOutgoingInvitations: [ExternalContactInvitation] {
        filterInvitations(outgoingInvitations)
    }

    private var currentTabIsEmpty: Bool {
        switch selectedTab {
        case .internalMembers: filteredMembers.isEmpty
        case .external: filteredExternalContacts.isEmpty
        case .incoming: filteredIncomingInvitations.isEmpty
        case .outgoing: filteredOutgoingInvitations.isEmpty
        case .blocked: filteredBlockedContacts.isEmpty
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            contactsTabBar

            if selectedTab == .external ||
                (selectedTab == .internalMembers && canAddOrganizationMember) {
                HStack {
                    Spacer(minLength: 0)
                    Button {
                        if selectedTab == .internalMembers {
                            showAddOrganizationMember = true
                        } else {
                            showAddExternalContact = true
                        }
                    } label: {
                        Label(
                            selectedTab == .internalMembers ? "添加成员" : "添加联系人",
                            systemImage: "person.badge.plus"
                        )
                        .font(.tt.captionSemibold)
                    }
                    .buttonStyle(.bordered)
                    .disabled(isMutating)
                }
                .padding(.horizontal, TTSpacing.md)
                .padding(.vertical, TTSpacing.xs)
            }

            if selectedTab != .internalMembers, let loadError, !currentTabIsEmpty {
                HStack(spacing: TTSpacing.sm) {
                    Text(loadError)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button("重试") { Task { await reloadExternalDirectory() } }
                        .font(.tt.captionSemibold)
                }
                .padding(.horizontal, TTSpacing.md)
                .padding(.top, TTSpacing.xs)
            }

            Group {
                if isLoading && currentTabIsEmpty {
                    ProgressView(L10n.Recent.loading)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let loadError, currentTabIsEmpty {
                    TTErrorStateView(message: loadError) { Task { await reload() } }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .padding(TTSpacing.xl)
                } else if currentTabIsEmpty {
                    ContentUnavailableView(
                        emptyTitle,
                        systemImage: "person.2.slash",
                        description: Text(emptyDescription)
                    )
                } else {
                    List {
                        rowsForSelectedTab
                    }
                    .listStyle(.plain)
                    .contentMargins(.top, 0, for: .scrollContent)
                    .scrollDismissesKeyboard(.interactively)
                    .refreshable { await reload() }
                }
            }
        }
        .background(.tt.bgCanvasDefault)
        .modifier(ContactsSystemSearchModifier(
            isEnabled: showsSearchField,
            text: searchQueryBinding
        ))
        .task(id: workspace.selectedOrganizationId) {
            let organizationId = workspace.selectedOrganizationId
            activateDirectoryScope(organizationId)
            selectedTab = .internalMembers
            localQuery = ""
            await reload(organizationId: organizationId)
        }
        .sheet(isPresented: $showAddExternalContact) {
            if let organizationId = workspace.selectedOrganizationId {
                AddExternalContactSheet(organizationId: organizationId) {
                    selectedTab = .outgoing
                    await reloadExternalDirectory()
                }
            }
        }
        .sheet(isPresented: $showAddOrganizationMember) {
            if let organization = workspace.selectedOrganization {
                NavigationStack {
                    WorkspaceInvitationsScreen(organization: organization)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button(L10n.Common.close) {
                                    showAddOrganizationMember = false
                                }
                            }
                        }
                }
            }
        }
        .confirmationDialog(
            "解除外部联系人关系？",
            isPresented: Binding(
                get: { contactPendingRemoval != nil },
                set: { if !$0 { contactPendingRemoval = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("解除关系", role: .destructive) {
                if let contact = contactPendingRemoval {
                    Task { await updateContact(contact, action: "remove") }
                }
            }
            Button("取消", role: .cancel) { contactPendingRemoval = nil }
        } message: {
            Text("私信历史仍会保留，但双方不能再发送新消息或互相邀请；共同群聊不受影响。")
        }
        .alert("提示", isPresented: Binding(
            get: { actionMessage != nil },
            set: { if !$0 { actionMessage = nil } }
        )) {
            Button("好", role: .cancel) { actionMessage = nil }
        } message: {
            Text(actionMessage ?? "")
        }
        .overlay(alignment: .bottom) {
            if let blockedContactToast {
                ContactsDirectoryToast(message: blockedContactToast)
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.bottom, TTSpacing.lg)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: blockedContactToast)
        .onDisappear {
            blockedContactToastDismissTask?.cancel()
            blockedContactToastDismissTask = nil
        }
    }

    private func showBlockedContactToast() {
        blockedContactToastDismissTask?.cancel()
        withAnimation(.easeInOut(duration: 0.2)) {
            blockedContactToast = "该外部联系人已被拉黑，解除拉黑后才能发消息。"
        }
        blockedContactToastDismissTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.4))
            guard !Task.isCancelled else { return }
            withAnimation(.easeInOut(duration: 0.2)) {
                blockedContactToast = nil
            }
            blockedContactToastDismissTask = nil
        }
    }

    private var contactsTabBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(ContactsDirectoryTab.allCases) { tab in
                    Button {
                        selectedTab = tab
                    } label: {
                        Text(tab.title)
                        .font(selectedTab == tab ? .tt.bodySemibold : .tt.body)
                        .foregroundStyle(selectedTab == tab ? .tt.textPrimary : .tt.textSecondary)
                        .padding(.horizontal, TTSpacing.md)
                        .frame(minHeight: 46)
                        .overlay(alignment: .bottom) {
                            if selectedTab == tab {
                                Capsule()
                                    .fill(Color.tt.bgAccent)
                                    .frame(height: 3)
                                    .padding(.horizontal, TTSpacing.xs)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
                    .accessibilityLabel(tab.title)
                }
            }
        }
        .background(.tt.bgCanvasDefault)
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.tt.borderLight).frame(height: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("通讯录分组")
    }

    @ViewBuilder
    private var rowsForSelectedTab: some View {
        switch selectedTab {
        case .internalMembers:
            ForEach(filteredMembers) { member in
                let isSelf = member.userId == currentUserId
                Button {
                    openDirectMessage(member)
                } label: {
                    ContactRow(member: member, isSelf: isSelf)
                }
                .buttonStyle(.plain)
                .disabled(isSelf || isOpeningDM)
                .listRowBackground(Color.clear)
            }
        case .external:
            ForEach(filteredExternalContacts) { contact in
                HStack(spacing: TTSpacing.sm) {
                    Button { openExternalDirectMessage(contact) } label: {
                        ExternalContactRow(contact: contact)
                    }
                    .buttonStyle(.plain)
                    .disabled(isOpeningDM || isMutating)
                    Menu {
                        Button("拉黑") { Task { await updateContact(contact, action: "block") } }
                        Button("解除关系", role: .destructive) { contactPendingRemoval = contact }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.tt.iconBody)
                            .foregroundStyle(.tt.iconSecondary)
                            .frame(width: 44, height: 44)
                    }
                    .disabled(isMutating)
                    .accessibilityLabel("更多操作")
                }
                .listRowBackground(Color.clear)
            }
        case .blocked:
            ForEach(filteredBlockedContacts) { contact in
                HStack(spacing: TTSpacing.sm) {
                    Button {
                        showBlockedContactToast()
                    } label: {
                        ExternalContactRow(contact: contact)
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityHint("解除拉黑后才能发消息")
                    Button("解除拉黑") {
                        Task { await updateContact(contact, action: "unblock") }
                    }
                    .buttonStyle(.bordered)
                    .disabled(isMutating)
                }
                .listRowBackground(Color.clear)
            }
        case .incoming:
            ForEach(filteredIncomingInvitations) { invitation in
                invitationRow(invitation, isIncoming: true)
                    .listRowBackground(Color.clear)
            }
        case .outgoing:
            ForEach(filteredOutgoingInvitations) { invitation in
                invitationRow(invitation, isIncoming: false)
                    .listRowBackground(Color.clear)
            }
        }
    }

    private func invitationRow(_ invitation: ExternalContactInvitation, isIncoming: Bool) -> some View {
        VStack(alignment: .leading, spacing: TTSpacing.xs) {
            HStack(spacing: TTSpacing.sm) {
                IdentityColorAvatar(
                    name: invitation.displayName,
                    seed: invitation.peerUserId,
                    imageUrl: invitation.avatarURL,
                    size: 40
                )
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(invitation.displayName.isEmpty ? invitation.peerUserId : invitation.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Text(invitation.note ?? invitation.peerOrganizationName ?? "跨组织联系人申请")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            HStack(spacing: TTSpacing.sm) {
                Spacer(minLength: 0)
                if isIncoming {
                    Menu {
                        ForEach(eligibleOrganizations(for: invitation)) { organization in
                            Button {
                                acceptAsOrganization[invitation.id] = organization.id
                            } label: {
                                if acceptedOrganizationId(for: invitation) == organization.id {
                                    Label(organization.name, systemImage: "checkmark")
                                } else {
                                    Text(organization.name)
                                }
                            }
                        }
                    } label: {
                        Text(acceptedOrganizationName(for: invitation))
                            .font(.tt.caption)
                            .lineLimit(1)
                    }
                    .disabled(isMutating || eligibleOrganizations(for: invitation).isEmpty)
                    Button("拒绝", role: .destructive) {
                        Task { await resolveInvitation(invitation, action: "reject") }
                    }
                    .disabled(isMutating)
                    Button("同意") {
                        Task { await resolveInvitation(invitation, action: "accept") }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isMutating || acceptedOrganizationId(for: invitation) == nil)
                } else {
                    Button("取消申请") {
                        Task { await resolveInvitation(invitation, action: "cancel") }
                    }
                    .buttonStyle(.bordered)
                    .disabled(isMutating)
                }
            }
        }
        .padding(.vertical, TTSpacing.xs)
    }

    private func activateDirectoryScope(_ organizationId: String?) {
        let previousOrganizationId = directoryState.organizationId
        directoryState.activate(organizationId: organizationId)
        guard directoryState.organizationId != previousOrganizationId else { return }
        acceptAsOrganization = [:]
        contactPendingRemoval = nil
        blockedContactToastDismissTask?.cancel()
        blockedContactToastDismissTask = nil
        blockedContactToast = nil
        isLoadingDirectory = directoryState.organizationId != nil
    }

    private func reload(organizationId requestedOrganizationId: String? = nil) async {
        let organizationId = requestedOrganizationId ?? workspace.selectedOrganizationId
        guard let orgId = organizationId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !orgId.isEmpty else {
            activateDirectoryScope(nil)
            externalContactStore.clear()
            return
        }
        guard workspace.selectedOrganizationId == orgId else { return }
        activateDirectoryScope(orgId)
        await workspace.loadMembers(organizationId: orgId)
        guard workspace.selectedOrganizationId == orgId else { return }
        await reloadExternalDirectory(organizationId: orgId)
    }

    private func reloadExternalDirectory(organizationId requestedOrganizationId: String? = nil) async {
        let organizationId = requestedOrganizationId ?? workspace.selectedOrganizationId
        guard let organizationId = organizationId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !organizationId.isEmpty,
              workspace.selectedOrganizationId == organizationId else { return }
        activateDirectoryScope(organizationId)
        guard let loadGeneration = directoryState.beginLoad(for: organizationId) else { return }
        isLoadingDirectory = true
        defer {
            if workspace.selectedOrganizationId == organizationId,
               directoryState.isActive(for: organizationId, generation: loadGeneration) {
                isLoadingDirectory = false
            }
        }
        async let loadedContacts = captureContactDirectoryResult {
            try await ExternalContactService.shared.list(organizationId: organizationId)
        }
        async let loadedIncoming = captureContactDirectoryResult {
            try await ExternalContactService.shared.listInvitations(
                organizationId: organizationId,
                direction: "incoming",
                status: "pending"
            )
        }
        async let loadedOutgoing = captureContactDirectoryResult {
            try await ExternalContactService.shared.listInvitations(
                organizationId: organizationId,
                direction: "outgoing",
                status: "pending"
            )
        }
        let results = await (loadedContacts, loadedIncoming, loadedOutgoing)
        guard workspace.selectedOrganizationId == organizationId,
              directoryState.isActive(for: organizationId, generation: loadGeneration) else { return }
        switch results.0 {
        case .success(let contacts): directoryState.contacts = contacts
        case .failure(let error): directoryState.contactsLoadError = error.localizedDescription
        }
        switch results.1 {
        case .success(let invitations): directoryState.incomingInvitations = invitations
        case .failure(let error): directoryState.incomingInvitationsLoadError = error.localizedDescription
        }
        switch results.2 {
        case .success(let invitations): directoryState.outgoingInvitations = invitations
        case .failure(let error): directoryState.outgoingInvitationsLoadError = error.localizedDescription
        }
    }

    private func updateContact(_ contact: ExternalContact, action: String) async {
        guard let organizationId = workspace.selectedOrganizationId,
              directoryState.owns(contact, selectedOrganizationId: organizationId),
              !isMutating else { return }
        isMutating = true
        defer {
            isMutating = false
            contactPendingRemoval = nil
        }
        do {
            try await ExternalContactService.shared.updateContact(
                contactId: contact.id,
                action: action,
                organizationId: organizationId
            )
            guard workspace.selectedOrganizationId == organizationId else { return }
            await reloadExternalDirectory()
            await externalContactStore.reload(organizationId: organizationId)
        } catch {
            guard workspace.selectedOrganizationId == organizationId else { return }
            actionMessage = error.localizedDescription
        }
    }

    private func resolveInvitation(_ invitation: ExternalContactInvitation, action: String) async {
        let direction: ContactsDirectoryInvitationDirection = action == "cancel" ? .outgoing : .incoming
        guard let organizationId = workspace.selectedOrganizationId,
              directoryState.owns(
                  invitation,
                  direction: direction,
                  selectedOrganizationId: organizationId
              ),
              !isMutating else { return }
        isMutating = true
        defer { isMutating = false }
        do {
            if action == "accept" {
                guard let destinationId = acceptedOrganizationId(for: invitation) else {
                    throw APIError.apiError("请选择一个不同于申请方的组织身份后再同意。")
                }
                _ = try await ExternalContactService.shared.accept(
                    organizationId: destinationId,
                    invitationId: invitation.id
                )
            } else {
                try await ExternalContactService.shared.updateInvitation(
                    invitationId: invitation.id,
                    action: action,
                    organizationId: organizationId
                )
            }
            guard workspace.selectedOrganizationId == organizationId else { return }
            await reloadExternalDirectory()
            await externalContactStore.reload(organizationId: organizationId)
        } catch {
            guard workspace.selectedOrganizationId == organizationId else { return }
            actionMessage = error.localizedDescription
        }
    }

    private func filterContacts(_ contacts: [ExternalContact]) -> [ExternalContact] {
        let q = queryText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let sorted = contacts.sorted {
            $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending
        }
        guard !q.isEmpty else { return sorted }
        return sorted.filter {
            [$0.displayName, $0.peerUserId, $0.peerOrganizationName]
                .contains { $0.lowercased().contains(q) }
        }
    }

    private func filterInvitations(_ invitations: [ExternalContactInvitation]) -> [ExternalContactInvitation] {
        let q = queryText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !q.isEmpty else { return invitations }
        return invitations.filter {
            [$0.displayName, $0.peerUserId, $0.peerOrganizationName ?? "", $0.note ?? ""]
                .contains { $0.lowercased().contains(q) }
        }
    }

    private var emptyTitle: String {
        queryText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "暂无内容"
            : "没有匹配的联系人"
    }

    private var emptyDescription: String {
        switch selectedTab {
        case .internalMembers: L10n.Recent.contactsEmptyDescription
        case .external: "添加其他组织的联系人后，可在这里发起私信。"
        case .incoming: "新的联系人申请会显示在这里。"
        case .outgoing: "你发出的待处理申请会显示在这里。"
        case .blocked: "你拉黑的外部联系人会显示在这里。"
        }
    }

    private func eligibleOrganizations(for invitation: ExternalContactInvitation) -> [Organization] {
        workspace.organizations.filter { $0.id != invitation.peerOrganizationId }
    }

    private func acceptedOrganizationId(for invitation: ExternalContactInvitation) -> String? {
        let eligible = eligibleOrganizations(for: invitation)
        if let selected = acceptAsOrganization[invitation.id], eligible.contains(where: { $0.id == selected }) {
            return selected
        }
        if let current = workspace.selectedOrganizationId, eligible.contains(where: { $0.id == current }) {
            return current
        }
        return eligible.first?.id
    }

    private func acceptedOrganizationName(for invitation: ExternalContactInvitation) -> String {
        guard let id = acceptedOrganizationId(for: invitation) else { return "选择身份" }
        return workspace.organizations.first(where: { $0.id == id })?.name ?? "选择身份"
    }

    private func openDirectMessage(_ member: OrganizationMember) {
        let userId = member.userId
        guard !userId.isEmpty, userId != currentUserId else { return }
        guard let organizationId = workspace.selectedOrganizationId, !organizationId.isEmpty else {
            actionMessage = "组织信息尚未就绪，请稍后重试。"
            return
        }
        guard !isOpeningDM else { return }
        isOpeningDM = true
        Task {
            defer { isOpeningDM = false }
            do {
                let id = try await resolveDirectMessageConversationId(
                    conversations: IMConversationStore.shared.conversations,
                    organizationId: organizationId,
                    otherUserId: userId
                ) {
                    try await conversationService.createOrGetDM(
                        organizationId: organizationId,
                        otherUserId: userId
                    )
                }
                guard !id.isEmpty else {
                    actionMessage = "暂时无法打开私信。"
                    return
                }
                IMConversationStore.shared.rememberDirectMessage(
                    conversationId: id,
                    organizationId: organizationId,
                    otherUserId: userId,
                    displayName: member.displayName
                )
                onOpenConversation(IMConversationTarget(
                    conversationId: id,
                    title: member.displayName.isEmpty ? "私信" : member.displayName
                ))
            } catch {
                actionMessage = error.localizedDescription
            }
        }
    }

    private func openExternalDirectMessage(_ contact: ExternalContact) {
        guard !contact.contactId.isEmpty else {
            actionMessage = "缺少外部联系人信息，请稍后重试。"
            return
        }
        guard let organizationId = workspace.selectedOrganizationId, !organizationId.isEmpty else {
            actionMessage = "组织信息尚未就绪，请稍后重试。"
            return
        }
        guard directoryState.owns(contact, selectedOrganizationId: organizationId) else {
            actionMessage = "外部联系人列表已切换，请刷新后重试。"
            return
        }
        guard !isOpeningDM else { return }
        isOpeningDM = true
        Task {
            defer { isOpeningDM = false }
            do {
                let id = try await conversationService.createOrGetExternalDM(
                    organizationId: organizationId,
                    externalContactId: contact.contactId
                )
                guard !id.isEmpty else {
                    actionMessage = "暂时无法打开外部私信。"
                    return
                }
                IMConversationStore.shared.rememberExternalDirectMessage(
                    conversationId: id,
                    organizationId: organizationId,
                    peerUserId: contact.peerUserId,
                    displayName: contact.displayName
                )
                onOpenConversation(IMConversationTarget(
                    conversationId: id,
                    title: contact.displayName.isEmpty ? "外部联系人" : contact.displayName
                ))
            } catch {
                actionMessage = error.localizedDescription
            }
        }
    }
}

private struct ContactsSystemSearchModifier: ViewModifier {
    let isEnabled: Bool
    let text: Binding<String>

    @ViewBuilder
    func body(content: Content) -> some View {
        if isEnabled {
            content.searchable(
                text: text,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: Text(L10n.Recent.contactsFilter)
            )
        } else {
            content
        }
    }
}

private struct ContactsDirectoryToast: View {
    let message: String

    var body: some View {
        HStack(spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.circle.fill")
                .font(.tt.iconBody)
                .foregroundStyle(.tt.textWarning)
            Text(message)
                .font(.tt.meta)
                .foregroundStyle(.tt.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, TTSpacing.md)
        .padding(.vertical, TTSpacing.sm)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.bgWarning.opacity(0.25), lineWidth: 0.5)
        )
        .shadow(color: .black.opacity(0.12), radius: 16, x: 0, y: 8)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(message)
    }
}

private struct ContactRow: View {
    let member: OrganizationMember
    let isSelf: Bool

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            IdentityColorAvatar(
                name: member.displayName,
                seed: member.userId,
                imageUrl: member.avatar,
                size: 40
            )
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(member.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if isSelf {
                        Text(L10n.Recent.contactsYou)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                if let subtitle = member.subtitle {
                    Text(subtitle)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if !isSelf {
                Image(systemName: "chevron.right")
                    .font(.tt.iconCaption)
                    .foregroundStyle(.tt.textTertiary)
            }
        }
        .padding(.vertical, TTSpacing.xs)
        .contentShape(Rectangle())
        .accessibilityLabel(
            isSelf
                ? "\(member.displayName)，自己"
                : "\(member.displayName)，打开私信"
        )
    }
}

private struct ExternalContactRow: View {
    let contact: ExternalContact

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            IdentityColorAvatar(
                name: contact.displayName,
                seed: contact.peerUserId,
                imageUrl: contact.avatarURL,
                size: 40
            )
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(contact.displayName.isEmpty ? contact.peerUserId : contact.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Text("外部")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.iconAccent)
                }
                if !contact.peerOrganizationName.isEmpty {
                    Text(contact.peerOrganizationName)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, TTSpacing.xs)
        .contentShape(Rectangle())
        .accessibilityLabel(
            "\(contact.displayName.isEmpty ? contact.peerUserId : contact.displayName)，外部联系人，打开私信"
        )
    }
}

private struct AddExternalContactSheet: View {
    let organizationId: String
    let onRequested: () async -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var phone = ""
    @State private var note = ""
    @State private var candidate: ExternalContactCandidate?
    @State private var isBusy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("完整手机号", text: $phone)
                        .keyboardType(.phonePad)
                        .onChange(of: phone) { _, _ in candidate = nil }
                    Button("查找") { Task { await discover() } }
                        .disabled(phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isBusy)
                } footer: {
                    Text("通过完整手机号精确查找，对方同意后即可发起私信。")
                }
                if let candidate {
                    Section("查找结果") {
                        HStack(spacing: TTSpacing.md) {
                            IdentityColorAvatar(
                                name: candidate.displayName,
                                seed: candidate.userId,
                                imageUrl: candidate.avatarURL,
                                size: 40
                            )
                            Text(candidate.displayName.isEmpty ? candidate.userId : candidate.displayName)
                                .font(.tt.bodySemibold)
                        }
                        if candidate.relationship == "none" || candidate.relationship == "removed" {
                            TextField("验证消息（选填）", text: $note, axis: .vertical)
                                .lineLimit(2...4)
                            Button("发送申请") { Task { await sendRequest(candidate) } }
                                .disabled(isBusy)
                        } else {
                            Text(candidate.relationship == "pending" ? "申请已发送" : "已是外部联系人")
                                .foregroundStyle(.tt.textSecondary)
                        }
                    }
                }
                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.tt.textCritical)
                    }
                }
            }
            .navigationTitle("添加外部联系人")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
            }
            .ttLoading(isBusy)
        }
        .presentationDetents([.medium, .large])
    }

    private func discover() async {
        let normalizedPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPhone.isEmpty, !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            candidate = try await ExternalContactService.shared.discover(
                organizationId: organizationId,
                phone: normalizedPhone
            )
        } catch {
            candidate = nil
            errorMessage = error.localizedDescription
        }
    }

    private func sendRequest(_ candidate: ExternalContactCandidate) async {
        guard !isBusy else { return }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            _ = try await ExternalContactService.shared.invite(
                organizationId: organizationId,
                targetUserId: candidate.userId,
                note: note.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            )
            await onRequested()
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
