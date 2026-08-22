import Foundation

enum SessionRunStatus: String, Codable, Equatable, Hashable, Sendable {
    case queued
    case running
    case waitingUser = "waiting_user"
    case paused
    case cancelling
    case completed
    case failed
    case cancelled
    case interrupted

    var isTerminal: Bool {
        switch self {
        case .completed, .failed, .cancelled, .interrupted:
            return true
        case .queued, .running, .waitingUser, .paused, .cancelling:
            return false
        }
    }
}

/// `/chat/sessions/all` 与 `chat.session.run_state.updated` 共用的权威运行态。
struct SessionRunState: Codable, Equatable, Hashable, Sendable {
    let runId: String
    let sequence: Int
    let revision: Int
    let status: SessionRunStatus
    let queueDepth: Int
    let startedAt: String?
    let stateChangedAt: String
    let endedAt: String?
    let stopReason: String?
    let errorClass: String?
    let waitingInteractionId: String?

    enum CodingKeys: String, CodingKey {
        case runId = "run_id"
        case sequence, revision, status
        case queueDepth = "queue_depth"
        case startedAt = "started_at"
        case stateChangedAt = "state_changed_at"
        case endedAt = "ended_at"
        case stopReason = "stop_reason"
        case errorClass = "error_class"
        case waitingInteractionId = "waiting_interaction_id"
    }
}

struct SessionReadState: Codable, Equatable, Hashable, Sendable {
    let lastReadRunSequence: Int
    let lastReadTerminalRevision: Int
    let readAt: String?
    let latestCompletedRunId: String?
    let latestCompletedRunSequence: Int?
    let latestCompletedTerminalRevision: Int?

    enum CodingKeys: String, CodingKey {
        case lastReadRunSequence = "last_read_run_sequence"
        case lastReadTerminalRevision = "last_read_terminal_revision"
        case readAt = "read_at"
        case latestCompletedRunId = "latest_completed_run_id"
        case latestCompletedRunSequence = "latest_completed_run_sequence"
        case latestCompletedTerminalRevision = "latest_completed_terminal_revision"
    }

    func pendingAck(sessionId: String, mutationId: String = UUID().uuidString)
        -> PendingSessionReadAck? {
        guard let runId = latestCompletedRunId,
              let sequence = latestCompletedRunSequence,
              let revision = latestCompletedTerminalRevision else { return nil }
        return PendingSessionReadAck(
            sessionId: sessionId,
            throughRunId: runId,
            throughSequence: sequence,
            throughRevision: revision,
            mutationId: mutationId
        )
    }

    /// 与 RecentSessionsStore / Electron capsule 未读判定对齐。
    var hasUnreadCompletedReply: Bool {
        guard let latestSequence = latestCompletedRunSequence,
              let latestRevision = latestCompletedTerminalRevision else { return false }
        return latestSequence > lastReadRunSequence
            || (
                latestSequence == lastReadRunSequence
                    && latestRevision > lastReadTerminalRevision
            )
    }
}

extension SessionRunState {
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let sequence = try container.decode(Int.self, forKey: .sequence)
        let revision = try container.decode(Int.self, forKey: .revision)
        let queueDepth = try container.decode(Int.self, forKey: .queueDepth)

        guard sequence >= 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .sequence,
                in: container,
                debugDescription: "sequence must be non-negative"
            )
        }
        guard revision >= 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .revision,
                in: container,
                debugDescription: "revision must be non-negative"
            )
        }
        guard queueDepth >= 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .queueDepth,
                in: container,
                debugDescription: "queue_depth must be non-negative"
            )
        }

        runId = try container.decode(String.self, forKey: .runId)
        self.sequence = sequence
        self.revision = revision
        status = try container.decode(SessionRunStatus.self, forKey: .status)
        self.queueDepth = queueDepth
        startedAt = try container.decodeIfPresent(String.self, forKey: .startedAt)
        stateChangedAt = try container.decode(String.self, forKey: .stateChangedAt)
        endedAt = try container.decodeIfPresent(String.self, forKey: .endedAt)
        stopReason = try container.decodeIfPresent(String.self, forKey: .stopReason)
        errorClass = try container.decodeIfPresent(String.self, forKey: .errorClass)
        waitingInteractionId = try container.decodeIfPresent(
            String.self,
            forKey: .waitingInteractionId
        )
    }
}

