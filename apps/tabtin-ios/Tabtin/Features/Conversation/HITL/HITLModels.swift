import Foundation

/// Project / 团队执行场景下，当前用户是否可以处理 HITL。
///
/// 与 Electron 共用同一条产品规则：payload 没有 `team_space_execution` 时是个人
/// Workspace / 旧事件，默认可处理；一旦声明 execution owner，则只有该用户可决议。
/// 这里刻意不向 UI 暴露后端权限码，只提供“谁可处理”的产品语义。
struct HITLResolutionAccess: Sendable, Equatable {
    private enum MetadataState: Int, Sendable {
        case missing
        case invalid
        case valid
    }

    static let unrestricted = HITLResolutionAccess(
        canResolve: true,
        executionOwnerDisplayName: nil,
        metadataState: .missing
    )

    let canResolve: Bool
    let executionOwnerDisplayName: String?
    private let metadataState: MetadataState

    static func resolve(envelope env: WSEnvelope, currentUserId: String?) -> HITLResolutionAccess {
        if env.payloadBool("__team_space_execution_redaction_required") == true
            || env.payloadBool("details_redacted") == true {
            return HITLResolutionAccess(
                canResolve: false,
                executionOwnerDisplayName: nil,
                metadataState: .invalid
            )
        }
        guard env.payload.keys.contains("team_space_execution") else {
            return .unrestricted
        }
        guard let metadata = env.payloadDict("team_space_execution"),
              let ownerId = nonBlankString(metadata["execution_owner_user_id"]) else {
            return HITLResolutionAccess(
                canResolve: false,
                executionOwnerDisplayName: nil,
                metadataState: .invalid
            )
        }

        return HITLResolutionAccess(
            canResolve: nonBlankString(currentUserId) == ownerId,
            executionOwnerDisplayName: nonBlankString(metadata["execution_owner_display_name"]),
            metadataState: .valid
        )
    }

    /// 同一 HITL 经本地流、用户事件和恢复接口多路到达时，优先采用更完整的权限元数据。
    /// 同等级有效元数据冲突则保守禁止，避免异常事件把只读请求升级为可操作。
    func merging(_ incoming: HITLResolutionAccess) -> HITLResolutionAccess {
        if incoming.metadataState.rawValue > metadataState.rawValue {
            return incoming
        }
        if incoming.metadataState.rawValue < metadataState.rawValue {
            return self
        }
        guard metadataState == .valid else { return self }
        return HITLResolutionAccess(
            canResolve: canResolve && incoming.canResolve,
            executionOwnerDisplayName: incoming.executionOwnerDisplayName
                ?? executionOwnerDisplayName,
            metadataState: .valid
        )
    }

