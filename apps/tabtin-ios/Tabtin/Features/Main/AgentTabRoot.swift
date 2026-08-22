import SwiftUI

/// Space tab 根：在不改底栏的前提下，以 Space / Project 分段承载个人执行现场与团队协作场景。
///
/// Space 是工作现场，Agent 是参与其中的 AI 身份，Device 是执行环境。三者在列表卡片
/// 中组合展示，但不互相等同。即使只有一个 Space 也保留列表层，让用户能看清这组关系。
///
/// 同时消费 MainRouter.pendingConversation：➕ 新建对话直达会话主屏（跳过会话列表）。
struct AgentTabRoot: View {
    @State private var store = WorkspaceStore.shared
    @State private var projectStore = ProjectStore.shared
    @State private var router = MainRouter.shared
    @State private var path = NavigationPath()
    @State private var searchQuery = ""
    @State private var selectedSection: WorkSection = .aiAvatar
    @State private var activeAgentSheet: MyAgentsSheet?
    @State private var selectedAgentForEdit: OrganizationAgent?
    @State private var agentsStore = MyAgentsStore.shared
    @State private var operationError: String?
    @State private var spaceToEdit: Space?
    @State private var spaceToDelete: Space?

    private var filteredSpaces: [Space] {
        let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return store.spaces }
        return store.spaces.filter { $0.name.localizedCaseInsensitiveContains(trimmed) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .background(.tt.bgCanvasDefault)
                .ttToolbarBackground()
                .navigationDestination(for: AgentRoute.self) { route in
                    switch route {
                    case .sessions(let spaceId):
                        if let space = store.spaces.first(where: { $0.id == spaceId }) {
                            spaceDetail(space)
                                .id(space.id)
                        } else {
                            ContentUnavailableView(L10n.SpaceList.notFound, systemImage: "square.stack.3d.up.slash")
                        }
                    }
                }
                .navigationDestination(for: ProjectRoute.self) { route in
                    if let project = projectStore.project(id: route.projectId) {
                        ProjectDetailScreen(
                            project: project,
                            onStartTask: { prompt, agentId, workspace in
                                path.append(ConversationTarget(
                                    title: project.name,
                                    workspaceId: workspace.id,
                                    organizationId: project.organizationId,
                                    // Project 不在入口选择 Agent；nil 交给草稿 Composer。
                                    agentId: agentId,
                                    projectId: project.id,
                                    startsNewSession: true,
                                    initialMessage: prompt
                                ))
                            },
                            onOpenIMConversation: { path.append($0) }
                        )
                        .id(project.id)
                    } else {
                        ContentUnavailableView(
                            L10n.Project.detailNotFound,
                            systemImage: "folder.badge.questionmark"
                        )
                    }
                }
                .navigationDestination(for: ConversationTarget.self) { target in
                    ConversationScreen(target: target, onBack: {
                        if !path.isEmpty { path.removeLast() }
                    }, onOpenConversation: { forkedTarget in
                        path.append(forkedTarget)
                    })
                }
                .navigationDestination(for: IMConversationTarget.self) { target in
                    IMConversationScreen(
                        conversationId: target.conversationId,
                        title: target.title,
                        onOpenConversation: { path.append($0) },
                        onOpenChatSession: { path.append($0) }
                    )
                }
        }
        .task { await reload() }
        .onChange(of: router.pendingConversation) { _, pending in
            consumePending(pending)
        }
        .onChange(of: store.selectedOrganizationId) { _, _ in
            path = NavigationPath()
        }
        .onAppear { consumePending(router.pendingConversation) }
        .sheet(item: $selectedAgentForEdit) { agent in
            NavigationStack {
                AgentEditSheet(agent: agent, store: agentsStore) { _ in
                    selectedAgentForEdit = nil
                }
            }
        }
        .sheet(item: $spaceToEdit) { space in
            EditSpaceSheet(space: space) { name, description in
                do {
                    _ = try await store.updateSpace(space.id, name: name, description: description)
                    return true
                } catch {
                    operationError = error.localizedDescription
                    return false
                }
            }
            .presentationDetents([.medium])
            .presentationDragIndicator(.visible)
        }
        .alert(
            L10n.Agent.delete,
            isPresented: Binding(
                get: { spaceToDelete != nil },
                set: { if !$0 { spaceToDelete = nil } }
            ),
            presenting: spaceToDelete
        ) { space in
            Button(L10n.Agent.delete, role: .destructive) {
                Task {
                    do {
                        try await store.deleteSpace(space.id)
                        path = NavigationPath()
                    } catch {
                        operationError = error.localizedDescription
                    }
                }
            }
            Button(L10n.Common.cancel, role: .cancel) {}
        } message: { space in
            Text(L10n.Agent.deleteConfirm(space.name))
        }
        .alert(L10n.Agent.operationFailed, isPresented: Binding(
            get: { operationError != nil },
            set: { if !$0 { operationError = nil } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { operationError = nil }
        } message: {
            Text(operationError ?? "")
        }
    }

    @ViewBuilder
    private var content: some View {
        VStack(spacing: 0) {
            Picker(L10n.Common.tabSpace, selection: $selectedSection) {
                ForEach(WorkSection.allCases) { section in
                    Text(section.title).tag(section)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, TTSpacing.md)
            .padding(.vertical, TTSpacing.sm)

            switch selectedSection {
            case .aiAvatar:
                MyAgentsListView(
                    searchQuery: searchQuery,
                    listHeader: nil,
                    activeSheet: $activeAgentSheet,
                    onOpenDetail: { selectedAgentForEdit = $0 }
                )
            case .workspace:
                spaceList
            case .project:
                ProjectListView(searchQuery: searchQuery, listHeader: nil) { project in
                    path.append(ProjectRoute(projectId: project.id))
                }
            }
        }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
            .ttRootNavigationTitle(L10n.Common.tabSpace)
            .searchable(
                text: $searchQuery,
                placement: .navigationBarDrawer(
                    displayMode: searchableItemCount > 1 ? .always : .automatic
                ),
                prompt: searchPlaceholder
            )
    }

    private var searchableItemCount: Int {
        switch selectedSection {
        case .aiAvatar: MyAgentsStore.shared.agents.count
        case .workspace: store.spaces.count
        case .project: projectStore.projects.count
        }
    }

    private var searchPlaceholder: String {
        switch selectedSection {
        case .aiAvatar: L10n.Project.myAgentsSearchPlaceholder
        case .workspace: L10n.SpaceList.searchPlaceholder
        case .project: L10n.Project.searchPlaceholder
        }
    }

    /// Space 会话列表，列表点入与「唯一 Space 直显」共用。
    private func spaceDetail(_ space: Space) -> some View {
        SpaceSessionsView(space: space, onOpen: { target in
            path.append(target)
        })
    }

    private var spaceList: some View {
        List {
            if (store.isLoadingSpaces || store.isLoadingOrganizations),
               store.spaces.isEmpty {
                placeholderRow {
                    ProgressView(L10n.Common.loading)
                        .frame(maxWidth: .infinity, minHeight: 360)
                }
            } else if let error = agentLoadError, store.spaces.isEmpty {
                placeholderRow {
                    errorState(error)
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else if store.spaces.isEmpty {
                placeholderRow {
                    emptyState
                        .frame(maxWidth: .infinity, minHeight: 420)
                }
            } else {
                ForEach(filteredSpaces) { space in
                    Button {
                        path.append(AgentRoute.sessions(spaceId: space.id))
                    } label: {
                        SpaceRow(
                            space: space,
                            agent: store.agent(for: space),
                            device: store.executionDevice(for: space),
                            isMetadataLoading: store.isLoadingSpaceMetadata
                        )
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
                    // 长按编辑/删除，操作对象始终是 Workspace。
                    .contextMenu {
                        Button {
                            spaceToEdit = space
                        } label: {
                            Label(L10n.Agent.edit, systemImage: "pencil")
                        }
                        Button(role: .destructive) {
                            spaceToDelete = space
                        } label: {
                            Label(L10n.Agent.delete, systemImage: "trash")
                        }
                    }
                }
                Text(L10n.SpaceList.creationBoundary)
                    .font(.tt.caption)
                    .foregroundStyle(.tt.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, TTSpacing.md)
                    .padding(.vertical, TTSpacing.sm)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .refreshable {
            await reload()
        }
    }

    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(L10n.SpaceList.emptyTitle, systemImage: "square.stack.3d.up.slash")
        } description: {
            Text(L10n.SpaceList.emptyDescription)
        }
    }

    private var agentLoadError: String? {
        store.selectedOrganizationId == nil ? store.errorMessage : store.spacesLoadError
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message) { Task { await reload() } }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, TTSpacing.xl)
    }

    private func reload() async {
        if store.selectedOrganizationId == nil {
            // 首次 Organization 加载失败时，Space 页必须能直接恢复完整工作区链路；
            // loadOrganizations 成功后会自动选择组织并加载 Spaces。
            await store.loadOrganizations()
            return
        }
        await store.loadSpaces()
    }

    /// 消费路由待办：直达目标会话并清空 pending（避免返回列表后被再次打开）。
    private func consumePending(_ pending: ConversationTarget?) {
        guard let pending else { return }
        path = NavigationPath()
        path.append(pending)
        router.pendingConversation = nil
    }

}

private enum AgentRoute: Hashable {
    case sessions(spaceId: String)
}

/// 工作 Tab 分段顺序对齐 Electron：AI分身 → Workspace → Project。
private enum WorkSection: String, CaseIterable, Identifiable {
    case aiAvatar
    case workspace
    case project

    var id: String { rawValue }
    var title: String {
        switch self {
        case .aiAvatar: L10n.Project.segmentAiAvatar
        case .workspace: L10n.Project.segmentSpace
        case .project: L10n.Project.segmentProject
        }
    }
}

struct SpaceRow: View {
    let space: Space
    let agent: AgentSummary?
    let device: RuntimeDevice?
    let isMetadataLoading: Bool

    var body: some View {
        HStack(alignment: .center, spacing: TTSpacing.md) {
            SpaceAvatar(name: space.name, imageURL: space.avatar.flatMap(URL.init(string:)), size: 44)
            VStack(alignment: .leading, spacing: TTSpacing.sm) {
                Text(space.name)
                    .font(.tt.bodySemibold)
                    .foregroundStyle(.tt.textPrimary)
                    .lineLimit(1)
                if !space.subtitle.isEmpty {
                    Text(space.subtitle)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(2)
                }
                VStack(alignment: .leading, spacing: TTSpacing.xs) {
                    metadataLine(
                        icon: "sparkles",
                        text: primaryAgentText,
                        color: .tt.iconAccent
                    )
                    metadataLine(
                        icon: "desktopcomputer",
                        text: executionDeviceText,
                        color: deviceStatusColor
                    )
                }
            }
            Spacer(minLength: TTSpacing.sm)
            Image(systemName: "chevron.right")
                .font(.tt.iconCaption)
                .foregroundStyle(.tt.iconSecondary)
                .frame(width: 14)
        }
        .padding(TTSpacing.md)
        .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                .strokeBorder(.tt.borderLight, lineWidth: 0.5)
        )
        .contentShape(RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous))
    }

    private func metadataLine(icon: String, text: String, color: Color) -> some View {
        HStack(spacing: TTSpacing.xs) {
            Image(systemName: icon)
                .font(.tt.iconCaption)
                .foregroundStyle(color)
                .frame(width: 14)
            Text(text)
                .font(.tt.meta)
                .foregroundStyle(.tt.textSecondary)
                .lineLimit(1)
        }
    }

    private var primaryAgentText: String {
        if let name = agent?.displayName {
            return L10n.SpaceList.primaryAgent(name)
        }
        if space.primaryAgentId == nil {
            return L10n.SpaceList.primaryAgentUnassigned
        }
        return isMetadataLoading
            ? L10n.SpaceList.primaryAgentLoading
            : L10n.SpaceList.primaryAgentUnavailable
    }

    private var executionDeviceText: String {
        if let device {
            let name = device.name?.trimmingCharacters(in: .whitespacesAndNewlines)
            let displayName = (name?.isEmpty == false) ? name! : L10n.SpaceList.unnamedDevice
            return L10n.SpaceList.executionDevice(displayName, deviceStatusText)
        }
        if space.executionDeviceId == nil {
            return L10n.SpaceList.executionDeviceUnbound
        }
        return isMetadataLoading
            ? L10n.SpaceList.executionDeviceLoading
            : L10n.SpaceList.executionDeviceUnavailable
    }

    private var deviceStatusText: String {
        switch device?.status?.lowercased() {
        case "online": return L10n.SpaceList.deviceOnline
        case "busy": return L10n.SpaceList.deviceBusy
        case "offline": return L10n.SpaceList.deviceOffline
        default: return L10n.SpaceList.deviceUnknown
        }
    }

    private var deviceStatusColor: Color {
        switch device?.status?.lowercased() {
        case "online": return .tt.bgSuccess
        case "busy": return .tt.bgWarning
        case "offline": return .tt.textTertiary
        default: return .tt.iconSecondary
        }
    }
}

struct SpaceAvatar: View {
    let name: String
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
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var placeholder: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(.tt.bgAccent.opacity(0.14))
            Text(String(name.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1)).uppercased())
                .font(.tt.bodySemibold)
                .foregroundStyle(.tt.iconAccent)
        }
    }
}

