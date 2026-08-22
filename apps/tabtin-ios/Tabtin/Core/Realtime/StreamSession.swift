import Foundation

struct ChatStreamErrorInfo: Sendable, Hashable {
    var message: String?
    var errorClass: String?
    var suggestedAction: String?
    var errorCategory: String?
    var errorCode: String?

    var hasStructuredFields: Bool {
        errorClass != nil || suggestedAction != nil || errorCategory != nil || errorCode != nil
    }
}

struct MessageIdMapping: Sendable, Hashable {
    let clientEventId: String
    let serverId: String
}

/// Runtime 的 tool lifecycle / progress system notice，按 tool_call_id 合并到既有工具卡。
struct ToolExecutionUpdate: Sendable, Hashable {
    enum Phase: Sendable, Hashable {
        case running
        case succeeded
        case failed
    }

    let toolCallId: String
    let toolName: String
    let phase: Phase
    let outputText: String?
    let durationMs: Int?
    let outputBytes: Int?
    let progressIsTruncated: Bool
    let suspicious: Bool
    let approvalSource: ToolApprovalSource?
    let errorKind: String?
    let taskId: String?
    /// lifecycle notice 上的 `presentation.kind`（如 `media_image_generation`）；可早于 tool_result。
    let presentationKind: String?
    /// `presentation.data.prompt` 预览。
    let presentationPrompt: String?

    static func decode(noticeType: String?, envelope env: WSEnvelope) -> ToolExecutionUpdate? {
        let phase: Phase
        switch noticeType {
        case "tool_started", "tool_pre_started_exec_started", "tool_progress":
            phase = .running
        case "tool_completed", "tool_pre_started_exec_completed":
            phase = .succeeded
        case "tool_failed", "tool_pre_started_exec_failed":
            phase = .failed
        default:
            return nil
        }

        guard let toolCallId = nonBlank(env.payloadString("tool_call_id")),
              let toolName = nonBlank(env.payloadString("tool_name")) else {
            return nil
        }

        let outputText: String?
        if noticeType == "tool_progress" {
            outputText = nonBlankContent(env.payloadString("stdout"))
        } else {
            outputText = nonBlankContent(ToolResultText.from(any: env.payload["output"]?.value))
                ?? nonBlankContent(env.payloadString("output_summary"))
                ?? nonBlankContent(env.payloadString("error_message"))
                ?? nonBlankContent(env.payloadString("error"))
        }

        let presentation = parsePresentation(from: env)

        return ToolExecutionUpdate(
            toolCallId: toolCallId,
            toolName: toolName,
            phase: phase,
            outputText: outputText,
            durationMs: env.payloadInt("duration_ms"),
            outputBytes: env.payloadInt("output_bytes"),
            progressIsTruncated: env.payloadBool("truncated") == true,
            suspicious: env.payloadBool("suspicious") == true,
            approvalSource: approvalSource(from: env),
            errorKind: nonBlank(env.payloadString("error_kind"))
                ?? nonBlank(env.payloadString("error_code")),
            taskId: nonBlank(env.payloadString("task_id")),
            presentationKind: presentation.kind,
            presentationPrompt: presentation.prompt
        )
    }

    /// 对齐 Electron `parseToolPresentation`：读 `payload.presentation.{kind,data.prompt}`。
    private static func parsePresentation(from env: WSEnvelope) -> (kind: String?, prompt: String?) {
        guard let presentation = env.payloadDict("presentation") else { return (nil, nil) }
        let kind = nonBlank(presentation["kind"] as? String)
        let data = presentation["data"] as? [String: Any]
        let prompt = nonBlank(data?["prompt"] as? String)
        return (kind, prompt)
    }

    private static func approvalSource(from env: WSEnvelope) -> ToolApprovalSource? {
        let raw = nonBlank(env.payloadString("approval_source"))
            ?? nonBlank(env.payloadString("permission_source"))
            ?? nonBlank(env.payloadString("permission_decision"))
        switch raw?.lowercased() {
        case "user", "user_approval", "allow_once", "allow":
            return .user
        case "memo", "standing_rule", "always_allow", "allow_always":
            return .standingRule
        default:
            return nil
        }
    }

    private static func nonBlank(_ raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func nonBlankContent(_ raw: String?) -> String? {
        guard let raw,
              !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return raw
    }
}

/// Runtime `agent.stream.context_pressure` 的服务端压力分档。
///
/// 这些值来自 agent-runtime 的 `computePressureStage`，移动端只翻译展示，不按本地
/// token 估算重算，避免系统提示、工具结果或压缩摘要不可见时给出虚假的占用数字。
enum ContextPressureLevel: Hashable, Sendable {
    case none
    case microcompact
    case llmSummary
    case emergency
    case unknown(String)

