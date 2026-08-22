import SwiftUI
import UIKit

enum ConversationSessionShareMode: String, CaseIterable, Identifiable, Sendable {
    case viewOnly
    case collaborate
    case continueTask

    var id: Self { self }

    var title: String {
        switch self {
        case .viewOnly: return "实时查看"
        case .collaborate: return "实时协作"
        case .continueTask: return "任务续接"
        }
    }

    var detail: String {
        switch self {
        case .viewOnly:
            return "对方可以持续查看原任务的最新内容，不能操作你的执行现场。"
        case .collaborate:
            return "对方可以实时查看并参与 Agent 对话。"
        case .continueTask:
            return "冻结发送时的任务上下文，交给对方创建一个独立新任务。"
        }
    }

    var icon: String {
        switch self {
        case .viewOnly: return "eye"
        case .collaborate: return "person.2.fill"
        case .continueTask: return "arrow.triangle.branch"
        }
    }

    var canFork: Bool { false }
    var canChat: Bool { self == .collaborate }
    var isContinuation: Bool { self == .continueTask }
    var accessMode: String { canChat ? "collaborate" : "view" }
}

struct ConversationSessionShareRequest: Equatable, Sendable {
    let sessionId: String
    let granteeUserId: String
    let mode: ConversationSessionShareMode
    let conversationId: String?
    let clientRequestId: String

    init(
        sessionId: String,
        granteeUserId: String,
        mode: ConversationSessionShareMode,
        conversationId: String? = nil,
        clientRequestId: String = UUID().uuidString
    ) {
        self.sessionId = sessionId
        self.granteeUserId = granteeUserId
        self.mode = mode
        self.conversationId = conversationId
        self.clientRequestId = clientRequestId
    }

    var body: [String: Any] {
        var body: [String: Any] = [
            "session_id": sessionId,
            "grantee_user_id": granteeUserId,
            "can_fork": mode.canFork,
            "can_chat": mode.canChat,
            "card_contract": "session_share_v2",
            "access_mode": mode.accessMode,
            "client_request_id": clientRequestId,
        ]
        if let conversationId, !conversationId.isEmpty {
            body["conversation_id"] = conversationId
        }
        return body
    }
}

struct ConversationSessionShareResponse: Decodable, Equatable, Sendable {
    let id: String
    let sessionId: String
    let sessionTitle: String
    let granteeUserId: String
    let canFork: Bool
    let canChat: Bool
    let conversationId: String?
    let messageId: Int?

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId = "session_id"
        case sessionTitle = "session_title"
        case granteeUserId = "grantee_user_id"
        case canFork = "can_fork"
        case canChat = "can_chat"
        case conversationId = "conversation_id"
        case messageId = "message_id"
    }
}

enum ConversationSessionSharePolicy {
    struct MemberSearchIdentity: Hashable {
        let organizationId: String
        let query: String

        init(organizationId: String, rawQuery: String) {
            self.organizationId = organizationId
            query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        }
    }

    static func memberDisplayName(_ member: OrganizationMember) -> String {
        let candidates = [member.user?.nickname, member.user?.username]
        return candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty } ?? "成员"
    }

    static func memberSearchQuery(_ rawQuery: String) -> [String: String]? {
        let query = rawQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return nil }
        return ["search": query, "search_mode": "nickname"]
    }

    static func emptyRecipientsMessage(search: String) -> String {
        search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "组织内没有其他可共享成员"
            : "未找到匹配成员"
    }

    static func recipientSubtitle(_ member: OrganizationMember) -> String? {
        guard let rawUsername = member.user?.username else { return nil }
        let username = rawUsername.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty else { return nil }
        return "@\(username)"
    }

    static func memberSearchErrorMessage(for error: Error) -> String? {
        error.isCancellation ? nil : "搜索组织成员失败，请稍后重试。"
    }

    static func retainedRecipientId(
        _ selectedUserId: String?,
        in visibleMembers: [OrganizationMember]
    ) -> String? {
        guard let selectedUserId,
              visibleMembers.contains(where: { $0.userId == selectedUserId }) else { return nil }
        return selectedUserId
    }

    static func recipients(
        from members: [OrganizationMember],
        currentUserId: String
    ) -> [OrganizationMember] {
        members
            .filter { !$0.userId.isEmpty && $0.userId != currentUserId }
            .sorted {
                let order = $0.displayName.localizedCaseInsensitiveCompare($1.displayName)
                if order != .orderedSame { return order == .orderedAscending }
                return $0.userId < $1.userId
            }
    }

    static func canSubmit(
        selectedUserId: String?,
        isSubmitting: Bool,
        completedShareId: String?
    ) -> Bool {
        guard !isSubmitting, completedShareId == nil,
              let selectedUserId, !selectedUserId.isEmpty else { return false }
        return true
    }

    static func canEditSelection(
        isSubmitting: Bool,
        completedShareId: String?
    ) -> Bool {
        !isSubmitting && completedShareId == nil
    }

    static func destinationText(
        recipientName: String,
        response: ConversationSessionShareResponse
    ) -> String {
        let name = recipientName.trimmingCharacters(in: .whitespacesAndNewlines)
        let peer = name.isEmpty ? "该成员" : name
        if let messageId = response.messageId {
            return "共享卡已发送到你与\(peer)的私信（消息 #\(messageId)）。"
        }
        return "共享卡已发送到你与\(peer)的私信。"
    }
}

