import Foundation
import os

/// 一次审批决定（UI → Coordinator），对应 `approval_requested.action_requests[]` 的一条。
struct ApprovalDecisionInput: Sendable, Equatable {
    let requestId: String
    let toolCallId: String
    /// "allow" | "deny"（对齐 zod，**不是** approve/reject）。
    let outcome: String
    /// 仅 allow 时有意义："once" | "thread" | "always"。
    let scope: String?
    /// 仅 deny 时携带：拒绝理由回传 Agent。
    let rejectionMessage: String?
}

struct HITLOutboundRequest {
    let type: String
    let payload: [String: Any]
    let okType: String
    let nakType: String
    let threadId: String
    let timeout: TimeInterval
}

typealias HITLRequestSender = @MainActor (HITLOutboundRequest) async -> AckResult

/// HITL 阻断类提案的协调器（§4.3 的 HITLCoordinator）。
///
/// 职责：按到达顺序持有**阻断类**待回应提案（approval batch / askUser / askForm / requestApproval），
/// 把用户响应组装成 `localrt.user_response` 上行并按 request_id 等 ack，处理 `already_consumed`
/// 幂等收起，以及 `approval_resolved` 多端 race 镜像 dismiss。
///
/// 非阻断类（plan / modeSwitch）**不经本协调器**——它们是 inline 消息卡，由 ConversationViewModel
/// 投射进消息流、用户动作触发新一轮（见 ConversationViewModel.handleHITL）。
///
/// 传输：复用 `RealtimeGateway.sendRequest`（与 chat.send_message 同一条连接 + ack 关联机制）。
/// 新版 HITL 走 `localrt.user_response`；旧 action 审批走 `agent.action.approval_response`。
@MainActor
@Observable
final class HITLCoordinator {
    let sessionId: String
    private let requestSender: HITLRequestSender
    private let currentUserIdProvider: @MainActor () -> String?
    private let logger = Logger(subsystem: "com.tabtin.mobile", category: "HITL")

    private var threadId: String { "chat-session-\(sessionId)" }

    /// 当前展示的阻断类提案。后续提案进入 FIFO，避免多个 Agent 同时请求时互相覆盖。
    private(set) var pending: HITLPrompt?
    private var pendingQueue: [HITLPrompt] = []
    private var resolutionAccessByPromptId: [String: HITLResolutionAccess] = [:]
    private var informationFidelityByPromptId: [String: HITLPromptInformationFidelity] = [:]
    /// 用户级 interaction 事件与 agent.stream 事件来自两条可靠通道，可能乱序。
    /// 一旦单请求 HITL 进入终态，迟到的 required 只能被忽略，不能重新打开面板。
    private var resolvedSingleHitlRequestIds: Set<String> = []
    private var resolvedSingleHitlRequestIdOrder: [String] = []
    private let maxResolvedSingleHitlRequestIds = 512
    var pendingCount: Int { (pending == nil ? 0 : 1) + pendingQueue.count }
    var additionalPendingCount: Int { pendingQueue.count }
    var pendingResolutionAccess: HITLResolutionAccess {
        guard let pending else { return .unrestricted }
        return resolutionAccessByPromptId[pending.id] ?? .unrestricted
    }
    var canResolvePending: Bool { pendingResolutionAccess.canResolve }
    var pendingExecutionOwnerDisplayName: String? {
        pendingResolutionAccess.executionOwnerDisplayName
    }
    /// 正在提交回应（UI 据此禁用按钮 + 转圈）。
    private(set) var isSubmitting = false
    private var submittingPromptId: String?
    /// 最近一次提交失败文案（UI 顶部提示，提交成功清空）。
    private(set) var submitError: String?
    private var expirationTask: Task<Void, Never>?

    init(
        sessionId: String,
        gateway: RealtimeGateway = .shared,
        currentUserIdProvider: @escaping @MainActor () -> String? = {
            AuthService.shared.currentUser?.id
        },
        requestSender: HITLRequestSender? = nil
    ) {
        self.sessionId = sessionId
        self.currentUserIdProvider = currentUserIdProvider
        self.requestSender = requestSender ?? { request in
            await gateway.sendRequest(
                type: request.type,
                payload: request.payload,
                okType: request.okType,
                nakType: request.nakType,
                threadId: request.threadId,
                timeout: request.timeout
            )
        }
    }

