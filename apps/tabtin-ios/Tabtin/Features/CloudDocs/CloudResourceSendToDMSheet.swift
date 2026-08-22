import SwiftUI
import UIKit

struct CloudResourceDMSendTarget: Equatable, Sendable {
    let resourceType: CloudShareResourceType
    let resourceId: String
    let title: String
    let organizationId: String
    let spaceId: String?
    let currentUserRole: String?

    var outgoingCard: IMOutgoingCard {
        IMOutgoingCard.resource(
            kind: resourceType == .document ? .document : .table,
            resourceId: resourceId,
            name: displayTitle,
            spaceId: spaceId,
            organizationId: organizationId
        )
    }

    var displayTitle: String {
        let normalized = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            return resourceType == .document
                ? L10n.CloudDocs.untitled
                : L10n.TabData.untitledTable
        }
        return normalized
    }
}

enum CloudResourceDMSendPolicy {
    static func canGrantViewer(currentUserRole: String?) -> Bool {
        switch currentUserRole?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() {
        case "owner", "admin": true
        default: false
        }
    }

    static func recipientHasAccess(
        _ recipientUserId: String,
        snapshot: CloudDocsCollaboratorList
    ) -> Bool {
        snapshot.owner?.userId == recipientUserId
            || snapshot.collaborators.contains { $0.userId == recipientUserId }
    }

    static func clientRequestId(
        reusing existing: String?,
        generate: () -> String = { UUID().uuidString }
    ) -> String {
        if let existing, !existing.isEmpty { return existing }
        return generate()
    }

    static func retainedClientRequestId(
        _ existing: String?,
        previousRecipientUserId: String?,
        selectedRecipientUserId: String
    ) -> String? {
        previousRecipientUserId == selectedRecipientUserId ? existing : nil
    }

    static func shouldDismiss(after outcome: IMSendOutcome) -> Bool {
        switch outcome {
        case .enqueued, .succeeded:
            true
        default:
            false
        }
    }

    static func errorMessage(for outcome: IMSendOutcome) -> String? {
        switch outcome {
        case .enqueued, .succeeded:
            nil
        case .failedPending:
            L10n.CloudDocs.directMessageSendFailed
        case .discardedAfterClear:
            L10n.CloudDocs.directMessageSendUnconfirmed
        case .rejectedInFlight:
            L10n.CloudDocs.directMessageSendInFlight
        case .rejectedTooLong:
            L10n.CloudDocs.directMessageTitleTooLong
        case .rejectedReadOnly:
            L10n.CloudDocs.directMessageReadOnly
        }
    }
}

private enum CloudResourceDMSendError: LocalizedError {
    case directMessageUnavailable
    case accessGrantFailed
    case messagingUnavailable

    var errorDescription: String? {
        switch self {
        case .directMessageUnavailable:
            L10n.CloudDocs.directMessageConversationUnavailable
        case .accessGrantFailed:
            L10n.CloudDocs.directMessageAccessGrantFailed
        case .messagingUnavailable:
            L10n.CloudDocs.directMessageMessagingUnavailable
        }
    }
}

@MainActor
private struct CloudResourceDMSendService {
    private let conversationService: any IMConversationServing

    init(conversationService: any IMConversationServing = IMConversationService()) {
        self.conversationService = conversationService
    }

    func send(
        target: CloudResourceDMSendTarget,
        recipientUserId: String,
        recipientDisplayName: String,
        clientRequestId: String,
        isRetry: Bool
    ) async throws -> IMSendOutcome {
        let conversationId: String
        do {
            conversationId = try await resolveDirectMessageConversationId(
                conversations: IMConversationStore.shared.conversations,
                organizationId: target.organizationId,
                otherUserId: recipientUserId
            ) {
                try await conversationService.createOrGetDM(
                    organizationId: target.organizationId,
                    otherUserId: recipientUserId
                )
            }
        } catch {
            guard !error.isCancellation else { throw error }
            throw CloudResourceDMSendError.directMessageUnavailable
        }

        IMConversationStore.shared.rememberDirectMessage(
            conversationId: conversationId,
            organizationId: target.organizationId,
            otherUserId: recipientUserId,
            displayName: recipientDisplayName
        )

        if CloudResourceDMSendPolicy.canGrantViewer(
            currentUserRole: target.currentUserRole
        ) {
            do {
                let snapshot = try await CloudDocsShareService.shared.collaborationSnapshot(
                    type: target.resourceType,
                    resourceId: target.resourceId
                )
                if !CloudResourceDMSendPolicy.recipientHasAccess(
                    recipientUserId,
                    snapshot: snapshot
                ) {
                    try await CloudDocsShareService.shared.invite(
                        type: target.resourceType,
                        resourceId: target.resourceId,
                        userId: recipientUserId,
                        permission: "viewer"
                    )
                }
            } catch {
                guard !error.isCancellation else { throw error }
                throw CloudResourceDMSendError.accessGrantFailed
            }
        }

        let messageStore = IMMessageStore(conversationId: conversationId)
        messageStore.currentUserId = AuthService.shared.currentUser?.id
        let card = target.outgoingCard
        return await messageStore.performSend(
            content: card.fallbackContent,
            card: card,
            clientRequestId: clientRequestId,
            isRetry: isRetry
        )
    }
}