struct SessionRunLocalOverlay: Equatable, Sendable {
    let runId: String
    let status: SessionRunStatus
    let baseSequence: Int?
    let baseRevision: Int?
}

struct SessionRunProjection: Equatable, Sendable {
    var authoritative: SessionRunState? = nil
    var localOverlay: SessionRunLocalOverlay? = nil

    var resolvedStatus: SessionRunStatus? {
        localOverlay?.status ?? authoritative?.status
    }
}

/// 单会话运行态归并器。sequence 识别轮次，revision 识别同轮更新；时间戳只用于展示。
enum SessionRunProjectionReducer {
    static func applying(
        authoritative incoming: SessionRunState,
        to current: SessionRunProjection?
    ) -> SessionRunProjection {
        var result = current ?? SessionRunProjection()
        if let existing = result.authoritative {
            guard incoming.sequence > existing.sequence
                    || (
                        incoming.sequence == existing.sequence
                            && incoming.runId == existing.runId
                            && incoming.revision > existing.revision
                    ) else {
                return result
            }
        }

        result.authoritative = incoming
        if let overlay = result.localOverlay {
            let advancesPastOverlayBase = overlay.baseSequence == nil
                || incoming.sequence > (overlay.baseSequence ?? -1)
                || (
                    incoming.sequence == overlay.baseSequence
                        && incoming.revision > (overlay.baseRevision ?? -1)
                )
            if advancesPastOverlayBase {
                result.localOverlay = nil
            }
        }
        return result
    }

    static func applyingLocal(
        runId: String,
        status: SessionRunStatus,
        beginsNewRun: Bool,
        to current: SessionRunProjection?
    ) -> SessionRunProjection {
        var result = current ?? SessionRunProjection()
        let resolvedRunId = result.localOverlay?.runId ?? result.authoritative?.runId
        let resolvedStatus = result.resolvedStatus

        if result.authoritative?.runId == runId,
           result.authoritative?.status.isTerminal == true {
            return result
        }
        if let resolvedRunId, resolvedRunId != runId {
            guard beginsNewRun else { return result }
        } else if resolvedStatus?.isTerminal == true, !status.isTerminal {
            // 同一轮终态到达后，迟到的 message_start 不得把列表重新点亮。
            return result
        }

        if let overlay = result.localOverlay,
           overlay.runId == runId,
           overlay.status.isTerminal,
           !status.isTerminal {
            return result
        }

        result.localOverlay = SessionRunLocalOverlay(
            runId: runId,
            status: status,
            baseSequence: result.authoritative?.sequence,
            baseRevision: result.authoritative?.revision
        )
        return result
    }

    /// 旧流式 done 没有 run_id 时，若列表已知当前权威 run，仍可短暂显示终态；
    /// 下一条更高 revision 的服务端事实会通过上面的规则撤销该本地覆盖。
    static func applyingLocalTerminalWithoutRunId(
        status: SessionRunStatus,
        to current: SessionRunProjection?
    ) -> SessionRunProjection? {
        guard let runId = current?.authoritative?.runId else { return nil }
        return applyingLocal(
            runId: runId,
            status: status,
            beginsNewRun: false,
            to: current
        )
    }
}