    init(serverValue: String?) {
        switch serverValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "", nil, "none": self = .none
        case "microcompact", "micro_compact": self = .microcompact
        case "llmsummary", "llm_summary", "summary": self = .llmSummary
        case "emergency": self = .emergency
        case let value?: self = .unknown(value)
        }
    }

    var displayName: String {
        switch self {
        case .none: return "正常"
        case .microcompact: return "接近压缩"
        case .llmSummary: return "建议压缩"
        case .emergency: return "上下文紧张"
        case .unknown: return "运行时提示"
        }
    }
}

struct ContextPressureSnapshot: Hashable, Sendable {
    let pressure: Double?
    let level: ContextPressureLevel
    let estimatedTokens: Int?
    let contextWindow: Int?
    let model: String?

    /// 服务端直接提供的压力比例。仅在有效范围内格式化，绝不在端上反推 token 使用量。
    var percentage: Int? {
        guard let pressure, pressure.isFinite, pressure >= 0, pressure <= 1 else { return nil }
        return Int((pressure * 100).rounded())
    }
}

enum ContextCompactionStatus: Hashable, Sendable {
    case idle
    case inProgress(mode: String?)
    case completed(mode: String?, stats: CompactionStats?)

    var isInProgress: Bool {
        if case .inProgress = self { return true }
        return false
    }
}

/// 将已解码的压力/压缩事件折叠为可观察快照。
///
/// 这是无副作用 reducer：StreamSession 持有它，之后 UI 可按需要投影；当前阶段不发起
/// 手动压缩，也不以本地估算替换 Runtime 事件。
struct ContextRuntimeState: Hashable, Sendable {
    private(set) var latestPressure: ContextPressureSnapshot?
    private(set) var compactionStatus: ContextCompactionStatus = .idle

    mutating func reduce(_ event: AgentContextPressure) {
        latestPressure = ContextPressureSnapshot(
            pressure: event.pressure,
            level: ContextPressureLevel(serverValue: event.level),
            estimatedTokens: event.estimatedTokens,
            contextWindow: event.contextWindow,
            model: event.model
        )
    }

    mutating func reduce(_ event: StreamCompaction) {
        switch event.phase {
        case .start:
            compactionStatus = .inProgress(mode: event.mode)
        case .end:
            compactionStatus = .completed(mode: event.mode, stats: event.stats)
        }
    }

    mutating func reset() {
        latestPressure = nil
        compactionStatus = .idle
    }
}

