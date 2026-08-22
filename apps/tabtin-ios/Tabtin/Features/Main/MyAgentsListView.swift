import SwiftUI

struct AgentAvatarView: View {
    let agent: OrganizationAgent
    let size: CGFloat

    var body: some View {
        if let preset = agent.avatarPreset {
            Image(preset.imageName)
                .resizable()
                .scaledToFill()
                .frame(width: size, height: size)
                .clipShape(Circle())
                .accessibilityHidden(true)
        } else {
            AgentIdentityFallbackAvatar(imageURL: agent.avatarURL, size: size)
        }
    }
}

private struct DeactivatedAgentAvatarView: View {
    let agent: DeactivatedOrganizationAgent

    var body: some View {
        if let preset = agent.avatarPreset {
            Image(preset.imageName)
                .resizable()
                .scaledToFill()
                .frame(width: 40, height: 40)
                .clipShape(Circle())
                .accessibilityHidden(true)
        } else {
            AgentIdentityFallbackAvatar(imageURL: agent.avatarURL, size: 40)
        }
    }
}

/// AI 分身头像：预设头像优先；没有预设时尝试自定义 URL，加载失败或缺失则统一回退 TabTin 品牌图标。
/// 不复用 SpaceAvatar，避免 AI 分身在历史数据缺少头像字段时退回名称首字母。
private struct AgentIdentityFallbackAvatar: View {
    let imageURL: URL?
    let size: CGFloat

    var body: some View {
        Group {
            if let imageURL {
                AsyncImage(url: imageURL) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        brandIcon
                    }
                }
            } else {
                brandIcon
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: size * 0.25, style: .continuous))
        .accessibilityHidden(true)
    }

    private var brandIcon: some View {
        Image("LoginBrandIcon")
            .resizable()
            .scaledToFill()
    }
}

struct AgentAvatarPresetPicker: View {
    @Binding var selection: AgentAvatarPreset

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: TTSpacing.sm), count: 4), spacing: TTSpacing.sm) {
            ForEach(AgentAvatarPreset.allCases) { preset in
                Button {
                    selection = preset
                } label: {
                    Image(preset.imageName)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 48, height: 48)
                        .clipShape(Circle())
                        .overlay {
                            Circle().strokeBorder(selection == preset ? Color.tt.bgAccent : .clear, lineWidth: 3)
                        }
                        .overlay(alignment: .bottomTrailing) {
                            if selection == preset {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.tt.iconAccent)
                                    .background(Circle().fill(.tt.bgCanvasDefault))
                            }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel(preset.label)
                .accessibilityValue(selection == preset ? "已选" : "")
            }
        }
    }
}

/// 工作 Tab「AI分身」：手机端可完成云端身份配置；本地执行现场仍留在 Workspace。
struct MyAgentsListView: View {
    let searchQuery: String
    let listHeader: AnyView?
    @Binding var activeSheet: MyAgentsSheet?
    let onOpenDetail: (OrganizationAgent) -> Void

    @State private var store = MyAgentsStore.shared
    @State private var workspace = WorkspaceStore.shared
    @State private var actionErrorMessage: String?
    @State private var permanentlyDeletingAgent: DeactivatedOrganizationAgent?

