import Foundation

/// 子 Agent 运行状态。对齐 Electron `SubagentRun.status`。
enum SubagentStatus: String, Sendable {
    case pending
    /// 进 BudgetTracker 排队等 active 槽位（服务端独立事件 `subagent_queued`）。
    case queued
    case running
    case completed
    case failed
    case cancelled

    var isTerminal: Bool {
        self == .completed || self == .failed || self == .cancelled
    }
}

/// `subagent_progress.latest_tool_status` 的实时状态，避免“最新工具”只有名字没有进度。
enum SubagentToolActivityStatus: String, Sendable, Hashable {
    case pending
    case running
    case completed
    case failed
}

/// 子 Agent 派发工具名的规范集合（SSoT，对齐 Electron `SUBAGENT_TOOL_NAMES`）。
/// runtime 把子 Agent 派发工具注册为 `agent`；`task` / `Task` 为历史别名。
let subagentDispatchToolNames: Set<String> = ["agent", "task", "Task"]

/// `agent` 工具是多态的：派发（`prompt`）/ 续跑（`resume_agent_id`）/ 纯状态查询
/// （`check_agent_id`）。只有前两者会产出或延续一个子 Agent run、应在对话内以任务卡呈现；
/// `check_agent_id` 只查不派，不该被当成一次新的派发（对齐 Electron `isSubagentDispatchInput`，
/// ——否则 check 调用会与真实派发块反查到同一个 run，重复成两张相同任务卡）。
///
/// input 缺失（流式早期尚未到达）时先按派发处理，finalize 后自然纠正。
func isSubagentDispatchInput(_ input: [String: Any]?) -> Bool {
    guard let input else { return true }
    if let checkId = input["check_agent_id"] as? String, !checkId.isEmpty { return false }
    return true
}

/// 一条工具步（subagent_progress.tool_history[]）。只取展示必需字段。
struct SubagentToolStep: Sendable, Hashable, Identifiable {
    let toolName: String
    let toolCallId: String?
    let success: Bool
    let elapsedMs: Int?
    let inputSummary: String?
    let outputSummary: String?
    let inputDetail: String?
    let outputDetail: String?
    let error: String?

    var id: String {
        toolCallId ?? "\(toolName)-\(inputSummary ?? "")-\(outputSummary ?? "")-\(success)"
    }
}

/// 子 Agent 的 token / 计费统计。对齐旧版 `SubagentRunStats` / Electron `SubagentCardData.stats`。
struct SubagentRunStats: Sendable, Hashable {
    var durationMs: Int?
    var inputTokens: Int?
    var outputTokens: Int?
    var totalTokens: Int?
    var creditsConsumed: Double?

    var isEmpty: Bool {
        durationMs == nil
            && inputTokens == nil
            && outputTokens == nil
            && totalTokens == nil
            && creditsConsumed == nil
    }
}

/// 子 Agent 内层实时 transcript 条目。来自 `subagent_stream_event.child_event` 递归流，
/// 用于会话行内卡片与独立详情页还原子 Agent 的真实执行记录。
struct SubagentTranscriptItem: Sendable, Hashable, Identifiable {
    enum Kind: String, Sendable {
        case assistant
        case thinking
        case tool
        case richContent
        case contextRef
        case system
        case error
    }

    let id: String
    var messageId: String?
    var index: Int?
    var kind: Kind
    var title: String?
    var text: String?
    var inputText: String?
    var outputText: String?
    var isFinal: Bool
    var isError: Bool
    var toolCallId: String?
    var richContent: RichContentBlock?
    var contextRef: ContextRefBlock?
    /// thinking 段本地打点（客户端观测用，非 wire 字段）。
    var startedAt: Date?
    var stoppedAt: Date?

    init(
        id: String,
        messageId: String? = nil,
        index: Int? = nil,
        kind: Kind,
        title: String? = nil,
        text: String? = nil,
        inputText: String? = nil,
        outputText: String? = nil,
        isFinal: Bool,
        isError: Bool,
        toolCallId: String? = nil,
        richContent: RichContentBlock? = nil,
        contextRef: ContextRefBlock? = nil,
        startedAt: Date? = nil,
        stoppedAt: Date? = nil
    ) {
        self.id = id
        self.messageId = messageId
        self.index = index
        self.kind = kind
        self.title = title
        self.text = text
        self.inputText = inputText
        self.outputText = outputText
        self.isFinal = isFinal
        self.isError = isError
        self.toolCallId = toolCallId
        self.richContent = richContent
        self.contextRef = contextRef
        self.startedAt = startedAt
        self.stoppedAt = stoppedAt
    }
}