struct CloudResourceSendToDMSheet: View {
    let target: CloudResourceDMSendTarget

    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var recipients: [OrganizationMember] = []
    @State private var searchedRecipients: [OrganizationMember] = []
    @State private var selectedUserId: String?
    @State private var searchText = ""
    @State private var isLoading = true
    @State private var isSearching = false
    @State private var isSubmitting = false
    @State private var loadError: String?
    @State private var searchError: String?
    @State private var submitError: String?
    @State private var sendClientRequestId: String?

    private let memberService = ConversationMenuService()
    private let sendService = CloudResourceDMSendService()

    private var currentUserId: String? {
        AuthService.shared.currentUser?.id
    }

    private var filteredRecipients: [OrganizationMember] {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? recipients
            : searchedRecipients
    }

    private var selectedRecipient: OrganizationMember? {
        (recipients + searchedRecipients).first { $0.userId == selectedUserId }
    }

    private var memberSearchIdentity: ConversationSessionSharePolicy.MemberSearchIdentity {
        .init(organizationId: target.organizationId, rawQuery: searchText)
    }

    private var searchStatusAnnouncement: String? {
        if isSearching { return L10n.CloudDocs.directMessageSearching }
        if let searchError { return searchError }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, searchedRecipients.isEmpty else { return nil }
        return emptyRecipientsMessage(search: query)
    }

    private var canSubmit: Bool {
        !isSubmitting && selectedUserId?.isEmpty == false
    }