    // MARK: - 入口：消费 HITL 事件

    /// 消费阻断类 HITL 事件 / approval_resolved 关闭信号。plan / modeSwitch 不应走这里。
    func ingest(kind: HITLKind, envelope env: WSEnvelope) {
        if kind == .singleHitlResolved {
            dismissOnSingleHitlResolved(envelope: env)
            return
        }
        if kind == .approvalResolved || kind == .actionApprovalResolved {
            dismissOnResolved(envelope: env)
            return
        }
        let access = HITLResolutionAccess.resolve(
            envelope: env,
            currentUserId: currentUserIdProvider()
        )
        guard let prompt = HITLPrompt.decode(
            kind: kind,
            envelope: env,
            allowRedactedFallback: !access.canResolve
        ), prompt.isBlocking else {
            logger.warning("ignored non-blocking or undecodable HITL kind in coordinator")
            return
        }
        let fidelity = HITLPromptInformationFidelity.resolve(prompt: prompt, envelope: env)
        if let requestId = singleHitlRequestId(for: prompt),
           resolvedSingleHitlRequestIds.contains(requestId) {
            return
        }
        if enqueue(prompt, access: access, fidelity: fidelity) {
            submitError = nil
        }
    }

    /// 本地收起当前提案（用户主动取消，不回传后端）。
    func dismiss() {
        guard let promptId = pending?.id else { return }
        removePrompt(id: promptId, markResolved: false)
        submitError = nil
    }

    func dismissResolvedInteraction(kind: String, threadId resolvedThreadId: String, requestKey: String) {
        if Self.isSingleHitlInteractionKind(kind) {
            rememberResolvedSingleHitlRequestId(requestKey)
        }
        let prompts = [pending].compactMap { $0 } + pendingQueue
        guard let matched = prompts.first(where: {
            matches(
                $0,
                interactionKind: kind,
                resolvedThreadId: resolvedThreadId,
                requestKey: requestKey
            )
        }) else {
            return
        }
        removePrompt(id: matched.id, markResolved: true)
        submitError = nil
    }

    // MARK: - 响应：approval batch

    func submitApprovalBatch(batchId: String, decisions: [ApprovalDecisionInput]) async {
        let decisionDicts: [[String: Any]] = decisions.map { d in
            var dict: [String: Any] = [
                "request_id": d.requestId,
                "tool_call_id": d.toolCallId,
                "outcome": d.outcome,
            ]
            if let scope = d.scope { dict["scope"] = scope }
            if let msg = d.rejectionMessage, !msg.isEmpty { dict["rejection_message"] = msg }
            return dict
        }
        let response: [String: Any] = ["batch_id": batchId, "decisions": decisionDicts]
        // batch 路径：envelope request_id 承载 batch_id（与 Electron renderer 一致，服务端仲裁键已升级为 batch）。
        await send(response: response, requestId: batchId)
    }

    /// 旧 `agent.action.approval_request` 的回应通道。
    func submitActionApproval(
        approvalId: String,
        threadId explicitThreadId: String?,
        approved: Bool,
        scope: String?
    ) async {
        let promptId = "action_approval:\(approvalId)"
        guard beginSubmission(promptId: promptId) else { return }
        submitError = nil
        defer { finishSubmission(promptId: promptId) }

        let resolvedThreadId = explicitThreadId ?? threadId
        var payload: [String: Any] = [
            "approval_id": approvalId,
            "approved": approved,
            "thread_id": resolvedThreadId,
        ]
        if approved, let scope, !scope.isEmpty {
            payload["scope"] = scope
        }

        let ack = await requestSender(HITLOutboundRequest(
            type: "agent.action.approval_response",
            payload: payload,
            okType: "agent.action.approval_response.ok",
            nakType: "agent.action.approval_response.nak",
            threadId: resolvedThreadId,
            timeout: 15
        ))
        handleSubmitAck(ack, promptId: promptId)
    }

    // MARK: - 响应：askUser / askForm / requestApproval

