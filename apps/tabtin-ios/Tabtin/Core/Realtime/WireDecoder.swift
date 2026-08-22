import Foundation

struct DecodedMessageDelta: Sendable, Hashable {
    let messageId: String?
    let stopReason: String?
    let stopSequence: String?
    /// Anthropic 语义为截至当前 delta 的累计 usage，消费方应覆盖而非累加。
    let usage: MessageUsage?
}

struct DecodedMessageStop: Sendable, Hashable {
    let messageId: String?
    /// 正常来自前序 message_delta；保留此字段兼容旧 relay 的扁平/嵌套形态。
    let stopReason: String?
    let stopSequence: String?
    let usage: MessageUsage?
    let persistedId: String?
    let blockIdOverrides: [String: String]
    let errorInfo: ErrorInfo?
}

struct AgentMonitorStatus: Sendable, Hashable {
    let monitorId: String?
    let description: String?
    let command: String?
    let status: String?
    let notifyOn: String?
    let failReason: String?
    let createdAt: String?
    let emitInterrupted: Bool?
    let taskId: String?
}

struct AgentContextPressure: Sendable, Hashable {
    let pressure: Double?
    let level: String?
    let estimatedTokens: Int?
    let contextWindow: Int?
    let model: String?
}

struct AgentSSHOutput: Sendable, Hashable {
    let output: String
    let stream: String?
    let sessionId: String?
    let taskId: String?
    let toolCallId: String?
    let serverName: String?
}

/// 流式事件解码后的强类型表示。高频正文/思考路径（content_block 三件套）解成
/// vendored Wire 类型；HITL / 提案 / 审批等低频复杂事件先透传原始 envelope，
/// 由 Phase 3 的 HITLCoordinator 精解。
///
/// 全部 case 关联值均 Sendable（ContentBlock / ContentBlockDeltaPayload 由
/// wire-codegen 标注 Sendable；WSEnvelope 为 Sendable struct），可安全跨 actor 传递。
enum DecodedStreamEvent: Sendable {
    case lifecycle(phase: String, sessionId: String?)
    case messageStart(messageId: String?, agentId: String? = nil, role: String? = nil)
    case messageDelta(DecodedMessageDelta)
    case messageStop(DecodedMessageStop)
    case contentBlockStart(messageId: String?, index: Int?, block: ContentBlock)
    case contentBlockDelta(messageId: String?, index: Int?, delta: ContentBlockDeltaPayload)
    case contentBlockStop(messageId: String?, index: Int?)
    case step(StreamStep)
    case monitorStatus(AgentMonitorStatus)
    case compaction(StreamCompaction)
    case contextPressure(AgentContextPressure)
    case sshOutput(AgentSSHOutput)
    /// `withdrawApplied`：`chat.cancel` 撤回路径上服务端是否已物理删除该轮；缺省 nil 表示旧后端未下发。
    case done(sessionId: String?, stopReason: String?, errorInfo: ChatStreamErrorInfo?, withdrawApplied: Bool?)
    case messagePersisted(sessionId: String?, messageId: String?, persistedId: String?, messageIds: [MessageIdMapping] = [])
    case messageCommitted(sessionId: String?, messageId: String?, serverId: String?)
    case systemNotice(noticeType: String?, envelope: WSEnvelope)
    case error(ChatStreamErrorInfo)
    /// HITL / 非阻断提案 / 审批：解码留待 Phase 3，先带原始 envelope。
    case hitl(kind: HITLKind, envelope: WSEnvelope)
    /// 子 Agent 生命周期（会话内联进度与独立详情页消费）。
    case subagent(event: SubagentEvent)
    /// 子 Agent 内层实时流（供会话内完整记录与工作台产出投影重放 transcript）。
    case subagentStream(event: SubagentStreamEvent)
    /// Agent 当前 todo 清单。
    case todo(items: [AgentTodoItem])
    /// Checkpoint 创建健康事件。
    case checkpoint(ok: Bool, sessionId: String?)
    /// 协议已知，但 payload 无法满足最小寻址要求。
    case ignored(eventType: String)
    /// 未识别（非 agent.stream.* 或新协议事件）。
    case unhandled(eventType: String)
}