/// 单轮会话的高层更新（投射给 ConversationViewModel 消费）。
/// 关联值均 Sendable；systemNotice / hitl 透传原始 envelope 供上层精解。
enum StreamUpdate: Sendable {
    /// chat.send_message 收到 ok ACK 后发出：服务端已受理本轮请求。
    /// serverMessageId 为后端回执里的助手消息 id（可能为空，按回包字段而定）。
    case accepted(serverMessageId: String?)
    /// 后端 lifecycle phase 字符串（start / planning / executing / done …），上层决定如何映射 UI 相位。
    case lifecycle(phase: String)
    /// 新一条 assistant 消息开始（message_start）。一轮 agentic 对话可能有多个 message_start，
    /// 每个对应一条独立助手气泡（对齐 Electron / 旧 iOS）；projector 据此建/认领气泡。
    /// role 为 payload 里的消息角色；合成 mini-message（如后台命令终态 tool_result 信封）
    /// 带 role="user"，projector 不为它建气泡。
    case messageStarted(messageId: String?, agentId: String? = nil, role: String? = nil)
    /// 流进行中传输断开（重连中）。由 ConversationViewModel 直接产出（非 reducer），UI 顶部 banner 提示，
    /// 超时预算在此期间挂起。
    case connectionInterrupted
    /// 传输重连成功、已触发 resume 回补。由 ConversationViewModel 直接产出；UI 收起 banner，超时预算恢复。
    case connectionRestored
    /// payload `_seq` 跳号（resume 也没补上的真实缺口）。由 ConversationViewModel 直接产出；
    /// debounce 后从 HTTP 重拉历史兑底（本轮收尾时整体校正，对齐 Electron / 旧 iOS loadMessages）。
    case sequenceGap
    /// 助手正文增量（content_block text / text_delta / connector_text_delta）。
    /// index 为 content_block 序号，供投射器按时间轴定位正文块（与 thinking / tool 穿插）。
    case appendText(messageId: String?, index: Int, text: String)
    /// 正文引用增量（content_block_delta.citations_delta），按正文 block 追加引用来源。
    case citation(messageId: String?, index: Int, citation: Citation)
    /// 思考段（按 messageId + content_block index 跟踪）。completed=true 表示该段定格。
    /// 带 messageId 是为了 agentic 多 message 子轮里 index 重置后仍能正确寻址，不跨子轮撞号。
    case thinking(messageId: String?, index: Int, text: String, completed: Bool)
    /// 工具调用块开始（content_block_start(tool_use)）。messageId 用于把卡片路由到对应助手气泡。
    case toolUseStarted(messageId: String?, toolCallId: String, name: String, index: Int)
    /// 工具调用块收尾（content_block_stop），inputJson 为累积的 input_json_delta。
    case toolUseFinalized(messageId: String?, toolCallId: String, name: String, index: Int, inputJson: String)
    /// 工具执行结果（content_block_start(tool_result)）。按 toolUseId 配对回填到对应工具卡的输出区。
    /// text 为结果文本化结果，isError 标记执行失败（tool_result.is_error）。
    /// presentationKind / presentationPrompt 来自 tool_result.presentation（可空）。
    case toolResult(
        messageId: String?,
        toolUseId: String,
        text: String,
        isError: Bool,
        presentationKind: String?,
        presentationPrompt: String?
    )
    /// Runtime 工具执行相位 / 实时输出快照。
    case toolExecution(ToolExecutionUpdate)
    /// 老协议 step 与 Monitor 状态也进入可见的 runtime 行，不再被 presentation 丢弃。
    case runtimeStep(messageId: String?, step: StreamStep)
    case monitorStatus(messageId: String?, status: AgentMonitorStatus)
    /// SSH_OUTPUT 是增量流，按 toolCallId/taskId 或最近的 ssh 工具卡追加。
    case sshOutput(messageId: String?, output: AgentSSHOutput)
    /// 富内容块（表格、文件、图片、资源引用等），直播和历史复用同一 UI block。
    case richContent(messageId: String?, index: Int, block: RichContentBlock)
    /// TabTin 来源引用块，映射到聊天内上下文卡片（可见、可点击、可缓存）。
    case contextRef(messageId: String?, index: Int, block: ContextRefBlock)
    case messageStop(messageId: String?, stopReason: String?)
    case messagePersisted(messageId: String?, persistedId: String?, messageIds: [MessageIdMapping] = [])
    case messageCommitted(messageId: String?, serverId: String?)
    /// 观察者镜像：别端在同会话发的用户消息（`agent.stream.user`）。由 ConversationViewModel
    /// 的旁观通道直接产出（非 reducer），projector 据 client_event_id 去重后追加 user 气泡。
    case observedUserMessage(
        id: String,
        text: String,
        senderUserId: String?,
        senderDisplayName: String?,
        triggeredBy: String? = nil
    )
    case done(stopReason: String?, errorInfo: ChatStreamErrorInfo?)
    case systemNotice(noticeType: String?, envelope: WSEnvelope)
    case hitl(kind: HITLKind, envelope: WSEnvelope)
    /// 子 Agent 生命周期（会话内联进度与完整记录）。
    case subagent(event: SubagentEvent)
    /// 子 Agent 内层实时流，交给上层按 runId 使用独立 reducer 重放。
    case subagentStream(event: SubagentStreamEvent)
    case todoUpdate([AgentTodoItem])
    case checkpointHealth(ok: Bool, sessionId: String?)
    case error(ChatStreamErrorInfo)
}

/// 单轮会话状态机 reducer（§4.3 第二刀的纯函数核心）。
///
/// 取代旧 StreamManager 的「会话段」：把一串 `DecodedStreamEvent` 折叠成 `StreamUpdate` 序列，
/// 并维护跨事件的最小状态（当前 messageId、各 content_block 的类型/思考文本/工具 input 累积）。
///
/// **刻意纯化**：值类型 + `mutating func ingest`，无 async / 无定时器 / 无 transport。
/// 发送 / ack / 超时 / 重连 / 批量 flush 等编排由 `ConversationViewModel`（不锁单通道）承载，
/// reducer 本身确定性可单测。
struct StreamSession {
    enum BlockKind: Sendable { case text, thinking, toolUse, other }

    private struct ToolAcc { let toolCallId: String; let name: String; var inputJson: String }

    private var blockKinds: [Int: BlockKind] = [:]
    private var thinkingText: [Int: String] = [:]
    private var toolBlocks: [Int: ToolAcc] = [:]
    private var messageDeltasById: [String: DecodedMessageDelta] = [:]
    private var latestMessageDelta: DecodedMessageDelta?

