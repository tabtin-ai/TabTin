import SwiftUI

/// TabFiles 协作者管理（对齐 CloudDocs 协作者段；**无公开链接**）。
struct TabFilesCollaboratorsSheet: View {
    let fileRecordId: String
    let resourceTitle: String
    let canManage: Bool

    @Environment(\.dismiss) private var dismiss
    @State private var workspace = WorkspaceStore.shared

    @State private var owner: TabFilesShareService.OwnerBrief?
    @State private var collaborators: [CloudDocsCollaborator] = []
    @State private var collaboratorQuery = ""
    @State private var isLoading = true
    @State private var isBusy = false
    @State private var errorMessage: String?
    @State private var pendingRemoval: CloudDocsCollaborator?
    @State private var loadFailed = false

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if loadFailed {
                    ContentUnavailableView(
                        L10n.CloudDrive.collaboratorsUnavailable,
                        systemImage: "person.crop.circle.badge.exclamationmark",
                        description: Text(errorMessage ?? L10n.CloudDrive.collaboratorsGap)
                    )
                } else {
                    List {
                        Section {
                            Text(L10n.CloudDrive.collaboratorsNoPublicLink)
                                .font(.tt.meta)
                                .foregroundStyle(.tt.textSecondary)
                        }

                        if let owner {
                            Section(L10n.CloudDrive.owner) {
                                Text(owner.nickname.isEmpty ? owner.email : owner.nickname)
                            }
                        }

                        if canManage {
                            inviteSection
                        }

                        Section(L10n.CloudDrive.collaborators) {
                            if collaborators.isEmpty {
                                Text(L10n.CloudDrive.noCollaborators)
                                    .foregroundStyle(.tt.textTertiary)
                            } else {
                                ForEach(collaborators) { collaborator in
                                    collaboratorRow(collaborator)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(L10n.CloudDrive.manageCollaborators)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(L10n.Common.cancel) { dismiss() }
                }
            }
            .task { await reload() }
            .alert(
                L10n.CloudDrive.operationFailed,
                isPresented: Binding(
                    get: { errorMessage != nil && !loadFailed },
                    set: { if !$0 { errorMessage = nil } }
                )
            ) {
                Button(L10n.Common.confirm, role: .cancel) { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "")
            }
            .confirmationDialog(
                L10n.CloudDrive.removeCollaboratorTitle,
                isPresented: Binding(
                    get: { pendingRemoval != nil },
                    set: { if !$0 { pendingRemoval = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button(L10n.CloudDrive.removeCollaborator, role: .destructive) {
                    guard let pendingRemoval else { return }
                    Task { await revoke(pendingRemoval.userId) }
                }
                Button(L10n.Common.cancel, role: .cancel) { pendingRemoval = nil }
            }
        }
    }

    private var inviteSection: some View {
        Section(L10n.CloudDrive.inviteCollaborator) {
            TextField(L10n.CloudDrive.searchMembers, text: $collaboratorQuery)
            ForEach(filteredMembers, id: \.userId) { member in
                HStack {
                    Text(member.displayName)
                    Spacer()
                    Menu {
                        Button(L10n.CloudDrive.permissionViewer) {
                            Task { await invite(member.userId, permission: "viewer") }
                        }
                        Button(L10n.CloudDrive.permissionEditor) {
                            Task { await invite(member.userId, permission: "editor") }
                        }
                    } label: {
                        Text(L10n.CloudDrive.invite)
                            .foregroundStyle(.tt.textAccent)
                    }
                    .disabled(isBusy)
                }
            }
        }
    }

    private var filteredMembers: [OrganizationMember] {
        let currentUserId = AuthService.shared.currentUser?.id
        return workspace.members.filter { member in
            member.userId != currentUserId
                && member.userId != owner?.userId
                && !collaborators.contains(where: { $0.userId == member.userId })
                && (collaboratorQuery.isEmpty
                    || member.displayName.localizedCaseInsensitiveContains(collaboratorQuery))
        }
    }

    @ViewBuilder
    private func collaboratorRow(_ collaborator: CloudDocsCollaborator) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(collaborator.nickname.isEmpty ? collaborator.email : collaborator.nickname)
                Text(collaborator.permission)
                    .font(.tt.captionMedium)
                    .foregroundStyle(.tt.textTertiary)
            }
            Spacer()
            if canManage {
                Menu {
                    Button(L10n.CloudDrive.permissionViewer) {
                        Task { await update(collaborator.userId, permission: "viewer") }
                    }
                    Button(L10n.CloudDrive.permissionEditor) {
                        Task { await update(collaborator.userId, permission: "editor") }
                    }
                    Button(L10n.CloudDrive.removeCollaborator, role: .destructive) {
                        pendingRemoval = collaborator
                    }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .disabled(isBusy)
            }
        }
    }

    @MainActor
    private func reload() async {
        isLoading = true
        loadFailed = false
        defer { isLoading = false }
        do {
            let list = try await TabFilesShareService.shared.list(fileRecordId: fileRecordId)
            owner = list.owner
            collaborators = list.collaborators
        } catch {
            loadFailed = true
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    @MainActor
    private func invite(_ userId: String, permission: String) async {
        await mutate {
            try await TabFilesShareService.shared.invite(
                fileRecordId: fileRecordId,
                userId: userId,
                permission: permission
            )
        }
    }

    @MainActor
    private func update(_ userId: String, permission: String) async {
        await mutate {
            try await TabFilesShareService.shared.update(
                fileRecordId: fileRecordId,
                userId: userId,
                permission: permission
            )
        }
    }

    @MainActor
    private func revoke(_ userId: String) async {
        await mutate {
            try await TabFilesShareService.shared.revoke(
                fileRecordId: fileRecordId,
                userId: userId
            )
        }
    }

    @MainActor
    private func mutate(_ work: () async throws -> Void) async {
        isBusy = true
        defer { isBusy = false }
        do {
            try await work()
            await reload()
        } catch {
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}
