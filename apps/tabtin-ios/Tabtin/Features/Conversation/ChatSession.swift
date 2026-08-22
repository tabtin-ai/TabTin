import Foundation

/// 后端聊天会话实体（区别于视图模型态 ChatMessage）。一个 Space 下可有多个 session；
/// bot Space 通常带一个默认 session。精简移植：只保留解析默认会话 + 展示标题所需字段。
struct ChatSession: Codable, Identifiable, Hashable, Sendable {
    let id: String
    let title: String?
    let status: String?
    let isPaused: Bool?
    let organizationId: String?
    let projectId: String?
    let workspaceId: String?
    let agentId: String?
    let agentMode: String?
    let approvalMode: String?
    let currentModelId: String?
    let currentModelName: String?
    let defaultModelId: String?
    let defaultModelName: String?
    let contextTierId: String?
    /// 会话级模型参数意图（v2 只读 `thinking_mode`）；旧后端缺键时为 nil。
    let modelParamOverrides: ChatModelParamOverrides?
    let createdAt: String?
    let lastMessageAt: String?
    let updatedAt: String?
    let forkedFromId: String?
    let forkPointMessageId: String?
    let forkCount: Int?
    let forkCopyStatus: String?
    let warnings: [String]?
    /// 会话详情与列表共用的服务端权威运行态。旧后端缺键时为 nil。
    let runState: SessionRunState?
    let readState: SessionReadState?

    enum CodingKeys: String, CodingKey {
        case id, title, status
        case isPaused = "is_paused"
        case organizationId = "organization_id"
        case workspaceId = "workspace_id"
        case projectId = "project_id"
        case agentId = "agent_id"
        case agentMode = "agent_mode"
        case approvalMode = "approval_mode"
        case currentModelId = "current_model_id"
        case currentModelName = "current_model_name"
        case defaultModelId = "default_model_id"
        case defaultModelName = "default_model_name"
        case contextTierId = "context_tier_id"
        case modelParamOverrides = "model_param_overrides"
        case createdAt = "created_at"
        case lastMessageAt = "last_message_at"
        case updatedAt = "updated_at"
        case forkedFromId = "forked_from_id"
        case forkPointMessageId = "fork_point_message_id"
        case forkCount = "fork_count"
        case forkCopyStatus = "fork_copy_status"
        case runState = "run_state"
        case readState = "read_state"
        case warnings
    }

    /// 已有会话必须使用服务端持久化的执行作用域；入口作用域仅为旧快照缺
    /// `workspace_id` 时的兼容回退，不能反向覆盖已冻结的 Workspace / Project。
    func executionScope(
        fallback: ConversationExecutionScope
    ) -> ConversationExecutionScope {
        ConversationExecutionScope.resolvingFrozenSession(
            workspaceId: workspaceId,
            projectId: projectId,
            organizationId: organizationId,
            fallback: fallback
        )
    }
}

struct ChatSessionListResponse: Decodable, Sendable {
    let sessions: [ChatSession]
    let total: Int?
}

struct SwitchChatSessionModelResponse: Decodable, Sendable {
    let currentModelId: String
    let contextTierId: String?

    enum CodingKeys: String, CodingKey {
        case currentModelId = "current_model_id"
        case contextTierId = "context_tier_id"
    }
}

struct SwitchChatSessionContextTierResponse: Decodable, Sendable {
    let currentTierId: String?

    enum CodingKeys: String, CodingKey {
        case currentTierId = "current_tier_id"
    }
}

struct UpdateChatSessionModelParamsResponse: Decodable, Sendable {
    let modelParamOverrides: ChatModelParamOverrides

    enum CodingKeys: String, CodingKey {
        case modelParamOverrides = "model_param_overrides"
    }
}

/// 把 Workspace 解析成一个可对话的 sessionId：取最近活跃 session，无则创建一个。
/// Chat API 直返（非 {success,data} 信封），APIClient.autoUnwrap 会自动兜底直接解码。
enum ChatSessionResolver {
    static func resolve(workspaceId: String, organizationId: String) async throws -> String {
        let resp: ChatSessionListResponse = try await APIClient.shared.get(
            path: Endpoints.Chat.sessions,
            query: sessionScopeQuery(workspaceId: workspaceId, status: "active")
        )
        let sorted = resp.sessions.sorted {
            ($0.lastMessageAt ?? $0.updatedAt ?? "") > ($1.lastMessageAt ?? $1.updatedAt ?? "")
        }
        if let first = sorted.first { return first.id }

        return try await create(workspaceId: workspaceId, organizationId: organizationId)
    }

