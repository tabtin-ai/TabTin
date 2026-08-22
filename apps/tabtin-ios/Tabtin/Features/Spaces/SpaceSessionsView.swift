import SwiftUI
import os

/// 单个 Space 下的会话与正式 Agent 数据源。
/// 与「最近」tab 的跨 Space 聚合（RecentSessionsStore）区分：这里只取一个 Space 的会话，
/// 按 Space 维度实例化（非单例），随视图生命周期创建/销毁。
@MainActor @Observable
final class SpaceSessionsStore {
    let spaceId: String

    private(set) var sessions: [ChatSession] = []
    private(set) var agentMembers: [SpaceAgentMember] = []
    private(set) var isLoading = false
    private(set) var loadError: String?
    private(set) var archivingIds: Set<String> = []
    private(set) var actionError: String?

    private var requestSeq = 0
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "SpaceSessionsStore")

    init(spaceId: String) {
        self.spaceId = spaceId
    }

    func reload(limit: Int = 50) async {
        guard AuthService.shared.isAuthenticated else { return }
        requestSeq += 1
        let seq = requestSeq

        // 先秒显本地缓存（仅当前为空时）→ 每次进 Space 会话列表不再「空→转圈→列表」跳一下。
        // per-space store 随视图创建/销毁（非单例），缓存对这条路径价值最大。
        if sessions.isEmpty {
            let cached = SessionListCacheStore.shared.spaceSessions(spaceId: spaceId)
            if !cached.isEmpty { sessions = cached }
        }
        isLoading = sessions.isEmpty
        loadError = nil
        async let rosterLoad: Void = reloadAgentMembers()
        do {
            let resp: ChatSessionListResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessions,
                query: ["space_id": spaceId, "status": "active", "limit": String(limit)]
            )
            guard seq == requestSeq else { return }
            let sorted = resp.sessions.sorted {
                ($0.lastMessageAt ?? $0.updatedAt ?? "") > ($1.lastMessageAt ?? $1.updatedAt ?? "")
            }
            sessions = sorted
            SessionListCacheStore.shared.cacheSpaceSessions(spaceId: spaceId, sessions: sorted)
        } catch {
            guard seq == requestSeq else { return }
            guard !error.isCancellation else {
                isLoading = false
                return
            }
            loadError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("space sessions reload failed: \(error.localizedDescription)")
        }
        await rosterLoad
        isLoading = false
    }

    private func reloadAgentMembers() async {
        do {
            let response: ProjectMembershipListResponse = try await APIClient.shared.get(
                path: Endpoints.Context.spaceMemberships(spaceId)
            )
            let memberships = response.memberships.filter { $0.isActive && $0.agentId != nil }
            let agentIds = Array(Set(memberships.compactMap(\.agentId))).sorted()
            let agents = await withTaskGroup(of: AgentSummary?.self) { group in
                for id in agentIds {
                    group.addTask { try? await APIClient.shared.get(path: Endpoints.Agent.detail(id)) }
                }
                var result: [String: AgentSummary] = [:]
                for await agent in group {
                    if let agent { result[agent.id] = agent }
                }
                return result
            }
            let currentUserId = AuthService.shared.currentUser?.id
            agentMembers = memberships.compactMap { membership in
                guard let agentId = membership.agentId, let agent = agents[agentId] else { return nil }
                return SpaceAgentMember(
                    id: membership.id,
                    agentId: agentId,
                    name: agent.displayName ?? "Agent",
                    roleLabel: membership.roleLabel,
                    responsibility: membership.responsibility,
                    isPrimary: membership.isPrimary == true,
                    ownedByCurrentUser: currentUserId != nil &&
                        (agent.userId == currentUserId || agent.ownerUserId == currentUserId)
                )
            }
            .sorted {
                if $0.isPrimary != $1.isPrimary { return $0.isPrimary }
                return $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        } catch {
            logger.warning("space agent roster load failed: \(error.localizedDescription)")
        }
    }

    /// 归档后同步当前列表和 Space 级离线快照，避免重新进入时短暂显示旧项。
    func archive(_ session: ChatSession) async {
        guard !archivingIds.contains(session.id) else { return }
        archivingIds.insert(session.id)
        actionError = nil
        defer { archivingIds.remove(session.id) }

        do {
            let _: ChatSession = try await APIClient.shared.put(
                path: Endpoints.Chat.session(session.id),
                body: ["status": "archived"]
            )
            sessions.removeAll { $0.id == session.id }
            SessionListCacheStore.shared.cacheSpaceSessions(spaceId: spaceId, sessions: sessions)
        } catch {
            guard !error.isCancellation else { return }
            actionError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            logger.error("space session archive failed: \(error.localizedDescription)")
        }
    }

    func clearActionError() {
        actionError = nil
    }

    /// 会话页完成归档后，由统一成功通知推进仍存活的 Space 列表。
    func applyArchivedSession(_ context: ConversationArchiveContext) {
        guard context.belongs(toSpace: spaceId),
              sessions.contains(where: { $0.id == context.sessionId }) else { return }
        sessions.removeAll { $0.id == context.sessionId }
        SessionListCacheStore.shared.cacheSpaceSessions(spaceId: spaceId, sessions: sessions)
    }
}