enum ConversationArchivePolicy {
    static func blockedReason(
        isStreaming: Bool,
        authoritativeStatus: SessionRunStatus?
    ) -> String? {
        guard isStreaming || authoritativeStatus?.isTerminal == false else { return nil }
        return "当前任务仍在运行，暂时不能归档。归档不会自动取消正在执行的任务，请等待任务结束后重试。"
    }
}

struct ConversationArchiveContext: Equatable, Sendable {
    let sessionId: String
    let organizationId: String
    let spaceId: String

    static func resolving(
        sessionId: String,
        authoritativeOrganizationId: String?,
        cachedOrganizationId: String?,
        fallbackOrganizationId: String,
        authoritativeSpaceId: String?,
        cachedSpaceId: String?,
        fallbackSpaceId: String
    ) -> ConversationArchiveContext? {
        guard let sessionId = nonEmpty(sessionId),
              let organizationId = firstNonEmpty(
                authoritativeOrganizationId,
                cachedOrganizationId,
                fallbackOrganizationId
              ),
              let spaceId = firstNonEmpty(
                authoritativeSpaceId,
                cachedSpaceId,
                fallbackSpaceId
              ) else { return nil }
        return ConversationArchiveContext(
            sessionId: sessionId,
            organizationId: organizationId,
            spaceId: spaceId
        )
    }

    func belongs(toSpace spaceId: String) -> Bool {
        guard let candidate = Self.nonEmpty(spaceId) else { return false }
        return self.spaceId == candidate
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        values.compactMap(nonEmpty).first
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }
}

extension Notification.Name {
    static let conversationSessionArchived = Notification.Name(
        "com.tabtin.mobile.conversation.sessionArchived"
    )
}

enum ConversationArchivePropagation {
    /// 仅在归档 PUT 已获成功响应后调用：推进目录内存、两类离线快照，
    /// 并通知仍存活的 Space 列表同步移除同一会话。
    @MainActor
    static func publishSucceeded(_ context: ConversationArchiveContext) {
        let recentSnapshot = RecentSessionsStore.shared.markArchived(
            sessionId: context.sessionId,
            organizationId: context.organizationId
        )
        SessionListCacheStore.shared.markArchived(
            sessionId: context.sessionId,
            organizationId: context.organizationId,
            spaceId: context.spaceId,
            recentSnapshot: recentSnapshot
        )
        NotificationCenter.default.post(
            name: .conversationSessionArchived,
            object: context
        )
    }

    static func context(from notification: Notification) -> ConversationArchiveContext? {
        notification.object as? ConversationArchiveContext
    }
}

struct ConversationMenuService {
    func loadShareRecipients(
        organizationId: String,
        currentUserId: String,
        search: String = ""
    ) async throws -> [OrganizationMember] {
        let response: OrganizationMemberListResponse = try await APIClient.shared.get(
            path: Endpoints.Context.organizationMembers(organizationId),
            query: ConversationSessionSharePolicy.memberSearchQuery(search)
        )
        return ConversationSessionSharePolicy.recipients(
            from: response.members,
            currentUserId: currentUserId
        )
    }

    func share(_ request: ConversationSessionShareRequest) async throws
        -> ConversationSessionShareResponse {
        try await APIClient.shared.post(
            path: Endpoints.IM.sessionShares,
            body: request.body
        )
    }

