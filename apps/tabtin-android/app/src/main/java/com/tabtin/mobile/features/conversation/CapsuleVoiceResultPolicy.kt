package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ConversationFocusContext

/**
 * 胶囊语音提交策略：纯函数门禁 + 草稿零污染 + Focus 冻结语义。
 */
public enum class CapsuleVoiceGate {
    ALLOW_QUEUE,
    BLOCK_HITL,
    BLOCK_PAUSED,
    BLOCK_BILLING,
    BLOCK_MODEL_MISSING,
    BLOCK_SESSION_MISSING,
}

public data class CapsuleVoiceGateInput(
    val sessionPresent: Boolean,
    val modelPresent: Boolean,
    val billingBlocked: Boolean,
    val memberLimitBlocked: Boolean,
    val pendingApproval: Boolean,
    val pendingAnswer: Boolean,
    val paused: Boolean,
    /** busy 允许排队，不阻断。 */
    val busy: Boolean = false,
)

public data class CapsuleVoiceSubmission(
    val transcript: String,
    val frozenFocus: ConversationFocusContext,
    val attachmentPolicy: AttachmentPolicy = AttachmentPolicy.NONE,
)

public data class ComposerDraftSnapshot(
    val text: String,
    val attachmentIds: List<String>,
    val referenceIds: List<String>,
)

public data class SurfaceNavigationSnapshot(
    val viewMode: String,
    val resourcePath: String,
    val scrollOffset: Int,
)

public object CapsuleVoiceResultPolicy {
    public fun evaluateGate(input: CapsuleVoiceGateInput): CapsuleVoiceGate {
        if (!input.sessionPresent) return CapsuleVoiceGate.BLOCK_SESSION_MISSING
        if (!input.modelPresent) return CapsuleVoiceGate.BLOCK_MODEL_MISSING
        if (input.billingBlocked || input.memberLimitBlocked) return CapsuleVoiceGate.BLOCK_BILLING
        if (input.pendingApproval || input.pendingAnswer) return CapsuleVoiceGate.BLOCK_HITL
        if (input.paused) return CapsuleVoiceGate.BLOCK_PAUSED
        return CapsuleVoiceGate.ALLOW_QUEUE
    }

    /** 阻断时保留 transcript，不入队。 */
    public fun shouldPreserveTranscript(gate: CapsuleVoiceGate): Boolean =
        gate != CapsuleVoiceGate.ALLOW_QUEUE

    public fun buildSubmission(
        transcript: String,
        frozenFocus: ConversationFocusContext,
    ): CapsuleVoiceSubmission = CapsuleVoiceSubmission(
        transcript = transcript,
        frozenFocus = frozenFocus,
        attachmentPolicy = AttachmentPolicy.NONE,
    )

    /** 发送后草稿文本与附件引用必须不变。 */
    public fun draftsUnchanged(
        before: ComposerDraftSnapshot,
        after: ComposerDraftSnapshot,
    ): Boolean = before == after

    /** 发送后 surface / path / 滚动必须不变。 */
    public fun surfaceUnchanged(
        before: SurfaceNavigationSnapshot,
        after: SurfaceNavigationSnapshot,
    ): Boolean = before == after

    /**
     * 重试永远读冻结 Focus（资源 A），即使此刻 Workbench 已切到资源 B。
     */
    public fun resolveRetryFocus(
        queuedFocus: ConversationFocusContext?,
        currentWorkbenchFocus: ConversationFocusContext?,
    ): ConversationFocusContext? = queuedFocus
}