/// 跨 Space 对话列表条目（`GET /chat/sessions/all` 响应里的 sessions 元素）。
/// 附带 agent/space 元信息，便于跨 agent 列表直接渲染。移植自 apps/tabtin-ios 的
/// AllChatSession，保留「最近」tab 的搜索、状态与本地管理所需字段。
struct RecentSession: Codable, Identifiable, Hashable, Sendable {
    let id: String
    var title: String?
    var status: String?
    var isPinned: Bool
    var pinnedAt: String?
    let organizationId: String?
    /// 工具执行仅使用服务端明确返回的 Workspace；`space_id` 不参与路由。
    /// `chat.session.activity.updated` 可跨端回写，故为 var。
    var workspaceId: String?
    var createdAt: String?
    var updatedAt: String?
    var lastMessageAt: String?
    let lastMessagePreview: String?
    let spaceName: String?
    var projectId: String?
    let projectName: String?
    var agentId: String?
    /// 随执行 Agent 切换可变；activity 推送 / 本机 switch 都会回写。
    var agentName: String?
    /// 随执行 Agent 切换可变；与 `agentId` 不同步时会出现「里面换了人、外面还是旧脸」。
    var agentAvatar: String?
    var hasActiveTask: Bool
    /// 后端当前固定返回 false，不能作为未读回复的可靠产品事实。
    var hasUnreadReply: Bool
    /// 最近一轮是否异常结束。当前主要由本机 stream 终态回写；服务端未来补齐同名字段后可直接解码。
    var lastRunFailed: Bool
    /// 服务端权威运行态。`nil` 既可能是显式 null，也可能来自尚未支持该字段的旧后端。
    var runState: SessionRunState?
    var readState: SessionReadState?
    /// 用于区分旧后端缺键与新后端显式 null，避免缓存把兼容路径误当成权威空态。
    private(set) var includesRunState: Bool
    /// keyword 搜索命中消息正文时，服务端返回的上下文片段；不在端上自行摘录或高亮猜测。
    let searchMatchContext: String?
    /// 任务列表锚点工作面（`chat` / `doc` / `browser` / `code`）。旧后端缺键时为 nil，UI 按 chat 渲染。
    let primarySurface: String?

    enum CodingKeys: String, CodingKey {
        case id, title, status
        case isPinned = "is_pinned"
        case pinnedAt = "pinned_at"
        case organizationId = "organization_id"
        case workspaceId = "workspace_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case lastMessageAt = "last_message_at"
        case lastMessagePreview = "last_message_preview"
        case spaceName = "space_name"
        case projectId = "project_id"
        case projectName = "project_name"
        case agentId = "agent_id"
        case agentName = "agent_name"
        case agentAvatar = "agent_avatar"
        case hasActiveTask = "has_active_task"
        case hasUnreadReply = "has_unread_reply"
        case lastRunFailed = "last_run_failed"
        case runState = "run_state"
        case readState = "read_state"
        case searchMatchContext = "search_match_context"
        case primarySurface = "primary_surface"
    }

