import SwiftUI

/// Space tab 内的 Project 分段。列表和邀请均为云端只读协作入口。
struct ProjectListView: View {
    let searchQuery: String
    let listHeader: AnyView?
    let onOpen: (Project) -> Void

    @State private var store = ProjectStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var desktopInvitation: PendingProjectInvitation?

    private var filteredProjects: [Project] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return store.projects }
        return store.projects.filter {
            $0.name.localizedCaseInsensitiveContains(query)
                || ($0.description?.localizedCaseInsensitiveContains(query) == true)
        }
    }

    var body: some View {
        List {
            if let listHeader {
                listHeader
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }

            if store.pendingInvitations.isEmpty, let error = store.invitationLoadError {
                Section {
                    invitationErrorRow(error)
                        .listRowBackground(Color.clear)
                }
            }

            if !store.pendingInvitations.isEmpty {
                Section(L10n.Project.invitations) {
                    ForEach(store.pendingInvitations) { invitation in
                        ProjectInvitationRow(invitation: invitation) {
                            desktopInvitation = invitation
                        }
                        .listRowBackground(Color.clear)
                    }
                }
            }

            if store.isLoading && store.projects.isEmpty {
                placeholderRow {
                    ProgressView(L10n.Common.loading)
                        .frame(maxWidth: .infinity, minHeight: 320)
                }
            } else if let error = store.loadError, store.projects.isEmpty {
                placeholderRow {
                    errorState(error)
                        .frame(maxWidth: .infinity, minHeight: 380)
                }
            } else if filteredProjects.isEmpty {
                placeholderRow {
                    ContentUnavailableView {
                        Label(L10n.Project.emptyTitle, systemImage: "folder.badge.person.crop")
                    } description: {
                        Text(L10n.Project.emptyDescription)
                    }
                    .frame(maxWidth: .infinity, minHeight: 380)
                }
            } else {
                ForEach(filteredProjects) { project in
                    Button { onOpen(project) } label: {
                        ProjectListCard(project: project)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets(
                        top: TTSpacing.xs,
                        leading: TTSpacing.md,
                        bottom: TTSpacing.xs,
                        trailing: TTSpacing.md
                    ))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .contentMargins(.top, 0, for: .scrollContent)
        .scrollDismissesKeyboard(.interactively)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .refreshable { await store.load(organizationId: workspace.selectedOrganizationId) }
        .alert(
            L10n.Project.desktopAcceptTitle,
            isPresented: Binding(
                get: { desktopInvitation != nil },
                set: { if !$0 { desktopInvitation = nil } }
            ),
            presenting: desktopInvitation
        ) { _ in
            Button(L10n.Common.confirm, role: .cancel) { desktopInvitation = nil }
        } message: { _ in
            Text(L10n.Project.desktopAcceptBody)
        }
    }

    private func invitationErrorRow(_ message: String) -> some View {
        HStack(alignment: .top, spacing: TTSpacing.sm) {
            Image(systemName: "exclamationmark.triangle")
                .foregroundStyle(.tt.textWarning)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                Text(L10n.Project.invitationLoadError)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                Text(message)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .lineLimit(2)
            }
            Spacer(minLength: 0)
            Button(L10n.Common.retry) {
                Task { await store.load(organizationId: workspace.selectedOrganizationId) }
            }
            .font(.tt.caption)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgWarning.opacity(0.10), in: RoundedRectangle(cornerRadius: TTRadius.sm))
    }

    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message) {
            Task { await store.load(organizationId: workspace.selectedOrganizationId) }
        }
        .padding(.horizontal, TTSpacing.xl)
    }
}

/// Project 邀请的正式卡片。手机端不接受邀请，只解释为什么需要前往电脑端。
struct ProjectInvitationRow: View {
    let invitation: PendingProjectInvitation
    let onDesktopAccept: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: TTSpacing.sm) {
            HStack(alignment: .top, spacing: TTSpacing.sm) {
                Image(systemName: "envelope.badge.person.crop")
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(.tt.iconAccent)
                    .frame(width: 28, height: 28)
                    .background(.tt.bgAccent.opacity(0.12), in: RoundedRectangle(cornerRadius: TTRadius.sm))
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(invitation.projectName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                    Text(L10n.Project.invitedBy(invitation.inviterName, role: roleTitle(invitation.role)))
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                }
                Spacer(minLength: 0)
            }

            // TODO: 后端将“加入 Project”与“供给本地执行 Space”解耦后，
            // 手机端在这里直接接受成员关系；当前必须保持邀请 pending，不能伪造设备/目录。
            Button(L10n.Project.desktopAccept) {
                onDesktopAccept()
            }
            .font(.tt.meta)
            .buttonStyle(.bordered)
            .tint(.tt.bgAccent)
        }
        .padding(.vertical, TTSpacing.xs)
    }

    private func roleTitle(_ role: String) -> String {
        OrganizationRole(rawValue: role)?.title ?? role.capitalized
    }
}

struct ProjectListCard: View {
    let project: Project

    var body: some View {
        HStack(alignment: .top, spacing: TTSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                    .fill(.tt.bgAccent.opacity(0.12))
                Image(systemName: "folder.badge.person.crop")
                    .font(.tt.iconFeatureSemibold)
                    .foregroundStyle(.tt.iconAccent)
            }
            .frame(width: 44, height: 44)

            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                Text(project.name)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)

                Text(project.displayDescription ?? L10n.Project.fallbackDescription)
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(2)

                HStack(spacing: TTSpacing.sm) {
                    Label(
                        L10n.Project.memberCount(project.memberCount ?? 1),
                        systemImage: "person.2"
                    )
                    if let time = project.displayTime {
                        Label(time, systemImage: "clock")
                    }
                }
                .font(.tt.caption)
                .foregroundStyle(.tt.textSecondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconSecondary)
                .padding(.top, TTSpacing.xs)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
    }
}