    func submitAskUser(_ answers: [AskUserAnswerInput], requestId: String) async {
        let payloadAnswers: [[String: Any]] = answers.map { ans in
            var dict: [String: Any] = [
                "question_id": ans.questionId,
                "selected_options": ans.selectedOptions,
            ]
            if let ft = ans.freeText, !ft.isEmpty { dict["free_text"] = ft }
            return dict
        }
        await send(response: ["answers": payloadAnswers], requestId: requestId)
    }

    func skipAskUser(requestId: String) async {
        await send(response: ["skipped": true], requestId: requestId)
    }

    func submitAskForm(_ fieldValues: [String: Any], requestId: String) async {
        await send(response: ["field_values": fieldValues], requestId: requestId)
    }

    func skipAskForm(requestId: String) async {
        await send(response: ["skipped": true], requestId: requestId)
    }

    func submitRequestApproval(_ approved: Bool, requestId: String) async {
        await send(response: ["approved": approved], requestId: requestId)
    }

    /// 胶囊气泡的动作入口。`promptId` 把按钮绑定到用户实际看到的请求，避免上一项刚刚
    /// resolved、队列推进后，迟到的点击误答下一项。
    func submitCapsuleHITLIntent(
        _ intent: CapsuleHITLBubbleIntent,
        promptId: String
    ) async {
        guard canResolvePending,
              pending?.id == promptId,
              !isSubmitting else { return }

        switch intent {
        case let .approve(scope):
            guard let request = pendingApprovalRequest,
                  !request.hasRedactedTeamApprovalDetails,
                  ApprovalDockPolicy.allowsDirectApproval(request.actionRequests) else { return }
            await submitApprovalDecision(
                promptId: promptId,
                outcome: "allow",
                scope: scope,
                rejectionMessage: nil
            )
        case .deny:
            await submitApprovalDecision(
                promptId: promptId,
                outcome: "deny",
                scope: nil,
                rejectionMessage: nil
            )
        case .approveRequest:
            guard case let .requestApproval(request) = pending,
                  request.riskLevel == .safe else { return }
            await submitRequestApproval(true, requestId: request.requestId)
        case .denyRequest:
            guard case let .requestApproval(request) = pending else { return }
            await submitRequestApproval(false, requestId: request.requestId)
        case let .answer(questionId, optionId):
            guard case let .askUser(request) = pending,
                  request.questions.count == 1,
                  let question = request.questions.first,
                  question.id == questionId,
                  question.allowMultiple != true,
                  question.allowFreeText != true,
                  question.otherOption == nil,
                  !question.options.isEmpty,
                  question.options.count <= CapsuleHITLBubbleProjection.maximumQuickChoiceCount,
                  !question.options.contains(where: { $0.id == AskUserAnswerDraft.otherOptionId }),
                  optionId != AskUserAnswerDraft.otherOptionId,
                  question.options.contains(where: { $0.id == optionId }) else { return }
            let answer = AskUserAnswerDraft.answer(
                question: question,
                selected: [optionId],
                freeText: ""
            )
            await submitAskUser([answer], requestId: request.requestId)
        case .openConversation:
            break
        }
    }

