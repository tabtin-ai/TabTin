import Foundation
import os

/// 跨 Space 会话目录：服务端搜索、状态筛选与分页均以同一查询快照驱动。
///
/// 任何新查询都会递增 generation；旧请求即使最后返回，也不得覆盖新搜索、筛选或组织的结果。
@MainActor @Observable
final class RecentSessionsStore {
    static let shared = RecentSessionsStore()

    private(set) var sessions: [RecentSession] = []
    private(set) var isLoading = false
    private(set) var isLoadingMore = false
    private(set) var loadError: String?
    private(set) var mutationError: String?
    private(set) var mutatingSessionIds: Set<String> = []
    private(set) var hasMore = false
    private(set) var activeQuery = RecentSessionsQuery()
    private(set) var runProjections: [String: SessionRunProjection] = [:]

    private var nextOffset = 0
    private var requestGeneration = 0
    /// 切换执行 Agent 后的本机粘性脸：挡住「退出会话立刻 reload」把尚未追上的旧列表盖回来。
    private var executionAgentOverrides: [String: RecentSessionExecutionAgentOverride] = [:]
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "RecentSessionsStore")
    private let realtimeListenerKey = "recent-session-run-projection"

    private init() {
        AuthService.shared.registerLogoutHook { [weak self] in self?.clearAll() }
        RealtimeGateway.shared.addEnvelopeListener(key: realtimeListenerKey) { [weak self] envelope in
            self?.handleRunStateEnvelope(envelope)
        }
        RealtimeGateway.shared.addReconnectListener(key: realtimeListenerKey) { [weak self] in
            guard let self else { return }
            Task { await self.reload(query: self.activeQuery) }
        }
    }

    /// 首页重载。查询变化时立即清空旧结果，避免把旧搜索词的会话伪装为新搜索结果。
    func reload(
        keyword: String? = nil,
        status: String? = "active",
        workspaceId: String? = nil,
        runStatus: String? = nil,
        limit: Int = 50
    ) async {
        await reload(query: RecentSessionsQuery(
            keyword: keyword,
            status: status,
            workspaceId: workspaceId,
            runStatus: runStatus,
            limit: limit
        ))
    }

    func reload(query: RecentSessionsQuery) async {
        guard AuthService.shared.isAuthenticated,
              let organizationId = WorkspaceStore.shared.selectedOrganizationId else {
            clearAll()
            return
        }

        requestGeneration += 1
        let generation = requestGeneration
        let queryChanged = activeQuery != query
        activeQuery = query
        nextOffset = 0
        hasMore = false
        loadError = nil
        isLoadingMore = false

        if queryChanged {
            sessions = []
        } else if sessions.isEmpty, query.keyword == nil, query.status == "active",
                  query.workspaceId == nil, query.runStatus == nil {
            // 仅默认首页可使用缓存；搜索/归档/筛选结果绝不被本地旧缓存污染。
            let cached = SessionListCacheStore.shared.recent(organizationId: organizationId)
            if !cached.isEmpty { adoptSessions(mergeRunSnapshots(cached)) }
        }
        isLoading = true

        do {
            let response: RecentSessionListResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessionsAll,
                query: query.parameters(organizationId: organizationId, offset: 0)
            )
            guard generation == requestGeneration, query == activeQuery else { return }
            adoptSessions(mergeRunSnapshots(response.sessions))
            nextOffset = response.sessions.count
            hasMore = response.hasMore
            if query.keyword == nil, query.status == "active",
               query.workspaceId == nil, query.runStatus == nil {
                SessionListCacheStore.shared.cacheRecent(organizationId: organizationId, sessions: sessions)
            }
        } catch {
            guard generation == requestGeneration, query == activeQuery else { return }
            if !error.isCancellation {
                loadError = error.userMessage
                logger.error("recent reload failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        guard generation == requestGeneration, query == activeQuery else { return }
        isLoading = false
    }

    /// 继续读取当前查询的下一页；使用加载时的 offset 和 generation，拒绝竞态回写。
    func loadMore() async {
        guard hasMore, !isLoading, !isLoadingMore,
              AuthService.shared.isAuthenticated,
              let organizationId = WorkspaceStore.shared.selectedOrganizationId else { return }

        let query = activeQuery
        let generation = requestGeneration
        let offset = nextOffset
        isLoadingMore = true
        loadError = nil

        do {
            let response: RecentSessionListResponse = try await APIClient.shared.get(
                path: Endpoints.Chat.sessionsAll,
                query: query.parameters(organizationId: organizationId, offset: offset)
            )
            guard generation == requestGeneration, query == activeQuery else { return }
            let incoming = mergeRunSnapshots(response.sessions)
            adoptSessions(
                RecentSessionsListPolicy.appendUnique(existing: sessions, incoming: incoming)
            )
            // offset 按服务端实际读取数推进，不能以去重后的显示数推进。
            nextOffset = offset + response.sessions.count
            hasMore = response.hasMore
            if query.keyword == nil, query.status == "active",
               query.workspaceId == nil, query.runStatus == nil {
                SessionListCacheStore.shared.cacheRecent(organizationId: organizationId, sessions: sessions)
            }
        } catch {
            guard generation == requestGeneration, query == activeQuery else { return }
            if !error.isCancellation {
                loadError = error.userMessage
                logger.error("recent load more failed: \(error.localizedDescription, privacy: .public)")
            }
        }

        guard generation == requestGeneration, query == activeQuery else { return }
        isLoadingMore = false
    }

    func rename(session: RecentSession, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            mutationError = "会话名称不能为空。"
            return
        }
        await mutate(sessionId: session.id) {
            let response: RecentSessionMutationResponse = try await APIClient.shared.put(
                path: Endpoints.Chat.session(session.id), body: ["title": trimmed]
            )
            self.applyUpdate(sessionId: session.id, title: response.title ?? trimmed, status: response.status)
        }
    }

    func archive(session: RecentSession) async {
        await mutate(sessionId: session.id) {
            let response: RecentSessionMutationResponse = try await APIClient.shared.put(
                path: Endpoints.Chat.session(session.id), body: ["status": "archived"]
            )
            self.applyUpdate(sessionId: session.id, title: response.title, status: response.status ?? "archived")
        }
    }

    func restore(session: RecentSession) async {
        await mutate(sessionId: session.id) {
            let response: RecentSessionMutationResponse = try await APIClient.shared.put(
                path: Endpoints.Chat.session(session.id), body: ["status": "active"]
            )
            self.applyUpdate(sessionId: session.id, title: response.title, status: response.status ?? "active")
        }
    }

    func setPinned(session: RecentSession, pinned: Bool) async {
        await mutate(sessionId: session.id) {
            let _: RecentSessionMutationResponse = try await APIClient.shared.put(
                path: Endpoints.Chat.session(session.id), body: ["is_pinned": pinned]
            )
            guard let index = self.sessions.firstIndex(where: { $0.id == session.id }) else { return }
            var next = self.sessions
            next[index].isPinned = pinned
            next[index].pinnedAt = pinned ? ISO8601DateFormatter().string(from: Date()) : nil
            self.sessions = next
            self.cacheDefaultSnapshotIfNeeded()
        }
    }

    /// 当前列表行上的执行 Agent 脸（切换失败回滚用）。
    func executionAgentFace(for sessionId: String) -> (
        agentId: String?,
        agentName: String?,
        agentAvatar: String?
    )? {
        guard let session = sessions.first(where: { $0.id == sessionId }) else { return nil }
        return (session.agentId, session.agentName, session.agentAvatar)
    }

    /// 会话内切换执行 Agent：立刻回写任务列表脸，并 sticky 挡住随后的列表重拉。
    ///
    /// 用户常在 PUT 尚未返回时就 pop；若不乐观写 + 覆盖，外面会一直是旧脸，
    /// 直到发消息、等回复结束触发 activity 才变——这正是产品不可接受的时序。
    func updateExecutionAgent(
        sessionId: String,
        agentId: String,
        agentName: String?,
        agentAvatar: String?
    ) {
        executionAgentOverrides[sessionId] = RecentSessionExecutionAgentOverride(
            agentId: agentId,
            agentName: agentName,
            agentAvatar: agentAvatar
        )
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else {
            // 会话还不在当前页：只留 override，等 reload / activity 带进来时再盖。
            return
        }
        // 整元素替换再赋回数组，确保 @Observable 一定发变更。
        var next = sessions
        next[index].agentId = agentId
        next[index].agentName = agentName
        next[index].agentAvatar = agentAvatar
        sessions = next
        cacheDefaultSnapshotIfNeeded()
    }

    /// PUT 失败时撤掉 sticky，并把列表脸滚回切换前。
    func revertExecutionAgent(
        sessionId: String,
        agentId: String?,
        agentName: String?,
        agentAvatar: String?
    ) {
        executionAgentOverrides.removeValue(forKey: sessionId)
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        var next = sessions
        next[index].agentId = agentId
        next[index].agentName = agentName
        next[index].agentAvatar = agentAvatar
        sessions = next
        cacheDefaultSnapshotIfNeeded()
    }

    /// 列表网络结果落地前合并 sticky 执行 Agent，避免 pop 重拉盖掉刚切换的脸。
    private func adoptSessions(_ incoming: [RecentSession]) {
        let merged = RecentSessionExecutionAgentOverridePolicy.merging(
            sessions: incoming,
            overrides: executionAgentOverrides
        )
        sessions = merged.sessions
        for sessionId in merged.resolvedSessionIds {
            executionAgentOverrides.removeValue(forKey: sessionId)
        }
    }

    /// 会话页已从同一权威 PUT 获得归档成功后，同步推进目录内存与默认离线缓存，
    /// 避免返回任务首页时短暂复活刚归档的会话。
    @discardableResult
    func markArchived(sessionId: String, organizationId: String) -> [RecentSession]? {
        guard WorkspaceStore.shared.selectedOrganizationId == organizationId else { return nil }
        let containedArchivedSession = sessions.contains { $0.id == sessionId }
        invalidateInFlightListRequestsAfterMutation()
        applyUpdate(sessionId: sessionId, title: nil, status: "archived")
        runProjections.removeValue(forKey: sessionId)
        guard containedArchivedSession,
              activeQuery.keyword == nil,
              activeQuery.status == "active" else { return nil }
        return sessions
    }

    func delete(session: RecentSession) async -> Bool {
        var deleted = false
        await mutate(sessionId: session.id) {
            let _: ApiEnvelope<String?> = try await APIClient.shared.delete(
                path: Endpoints.Chat.session(session.id)
            )
            RecentSessionsMutationPolicy.delete(
                sessionId: session.id,
                sessions: &self.sessions,
                runProjections: &self.runProjections
            )
            deleted = true
        }
        return deleted
    }

    func clearMutationError() { mutationError = nil }

    func resolvedRunStatus(for session: RecentSession) -> SessionRunStatus? {
        runProjections[session.id]?.resolvedStatus ?? session.runState?.status
    }

    func markReadAcknowledged(sessionId: String, sequence: Int, revision: Int) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        sessions[index].hasUnreadReply = false
        sessions[index].readState = SessionReadState(
            lastReadRunSequence: sequence,
            lastReadTerminalRevision: revision,
            readAt: nil,
            latestCompletedRunId: sessions[index].readState?.latestCompletedRunId,
            latestCompletedRunSequence: sessions[index].readState?.latestCompletedRunSequence,
            latestCompletedTerminalRevision:
                sessions[index].readState?.latestCompletedTerminalRevision
        )
        cacheDefaultSnapshotIfNeeded()
    }

    /// 本机已派发新一轮：有 run_id 时写入可被服务端版本覆盖的临时层；旧后端继续改兼容字段。
    func markRunStarted(
        sessionId: String,
        runId: String? = nil,
        status: SessionRunStatus = .running,
        beginsNewRun: Bool = true
    ) {
        if let runId, !runId.isEmpty {
            let previous = runProjections[sessionId]
            let updated = SessionRunProjectionReducer.applyingLocal(
                runId: runId,
                status: status,
                beginsNewRun: beginsNewRun,
                to: previous
            )
            runProjections[sessionId] = updated
            if updated != previous {
                applyLegacyRunFlags(sessionId: sessionId, status: status)
            }
            cacheDefaultSnapshotIfNeeded()
            return
        }
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        sessions[index].hasActiveTask = true
        sessions[index].hasUnreadReply = false
        sessions[index].lastRunFailed = false
        cacheDefaultSnapshotIfNeeded()
    }

    /// 本机会话流已到终态：本地终态仅在权威 run 状态的下一次更新前短暂兜底。
    func markRunTerminal(
        sessionId: String,
        runId: String? = nil,
        status: SessionRunStatus
    ) {
        if let runId, !runId.isEmpty {
            let previous = runProjections[sessionId]
            let updated = SessionRunProjectionReducer.applyingLocal(
                runId: runId,
                status: status,
                beginsNewRun: false,
                to: previous
            )
            runProjections[sessionId] = updated
            if updated != previous {
                applyLegacyRunFlags(sessionId: sessionId, status: status)
            }
            cacheDefaultSnapshotIfNeeded()
            return
        }
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        let previous = runProjections[sessionId]
            ?? sessions[index].runState.map { SessionRunProjection(authoritative: $0) }
        if let updated = SessionRunProjectionReducer.applyingLocalTerminalWithoutRunId(
            status: status,
            to: previous
        ) {
            runProjections[sessionId] = updated
            if updated != previous {
                applyLegacyRunFlags(sessionId: sessionId, status: status)
            }
            cacheDefaultSnapshotIfNeeded()
            return
        }
        sessions[index].hasActiveTask = false
        sessions[index].lastRunFailed = status == .failed
        cacheDefaultSnapshotIfNeeded()
    }

    func markRunTerminal(sessionId: String, failed: Bool) {
        markRunTerminal(sessionId: sessionId, status: failed ? .failed : .completed)
    }

    func clearForOrganizationSwitch() { clearAll() }

    /// 测试专用：清掉某会话的本地 run 投影，避免单测共享 `shared` 单例时相互污染。
    /// internal + @testable 可达；`runProjections` 为 `private(set)`，测试无法直接改写。
    func removeRunProjectionForTesting(sessionId: String) {
        runProjections.removeValue(forKey: sessionId)
    }

    func clearAll() {
        requestGeneration += 1
        sessions = []
        executionAgentOverrides = [:]
        isLoading = false
        isLoadingMore = false
        loadError = nil
        mutationError = nil
        mutatingSessionIds = []
        hasMore = false
        nextOffset = 0
        activeQuery = RecentSessionsQuery()
        runProjections = [:]
    }

    private func mutate(sessionId: String, operation: () async throws -> Void) async {
        guard !mutatingSessionIds.contains(sessionId) else { return }
        mutationError = nil
        mutatingSessionIds.insert(sessionId)
        defer { mutatingSessionIds.remove(sessionId) }

        do {
            try await operation()
            // mutation 的服务端确认晚于此前发出的列表请求；推进代次并结束旧 loading，
            // 防止旧快照随后覆盖刚完成的重命名、归档或删除。
            invalidateInFlightListRequestsAfterMutation()
            // mutation 已获服务端确认后，内存快照与离线默认首页必须一同向前推进。
            // 空数组也要写入，否则归档/删除最后一项后，冷启动会复活旧快照。
            cacheDefaultSnapshotIfNeeded()
        } catch {
            guard !error.isCancellation else { return }
            mutationError = error.userMessage
            logger.error("recent session mutation failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func invalidateInFlightListRequestsAfterMutation() {
        requestGeneration += 1
        isLoading = false
        isLoadingMore = false
    }

    private func applyUpdate(sessionId: String, title: String?, status: String?) {
        RecentSessionsMutationPolicy.update(
            sessionId: sessionId,
            title: title,
            status: status,
            expectedStatus: activeQuery.status,
            sessions: &sessions
        )
    }

    private func cacheDefaultSnapshotIfNeeded() {
        guard activeQuery.keyword == nil,
              activeQuery.status == "active",
              let organizationId = WorkspaceStore.shared.selectedOrganizationId else { return }
        SessionListCacheStore.shared.cacheRecent(
            organizationId: organizationId,
            sessions: sessions
        )
    }

    private func mergeRunSnapshots(_ incoming: [RecentSession]) -> [RecentSession] {
        incoming.map { session in
            var merged = session
            if let runState = session.runState {
                let projection = SessionRunProjectionReducer.applying(
                    authoritative: runState,
                    to: runProjections[session.id]
                )
                runProjections[session.id] = projection
                // HTTP 返回可能落后于刚收到的 realtime；缓存与行模型都保留 reducer 接纳的版本。
                merged.applyAuthoritativeRunState(projection.authoritative)
            } else if session.includesRunState, runProjections[session.id] == nil {
                // 显式 null 表示新后端当前尚无权威 run；缺键则是旧后端兼容路径。
                runProjections[session.id] = SessionRunProjection()
            }
            return merged
        }
    }

    private func applyLegacyRunFlags(sessionId: String, status: SessionRunStatus) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        sessions[index].hasActiveTask = !status.isTerminal
        sessions[index].hasUnreadReply = false
        sessions[index].lastRunFailed = status == .failed
    }

    private func handleRunStateEnvelope(_ envelope: WSEnvelope) {
        switch envelope.type {
        case "chat.session.read_state.updated":
            handleReadStateEnvelope(envelope)
        case "chat.session.activity.updated":
            handleActivityEnvelope(envelope)
        case "agent.user.title_updated":
            handleTitleUpdatedEnvelope(envelope)
        case "chat.session.run_state.updated":
            handleAuthoritativeRunStateEnvelope(envelope)
        default:
            break
        }
    }

    private func handleAuthoritativeRunStateEnvelope(_ envelope: WSEnvelope) {
        guard let sessionId = envelope.payloadString("session_id"),
              !sessionId.isEmpty,
              let runState = envelope.decodePayloadField(
                "run_state",
                as: SessionRunState.self,
                encoder: JSONEncoder(),
                decoder: JSONDecoder()
              ) else { return }

        guard let eventOrganizationId = envelope.payloadString("organization_id"),
              let selectedOrganizationId = WorkspaceStore.shared.selectedOrganizationId,
              eventOrganizationId == selectedOrganizationId else { return }

        let projection = SessionRunProjectionReducer.applying(
            authoritative: runState,
            to: runProjections[sessionId]
        )
        runProjections[sessionId] = projection
        if let index = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[index].applyAuthoritativeRunState(projection.authoritative)
            cacheDefaultSnapshotIfNeeded()
        }
    }

    private func handleReadStateEnvelope(_ envelope: WSEnvelope) {
        guard let sessionId = envelope.payloadString("session_id"),
              let eventOrganizationId = envelope.payloadString("organization_id"),
              let selectedOrganizationId = WorkspaceStore.shared.selectedOrganizationId,
              eventOrganizationId == selectedOrganizationId,
              let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }

        let readState = envelope.decodePayloadField(
            "read_state",
            as: SessionReadState.self,
            encoder: JSONEncoder(),
            decoder: JSONDecoder()
        ) ?? envelope.decodePayload(
            as: SessionReadState.self,
            encoder: JSONEncoder(),
            decoder: JSONDecoder()
        )
        guard let readState else { return }
        sessions[index].readState = readState
        sessions[index].hasUnreadReply = readState.hasUnreadCompletedReply
        cacheDefaultSnapshotIfNeeded()
    }

    /// ：同账号跨端会话目录活动——upsert 后按活动时间重排。
    private func handleActivityEnvelope(_ envelope: WSEnvelope) {
        guard let patch = SessionActivityPatch(envelope: envelope) else { return }
        let applied = RecentSessionActivityPolicy.apply(
            patch: patch,
            selectedOrganizationId: WorkspaceStore.shared.selectedOrganizationId,
            expectedStatus: activeQuery.status,
            sessions: &sessions
        )
        if applied {
            // activity 可能带上新 agent_id，但仍可能缺脸；sticky 优先，追上后剪掉。
            adoptSessions(sessions)
            cacheDefaultSnapshotIfNeeded()
        }
    }

    /// LLM 异步标题：只改 title，不 bump 排序时间（优先级低于 activity）。
    private func handleTitleUpdatedEnvelope(_ envelope: WSEnvelope) {
        guard let sessionId = envelope.payloadString("session_id"),
              !sessionId.isEmpty,
              let title = envelope.payloadString("title")?
                .trimmingCharacters(in: .whitespacesAndNewlines),
              !title.isEmpty,
              let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        if let eventOrganizationId = envelope.payloadString("organization_id"),
           let selectedOrganizationId = WorkspaceStore.shared.selectedOrganizationId,
           eventOrganizationId != selectedOrganizationId {
            return
        }
        sessions[index].title = title
        cacheDefaultSnapshotIfNeeded()
    }
}

