package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 服务端发布的会话阅读水位。
 *
 * 未读不由本地时间戳推断：只有 `latest_completed_*` 游标严格超过
 * `last_read_*` 游标时，才表示用户还有一轮已完成回复尚未完整查看。
 */
@Serializable
public data class SessionReadState(
    @SerialName("last_read_run_sequence") val lastReadRunSequence: Int,
    /** 服务端用微秒时间戳作 revision，超过 Int32；必须用 Long。 */
    @SerialName("last_read_terminal_revision") val lastReadTerminalRevision: Long,
    @SerialName("read_at") val readAt: String? = null,
    @SerialName("latest_completed_run_id") val latestCompletedRunId: String? = null,
    @SerialName("latest_completed_run_sequence") val latestCompletedRunSequence: Int? = null,
    @SerialName("latest_completed_terminal_revision") val latestCompletedTerminalRevision: Long? = null,
) {
    public val isValid: Boolean
        get() {
            if (lastReadRunSequence < 0 || lastReadTerminalRevision < 0) return false
            val latestFields = listOf(
                latestCompletedRunId,
                latestCompletedRunSequence?.toString(),
                latestCompletedTerminalRevision?.toString(),
            )
            if (latestFields.all { it == null }) return true
            return latestCompletedRunId?.isNotBlank() == true &&
                latestCompletedRunSequence != null && latestCompletedRunSequence >= 0 &&
                latestCompletedTerminalRevision != null && latestCompletedTerminalRevision >= 0
        }

    public val hasUnreadReply: Boolean
        get() {
            val latestSequence = latestCompletedRunSequence ?: return false
            val latestRevision = latestCompletedTerminalRevision ?: return false
            return latestSequence > lastReadRunSequence ||
                (latestSequence == lastReadRunSequence && latestRevision > lastReadTerminalRevision)
        }

    public fun pendingAck(
        sessionId: String,
        mutationId: String,
    ): PendingSessionReadAck? {
        if (!isValid || !hasUnreadReply || sessionId.isBlank() || mutationId.isBlank()) return null
        val runId = latestCompletedRunId ?: return null
        val sequence = latestCompletedRunSequence ?: return null
        val revision = latestCompletedTerminalRevision ?: return null
        return PendingSessionReadAck(
            sessionId = sessionId,
            throughRunId = runId,
            throughSequence = sequence,
            throughRevision = revision,
            mutationId = mutationId,
        )
    }
}

/** 内容已完整展示后写入 read outbox 的稳定游标。 */
@Serializable
public data class PendingSessionReadAck(
    val sessionId: String,
    val throughRunId: String,
    val throughSequence: Int,
    val throughRevision: Long,
    val mutationId: String,
) {
    public fun isNewerThan(other: PendingSessionReadAck?): Boolean = other == null ||
        throughSequence > other.throughSequence ||
        (throughSequence == other.throughSequence && throughRevision > other.throughRevision)
}