    private(set) var currentMessageId: String?
    /// 最近一条 message_delta 的累计 usage（覆盖而非累加）。
    private(set) var latestMessageUsage: MessageUsage?
    /// 最近一条 message_stop 的结构化错误；后续 UI 投影可按 partial_reason 展示。
    private(set) var latestMessageStopErrorInfo: ErrorInfo?
    /// 收到 done / error 即置位，编排层据此结束 AsyncStream。
    private(set) var isFinished = false
    /// 是否已收到首个 agent.stream.* 事件（编排层用于取消首包超时）。
    private(set) var hasReceivedFirstEvent = false
    /// Runtime 真实下发的上下文压力与压缩快照。
    /// 目前保持在 reducer 层，供后续 Composer / Agent 状态面板选择性投影；不在此处
    /// 伪造本地 token 估算，也不把压缩事件误当作可由移动端主动触发的操作。
    private(set) var contextRuntimeState = ContextRuntimeState()

    init() {}

    mutating func ingest(_ event: DecodedStreamEvent) -> [StreamUpdate] {
        switch event {
        case .lifecycle, .messageStart, .messageDelta, .messageStop, .contentBlockStart,
             .contentBlockDelta, .contentBlockStop, .done, .messagePersisted, .messageCommitted,
             .step, .monitorStatus, .compaction, .contextPressure, .sshOutput,
             .systemNotice, .error, .hitl, .subagent, .subagentStream, .todo, .checkpoint:
            hasReceivedFirstEvent = true
        case .ignored, .unhandled:
            break
        }

        switch event {
        case let .lifecycle(phase, _):
            return [.lifecycle(phase: phase)]

        case let .messageStart(messageId, agentId, role):
            currentMessageId = messageId
            if let messageId {
                messageDeltasById.removeValue(forKey: messageId)
            }
            latestMessageDelta = nil
            latestMessageUsage = nil
            latestMessageStopErrorInfo = nil
            return [.messageStarted(messageId: messageId, agentId: agentId, role: role)]

        case let .messageDelta(metadata):
            let messageId = metadata.messageId ?? currentMessageId
            let previous = messageId.flatMap { messageDeltasById[$0] }
            let merged = DecodedMessageDelta(
                messageId: messageId,
                stopReason: metadata.stopReason ?? previous?.stopReason,
                stopSequence: metadata.stopSequence ?? previous?.stopSequence,
                usage: metadata.usage ?? previous?.usage
            )
            latestMessageDelta = merged
            if let messageId {
                messageDeltasById[messageId] = merged
            }
            if let usage = merged.usage {
                latestMessageUsage = usage
            }
            return []

        case let .contentBlockStart(messageId, index, block):
            if let messageId { currentMessageId = messageId }
            return handleBlockStart(index: index, block: block, messageId: messageId)

        case let .contentBlockDelta(messageId, index, delta):
            return handleBlockDelta(index: index, delta: delta, messageId: messageId)

        case let .contentBlockStop(messageId, index):
            return handleBlockStop(index: index, messageId: messageId)

        case let .messageStop(metadata):
            let messageId = metadata.messageId ?? currentMessageId
            let delta: DecodedMessageDelta?
            if let messageId {
                delta = messageDeltasById.removeValue(forKey: messageId)
            } else {
                delta = latestMessageDelta
            }
            if let usage = metadata.usage ?? delta?.usage {
                latestMessageUsage = usage
            }
            latestMessageStopErrorInfo = metadata.errorInfo
            latestMessageDelta = nil
            return [.messageStop(
                messageId: messageId,
                stopReason: metadata.stopReason ?? delta?.stopReason
            )]

        case let .messagePersisted(_, messageId, persistedId, messageIds):
            return [.messagePersisted(messageId: messageId, persistedId: persistedId, messageIds: messageIds)]

        case let .messageCommitted(_, messageId, serverId):
            return [.messageCommitted(messageId: messageId, serverId: serverId)]

        case let .done(_, stopReason, errorInfo, _):
            isFinished = true
            return [.done(stopReason: stopReason, errorInfo: errorInfo)]

        case let .systemNotice(noticeType, envelope):
            if let toolUpdate = ToolExecutionUpdate.decode(noticeType: noticeType, envelope: envelope) {
                return [.toolExecution(toolUpdate)]
            }
            // `severity=silent` 是协议明确约定的内部诊断事件，前端必须接收但不能展示。
            // llm_timing 再按类型兜底，兼容尚未携带 severity 的旧 Runtime。
            let severity = envelope.payloadString("severity")?
                .trimmingCharacters(in: .whitespacesAndNewlines)
                .lowercased()
            if severity == "silent" || noticeType == "llm_timing" {
                return []
            }
            return [.systemNotice(noticeType: noticeType, envelope: envelope)]

        case let .hitl(kind, envelope):
            return [.hitl(kind: kind, envelope: envelope)]

        case let .subagent(event):
            return [.subagent(event: event)]

        case let .subagentStream(event):
            return [.subagentStream(event: event)]

        case let .todo(items):
            return [.todoUpdate(items)]

        case let .checkpoint(ok, sessionId):
            return [.checkpointHealth(ok: ok, sessionId: sessionId)]

        case let .error(info):
            isFinished = true
            return [.error(info)]

        case let .step(step):
            return [.runtimeStep(messageId: currentMessageId, step: step)]

        case let .monitorStatus(status):
            return [.monitorStatus(messageId: currentMessageId, status: status)]

        case let .sshOutput(output):
            return [.sshOutput(messageId: currentMessageId, output: output)]

        case let .compaction(compaction):
            contextRuntimeState.reduce(compaction)
            return []

        case let .contextPressure(pressure):
            contextRuntimeState.reduce(pressure)
            return []

        case .ignored, .unhandled:
            return []
        }
    }

