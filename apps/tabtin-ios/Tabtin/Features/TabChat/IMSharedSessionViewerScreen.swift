import SwiftUI
import UIKit

enum SharedSessionExecutionTargetPolicy {
    static func agents(
        from agents: [OrganizationAgent],
        organizationId: String
    ) -> [OrganizationAgent] {
        agents.filter {
            $0.isActive != false
                && ($0.organizationId == nil || $0.organizationId == organizationId)
        }
    }

    static func workspaces(from spaces: [Space], organizationId: String) -> [Space] {
        spaces.filter {
            $0.isExecutionSpace
                && $0.organizationId == organizationId
                && $0.isArchived != true
        }
    }

    static func defaultAgent(in agents: [OrganizationAgent]) -> OrganizationAgent? {
        agents.first(where: { $0.isDefault == true }) ?? agents.first
    }

    static func defaultWorkspace(in workspaces: [Space]) -> Space? {
        workspaces.first(where: { $0.isDefault == true }) ?? workspaces.first
    }
}

enum SharedSessionMessageVisibility {
    static func filter(_ messages: [ChatMessage]) -> [ChatMessage] {
        messages.filter { !$0.isInternalContext && !$0.isCompactionSummary }
    }
}

private enum SharedSessionExecutionTargetStep: Equatable {
    case agent
    case workspace
}

/// 对方共享任务的独立视图。查看档只读；协作档提供受 shared-chat 授权保护的文本输入，
/// 两者都复用同一条消息历史与实时流，续接档则在消息卡上单独完成物化。
struct IMSharedSessionViewerScreen: View {
    let card: IMSessionShareCard
    let organizationId: String
    let onOpenFork: (ConversationTarget) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @State private var viewModel: ConversationViewModel
    @State private var detail: IMSessionShareCard
    @State private var workspaceStore = WorkspaceStore.shared
    @State private var agentsStore = MyAgentsStore.shared
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var isForking = false
    @State private var showExecutionTargetPicker = false
    @State private var executionTargetStep: SharedSessionExecutionTargetStep = .agent
    @State private var selectedAgentId: String?
    @State private var selectedWorkspaceId: String?
    @State private var sharedChatDraft = ""
    @State private var isSendingSharedChat = false
    @State private var sharedChatError: String?

    private let service: IMConversationServing = IMConversationService()

    init(
        card: IMSessionShareCard,
        organizationId: String,
        onOpenFork: @escaping (ConversationTarget) -> Void
    ) {
        self.card = card
        self.organizationId = organizationId
        self.onOpenFork = onOpenFork
        self._detail = State(initialValue: card)
        self._viewModel = State(initialValue: ConversationViewModel(
            sessionId: card.sessionId ?? "",
            organizationId: organizationId,
            shareId: card.shareId,
            isReadOnly: true
        ))
    }

    private var isActive: Bool { detail.normalizedStatus == "active" }
    private var availableAgents: [OrganizationAgent] {
        SharedSessionExecutionTargetPolicy.agents(
            from: agentsStore.agents,
            organizationId: organizationId
        )
    }
    private var availableWorkspaces: [Space] {
        SharedSessionExecutionTargetPolicy.workspaces(
            from: workspaceStore.spaces,
            organizationId: organizationId
        )
    }

