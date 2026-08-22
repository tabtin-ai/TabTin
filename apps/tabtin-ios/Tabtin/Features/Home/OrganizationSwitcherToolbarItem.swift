import SwiftUI

/// 组织切换器（对齐 Electron `TopBarOrganizationSwitcher`）。
/// 任务页顶栏已改为固定「任务」标题；组织切换只留账户侧栏。
/// 组件保留供其它入口复用。
struct OrganizationSwitcherToolbarItem: View {
    @State private var workspace = WorkspaceStore.shared

    private var displayLabel: String {
        if let organization = workspace.selectedOrganization {
            return organization.switcherLabel
        }
        if workspace.isLoadingOrganizations {
            return L10n.Home.loading
        }
        return L10n.Workspace.team
    }

    var body: some View {
        Group {
            if workspace.organizations.isEmpty {
                labelContent(showsChevron: false)
            } else {
                Menu {
                    Section(L10n.Workspace.switchOrganization) {
                        ForEach(workspace.organizations) { organization in
                            Button {
                                Task { await workspace.selectOrganization(organization) }
                            } label: {
                                if organization.id == workspace.selectedOrganizationId {
                                    Label(organization.switcherLabel, systemImage: "checkmark")
                                } else {
                                    Text(organization.switcherLabel)
                                }
                            }
                        }
                    }
                } label: {
                    labelContent(showsChevron: workspace.organizations.count > 1)
                }
            }
        }
        .accessibilityLabel(L10n.Workspace.switchOrganization)
        .accessibilityValue(displayLabel)
        .task {
            if !workspace.didAttemptOrganizationLoad {
                await workspace.loadOrganizations()
            }
        }
    }

    private func labelContent(showsChevron: Bool) -> some View {
        HStack(spacing: TTSpacing.xxs) {
            Text(displayLabel)
                .font(.tt.subtitleSemibold)
                .foregroundStyle(.tt.textPrimary)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.down")
                    .font(.tt.iconCaptionMedium)
                    .foregroundStyle(.tt.textSecondary)
            }
        }
        .padding(.horizontal, TTSpacing.sm)
        .padding(.vertical, TTSpacing.xxs)
        .frame(maxWidth: 220)
        .background(
            RoundedRectangle(cornerRadius: TTRadius.interactive, style: .continuous)
                .fill(Color.tt.bgSubtleSecondary.opacity(0.9))
        )
    }
}
