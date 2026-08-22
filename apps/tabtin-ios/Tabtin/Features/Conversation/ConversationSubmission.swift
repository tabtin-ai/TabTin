import Foundation

/// 统一提交请求：Composer 与胶囊语音使用不同来源与附件策略。
enum ConversationSubmissionSource: Equatable, Sendable {
    case composer
    case capsuleVoice
}

enum ConversationAttachmentPolicy: Equatable, Sendable {
    /// Composer：可夹带当前附件与显式上下文引用。
    case composerDraft
    /// 胶囊语音：仅 transcript + 冻结 Focus，不读草稿/附件/引用。
    case none
}

struct ConversationSubmissionRequest: Equatable, Sendable {
    var source: ConversationSubmissionSource
    var text: String
    var focusSnapshot: FocusSnapshot?
    var attachmentPolicy: ConversationAttachmentPolicy
    /// Composer 专用；胶囊语音路径始终为 0，防止夹带附件/引用。
    var composerBlockCount: Int

    static func composer(
        text: String,
        focusSnapshot: FocusSnapshot?,
        blockCount: Int
    ) -> ConversationSubmissionRequest {
        ConversationSubmissionRequest(
            source: .composer,
            text: text,
            focusSnapshot: focusSnapshot,
            attachmentPolicy: .composerDraft,
            composerBlockCount: max(0, blockCount)
        )
    }

    static func capsuleVoice(
        transcript: String,
        focusSnapshot: FocusSnapshot?
    ) -> ConversationSubmissionRequest {
        ConversationSubmissionRequest(
            source: .capsuleVoice,
            text: transcript,
            focusSnapshot: focusSnapshot,
            attachmentPolicy: .none,
            composerBlockCount: 0
        )
    }

    /// 胶囊语音永远不附带 Composer blocks。
    var includesComposerBlocks: Bool {
        attachmentPolicy == .composerDraft && composerBlockCount > 0
    }

    /// 胶囊语音不得改写 Composer 草稿。
    var shouldMutateComposerDraft: Bool { source == .composer }
}

/// Composer 点击发送瞬间冻结的不可变快照。
/// 后续 await / 入队只消费本快照；成功后只清快照对应状态，不读发送中新增内容。
/// 非 Sendable：`blockPayloads` 含 `[String: Any]`，仅在 `@MainActor` 发送路径使用。
struct ConversationComposerSendSnapshot {
    let request: ConversationSubmissionRequest
    let contextRefs: [MentionContextRef]
    let attachmentIds: [String]
    /// 入队用的 blocks（附件 + 引用）；在点击瞬间冻结，禁止 await 后再读 live。
    let blockPayloads: [[String: Any]]
    /// 草稿世代：同 revision 的快速连点不得重复夹带附件。
    let draftRevision: Int
    /// 本轮发送令牌：同意完成 / 失败恢复只认本 token，禁止重新捕获 live Focus。
    let sendToken: String
    /// 编辑重发失败后恢复到 Composer 的原始 blocks。入队成功时只清理同一份恢复载荷。
    let editResendRecoveryToken: String?

    var text: String { request.text }
    var focusSnapshot: FocusSnapshot? { request.focusSnapshot }

    static func capturing(
        text: String,
        focusSnapshot: FocusSnapshot?,
        contextRefs: [MentionContextRef],
        attachments: [ComposerLocalAttachment],
        blockPayloads: [[String: Any]],
        draftRevision: Int,
        sendToken: String = UUID().uuidString.lowercased(),
        editResendRecoveryToken: String? = nil
    ) -> ConversationComposerSendSnapshot {
        ConversationComposerSendSnapshot(
            request: .composer(
                text: text,
                focusSnapshot: focusSnapshot,
                blockCount: blockPayloads.count
            ),
            contextRefs: contextRefs,
            attachmentIds: attachments.map(\.id),
            blockPayloads: blockPayloads,
            draftRevision: draftRevision,
            sendToken: sendToken,
            editResendRecoveryToken: editResendRecoveryToken
        )
    }

    /// 成功后是否应清空当前草稿：仅当草稿仍是快照原文或已被 Composer 交空时。
    static func shouldClearDraft(currentDraft: String, snapshotText: String) -> Bool {
        let current = currentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        let frozen = snapshotText.trimmingCharacters(in: .whitespacesAndNewlines)
        return current.isEmpty || current == frozen
    }

    /// 失败恢复：仅当用户未在发送后输入新内容时才写回快照原文。
    static func shouldRestoreDraft(currentDraft: String, snapshotText: String) -> Bool {
        shouldClearDraft(currentDraft: currentDraft, snapshotText: snapshotText)
    }

    /// 阻断和本地持久化失败都必须保留编辑草稿；非 nil 回执不等于发送成功。
    static func shouldPreserveDraft(after receipt: QueuedSendReceipt?) -> Bool {
        receipt?.isPersistedForDelivery != true
    }

    /// 同意完成 / 迟到回调：只认仍占有本 sendToken 的 in-flight 发送。
    static func ownsInFlightSend(
        inFlightToken: String?,
        snapshotToken: String
    ) -> Bool {
        guard let inFlightToken else { return false }
        return inFlightToken == snapshotToken
    }
}

/// 终态自动已读门禁：对话面板真实可见才允许 ACK（工作台保持完整完成胶囊）。
enum ConversationAutoReadVisibilityGate: Equatable, Sendable {
    static func allowsAutoReadAck(isConversationContentVisible: Bool) -> Bool {
        isConversationContentVisible
    }
}

/// 冷启动 / 重连：自动 drain 必须排在权威 HITL hydration（及 paused/control）之后。
enum SessionAutoDrainSequence: String, CaseIterable, Equatable, Sendable {
    case refreshControlState
    case hydratePendingInteractions
    case openAutoDrain

    /// 冷启动与重连共用顺序；单测断言此序，生产路径必须遵守。
    static let beforeAutoDrain: [SessionAutoDrainSequence] = [
        .refreshControlState,
        .hydratePendingInteractions,
        .openAutoDrain,
    ]

    /// 单步结果：失败必须 fail-closed，禁止当作「已就绪」。
    enum StepResult: Equatable, Sendable {
        case success
        case failure
    }

    static func allowsAutoDrain(
        controlState: StepResult,
        hitlHydration: StepResult
    ) -> Bool {
        controlState == .success && hitlHydration == .success
    }

    /// 兼容旧 Bool 调用；任一步 false 即不允许 drain。
    static func allowsAutoDrain(
        controlStateReady: Bool,
        hitlHydrationCompleted: Bool
    ) -> Bool {
        allowsAutoDrain(
            controlState: controlStateReady ? .success : .failure,
            hitlHydration: hitlHydrationCompleted ? .success : .failure
        )
    }
}

/// 提交前门禁结果（HITL / paused / 计费 / 模型）。
enum ConversationSubmissionGate: Equatable, Sendable {
    case allow
    case block(reason: String)
}

enum ConversationSubmission {
    static func gate(
        hitlPending: Bool,
        isPaused: Bool,
        billingBlocked: Bool,
        hasSendableModel: Bool
    ) -> ConversationSubmissionGate {
        if hitlPending {
            return .block(reason: "需要先完成确认或回答，才能继续发送。")
        }
        if isPaused {
            return .block(reason: "任务已暂停，恢复后再发送。")
        }
        if billingBlocked {
            return .block(reason: "当前计费状态阻止发送。")
        }
        if !hasSendableModel {
            return .block(reason: "没有可用模型：请在管理后台配置并激活聊天模型后重试。")
        }
        return .allow
    }
}
