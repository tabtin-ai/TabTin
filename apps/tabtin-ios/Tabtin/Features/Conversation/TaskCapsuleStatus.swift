import Foundation

/// 对齐 Electron `resolveCapsuleActivity` / runState 工具计数的纯投影。
enum TaskCapsuleActivity {
    /// 当前轮已完成、用户可感知的工具调用数（planning 且 >0 → planningNext）。
    static func completedToolCalls(in messages: [ChatMessage]) -> Int {
        let target = messages.last(where: {
            $0.isAssistant && $0.isStreaming && !$0.isSubagentTranscript
        }) ?? messages.last(where: {
            $0.isAssistant && !$0.isSubagentTranscript
        })
        guard let message = target else { return 0 }
        return message.toolCalls.filter { tool in
            // 与 Electron hideTodoInit 对齐：todo 初始化不计用户可感知工具完成。
            let name = tool.name.lowercased()
            if name.contains("todo") { return false }
            return tool.hasResult || tool.isError || tool.finalized
        }.count
    }

    /// 权威 queue_depth 与本机待发送队列取较大值（对齐 Electron queuedRunIds.length）。
    static func resolveQueuedCount(
        authoritativeQueueDepth: Int?,
        waitingOutgoingCount: Int
    ) -> Int {
        max(max(0, authoritativeQueueDepth ?? 0), max(0, waitingOutgoingCount))
    }

    static func waitingOutgoingCount(in messages: [QueuedOutgoingMessage]) -> Int {
        messages.filter {
            switch $0.status {
            case .waiting, .offline, .sending: return true
            case .accepted, .awaitingDevice, .persistedExecutionFailed, .failed: return false
            }
        }.count
    }

    /// 解析 read_state.readAt 为 seenUntil 水位。
    static func seenUntil(from readState: SessionReadState?) -> Date? {
        guard let raw = readState?.readAt?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else { return nil }
        return parseTimestamp(raw)
    }

    /// 对齐 Electron：统计 `createdAt > seenUntil` 的 assistant 消息数。
    static func unreadAssistantCount(
        messages: [ChatMessage],
        seenUntil: Date
    ) -> Int {
        messages.reduce(into: 0) { count, message in
            guard message.isAssistant, !message.isSubagentTranscript else { return }
            if message.createdAt > seenUntil { count += 1 }
        }
    }

    /// 优先按 readAt 水位计数；无水位但权威未读为真时回落 1（避免全历史膨胀）。
    static func resolveUnreadCount(
        messages: [ChatMessage],
        readState: SessionReadState?
    ) -> Int {
        if let seen = seenUntil(from: readState) {
            let counted = unreadAssistantCount(messages: messages, seenUntil: seen)
            if counted > 0 { return counted }
            if readState?.hasUnreadCompletedReply == true { return 1 }
            return 0
        }
        if readState?.hasUnreadCompletedReply == true { return 1 }
        return 0
    }

    private static func parseTimestamp(_ raw: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: raw) { return date }
        let basic = ISO8601DateFormatter()
        basic.formatOptions = [.withInternetDateTime]
        return basic.date(from: raw)
    }
}

/// 跨端 TaskCapsule 状态投影（对齐 `@tabtin/contracts` resolveTaskCapsuleStatus）。
///
/// 输入 run / HITL / queue / unread / paused，输出 canonical key 与 full/mini/hidden。
/// 仅 `ready` → mini；未读 `complete`、`paused` 及其余活跃/终态 → full。
enum TaskCapsuleStatusKind: String, CaseIterable, Equatable, Sendable {
    case ready
    case preparing
    case queued
    case thinking
    case planningNext
    case working
    case finishing
    case needsApproval
    case needsAnswer
    case paused
    case recovering
    case complete
    case stopped
    case error
}

enum TaskCapsuleRunPhase: String, Equatable, Sendable {
    case planning
    case toolCalls = "tool_calls"
    case synthesizing
    case done
    case error
    case cancelled
}

enum TaskCapsuleVisualKind: String, Equatable, Sendable {
    case full
    case mini
    case hidden
}

struct TaskCapsuleStatusInput: Equatable, Sendable {
    var busy: Bool
    var runPhase: TaskCapsuleRunPhase?
    var completedToolCalls: Int?
    var queuedCount: Int?
    var pendingApproval: Bool?
    var pendingAnswer: Bool?
    var paused: Bool?
    var suspended: Bool?
    var unreadCount: Int?
}