enum HITLKind: Sendable {
    case askUser
    case askForm
    case requestApproval
    case singleHitlResolved
    case approvalRequested
    case approvalResolved
    case actionApprovalRequested
    case actionApprovalResolved
    case planProposal
    case modeSwitchProposal
}

/// 无状态流式解码器：`agent.stream.*` envelope → 强类型 `DecodedStreamEvent`。
///
/// 取代旧 StreamManager 的解码段（§4.3 第一刀）。纯函数、无副作用、可单测。
/// 持有可复用的 JSONEncoder/JSONDecoder（高频 content_block_delta 避免反复构造），
/// 因此非 Sendable——由单一持有者（StreamSession actor / ConversationViewModel）隔离使用。
struct WireDecoder {
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    init() {}

    func decode(_ env: WSEnvelope) -> DecodedStreamEvent {
        switch env.type {
        case AgentStreamEvent.actionApprovalRequest:
            return .hitl(kind: .actionApprovalRequested, envelope: env)
        case AgentStreamEvent.actionApprovalResolved:
            return .hitl(kind: .actionApprovalResolved, envelope: env)
        default:
            break
        }

        guard env.type.hasPrefix(AgentStreamEvent.prefix) else {
            return .unhandled(eventType: env.type)
        }
        let short = String(env.type.dropFirst(AgentStreamEvent.prefix.count))
        let sessionId = env.sessionId ?? env.payloadString("session_id")

        switch short {
        case AgentStreamEvent.lifecycle:
            return .lifecycle(phase: env.payloadString("phase") ?? "", sessionId: sessionId)

        case AgentStreamEvent.messageStart:
            // role 透传给投影层：后台命令终态等合成 mini-message 的 role="user"，
            // 与真实用户消息区分开（真实用户消息不走 message_start 建气泡路径）。
            return .messageStart(
                messageId: env.payloadString("message_id"),
                agentId: env.payloadString("agent_id"),
                role: env.payloadString("role")
            )

        case AgentStreamEvent.messageDelta:
            guard let metadata = decodeMessageDelta(from: env) else {
                return .unhandled(eventType: short)
            }
            return .messageDelta(metadata)

        case AgentStreamEvent.messageStop:
            return .messageStop(decodeMessageStop(from: env))

        case AgentStreamEvent.contentBlockStart:
            if let block = decodeContentBlock(from: env) {
                return .contentBlockStart(
                    messageId: env.payloadString("message_id"),
                    index: env.payloadInt("index"),
                    block: block
                )
            }
            return .unhandled(eventType: short)

        case AgentStreamEvent.contentBlockDelta:
            if let delta = env.decodePayloadField(
                "delta", as: ContentBlockDeltaPayload.self,
                encoder: encoder, decoder: decoder
            ) {
                return .contentBlockDelta(
                    messageId: env.payloadString("message_id"),
                    index: env.payloadInt("index"),
                    delta: delta
                )
            }
            return .unhandled(eventType: short)

        case AgentStreamEvent.contentBlockStop:
            return .contentBlockStop(
                messageId: env.payloadString("message_id"),
                index: env.payloadInt("index")
            )

        case AgentStreamEvent.step:
            guard let step = env.decodePayload(as: StreamStep.self, encoder: encoder, decoder: decoder) else {
                return .unhandled(eventType: short)
            }
            return .step(step)

        case AgentStreamEvent.monitorStatus:
            return .monitorStatus(AgentMonitorStatus(
                monitorId: env.payloadString("monitor_id"),
                description: env.payloadString("description"),
                command: env.payloadString("command"),
                status: env.payloadString("status"),
                notifyOn: env.payloadString("notify_on"),
                failReason: env.payloadString("fail_reason"),
                createdAt: env.payloadString("created_at"),
                emitInterrupted: env.payloadBool("emit_interrupted"),
                taskId: env.payloadString("task_id")
            ))

        case AgentStreamEvent.compaction:
            guard let compaction = env.decodePayload(
                as: StreamCompaction.self,
                encoder: encoder,
                decoder: decoder
            ) else {
                return .unhandled(eventType: short)
            }
            return .compaction(compaction)

        case AgentStreamEvent.contextPressure:
            return .contextPressure(AgentContextPressure(
                pressure: env.payloadDouble("pressure"),
                level: env.payloadString("level"),
                estimatedTokens: env.payloadInt("estimatedTokens") ?? env.payloadInt("estimated_tokens"),
                contextWindow: env.payloadInt("contextWindow") ?? env.payloadInt("context_window"),
                model: env.payloadString("model")
            ))

        case AgentStreamEvent.sshOutput:
            return .sshOutput(AgentSSHOutput(
                output: env.payloadString("data")
                    ?? env.payloadString("output")
                    ?? env.payloadString("content")
                    ?? "",
                stream: env.payloadString("stream") ?? env.payloadString("channel"),
                sessionId: sessionId,
                taskId: env.payloadString("task_id"),
                toolCallId: env.payloadString("tool_call_id"),
                serverName: env.payloadString("server_name")
            ))

        case AgentStreamEvent.done:
            let info = Self.errorInfo(from: env)
            return .done(
                sessionId: sessionId,
                stopReason: env.payloadString("stop_reason"),
                errorInfo: info,
                withdrawApplied: env.payloadBool("withdraw_applied")
            )

        case AgentStreamEvent.messagePersisted:
            return .messagePersisted(
                sessionId: sessionId,
                messageId: env.payloadString("message_id"),
                persistedId: env.payloadString("persisted_id"),
                messageIds: Self.messageIdMappings(from: env)
            )

        case AgentStreamEvent.messageCommitted:
            return .messageCommitted(
                sessionId: sessionId,
                messageId: env.payloadString("message_id"),
                serverId: env.payloadString("server_id")
            )

        case AgentStreamEvent.systemNotice:
            return .systemNotice(noticeType: env.payloadString("notice_type"), envelope: env)

        case AgentStreamEvent.persistError:
            return .error(ChatStreamErrorInfo(
                message: env.payloadString("error") ?? env.payloadString("message") ?? "保存失败",
                errorClass: env.payloadString("error_class"),
                suggestedAction: env.payloadString("suggested_action"),
                errorCategory: env.payloadString("error_category") ?? "persist_error",
                errorCode: env.payloadString("error_code") ?? "persist_error"
            ))

        case AgentStreamEvent.askUserRequired:
            return .hitl(kind: .askUser, envelope: env)
        case AgentStreamEvent.askFormRequired:
            return .hitl(kind: .askForm, envelope: env)
        case AgentStreamEvent.requestApprovalRequired:
            return .hitl(kind: .requestApproval, envelope: env)
        case AgentStreamEvent.singleHitlResolved:
            return .hitl(kind: .singleHitlResolved, envelope: env)
        case AgentStreamEvent.approvalRequested:
            return .hitl(kind: .approvalRequested, envelope: env)
        case AgentStreamEvent.approvalResolved:
            return .hitl(kind: .approvalResolved, envelope: env)
        case AgentStreamEvent.planProposal:
            return .hitl(kind: .planProposal, envelope: env)
        case AgentStreamEvent.modeSwitchProposal:
            return .hitl(kind: .modeSwitchProposal, envelope: env)

        case AgentStreamEvent.subagentStarted:
            return subagent(.started, env)
        case AgentStreamEvent.subagentQueued:
            return subagent(.queued, env)
        case AgentStreamEvent.subagentProgress:
            return subagent(.progress, env)
        case AgentStreamEvent.subagentCompleted:
            return subagent(.completed, env)
        case AgentStreamEvent.subagentFailed:
            return subagent(.failed, env)
        case AgentStreamEvent.subagentStreamEvent:
            if let event = SubagentStreamEvent.decode(envelope: env) {
                return .subagentStream(event: event)
            }
            return .ignored(eventType: short)

        case AgentStreamEvent.todo:
            return .todo(items: AgentTodoItem.decode(envelope: env))

        case AgentStreamEvent.checkpointSuccess:
            return .checkpoint(ok: true, sessionId: sessionId)

        case AgentStreamEvent.checkpointFailed:
            return .checkpoint(ok: false, sessionId: sessionId)

        default:
            return .unhandled(eventType: short)
        }
    }