/// 子 Agent 一次运行的快照（会话行内卡片 + 独立详情）。
/// 字段对齐 electron `SubagentRun` 子集（agent-tool.ts emit），并额外承载 live transcript。
struct SubagentRun: Sendable, Hashable, Identifiable {
    let runId: String
    var parentToolCallId: String?
    var parentMessageId: String?
    var parentRunId: String?
    var subagentChain: [String]
    var label: String?
    var task: String?
    var status: SubagentStatus
    var stepCount: Int?
    var latestTool: String?
    var latestToolStatus: SubagentToolActivityStatus?
    var latestSuccess: Bool?
    var elapsedMs: Int?
    var summary: String?
    var error: String?
    var errorKind: String?
    var toolHistory: [SubagentToolStep]
    var stats: SubagentRunStats?
    var transcript: [SubagentTranscriptItem]
    var startedAt: Double?
    var endedAt: Double?

    var id: String { runId }

    static func pending(runId: String) -> SubagentRun {
        SubagentRun(
            runId: runId,
            parentToolCallId: nil,
            parentMessageId: nil,
            parentRunId: nil,
            subagentChain: [runId],
            label: nil,
            task: nil,
            status: .pending,
            stepCount: nil,
            latestTool: nil,
            latestToolStatus: nil,
            latestSuccess: nil,
            elapsedMs: nil,
            summary: nil,
            error: nil,
            errorKind: nil,
            toolHistory: [],
            stats: nil,
            transcript: [],
            startedAt: nil,
            endedAt: nil
        )
    }

    /// 标题：label 优先，其次 task 截断，最后兜底。
    var displayTitle: String {
        if let label, !label.isEmpty { return label }
        if let task, !task.isEmpty { return task }
        return "子 Agent"
    }

    var durationMs: Int? {
        if let duration = stats?.durationMs, duration > 0 { return duration }
        if let elapsedMs, elapsedMs > 0 { return elapsedMs }
        if let startedAt, let endedAt, endedAt > startedAt {
            let start = startedAt > 1e12 ? startedAt / 1000 : startedAt
            let end = endedAt > 1e12 ? endedAt / 1000 : endedAt
            return Int((end - start) * 1000)
        }
        return nil
    }

    /// 生命周期事件可能经多个 relay 重复、乱序到达；终态一旦确定不可被 progress/queued 降级。
    mutating func merge(_ event: SubagentEvent) {
        if let parentToolCallId = event.parentToolCallId { self.parentToolCallId = parentToolCallId }
        if let parentMessageId = event.parentMessageId { self.parentMessageId = parentMessageId }
        if let label = event.label { self.label = label }
        if let task = event.task { self.task = task }
        if let startedAt = event.startedAt { self.startedAt = startedAt }
        if let endedAt = event.endedAt { self.endedAt = endedAt }

        let wasTerminal = status.isTerminal
        let isTerminalEvent: Bool
        switch event.kind {
        case .completed, .failed: isTerminalEvent = true
        case .started, .queued, .progress: isTerminalEvent = false
        }
        if !wasTerminal || isTerminalEvent {
            if let stepCount = event.stepCount { self.stepCount = stepCount }
            if let latestTool = event.latestTool { self.latestTool = latestTool }
            if let latestToolStatus = event.latestToolStatus { self.latestToolStatus = latestToolStatus }
            if let latestSuccess = event.latestSuccess { self.latestSuccess = latestSuccess }
            if let elapsedMs = event.elapsedMs { self.elapsedMs = elapsedMs }
            // tool_history 已废弃：工具步与主 Agent 一样走 transcript / stream event。
            if let stats = event.stats { self.stats = stats }
        }

        switch event.kind {
        case .queued:
            if status == .pending || status == .queued {
                status = .queued
            }
        case .started, .progress:
            if !wasTerminal {
                status = .running
                if let summary = event.summary { self.summary = summary }
            }
        case .completed:
            guard !wasTerminal || status == .completed else { return }
            status = .completed
            if latestTool != nil { latestToolStatus = .completed }
            if let summary = event.summary { self.summary = summary }
        case .failed:
            guard !wasTerminal || status == .failed || status == .cancelled else { return }
            status = event.cancelled == true || event.errorKind == "cancelled" ? .cancelled : .failed
            if latestTool != nil { latestToolStatus = .failed }
            error = event.error
            errorKind = event.errorKind
        }
    }
}

/// 子 Agent 事件（WireDecoder 解出 → reducer 透传 → ViewModel 聚合成 SubagentRun）。
///
/// runtime 无 vendored DTO（subagent 不在 wire-codegen 范围），按 agent-tool.ts emit 的字段手解。
struct SubagentEvent: Sendable, Hashable {
    enum Kind: Sendable { case started, queued, progress, completed, failed }

