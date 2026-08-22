import SwiftUI

enum IMAgentPickerMode: Sendable, Equatable {
    case mention
    case addOnly
}

/// 与桌面端一致：普通群里的真人成员可以把自己的 Agent 加入会话，外部群 / 项目频道禁止。
enum IMGroupAgentMembershipPolicy {
    static func canAddAgent(
        to detail: IMConversationDetail,
        currentUserId: String?,
        catalogIsExternal: Bool? = nil
    ) -> Bool {
        guard detail.conversationType == .group,
              !detail.isExternal,
              !detail.isTeamSpaceChannel,
              catalogIsExternal != true,
              let currentUserId,
              !currentUserId.isEmpty else {
            return false
        }
        return detail.members.contains { member in
            member.typedMemberType == .user
                && member.userId == currentUserId
        }
    }
}

/// @Agent 选择器：会话内 Agent 可直接 @；其他 Agent 必须先选择执行现场并建立 binding。
@MainActor
@Observable
final class AgentMentionPickerModel {
    private(set) var agents: [IMAgentSummary] = []
    private(set) var isLoading = false
    /// 搜索/加载失败提示（列表为空时以 ContentUnavailableView 呈现）。
    private(set) var errorMessage: String?
    /// 选择未派驻 Agent 时的明确边界提示，与搜索加载错误分开呈现。
    private(set) var pickError: String?
    private(set) var addingAgentId: String?
    private(set) var agentBindings: [String: IMConversationAgentBinding] = [:]
    private(set) var isLoadingBindings = false
    let conversationId: String
    let organizationId: String
    /// 已在会话内的 Agent，即当前允许 @ 的派驻成员。
    private(set) var memberAgentIds: Set<String>
    private let service: IMConversationServing

    init(
        conversationId: String,
        organizationId: String,
        existingAgentIds: Set<String>,
        service: IMConversationServing = IMConversationService()
    ) {
        self.conversationId = conversationId
        self.organizationId = organizationId
        self.memberAgentIds = existingAgentIds
        self.service = service
    }

    func load(query: String = "") async {
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            agents = try await service.searchAgents(organizationId: organizationId, query: query)
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func isMember(_ agent: IMAgentSummary) -> Bool { memberAgentIds.contains(agent.id) }

    func binding(for agent: IMAgentSummary) -> IMConversationAgentBinding? {
        agentBindings[agent.id]
    }

    func canMentionDirectly(_ agent: IMAgentSummary) -> Bool {
        memberAgentIds.contains(agent.id) && agentBindings[agent.id]?.isExecutable == true
    }

    func loadBindings() async {
        guard !isLoadingBindings else { return }
        isLoadingBindings = true
        defer { isLoadingBindings = false }
        do {
            let bindings = try await service.listAgentBindings(conversationId: conversationId)
            agentBindings = Dictionary(uniqueKeysWithValues: bindings.map { ($0.agentId, $0) })
        } catch is CancellationError {
            return
        } catch {
            // 绑定状态未知时保持保守：已有成员也必须重新选执行现场，由写接口权威校验。
            agentBindings = [:]
        }
    }

    func agents(for mode: IMAgentPickerMode) -> [IMAgentSummary] {
        switch mode {
        case .mention:
            return agents
        case .addOnly:
            return agents.filter { !memberAgentIds.contains($0.id) }
        }
    }

    func clearPickError() { pickError = nil }

    /// 选中 Agent：只有绑定仍可执行时才能直接 @；缺失/失效则补绑或换绑。
    func pick(_ agent: IMAgentSummary, workspaceId: String? = nil) async -> Bool {
        if canMentionDirectly(agent) { return true }
        guard let workspaceId, !workspaceId.isEmpty else {
            pickError = "请先选择执行现场"
            return false
        }
        guard addingAgentId == nil else { return false }
        addingAgentId = agent.id
        pickError = nil
        defer { addingAgentId = nil }
        do {
            let binding: IMConversationAgentBinding
            if let existingBinding = agentBindings[agent.id] {
                guard existingBinding.canRebind else {
                    pickError = "你没有权限更换此 Agent 的执行现场"
                    return false
                }
                binding = try await service.updateAgentBinding(
                    conversationId: conversationId,
                    agentId: agent.id,
                    workspaceId: workspaceId
                )
            } else {
                binding = try await service.bindAgent(
                    conversationId: conversationId,
                    agentId: agent.id,
                    workspaceId: workspaceId
                )
            }
            agentBindings[agent.id] = binding
            memberAgentIds.insert(agent.id)
            return true
        } catch is CancellationError {
            return false
        } catch {
            pickError = error.localizedDescription
            return false
        }
    }
}

struct AgentMentionPickerView: View {
    @State private var model: AgentMentionPickerModel
    @State private var workspace = WorkspaceStore.shared
    @State private var query = ""
    @State private var pendingAgent: IMAgentSummary?
    private let mode: IMAgentPickerMode
    private let onPick: (IMAgentSummary) async -> Void
    @Environment(\.dismiss) private var dismiss

    init(
        conversationId: String,
        organizationId: String,
        existingAgentIds: Set<String>,
        service: IMConversationServing = IMConversationService(),
        mode: IMAgentPickerMode = .mention,
        onPick: @escaping (IMAgentSummary) async -> Void
    ) {
        _model = State(
            initialValue: AgentMentionPickerModel(
                conversationId: conversationId,
                organizationId: organizationId,
                existingAgentIds: existingAgentIds,
                service: service
            )
        )
        self.mode = mode
        self.onPick = onPick
    }