    private static func nonBlankString(_ raw: Any?) -> String? {
        guard let value = raw as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// 同一请求可能由 runtime stream、WS relay、PendingInteraction 恢复多路投递。
/// 完整 payload 可以覆盖脱敏 payload，反向覆盖会让已展示的参数退化成等待占位。
enum HITLPromptInformationFidelity: Int, Sendable {
    case redacted
    case full

    static func resolve(prompt: HITLPrompt, envelope env: WSEnvelope) -> Self {
        if env.payloadBool("details_redacted") == true
            || env.payloadBool("__team_space_execution_redaction_required") == true {
            return .redacted
        }
        switch prompt {
        case let .approvalBatch(request) where request.hasRedactedTeamApprovalDetails:
            return .redacted
        case let .askUser(request) where request.questions.isEmpty:
            return .redacted
        case let .askForm(request) where request.fields.isEmpty:
            return .redacted
        case let .requestApproval(request) where request.title.isEmpty && request.rationale.isEmpty:
            return .redacted
        default:
            return .full
        }
    }
}

/// HITL（Human-in-the-loop）提案的强类型表示。
///
/// `WireDecoder` 把 `agent.stream.*` 里的 HITL 事件归类为 `DecodedStreamEvent.hitl(kind:, envelope:)`
/// （只带 kind + 原始 envelope）；本类型在 Phase 3 把 envelope **精解**成 vendored Wire DTO，
/// 供 Coordinator / UI 消费。解码失败返回 nil（schema 不匹配时上层忽略该事件，不中断主流程）。
///
/// 分两类（见 `isBlocking`）：
/// - **阻断类**（approval batch / askUser / askForm / requestApproval）：Agent 暂停等用户回应，
///   走 `localrt.user_response` 上行；期间编排层（Runner）须挂起超时。
/// - **非阻断类**（plan / modeSwitch）：本轮 stream 正常 `done`，提案作为 inline 卡留在消息流，
///   用户动作触发**新一轮**（plan 走 REST + 续聊，modeSwitch 走切模式 + 续聊）。
enum HITLPrompt: Sendable, Identifiable {
    case approvalBatch(ApprovalRequested)
    case actionApproval(ActionApprovalRequest)
    case askUser(AskUserRequest)
    case askForm(HITLAskFormRequest)
    case requestApproval(RequestApprovalRequest)
    case planProposal(PlanProposal)
    case modeSwitch(ModeSwitchProposal)

    /// 是否阻断当前轮（Agent 暂停等回应）。plan / modeSwitch 为非阻断 inline 卡。
    var isBlocking: Bool {
        switch self {
        case .approvalBatch, .actionApproval, .askUser, .askForm, .requestApproval:
            return true
        case .planProposal, .modeSwitch:
            return false
        }
    }

    /// 稳定标识：用于去重、approval_resolved 镜像 dismiss、inline 卡寻址。
    var id: String {
        switch self {
        case let .approvalBatch(p): return "approval:\(p.batchId)"
        case let .actionApproval(p): return "action_approval:\(p.approvalId)"
        case let .askUser(p): return "ask_user:\(p.requestId)"
        case let .askForm(p): return "ask_form:\(p.requestId)"
        case let .requestApproval(p): return "request_approval:\(p.requestId)"
        case let .planProposal(p): return "plan:\(p.planDocumentId)"
        case let .modeSwitch(p): return "mode_switch:\(p.proposalId)"
        }
    }

    /// 阻断类提案回传 `localrt.user_response` 时用的 `request_id`（batch 路径填 batch_id）。
    /// 非阻断类无 HITL 上行，返回 nil。
    var hitlRequestId: String? {
        switch self {
        case let .approvalBatch(p): return p.batchId
        case let .actionApproval(p): return p.approvalId
        case let .askUser(p): return p.requestId
        case let .askForm(p): return p.requestId
        case let .requestApproval(p): return p.requestId
        case .planProposal, .modeSwitch: return nil
        }
    }
}

/// 旧 Electron/Daemon action 审批事件（`agent.action.approval_request`）。
///
/// 这类事件不是新版 `agent.stream.approval_requested` batch 协议，但 UI 可以复用同一张
/// 审批面板；真正提交时必须走 `agent.action.approval_response`。
struct ActionApprovalRequest: Sendable, Hashable {
    let approvalId: String
    let threadId: String?
    let displayRequest: ApprovalRequested

    var batchId: String { Self.batchId(approvalId) }

    init?(envelope env: WSEnvelope) {
        guard let approvalId = env.payloadString("approval_id"), !approvalId.isEmpty else { return nil }
        self.approvalId = approvalId
        self.threadId = env.threadId ?? env.payloadString("thread_id")

        let command = env.payloadString("command") ?? ""
        let detail = Self.firstNonBlank(env.payloadString("detail"), command)
        let actionName = Self.firstNonBlank(
            env.payloadString("action_type"),
            env.payloadString("action"),
            Self.extractActionName(from: command),
            "sensitive_action"
        ) ?? "sensitive_action"

        var toolInput: [String: JSONValue] = [:]
        if let detail, !detail.isEmpty { toolInput["detail"] = .string(detail) }
        if !command.isEmpty { toolInput["command"] = .string(command) }
        if let policy = env.payload["policy"]?.value {
            toolInput["policy"] = Self.jsonValue(policy)
        }

        let actionRequest = ApprovalRequestedPayloadActionRequestsItem(
            requestId: approvalId,
            toolCallId: approvalId,
            toolName: actionName,
            toolInput: toolInput.isEmpty ? nil : .object(toolInput),
            decisionReason: .userInteractive(
                ApprovalRequestedPayloadActionRequestsItemDecisionReasonUserInteractivePayload(
                    type: "user_interactive",
                    scope: .once
                )
            ),
            askHint: ApprovalRequestedPayloadActionRequestsItemAskHint(
                summary: detail ?? "敏感操作需要确认",
                suggestedScope: .once
            ),
            allowedScopes: [.once],
            allowedOutcomes: [.allow, .deny],
            riskLevel: .high
        )

        self.displayRequest = ApprovalRequested(
            batchId: Self.batchId(approvalId),
            approvalType: "tool_permission",
            actionRequests: [actionRequest],
            runtimeMode: .interactive,
            expiresAt: Self.parseExpiresAt(from: env),
            schemaVersion: 1
        )
    }

    static func batchId(_ approvalId: String) -> String {
        "action-\(approvalId)"
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.first {
            guard let value = $0?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return !value.isEmpty
        } ?? nil
    }

    private static func extractActionName(from command: String) -> String? {
        let trimmed = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        if let colon = trimmed.firstIndex(of: ":") {
            let prefix = String(trimmed[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
            if isLikelyActionName(prefix) { return prefix }
        }

        for marker in ["请求 ", "request "] {
            if let range = trimmed.range(of: marker, options: marker == "request " ? [.caseInsensitive] : []) {
                let tail = trimmed[range.upperBound...]
                let token = tail.split { $0.isWhitespace || $0 == ":" }.first.map(String.init)
                if let token, isLikelyActionName(token) { return token }
            }
        }
        return nil
    }

    private static func parseExpiresAt(from env: WSEnvelope) -> Double {
        guard let raw = env.payload["expires_at"]?.doubleValue, raw > 0 else { return 0 }
        return raw
    }

    private static func isLikelyActionName(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        return value.allSatisfy { char in
            char.isLetter || char.isNumber || char == "." || char == "_" || char == "-"
        }
    }

    private static func jsonValue(_ value: Any) -> JSONValue {
        switch value {
        case let value as JSONValue:
            return value
        case let value as String:
            return .string(value)
        case let value as Bool:
            return .bool(value)
        case let value as Int:
            return .int(value)
        case let value as Double:
            return .double(value)
        case let value as Float:
            return .double(Double(value))
        case let value as [Any]:
            return .array(value.map(jsonValue))
        case let value as [String: Any]:
            return .object(value.mapValues(jsonValue))
        case is NSNull:
            return .null
        default:
            return .string(String(describing: value))
        }
    }
}

enum RedactedApprovalDisplay {
    static let toolName = "redacted_tool"
    static let title = "需 Owner 审批"
    static let waitingMessage = "Owner 正在审核这次操作。为保护执行环境，成员端不会显示命令、路径或工具参数。"
}

private enum RedactedApprovalRequested {
    static func decode(envelope env: WSEnvelope) -> ApprovalRequested? {
        guard isRedactedApprovalPayload(env) else { return nil }
        let actions = (env.payload["action_requests"]?.arrayValue ?? []).compactMap(decodeAction)
        guard !actions.isEmpty else { return nil }

        return ApprovalRequested(
            batchId: firstNonBlank(env.payloadString("batch_id"), env.requestId) ?? env.requestId,
            approvalType: firstNonBlank(env.payloadString("approval_type"), "tool_permission") ?? "tool_permission",
            actionRequests: actions,
            runtimeMode: runtimeMode(from: env.payloadString("runtime_mode")),
            expiresAt: env.payloadDouble("expires_at") ?? 0,
            schemaVersion: env.payloadInt("schema_version") ?? 1
        )
    }

    private static func isRedactedApprovalPayload(_ env: WSEnvelope) -> Bool {
        if env.payloadBool("details_redacted") == true { return true }
        return (env.payload["action_requests"]?.arrayValue ?? []).contains { raw in
            guard let action = raw as? [String: Any] else { return false }
            return firstString(action["tool_name"]) == RedactedApprovalDisplay.toolName
        }
    }

    private static func decodeAction(_ raw: Any) -> ApprovalRequestedPayloadActionRequestsItem? {
        guard let action = raw as? [String: Any] else { return nil }
        let stableId = firstNonBlank(
            firstString(action["request_id"]),
            firstString(action["tool_call_id"])
        )
        guard let stableId else { return nil }

        return ApprovalRequestedPayloadActionRequestsItem(
            requestId: stableId,
            toolCallId: firstNonBlank(firstString(action["tool_call_id"]), stableId) ?? stableId,
            toolName: RedactedApprovalDisplay.toolName,
            toolInput: nil,
            decisionReason: .userInteractive(
                ApprovalRequestedPayloadActionRequestsItemDecisionReasonUserInteractivePayload(
                    type: "user_interactive",
                    scope: .once
                )
            ),
            askHint: ApprovalRequestedPayloadActionRequestsItemAskHint(
                summary: RedactedApprovalDisplay.title,
                suggestedScope: .once
            ),
            allowedScopes: [.once],
            allowedOutcomes: [.allow, .deny],
            riskLevel: .high
        )
    }

    private static func runtimeMode(from raw: String?) -> ApprovalRequestedPayloadRuntimeMode {
        guard let raw, let mode = ApprovalRequestedPayloadRuntimeMode(rawValue: raw) else {
            return .interactive
        }
        return mode
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.first {
            guard let value = $0?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
            return !value.isEmpty
        } ?? nil
    }

    private static func firstString(_ value: Any?) -> String? {
        switch value {
        case let value as String:
            return value
        case let value as Int:
            return String(value)
        case let value as Double:
            return String(value)
        default:
            return nil
        }
    }
}

extension ApprovalRequestedPayloadActionRequestsItem {
    var isRedactedTeamApproval: Bool {
        toolName == RedactedApprovalDisplay.toolName
    }
}

extension ApprovalRequestedPayload {
    var hasRedactedTeamApprovalDetails: Bool {
        actionRequests.contains(where: \.isRedactedTeamApproval)
    }
}

// MARK: - ask_form UI model

/// ask_form 的 UI 侧宽松模型。
///
/// Wire DTO 由 codegen 严格生成，只保留基础字段；运行时 payload 还会携带
/// `required/options/name/id/title/prompt` 等增强字段。这里从原始 envelope lenient 解析，
/// 避免改生成文件，也让移动端表单控件与旧版成熟实现保持一致。
struct HITLAskFormRequest: Sendable, Hashable {
    struct Field: Sendable, Hashable, Identifiable {
        struct Option: Sendable, Hashable, Identifiable {
            let id: String
            let label: String
            let description: String?
        }

        let key: String
        let label: String
        let type: String
        let description: String?
        let placeholder: String?
        let required: Bool
        let options: [Option]

        var id: String { key }
    }

    let requestId: String
    let title: String
    let submitLabel: String?
    let fields: [Field]

    init(redactedRequestId requestId: String) {
        self.requestId = requestId
        self.title = ""
        self.submitLabel = nil
        self.fields = []
    }

    init?(
        envelope env: WSEnvelope,
        fallback: AskFormRequest? = nil
    ) {
        let requestId = env.payloadString("request_id")
            ?? env.payloadString("interrupt_id")
            ?? env.payloadString("message_id")
            ?? fallback?.requestId
        guard let requestId, !requestId.isEmpty else { return nil }

        self.requestId = requestId
        self.title = env.payloadString("title") ?? fallback?.title ?? "请补充信息"
        self.submitLabel = env.payloadString("submit_label") ?? fallback?.submitLabel

        let rawFields = (env.payload["fields"]?.arrayValue ?? []).compactMap { $0 as? [String: Any] }
        if !rawFields.isEmpty {
            self.fields = rawFields.enumerated().map { index, raw in
                Self.decodeField(raw, index: index)
            }
        } else if let fallback {
            self.fields = fallback.fields.enumerated().map { index, field in
                Field(
                    key: field.key.isEmpty ? "field-\(index)" : field.key,
                    label: field.label.isEmpty ? field.key : field.label,
                    type: field.type ?? "input",
                    description: field.description,
                    placeholder: field.placeholder,
                    required: false,
                    options: []
                )
            }
        } else {
            self.fields = []
        }

        guard !fields.isEmpty else { return nil }
    }

    private static func decodeField(_ raw: [String: Any], index: Int) -> Field {
        let key = firstString(raw, keys: ["key", "name", "id"]) ?? "field-\(index)"
        let label = firstString(raw, keys: ["label", "title", "prompt"]) ?? key
        let type = firstString(raw, keys: ["type"]) ?? "input"
        let options = (raw["options"] as? [[String: Any]] ?? []).enumerated().map { optionIndex, option in
            let id = firstString(option, keys: ["id", "value", "key"]) ?? "opt-\(optionIndex)"
            return Field.Option(
                id: id,
                label: firstString(option, keys: ["label", "title", "text", "name"]) ?? id,
                description: firstString(option, keys: ["description", "desc"])
            )
        }
        return Field(
            key: key,
            label: label,
            type: type,
            description: firstString(raw, keys: ["description", "desc"]),
            placeholder: firstString(raw, keys: ["placeholder"]),
            required: boolValue(raw["required"]) ?? false,
            options: options
        )
    }

    private static func firstString(_ raw: [String: Any], keys: [String]) -> String? {
        for key in keys {
            if let value = raw[key] as? String, !value.isEmpty { return value }
            if let int = raw[key] as? Int { return String(int) }
            if let double = raw[key] as? Double { return String(double) }
        }
        return nil
    }

    private static func boolValue(_ value: Any?) -> Bool? {
        if let value = value as? Bool { return value }
        if let value = value as? Int { return value != 0 }
        if let value = value as? String {
            switch value.lowercased() {
            case "true", "1", "yes", "required": return true
            case "false", "0", "no", "optional": return false
            default: return nil
            }
        }
        return nil
    }
}

extension HITLKind {
    /// 是否阻断当前轮（Agent 暂停等回应）。编排层据此挂起超时；plan/modeSwitch/approvalResolved 不阻断。
    var isBlocking: Bool {
        switch self {
        case .askUser, .askForm, .requestApproval, .approvalRequested, .actionApprovalRequested:
            return true
        case .singleHitlResolved, .planProposal, .modeSwitchProposal,
             .approvalResolved, .actionApprovalResolved:
            return false
        }
    }
}

extension HITLPrompt {
    /// 把 `WireDecoder` 透传的 `(kind, envelope)` 精解成强类型提案。schema 不匹配返回 nil。
    static func decode(
        kind: HITLKind,
        envelope env: WSEnvelope,
        allowRedactedFallback: Bool = false
    ) -> HITLPrompt? {
        let decoded: HITLPrompt?
        switch kind {
        case .askUser:
            decoded = env.decodePayload(as: AskUserRequest.self).map(HITLPrompt.askUser)
        case .askForm:
            decoded = HITLAskFormRequest(
                envelope: env,
                fallback: env.decodePayload(as: AskFormRequest.self)
            ).map(HITLPrompt.askForm)
        case .requestApproval:
            decoded = env.decodePayload(as: RequestApprovalRequest.self).map(HITLPrompt.requestApproval)
        case .approvalRequested:
            if let strict = env.decodePayload(as: ApprovalRequested.self) {
                decoded = .approvalBatch(strict)
            } else {
                decoded = RedactedApprovalRequested.decode(envelope: env).map(HITLPrompt.approvalBatch)
            }
        case .actionApprovalRequested:
            decoded = ActionApprovalRequest(envelope: env).map(HITLPrompt.actionApproval)
        case .planProposal:
            decoded = env.decodePayload(as: PlanProposal.self).map(HITLPrompt.planProposal)
        case .modeSwitchProposal:
            decoded = env.decodePayload(as: ModeSwitchProposal.self).map(HITLPrompt.modeSwitch)
        case .singleHitlResolved, .approvalResolved, .actionApprovalResolved:
            // 关闭信号，不是新提案——由 Coordinator 单独处理 dismiss（见 decodeResolved）。
            decoded = nil
        }
        if let decoded { return decoded }
        guard allowRedactedFallback,
              let requestId = nonBlankPayloadString(env, key: "request_id") else { return nil }
        return redactedBlockingPrompt(kind: kind, requestId: requestId, envelope: env)
    }

    private static func redactedBlockingPrompt(
        kind: HITLKind,
        requestId: String,
        envelope env: WSEnvelope
    ) -> HITLPrompt? {
        let messageId = env.payloadString("message_id")
        switch kind {
        case .askUser:
            return .askUser(AskUserRequest(
                requestId: requestId,
                toolName: "ask_user",
                questions: [],
                interactionType: "choice",
                blockingPolicy: "blocking",
                intent: "clarify",
                formMode: "single",
                messageId: messageId
            ))
        case .askForm:
            return .askForm(HITLAskFormRequest(redactedRequestId: requestId))
        case .requestApproval:
            return .requestApproval(RequestApprovalRequest(
                requestId: requestId,
                toolName: "request_approval",
                title: "",
                rationale: "",
                riskLevel: .high,
                interactionType: "ask_user",
                blockingPolicy: "hard",
                intent: "approve",
                formMode: "approval",
                messageId: messageId
            ))
        case .singleHitlResolved, .approvalRequested, .actionApprovalRequested, .planProposal,
             .modeSwitchProposal, .approvalResolved, .actionApprovalResolved:
            return nil
        }
    }

    private static func nonBlankPayloadString(_ env: WSEnvelope, key: String) -> String? {
        guard let value = env.payloadString(key)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !value.isEmpty else { return nil }
        return value
    }

    /// 解析 `approval_resolved` 关闭信号 → 需 dismiss 的 batch_id（用于多端 race 后镜像收起面板）。
    static func decodeResolvedBatchId(envelope env: WSEnvelope) -> String? {
        if let resolved = env.decodePayload(as: ApprovalResolved.self) {
            return resolved.batchId
        }
        if let approvalId = env.payloadString("approval_id"), !approvalId.isEmpty {
            return ActionApprovalRequest.batchId(approvalId)
        }
        return env.payloadString("batch_id")
    }
}

// MARK: - 用户响应输入（UI → Coordinator）

/// AskUser 单题作答。
struct AskUserAnswerInput: Sendable, Equatable {
    let questionId: String
    let selectedOptions: [String]
    let freeText: String?
}

/// AskUser 选择题的提交语义，对齐 Electron：
/// - `__other__` 是唯一会携带 `free_text` 的选项；
/// - 选中 Other 后必须填写自定义答案；
/// - 普通选项不会带上曾经输入但已隐藏的自定义文本；
/// - 多选按服务端选项顺序输出，避免 Set 导致回执顺序抖动。
enum AskUserAnswerDraft {
    static let otherOptionId = "__other__"

    static func isOtherSelected(_ selected: Set<String>) -> Bool {
        selected.contains(otherOptionId)
    }

    static func canSubmit(
        question: AskUserRequestQuestionsItem,
        selected: Set<String>,
        freeText: String
    ) -> Bool {
        guard !selected.isEmpty else { return false }
        guard isOtherSelected(selected) else { return true }
        return !freeText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func answer(
        question: AskUserRequestQuestionsItem,
        selected: Set<String>,
        freeText: String
    ) -> AskUserAnswerInput {
        let knownOrder = Dictionary(
            uniqueKeysWithValues: question.options.enumerated().map { ($0.element.id, $0.offset) }
        )
        let orderedSelection = selected.sorted { lhs, rhs in
            let left = knownOrder[lhs] ?? Int.max
            let right = knownOrder[rhs] ?? Int.max
            return left == right ? lhs < rhs : left < right
        }
        let customAnswer = isOtherSelected(selected)
            ? freeText.trimmingCharacters(in: .whitespacesAndNewlines)
            : ""
        return AskUserAnswerInput(
            questionId: question.id,
            selectedOptions: orderedSelection,
            freeText: customAnswer.isEmpty ? nil : customAnswer
        )
    }
}

// MARK: - 胶囊就地 HITL 投射

enum CapsuleHITLBubbleKind: Equatable, Sendable {
    case approval
    case choice
}

enum CapsuleHITLBubbleActionRole: Equatable, Sendable {
    case primary
    case destructive
    case secondary
}

enum CapsuleHITLBubbleIntent: Equatable, Sendable {
    case approve(scope: String)
    case deny
    case approveRequest
    case denyRequest
    case answer(questionId: String, optionId: String)
    case openConversation
}

struct CapsuleHITLBubbleAction: Equatable, Sendable, Identifiable {
    let title: String
    let role: CapsuleHITLBubbleActionRole
    let intent: CapsuleHITLBubbleIntent

    var id: String {
        switch intent {
        case let .approve(scope): return "approve:\(scope)"
        case .deny: return "deny"
        case .approveRequest: return "approve-request"
        case .denyRequest: return "deny-request"
        case let .answer(questionId, optionId): return "answer:\(questionId):\(optionId)"
        case .openConversation: return "open-conversation"
        }
    }
}

struct CapsuleHITLBubblePresentation: Equatable, Sendable, Identifiable {
    let id: String
    let kind: CapsuleHITLBubbleKind
    let title: String?
    let message: String
    let actions: [CapsuleHITLBubbleAction]
}

/// 把阻断类 HITL 收敛成胶囊旁可安全执行的最小动作集。
///
/// 这里只投射现有协议已经支持的决定，不持有额外“已处理”状态；气泡生命周期始终跟随
/// `HITLCoordinator.pending`，因此 ACK 失败会原位保留，成功 / 多端 resolved 才消失。
enum CapsuleHITLBubbleProjection {
    static let maximumQuickChoiceCount = 4

    static func presentation(
        for prompt: HITLPrompt?,
        canResolve: Bool
    ) -> CapsuleHITLBubblePresentation? {
        guard let prompt else { return nil }
        switch prompt {
        case let .approvalBatch(request):
            return approval(
                id: prompt.id,
                request: request,
                canResolve: canResolve
            )
        case let .actionApproval(request):
            return approval(
                id: prompt.id,
                request: request.displayRequest,
                canResolve: canResolve
            )
        case let .askUser(request):
            return choice(
                id: prompt.id,
                request: request,
                canResolve: canResolve
            )
        case let .requestApproval(request):
            return requestApproval(
                id: prompt.id,
                request: request,
                canResolve: canResolve
            )
        case let .askForm(request):
            return askForm(
                id: prompt.id,
                request: request,
                canResolve: canResolve
            )
        case .planProposal, .modeSwitch:
            return nil
        }
    }

    private static func askForm(
        id: String,
        request: HITLAskFormRequest,
        canResolve: Bool
    ) -> CapsuleHITLBubblePresentation {
        let message: String
        let actionTitle: String
        if canResolve {
            let title = request.title.trimmingCharacters(in: .whitespacesAndNewlines)
            let firstFieldSummary = request.fields.first.flatMap { field in
                nonBlank(field.description) ?? nonBlank(field.label)
            }
            message = [nonBlank(title), firstFieldSummary]
                .compactMap { $0 }
                .reduce(into: [String]()) { parts, part in
                    if parts.last != part { parts.append(part) }
                }
                .joined(separator: "\n")
            actionTitle = L10n.Agent.capsuleHITLAnswerInConversation
        } else {
            message = L10n.Agent.capsuleHITLWaitingOwnerAnswer
            actionTitle = L10n.Agent.capsuleHITLViewDetails
        }
        return CapsuleHITLBubblePresentation(
            id: id,
            kind: .choice,
            title: nonBlank(request.title),
            message: message.isEmpty ? L10n.Agent.capsuleHITLChoiceFallback : message,
            actions: [openConversationAction(title: actionTitle)]
        )
    }

    private static func requestApproval(
        id: String,
        request: RequestApprovalRequest,
        canResolve: Bool
    ) -> CapsuleHITLBubblePresentation {
        var actions: [CapsuleHITLBubbleAction] = []
        if canResolve {
            if request.riskLevel == .safe {
                actions.append(CapsuleHITLBubbleAction(
                    title: nonBlank(request.submitLabel) ?? L10n.Agent.capsuleHITLApprove,
                    role: .primary,
                    intent: .approveRequest
                ))
            }
            actions.append(CapsuleHITLBubbleAction(
                title: nonBlank(request.declineLabel) ?? L10n.Agent.capsuleHITLDeny,
                role: .destructive,
                intent: .denyRequest
            ))
        }
        actions.append(openConversationAction(title: L10n.Agent.capsuleHITLViewDetails))
        let message = canResolve
            ? (nonBlank(request.rationale) ?? nonBlank(request.title)
                ?? L10n.Agent.capsuleHITLApprovalKind)
            : L10n.Agent.capsuleHITLWaitingOwnerApproval
        return CapsuleHITLBubblePresentation(
            id: id,
            kind: .approval,
            title: nonBlank(request.title),
            message: message,
            actions: actions
        )
    }

    private static func choice(
        id: String,
        request: AskUserRequest,
        canResolve: Bool
    ) -> CapsuleHITLBubblePresentation {
        guard canResolve else {
            return CapsuleHITLBubblePresentation(
                id: id,
                kind: .choice,
                title: nonBlank(request.title),
                message: L10n.Agent.capsuleHITLWaitingOwnerAnswer,
                actions: [openConversationAction(title: L10n.Agent.capsuleHITLViewDetails)]
            )
        }

        guard request.questions.count == 1, let question = request.questions.first else {
            return CapsuleHITLBubblePresentation(
                id: id,
                kind: .choice,
                title: nonBlank(request.title),
                message: choiceMessage(request: request, question: nil),
                actions: [openConversationAction(title: L10n.Agent.capsuleHITLAnswerInConversation)]
            )
        }

        let quickOptions = question.options.filter { $0.id != AskUserAnswerDraft.otherOptionId }
        let allowsQuickAnswer = question.allowMultiple != true
            && question.allowFreeText != true
            && question.otherOption == nil
            && quickOptions.count == question.options.count
            && !quickOptions.isEmpty
            && quickOptions.count <= maximumQuickChoiceCount
        var actions: [CapsuleHITLBubbleAction] = allowsQuickAnswer
            ? quickOptions.enumerated().map { index, option in
                CapsuleHITLBubbleAction(
                    title: option.label,
                    role: index == 0 ? .primary : .secondary,
                    intent: .answer(questionId: question.id, optionId: option.id)
                )
            }
            : []
        if !allowsQuickAnswer {
            actions.append(openConversationAction(title: L10n.Agent.capsuleHITLAnswerInConversation))
        }

        return CapsuleHITLBubblePresentation(
            id: id,
            kind: .choice,
            title: nonBlank(request.title),
            message: choiceMessage(request: request, question: question),
            actions: actions
        )
    }

    private static func approval(
        id: String,
        request: ApprovalRequested,
        canResolve: Bool
    ) -> CapsuleHITLBubblePresentation {
        let actions = request.actionRequests
        let allowedOutcomes = commonAllowedOutcomes(actions)
        let isRedacted = request.hasRedactedTeamApprovalDetails
        var bubbleActions: [CapsuleHITLBubbleAction] = []

        if canResolve, !isRedacted {
            if allowedOutcomes.contains("allow"),
               ApprovalDockPolicy.allowsDirectApproval(actions),
               let leastPrivilegeScope = leastPrivilegeScope(for: actions) {
                bubbleActions.append(CapsuleHITLBubbleAction(
                    title: L10n.Agent.capsuleHITLApprove,
                    role: .primary,
                    intent: .approve(scope: leastPrivilegeScope)
                ))
            }
            if allowedOutcomes.contains("deny") {
                bubbleActions.append(CapsuleHITLBubbleAction(
                    title: L10n.Agent.capsuleHITLDeny,
                    role: .destructive,
                    intent: .deny
                ))
            }
        }
        bubbleActions.append(CapsuleHITLBubbleAction(
            title: L10n.Agent.capsuleHITLViewDetails,
            role: .secondary,
            intent: .openConversation
        ))

        return CapsuleHITLBubblePresentation(
            id: id,
            kind: .approval,
            title: approvalTitle(request: request, canResolve: canResolve),
            message: approvalMessage(request: request, canResolve: canResolve),
            actions: bubbleActions
        )
    }

    private static func commonAllowedOutcomes(
        _ actions: [ApprovalRequestedPayloadActionRequestsItem]
    ) -> Set<String> {
        guard let first = actions.first else { return [] }
        return actions.dropFirst().reduce(Set(first.allowedOutcomes.map(\.rawValue))) { result, item in
            result.intersection(item.allowedOutcomes.map(\.rawValue))
        }
    }

    private static func commonAllowedScopes(
        _ actions: [ApprovalRequestedPayloadActionRequestsItem]
    ) -> [String] {
        guard let first = actions.first else { return [] }
        let common = actions.dropFirst().reduce(Set(first.allowedScopes.map(\.rawValue))) { result, item in
            result.intersection(item.allowedScopes.map(\.rawValue))
        }
        return ["once", "thread", "always"].filter(common.contains)
    }

    private static func leastPrivilegeScope(
        for actions: [ApprovalRequestedPayloadActionRequestsItem]
    ) -> String? {
        commonAllowedScopes(actions).first
    }

    private static func approvalMessage(
        request: ApprovalRequested,
        canResolve: Bool
    ) -> String {
        guard canResolve, !request.hasRedactedTeamApprovalDetails else {
            return L10n.Agent.capsuleHITLWaitingOwnerApproval
        }
        guard request.actionRequests.count == 1,
              let action = request.actionRequests.first else {
            return L10n.Agent.capsuleHITLApprovalBatch(request.actionRequests.count)
        }
        if let summary = action.askHint?.summary.trimmingCharacters(in: .whitespacesAndNewlines),
           !summary.isEmpty {
            return summary
        }
        let layout = ApprovalPresentation.layout(from: action.toolInput)
        if let command = layout.command?.value { return command }
        if let value = layout.primaryRows.first?.value { return value }
        return L10n.Agent.capsuleHITLApprovalToolRequest(ToolPresentation.of(action.toolName).verb)
    }

    private static func approvalTitle(
        request: ApprovalRequested,
        canResolve: Bool
    ) -> String? {
        guard canResolve,
              !request.hasRedactedTeamApprovalDetails,
              request.actionRequests.count == 1,
              let toolName = request.actionRequests.first?.toolName
        else { return nil }
        return nonBlank(toolName)
    }

    private static func choiceMessage(
        request: AskUserRequest,
        question: AskUserRequestQuestionsItem?
    ) -> String {
        for candidate in [question?.prompt, question?.header, request.message, request.title] {
            if let text = candidate?.trimmingCharacters(in: .whitespacesAndNewlines),
               !text.isEmpty {
                return text
            }
        }
        return L10n.Agent.capsuleHITLChoiceFallback
    }

    private static func openConversationAction(title: String) -> CapsuleHITLBubbleAction {
        CapsuleHITLBubbleAction(
            title: title,
            role: .secondary,
            intent: .openConversation
        )
    }

    private static func nonBlank(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

// MARK: - 审批展示模型

struct ApprovalParameterRow: Identifiable, Sendable, Equatable {
    enum Style: Sendable, Equatable {
        case text
        case code
        case path
    }

    let key: String
    let label: String
    let value: String
    let style: Style

    var id: String { key }
}

/// 单条审批操作的信息分层：命令块 / 主区字段 / 折叠区字段。
///
/// 决策视线只留「做什么」（命令 + 最多两个关键字段），其余参数一律收进折叠区，
/// 避免整屏同权重灰字把关键信息淹没。
struct ApprovalActionLayout: Sendable, Equatable {
    let command: ApprovalParameterRow?
    let primaryRows: [ApprovalParameterRow]
    let collapsedRows: [ApprovalParameterRow]

    static let empty = ApprovalActionLayout(command: nil, primaryRows: [], collapsedRows: [])
}

/// 风险提示行。只在真正需要提醒时产出——低风险不再输出「安全」类文案，
/// 因为风险分级低不等于我们担保它安全。
struct ApprovalRiskHint: Sendable, Equatable {
    enum Emphasis: Sendable, Equatable {
        case critical
        case warning
    }

    let text: String
    let emphasis: Emphasis
}

/// 授权范围的标题与后果说明。后果说明只给当前选中项，避免三行小字同时压在决策区。
enum ApprovalScopePresentation {
    static func label(_ scope: String) -> String {
        switch scope {
        case "thread": return "本会话"
        case "always": return "始终"
        default: return "仅此次"
        }
    }

    static func consequence(_ scope: String) -> String {
        switch scope {
        case "thread": return "本次对话内同类操作不再询问。"
        case "always": return "以后同类操作都自动执行，可在设置里撤销。"
        default: return "只批准这一次，下次同样操作还会问你。"
        }
    }
}

/// 收起态（Dock）能否直接批准。手机上单手误触代价高，只有「单条 + 非高风险 + 工作区内」
/// 才允许一键放行；其余一律要求展开详情后确认。
enum ApprovalDockPolicy {
    static func allowsDirectApproval(
        _ actions: [ApprovalRequestedPayloadActionRequestsItem]
    ) -> Bool {
        guard actions.count == 1, let action = actions.first else { return false }
        guard action.riskLevel != .high else { return false }
        switch ApprovalPresentation.workspaceZone(for: action.decisionReason) {
        case "sensitive", "outside":
            return false
        default:
            return true
        }
    }
}

/// 把审批的任意 JSON 入参转换为稳定的「字段名 + 值」列表。
/// UI 不再展示整段 raw JSON；已知字段用产品词汇，未知字段也逐项展开，不丢信息。
enum ApprovalPresentation {
    private struct FieldGroup {
        let keys: [String]
        let label: String
        let style: ApprovalParameterRow.Style
    }

    private static let fieldGroups: [FieldGroup] = [
        FieldGroup(
            keys: ["command", "cmd", "shell_command", "shell", "script"],
            label: "命令",
            style: .code
        ),
        FieldGroup(
            keys: ["path", "file_path", "filepath", "target_file", "file", "uri", "destination"],
            label: "路径",
            style: .path
        ),
        FieldGroup(
            keys: ["cwd", "working_dir", "workdir", "directory", "dir"],
            label: "目录",
            style: .path
        ),
        FieldGroup(keys: ["url", "href"], label: "地址", style: .code),
        FieldGroup(
            keys: ["query", "search_query", "search_term", "prompt", "question", "input"],
            label: "查询",
            style: .text
        ),
        FieldGroup(
            keys: ["pattern", "regex", "glob", "include", "exclude"],
            label: "模式",
            style: .code
        ),
        FieldGroup(keys: ["skill"], label: "Skill", style: .text),
    ]

    static func explanation(from input: JSONValue?) -> String? {
        guard case let .object(values) = input,
              let explanation = displayValue(values["explanation"]) else { return nil }
        return explanation
    }

    static func parameterRows(from input: JSONValue?) -> [ApprovalParameterRow] {
        guard case let .object(values) = input else { return [] }
        var rows: [ApprovalParameterRow] = []
        var consumed = Set(["explanation"])

        for group in fieldGroups {
            guard let key = group.keys.first(where: { displayValue(values[$0]) != nil }),
                  let value = displayValue(values[key]) else { continue }
            rows.append(ApprovalParameterRow(
                key: key,
                label: group.label,
                value: value,
                style: group.style
            ))
            consumed.formUnion(group.keys)
        }

        if rows.contains(where: { $0.label == "Skill" }),
           let value = displayValue(values["args"]) {
            rows.append(ApprovalParameterRow(key: "args", label: "参数", value: value, style: .text))
            consumed.insert("args")
        }

        for key in values.keys.sorted() where !consumed.contains(key) {
            guard let value = displayValue(values[key]) else { continue }
            rows.append(ApprovalParameterRow(
                key: key,
                label: friendlyLabel(key),
                value: value,
                style: inferredStyle(for: key)
            ))
        }
        return rows
    }

    /// 命令行的字段名。命令单独成块（独立底色 + 拷贝），不与普通字段混排。
    static let commandLabel = "命令"

    /// 主区允许出现的已知语义字段；未知字段一律进折叠区。
    private static let primaryRowLabels: Set<String> = ["路径", "目录", "地址", "查询", "模式", "Skill", "参数"]

    /// 主区最多两条字段——再多就不是「一眼看懂」，而是又一屏小字。
    private static let primaryRowLimit = 2

    static func layout(from input: JSONValue?) -> ApprovalActionLayout {
        layout(rows: parameterRows(from: input))
    }

    static func layout(rows: [ApprovalParameterRow]) -> ApprovalActionLayout {
        var candidates = rows
        var command: ApprovalParameterRow?
        if let index = candidates.firstIndex(where: { $0.label == commandLabel }) {
            command = candidates.remove(at: index)
        }

        var primaryRows: [ApprovalParameterRow] = []
        var collapsedRows: [ApprovalParameterRow] = []
        for row in candidates {
            if primaryRows.count < primaryRowLimit, primaryRowLabels.contains(row.label) {
                primaryRows.append(row)
            } else {
                collapsedRows.append(row)
            }
        }
        return ApprovalActionLayout(
            command: command,
            primaryRows: primaryRows,
            collapsedRows: collapsedRows
        )
    }

    /// 要不要显示风险行。普通 low 不占位；越界 / 敏感资源必须在无侧条卡片里保留提示。
    static func riskHint(
        level: ApprovalRequestedPayloadActionRequestsItemRiskLevel?,
        workspaceZone: String? = nil
    ) -> ApprovalRiskHint? {
        guard let level else {
            guard workspaceZone == "sensitive" || workspaceZone == "outside",
                  let text = riskDetail(level: .medium, workspaceZone: workspaceZone) else { return nil }
            return ApprovalRiskHint(text: text, emphasis: .warning)
        }
        guard let text = riskDetail(level: level, workspaceZone: workspaceZone) else { return nil }
        switch level {
        case .high:
            return ApprovalRiskHint(text: text, emphasis: .critical)
        case .medium:
            guard workspaceZone == "sensitive" || workspaceZone == "outside" else { return nil }
            return ApprovalRiskHint(text: text, emphasis: .warning)
        case .low:
            guard workspaceZone == "sensitive" || workspaceZone == "outside" else { return nil }
            return ApprovalRiskHint(text: text, emphasis: .warning)
        }
    }

    /// 工作区归属。只有明确越界 / 触达敏感资源才回值，其余保持 nil。
    ///
    /// 为什么从判决理由反推而不读 `workspace_zone`：该字段在 runtime 生产链路上并未下发
    /// ，Electron 读它得到的是恒 false。判决理由是同一事实的另一种表达，
    /// 而且确实有下发，所以这里以它为准。Android `ApprovalPresentation.workspaceZone`
    /// 同口径（它多一层字段优先，因为 Android wire 模型解了这个字段）。
    static func workspaceZone(
        for reason: ApprovalRequestedPayloadActionRequestsItemDecisionReason
    ) -> String? {
        switch reason {
        case .workspaceOut, .denyReadPath, .denyWritePath:
            return "outside"
        case .sensitiveOutDeny, .sensitiveInAsk:
            return "sensitive"
        default:
            return nil
        }
    }

    static func riskDetail(
        level: ApprovalRequestedPayloadActionRequestsItemRiskLevel?,
        workspaceZone: String? = nil
    ) -> String? {
        guard let level else { return nil }
        let risk: String
        switch level {
        case .high:
            risk = "高风险：可能产生不可逆或敏感影响，请仔细核对。"
        case .medium:
            risk = "需留意：此操作会修改状态或访问受限资源。"
        case .low:
            risk = "低风险：执行前仍请确认目标和参数。"
        }
        switch workspaceZone {
        case "sensitive":
            return "\(risk) 将触达受保护资源。"
        case "outside":
            return "\(risk) 目标位于当前工作区之外。"
        default:
            return risk
        }
    }

    private static func displayValue(_ value: JSONValue?) -> String? {
        guard let value else { return nil }
        switch value {
        case .null:
            return nil
        case let .string(text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        case let .bool(value):
            return value ? "是" : "否"
        case let .int(value):
            return String(value)
        case let .double(value):
            return value.rounded() == value ? String(Int(value)) : String(value)
        case let .array(values):
            let parts = values.compactMap(displayValue)
            return parts.isEmpty ? nil : parts.joined(separator: "、")
        case let .object(values):
            let parts = values.keys.sorted().compactMap { key -> String? in
                guard let value = displayValue(values[key]) else { return nil }
                return "\(friendlyLabel(key))：\(value)"
            }
            return parts.isEmpty ? nil : parts.joined(separator: "；")
        }
    }

    private static func friendlyLabel(_ key: String) -> String {
        key.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
    }

    private static func inferredStyle(for key: String) -> ApprovalParameterRow.Style {
        let normalized = key.lowercased()
        if normalized.contains("path") || normalized.contains("file") {
            return .path
        }
        if normalized.contains("command") || normalized == "cmd"
            || normalized.contains("url") || normalized.contains("uri") {
            return .code
        }
        return .text
    }
}

// MARK: - Plan 执行事务

enum PlanExecutionResult: Sendable, Equatable {
    case accepted
    case alreadyAccepted
    case failed(String)
}

struct PlanExecutionTransaction: Sendable, Equatable {
    enum Phase: Sendable, Equatable {
        case idle
        case executing
        case succeeded
        case failed(String)
    }

    private(set) var phase: Phase = .idle

    var isExecuting: Bool { phase == .executing }
    var isSucceeded: Bool { phase == .succeeded }
    var errorMessage: String? {
        guard case let .failed(message) = phase else { return nil }
        return message
    }

    /// 只有空闲或失败态可开启新事务；执行中和成功态的重复点击直接拒绝。
    mutating func begin() -> Bool {
        switch phase {
        case .idle, .failed:
            phase = .executing
            return true
        case .executing, .succeeded:
            return false
        }
    }

    /// 只允许当前执行中的事务提交结果，防止旧 Task 的迟到结果覆盖新状态。
    mutating func finish(_ result: PlanExecutionResult) {
        guard phase == .executing else { return }
        switch result {
        case .accepted, .alreadyAccepted:
            phase = .succeeded
        case let .failed(message):
            let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
            phase = .failed(trimmed.isEmpty ? "启动执行失败，请重试。" : trimmed)
        }
    }
}