    let kind: Kind
    let runId: String
    var parentToolCallId: String?
    var parentMessageId: String?
    var label: String?
    var task: String?
    var stepCount: Int?
    var latestTool: String?
    var latestToolStatus: SubagentToolActivityStatus?
    var latestSuccess: Bool?
    var elapsedMs: Int?
    var summary: String?
    var error: String?
    var errorKind: String?
    var cancelled: Bool?
    var toolHistory: [SubagentToolStep]
    var stats: SubagentRunStats?
    var startedAt: Double?
    var endedAt: Double?
}

/// `agent.stream.subagent_stream_event` 的拆包结果。
/// payload.child_event 是一条子 Agent 内层 `agent.stream.*` envelope，交给既有 WireDecoder 复用。
struct SubagentStreamEvent: Sendable {
    let runId: String
    var parentRunId: String?
    var subagentChain: [String]
    var childEnvelope: WSEnvelope
}

extension SubagentEvent {
    /// 从原始 envelope 手解 subagent 事件。runId 缺失返回 nil（无法寻址）。
    /// 兼容 `subagent_run_id` / `subagent_id` 两种历史字段名。
    static func decode(kind: Kind, envelope env: WSEnvelope) -> SubagentEvent? {
        let runId = env.payloadString("subagent_run_id") ?? env.payloadString("subagent_id")
        guard let runId, !runId.isEmpty else { return nil }

        let history: [SubagentToolStep] = (env.payload["tool_history"]?.arrayValue ?? []).compactMap { item in
            guard let dict = item as? [String: Any], let name = dict["tool_name"] as? String else { return nil }
            return SubagentToolStep(
                toolName: name,
                toolCallId: string(dict, "tool_call_id", "toolCallId", "id"),
                success: (dict["success"] as? Bool) ?? false,
                elapsedMs: int(dict, "elapsed_ms", "duration_ms", "elapsedMs", "durationMs"),
                inputSummary: string(dict, "input_summary", "inputSummary"),
                outputSummary: string(dict, "output_summary", "outputSummary"),
                inputDetail: detailString(dict, "input_detail", "inputDetail", "input", "input_json"),
                outputDetail: detailString(dict, "output_detail", "outputDetail", "output", "result"),
                error: string(dict, "error", "error_message", "message")
            )
        }

        return SubagentEvent(
            kind: kind,
            runId: runId,
            parentToolCallId: env.payloadString("parent_tool_call_id")
                ?? env.payloadString("parentToolCallId")
                ?? env.payloadString("tool_use_id")
                ?? env.payloadString("toolUseId")
                ?? env.payloadString("tool_call_id")
                ?? env.payloadString("toolCallId"),
            parentMessageId: env.payloadString("parent_message_id")
                ?? env.payloadString("parentMessageId")
                ?? env.payloadString("message_id")
                ?? env.payloadString("messageId"),
            label: env.payloadString("label"),
            task: env.payloadString("task"),
            stepCount: env.payloadInt("step_count"),
            latestTool: env.payloadString("latest_tool"),
            latestToolStatus: env.payloadString("latest_tool_status")
                .flatMap(SubagentToolActivityStatus.init(rawValue:)),
            latestSuccess: env.payloadBool("latest_success"),
            elapsedMs: env.payloadInt("elapsed_ms"),
            summary: env.payloadString("summary") ?? env.payloadString("result"),
            error: env.payloadString("error"),
            errorKind: env.payloadString("error_kind"),
            cancelled: env.payloadBool("cancelled"),
            toolHistory: history,
            stats: decodeStats(from: env),
            startedAt: env.payloadDouble("started_at"),
            endedAt: env.payloadDouble("ended_at")
        )
    }

    private static func decodeStats(from env: WSEnvelope) -> SubagentRunStats? {
        let stats = env.payloadDict("stats") ?? env.payloadDict("usage") ?? [:]
        let decoded = SubagentRunStats(
            durationMs: int(stats, "duration_ms", "durationMs") ?? env.payloadInt("duration_ms"),
            inputTokens: int(stats, "input_tokens", "inputTokens"),
            outputTokens: int(stats, "output_tokens", "outputTokens"),
            totalTokens: int(stats, "total_tokens", "totalTokens"),
            creditsConsumed: double(stats, "credits_consumed", "creditsConsumed", "credits")
        )
        return decoded.isEmpty ? nil : decoded
    }

    private static func string(_ dict: [String: Any], _ keys: String...) -> String? {
        for key in keys {
            guard let value = dict[key] else { continue }
            if let string = value as? String, !string.isEmpty { return string }
            if let int = value as? Int { return String(int) }
            if let double = value as? Double { return String(double) }
        }
        return nil
    }

    private static func int(_ dict: [String: Any], _ keys: String...) -> Int? {
        for key in keys {
            guard let value = dict[key] else { continue }
            if let int = value as? Int { return int }
            if let double = value as? Double { return Int(double) }
            if let string = value as? String, let int = Int(string) { return int }
        }
        return nil
    }