    func archive(sessionId: String) async throws -> ChatSession {
        try await APIClient.shared.put(
            path: Endpoints.Chat.session(sessionId),
            body: ["status": "archived"]
        )
    }
}

struct ConversationSessionShareSheet: View {
    let sessionId: String
    let organizationId: String

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var recipients: [OrganizationMember] = []
    @State private var searchedRecipients: [OrganizationMember] = []
    @State private var selectedUserId: String?
    @State private var selectedMode: ConversationSessionShareMode = .viewOnly
    @State private var searchText = ""
    @State private var isLoading = true
    @State private var isSearching = false
    @State private var isSubmitting = false
    @State private var loadError: String?
    @State private var searchError: String?
    @State private var submitError: String?
    @State private var completedResponse: ConversationSessionShareResponse?
    @State private var completedContinuation: IMSessionContinuationDetail?
    @State private var shareClientRequestId: String?

    private let service = ConversationMenuService()
    private let conversationService = IMConversationService()

    private var currentUserId: String? {
        AuthService.shared.currentUser?.id
    }

    private var filteredRecipients: [OrganizationMember] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return query.isEmpty ? recipients : searchedRecipients
    }

    private var selectedRecipient: OrganizationMember? {
        (recipients + searchedRecipients).first { $0.userId == selectedUserId }
    }

    private var memberSearchIdentity: ConversationSessionSharePolicy.MemberSearchIdentity {
        .init(organizationId: organizationId, rawQuery: searchText)
    }

    private var searchStatusAnnouncement: String? {
        if isSearching { return "正在搜索组织成员" }
        if let searchError { return searchError }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, searchedRecipients.isEmpty else { return nil }
        return ConversationSessionSharePolicy.emptyRecipientsMessage(search: query)
    }

    private var canSubmit: Bool {
        ConversationSessionSharePolicy.canSubmit(
            selectedUserId: selectedUserId,
            isSubmitting: isSubmitting,
            completedShareId: completedResponse?.id ?? completedContinuation?.objectId
        )
    }

    private var canEditSelection: Bool {
        ConversationSessionSharePolicy.canEditSelection(
            isSubmitting: isSubmitting,
            completedShareId: completedResponse?.id ?? completedContinuation?.objectId
        )
    }

    var body: some View {
        NavigationStack {
            Group {
                if let response = completedResponse {
                    successContent(response)
                } else if let continuation = completedContinuation {
                    continuationSuccessContent(continuation)
                } else {
                    shareForm
                }
            }
            .frame(maxWidth: horizontalSizeClass == .regular ? 560 : .infinity)
            .frame(maxWidth: .infinity)
            .background(.tt.bgCanvasDefault)
            .navigationTitle("共享会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(completedResponse == nil && completedContinuation == nil ? "取消" : "完成") {
                        dismiss()
                    }
                        .disabled(isSubmitting)
                }
            }
        }
        .presentationDetents(
            horizontalSizeClass == .regular ? [.large] : [.medium, .large]
        )
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isSubmitting)
        .task(id: organizationId) { await loadRecipients(organizationId: organizationId) }
        .task(id: memberSearchIdentity) {
            await searchRecipients(for: memberSearchIdentity)
        }
        .onChange(of: searchStatusAnnouncement) { _, announcement in
            guard let announcement else { return }
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
    }

    private var shareForm: some View {
        Form {
            Section {
                if isLoading {
                    HStack(spacing: TTSpacing.sm) {
                        ProgressView().controlSize(.small)
                        Text("正在加载组织成员…")
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textSecondary)
                    }
                    .frame(minHeight: 44)
                } else if let loadError {
                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        Text(loadError)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textCritical)
                        Button("重试") {
                            Task { await loadRecipients(organizationId: organizationId) }
                        }
                            .frame(minHeight: 44)
                    }
                } else {
                    HStack(spacing: TTSpacing.sm) {
                        Image(systemName: "magnifyingglass")
                            .foregroundStyle(.tt.textTertiary)
                        TextField("搜索组织成员", text: $searchText)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    .frame(minHeight: 44)
                    .disabled(!canEditSelection)

                    if isSearching {
                        HStack(spacing: TTSpacing.sm) {
                            ProgressView().controlSize(.small)
                            Text("正在搜索组织成员…")
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                        }
                        .frame(minHeight: 44)
                    } else if let searchError {
                        VStack(alignment: .leading, spacing: TTSpacing.sm) {
                            Text(searchError)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textCritical)
                            Button("重试") {
                                Task {
                                    await searchRecipients(
                                        for: memberSearchIdentity,
                                        debounce: false
                                    )
                                }
                            }
                            .frame(minHeight: 44)
                        }
                    } else if filteredRecipients.isEmpty {
                        Label(
                            ConversationSessionSharePolicy.emptyRecipientsMessage(search: searchText),
                            systemImage: "person.2.slash"
                        )
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .frame(minHeight: 44)
                    }
                    if !isSearching && searchError == nil {
                        ForEach(filteredRecipients) { member in
                            recipientRow(member)
                        }
                    }
                }
            } header: {
                Text("共享给")
            }

            Section {
                ForEach(ConversationSessionShareMode.allCases) { mode in
                    shareModeRow(mode)
                }
            } header: {
                Text("对方可以")
            } footer: {
                Text("实时查看和实时协作作用于原任务；任务续接只交付发送时冻结的上下文。")
            }

            Section {
                Button {
                    Task { await submitShare() }
                } label: {
                    HStack {
                        Spacer()
                        if isSubmitting {
                            ProgressView().controlSize(.small)
                        } else {
                            Label("发送共享卡", systemImage: "paperplane.fill")
                        }
                        Spacer()
                    }
                    .frame(minHeight: 44)
                }
                .disabled(!canSubmit)

                if let submitError {
                    Text(submitError)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private func recipientRow(_ member: OrganizationMember) -> some View {
        let isSelected = selectedUserId == member.userId
        return Button {
            selectedUserId = member.userId
            submitError = nil
            shareClientRequestId = nil
        } label: {
            HStack(spacing: TTSpacing.sm) {
                IdentityColorAvatar(
                    name: ConversationSessionSharePolicy.memberDisplayName(member),
                    seed: member.userId,
                    imageUrl: member.avatar,
                    size: 36
                )
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(ConversationSessionSharePolicy.memberDisplayName(member))
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    if let subtitle = ConversationSessionSharePolicy.recipientSubtitle(member) {
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
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .disabled(!canEditSelection)
        .accessibilityLabel(ConversationSessionSharePolicy.memberDisplayName(member))
        .accessibilityValue(isSelected ? "已选择" : "未选择")
    }

    private func shareModeRow(_ mode: ConversationSessionShareMode) -> some View {
        let isSelected = selectedMode == mode
        return Button {
            selectedMode = mode
            submitError = nil
            shareClientRequestId = nil
        } label: {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: mode.icon)
                    .foregroundStyle(.tt.iconAccent)
                    .frame(width: 24, height: 24)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(mode.title)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(mode.detail)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: TTSpacing.xs)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(isSelected ? .tt.iconAccent : .tt.textTertiary)
            }
            .padding(.vertical, TTSpacing.xs)
            .contentShape(Rectangle())
            .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .disabled(!canEditSelection)
        .accessibilityLabel("\(mode.title)，\(mode.detail)")
        .accessibilityValue(isSelected ? "已选择" : "未选择")
    }

    private func successContent(_ response: ConversationSessionShareResponse) -> some View {
        VStack(spacing: TTSpacing.lg) {
            Image(systemName: "checkmark.circle.fill")
                .font(.tt.iconEmptyHero)
                .foregroundStyle(.tt.textSuccess)
            Text("共享成功")
                .font(.tt.heading)
                .foregroundStyle(.tt.textPrimary)
            Text(
                ConversationSessionSharePolicy.destinationText(
                    recipientName: selectedRecipient?.displayName ?? "",
                    response: response
                )
            )
            .font(.tt.body)
            .foregroundStyle(.tt.textSecondary)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
            Text(response.canChat ? "权限：实时协作" : "权限：实时查看")
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
            Text("可前往「消息」查看这张共享卡。")
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
            Button("完成") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)
                .frame(minWidth: 160, minHeight: 44)
        }
        .padding(TTSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func continuationSuccessContent(_ continuation: IMSessionContinuationDetail) -> some View {
        VStack(spacing: TTSpacing.lg) {
            Image(systemName: "checkmark.circle.fill")
                .font(.tt.iconEmptyHero)
                .foregroundStyle(.tt.textSuccess)
            Text("转交成功")
                .font(.tt.heading)
                .foregroundStyle(.tt.textPrimary)
            Text("已把发送时冻结的任务上下文交给\(selectedRecipient?.displayName ?? "该成员")。")
                .font(.tt.body)
                .foregroundStyle(.tt.textSecondary)
                .multilineTextAlignment(.center)
            Text("冻结内容：\(continuation.snapshotTurnCount) 轮上下文")
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
            Text("对方创建的是独立新任务，不会获得你的原任务权限。")
                .font(.tt.meta)
                .foregroundStyle(.tt.textTertiary)
            Button("完成") { dismiss() }
                .buttonStyle(.borderedProminent)
                .tint(.tt.bgAccent)
                .frame(minWidth: 160, minHeight: 44)
        }
        .padding(TTSpacing.xl)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadRecipients(organizationId requestOrganizationId: String) async {
        guard let currentUserId, !currentUserId.isEmpty else {
            isLoading = false
            loadError = "无法确认当前用户，请重新登录后重试。"
            return
        }
        isLoading = true
        loadError = nil
        do {
            let result = try await service.loadShareRecipients(
                organizationId: requestOrganizationId,
                currentUserId: currentUserId
            )
            try Task.checkCancellation()
            guard requestOrganizationId == organizationId else { return }
            recipients = result
            if searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
               let selectedUserId {
                self.selectedUserId = ConversationSessionSharePolicy.retainedRecipientId(
                    selectedUserId,
                    in: recipients
                )
            }
        } catch {
            guard !error.isCancellation else { return }
            guard requestOrganizationId == organizationId else { return }
            loadError = error.localizedDescription
        }
        if requestOrganizationId == organizationId {
            isLoading = false
        }
    }

    private func searchRecipients(
        for request: ConversationSessionSharePolicy.MemberSearchIdentity,
        debounce: Bool = true
    ) async {
        let query = request.query
        guard !query.isEmpty, let currentUserId else {
            searchedRecipients = []
            selectedUserId = ConversationSessionSharePolicy.retainedRecipientId(
                selectedUserId,
                in: recipients
            )
            isSearching = false
            searchError = nil
            return
        }
        searchError = nil
        isSearching = true
        do {
            if debounce {
                try await Task.sleep(for: .milliseconds(250))
            }
            try Task.checkCancellation()
            let result = try await service.loadShareRecipients(
                organizationId: request.organizationId,
                currentUserId: currentUserId,
                search: query
            )
            try Task.checkCancellation()
            guard request == memberSearchIdentity else { return }
            searchedRecipients = result
            selectedUserId = ConversationSessionSharePolicy.retainedRecipientId(
                selectedUserId,
                in: result
            )
            searchError = nil
            isSearching = false
        } catch {
            guard let message = ConversationSessionSharePolicy.memberSearchErrorMessage(for: error) else { return }
            guard request == memberSearchIdentity else { return }
            searchedRecipients = []
            selectedUserId = nil
            searchError = message
            isSearching = false
        }
    }

    private func submitShare() async {
        guard canSubmit, let selectedUserId else { return }
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }
        do {
            let clientRequestId = shareClientRequestId ?? UUID().uuidString
            shareClientRequestId = clientRequestId
            let recipientName = selectedRecipient.map(
                ConversationSessionSharePolicy.memberDisplayName
            ) ?? "成员"
            let conversationId = try await resolveDirectMessageConversationId(
                conversations: IMConversationStore.shared.conversations,
                organizationId: organizationId,
                otherUserId: selectedUserId
            ) {
                try await conversationService.createOrGetDM(
                    organizationId: organizationId,
                    otherUserId: selectedUserId
                )
            }
            IMConversationStore.shared.rememberDirectMessage(
                conversationId: conversationId,
                organizationId: organizationId,
                otherUserId: selectedUserId,
                displayName: recipientName
            )
            if selectedMode.isContinuation {
                completedContinuation = try await conversationService.createSessionContinuation(
                    sourceSessionId: sessionId,
                    recipientUserId: selectedUserId,
                    conversationId: conversationId,
                    clientRequestId: clientRequestId
                )
            } else {
                completedResponse = try await service.share(
                    ConversationSessionShareRequest(
                        sessionId: sessionId,
                        granteeUserId: selectedUserId,
                        mode: selectedMode,
                        conversationId: conversationId,
                        clientRequestId: clientRequestId
                    )
                )
            }
        } catch {
            guard !error.isCancellation else { return }
            submitError = error.localizedDescription
        }
    }
}