    /// SSoT：stop_reason / usage 属于 message_delta，而非 message_stop。
    /// 旧 relay 曾把 stop_reason 扁平放在 payload 根，保留兼容读取。
    private func decodeMessageDelta(from env: WSEnvelope) -> DecodedMessageDelta? {
        let delta = env.decodePayloadField(
            "delta",
            as: MessageDeltaDelta.self,
            encoder: encoder,
            decoder: decoder
        )
        let usage = env.decodePayloadField(
            "usage",
            as: MessageUsage.self,
            encoder: encoder,
            decoder: decoder
        )
        let legacyStopReason = env.payloadString("stop_reason")
        let legacyStopSequence = env.payloadString("stop_sequence")
        guard delta != nil || usage != nil || legacyStopReason != nil || legacyStopSequence != nil else {
            return nil
        }
        return DecodedMessageDelta(
            messageId: env.payloadString("message_id"),
            stopReason: delta?.stopReason ?? legacyStopReason,
            stopSequence: delta?.stopSequence ?? legacyStopSequence,
            usage: usage
        )
    }

    /// message_stop 的标准字段是 persisted_id / block_id_overrides / error_info。
    /// 同时兼容历史 relay 将 message_delta 的 delta / usage 合入 stop payload 的形态。
    private func decodeMessageStop(from env: WSEnvelope) -> DecodedMessageStop {
        let delta = env.decodePayloadField(
            "delta",
            as: MessageDeltaDelta.self,
            encoder: encoder,
            decoder: decoder
        )
        return DecodedMessageStop(
            messageId: env.payloadString("message_id"),
            stopReason: delta?.stopReason ?? env.payloadString("stop_reason"),
            stopSequence: delta?.stopSequence ?? env.payloadString("stop_sequence"),
            usage: env.decodePayloadField(
                "usage",
                as: MessageUsage.self,
                encoder: encoder,
                decoder: decoder
            ),
            persistedId: env.payloadString("persisted_id"),
            blockIdOverrides: Self.stringDictionary(from: env.payloadDict("block_id_overrides")),
            errorInfo: env.decodePayloadField(
                "error_info",
                as: ErrorInfo.self,
                encoder: encoder,
                decoder: decoder
            )
        )
    }