    /// 新旧审批协议的共享提交口。完整面板与胶囊气泡都经这里映射到既有 wire 动作，
    /// 不在视图层分别拼 payload。
    func submitApprovalDecision(
        promptId: String,
        outcome: String,
        scope: String?,
        rejectionMessage: String?
    ) async {
        guard canResolvePending,
              let prompt = pending,
              prompt.id == promptId else { return }

        let request: ApprovalRequested
        let actionApprovalId: String?
        let actionThreadId: String?
        switch prompt {
        case let .approvalBatch(value):
            request = value
            actionApprovalId = nil
            actionThreadId = nil
        case let .actionApproval(value):
            request = value.displayRequest
            actionApprovalId = value.approvalId
            actionThreadId = value.threadId
        case .askUser, .askForm, .requestApproval, .planProposal, .modeSwitch:
            return
        }

        let commonOutcomes = request.actionRequests.dropFirst().reduce(
            Set(request.actionRequests.first?.allowedOutcomes.map(\.rawValue) ?? [])
        ) { result, item in
            result.intersection(item.allowedOutcomes.map(\.rawValue))
        }
        guard commonOutcomes.contains(outcome) else { return }

        let normalizedScope: String?
        if outcome == "allow" {
            let commonScopes = request.actionRequests.dropFirst().reduce(
                Set(request.actionRequests.first?.allowedScopes.map(\.rawValue) ?? [])
            ) { result, item in
                result.intersection(item.allowedScopes.map(\.rawValue))
            }
            guard let scope, commonScopes.contains(scope) else { return }
            normalizedScope = scope
        } else {
            normalizedScope = nil
        }

        if let actionApprovalId {
            await submitActionApproval(
                approvalId: actionApprovalId,
                threadId: actionThreadId,
                approved: outcome == "allow",
                scope: normalizedScope
            )
            return
        }

        let decisions = request.actionRequests.map { item in
            ApprovalDecisionInput(
                requestId: item.requestId,
                toolCallId: item.toolCallId,
                outcome: outcome,
                scope: normalizedScope,
                rejectionMessage: outcome == "deny" ? rejectionMessage : nil
            )
        }
        await submitApprovalBatch(batchId: request.batchId, decisions: decisions)
    }

    private var pendingApprovalRequest: ApprovalRequested? {
        switch pending {
        case let .approvalBatch(request): return request
        case let .actionApproval(request): return request.displayRequest
        case .askUser, .askForm, .requestApproval, .planProposal, .modeSwitch, .none: return nil
        }
    }

    // MARK: - 私有：上行 + ack

    private func send(response: [String: Any], requestId: String) async {
        guard let promptId = pending?.id,
              pending?.hitlRequestId == requestId,
              beginSubmission(promptId: promptId) else { return }
        submitError = nil
        defer { finishSubmission(promptId: promptId) }

        let payload: [String: Any] = [
            "thread_id": threadId,
            "request_id": requestId,
            "response": response,
        ]
        let ack = await requestSender(HITLOutboundRequest(
            type: "localrt.user_response",
            payload: payload,
            okType: "localrt.user_response.ok",
            nakType: "localrt.user_response.nak",
            threadId: threadId,
            timeout: 20
        ))
        handleSubmitAck(ack, promptId: promptId)
    }

    private func handleSubmitAck(_ ack: AckResult, promptId: String) {
        switch ack {
        case .ok:
            removePrompt(id: promptId, markResolved: true)
        case let .nak(code, message, _, retryable, _, _, _, _):
            // already_consumed：他端已处理（多端 race），视为成功收起。
            if code == "already_consumed" {
                removePrompt(id: promptId, markResolved: true)
            } else if !retryable || isTerminalNak(code: code, message: message) {
                // pending_not_found / invalid_response 等表示当前卡片已经不可能再被
                // runtime 接收。继续阻塞输入只会让用户困在无法关闭的弹窗里。
                removePrompt(id: promptId, markResolved: true)
                submitError = nil
                logger.warning("localrt.user_response terminal nak dismissed: \(code, privacy: .public)")
            } else if pending?.id == promptId {
                submitError = message.isEmpty ? code : message
                logger.warning("localrt.user_response nak: \(code, privacy: .public)")
            }
        case .timeout where pending?.id == promptId:
            submitError = "提交超时，请重试"
        case .disconnected where pending?.id == promptId:
            submitError = "连接已断开，请重试"
        default:
            break
        }
    }

    private func dismissOnResolved(envelope env: WSEnvelope) {
        guard let batchId = HITLPrompt.decodeResolvedBatchId(envelope: env) else { return }
        let prompts = [pending].compactMap { $0 } + pendingQueue
        guard let matched = prompts.first(where: {
            switch $0 {
            case let .approvalBatch(p):
                return p.batchId == batchId
            case let .actionApproval(p):
                return p.batchId == batchId
            default:
                return false
            }
        }) else {
            return
        }
        removePrompt(id: matched.id, markResolved: true)
        submitError = nil
    }

