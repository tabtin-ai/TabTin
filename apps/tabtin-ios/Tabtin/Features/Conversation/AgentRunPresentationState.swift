import Foundation

/// Agent Runtime 的跨页面展示语义。
///
/// 任务首页与会话页都从这里取状态，不再各自拼 `isStreaming`、`phase`、HITL 和错误。
/// 该类型不含 SwiftUI 颜色或布局，因此可以独立单测，也便于未来替换 Runtime 状态来源。
struct AgentRunPresentationState: Equatable, Sendable {
    enum Phase: Equatable, Sendable {
        case idle
        case preparing
        case planning
        case executing
        case responding
        case waitingForUser(count: Int)
        case paused
        case recoveringConnection
        case completed(hasUnreadReply: Bool)
        case failed
    }

    enum Recovery: Equatable, Sendable {
        case retry
        case checkBilling
        case relogin
        case newConversation
    }

    let phase: Phase
    let currentAction: String?
    let failureReason: String?
    let recovery: Recovery?
    /// 完成后未读条数（对齐 Electron capsule unreadCount）；非完成态为 0。
    let unreadReplyCount: Int
    /// 当前轮已完成工具数（planning 且 >0 → planningNext）。
    let completedToolCalls: Int
    /// 排队中的后继任务数（权威 queue_depth 或本机出站队列）。
    let queuedCount: Int

    static let idle = AgentRunPresentationState(
        phase: .idle,
        currentAction: nil,
        failureReason: nil,
        recovery: nil,
        unreadReplyCount: 0,
        completedToolCalls: 0,
        queuedCount: 0
    )

    init(
        phase: Phase,
        currentAction: String?,
        failureReason: String?,
        recovery: Recovery?,
        unreadReplyCount: Int = 0,
        completedToolCalls: Int = 0,
        queuedCount: Int = 0
    ) {
        self.phase = phase
        self.currentAction = currentAction
        self.failureReason = failureReason
        self.recovery = recovery
        self.unreadReplyCount = max(0, unreadReplyCount)
        self.completedToolCalls = max(0, completedToolCalls)
        self.queuedCount = max(0, queuedCount)
    }

    /// 附加胶囊投影指标（工具完成数 / 排队 / 未读），不改 phase。
    func withCapsuleMetrics(
        completedToolCalls: Int,
        queuedCount: Int,
        unreadReplyCount: Int? = nil
    ) -> AgentRunPresentationState {
        AgentRunPresentationState(
            phase: phase,
            currentAction: currentAction,
            failureReason: failureReason,
            recovery: recovery,
            unreadReplyCount: unreadReplyCount ?? self.unreadReplyCount,
            completedToolCalls: completedToolCalls,
            queuedCount: queuedCount
        )
    }

