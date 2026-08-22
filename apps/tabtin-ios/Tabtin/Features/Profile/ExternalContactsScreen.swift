import SwiftUI

struct ExternalContactsScreen: View {
    let organization: Organization

    @State private var contacts: [ExternalContact] = []
    @State private var invitations: [ExternalContactInvitation] = []
    @State private var phone = ""
    @State private var candidate: ExternalContactCandidate?
    @State private var isLoading = false
    @State private var isMutating = false
    @State private var errorMessage: String?
    @State private var workspace = WorkspaceStore.shared

    var body: some View {
        List {
            Section {
                Text("添加其他组织的联系人，建立跨组织私信。外部群聊会沿用同一套权限和消息能力。")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                HStack(spacing: TTSpacing.sm) {
                    TextField("手机号", text: $phone)
                        .keyboardType(.phonePad)
                        .textFieldStyle(.roundedBorder)
                    Button("查找并添加") {
                        Task { await discoverAndInvite() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(phone.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isMutating)
                }
                if let candidate {
                    candidateRow(candidate)
                }
            }

            if !invitations.isEmpty {
                Section("待处理邀请") {
                    ForEach(invitations) { invitation in
                        invitationRow(invitation)
                    }
                }
            }

            Section("外部联系人") {
                if isLoading && contacts.isEmpty {
                    ProgressView().frame(maxWidth: .infinity)
                } else if contacts.isEmpty {
                    Text("还没有外部联系人")
                        .foregroundStyle(.tt.textTertiary)
                } else {
                    ForEach(contacts) { contact in
                        contactRow(contact)
                    }
                }
            }

            if let errorMessage {
                Section {
                    Label(errorMessage, systemImage: "exclamationmark.triangle")
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textCritical)
                }
            }
        }
        .ttSettingsDetailListStyle()
        .navigationTitle("外部联系人")
        .navigationBarTitleDisplayMode(.inline)
        .ttToolbarBackground()
        .ttTabBarHidden(true)
        .ttLoading(isLoading || isMutating)
        .task { await reload() }
        .refreshable { await reload() }
    }

    private func candidateRow(_ candidate: ExternalContactCandidate) -> some View {
        HStack(spacing: TTSpacing.md) {
            ExternalContactAvatar(name: candidate.displayName, imageURL: URL(string: candidate.avatarURL))
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(candidate.displayName.isEmpty ? candidate.userId : candidate.displayName)
                    .font(.tt.bodySemibold)
                Text(candidate.relationship == "pending" ? "邀请已发送" : candidate.relationship)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer()
        }
    }

    private func contactRow(_ contact: ExternalContact) -> some View {
        HStack(spacing: TTSpacing.md) {
            ExternalContactAvatar(name: contact.displayName, imageURL: URL(string: contact.avatarURL))
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(contact.displayName.isEmpty ? contact.peerUserId : contact.displayName)
                    .font(.tt.bodySemibold)
                if !contact.peerOrganizationName.isEmpty {
                    Text(contact.peerOrganizationName)
                        .font(.tt.meta)
                        .foregroundStyle(.tt.textTertiary)
                }
            }
            Spacer()
            Button("发消息") {
                Task { await openConversation(contact) }
            }
            .buttonStyle(.bordered)
            Menu {
                Button("移除联系人", role: .destructive) {
                    Task { await remove(contact) }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
                    .foregroundStyle(.tt.iconSecondary)
            }
        }
        .padding(.vertical, TTSpacing.xs)
    }

    private func invitationRow(_ invitation: ExternalContactInvitation) -> some View {
        HStack(spacing: TTSpacing.md) {
            ExternalContactAvatar(name: invitation.displayName, imageURL: URL(string: invitation.avatarURL))
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(invitation.displayName.isEmpty ? invitation.peerUserId : invitation.displayName)
                    .font(.tt.bodySemibold)
                Text(invitation.peerOrganizationName ?? "跨组织联系人邀请")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer()
            Button("接受") { Task { await resolve(invitation, action: "accept") } }
                .buttonStyle(.borderedProminent)
                .disabled(isMutating)
            Button("拒绝", role: .destructive) { Task { await resolve(invitation, action: "reject") } }
                .disabled(isMutating)
        }
    }

    private func reload() async {
        isLoading = true
        errorMessage = nil
        do {
            async let loadedContacts = ExternalContactService.shared.list(organizationId: organization.id)
            async let loadedInvitations = ExternalContactService.shared.listInvitations(organizationId: organization.id)
            contacts = (try await loadedContacts).filter { $0.relationship == "friend" }
            invitations = try await loadedInvitations
        } catch {
            errorMessage = error.localizedDescription
        }
        isLoading = false
    }

    private func discoverAndInvite() async {
        let normalizedPhone = phone.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPhone.isEmpty, !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let discovered = try await ExternalContactService.shared.discover(
                organizationId: organization.id,
                phone: normalizedPhone
            )
            if discovered.relationship == "none" || discovered.relationship == "removed" {
                _ = try await ExternalContactService.shared.invite(
                    organizationId: organization.id,
                    targetUserId: discovered.userId
                )
                candidate = ExternalContactCandidate(
                    userId: discovered.userId,
                    displayName: discovered.displayName,
                    avatarURL: discovered.avatarURL,
                    relationship: "pending",
                    externalContactId: discovered.externalContactId,
                    pendingInvitationId: discovered.pendingInvitationId
                )
            } else {
                candidate = discovered
            }
            await reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resolve(_ invitation: ExternalContactInvitation, action: String) async {
        guard !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            if action == "accept" {
                let destinationId = organization.id != invitation.peerOrganizationId
                    ? organization.id
                    : workspace.organizations.first(where: { $0.id != invitation.peerOrganizationId })?.id
                guard let destinationId else {
                    throw APIError.apiError("没有可用于建立联系的组织")
                }
                _ = try await ExternalContactService.shared.accept(
                    organizationId: destinationId,
                    invitationId: invitation.invitationId
                )
            } else {
                try await ExternalContactService.shared.updateInvitation(
                    invitationId: invitation.invitationId,
                    action: action,
                    organizationId: organization.id
                )
            }
            await reload()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func remove(_ contact: ExternalContact) async {
        guard !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            try await ExternalContactService.shared.updateContact(
                contactId: contact.contactId,
                action: "remove",
                organizationId: organization.id
            )
            contacts.removeAll { $0.id == contact.id }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func openConversation(_ contact: ExternalContact) async {
        guard !isMutating else { return }
        isMutating = true
        errorMessage = nil
        defer { isMutating = false }
        do {
            let conversationId = try await IMConversationService().createOrGetExternalDM(
                organizationId: organization.id,
                externalContactId: contact.contactId
            )
            IMConversationStore.shared.rememberExternalDirectMessage(
                conversationId: conversationId,
                organizationId: organization.id,
                peerUserId: contact.peerUserId,
                displayName: contact.displayName
            )
            MainRouter.shared.openIMConversation(IMConversationTarget(
                conversationId: conversationId,
                title: contact.displayName.isEmpty ? "外部联系人" : contact.displayName
            ))
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ExternalContactAvatar: View {
    let name: String
    let imageURL: URL?

    var body: some View {
        Group {
            if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    default: placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: 40, height: 40)
        .clipShape(Circle())
    }

    private var placeholder: some View {
        ZStack {
            Circle().fill(.tt.bgAccent.opacity(0.14))
            Text(IdentityAvatar.initials(name))
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.textAccent)
        }
    }
}