    var body: some View {
        NavigationStack {
            Group {
                if let pendingAgent {
                    workspaceContent(for: pendingAgent)
                } else {
                    content.searchable(text: $query, prompt: "搜索 Agent")
                }
            }
                .navigationTitle(
                    pendingAgent == nil
                        ? (mode == .mention ? "@ Agent" : "添加 AI Agent")
                        : "选择执行现场"
                )
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(pendingAgent == nil ? "取消" : "返回") {
                            if pendingAgent == nil { dismiss() } else { pendingAgent = nil }
                        }
                    }
                }
                .task(id: query) { await model.load(query: query) }
                .task {
                    async let spacesLoad: Void = workspace.loadSpaces()
                    async let bindingsLoad: Void = model.loadBindings()
                    _ = await (spacesLoad, bindingsLoad)
                }
                .alert(
                    mode == .mention ? "暂时无法 @ 此 Agent" : "暂时无法添加此 Agent",
                    isPresented: Binding(
                        get: { model.pickError != nil },
                        set: { if !$0 { model.clearPickError() } }
                    )
                ) {
                    Button("好", role: .cancel) {}
                } message: {
                    Text(model.pickError ?? "")
                }
        }
    }

    private var selectableWorkspaces: [Space] {
        workspace.spaces.filter {
            $0.organizationId == model.organizationId
                && $0.isExecutionSpace
                && $0.isArchived != true
                && $0.executionDeviceId != nil
        }
    }

    @ViewBuilder
    private func workspaceContent(for agent: IMAgentSummary) -> some View {
        if workspace.isLoadingSpaces && selectableWorkspaces.isEmpty {
            ProgressView("正在加载执行现场…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if selectableWorkspaces.isEmpty {
            ContentUnavailableView {
                Label("没有可用执行现场", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text(workspace.spacesLoadError ?? "请先在桌面端创建并信任一个绑定执行设备的 Workspace。")
            } actions: {
                Button("重新加载") { Task { await workspace.loadSpaces() } }
            }
        } else {
            List(selectableWorkspaces) { item in
                Button {
                    Task {
                        if await model.pick(agent, workspaceId: item.id) {
                            await onPick(agent)
                            dismiss()
                        }
                    }
                } label: {
                    HStack(spacing: 12) {
                        Image(systemName: "folder")
                            .foregroundStyle(.tt.textAccent)
                            .frame(width: 32, height: 32)
                            .background(.tt.bgSubtle, in: RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.name).font(.tt.body).foregroundStyle(.tt.textPrimary)
                            Text("用于 \(agent.displayName) 执行群聊中的任务")
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textSecondary)
                        }
                        Spacer()
                        if model.addingAgentId == agent.id {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "chevron.right")
                                .font(.tt.iconCaption)
                                .foregroundStyle(.tt.textSecondary)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(model.addingAgentId != nil)
            }
            .listStyle(.plain)
        }
    }

    @ViewBuilder
    private var content: some View {
        let visibleAgents = model.agents(for: mode)
        if model.isLoading && model.agents.isEmpty {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = model.errorMessage, model.agents.isEmpty {
            ContentUnavailableView {
                Label("加载失败", systemImage: "exclamationmark.triangle")
            } description: {
                Text(error)
            } actions: {
                Button("重试") { Task { await model.load(query: query) } }
            }
        } else if visibleAgents.isEmpty {
            ContentUnavailableView(
                mode == .mention ? "没有可 @ 的 Agent" : "没有可添加的 Agent",
                systemImage: "sparkles",
                description: Text(
                    mode == .addOnly && !model.agents.isEmpty
                        ? "当前可用的 Agent 都已在群聊中"
                        : "当前组织下你还没有可用的 Agent"
                )
            )
        } else {
            List(visibleAgents) { agent in
                agentRow(agent)
            }
            .listStyle(.plain)
        }
    }

    private func agentRow(_ agent: IMAgentSummary) -> some View {
        Button {
            if model.canMentionDirectly(agent) {
                Task {
                    if await model.pick(agent) {
                        await onPick(agent)
                        dismiss()
                    }
                }
            } else {
                pendingAgent = agent
            }
        } label: {
            HStack(spacing: 12) {
                Image(systemName: "sparkles")
                    .font(.tt.iconSubtitle)
                    .foregroundStyle(.tt.bgAccent)
                    .frame(width: 32, height: 32)
                    .background(.tt.bgSubtle, in: Circle())
                VStack(alignment: .leading, spacing: 2) {
                    Text(agent.displayName).font(.tt.body).foregroundStyle(.tt.textPrimary)
                    if model.canMentionDirectly(agent) {
                        let workspaceName = model.binding(for: agent)?.workspaceName ?? ""
                        Text(workspaceName.isEmpty ? "已绑定执行现场" : workspaceName)
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                    } else if model.isMember(agent) {
                        Text("执行现场缺失或已失效，选择后修复")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textCritical)
                    } else {
                        Text(mode == .mention ? "选择执行现场后加入并 @" : "选择执行现场后加入群聊")
                            .font(.tt.captionMedium)
                            .foregroundStyle(.tt.textSecondary)
                    }
                }
                Spacer()
                if model.addingAgentId == agent.id {
                    ProgressView().controlSize(.small)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(model.addingAgentId != nil)
        .accessibilityLabel(
            mode == .mention
                ? "@ \(agent.displayName)"
                : "添加 \(agent.displayName) 到群聊"
        )
    }
}