enum TaskCapsuleStatus {
    static func resolve(_ input: TaskCapsuleStatusInput) -> TaskCapsuleStatusKind {
        if input.pendingApproval == true { return .needsApproval }
        if input.pendingAnswer == true { return .needsAnswer }
        if input.paused == true { return .paused }
        if input.suspended == true { return .recovering }

        if input.busy {
            return resolveBusy(input)
        }

        if input.runPhase == .error { return .error }
        if input.runPhase == .cancelled { return .stopped }
        if (input.unreadCount ?? 0) > 0 { return .complete }
        return .ready
    }

    static func resolveVisual(_ status: TaskCapsuleStatusKind) -> TaskCapsuleVisualKind {
        status == .ready ? .mini : .full
    }

    /// Electron 正典中文文案（`chat.json` capsule.status.*）。
    static func statusTitle(
        _ status: TaskCapsuleStatusKind,
        queuedCount: Int = 0,
        unreadCount: Int = 0
    ) -> String {
        switch status {
        case .ready: return "随时待命"
        case .preparing: return "正在准备"
        case .queued: return "等待执行 · \(max(queuedCount, 1)) 项排队"
        case .thinking: return "正在思考"
        case .planningNext: return "计划下一步"
        case .working: return "执行中"
        case .finishing: return "整理结果"
        case .needsApproval: return "等待你确认"
        case .needsAnswer: return "等待你回答"
        case .paused: return "任务已暂停"
        case .recovering: return "连接中断，正在恢复"
        case .complete: return "已完成 · \(max(unreadCount, 1)) 条更新"
        case .stopped: return "已停止"
        case .error: return "遇到问题，点击查看"
        }
    }

    /// 从现有 AgentRunPresentationState 投影到跨端输入（供宿主过渡期使用）。
    static func input(
        from runState: AgentRunPresentationState,
        queuedCount: Int = 0,
        pendingApproval: Bool = false,
        pendingAnswer: Bool = false
    ) -> TaskCapsuleStatusInput {
        let resolvedQueue = max(queuedCount, runState.queuedCount)
        let completedTools = runState.completedToolCalls
        switch runState.phase {
        case .waitingForUser:
            if pendingAnswer {
                return TaskCapsuleStatusInput(busy: false, pendingAnswer: true)
            }
            return TaskCapsuleStatusInput(
                busy: false,
                pendingApproval: pendingApproval || true
            )
        case .recoveringConnection:
            return TaskCapsuleStatusInput(busy: true, suspended: true)
        case .paused:
            return TaskCapsuleStatusInput(busy: false, paused: true)
        case .preparing:
            return TaskCapsuleStatusInput(
                busy: true,
                runPhase: nil,
                completedToolCalls: completedTools,
                queuedCount: resolvedQueue
            )
        case .planning:
            return TaskCapsuleStatusInput(
                busy: true,
                runPhase: .planning,
                completedToolCalls: completedTools,
                queuedCount: resolvedQueue
            )
        case .executing:
            return TaskCapsuleStatusInput(
                busy: true,
                runPhase: .toolCalls,
                completedToolCalls: completedTools,
                queuedCount: resolvedQueue
            )
        case .responding:
            return TaskCapsuleStatusInput(
                busy: true,
                runPhase: .synthesizing,
                completedToolCalls: completedTools,
                queuedCount: resolvedQueue
            )
        case let .completed(hasUnreadReply):
            let count = hasUnreadReply ? max(runState.unreadReplyCount, 1) : 0
            // 完成后若仍有排队：对齐 Electron busy+done+queuedCount → queued。
            if resolvedQueue > 0 {
                return TaskCapsuleStatusInput(
                    busy: true,
                    runPhase: .done,
                    completedToolCalls: completedTools,
                    queuedCount: resolvedQueue,
                    unreadCount: count
                )
            }
            return TaskCapsuleStatusInput(
                busy: false,
                runPhase: .done,
                completedToolCalls: completedTools,
                unreadCount: count
            )
        case .failed:
            return TaskCapsuleStatusInput(busy: false, runPhase: .error)
        case .idle:
            // 本机/权威队列非空时抬成 busy，才能投影到 queued。
            if resolvedQueue > 0 {
                return TaskCapsuleStatusInput(
                    busy: true,
                    runPhase: nil,
                    queuedCount: resolvedQueue
                )
            }
            return TaskCapsuleStatusInput(busy: false, queuedCount: 0)
        }
    }

    private static func resolveBusy(_ input: TaskCapsuleStatusInput) -> TaskCapsuleStatusKind {
        if input.runPhase == .planning {
            return (input.completedToolCalls ?? 0) > 0 ? .planningNext : .thinking
        }
        if input.runPhase == .toolCalls { return .working }
        if input.runPhase == .synthesizing { return .finishing }
        if (input.queuedCount ?? 0) > 0 { return .queued }
        return .preparing
    }
}