    // MARK: - content_block 三件套

    private mutating func handleBlockStart(index: Int?, block: ContentBlock, messageId: String?) -> [StreamUpdate] {
        let idx = index ?? 0
        switch block {
        case let .text(payload):
            blockKinds[idx] = .text
            return payload.text.isEmpty ? [] : [.appendText(messageId: messageId ?? currentMessageId, index: idx, text: payload.text)]
        case let .thinking(payload):
            blockKinds[idx] = .thinking
            thinkingText[idx] = payload.thinking
            return [.thinking(messageId: messageId ?? currentMessageId, index: idx, text: payload.thinking, completed: false)]
        case let .toolUse(payload):
            blockKinds[idx] = .toolUse
            toolBlocks[idx] = ToolAcc(toolCallId: payload.id, name: payload.name, inputJson: "")
            return [.toolUseStarted(messageId: messageId ?? currentMessageId, toolCallId: payload.id, name: payload.name, index: idx)]
        case let .serverToolUse(payload):
            // 服务端 Web Search 仍是同一条可展开工具卡，而不是新的聊天消息。
            let inputJson = Self.jsonString(payload.input)
            blockKinds[idx] = .toolUse
            toolBlocks[idx] = ToolAcc(toolCallId: payload.id, name: payload.name, inputJson: inputJson)
            let mid = messageId ?? currentMessageId
            return [
                .toolUseStarted(messageId: mid, toolCallId: payload.id, name: payload.name, index: idx),
                .toolUseFinalized(messageId: mid, toolCallId: payload.id, name: payload.name, index: idx, inputJson: inputJson),
            ]
        case let .toolResult(payload):
            // tool_result 块一次性带完整 content（无 delta）；按 toolUseId 配对回填到对应工具卡。
            blockKinds[idx] = .other
            let kind = payload.presentation?.kind
            let prompt: String? = {
                guard let data = payload.presentation?.data else { return nil }
                if case let .string(s) = data["prompt"] { return s }
                return nil
            }()
            return [.toolResult(
                messageId: messageId ?? currentMessageId,
                toolUseId: payload.toolUseId,
                text: ToolResultText.from(payload.content),
                isError: payload.isError ?? false,
                presentationKind: kind,
                presentationPrompt: prompt
            )]
        case let .webSearchToolResult(payload):
            // 只将结果回填给对应 server_tool_use，避免独立 artifact 占据时间线。
            blockKinds[idx] = .other
            return [.toolResult(
                messageId: messageId ?? currentMessageId,
                toolUseId: payload.toolUseId,
                text: Self.jsonString(payload.content),
                isError: false,
                presentationKind: nil,
                presentationPrompt: nil
            )]
        case let .tabtinRichContent(payload):
            blockKinds[idx] = .other
            let mid = messageId ?? currentMessageId
            return [.richContent(
                messageId: mid,
                index: idx,
                block: Self.richContentBlock(from: payload, messageId: mid, index: idx)
            )]
        case let .tabtinSourceRef(payload):
            blockKinds[idx] = .other
            let mid = messageId ?? currentMessageId
            return [.contextRef(
                messageId: mid,
                index: idx,
                block: Self.contextRefBlock(from: payload, messageId: mid, index: idx)
            )]
        default:
            blockKinds[idx] = .other
            return []
        }
    }