struct SpaceAgentMember: Identifiable, Hashable, Sendable {
    let id: String
    let agentId: String
    let name: String
    let roleLabel: String?
    let responsibility: String?
    let isPrimary: Bool
    let ownedByCurrentUser: Bool
}

/// Space 详情页：只展示该 Space 下的 Agent 会话列表。
/// 从 Space 列表点入（或该 tab 仅一个 Space 时直接作为根内容展示）；
/// 会话点开走 `onOpen`（进对话主屏），顶部「➕」统一进入 ConversationScreen 草稿；
/// Workspace 只声明执行现场，Agent 选择不在此入口重复出现。
struct SpaceSessionsView: View {
    let space: Space
    let onOpen: (ConversationTarget) -> Void

    @State private var store: SpaceSessionsStore
    @State private var showSettings = false
    @State private var archiveTarget: ChatSession?
    @State private var resumableDraft: ConversationDraftSnapshot?
    @State private var draftStore: ConversationDraftStore?

    init(
        space: Space,
        onOpen: @escaping (ConversationTarget) -> Void
    ) {
        self.space = space
        self.onOpen = onOpen
        _store = State(initialValue: SpaceSessionsStore(spaceId: space.id))
        _resumableDraft = State(initialValue: nil)
        _draftStore = State(initialValue: try? ConversationDraftStore())
    }

    var body: some View {
        List {
            agentContent
            draftContent
            sessionContent
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable { await reload() }
        .ttRootNavigationTitle(space.name)
        .background(.tt.bgCanvasDefault, ignoresSafeAreaEdges: .all)
        .ttToolbarBackground()
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button { startNewSession() } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel(L10n.Agent.createConversation)
                Button { showSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel(L10n.Common.settings)
            }
        }
        .task { await reload() }
        .onAppear {
            Task { await loadDraft() }
        }
        .onReceive(NotificationCenter.default.publisher(for: .conversationSessionArchived)) { note in
            guard let context = ConversationArchivePropagation.context(from: note) else { return }
            store.applyArchivedSession(context)
        }
        .alert(L10n.Agent.archiveSession, isPresented: Binding(
            get: { archiveTarget != nil },
            set: { if !$0 { archiveTarget = nil } }
        )) {
            Button(L10n.Agent.archiveSession, role: .destructive) {
                guard let session = archiveTarget else { return }
                archiveTarget = nil
                Task { await store.archive(session) }
            }
            Button(L10n.Common.cancel, role: .cancel) { archiveTarget = nil }
        } message: {
            Text(L10n.Agent.archiveSessionConfirm(archiveTarget.map(sessionTitle)))
        }
        .alert(L10n.Agent.operationFailed, isPresented: Binding(
            get: { store.actionError != nil },
            set: { if !$0 { store.clearActionError() } }
        )) {
            Button(L10n.Common.confirm, role: .cancel) { store.clearActionError() }
        } message: {
            Text(store.actionError ?? "")
        }
        .sheet(isPresented: $showSettings) {
            ConversationSettingsSheet(spaceId: space.id)
        }
    }

    // MARK: - 会话列表