    /// 强制新建一个 session（➕ 新建对话）。
    ///
    /// agent-first 契约（release-20260609 起，见  / 总 tracking ）：
    /// - `agent_id` 必填，缺省会以「Agent ID 非法」400 拒绝；
    /// - 可执行任务必须带 `workspace_id`，否则会话被建成 observer，
    ///   发消息时在 `resolve_effective_runtime_config` 以
    ///   「observer 会话未绑定 Workspace，不能执行工具」失败（见 ）。
    static func create(
        workspaceId: String,
        organizationId: String,
        agentId: String? = nil,
        projectId: String? = nil,
        sessionId: String? = nil,
        modelId: String? = nil,
        agentMode: ChatAgentMode? = nil,
        approvalMode: ChatApprovalMode? = nil
    ) async throws -> String {
        guard let resolvedAgentId = await resolveExecutionAgentId(
            workspaceId: workspaceId,
            explicit: agentId
        ) else {
            throw APIError.apiError("该 Workspace 暂无可用 Agent，无法新建对话")
        }
        var body: [String: Any] = [
            "organization_id": organizationId,
            "agent_id": resolvedAgentId,
            "workspace_id": workspaceId,
        ]
        if let sessionId, !sessionId.isEmpty {
            // 草稿 UUID 同时作为服务端 Session UUID：POST 响应丢失后重试仍命中同一行。
            body["session_id"] = sessionId
        }
        if let modelId, !modelId.isEmpty {
            body["model_id"] = modelId
        }
        if let agentMode {
            body["agent_mode"] = agentMode.rawValue
        }
        if let approvalMode {
            body["approval_mode"] = approvalMode.rawValue
        }
        if let projectId, !projectId.isEmpty {
            body["project_id"] = projectId
        }
        let created: ChatSession = try await APIClient.shared.post(
            path: Endpoints.Chat.sessions,
            body: body
        )
        return created.id
    }

    /// 解析建会话应绑定的执行 Agent id（agent-first 契约要求）。按可信度从高到低：
    /// 1. 显式指定（多 Agent 时用户在 picker 选的，或调用方已知）；
    /// 2. `WorkspaceStore` 已缓存的 Workspace 记录中的 `primaryAgentId`；
    ///    后端 `_serialize_space_data` 经执行绑定解析下发）；
    /// 3. 缓存缺该 Workspace 时拉详情兜底；
    /// 4. 复用该 Workspace 最近一条会话的 `agentId`。
    /// 都拿不到返回 nil，由调用方给出「无可用 Agent」友好提示，而非透传后端原始错。
    private static func resolveExecutionAgentId(
        workspaceId: String,
        explicit: String?
    ) async -> String? {
        if let explicit, !explicit.isEmpty { return explicit }

        if let agentId = await resolveWorkspaceRecord(workspaceId: workspaceId)?.primaryAgentId,
           !agentId.isEmpty {
            return agentId
        }

        if let resp: ChatSessionListResponse = try? await APIClient.shared.get(
            path: Endpoints.Chat.sessions,
            query: sessionScopeQuery(workspaceId: workspaceId, status: "active")
        ) {
            let recent = resp.sessions.sorted {
                ($0.lastMessageAt ?? $0.updatedAt ?? "") > ($1.lastMessageAt ?? $1.updatedAt ?? "")
            }
            if let agentId = recent.compactMap(\.agentId).first(where: { !$0.isEmpty }) {
                return agentId
            }
        }

        return nil
    }

    /// `Space` 是当前网络模型的实现壳类型；本方法只接受明确的 Workspace ID。
    private static func resolveWorkspaceRecord(workspaceId: String) async -> Space? {
        let cached = await MainActor.run {
            WorkspaceStore.shared.spaces.first(where: { $0.id == workspaceId && $0.isExecutionSpace })
        }
        if let cached { return cached }
        let record: WorkspaceSummary? = try? await APIClient.shared.get(
            path: Endpoints.Context.workspace(workspaceId)
        )
        return record?.asSpace()
    }