    private mutating func handleBlockDelta(index: Int?, delta: ContentBlockDeltaPayload, messageId: String?) -> [StreamUpdate] {
        let idx = index ?? 0
        switch delta {
        case let .textDelta(payload):
            return payload.text.isEmpty ? [] : [.appendText(messageId: messageId ?? currentMessageId, index: idx, text: payload.text)]
        case let .connectorTextDelta(payload):
            return payload.connectorText.isEmpty ? [] : [.appendText(messageId: messageId ?? currentMessageId, index: idx, text: payload.connectorText)]
        case let .thinkingDelta(payload):
            let merged = (thinkingText[idx] ?? "") + payload.thinking
            thinkingText[idx] = merged
            return [.thinking(messageId: messageId ?? currentMessageId, index: idx, text: merged, completed: false)]
        case let .inputJsonDelta(payload):
            if var acc = toolBlocks[idx] {
                acc.inputJson += payload.partialJson
                toolBlocks[idx] = acc
            }
            return []
        case .signatureDelta:
            return []
        case let .citationsDelta(payload):
            return [.citation(messageId: messageId ?? currentMessageId, index: idx, citation: payload.citation)]
        }
    }

    private mutating func handleBlockStop(index: Int?, messageId: String?) -> [StreamUpdate] {
        let idx = index ?? 0
        switch blockKinds[idx] {
        case .thinking:
            let text = thinkingText[idx] ?? ""
            thinkingText[idx] = nil
            blockKinds[idx] = nil
            return [.thinking(messageId: messageId ?? currentMessageId, index: idx, text: text, completed: true)]
        case .toolUse:
            guard let acc = toolBlocks[idx] else { return [] }
            toolBlocks[idx] = nil
            blockKinds[idx] = nil
            return [.toolUseFinalized(messageId: messageId ?? currentMessageId, toolCallId: acc.toolCallId, name: acc.name, index: idx, inputJson: acc.inputJson)]
        default:
            blockKinds[idx] = nil
            return []
        }
    }