    /// 会话页实时态。优先级体现用户当下最需要知道的事情：
    /// 连接恢复 > 等待用户 > 暂停 > 正在执行 > 上一轮失败。
    ///
    /// `connectionRecoveryOwnedByBanner` / `blockingHITLOwnedByPanel`：当**可见的**
    /// 独立 UI（恢复 Banner、阻断型 HITL 面板）承担同一事实时，Dock/胶囊让位。
    /// 工作台聚焦导致对话面板不可见时，调用方必须传 `false`，否则胶囊会丢掉
    /// needsApproval / needsAnswer / recovering。
    static func conversation(
        rawPhase: String?,
        isStreaming: Bool,
        isPaused: Bool,
        pendingInteractionCount: Int,
        connectionInterrupted: Bool,
        currentAction: String?,
        failure: AgentRunFailurePresentation?,
        authoritativeRunStatus: SessionRunStatus? = nil,
        hasUnreadReply: Bool = false,
        unreadReplyCount: Int = 0,
        connectionRecoveryOwnedByBanner: Bool = false,
        blockingHITLOwnedByPanel: Bool = false
    ) -> AgentRunPresentationState {
        let resolvedUnreadCount = hasUnreadReply ? max(unreadReplyCount, 1) : 0

        if connectionInterrupted, !connectionRecoveryOwnedByBanner {
            return AgentRunPresentationState(
                phase: .recoveringConnection,
                currentAction: nil,
                failureReason: nil,
                recovery: nil
            )
        }

        if pendingInteractionCount > 0, !blockingHITLOwnedByPanel {
            return AgentRunPresentationState(
                phase: .waitingForUser(count: pendingInteractionCount),
                currentAction: nil,
                failureReason: nil,
                recovery: nil
            )
        }

        if isPaused {
            return AgentRunPresentationState(
                phase: .paused,
                currentAction: normalized(currentAction),
                failureReason: nil,
                recovery: nil
            )
        }

        if isStreaming {
            let normalizedPhase = normalized(rawPhase)?.lowercased()
            let action = normalized(currentAction)

            if Self.failurePhases.contains(normalizedPhase ?? "") {
                return failed(failure)
            }
            // Agent 的 phase 是当前事实；工具名可能由前一个 execution delta 迟到，
            // 不能因此把新一段 thinking 误投影成 wrench / 执行态。
            if Self.thinkingPhases.contains(normalizedPhase ?? "") {
                return AgentRunPresentationState(
                    phase: .planning,
                    currentAction: nil,
                    failureReason: nil,
                    recovery: nil
                )
            }
            if action != nil {
                return AgentRunPresentationState(
                    phase: .executing,
                    currentAction: action,
                    failureReason: nil,
                    recovery: nil
                )
            }

            let phase: Phase
            switch normalizedPhase {
            // Thinking / reasoning 是 Agent 自己的推理过程，不是工具调用。把它归到
            // planning，令状态栏继续使用 Brain，而不是执行态的 wrench。
            case "planning", "plan", "thinking", "thought", "reasoning", "reason":
                phase = .planning
            // Wire lifecycle 只有 start/end/…，没有 planning。Electron / Android 都把
            // start 抬成 planning；nil 则是乐观气泡刚建、stream 尚未写 phase。
            // 若落到 preparing，会与气泡里的「思考中…」长期叠成冗余底栏。
            case "start", "turn_start", "running", .none:
                phase = .planning
            case "executing", "execution", "tool", "tool_use", "calling_tool":
                phase = .executing
            case "responding", "response", "generating", "message", "done", "end", "completed":
                phase = .responding
            case "preparing", "queued", "pending":
                phase = .preparing
            default:
                // 未知 wire 相位在流式中按 planning 处理，避免误显示「正在准备…」。
                phase = .planning
            }
            return AgentRunPresentationState(
                phase: phase,
                currentAction: nil,
                failureReason: nil,
                recovery: nil
            )
        }

        // 冷启动或从别端打开会话时，消息 projector 尚未收到本轮 stream，不能因此
        // 把服务端明确的运行事实降成 idle。气泡 streaming 仍只由 projector 决定；
        // 这里仅为会话头部和控制区提供粗粒度权威兜底。
        if let authoritativeRunStatus {
            return sessionSummary(
                runStatus: authoritativeRunStatus,
                hasUnreadReply: hasUnreadReply,
                unreadReplyCount: resolvedUnreadCount
            )
        }

        if let failure {
            return failed(failure)
        }

        if resolvedUnreadCount > 0 {
            return AgentRunPresentationState(
                phase: .completed(hasUnreadReply: true),
                currentAction: nil,
                failureReason: nil,
                recovery: nil,
                unreadReplyCount: resolvedUnreadCount
            )
        }

        return .idle
    }

    /// 任务首页来自服务端聚合字段，只表达有证据的粗粒度状态，不伪造具体 Runtime phase。
    static func sessionSummary(
        hasActiveTask: Bool,
        hasUnreadReply: Bool,
        hasPendingInteraction: Bool,
        hasFailedTask: Bool = false
    ) -> AgentRunPresentationState {
        if hasPendingInteraction {
            return AgentRunPresentationState(
                phase: .waitingForUser(count: 1),
                currentAction: nil,
                failureReason: nil,
                recovery: nil
            )
        }
        if hasActiveTask {
            return AgentRunPresentationState(
                phase: .executing,
                currentAction: nil,
                failureReason: nil,
                recovery: nil
            )
        }
        if hasFailedTask {
            return failed(nil)
        }
        if hasUnreadReply {
            return AgentRunPresentationState(
                phase: .completed(hasUnreadReply: true),
                currentAction: nil,
                failureReason: nil,
                recovery: nil,
                unreadReplyCount: 1
            )
        }
        return .idle
    }