    @ViewBuilder
    private var draftContent: some View {
        if let resumableDraft {
            Text("草稿")
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textTertiary)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: TTSpacing.lg,
                    leading: TTSpacing.md,
                    bottom: TTSpacing.xs,
                    trailing: TTSpacing.md
                ))

            Button { startNewSession() } label: {
                HStack(spacing: TTSpacing.md) {
                    Image(systemName: "square.and.pencil")
                        .font(.tt.iconSubtitleMedium)
                        .foregroundStyle(.tt.iconAccent)
                        .frame(width: 36, height: 36)
                        .background(
                            .tt.bgSubtle,
                            in: RoundedRectangle(cornerRadius: TTRadius.sm, style: .continuous)
                        )

                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        Text("继续未发送的对话")
                            .font(.tt.bodySemibold)
                            .foregroundStyle(.tt.textPrimary)
                        Text(draftPreview(resumableDraft))
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                            .lineLimit(2)
                    }

                    Spacer(minLength: TTSpacing.sm)
                    Image(systemName: "chevron.right")
                        .font(.tt.iconCaptionMedium)
                        .foregroundStyle(.tt.iconSecondary)
                }
                .padding(.vertical, TTSpacing.sm)
            }
            .buttonStyle(.plain)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(
                top: 0,
                leading: TTSpacing.md,
                bottom: 0,
                trailing: TTSpacing.md
            ))
        }
    }

    @ViewBuilder
    private var agentContent: some View {
        if !store.agentMembers.isEmpty {
            Text(L10n.SpaceList.formalAgents)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textTertiary)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: TTSpacing.md,
                    leading: TTSpacing.md,
                    bottom: TTSpacing.xs,
                    trailing: TTSpacing.md
                ))
            ForEach(store.agentMembers) { member in
                HStack(alignment: .top, spacing: TTSpacing.md) {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                        .font(.tt.iconFeature)
                        .foregroundStyle(.tt.iconAccent)
                    VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                        HStack(spacing: TTSpacing.xs) {
                            Text(member.name).font(.tt.bodySemibold)
                            if member.isPrimary {
                                Text(L10n.Project.primaryAgentBadge)
                                    .font(.tt.captionMedium)
                                    .foregroundStyle(.tt.iconAccent)
                            }
                        }
                        if let role = member.roleLabel, !role.isEmpty {
                            Text(role).font(.tt.caption).foregroundStyle(.tt.textSecondary)
                        }
                        if let responsibility = member.responsibility, !responsibility.isEmpty {
                            Text(responsibility)
                                .font(.tt.caption)
                                .foregroundStyle(.tt.textTertiary)
                                .lineLimit(2)
                        }
                    }
                }
                .padding(TTSpacing.md)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    .tt.bgSubtle,
                    in: RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: TTRadius.md, style: .continuous)
                        .strokeBorder(.tt.borderLight, lineWidth: 0.5)
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: TTSpacing.xs,
                    leading: TTSpacing.md,
                    bottom: TTSpacing.sm,
                    trailing: TTSpacing.md
                ))
            }
        }
    }

    /// 会话区：加载/错误/空态占位行 or「会话」标题行 + 会话行。
    @ViewBuilder
    private var sessionContent: some View {
        if store.isLoading && store.sessions.isEmpty {
            placeholderRow {
                ProgressView(L10n.Agent.loadingSessions)
                    .frame(maxWidth: .infinity, minHeight: 280)
            }
        } else if let err = store.loadError, store.sessions.isEmpty {
            placeholderRow {
                errorState(err)
                    .frame(maxWidth: .infinity, minHeight: 320)
            }
        } else if store.sessions.isEmpty, resumableDraft == nil {
            placeholderRow {
                emptyState
                    .frame(maxWidth: .infinity, minHeight: 320)
            }
        } else {
            Text(L10n.Agent.conversationsSection)
                .font(.tt.captionSemibold)
                .foregroundStyle(.tt.textTertiary)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(
                    top: TTSpacing.lg,
                    leading: TTSpacing.md,
                    bottom: TTSpacing.xs,
                    trailing: TTSpacing.md
                ))
            ForEach(store.sessions) { session in
                Button { open(session) } label: { SpaceSessionRow(session: session) }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(role: .destructive) {
                            archiveTarget = session
                        } label: {
                            Label(L10n.Agent.archiveSession, systemImage: "archivebox")
                        }
                        .disabled(store.archivingIds.contains(session.id))
                    }
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(
                        top: 0,
                        leading: TTSpacing.md,
                        bottom: 0,
                        trailing: TTSpacing.md
                    ))
            }
        }
    }

    private func placeholderRow<Content: View>(@ViewBuilder content: () -> Content) -> some View {
        content()
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    private func open(_ session: ChatSession) {
        onOpen(ConversationTarget(
            title: sessionTitle(session),
            workspaceId: space.id,
            organizationId: space.organizationId,
            sessionId: session.id
        ))
    }

    private func startNewSession() {
        onOpen(ConversationTarget(
            title: space.name,
            workspaceId: space.id,
            organizationId: space.organizationId,
            startsNewSession: true
        ))
    }

    private func reload() async {
        async let sessions: Void = store.reload()
        async let draft: Void = loadDraft()
        _ = await (sessions, draft)
    }

    private func loadDraft() async {
        guard let draftStore,
              let scope = try? ConversationDraftScope(
                  organizationId: space.organizationId,
                  workspaceId: space.id
              ) else {
            resumableDraft = nil
            return
        }
        resumableDraft = try? await draftStore.load(scope: scope)
    }

    private func draftPreview(_ draft: ConversationDraftSnapshot) -> String {
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !text.isEmpty { return text }
        if !draft.attachments.isEmpty {
            return "已添加 \(draft.attachments.count) 个附件"
        }
        if !draft.contextReferences.isEmpty {
            return "已添加 \(draft.contextReferences.count) 个上下文"
        }
        return "已保存对话设置"
    }

    private func sessionTitle(_ session: ChatSession) -> String {
        if let t = session.title, !t.isEmpty { return t }
        return space.name
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label(L10n.Agent.noConversations, systemImage: "bubble.left.and.bubble.right")
        } description: {
            Text(L10n.Agent.noConversationsHint(space.name))
        } actions: {
            Button { startNewSession() } label: {
                Label(L10n.Agent.createConversation, systemImage: "square.and.pencil")
                    // ContentUnavailableView.actions 会给按钮内容套 accent 前景，
                    // 图标在 borderedProminent 橙底上仍是橙色——显式压成白色。
                    .foregroundStyle(.white)
            }
            .buttonStyle(.borderedProminent)
            .tint(.tt.bgAccent)
        }
    }

    private func errorState(_ message: String) -> some View {
        TTErrorStateView(message: message) { Task { await store.reload() } }
            .padding(.horizontal, TTSpacing.xl)
    }
}

