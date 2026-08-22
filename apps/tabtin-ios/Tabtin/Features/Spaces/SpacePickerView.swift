import SwiftUI

/// Space 列表（Phase 1「最小可登录」终点）：选中 organization 的 spaces，点选进入。
/// 多 organization 时顶部菜单可切换。会话工作台、各 App 入口随 Phase 2+ 落地。
struct SpacePickerView: View {
    @State var store = WorkspaceStore.shared
    let onSelect: (Space) -> Void

    var body: some View {
        NavigationStack {
            Group {
                if store.isLoadingSpaces && store.spaces.isEmpty {
                    ProgressView(L10n.Workspace.loadingSpace)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.spaces.isEmpty {
                    emptyView
                } else {
                    spaceList
                }
            }
            .navigationTitle(L10n.Workspace.selectSpace)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if store.organizations.count > 1 {
                    ToolbarItem(placement: .topBarLeading) { organizationMenu }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button(L10n.Profile.logout, role: .destructive) { AuthService.shared.logout() }
                }
            }
        }
        .task {
            // 仅兜底「从未尝试过加载」的极端情况；正常路径由 WorkspaceFlowView 统一发起。
            // 用 didAttemptOrganizationLoad 而非 organizations.isEmpty 作判据，否则空团队时会与
            // 加载标志翻转互相触发，造成主界面无限重挂。
            if !store.didAttemptOrganizationLoad { await store.loadOrganizations() }
        }
        .refreshable { await store.loadSpaces() }
    }

    private var spaceList: some View {
        List {
            if let wt = store.selectedOrganization {
                Section {
                    ForEach(store.spaces) { space in
                        Button { onSelect(space) } label: { spaceRow(space) }
                            .buttonStyle(.plain)
                    }
                } header: {
                    Text(wt.name)
                }
            }
        }
        .listStyle(.insetGrouped)
    }

    private func spaceRow(_ space: Space) -> some View {
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 9)
                    .fill(.tint.opacity(0.15))
                    .frame(width: 38, height: 38)
                Text(String(space.name.prefix(1)))
                    .font(.tt.subtitleSemibold)
                    .foregroundStyle(.tint)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(space.name).font(.tt.bodyMedium)
                if !space.subtitle.isEmpty {
                    Text(space.subtitle).font(.tt.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer()
            Image(systemName: "chevron.right").font(.tt.iconCaption).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }

    private var organizationMenu: some View {
        Menu {
            ForEach(store.organizations) { wt in
                Button {
                    Task { await store.selectOrganization(wt) }
                } label: {
                    Label(wt.name, systemImage: wt.id == store.selectedOrganizationId ? "checkmark" : "person.2")
                }
            }
        } label: {
            HStack(spacing: 4) {
                Text(store.selectedOrganization?.name ?? L10n.Workspace.team).lineLimit(1)
                Image(systemName: "chevron.down").font(.tt.iconCaption)
            }
        }
    }

    private var emptyView: some View {
        ContentUnavailableView {
            Label(L10n.Workspace.noSpaces, systemImage: "square.stack.3d.up.slash")
        } description: {
            Text(L10n.Workspace.noSpacesDesc)
        } actions: {
            Button(L10n.Workspace.refresh) { Task { await store.loadSpaces() } }
        }
    }
}