/// 本机刚切换的执行 Agent 脸：挡住列表重拉里尚未追上的旧 `agent_id`。
struct RecentSessionExecutionAgentOverride: Equatable, Sendable {
    let agentId: String
    let agentName: String?
    let agentAvatar: String?
}

enum RecentSessionExecutionAgentOverridePolicy {
    /// 把 sticky 脸盖到列表行上；当服务端 `agentId` 已追上时标记可清除。
    static func merging(
        sessions: [RecentSession],
        overrides: [String: RecentSessionExecutionAgentOverride]
    ) -> (sessions: [RecentSession], resolvedSessionIds: [String]) {
        guard !overrides.isEmpty else { return (sessions, []) }

        var resolvedSessionIds: [String] = []
        let next = sessions.map { session -> RecentSession in
            guard let override = overrides[session.id] else { return session }
            if session.agentId == override.agentId {
                resolvedSessionIds.append(session.id)
                var enriched = session
                // API 可能已换人但仍缺脸——用本机脸补齐一次再放行。
                if normalized(enriched.agentAvatar) == nil {
                    enriched.agentName = enriched.agentName ?? override.agentName
                    enriched.agentAvatar = override.agentAvatar
                }
                return enriched
            }
            var patched = session
            patched.agentId = override.agentId
            patched.agentName = override.agentName
            patched.agentAvatar = override.agentAvatar
            return patched
        }
        return (next, resolvedSessionIds)
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

enum RecentSessionsMutationPolicy {
    static func update(
        sessionId: String,
        title: String?,
        status: String?,
        expectedStatus: String?,
        sessions: inout [RecentSession]
    ) {
        guard let index = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        if let title { sessions[index].title = title }
        if let status {
            sessions[index].status = status
            // 当前服务端筛选不包含更新后的状态时，立即从结果中移除，避免展示与筛选标签矛盾。
            if let expectedStatus, status != expectedStatus {
                sessions.remove(at: index)
            }
        }
    }

    static func delete(
        sessionId: String,
        sessions: inout [RecentSession],
        runProjections: inout [String: SessionRunProjection]
    ) {
        sessions.removeAll { $0.id == sessionId }
        runProjections.removeValue(forKey: sessionId)
    }
}

/// `chat.session.activity.updated` payload 快照。
struct SessionActivityPatch: Equatable, Sendable {
    let sessionId: String
    let organizationId: String
    let reason: String?
    let title: String?
    let status: String?
    let workspaceId: String?
    let projectId: String?
    let agentId: String?
    let agentName: String?
    let agentAvatar: String?
    let lastMessageAt: String?
    let updatedAt: String?
    let createdAt: String?
    let threadId: String?

    init?(envelope: WSEnvelope) {
        guard let sessionId = Self.nonEmpty(envelope.payloadString("session_id")),
              let organizationId = Self.nonEmpty(envelope.payloadString("organization_id"))
        else { return nil }
        self.sessionId = sessionId
        self.organizationId = organizationId
        reason = Self.nonEmpty(envelope.payloadString("reason"))
        title = Self.nonEmpty(envelope.payloadString("title"))
        status = Self.nonEmpty(envelope.payloadString("status"))
        workspaceId = Self.nonEmpty(envelope.payloadString("workspace_id"))
        projectId = Self.nonEmpty(envelope.payloadString("project_id"))
        agentId = Self.nonEmpty(envelope.payloadString("agent_id"))
        agentName = Self.nonEmpty(envelope.payloadString("agent_name"))
        agentAvatar = Self.nonEmpty(envelope.payloadString("agent_avatar"))
        // 时间戳允许写入新值（含空串以外的 ISO）；空串视为未提供。
        lastMessageAt = Self.timestamp(envelope.payloadString("last_message_at"))
        updatedAt = Self.timestamp(envelope.payloadString("updated_at"))
        createdAt = Self.timestamp(envelope.payloadString("created_at"))
        threadId = Self.nonEmpty(envelope.payloadString("thread_id"))
    }

    /// 单测 / 纯函数入口，绕过 WS envelope。
    init(
        sessionId: String,
        organizationId: String,
        reason: String? = nil,
        title: String? = nil,
        status: String? = nil,
        workspaceId: String? = nil,
        projectId: String? = nil,
        agentId: String? = nil,
        agentName: String? = nil,
        agentAvatar: String? = nil,
        lastMessageAt: String? = nil,
        updatedAt: String? = nil,
        createdAt: String? = nil,
        threadId: String? = nil
    ) {
        self.sessionId = sessionId
        self.organizationId = organizationId
        self.reason = reason
        self.title = title
        self.status = status
        self.workspaceId = workspaceId
        self.projectId = projectId
        self.agentId = agentId
        self.agentName = agentName
        self.agentAvatar = agentAvatar
        self.lastMessageAt = lastMessageAt
        self.updatedAt = updatedAt
        self.createdAt = createdAt
        self.threadId = threadId
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    private static func timestamp(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// 跨端会话目录活动同步：org 校验 → upsert → 按活动时间重排。
enum RecentSessionActivityPolicy {
    /// 与 TaskHomeRoot 一致：`lastMessageAt ?? updatedAt ?? createdAt`。
    static func sortKey(for session: RecentSession) -> String {
        session.lastMessageAt ?? session.updatedAt ?? session.createdAt ?? ""
    }

    static func sortByActivity(_ sessions: [RecentSession]) -> [RecentSession] {
        sessions.sorted { lhs, rhs in
            let lhsKey = sortKey(for: lhs)
            let rhsKey = sortKey(for: rhs)
            if lhsKey != rhsKey { return lhsKey > rhsKey }
            return lhs.id < rhs.id
        }
    }

    /// - Returns: 是否写入了 `sessions`（跨 org 忽略时为 false）。
    @discardableResult
    static func apply(
        patch: SessionActivityPatch,
        selectedOrganizationId: String?,
        expectedStatus: String?,
        sessions: inout [RecentSession]
    ) -> Bool {
        guard let selectedOrganizationId,
              patch.organizationId == selectedOrganizationId else { return false }

        if let index = sessions.firstIndex(where: { $0.id == patch.sessionId }) {
            applyFields(patch, to: &sessions[index])
            if let expectedStatus,
               let status = sessions[index].status,
               status != expectedStatus {
                sessions.remove(at: index)
            }
        } else {
            let insertedStatus = patch.status ?? "active"
            if let expectedStatus, insertedStatus != expectedStatus {
                return false
            }
            sessions.append(makeMinimalSession(from: patch, status: insertedStatus))
        }

        sessions = sortByActivity(sessions)
        return true
    }

    private static func applyFields(_ patch: SessionActivityPatch, to session: inout RecentSession) {
        if let title = patch.title { session.title = title }
        if let status = patch.status { session.status = status }
        if let agentId = patch.agentId, agentId != session.agentId {
            session.agentId = agentId
            // 推送目前只带 agent_id：身份变了就清旧脸，避免张冠李戴；
            // 本机 switch 补丁 / 列表重拉会补上新头像。
            if patch.agentName == nil { session.agentName = nil }
            if patch.agentAvatar == nil { session.agentAvatar = nil }
        }
        if let agentName = patch.agentName { session.agentName = agentName }
        if let agentAvatar = patch.agentAvatar { session.agentAvatar = agentAvatar }
        if let workspaceId = patch.workspaceId { session.workspaceId = workspaceId }
        if let projectId = patch.projectId { session.projectId = projectId }
        if let lastMessageAt = patch.lastMessageAt { session.lastMessageAt = lastMessageAt }
        if let updatedAt = patch.updatedAt { session.updatedAt = updatedAt }
        if let createdAt = patch.createdAt { session.createdAt = createdAt }
    }

    private static func makeMinimalSession(
        from patch: SessionActivityPatch,
        status: String
    ) -> RecentSession {
        RecentSession(
            id: patch.sessionId,
            title: patch.title,
            status: status,
            organizationId: patch.organizationId,
            workspaceId: patch.workspaceId,
            createdAt: patch.createdAt,
            updatedAt: patch.updatedAt,
            lastMessageAt: patch.lastMessageAt,
            projectId: patch.projectId,
            agentId: patch.agentId,
            agentName: patch.agentName,
            agentAvatar: patch.agentAvatar
        )
    }
}

private struct RecentSessionMutationResponse: Decodable {
    let title: String?
    let status: String?
}

private extension Error {
    var userMessage: String {
        (self as? LocalizedError)?.errorDescription ?? localizedDescription
    }
}