    private static func sessionScopeQuery(workspaceId: String, status: String) -> [String: String] {
        ["status": status, "limit": "50", "workspace_id": workspaceId]
    }

    static func fork(sessionId: String, messageId: String?) async throws -> ChatSession {
        var body: [String: Any] = [:]
        if let messageId, !messageId.isEmpty {
            body["message_id"] = messageId
        }
        return try await APIClient.shared.post(
            path: Endpoints.Chat.sessionFork(sessionId),
            body: body
        )
    }

    static func rename(sessionId: String, title: String) async throws -> ChatSession {
        try await APIClient.shared.put(
            path: Endpoints.Chat.session(sessionId),
            body: ["title": title]
        )
    }

    /// ：即时同步 Composer 工作方式到服务端 `ChatSession.agent_mode`。
    static func updateAgentMode(sessionId: String, agentMode: ChatAgentMode) async throws -> ChatSession {
        try await APIClient.shared.put(
            path: Endpoints.Chat.session(sessionId),
            body: ["agent_mode": agentMode.rawValue]
        )
    }

    /// 修改个人 Workspace 会话后续轮次使用的执行 Agent。
    ///
    /// 正在运行的轮次仍由服务端运行快照保持原 Agent；本更新只影响排队消息与下一轮。
    /// 团队 Space 会话的可变性由界面层按 ``ConversationAgentSelectionPolicy`` 收口。
    static func switchAgent(sessionId: String, agentId: String) async throws -> ChatSession {
        try await APIClient.shared.put(
            path: Endpoints.Chat.session(sessionId),
            body: ["agent_id": agentId]
        )
    }

    static func switchModel(
        sessionId: String,
        modelId: String,
        contextTierId: String? = nil
    ) async throws -> SwitchChatSessionModelResponse {
        var body: [String: Any] = ["model_id": modelId]
        if let contextTierId {
            body["context_tier_id"] = contextTierId
        }
        return try await APIClient.shared.put(
            path: Endpoints.Chat.sessionModel(sessionId),
            body: body
        )
    }

    /// 切换会话上下文档位；`tierId` 传 nil 或空字符串重置为默认档。
    static func switchContextTier(
        sessionId: String,
        tierId: String?
    ) async throws -> String? {
        let normalized = tierId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let body: [String: Any] = [
            "context_tier_id": (normalized?.isEmpty == false) ? (normalized as Any) : NSNull()
        ]
        let response: SwitchChatSessionContextTierResponse = try await APIClient.shared.put(
            path: Endpoints.Chat.sessionContextTier(sessionId),
            body: body
        )
        return response.currentTierId
    }

    /// 写入会话级 `model_param_overrides`（v2：`thinking_mode`）。
    ///
    /// 后端整表替换：须传入 `preserving` 以保留桌面端已写的 `performance_profile`。
    static func updateModelParams(
        sessionId: String,
        thinkingMode: ChatModelThinkingMode,
        preserving existing: ChatModelParamOverrides? = nil
    ) async throws -> ChatModelParamOverrides {
        let overrides = ChatModelParamOverrides.thinkingModeV2(
            thinkingMode,
            preserving: existing
        )
        let response: UpdateChatSessionModelParamsResponse = try await APIClient.shared.put(
            path: Endpoints.Chat.sessionModelParams(sessionId),
            body: ["model_param_overrides": overrides.transportDictionary]
        )
        return response.modelParamOverrides
    }
}

/// 与 Electron 一致的会话执行 Agent 可变性边界。
///
/// 个人 Workspace 的草稿和正式会话都可切换；团队 Space 的执行归属不由单会话改写。
/// Project 成员自己的执行 Workspace 仍属于个人 Workspace，因此保持可切换。
enum ConversationAgentSelectionPolicy {
    static func canChange(
        isTeamSpace: Bool,
        isFirstSendInFlight: Bool,
        isUpdating: Bool
    ) -> Bool {
        !isTeamSpace
            && !isFirstSendInFlight
            && !isUpdating
    }
}