    /// 新版服务端运行投影。完成后的“未读”仍暂借通知已读态，不能反向改写运行状态。
    static func sessionSummary(
        runStatus: SessionRunStatus,
        hasUnreadReply: Bool,
        unreadReplyCount: Int = 0
    ) -> AgentRunPresentationState {
        let phase: Phase
        switch runStatus {
        case .queued, .running, .cancelling:
            phase = .executing
        case .waitingUser:
            phase = .waitingForUser(count: 1)
        case .paused:
            phase = .paused
        case .completed:
            phase = .completed(hasUnreadReply: hasUnreadReply)
        case .failed:
            phase = .failed
        case .cancelled, .interrupted:
            phase = .idle
        }
        let count = hasUnreadReply ? max(unreadReplyCount, 1) : 0
        return AgentRunPresentationState(
            phase: phase,
            currentAction: nil,
            failureReason: nil,
            recovery: nil,
            unreadReplyCount: count
        )
    }

    var isVisibleInConversationHeader: Bool {
        switch phase {
        case .idle, .completed:
            return false
        default:
            return true
        }
    }

    var isVisibleInTaskRow: Bool {
        switch phase {
        case .idle, .completed(hasUnreadReply: false):
            return false
        default:
            return true
        }
    }

    var isActive: Bool {
        switch phase {
        case .preparing, .planning, .executing, .responding, .recoveringConnection:
            return true
        default:
            return false
        }
    }

    private static let failurePhases: Set<String> = ["error", "failed", "failure"]
    private static let thinkingPhases: Set<String> = [
        "planning", "plan", "thinking", "thought", "reasoning", "reason",
    ]

    private static func failed(
        _ failure: AgentRunFailurePresentation?
    ) -> AgentRunPresentationState {
        AgentRunPresentationState(
            phase: .failed,
            currentAction: nil,
            failureReason: failure?.reason,
            recovery: failure?.recovery ?? .retry
        )
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }
}

/// 从最近一条助手消息提取失败和下一步。用户主动停止不属于失败，不生成该状态。
struct AgentRunFailurePresentation: Equatable, Sendable {
    let reason: String?
    let recovery: AgentRunPresentationState.Recovery?

    init?(
        errorMessage: String?,
        errorClass: String?,
        errorCategory: String?,
        errorCode: String?,
        suggestedAction: String?,
        stopReason: String?
    ) {
        let evidence = [
            errorMessage,
            errorClass,
            errorCategory,
            errorCode,
            suggestedAction,
        ]
        .compactMap(Self.normalized)

        guard !evidence.isEmpty else { return nil }

        let classification = ([stopReason].compactMap(Self.normalized) + evidence)
            .compactMap(Self.normalized)
            .joined(separator: " ")
            .lowercased()

        if classification.contains("abort") || classification.contains("cancelled") {
            return nil
        }

        reason = Self.normalized(errorMessage)
        recovery = Self.recovery(
            suggestedAction: suggestedAction,
            classification: classification
        )
    }

    private static func recovery(
        suggestedAction: String?,
        classification: String
    ) -> AgentRunPresentationState.Recovery? {
        switch normalized(suggestedAction)?.lowercased() {
        case "check_billing":
            return .checkBilling
        case "relogin":
            return .relogin
        case "shorten_context":
            return .newConversation
        default:
            break
        }

        if classification.contains("context_overflow")
            || classification.contains("token_budget")
            || classification.contains("iteration_budget") {
            return .newConversation
        }
        if classification.contains("billing")
            || classification.contains("quota")
            || classification.contains("credit")
            || classification.contains("budget")
            || classification.contains("member_") {
            return .checkBilling
        }
        if classification.contains("auth")
            || classification.contains("unauthorized")
            || classification.contains("relogin") {
            return .relogin
        }
        return .retry
    }

    private static func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let trimmed, !trimmed.isEmpty else { return nil }
        return trimmed
    }
}