    /// 跨端 activity / 单测构造最小行用；HTTP 解码仍走 `init(from:)`。
    init(
        id: String,
        title: String? = nil,
        status: String? = nil,
        isPinned: Bool = false,
        pinnedAt: String? = nil,
        organizationId: String? = nil,
        workspaceId: String? = nil,
        createdAt: String? = nil,
        updatedAt: String? = nil,
        lastMessageAt: String? = nil,
        lastMessagePreview: String? = nil,
        spaceName: String? = nil,
        projectId: String? = nil,
        projectName: String? = nil,
        agentId: String? = nil,
        agentName: String? = nil,
        agentAvatar: String? = nil,
        hasActiveTask: Bool = false,
        hasUnreadReply: Bool = false,
        lastRunFailed: Bool = false,
        runState: SessionRunState? = nil,
        readState: SessionReadState? = nil,
        includesRunState: Bool = false,
        searchMatchContext: String? = nil,
        primarySurface: String? = nil
    ) {
        self.id = id
        self.title = title
        self.status = status
        self.isPinned = isPinned
        self.pinnedAt = pinnedAt
        self.organizationId = organizationId
        self.workspaceId = workspaceId
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastMessageAt = lastMessageAt
        self.lastMessagePreview = lastMessagePreview
        self.spaceName = spaceName
        self.projectId = projectId
        self.projectName = projectName
        self.agentId = agentId
        self.agentName = agentName
        self.agentAvatar = agentAvatar
        self.hasActiveTask = hasActiveTask
        self.hasUnreadReply = hasUnreadReply
        self.lastRunFailed = lastRunFailed
        self.runState = runState
        self.readState = readState
        self.includesRunState = includesRunState
        self.searchMatchContext = searchMatchContext
        self.primarySurface = primarySurface
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decodeIfPresent(String.self, forKey: .title)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        isPinned = try c.decodeIfPresent(Bool.self, forKey: .isPinned) ?? false
        pinnedAt = try c.decodeIfPresent(String.self, forKey: .pinnedAt)
        organizationId = try c.decodeIfPresent(String.self, forKey: .organizationId)
        workspaceId = try c.decodeIfPresent(String.self, forKey: .workspaceId)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt)
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        lastMessageAt = try c.decodeIfPresent(String.self, forKey: .lastMessageAt)
        lastMessagePreview = try c.decodeIfPresent(String.self, forKey: .lastMessagePreview)
        spaceName = try c.decodeIfPresent(String.self, forKey: .spaceName)
        projectId = try c.decodeIfPresent(String.self, forKey: .projectId)
        projectName = try c.decodeIfPresent(String.self, forKey: .projectName)
        agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
        agentName = try c.decodeIfPresent(String.self, forKey: .agentName)
        agentAvatar = try c.decodeIfPresent(String.self, forKey: .agentAvatar)
        hasActiveTask = try c.decodeIfPresent(Bool.self, forKey: .hasActiveTask) ?? false
        hasUnreadReply = try c.decodeIfPresent(Bool.self, forKey: .hasUnreadReply) ?? false
        lastRunFailed = try c.decodeIfPresent(Bool.self, forKey: .lastRunFailed) ?? false
        includesRunState = c.contains(.runState)
        runState = try c.decodeIfPresent(SessionRunState.self, forKey: .runState)
        readState = try c.decodeIfPresent(SessionReadState.self, forKey: .readState)
        searchMatchContext = try c.decodeIfPresent(String.self, forKey: .searchMatchContext)
        primarySurface = try c.decodeIfPresent(String.self, forKey: .primarySurface)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(id, forKey: .id)
        try c.encodeIfPresent(title, forKey: .title)
        try c.encodeIfPresent(status, forKey: .status)
        try c.encode(isPinned, forKey: .isPinned)
        try c.encodeIfPresent(pinnedAt, forKey: .pinnedAt)
        try c.encodeIfPresent(organizationId, forKey: .organizationId)
        try c.encodeIfPresent(workspaceId, forKey: .workspaceId)
        try c.encodeIfPresent(createdAt, forKey: .createdAt)
        try c.encodeIfPresent(updatedAt, forKey: .updatedAt)
        try c.encodeIfPresent(lastMessageAt, forKey: .lastMessageAt)
        try c.encodeIfPresent(lastMessagePreview, forKey: .lastMessagePreview)
        try c.encodeIfPresent(spaceName, forKey: .spaceName)
        try c.encodeIfPresent(projectId, forKey: .projectId)
        try c.encodeIfPresent(projectName, forKey: .projectName)
        try c.encodeIfPresent(agentId, forKey: .agentId)
        try c.encodeIfPresent(agentName, forKey: .agentName)
        try c.encodeIfPresent(agentAvatar, forKey: .agentAvatar)
        try c.encode(hasActiveTask, forKey: .hasActiveTask)
        try c.encode(hasUnreadReply, forKey: .hasUnreadReply)
        try c.encode(lastRunFailed, forKey: .lastRunFailed)
        if includesRunState {
            try c.encodeIfPresent(runState, forKey: .runState)
            if runState == nil { try c.encodeNil(forKey: .runState) }
        }
        try c.encodeIfPresent(readState, forKey: .readState)
        try c.encodeIfPresent(searchMatchContext, forKey: .searchMatchContext)
        try c.encodeIfPresent(primarySurface, forKey: .primarySurface)
    }

    mutating func applyAuthoritativeRunState(_ state: SessionRunState?) {
        includesRunState = true
        runState = state
    }

    var displayTitle: String { (title?.isEmpty == false) ? title! : L10n.Recent.newConversation }

    var displayTime: String? {
        guard let raw = lastMessageAt ?? updatedAt ?? createdAt else { return nil }
        return RelativeTime.format(raw)
    }

    var executionWorkspaceId: String? { nonEmpty(workspaceId) }
    var normalizedProjectId: String? { nonEmpty(projectId) }
    var normalizedAgentId: String? { nonEmpty(agentId) }

    private func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

