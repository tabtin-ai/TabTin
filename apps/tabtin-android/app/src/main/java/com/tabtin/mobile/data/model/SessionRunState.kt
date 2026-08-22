package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 服务端发布的会话当前运行事实。
 *
 * `sequence` 标识同一会话的第几轮运行，`revision` 标识该轮运行内的状态推进。客户端
 * 必须只按这两个字段单调合并，不能再从消息角色或本地计时推断运行是否结束。
 */
@Serializable
public data class SessionRunState(
    @SerialName("run_id") val runId: String,
    val sequence: Int,
    /** 服务端用微秒时间戳作 revision，超过 Int32；必须用 Long。 */
    val revision: Long,
    val status: String,
    @SerialName("queue_depth") val queueDepth: Int,
    @SerialName("started_at") val startedAt: String? = null,
    @SerialName("state_changed_at") val stateChangedAt: String,
    @SerialName("ended_at") val endedAt: String? = null,
    @SerialName("stop_reason") val stopReason: String? = null,
    @SerialName("error_class") val errorClass: String? = null,
    @SerialName("waiting_interaction_id") val waitingInteractionId: String? = null,
) {
    /** 先在边界校验，避免畸形实时 payload 污染后续单调投影。 */
    public val isValid: Boolean
        get() = runId.isNotBlank() &&
            sequence >= 0 &&
            revision >= 0 &&
            queueDepth >= 0 &&
            stateChangedAt.isNotBlank() &&
            status in SessionRunStatus.ALL

    public val isActive: Boolean get() = status in SessionRunStatus.ACTIVE
    public val isTerminal: Boolean get() = status in SessionRunStatus.TERMINAL
}

/** 服务端 `SessionRunStateSchema.status` 的稳定枚举集合。 */
public object SessionRunStatus {
    public const val QUEUED: String = "queued"
    public const val RUNNING: String = "running"
    public const val WAITING_USER: String = "waiting_user"
    public const val PAUSED: String = "paused"
    public const val CANCELLING: String = "cancelling"
    public const val COMPLETED: String = "completed"
    public const val FAILED: String = "failed"
    public const val CANCELLED: String = "cancelled"
    public const val INTERRUPTED: String = "interrupted"

    public val ACTIVE: Set<String> = setOf(
        QUEUED,
        RUNNING,
        WAITING_USER,
        PAUSED,
        CANCELLING,
    )

    public val TERMINAL: Set<String> = setOf(
        COMPLETED,
        FAILED,
        CANCELLED,
        INTERRUPTED,
    )

    public val ALL: Set<String> = ACTIVE + TERMINAL
}

/**
 * 判断 [incoming] 能否推进 [current]。
 *
 * 新 run 必须提高 sequence；同一 run 只接受 revision 严格变大。服务端事件以
 * `sequence + revision` 为最终事实，不能由客户端根据终态猜测拒绝更高 revision。
 */
public fun shouldAcceptSessionRunState(
    current: SessionRunState?,
    incoming: SessionRunState,
): Boolean {
    if (!incoming.isValid) return false
    if (current == null || !current.isValid) return true
    if (incoming.sequence != current.sequence) return incoming.sequence > current.sequence
    if (incoming.runId != current.runId) return false
    return incoming.revision > current.revision
}

/** 在两个服务端事实间保留单调更晚的一个。 */
public fun selectNewerSessionRunState(
    current: SessionRunState?,
    incoming: SessionRunState,
): SessionRunState = if (shouldAcceptSessionRunState(current, incoming)) incoming else current ?: incoming
