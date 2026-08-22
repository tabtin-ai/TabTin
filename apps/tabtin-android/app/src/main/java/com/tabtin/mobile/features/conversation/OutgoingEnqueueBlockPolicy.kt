package com.tabtin.mobile.features.conversation

/**
 * 入队 / 自动排空共用阻断：HITL / paused / 计费。
 * 忙碌（streaming）不在此列——允许排队，由 drain 的 isStreaming 挡住发送。
 */
public enum class OutgoingEnqueueBlock {
    HITL,
    PAUSED,
    BILLING,
}

public data class OutgoingEnqueueBlockInput(
    val pendingApproval: Boolean,
    val pendingAnswer: Boolean,
    val paused: Boolean,
    val billingBlocked: Boolean,
    val memberLimitBlocked: Boolean,
)

public object OutgoingEnqueueBlockPolicy {
    public fun evaluate(input: OutgoingEnqueueBlockInput): OutgoingEnqueueBlock? {
        if (input.billingBlocked || input.memberLimitBlocked) return OutgoingEnqueueBlock.BILLING
        if (input.pendingApproval || input.pendingAnswer) return OutgoingEnqueueBlock.HITL
        if (input.paused) return OutgoingEnqueueBlock.PAUSED
        return null
    }

    public fun canAutoDrain(input: OutgoingEnqueueBlockInput): Boolean =
        evaluate(input) == null
}