    var body: some View {
        NavigationStack {
            Form {
                recipientSection
                sendSection
            }
            .scrollContentBackground(.hidden)
            .frame(maxWidth: horizontalSizeClass == .regular ? 560 : .infinity)
            .frame(maxWidth: .infinity)
            .background(.tt.bgCanvasDefault)
            .navigationTitle(L10n.CloudDocs.directMessageTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                        .disabled(isSubmitting)
                }
            }
        }
        .presentationDetents(
            horizontalSizeClass == .regular ? [.large] : [.medium, .large]
        )
        .presentationDragIndicator(.visible)
        .interactiveDismissDisabled(isSubmitting)
        .task(id: target.organizationId) {
            await loadRecipients(organizationId: target.organizationId)
        }
        .task(id: memberSearchIdentity) {
            await searchRecipients(for: memberSearchIdentity)
        }
        .onChange(of: searchStatusAnnouncement) { _, announcement in
            guard let announcement else { return }
            UIAccessibility.post(notification: .announcement, argument: announcement)
        }
    }

    private var recipientSection: some View {
        Section {
            if isLoading {
                statusRow(L10n.CloudDocs.directMessageLoadingMembers)
            } else if let loadError {
                VStack(alignment: .leading, spacing: TTSpacing.sm) {
                    errorText(loadError)
                    Button(L10n.Common.retry) {
                        Task { await loadRecipients(organizationId: target.organizationId) }
                    }
                    .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                }
            } else {
                HStack(spacing: TTSpacing.sm) {
                    Image(systemName: "magnifyingglass")
                        .font(.tt.iconBody)
                        .foregroundStyle(.tt.textTertiary)
                    TextField(L10n.CloudDocs.directMessageSearchPlaceholder, text: $searchText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                .disabled(isSubmitting)

                if isSearching {
                    statusRow(L10n.CloudDocs.directMessageSearching)
                } else if let searchError {
                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        errorText(searchError)
                        Button(L10n.Common.retry) {
                            Task {
                                await searchRecipients(
                                    for: memberSearchIdentity,
                                    debounce: false
                                )
                            }
                        }
                        .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                    }
                } else if filteredRecipients.isEmpty {
                    Label(
                        emptyRecipientsMessage(search: searchText),
                        systemImage: "person.2.slash"
                    )
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
                }

                if !isSearching && searchError == nil {
                    ForEach(filteredRecipients) { member in
                        recipientRow(member)
                    }
                }
            }
        } header: {
            Text(L10n.CloudDocs.directMessageSection)
        } footer: {
            Text(L10n.CloudDocs.directMessageFooter)
        }
    }

    private var sendSection: some View {
        Section {
            Button {
                Task { await submit() }
            } label: {
                HStack {
                    Spacer()
                    if isSubmitting {
                        ProgressView().controlSize(.small)
                    } else {
                        Label(L10n.CloudDocs.directMessageSendAction, systemImage: "paperplane.fill")
                    }
                    Spacer()
                }
                .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
            }
            .disabled(!canSubmit)

            if let submitError {
                errorText(submitError)
            }
        }
    }

    private func statusRow(_ text: String) -> some View {
        HStack(spacing: TTSpacing.sm) {
            ProgressView().controlSize(.small)
            Text(text)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
        }
        .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
    }

    private func errorText(_ text: String) -> some View {
        Text(text)
            .font(.tt.meta)
            .foregroundStyle(.tt.textCritical)
    }

    private func recipientRow(_ member: OrganizationMember) -> some View {
        let isSelected = selectedUserId == member.userId
        return Button {
            sendClientRequestId = CloudResourceDMSendPolicy.retainedClientRequestId(
                sendClientRequestId,
                previousRecipientUserId: selectedUserId,
                selectedRecipientUserId: member.userId
            )
            selectedUserId = member.userId
            submitError = nil
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
                    .font(.tt.iconBody)
                    .foregroundStyle(isSelected ? .tt.iconAccent : .tt.textTertiary)
            }
            .contentShape(Rectangle())
            .frame(minHeight: TTSpacing.Control.minimumTouchTarget)
        }
        .buttonStyle(.plain)
        .disabled(isSubmitting)
        .accessibilityLabel(ConversationSessionSharePolicy.memberDisplayName(member))
        .accessibilityValue(
            isSelected
                ? L10n.CloudDocs.directMessageSelected
                : L10n.CloudDocs.directMessageUnselected
        )
    }

    private func loadRecipients(organizationId requestOrganizationId: String) async {
        guard let currentUserId, !currentUserId.isEmpty else {
            isLoading = false
            loadError = L10n.CloudDocs.directMessageCannotIdentifyUser
            return
        }
        isLoading = true
        loadError = nil
        do {
            let result = try await memberService.loadShareRecipients(
                organizationId: requestOrganizationId,
                currentUserId: currentUserId
            )
            try Task.checkCancellation()
            guard requestOrganizationId == target.organizationId else { return }
            recipients = result
            selectedUserId = ConversationSessionSharePolicy.retainedRecipientId(
                selectedUserId,
                in: recipients
            )
        } catch {
            guard !error.isCancellation else { return }
            guard requestOrganizationId == target.organizationId else { return }
            loadError = L10n.CloudDocs.directMessageLoadFailed
        }
        if requestOrganizationId == target.organizationId {
            isLoading = false
        }
    }

    private func searchRecipients(
        for request: ConversationSessionSharePolicy.MemberSearchIdentity,
        debounce: Bool = true
    ) async {
        guard !request.query.isEmpty, let currentUserId else {
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
            if debounce { try await Task.sleep(for: .milliseconds(250)) }
            try Task.checkCancellation()
            let result = try await memberService.loadShareRecipients(
                organizationId: request.organizationId,
                currentUserId: currentUserId,
                search: request.query
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
            guard !error.isCancellation else { return }
            guard request == memberSearchIdentity else { return }
            searchedRecipients = []
            selectedUserId = nil
            searchError = L10n.CloudDocs.directMessageSearchFailed
            isSearching = false
        }
    }

    private func submit() async {
        guard canSubmit, let selectedUserId else { return }
        let wasRetry = sendClientRequestId != nil
        let clientRequestId = CloudResourceDMSendPolicy.clientRequestId(
            reusing: sendClientRequestId
        )
        sendClientRequestId = clientRequestId
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }

        do {
            let outcome = try await sendService.send(
                target: target,
                recipientUserId: selectedUserId,
                recipientDisplayName: selectedRecipient.map(
                    ConversationSessionSharePolicy.memberDisplayName
                ) ?? L10n.CloudDocs.directMessageMemberFallback,
                clientRequestId: clientRequestId,
                isRetry: wasRetry
            )
            if CloudResourceDMSendPolicy.shouldDismiss(after: outcome) {
                dismiss()
            } else {
                submitError = CloudResourceDMSendPolicy.errorMessage(for: outcome)
            }
        } catch {
            guard !error.isCancellation else { return }
            submitError = error.localizedDescription
        }
    }

    private func emptyRecipientsMessage(search: String) -> String {
        search.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? L10n.CloudDocs.directMessageNoMembers
            : L10n.CloudDocs.directMessageNoSearchResults
    }
}
