import Foundation

/// iOS Composer 可选择的工作模式。
///
/// 该枚举是移动端发送、队列持久化与后续 Composer 设置页共用的唯一事实源；
/// 旧版的 `yolo` 不是工作模式，读取历史偏好或队列时会安全迁移到 `.agent`。
enum ChatAgentMode: String, CaseIterable, Codable, Sendable {
    case ask
    case agent
    case plan
    case group

    static func resolve(_ rawValue: String?) -> ChatAgentMode {
        guard let rawValue else { return .agent }
        return ChatAgentMode(
            rawValue: rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        ) ?? .agent
    }

    static func isLegacyYolo(_ rawValue: String?) -> Bool {
        rawValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "yolo"
    }
}

/// 工具操作的人类确认强度。它与 `ChatAgentMode` 正交，不能再借由 `yolo` 表达。
enum ChatApprovalMode: String, CaseIterable, Codable, Sendable {
    case alwaysAsk = "always_ask"
    case auto
    case fullAccess = "full_access"

    static func resolve(_ rawValue: String?) -> ChatApprovalMode? {
        guard let rawValue else { return nil }
        return ChatApprovalMode(
            rawValue: rawValue.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        )
    }

    /// 组织未开放宽松审批时，不能让历史偏好或离线队列把本轮静默提权。
    func clamped(permitsRelaxedApproval: Bool) -> ChatApprovalMode {
        permitsRelaxedApproval ? self : .alwaysAsk
    }
}

/// 会话发送所依附的执行作用域。
///
/// 新会话尚未有服务端事实时使用入口选定的 Workspace；已有会话一旦读到服务端
/// 快照，必须以它创建时冻结的 Workspace / Project 为准，不能让“从哪里点进来”
/// 覆盖历史任务的执行位置。
struct ConversationExecutionScope: Equatable, Sendable {
    let workspaceId: String
    let projectId: String?
    let organizationId: String

    static func entry(
        workspaceId: String,
        projectId: String?,
        organizationId: String
    ) -> ConversationExecutionScope {
        ConversationExecutionScope(
            workspaceId: workspaceId,
            projectId: projectId,
            organizationId: organizationId
        )
    }

    /// `workspace_id` 是已有会话的必备冻结事实；旧服务端快照若未提供它，才安全
    /// 回退入口值。`project_id` 可合法为 nil（个人会话），因此只要 Workspace
    /// 存在就严格保留服务端的 nil，不能从入口误补成 Project 会话。
    static func resolvingFrozenSession(
        workspaceId: String?,
        projectId: String?,
        organizationId: String?,
        fallback: ConversationExecutionScope
    ) -> ConversationExecutionScope {
        guard let workspaceId = nonEmpty(workspaceId) else { return fallback }
        return ConversationExecutionScope(
            workspaceId: workspaceId,
            projectId: nonEmpty(projectId),
            organizationId: nonEmpty(organizationId) ?? fallback.organizationId
        )
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// 一条待发送消息冻结的运行配置。
///
/// `migrating` 同时承担旧 UserDefaults / SwiftData 记录的兼容：旧 `yolo` 会转为
/// `.agent`，并在组织允许时保留为 `.auto` 的审批体验；不允许时一律夹回
/// `.alwaysAsk`。因此任何路径都不会再把 `yolo` 写进 `chat.send_message.agent_mode`。
struct ConversationRuntimeConfiguration: Equatable, Sendable {
    let agentMode: ChatAgentMode
    let approvalMode: ChatApprovalMode

    init(
        agentMode: ChatAgentMode = .agent,
        approvalMode: ChatApprovalMode = .alwaysAsk
    ) {
        self.agentMode = agentMode
        self.approvalMode = approvalMode
    }

    static func migrating(
        agentMode rawAgentMode: String?,
        approvalMode rawApprovalMode: String?,
        permitsRelaxedApproval: Bool
    ) -> ConversationRuntimeConfiguration {
        let normalized = normalizedForStorage(
            agentMode: rawAgentMode,
            approvalMode: rawApprovalMode
        )
        return ConversationRuntimeConfiguration(
            agentMode: normalized.agentMode,
            approvalMode: normalized.approvalMode.clamped(
                permitsRelaxedApproval: permitsRelaxedApproval
            )
        )
    }

    /// 只负责历史值归一化，不根据当前组织权限丢弃用户原先选择。
    /// 队列读取时再应用 `migrating` 的运行时安全夹取，权限恢复后仍可保留原来的配置。
    static func normalizedForStorage(
        agentMode rawAgentMode: String?,
        approvalMode rawApprovalMode: String?
    ) -> ConversationRuntimeConfiguration {
        let migratedYolo = ChatAgentMode.isLegacyYolo(rawAgentMode)
        let resolvedAgentMode = ChatAgentMode.resolve(rawAgentMode)
        let requestedApproval = ChatApprovalMode.resolve(rawApprovalMode)
            ?? (migratedYolo ? .auto : .alwaysAsk)
        return ConversationRuntimeConfiguration(
            agentMode: resolvedAgentMode,
            approvalMode: requestedApproval
        )
    }

    /// 构造与 Django `chat.send_message` 契约对齐的可测试纯载荷。
    /// 两个运行配置字段均显式发送，避免队列重试时回退到“当前 UI 选择”。
    /// `focusSnapshot` 必须是入队时冻结的副本；重试不得读取此刻工作台导航。
    func chatSendPayload(
        sessionId: String,
        message: String,
        clientEventId: String,
        modelId: String,
        blocks: [[String: Any]]?,
        userTimeZone: String,
        focusSnapshot: FocusSnapshot? = nil
    ) -> [String: Any] {
        var appContext: [String: Any]
        if let focusSnapshot {
            appContext = focusSnapshot.asAppContextDictionary(userTimeZoneFallback: userTimeZone)
        } else {
            appContext = [
                "userTimeZone": userTimeZone,
                "user_time_zone": userTimeZone,
            ]
        }
        var payload: [String: Any] = [
            "session_id": sessionId,
            "message": message,
            "client_event_id": clientEventId,
            "model_id": modelId,
            "agent_mode": agentMode.rawValue,
            "approval_mode": approvalMode.rawValue,
            "app_context": appContext,
        ]
        if let blocks, !blocks.isEmpty {
            payload["blocks"] = blocks
        }
        return payload
    }
}