private struct SpaceSessionRow: View {
    let session: ChatSession

    private var hasPendingInteraction: Bool {
        PendingInteractionStore.shared.hasPendingForSession(session.id)
    }

    var body: some View {
        HStack(spacing: TTSpacing.md) {
            ZStack {
                RoundedRectangle(cornerRadius: 10)
                    .fill(.tint.opacity(0.15))
                    .frame(width: 40, height: 40)
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.tt.iconBody)
                    .foregroundStyle(.tint)
            }
            VStack(alignment: .leading, spacing: TTSpacing.xxs) {
                HStack(spacing: TTSpacing.xs) {
                    Text(displayTitle)
                        .font(.tt.bodySemibold)
                        .foregroundStyle(.tt.textPrimary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if hasPendingInteraction {
                        PendingInteractionPill()
                    }
                    if let time = displayTime {
                        Text(time)
                            .font(.tt.caption)
                            .foregroundStyle(.tt.textTertiary)
                    }
                }
                if let model = session.currentModelName, !model.isEmpty {
                    Text(model)
                        .font(.tt.caption)
                        .foregroundStyle(.tt.textSecondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, TTSpacing.sm)
        .contentShape(Rectangle())
    }

    private var displayTitle: String {
        if let t = session.title, !t.isEmpty { return t }
        return L10n.Agent.unnamedSession
    }

    private var displayTime: String? {
        guard let raw = session.lastMessageAt ?? session.updatedAt else { return nil }
        return RelativeTime.format(raw)
    }
}