    var body: some View {
        Group {
            if isLoading {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !isActive {
                unavailableState("共享已停止或你已无权查看。")
            } else if let errorMessage {
                unavailableState(errorMessage)
            } else {
                MessageListView(
                    messages: SharedSessionMessageVisibility.filter(viewModel.messages),
                    tipRowModel: viewModel.tipRowModel,
                    subagentRuns: viewModel.subagentRuns,
                    onCopyMessage: copyMessage,
                    isReadOnly: true,
                    emptyStateText: "暂无可查看的消息",
                    isLoadingEarlier: viewModel.isLoadingEarlier,
                    earlierPrependToken: viewModel.earlierPrependToken,
                    onLoadEarlier: {
                        guard viewModel.hasMoreEarlier else { return }
                        Task { await viewModel.loadEarlier() }
                    }
                ) {
                    readOnlyFooter
                }
            }
        }
        .navigationTitle(detail.displayTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "xmark")
                }
                .accessibilityLabel("关闭")
            }
        }
        .task { await start() }
        .onDisappear { viewModel.stopSession() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active else { return }
            Task { await refreshPermission() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .imSessionShareStatusDidChange)) { _ in
            Task { await refreshPermission() }
        }
        .sheet(isPresented: $showExecutionTargetPicker) {
            NavigationStack {
                List {
                    switch executionTargetStep {
                    case .agent:
                        ForEach(availableAgents, id: \.id) { agent in
                            Button {
                                selectedAgentId = agent.id
                            } label: {
                                HStack(spacing: TTSpacing.sm) {
                                    AgentAvatarView(agent: agent, size: 36)
                                    Text(agent.displayName)
                                        .foregroundStyle(.tt.textPrimary)
                                    Spacer()
                                    if selectedAgentId == agent.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tt.bgAccent)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(agent.displayName)
                            .accessibilityAddTraits(selectedAgentId == agent.id ? .isSelected : [])
                        }
                    case .workspace:
                        ForEach(availableWorkspaces, id: \.id) { workspace in
                            Button {
                                selectedWorkspaceId = workspace.id
                            } label: {
                                HStack(spacing: TTSpacing.sm) {
                                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                                        Text(workspace.name).foregroundStyle(.tt.textPrimary)
                                        Text("在该 Workspace 中创建独立副本")
                                            .font(.tt.caption)
                                            .foregroundStyle(.tt.textSecondary)
                                    }
                                    Spacer()
                                    if selectedWorkspaceId == workspace.id {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(.tt.bgAccent)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(workspace.name)
                            .accessibilityAddTraits(selectedWorkspaceId == workspace.id ? .isSelected : [])
                        }
                    }
                }
                .navigationTitle(executionTargetStep == .agent ? "选择 AI 分身" : "选择 Workspace")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        if executionTargetStep == .agent {
                            Button("取消") { showExecutionTargetPicker = false }
                        } else {
                            Button {
                                executionTargetStep = .agent
                            } label: {
                                Label("返回", systemImage: "chevron.left")
                            }
                        }
                    }
                    ToolbarItem(placement: .confirmationAction) {
                        switch executionTargetStep {
                        case .agent:
                            Button("下一步") { executionTargetStep = .workspace }
                                .disabled(selectedAgentId == nil)
                        case .workspace:
                            Button("创建") { createForkFromSelection() }
                                .disabled(selectedWorkspaceId == nil || isForking)
                        }
                    }
                }
            }
            .presentationDetents([.medium, .large])
        }
    }

    private var readOnlyFooter: some View {
        VStack(spacing: TTSpacing.sm) {
            Divider()
            if detail.canChat {
                HStack(alignment: .bottom, spacing: TTSpacing.sm) {
                    TextField("输入消息，驱动 Agent…", text: $sharedChatDraft, axis: .vertical)
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1...4)
                        .disabled(isSendingSharedChat)
                    Button {
                        Task { await sendCollaborativeMessage() }
                    } label: {
                        if isSendingSharedChat {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.title2)
                        }
                    }
                    .disabled(
                        isSendingSharedChat
                            || sharedChatDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                    .accessibilityLabel("发送协作消息")
                }
                if let sharedChatError {
                    Text(sharedChatError)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textCritical)
                } else {
                    Label("实时协作：消息会在原任务中执行", systemImage: "person.2.fill")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                }
            } else if detail.canFork {
                Button {
                    openExecutionTargetPicker()
                } label: {
                    if isForking {
                        ProgressView().frame(maxWidth: .infinity)
                    } else {
                        Label("创建我的副本", systemImage: "arrow.triangle.branch")
                            .frame(maxWidth: .infinity)
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(
                    isForking
                        || agentsStore.isLoading
                        || workspaceStore.isLoadingSpaces
                        || availableAgents.isEmpty
                        || availableWorkspaces.isEmpty
                )
                if agentsStore.isLoading || workspaceStore.isLoadingSpaces {
                    Text("正在加载可用的执行目标…")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                } else if let loadError = agentsStore.loadError, availableAgents.isEmpty {
                    Text("AI 分身加载失败：\(loadError)")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                } else if availableAgents.isEmpty {
                    Text("当前组织没有可用的 AI 分身")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                } else if let loadError = workspaceStore.spacesLoadError, availableWorkspaces.isEmpty {
                    Text("Workspace 加载失败：\(loadError)")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                } else if availableWorkspaces.isEmpty {
                    Text("当前组织没有可用的执行 Workspace")
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textTertiary)
                }
            } else {
                Label("仅查看", systemImage: "eye")
                    .font(.tt.meta)
                    .foregroundStyle(.tt.textSecondary)
            }
        }
        .padding(.horizontal, TTSpacing.lg)
        .padding(.top, TTSpacing.sm)
        .padding(.bottom, TTSpacing.sm)
        .background(.ultraThinMaterial)
    }

    private func unavailableState(_ message: String) -> some View {
        ContentUnavailableView("无法打开共享任务", systemImage: "lock.slash", description: Text(message))
            .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func start() async {
        guard card.sessionId?.isEmpty == false else {
            errorMessage = "任务信息不完整。"
            isLoading = false
            return
        }
        await refreshPermission()
        guard isActive, errorMessage == nil else {
            isLoading = false
            return
        }
        if workspaceStore.spacesLoadedOrganizationId != organizationId {
            await workspaceStore.loadSpaces()
        }
        await agentsStore.ensureLoaded(organizationId: organizationId)
        await viewModel.startSession()
        isLoading = false
    }

    private func refreshPermission() async {
        do {
            let initial: IMSessionShareCard
            do {
                initial = try await service.getSessionShare(id: card.shareId)
            } catch {
                initial = try await latestIncomingShare(for: card.sessionId)
            }
            var latest = initial
            if latest.sessionId != card.sessionId {
                latest = try await latestIncomingShare(for: card.sessionId)
            }
            if latest.normalizedStatus != "active",
               let replacement = try? await latestIncomingShare(for: card.sessionId) {
                // 旧卡可能已经被撤销，但同一任务已重新发出有效授权；撤销状态不能
                // 直接终止恢复流程，要先尝试切换到当前 incoming 授权。
                latest = replacement
            }
            guard latest.normalizedStatus == "active" else {
                viewModel.stopSession()
                detail = latest
                errorMessage = nil
                return
            }
            guard let sessionId = latest.sessionId, !sessionId.isEmpty else {
                errorMessage = "任务信息不完整。"
                return
            }
            do {
                let _: ChatSession = try await APIClient.shared.get(
                    path: Endpoints.Chat.session(sessionId),
                    query: ["share_id": latest.shareId]
                )
            } catch {
                // 消息卡是持久快照；同一任务可能已经轮换授权。与 Electron
                // resolveRestoredIncomingSessionShare 保持一致，回退到最新有效卡。
                latest = try await latestIncomingShare(for: sessionId)
                guard let replacementSessionId = latest.sessionId, !replacementSessionId.isEmpty else {
                    throw APIError.apiError("共享任务信息不完整")
                }
                let _: ChatSession = try await APIClient.shared.get(
                    path: Endpoints.Chat.session(replacementSessionId),
                    query: ["share_id": latest.shareId]
                )
            }
            let shareChanged = detail.shareId != latest.shareId
            if shareChanged {
                viewModel.stopSession()
                viewModel.updateSharedAccess(shareId: latest.shareId)
            }
            detail = latest
            IMCardStatusMemoryCache.putAuthoritativeSessionShare(latest)
            errorMessage = nil
            if shareChanged, !isLoading {
                await viewModel.startSession()
            }
        } catch {
            viewModel.stopSession()
            errorMessage = "共享已停止或你已无权查看。"
        }
    }

    private func latestIncomingShare(for sessionId: String?) async throws -> IMSessionShareCard {
        guard let sessionId = sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty else {
            throw APIError.apiError("共享任务信息不完整")
        }
        let shares = try await service.listIncomingSessionShares(organizationId: organizationId)
        guard let latest = shares.first(where: {
            $0.normalizedStatus == "active" && $0.sessionId == sessionId
        }) else {
            throw APIError.apiError("共享已停止或你已无权查看")
        }
        return latest
    }

    private func sendCollaborativeMessage() async {
        let text = sharedChatDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard detail.canChat,
              let sessionId = detail.sessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionId.isEmpty,
              !text.isEmpty,
              !isSendingSharedChat else { return }
        isSendingSharedChat = true
        sharedChatError = nil
        defer { isSendingSharedChat = false }
        do {
            let status = try await service.getSharedExecutionStatus(
                sessionId: sessionId,
                shareId: detail.shareId
            )
            guard status.reachable else {
                sharedChatError = status.errorCategory ?? "远程执行设备暂未在线"
                return
            }

            let result = try await service.sendSharedChat(
                sessionId: sessionId,
                shareId: detail.shareId,
                text: text,
                clientMessageId: UUID().uuidString
            )
            let category = result.errorCategory?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if result.messageId != nil || category.isEmpty {
                sharedChatDraft = ""
                await viewModel.refreshSharedHistory()
            }
            if !category.isEmpty {
                sharedChatError = result.reply ?? result.errorMessage ?? "协作消息发送失败"
            }
        } catch {
            sharedChatError = error.localizedDescription
        }
    }

    private func openExecutionTargetPicker() {
        selectedAgentId = SharedSessionExecutionTargetPolicy.defaultAgent(in: availableAgents)?.id
        selectedWorkspaceId = SharedSessionExecutionTargetPolicy.defaultWorkspace(in: availableWorkspaces)?.id
        executionTargetStep = .agent
        showExecutionTargetPicker = true
    }

    private func createForkFromSelection() {
        guard let agentId = selectedAgentId,
              let workspace = availableWorkspaces.first(where: { $0.id == selectedWorkspaceId })
        else { return }
        showExecutionTargetPicker = false
        Task { await fork(agentId: agentId, into: workspace) }
    }

    private func fork(agentId: String, into workspace: Space) async {
        guard let sessionId = detail.sessionId else { return }
        isForking = true
        defer { isForking = false }
        do {
            let forked: ChatSession = try await APIClient.shared.post(
                path: Endpoints.Chat.sharedFork(sessionId),
                body: [
                    "agent_id": agentId,
                    "workspace_id": workspace.id,
                    "share_id": detail.shareId,
                ]
            )
            onOpenFork(ConversationTarget(
                title: forked.title ?? detail.displayTitle,
                workspaceId: workspace.id,
                organizationId: organizationId,
                agentId: agentId,
                sessionId: forked.id
            ))
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func copyMessage(_ message: ChatMessage) {
        UIPasteboard.general.string = message.text
    }
}
