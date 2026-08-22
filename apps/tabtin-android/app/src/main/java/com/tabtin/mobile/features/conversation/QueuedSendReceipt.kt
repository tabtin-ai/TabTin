package com.tabtin.mobile.features.conversation

/**
 * 发送回执：区分本地已保存 / 忙碌排队 / 服务端已接受，禁止统称「已发送」。
 * 对齐 iOS `QueuedSendReceipt.userFacingMessage`。
 */
public sealed class QueuedSendReceipt {
    public data class Blocked(val gate: CapsuleVoiceGate) : QueuedSendReceipt()
    public data class Persisted(val queueId: String) : QueuedSendReceipt()
    public data class Queued(val queueId: String) : QueuedSendReceipt()
    public data class Accepted(val queueId: String) : QueuedSendReceipt()
    public data class Failed(val reason: String) : QueuedSendReceipt()

    public val queueIdOrNull: String?
        get() = when (this) {
            is Persisted -> queueId
            is Queued -> queueId
            is Accepted -> queueId
            is Blocked, is Failed -> null
        }
}