    private func dismissOnSingleHitlResolved(envelope env: WSEnvelope) {
        guard let requestId = Self.firstNonBlank(
            env.payloadString("request_id"),
            env.payloadString("interrupt_id")
        ) else { return }
        rememberResolvedSingleHitlRequestId(requestId)

        let prompts = [pending].compactMap { $0 } + pendingQueue
        guard let matched = prompts.first(where: {
            singleHitlRequestId(for: $0) == requestId
        }) else {
            return
        }
        removePrompt(id: matched.id, markResolved: true)
        submitError = nil
    }

    /// 返回 true 表示当前展示项被设置或刷新；仅此时才应清除当前项的提交错误。
    private func enqueue(
        _ prompt: HITLPrompt,
        access: HITLResolutionAccess,
        fidelity: HITLPromptInformationFidelity
    ) -> Bool {
        let existingAccess = resolutionAccessByPromptId[prompt.id]
        resolutionAccessByPromptId[prompt.id] = existingAccess?.merging(access) ?? access

        if let current = pending, current.id == prompt.id {
            guard shouldReplacePrompt(id: prompt.id, with: fidelity) else { return false }
            informationFidelityByPromptId[prompt.id] = fidelity
            setPending(prompt)
            return true
        }
        if let index = pendingQueue.firstIndex(where: { $0.id == prompt.id }) {
            guard shouldReplacePrompt(id: prompt.id, with: fidelity) else { return false }
            informationFidelityByPromptId[prompt.id] = fidelity
            pendingQueue[index] = prompt
            return false
        }
        informationFidelityByPromptId[prompt.id] = fidelity
        guard pending != nil else {
            setPending(prompt)
            return true
        }
        pendingQueue.append(prompt)
        return false
    }

    private func shouldReplacePrompt(
        id: String,
        with incoming: HITLPromptInformationFidelity
    ) -> Bool {
        guard let existing = informationFidelityByPromptId[id] else { return true }
        // 同保真度不刷：stream / WS / hydrate 多路到达时避免重复 setPending（Ask User 双重触发）。
        return incoming.rawValue > existing.rawValue
    }

    private func removePrompt(id: String, markResolved: Bool) {
        if let current = pending, current.id == id {
            if markResolved {
                rememberResolvedSingleHitlRequestId(singleHitlRequestId(for: current))
                markInteractionResolved(current)
            }
            if submittingPromptId == id {
                submittingPromptId = nil
                isSubmitting = false
            }
            let next = pendingQueue.isEmpty ? nil : pendingQueue.removeFirst()
            resolutionAccessByPromptId.removeValue(forKey: id)
            informationFidelityByPromptId.removeValue(forKey: id)
            setPending(next)
            submitError = nil
            return
        }
        guard let index = pendingQueue.firstIndex(where: { $0.id == id }) else { return }
        let removed = pendingQueue.remove(at: index)
        resolutionAccessByPromptId.removeValue(forKey: id)
        informationFidelityByPromptId.removeValue(forKey: id)
        if markResolved {
            rememberResolvedSingleHitlRequestId(singleHitlRequestId(for: removed))
            markInteractionResolved(removed)
        }
    }

    private func singleHitlRequestId(for prompt: HITLPrompt) -> String? {
        switch prompt {
        case let .askUser(request): return request.requestId
        case let .askForm(request): return request.requestId
        case let .requestApproval(request): return request.requestId
        case .approvalBatch, .actionApproval, .planProposal, .modeSwitch: return nil
        }
    }

    private func rememberResolvedSingleHitlRequestId(_ rawRequestId: String?) {
        guard let requestId = Self.firstNonBlank(rawRequestId) else { return }
        if resolvedSingleHitlRequestIds.insert(requestId).inserted {
            resolvedSingleHitlRequestIdOrder.append(requestId)
        }
        while resolvedSingleHitlRequestIdOrder.count > maxResolvedSingleHitlRequestIds {
            let oldest = resolvedSingleHitlRequestIdOrder.removeFirst()
            resolvedSingleHitlRequestIds.remove(oldest)
        }
    }

    private static func isSingleHitlInteractionKind(_ kind: String) -> Bool {
        kind == "ask_choice" || kind == "ask_form" || kind == "permission_request"
    }