/// 长按「编辑」弹出的 Space 名称/描述编辑表单。
private struct EditSpaceSheet: View {
    let space: Space
    /// 返回 true 表示保存成功，sheet 自行关闭；false 由 caller 弹错误。
    let onSave: (_ name: String, _ description: String) async -> Bool

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var descriptionText: String
    @State private var isSaving = false

    init(space: Space, onSave: @escaping (_ name: String, _ description: String) async -> Bool) {
        self.space = space
        self.onSave = onSave
        _name = State(initialValue: space.name)
        _descriptionText = State(initialValue: space.description ?? "")
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField(L10n.SpaceList.editNamePlaceholder, text: $name)
                TextField(L10n.SpaceList.editDescriptionPlaceholder, text: $descriptionText, axis: .vertical)
                    .lineLimit(3...6)
            }
            .navigationTitle(L10n.SpaceList.editTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button(L10n.Common.cancel) { dismiss() }
                        .disabled(isSaving)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        Task {
                            isSaving = true
                            defer { isSaving = false }
                            if await onSave(
                                name.trimmingCharacters(in: .whitespacesAndNewlines),
                                descriptionText.trimmingCharacters(in: .whitespacesAndNewlines)
                            ) {
                                dismiss()
                            }
                        }
                    } label: {
                        if isSaving {
                            ProgressView().controlSize(.small)
                        } else {
                            Text(L10n.Common.save)
                        }
                    }
                    .disabled(isSaving || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}
