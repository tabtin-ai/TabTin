import Foundation

/// 队列条目的本地动作不是服务端任务控制：
/// - 未送达的记录可以重试或从本机待发送队列移除；
/// - 已受理或已持久化但执行失败的记录只能隐藏本机跟踪，绝不暗示取消了服务端任务。
enum OutgoingQueueLocalAction: Equatable {
    case retry
    case removeUnsent
    case hideAcceptedTracking
}

struct OutgoingQueueActionEligibility: Equatable {
    let primaryAction: OutgoingQueueLocalAction?
    let secondaryAction: OutgoingQueueLocalAction?

    func allows(_ action: OutgoingQueueLocalAction) -> Bool {
        primaryAction == action || secondaryAction == action
    }
}

enum OutgoingQueueTone: Equatable {
    case accent
    case warning
    case critical
}

struct OutgoingQueuePresentation: Equatable {
    let title: String
    let fallbackDetail: String
    let iconName: String
    let tone: OutgoingQueueTone
    let actions: OutgoingQueueActionEligibility

    func label(for action: OutgoingQueueLocalAction) -> String {
        switch action {
        case .retry:
            return "重试"
        case .removeUnsent:
            return "移除待发送"
        case .hideAcceptedTracking:
            return "隐藏本机跟踪"
        }
    }
}

/// 所有队列文案、动作资格与 ACK 状态投影集中在这里，避免 UI 和存储层各自解释同一条记录。
enum OutgoingQueuePolicy {
    /// 队列条可见性：happy-path（发送中 / 已受理）与设备等待态静默，仅异常或 Agent 忙时排队才提示。
    /// `awaitingDevice` 故意隐藏——环境离线由 Composer 井内硬门闩承担（禁发，不再外挂横幅）。
    static func shouldPresentStrip(
        for status: QueuedOutgoingMessageStatus,
        agentBusy: Bool
    ) -> Bool {
        switch status {
        case .offline, .failed, .persistedExecutionFailed:
            return true
        case .waiting:
            return agentBusy
        case .sending, .accepted, .awaitingDevice:
            return false
        }
    }

    /// 按 FIFO 过滤出应对用户展示的队列项（跳过头上的 happy-path 静默态）。
    static func stripMessages(
        _ messages: [QueuedOutgoingMessage],
        agentBusy: Bool
    ) -> [QueuedOutgoingMessage] {
        messages.filter { shouldPresentStrip(for: $0.status, agentBusy: agentBusy) }
    }