    private static func jsonString<T: Encodable>(_ value: T) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let string = String(data: data, encoding: .utf8) else { return "" }
        return string
    }

    private static func richContentBlock(
        from block: ContentBlockTabtinRichContentPayload,
        messageId: String?,
        index: Int
    ) -> RichContentBlock {
        let payload = nativePayload(block.payload)
        let title = stringValue(payload["title"])
            ?? stringValue(payload["name"])
            ?? stringValue(payload["filename"])
        let tableSchema = RichTableSchema.fromPayload(payload)
        let kind = stringValue(payload["kind"]) ?? block.kind.rawValue
        let formalImage = FormalOssImageAsset.from(kind: kind, payload: payload)
        return RichContentBlock(
            messageId: messageId,
            index: index,
            kind: kind,
            summary: block.summary.isEmpty ? (stringValue(payload["summary"]) ?? "") : block.summary,
            title: title,
            groupId: block.groupId,
            tableRows: tableSchema?.displayRows ?? parseTableRows(payload),
            tableSchema: tableSchema,
            footer: stringValue(payload["footer"]) ?? stringValue(payload["truncated_footer"]),
            resourceType: stringValue(payload["resource_type"]),
            resourceName: stringValue(payload["resource_name"]) ?? stringValue(payload["name"]),
            resourceId: stringValue(payload["resource_id"]) ?? stringValue(payload["id"]),
            spaceName: stringValue(payload["space_name"]),
            url: formalImage?.fallbackURL
                ?? ((formalImage == nil ? stringValue(payload["url"]) : nil)
                    ?? stringValue(payload["image_url"])
                    ?? stringValue(payload["file_url"])
                    ?? stringValue(payload["remote_url"])),
            filename: stringValue(payload["filename"]) ?? stringValue(payload["file_name"]),
            mimeType: stringValue(payload["mime_type"]),
            fileSize: int64Value(payload["file_size"] ?? payload["size"]),
            totalRows: intValue(payload["total_rows"] ?? payload["total"]),
            widgetId: stringValue(payload["widget_id"]) ?? stringValue(payload["widgetId"]),
            format: stringValue(payload["format"]),
            sourceCode: stringValue(payload["source_code"]) ?? stringValue(payload["sourceCode"]),
            mermaidSource: stringValue(payload["mermaid_source"]) ?? stringValue(payload["mermaidSource"]),
            query: stringValue(payload["query"]),
            searchResults: RichSearchResult.fromPayload(payload["search_results"]),
            totalCount: intValue(payload["total_count"] ?? payload["total"]),
            fileId: formalImage?.fileId
                ?? stringValue(payload["file_id"])
                ?? stringValue(payload["fileId"]),
            sourceToolUseId: stringValue(payload["source_tool_use_id"]),
            artifactKind: stringValue(payload["artifact_kind"]),
            relativePath: stringValue(payload["relative_path"])
        )
    }

    private static func contextRefBlock(
        from block: ContentBlockTabtinSourceRefPayload,
        messageId: String?,
        index: Int
    ) -> ContextRefBlock {
        switch block.snapshot {
        case let .web(payload):
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "web",
                resourceId: nil,
                url: payload.url,
                tableId: nil,
                docId: nil,
                rowIds: [],
                fieldIds: [],
                label: firstNonEmpty(payload.title, payload.url) ?? "网页来源",
                preview: firstNonEmpty(payload.selectedText, payload.preview),
                spaceId: nil,
                spaceName: nil,
                locationHint: nil
            )
        case let .doc(payload):
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "doc_selection",
                resourceId: payload.docId,
                url: nil,
                tableId: nil,
                docId: payload.docId,
                rowIds: [],
                fieldIds: [],
                label: "文档引用",
                preview: payload.preview,
                spaceId: nil,
                spaceName: nil,
                locationHint: sourceRefLocationHint(page: payload.page, bbox: payload.bbox)
            )
        case let .table(payload):
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "table_selection",
                resourceId: payload.tableId,
                url: nil,
                tableId: payload.tableId,
                docId: nil,
                rowIds: payload.rowIds ?? [],
                fieldIds: payload.fieldIds ?? [],
                label: "表格引用",
                preview: payload.csvPreview,
                spaceId: nil,
                spaceName: nil,
                locationHint: sourceRefLocationHint(rowIds: payload.rowIds, fieldIds: payload.fieldIds)
            )
        case let .code(payload):
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "code_file",
                resourceId: payload.filePath,
                url: nil,
                tableId: nil,
                docId: nil,
                rowIds: [],
                fieldIds: [],
                label: payload.filePath,
                preview: payload.codeExcerpt,
                spaceId: nil,
                spaceName: nil,
                locationHint: payload.endLine > payload.startLine ? "行 \(payload.startLine)-\(payload.endLine)" : "行 \(payload.startLine)"
            )
        case let .memo(payload):
            return ContextRefBlock(
                messageId: messageId,
                index: index,
                type: "memo",
                resourceId: payload.memoId,
                url: nil,
                tableId: nil,
                docId: nil,
                rowIds: [],
                fieldIds: [],
                label: "笔记引用",
                preview: payload.preview,
                spaceId: nil,
                spaceName: nil,
                locationHint: nil
            )
        }
    }

    private static func nativePayload(_ payload: [String: JSONValue]?) -> [String: Any] {
        guard let payload,
              let data = try? JSONEncoder().encode(payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return [:]
        }
        return object
    }

    private static func parseTableRows(_ payload: [String: Any]) -> [[String]] {
        if let rows = payload["rows"] as? [[String: Any]], !rows.isEmpty {
            let columns = parseColumnKeys(payload["columns"], fallbackRows: rows)
            var table: [[String]] = [columns.map(\.label)]
            table.append(contentsOf: rows.prefix(10).map { row in
                columns.map { cellText(row[$0.key]) }
            })
            return table
        }
        if let rows = payload["rows"] as? [[Any]], !rows.isEmpty {
            return rows.prefix(10).map { row in
                row.prefix(6).map { cellText($0) }
            }
        }
        if let rows = payload["data"] as? [[Any]], !rows.isEmpty {
            return rows.prefix(10).map { row in
                row.prefix(6).map { cellText($0) }
            }
        }
        if let rows = payload["records"] as? [[String: Any]], !rows.isEmpty {
            let columns = parseColumnKeys(payload["columns"], fallbackRows: rows)
            var table: [[String]] = [columns.map(\.label)]
            table.append(contentsOf: rows.prefix(10).map { row in
                columns.map { cellText(row[$0.key]) }
            })
            return table
        }
        return []
    }

    private static func parseColumnKeys(_ value: Any?, fallbackRows: [[String: Any]]) -> [(key: String, label: String)] {
        if let columns = value as? [[String: Any]], !columns.isEmpty {
            return columns.prefix(6).compactMap { column in
                let key = stringValue(column["key"])
                    ?? stringValue(column["id"])
                    ?? stringValue(column["name"])
                guard let key, !key.isEmpty else { return nil }
                let label = stringValue(column["label"])
                    ?? stringValue(column["title"])
                    ?? stringValue(column["name"])
                    ?? key
                return (key, label)
            }
        }
        let keys = Array(fallbackRows.flatMap(\.keys)).reduce(into: [String]()) { acc, key in
            if !acc.contains(key) { acc.append(key) }
        }.prefix(6)
        return keys.map { ($0, $0) }
    }

    private static func cellText(_ value: Any?) -> String {
        switch value {
        case let string as String: return string
        case let number as NSNumber: return number.stringValue
        case let dict as [String: Any]:
            return stringValue(dict["label"])
                ?? stringValue(dict["value"])
                ?? stringValue(dict["text"])
                ?? jsonLikeString(dict)
        case let array as [Any]:
            return array.map { cellText($0) }.joined(separator: ", ")
        case .some(let value): return String(describing: value)
        case .none: return ""
        }
    }

    private static func stringValue(_ value: Any?) -> String? {
        switch value {
        case let string as String: return firstNonEmpty(string)
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }

    private static func firstNonEmpty(_ values: String?...) -> String? {
        for value in values {
            let cleaned = value?.trimmingCharacters(in: .whitespacesAndNewlines)
            if let cleaned, !cleaned.isEmpty {
                return cleaned
            }
        }
        return nil
    }

    private static func sourceRefLocationHint(page: Int? = nil, bbox: [Double]? = nil, rowIds: [String]? = nil, fieldIds: [String]? = nil) -> String? {
        var parts: [String] = []
        if let page {
            parts.append("第 \(page) 页")
        }
        if let bbox, !bbox.isEmpty {
            parts.append("区域 \(bbox.map { String(format: "%.2f", $0) }.joined(separator: ","))")
        }
        if let rowIds, !rowIds.isEmpty {
            parts.append(rowIds.count == 1 ? "记录 \(rowIds[0])" : "\(rowIds.count) 条记录")
        }
        if let fieldIds, !fieldIds.isEmpty {
            parts.append(fieldIds.count == 1 ? "字段 \(fieldIds[0])" : "\(fieldIds.count) 个字段")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let int = value as? Int { return int }
        if let int64 = value as? Int64 { return Int(int64) }
        if let double = value as? Double { return Int(double) }
        if let string = value as? String { return Int(string) }
        return nil
    }

    private static func int64Value(_ value: Any?) -> Int64? {
        if let int = value as? Int { return Int64(int) }
        if let int64 = value as? Int64 { return int64 }
        if let double = value as? Double { return Int64(double) }
        if let string = value as? String { return Int64(string) }
        return nil
    }

    private static func jsonLikeString(_ value: Any) -> String {
        guard JSONSerialization.isValidJSONObject(value),
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]),
              let string = String(data: data, encoding: .utf8) else {
            return String(describing: value)
        }
        return string.count > 80 ? String(string.prefix(80)) + "..." : string
    }
}