    private static func errorInfo(from env: WSEnvelope) -> ChatStreamErrorInfo? {
        guard env.payloadBool("error") == true else { return nil }
        let info = ChatStreamErrorInfo(
            message: env.payloadString("error_message")
                ?? env.payloadString("error")
                ?? env.payloadString("message"),
            errorClass: env.payloadString("error_class") ?? env.payloadString("errorClass"),
            suggestedAction: env.payloadString("suggested_action") ?? env.payloadString("suggestedAction"),
            errorCategory: env.payloadString("error_category")
                ?? env.payloadString("errorCategory")
                ?? env.payloadString("category"),
            errorCode: env.payloadString("error_code")
                ?? env.payloadString("errorCode")
                ?? env.payloadString("code")
        )
        return info
    }

    private static func stringDictionary(from value: [String: Any]?) -> [String: String] {
        guard let value else { return [:] }
        return value.reduce(into: [:]) { result, item in
            if let string = item.value as? String {
                result[item.key] = string
            }
        }
    }

    private static func messageIdMappings(from env: WSEnvelope) -> [MessageIdMapping] {
        guard let rawItems = env.payload["message_ids"]?.arrayValue else { return [] }
        return rawItems.compactMap { item in
            guard let dict = item as? [String: Any],
                  let clientEventId = firstNonBlank(dict["client_event_id"] as? String),
                  let serverId = firstNonBlank(dict["server_id"] as? String) else {
                return nil
            }
            return MessageIdMapping(clientEventId: clientEventId, serverId: serverId)
        }
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.first {
            guard let value = $0?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return !value.isEmpty
        } ?? nil
    }

    /// 子 Agent 事件手解：runId 缺失（无法寻址）回退 ignored，不中断主流程。
    private func subagent(_ kind: SubagentEvent.Kind, _ env: WSEnvelope) -> DecodedStreamEvent {
        if let event = SubagentEvent.decode(kind: kind, envelope: env) {
            return .subagent(event: event)
        }
        return .ignored(eventType: env.type)
    }

    /// content_block_start 的 block 字段名有 `block` / `content_block` 两种历史形态。
    private func decodeContentBlock(from env: WSEnvelope) -> ContentBlock? {
        if let block = env.decodePayloadField("block", as: ContentBlock.self, encoder: encoder, decoder: decoder) {
            return block
        }
        return env.decodePayloadField("content_block", as: ContentBlock.self, encoder: encoder, decoder: decoder)
    }
}