    private static func double(_ dict: [String: Any], _ keys: String...) -> Double? {
        for key in keys {
            guard let value = dict[key] else { continue }
            if let double = value as? Double { return double }
            if let int = value as? Int { return Double(int) }
            if let string = value as? String, let double = Double(string) { return double }
        }
        return nil
    }

    private static func detailString(_ dict: [String: Any], _ keys: String...) -> String? {
        for key in keys {
            guard let value = dict[key] else { continue }
            if let string = value as? String, !string.isEmpty { return string }
            if JSONSerialization.isValidJSONObject(value),
               let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]),
               let string = String(data: data, encoding: .utf8),
               !string.isEmpty {
                return string
            }
        }
        return nil
    }
}

extension SubagentStreamEvent {
    static func decode(envelope env: WSEnvelope) -> SubagentStreamEvent? {
        guard let runId = env.payloadString("subagent_run_id") ?? env.payloadString("subagent_id"),
              !runId.isEmpty,
              let child = env.payloadDict("child_event"),
              let childType = child["type"] as? String,
              !childType.isEmpty,
              let childPayload = child["payload"] as? [String: Any] else {
            return nil
        }

        var childEnvelope = WSEnvelope.build(
            type: childType,
            deviceId: env.deviceId,
            payload: childPayload,
            organizationId: env.organizationId,
            role: env.role,
            threadId: env.threadId,
            traceId: env.traceId,
            requestId: env.requestId
        )
        childEnvelope.eventId = env.eventId
        childEnvelope.topic = env.topic
        childEnvelope.replyTo = env.replyTo
        childEnvelope.sessionId = env.sessionId
        childEnvelope.tableId = env.tableId
        childEnvelope.instanceId = env.instanceId

        let chain = (env.payload["subagent_chain"]?.arrayValue ?? []).compactMap { $0 as? String }
        return SubagentStreamEvent(
            runId: runId,
            parentRunId: env.payloadString("parent_run_id"),
            subagentChain: chain.isEmpty ? [runId] : chain,
            childEnvelope: childEnvelope
        )
    }
}

/// 对齐 Electron `streamMessageHandler`：父 topic 上带 `subagent_run_id` 的 raw
/// `agent.stream.*`（lifecycle / message_* / content_block_*）必须进子 transcript，
/// 绝不能进父 `StreamSession`——否则子 Agent thinking 会灌进主对话气泡。
enum SubagentStreamRouting {
    /// `agent.stream.subagent_*` 元事件与包装事件走既有 decode，不经本门闩改写。
    private static let subagentEventPrefix = "\(AgentStreamEvent.prefix)subagent"

    /// Electron 在隔离 guard 前直接 return 的 persist；iOS 对应落库回执也不该进 transcript。
    private static let parentOnlyShortNames: Set<String> = [
        AgentStreamEvent.messagePersisted,
        AgentStreamEvent.messageCommitted,
        "persist_message",
    ]

    static func subagentRunId(in env: WSEnvelope) -> String? {
        let raw = env.payloadString("subagent_run_id") ?? env.payloadString("subagent_id")
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// 是否应把该 envelope 从父时间线隔离并改写为子流。
    static func shouldIsolateFromParentTimeline(_ env: WSEnvelope) -> Bool {
        guard env.type.hasPrefix(AgentStreamEvent.prefix) else { return false }
        guard subagentRunId(in: env) != nil else { return false }
        if env.type.hasPrefix(subagentEventPrefix) { return false }
        let short = String(env.type.dropFirst(AgentStreamEvent.prefix.count))
        if parentOnlyShortNames.contains(short) { return false }
        return true
    }

    /// 把带 `subagent_run_id` 的 raw 事件改写成 `SubagentStreamEvent`（child = 原事件）。
    static func rewriteAsSubagentStreamEvent(_ env: WSEnvelope) -> SubagentStreamEvent? {
        guard shouldIsolateFromParentTimeline(env),
              let runId = subagentRunId(in: env) else {
            return nil
        }

        var childEnvelope = WSEnvelope.build(
            type: env.type,
            deviceId: env.deviceId,
            payload: env.payloadDict,
            organizationId: env.organizationId,
            role: env.role,
            threadId: env.threadId,
            traceId: env.traceId,
            requestId: env.requestId
        )
        childEnvelope.eventId = env.eventId
        childEnvelope.topic = env.topic
        childEnvelope.replyTo = env.replyTo
        childEnvelope.sessionId = env.sessionId
        childEnvelope.tableId = env.tableId
        childEnvelope.instanceId = env.instanceId

        let chain = (env.payload["subagent_chain"]?.arrayValue ?? []).compactMap { $0 as? String }
        return SubagentStreamEvent(
            runId: runId,
            parentRunId: env.payloadString("parent_run_id"),
            subagentChain: chain.isEmpty ? [runId] : chain,
            childEnvelope: childEnvelope
        )
    }
}