/// tool_result 的 `content` 文本化（直播 JSONValue / 历史 Any 两条入口共用）。
///
/// content 形态多样：纯字符串、Anthropic 风格 `[{type:"text", text:...}]` 数组、或任意 JSON 对象。
/// 统一降维成可读文本：字符串直取；数组提取每项 text（无 text 则 pretty JSON）拼接；对象取 text
/// 或 pretty JSON。专用卡（Diff / 终端 / 表格）的结构化解析留待后续阶段，本期先保证「展开能看到原文」。
enum ToolResultText {
    /// 直播入口：wire 层 JSONValue。
    static func from(_ value: JSONValue) -> String {
        guard let data = try? JSONEncoder().encode(value),
              let any = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
        else { return "" }
        return from(any: any)
    }

    /// 历史入口：AnyCodable 解出的原生 Any（String / [Any] / [String:Any] / NSNumber …）。
    static func from(any: Any?) -> String {
        switch any {
        case let s as String:
            return s
        case let arr as [Any]:
            return arr.compactMap { item -> String? in
                if let d = item as? [String: Any] {
                    if let t = d["text"] as? String { return t }
                    return prettyJSON(d)
                }
                if let s = item as? String { return s }
                return nil
            }.joined(separator: "\n")
        case let d as [String: Any]:
            if let t = d["text"] as? String { return t }
            return prettyJSON(d)
        case let n as NSNumber:
            return n.stringValue
        case .some(let other):
            return String(describing: other)
        case .none:
            return ""
        }
    }

    private static func prettyJSON(_ obj: Any) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .withoutEscapingSlashes]),
              let s = String(data: data, encoding: .utf8) else { return String(describing: obj) }
        return s
    }
}