    private static func firstNonBlank(_ values: String?...) -> String? {
        values.lazy.compactMap { value in
            guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty else { return nil }
            return trimmed
        }.first
    }

    private func setPending(_ prompt: HITLPrompt?) {
        expirationTask?.cancel()
        expirationTask = nil
        pending = prompt
        scheduleExpiration(for: prompt)
    }

    private func scheduleExpiration(for prompt: HITLPrompt?) {
        guard let expiresAt = expiresAtDate(for: prompt) else { return }
        let delay = expiresAt.timeIntervalSinceNow
        if delay <= 0 {
            expireCurrentPrompt()
            return
        }
        let nanoseconds = UInt64(max(0, delay) * 1_000_000_000)
        expirationTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: nanoseconds)
            guard !Task.isCancelled else { return }
            self?.expireCurrentPrompt()
        }
    }

    private func expiresAtDate(for prompt: HITLPrompt?) -> Date? {
        let raw: Double
        switch prompt {
        case let .approvalBatch(p):
            raw = p.expiresAt
        case let .actionApproval(p):
            raw = p.displayRequest.expiresAt
        default:
            return nil
        }
        guard raw > 0 else { return nil }
        let seconds = raw > 1_000_000_000_000 ? raw / 1000 : raw
        return Date(timeIntervalSince1970: seconds)
    }

    private func expireCurrentPrompt() {
        guard let promptId = pending?.id else { return }
        removePrompt(id: promptId, markResolved: true)
    }

    private func markInteractionResolved(_ prompt: HITLPrompt) {
        switch prompt {
        case let .approvalBatch(p):
            PendingInteractionStore.shared.markResolved(
                kind: "tool_approval",
                threadId: threadId,
                requestKey: p.batchId
            )
        case let .actionApproval(p):
            PendingInteractionStore.shared.markResolved(
                kind: "tool_approval",
                threadId: p.threadId ?? threadId,
                requestKey: p.approvalId
            )
        case let .askUser(p):
            PendingInteractionStore.shared.markResolved(
                kind: "ask_choice",
                threadId: threadId,
                requestKey: p.requestId
            )
        case let .askForm(p):
            PendingInteractionStore.shared.markResolved(
                kind: "ask_form",
                threadId: threadId,
                requestKey: p.requestId
            )
        case let .requestApproval(p):
            PendingInteractionStore.shared.markResolved(
                kind: "permission_request",
                threadId: threadId,
                requestKey: p.requestId
            )
        default:
            break
        }
    }

    private func beginSubmission(promptId: String) -> Bool {
        guard canResolvePending,
              submittingPromptId == nil,
              pending?.id == promptId else { return false }
        submittingPromptId = promptId
        isSubmitting = true
        return true
    }

    private func finishSubmission(promptId: String) {
        guard submittingPromptId == promptId else { return }
        submittingPromptId = nil
        isSubmitting = false
    }

    private func matches(
        _ prompt: HITLPrompt,
        interactionKind: String,
        resolvedThreadId: String,
        requestKey: String
    ) -> Bool {
        switch (interactionKind, prompt) {
        case let ("tool_approval", .approvalBatch(p)):
            return threadId == resolvedThreadId && p.batchId == requestKey
        case let ("tool_approval", .actionApproval(p)):
            return (p.threadId ?? threadId) == resolvedThreadId && p.approvalId == requestKey
        case let ("ask_choice", .askUser(p)):
            return threadId == resolvedThreadId && p.requestId == requestKey
        case let ("ask_form", .askForm(p)):
            return threadId == resolvedThreadId && p.requestId == requestKey
        case let ("permission_request", .requestApproval(p)):
            return threadId == resolvedThreadId && p.requestId == requestKey
        default:
            return false
        }
    }

    private func isTerminalNak(code: String, message: String) -> Bool {
        switch code.lowercased() {
        case "pending_not_found",
             "invalid_response",
             "missing_pending_request",
             "request_expired",
             "approval_expired":
            return true
        default:
            break
        }
        let normalizedMessage = message.lowercased()
        return normalizedMessage.contains("no pending")
            || normalizedMessage.contains("pending request not found")
            || normalizedMessage.contains("missing pending request")
    }
}