    private var filteredAgents: [OrganizationAgent] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return store.agents }
        return store.agents.filter {
            $0.displayName.localizedCaseInsensitiveContains(query)
                || ($0.customRules?.localizedCaseInsensitiveContains(query) == true)
        }
    }

    private var filteredDeactivatedAgents: [DeactivatedOrganizationAgent] {
        let query = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return store.deactivatedAgents }
        return store.deactivatedAgents.filter {
            $0.name.localizedCaseInsensitiveContains(query)
        }
    }

    private var hasVisibleAgents: Bool {
        !filteredAgents.isEmpty || !filteredDeactivatedAgents.isEmpty
    }

    var body: some View {
        List {
            if let listHeader {
                listHeader
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }

            if store.isLoading && store.agents.isEmpty && store.deactivatedAgents.isEmpty {
                placeholderRow {
                    ProgressView(L10n.Common.loading)
                        .frame(maxWidth: .infinity, minHeight: 320)
                }
            } else if let error = store.loadError, store.agents.isEmpty && store.deactivatedAgents.isEmpty {
                placeholderRow {
                    ContentUnavailableView {
                        Label(L10n.Project.myAgentsLoadFailed, systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(error)
                    } actions: {
                        Button(L10n.Common.retry) {
                            Task { await store.load(organizationId: workspace.selectedOrganizationId) }
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 380)
                }
            } else if !hasVisibleAgents {
                placeholderRow {
                    ContentUnavailableView {
                        Label(L10n.Project.myAgentsEmptyTitle, systemImage: "person.crop.circle.badge.plus")
                    } description: {
                        Text(L10n.Project.myAgentsEmptyDescription)
                    } actions: {
                        Button(L10n.Project.myAgentsCreate) { activeSheet = .create }
                    }
                    .frame(maxWidth: .infinity, minHeight: 380)
                }
            } else {
                ForEach(filteredAgents) { agent in
                    Button { onOpenDetail(agent) } label: {
                        MyAgentRow(agent: agent)
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
                if !filteredDeactivatedAgents.isEmpty {
                    Text(L10n.Project.myAgentsDeactivatedTitle)
                        .font(.tt.captionSemibold)
                        .foregroundStyle(.tt.textSecondary)
                        .padding(.top, TTSpacing.md)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)

                    ForEach(filteredDeactivatedAgents) { agent in
                        DeactivatedAgentRow(
                            agent: agent,
                            isReactivating: store.reactivatingAgentIds.contains(agent.id),
                            isMutating: store.isMutating,
                            onReactivate: { await reactivate(agent) },
                            onPermanentDelete: { permanentlyDeletingAgent = agent }
                        )
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
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .refreshable { await store.load(organizationId: workspace.selectedOrganizationId) }
        .task(id: workspace.selectedOrganizationId) {
            await store.load(organizationId: workspace.selectedOrganizationId)
        }
        .sheet(item: $activeSheet) { sheet in
            switch sheet {
            case .create:
                NavigationStack {
                    AgentCreateSheet(
                        store: store,
                        organizationId: workspace.selectedOrganizationId,
                        onCreated: { created in
                            activeSheet = nil
                            onOpenDetail(created)
                        }
                    )
                }
            }
        }
        .alert(
            L10n.Project.myAgentsActionFailed,
            isPresented: Binding(
                get: { actionErrorMessage != nil },
                set: { if !$0 { actionErrorMessage = nil } }
            )
        ) {
            Button(L10n.Common.confirm, role: .cancel) { actionErrorMessage = nil }
        } message: {
            Text(actionErrorMessage ?? "")
        }
        .alert(
            L10n.Project.myAgentsPermanentDeleteTitle,
            isPresented: Binding(
                get: { permanentlyDeletingAgent != nil },
                set: { if !$0 { permanentlyDeletingAgent = nil } }
            ),
            presenting: permanentlyDeletingAgent
        ) { agent in
            Button(L10n.Project.myAgentsPermanentDelete, role: .destructive) {
                Task { await permanentlyDelete(agent) }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: { agent in
            Text(L10n.Project.myAgentsPermanentDeleteBody(agent.name))
        }
    }

    @ViewBuilder
    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private func reactivate(_ agent: DeactivatedOrganizationAgent) async {
        do {
            try await store.reactivate(agentId: agent.id)
        } catch {
            guard !error.isCancellation else { return }
            actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    private func permanentlyDelete(_ agent: DeactivatedOrganizationAgent) async {
        do {
            try await store.permanentlyDelete(agentId: agent.id)
            permanentlyDeletingAgent = nil
        } catch {
            guard !error.isCancellation else { return }
            actionErrorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }
}

enum MyAgentsSheet: Identifiable {
    case create

    var id: String {
        switch self {
        case .create: "create"
        }
    }
}

private struct MyAgentRow: View {
    let agent: OrganizationAgent

    private var displayTime: String? {
        RelativeTime.format(agent.updatedAt ?? agent.createdAt ?? "")
    }

    var body: some View {
        HStack(alignment: .center, spacing: TTSpacing.md) {
            AgentAvatarView(agent: agent, size: 44)
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(agent.displayName)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let displayTime {
                        Text(displayTime)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(1)
                    }
                }
            }
            Image(systemName: "chevron.right")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.textTertiary)
        }
        .padding(.vertical, TTSpacing.sm)
        .contentShape(Rectangle())
    }
}

private struct DeactivatedAgentRow: View {
    let agent: DeactivatedOrganizationAgent
    let isReactivating: Bool
    let isMutating: Bool
    let onReactivate: () async -> Void
    let onPermanentDelete: () -> Void

    private var status: String {
        if let deactivatedAt = agent.deactivatedAt,
           let time = RelativeTime.format(deactivatedAt) {
            return L10n.Project.myAgentsDeactivatedAt(time)
        }
        return L10n.Project.myAgentsDeactivatedStatus
    }

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            DeactivatedAgentAvatarView(agent: agent)
            VStack(alignment: .leading, spacing: TTSpacing.xs) {
                Text(agent.name)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                Text(status)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textSecondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            Button {
                Task { await onReactivate() }
            } label: {
                if isReactivating {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: "arrow.counterclockwise")
                }
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(L10n.Project.myAgentsReactivate)
            .disabled(isReactivating || isMutating)
            Button(role: .destructive, action: onPermanentDelete) {
                Image(systemName: "trash")
            }
            .buttonStyle(.bordered)
            .accessibilityLabel(L10n.Project.myAgentsPermanentDelete)
            .disabled(isReactivating || isMutating)
        }
        .padding(.vertical, TTSpacing.sm)
        .contentShape(Rectangle())
    }
}

struct AgentEditSheet: View {
    @Environment(\.dismiss) private var dismiss
    let agent: OrganizationAgent
    @Bindable var store: MyAgentsStore
    let onSaved: (OrganizationAgent) -> Void

    @State private var name: String
    @State private var rules: String
    @State private var avatarPreset: AgentAvatarPreset
    @State private var errorMessage: String?

    init(agent: OrganizationAgent, store: MyAgentsStore, onSaved: @escaping (OrganizationAgent) -> Void) {
        self.agent = agent
        self.store = store
        self.onSaved = onSaved
        _name = State(initialValue: agent.displayName)
        _rules = State(initialValue: agent.customRules ?? "")
        _avatarPreset = State(initialValue: agent.avatarPreset ?? .generalAssistant)
    }

    var body: some View {
        Form {
            Section(L10n.Project.myAgentsName) {
                TextField(L10n.Project.myAgentsName, text: $name)
            }
            Section {
                AgentAvatarPresetPicker(selection: $avatarPreset)
            } header: {
                Text("头像")
            } footer: {
                Text("从 TabTin 预置头像中选择。")
            }
            Section {
                TextField(L10n.Project.myAgentsPersonaPlaceholder, text: $rules, axis: .vertical)
                    .lineLimit(6...16)
            } header: {
                Text(L10n.Project.myAgentsPersonaRules)
            } footer: {
                Text(L10n.Project.myAgentsPersonaScopeHint)
            }
            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
            }
        }
        .ttFormStyle()
        .navigationTitle(L10n.Project.myAgentsEdit)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.cancel) { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(L10n.Common.save) { Task { await save() } }
                    .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isMutating)
            }
        }
        .ttLoading(store.isMutating)
    }

    private func save() async {
        do {
            let updated = try await store.update(
                agentId: agent.id,
                name: name,
                customRules: rules,
                avatarPreset: avatarPreset
            )
            onSaved(updated)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct AgentCreateSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var store: MyAgentsStore
    let organizationId: String?
    let onCreated: (OrganizationAgent) -> Void

    @State private var name = ""
    @State private var selectedTemplateId: String?
    @State private var avatarPreset: AgentAvatarPreset = .generalAssistant
    @State private var errorMessage: String?

    private var ownerName: String {
        let user = AuthService.shared.currentUser
        return user?.nickname?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? user?.username?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
            ?? "我"
    }

    var body: some View {
        Form {
            Section {
                TextField(L10n.Project.myAgentsName, text: $name)
            } header: {
                Text(L10n.Project.myAgentsName)
            }

            Section {
                AgentAvatarPresetPicker(selection: $avatarPreset)
            } header: {
                Text("头像")
            } footer: {
                Text("从 TabTin 预置头像中选择。")
            }

            Section(L10n.Project.myAgentsTemplate) {
                templateRow(
                    id: nil,
                    title: L10n.Project.myAgentsBlank,
                    subtitle: L10n.Project.myAgentsBlankHint
                )
                if store.isLoadingTemplates && store.templates.isEmpty {
                    ProgressView().frame(maxWidth: .infinity)
                } else if let templateLoadError = store.templateLoadError, store.templates.isEmpty {
                    VStack(alignment: .leading, spacing: TTSpacing.sm) {
                        Text(templateLoadError)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textCritical)
                        Button(L10n.Common.retry) { Task { await store.loadTemplates() } }
                    }
                } else {
                    ForEach(store.templates) { template in
                        templateRow(
                            id: template.id,
                            title: template.displayName(ownerName: ownerName),
                            subtitle: template.tagline ?? ""
                        )
                    }
                }
            }

            if let errorMessage {
                Section { Text(errorMessage).foregroundStyle(.tt.textCritical) }
            }
        }
        .ttFormStyle()
        .navigationTitle(L10n.Project.myAgentsCreate)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button(L10n.Common.cancel) { dismiss() }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button(L10n.Project.myAgentsCreateAction) { Task { await create() } }
                    .disabled(
                        organizationId == nil
                            || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            || store.isMutating
                    )
            }
        }
        .ttLoading(store.isMutating)
        .task { await store.loadTemplates() }
    }

    private func templateRow(id: String?, title: String, subtitle: String) -> some View {
        Button {
            selectedTemplateId = id
            if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, id != nil {
                name = title
            }
        } label: {
            HStack(alignment: .top, spacing: TTSpacing.md) {
                Image(systemName: selectedTemplateId == id ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(selectedTemplateId == id ? .tt.iconAccent : .tt.iconSecondary)
                VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                    Text(title).foregroundStyle(.tt.textPrimary)
                    if !subtitle.isEmpty {
                        Text(subtitle)
                            .font(.tt.meta)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func create() async {
        guard let organizationId else { return }
        do {
            let created = try await store.create(
                organizationId: organizationId,
                name: name,
                templateId: selectedTemplateId,
                avatarPreset: avatarPreset
            )
            onCreated(created)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