enum RecentConversationTargetResolver {
    static func resolve(_ session: RecentSession, fallbackOrganizationId: String?) -> ConversationTarget? {
        guard let workspaceId = session.executionWorkspaceId else { return nil }
        return ConversationTarget(
            title: session.displayTitle,
            workspaceId: workspaceId,
            organizationId: nonEmpty(session.organizationId) ?? fallbackOrganizationId ?? "",
            agentId: session.normalizedAgentId,
            projectId: session.normalizedProjectId,
            sessionId: session.id
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
        return value
    }
}

struct RecentSessionsQuery: Hashable, Sendable {
    let keyword: String?
    let status: String?
    /// 执行 Workspace 过滤。nil 表示跨全部 Workspace。
    let workspaceId: String?
    /// 运行态过滤（waiting_user / running / failed …）。与 status 正交：
    /// status 是会话生命周期，runStatus 是本轮运行态。
    let runStatus: String?
    let limit: Int

    init(
        keyword: String? = nil,
        status: String? = "active",
        workspaceId: String? = nil,
        runStatus: String? = nil,
        limit: Int = 50
    ) {
        self.keyword = Self.normalized(keyword)
        self.status = Self.normalized(status)
        self.workspaceId = Self.normalized(workspaceId)
        self.runStatus = Self.normalized(runStatus)
        self.limit = max(1, limit)
    }

    func parameters(organizationId: String, offset: Int) -> [String: String] {
        var result = [
            "organization_id": organizationId,
            "limit": String(limit),
            "offset": String(max(0, offset)),
        ]
        if let keyword { result["keyword"] = keyword }
        if let status { result["status"] = status }
        if let workspaceId { result["workspace_id"] = workspaceId }
        if let runStatus { result["run_status"] = runStatus }
        return result
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }
}

enum RecentSessionsListPolicy {
    static func appendUnique(existing: [RecentSession], incoming: [RecentSession]) -> [RecentSession] {
        var ids = Set(existing.map(\.id))
        var merged = existing
        for session in incoming where ids.insert(session.id).inserted { merged.append(session) }
        return merged
    }
}

struct RecentSessionListResponse: Decodable, Sendable {
    let sessions: [RecentSession]
    let total: Int?
    let hasMore: Bool

    enum CodingKeys: String, CodingKey {
        case sessions, total
        case hasMore = "has_more"
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessions = try c.decode([RecentSession].self, forKey: .sessions)
        total = try c.decodeIfPresent(Int.self, forKey: .total)
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
    }
}

// MARK: - 相对时间

/// 轻量相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前（30 天内）/ 月日（30 天后，不含年）。
enum RelativeTime {
    private nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private nonisolated(unsafe) static let isoFallback: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static func format(_ raw: String, now: Date = Date()) -> String? {
        guard let date = iso.date(from: raw) ?? isoFallback.date(from: raw) else { return nil }
        let seconds = now.timeIntervalSince(date)
        if seconds < 0 { return L10n.Common.justNow }
        if seconds < 60 { return L10n.Common.justNow }
        let minutes = Int(seconds / 60)
        if minutes < 60 { return L10n.Common.minutesAgo(minutes) }
        let hours = minutes / 60
        if hours < 24 { return L10n.Common.hoursAgo(hours) }
        let days = hours / 24
        if days == 1 { return L10n.Common.yesterday }
        if days < 30 { return L10n.Common.daysAgo(days) }
        let absolute = DateFormatter()
        absolute.locale = LanguageManager.shared.effectiveLocale
        absolute.setLocalizedDateFormatFromTemplate("Md")
        return absolute.string(from: date)
    }
}