    /// 队列条副文案：避免历史 `lastError` 里的 snake_case / `[device_offline]` 直出。
    static func displayDetail(lastError: String?, fallback: String) -> String {
        guard let raw = lastError?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return fallback
        }
        if let bracketed = extractBracketedWireCode(raw),
           let mapped = wireErrorMessages[bracketed] {
            return mapped
        }
        if !looksLikeWireErrorCode(raw) {
            return raw
        }
        let normalized = normalizeWireToken(raw)
        return wireErrorMessages[normalized] ?? fallback
    }

    private static func extractBracketedWireCode(_ value: String) -> String? {
        guard value.hasPrefix("["),
              let end = value.firstIndex(of: "]") else { return nil }
        let inner = value[value.index(after: value.startIndex)..<end]
        let normalized = normalizeWireToken(String(inner))
        return normalized.isEmpty ? nil : normalized
    }

    private static func normalizeWireToken(_ value: String) -> String {
        value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
    }

    private static func looksLikeWireErrorCode(_ value: String) -> Bool {
        let normalized = normalizeWireToken(value)
        guard !normalized.isEmpty else { return false }
        return normalized.range(of: "^[a-z][a-z0-9_]*$", options: .regularExpression) != nil
    }

    /// 队列 / 硬失败路径的事实文案。环境离线禁发文案见 `RemoteExecutionNoticePresentation`。
    private static let wireErrorMessages: [String: String] = [
        "device_offline": "执行设备暂未在线。",
        "device_unreachable": "执行设备暂未在线。",
        "device_dropped": "执行设备暂未在线。",
        "route_failed": "执行设备暂未在线。",
        "route_none": "执行设备暂未在线。",
        "device_busy": "设备正忙，请稍后重试。",
        "runtime_failed": "执行设备暂时不可用，请稍后重试。",
    ]

    static func isAutoDrainEligible(_ status: QueuedOutgoingMessageStatus) -> Bool {
        status == .waiting || status == .offline || status == .sending
    }

    static func isAwaitingExecutionConfirmation(_ status: QueuedOutgoingMessageStatus) -> Bool {
        status == .accepted || status == .awaitingDevice
    }

    /// Realtime 兜底：旧 relay / 旁观恢复路径可能缺 `source_client_event_id`，
    /// 但已经下发 assistant message/content 边界。只有当前本机刚送达的消息能消费这类证据；
    /// 显式带来源的事件交给精确匹配路径，避免借别轮的回复清掉本机跟踪。
    static func isUnattributedExecutionEvidence(
        eventType: String,
        sourceClientEventId: String?,
        activeClientEventId: String?
    ) -> Bool {
        guard let active = nonBlank(activeClientEventId) else { return false }
        guard nonBlank(sourceClientEventId) == nil else { return false }
        let shortType = eventType.hasPrefix(AgentStreamEvent.prefix)
            ? String(eventType.dropFirst(AgentStreamEvent.prefix.count))
            : eventType
        let evidenceTypes: Set<String> = [
            AgentStreamEvent.messageStart,
            AgentStreamEvent.contentBlockStart,
            AgentStreamEvent.contentBlockDelta,
            AgentStreamEvent.contentBlockStop,
            AgentStreamEvent.messageStop,
        ]
        return !active.isEmpty && evidenceTypes.contains(shortType)
    }

    static func presentation(
        for status: QueuedOutgoingMessageStatus,
        queueCount: Int
    ) -> OutgoingQueuePresentation {
        switch status {
        case .waiting:
            return OutgoingQueuePresentation(
                title: queueCount > 1 ? "\(queueCount) 条消息排队中，当前回复结束后发送" : "消息已排队，当前回复结束后发送",
                fallbackDetail: "尚未送达服务端，可从本机待发送队列移除",
                iconName: "clock",
                tone: .accent,
                actions: .init(primaryAction: .removeUnsent, secondaryAction: nil)
            )
        case .offline:
            return OutgoingQueuePresentation(
                title: queueCount > 1 ? "\(queueCount) 条消息等待连接恢复" : "消息等待连接恢复",
                fallbackDetail: "尚未送达服务端，可重试或移除本机待发送消息",
                iconName: "wifi.slash",
                tone: .warning,
                actions: .init(primaryAction: .retry, secondaryAction: .removeUnsent)
            )
        case .sending:
            return OutgoingQueuePresentation(
                title: queueCount > 1 ? "正在发送排队消息（队列共 \(queueCount) 条）" : "正在发送排队消息",
                fallbackDetail: "正在等待发送确认，暂不能移除或重试",
                iconName: "paperplane.fill",
                tone: .accent,
                actions: .init(primaryAction: nil, secondaryAction: nil)
            )
        case .accepted:
            return OutgoingQueuePresentation(
                title: queueCount > 1 ? "消息已送达，正在确认执行状态（队列共 \(queueCount) 条）" : "消息已送达，正在确认执行状态",
                fallbackDetail: "服务端已受理，但尚未确认 Agent 已开始处理；隐藏仅影响本机跟踪，不会取消服务端任务",
                iconName: "clock",
                tone: .warning,
                actions: .init(primaryAction: .hideAcceptedTracking, secondaryAction: nil)
            )
        case .awaitingDevice:
            return OutgoingQueuePresentation(
                title: queueCount > 1 ? "消息已送达，等待执行设备接手（队列共 \(queueCount) 条）" : "消息已送达，等待执行设备接手",
                fallbackDetail: "已送达服务端；隐藏仅影响本机跟踪，不会取消服务端任务",
                iconName: "desktopcomputer",
                tone: .warning,
                actions: .init(primaryAction: .hideAcceptedTracking, secondaryAction: nil)
            )
        case .persistedExecutionFailed:
            return OutgoingQueuePresentation(
                title: queueCount > 1 ? "消息已保存，但执行未启动（队列共 \(queueCount) 条）" : "消息已保存，但执行未启动",
                fallbackDetail: "消息已保存，但执行未启动；隐藏仅影响本机跟踪，不会取消服务端消息",
                iconName: "exclamationmark.triangle.fill",
                tone: .critical,
                actions: .init(primaryAction: .hideAcceptedTracking, secondaryAction: nil)
            )
        case .failed:
            return OutgoingQueuePresentation(
                title: "排队消息发送失败",
                fallbackDetail: "未送达服务端，可重试或移除本机待发送消息",
                iconName: "exclamationmark.triangle.fill",
                tone: .critical,
                actions: .init(primaryAction: .retry, secondaryAction: .removeUnsent)
            )
        }
    }

    /// `delivery` 只说明消息接收情况；`execution_state` 才决定是否在等设备。
    /// 未识别的新值保守投影为 accepted，绝不把已接收的消息降回可删除队列。
    static func statusForAcknowledgedDelivery(
        delivery: String?,
        executionState: String?
    ) -> QueuedOutgoingMessageStatus {
        let normalizedDelivery = normalized(delivery)
        let normalizedExecution = normalized(executionState)
        if normalizedExecution == "failed_after_persist" {
            return .persistedExecutionFailed
        }
        let awaitingDeviceStates: Set<String> = [
            "awaiting_device", "waiting_for_device", "device_offline",
        ]
        if awaitingDeviceStates.contains(normalizedExecution) {
            return .awaitingDevice
        }
        return .accepted
    }

    private static func normalized(_ value: String?) -> String {
        (value ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .replacingOccurrences(of: "-", with: "_")
            .replacingOccurrences(of: " ", with: "_")
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

enum ConversationStopRequestState: Equatable {
    case idle
    case requesting
    case acknowledgedAwaitingTerminal
    case failed
}

enum ConversationStopRequestResult: Equatable {
    case acknowledged
    case rejected(message: String)
    case timedOut
    case disconnected
}

/// 已取消轮次的稳定关联键。允许 Stop ACK 后立即发送下一条，同时精确过滤旧 run
/// 迟到的 message_stop / done，避免它把新轮次误收口。
struct ConversationCancelledRunIdentity: Equatable {
    let clientEventId: String?
    let taskId: String?

    func matches(sourceClientEventId: String?, taskId incomingTaskId: String?) -> Bool {
        (clientEventId != nil && sourceClientEventId == clientEventId)
            || (taskId != nil && incomingTaskId == taskId)
    }
}

/// “停止当前运行”必须由执行端确认；本机 ACK 只表示请求已受理，不代表任务已停止。
enum ConversationStopRequestPolicy {
    /// 发送键就地变成停止键的同一手势窗口。已暂停则允许立刻停止。
    static let accidentalStopGrace: TimeInterval = 0.45

    static func canRequest(
        hasActiveRun: Bool,
        isPaused: Bool,
        state: ConversationStopRequestState,
        pauseControlPending: Bool = false,
        elapsedSinceCanCancel: TimeInterval? = nil
    ) -> Bool {
        // ：正在暂停只锁 pause/resume，不能锁停止 / 撤回。
        guard hasActiveRun || isPaused || pauseControlPending else { return false }
        guard state == .idle || state == .failed else { return false }
        if !isPaused, !pauseControlPending,
           let elapsedSinceCanCancel,
           elapsedSinceCanCancel < accidentalStopGrace {
            return false
        }
        return true
    }

    static func state(after result: ConversationStopRequestResult) -> ConversationStopRequestState {
        switch result {
        case .acknowledged:
            return .acknowledgedAwaitingTerminal
        case .rejected, .timedOut, .disconnected:
            return .failed
        }
    }

    static func message(for result: ConversationStopRequestResult) -> String? {
        switch result {
        case .acknowledged:
            return nil
        case .rejected:
            return "未能停止任务，请重试"
        case .timedOut:
            return "停止请求超时，请重试"
        case .disconnected:
            return "连接不可用，未能停止任务"
        }
    }
}

// MARK: -  暂停两阶段：ACK 已转发 ≠ runtime 已抵达

struct PauseControlPresentation: Equatable {
    let isPaused: Bool
    let isPauseControlPending: Bool
}

enum PauseControlPolicy {
    /// pause ACK 只保持 pending；resume ACK 立刻清暂停。
    static func afterAck(
        requestedPause: Bool,
        ackSucceeded: Bool,
        currentlyPaused: Bool,
        currentlyPending: Bool
    ) -> PauseControlPresentation {
        guard ackSucceeded else {
            return PauseControlPresentation(isPaused: currentlyPaused, isPauseControlPending: false)
        }
        if requestedPause {
            return PauseControlPresentation(isPaused: false, isPauseControlPending: true)
        }
        return PauseControlPresentation(isPaused: false, isPauseControlPending: false)
    }

    /// 「已暂停」只认权威 `run_state.status=paused`。
    /// `sessionRequestedPause` 对应 `ChatSession.is_paused`：请求已发出但尚未抵达时恢复 pending。
    static func afterRunState(
        _ status: SessionRunStatus,
        currentlyPending: Bool,
        sessionRequestedPause: Bool = false
    ) -> PauseControlPresentation {
        let reached = status == .paused
        return PauseControlPresentation(
            isPaused: reached,
            isPauseControlPending: {
                if reached || status.isTerminal { return false }
                return currentlyPending || sessionRequestedPause
            }()
        )
    }
}

// MARK: - 未答轮次撤回：终态对账门控

/// 撤回路径上「是否豁免终态 HTTP 对账」的生命周期。
///
/// 与 `discardingCancelledRun` 分工：
/// - `discardingCancelledRun` / `cancelledRunIdentity`：丢弃旧 run 迟到的 WS 尾事件；
/// - 本门控：决定 `finishCancelledRunTail` → `scheduleTerminalReconcile` → `refreshHistoryFull`
///   是否允许用权威历史把本地已抽掉的轮次拉回。
enum WithdrawTerminalReconcileGate: Equatable, Sendable {
    /// 非撤回 cancel，或已清标记。
    case idle
    /// 已发 `withdraw_unanswered`，等待 `chat.cancel.ok` / `agent.stream.done` 的 `withdraw_applied`。
    case awaitingConfirmation(clientEventId: String)
    /// 服务端确认已物理删除 → 豁免终态对账。
    case exempt(clientEventId: String)
}

enum WithdrawTerminalReconcilePolicy {
    /// 撤回 cancel 发出后进入等待确认。
    static func beginWithdraw(clientEventId: String) -> WithdrawTerminalReconcileGate {
        .awaitingConfirmation(clientEventId: clientEventId)
    }

    /// 应用 ack / done 上的可选 `withdraw_applied`：
    /// - `true` → 豁免终态对账（不得把已撤轮次拉回）
    /// - `false` → 不豁免，清标记走正常 reconcile（竞态拒绝时消息自然回拉）
    /// - `nil`（字段缺失）→ 清等待态、维持旧后端现状对账；若已 exempt 则保持豁免
    static func applySignal(
        _ gate: WithdrawTerminalReconcileGate,
        withdrawApplied: Bool?
    ) -> WithdrawTerminalReconcileGate {
        switch gate {
        case .idle:
            return .idle
        case let .awaitingConfirmation(clientEventId):
            switch withdrawApplied {
            case true?:
                return .exempt(clientEventId: clientEventId)
            case false?, nil:
                return .idle
            }
        case let .exempt(clientEventId):
            switch withdrawApplied {
            case true?:
                return .exempt(clientEventId: clientEventId)
            case false?:
                // 后到的拒绝信号以服务端复判为准，允许后续对账回拉。
                return .idle
            case nil:
                return .exempt(clientEventId: clientEventId)
            }
        }
    }

    /// ACK 失败 / 超时 / 断连：清标记，走现状对账。
    static func clearPending() -> WithdrawTerminalReconcileGate { .idle }

    /// 新一轮发送时清门控，避免误伤下一轮终态对账。
    static func clearForNewSend() -> WithdrawTerminalReconcileGate { .idle }

    /// `true` 时 `scheduleTerminalReconcile` / 其驱动的 `refreshHistoryFull` 应直接跳过。
    static func shouldSuppressTerminalReconcile(_ gate: WithdrawTerminalReconcileGate) -> Bool {
        if case .exempt = gate { return true }
        return false
    }
}
