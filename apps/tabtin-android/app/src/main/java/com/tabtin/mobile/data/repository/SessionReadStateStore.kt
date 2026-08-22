package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.SessionReadState
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** 已接受的会话阅读水位变更，供详情页和会话列表共享消费。 */
public data class SessionReadStateUpdate(
    val sessionId: String,
    val readState: SessionReadState,
)

/**
 * 会话阅读事实的内存归并层。
 *
 * HTTP 快照、read ACK 响应和用户级 websocket 事件都通过这里汇聚。读游标与最新已
 * 完成游标分别单调推进，避免较旧快照把已确认阅读的会话重新标为未读。
 */
@Singleton
public class SessionReadStateStore @Inject constructor() {
    private val latestBySessionId = ConcurrentHashMap<String, SessionReadState>()
    private val _updates = MutableSharedFlow<SessionReadStateUpdate>(extraBufferCapacity = 64)

    public val updates: SharedFlow<SessionReadStateUpdate> = _updates.asSharedFlow()

    public fun accept(sessionId: String, incoming: SessionReadState): Boolean {
        if (sessionId.isBlank() || !incoming.isValid) return false
        var accepted = false
        latestBySessionId.compute(sessionId) { _, current ->
            val merged = mergeSessionReadState(current, incoming)
            if (merged != current) accepted = true
            merged
        }
        val latest = latestBySessionId[sessionId]
        if (accepted && latest != null) {
            _updates.tryEmit(SessionReadStateUpdate(sessionId, latest))
        }
        return accepted
    }

    public fun latest(sessionId: String): SessionReadState? = latestBySessionId[sessionId]

    /** 阅读水位与登录身份、Organization 一起切换，不能跨作用域保留。 */
    public fun clear() {
        latestBySessionId.clear()
    }
}

/** 将两份服务端阅读事实按各自游标单调合并。 */
public fun mergeSessionReadState(
    current: SessionReadState?,
    incoming: SessionReadState,
): SessionReadState {
    if (current == null || !current.isValid) return incoming

    val keepIncomingRead = isCursorNewer(
        incoming.lastReadRunSequence,
        incoming.lastReadTerminalRevision,
        current.lastReadRunSequence,
        current.lastReadTerminalRevision,
    )
    val keepIncomingCompleted = isCursorNewer(
        incoming.latestCompletedRunSequence,
        incoming.latestCompletedTerminalRevision,
        current.latestCompletedRunSequence,
        current.latestCompletedTerminalRevision,
    )

    return incoming.copy(
        lastReadRunSequence = if (keepIncomingRead) {
            incoming.lastReadRunSequence
        } else {
            current.lastReadRunSequence
        },
        lastReadTerminalRevision = if (keepIncomingRead) {
            incoming.lastReadTerminalRevision
        } else {
            current.lastReadTerminalRevision
        },
        readAt = if (keepIncomingRead) incoming.readAt else current.readAt,
        latestCompletedRunId = if (keepIncomingCompleted) {
            incoming.latestCompletedRunId
        } else {
            current.latestCompletedRunId
        },
        latestCompletedRunSequence = if (keepIncomingCompleted) {
            incoming.latestCompletedRunSequence
        } else {
            current.latestCompletedRunSequence
        },
        latestCompletedTerminalRevision = if (keepIncomingCompleted) {
            incoming.latestCompletedTerminalRevision
        } else {
            current.latestCompletedTerminalRevision
        },
    )
}

private fun isCursorNewer(
    incomingSequence: Int?,
    incomingRevision: Long?,
    currentSequence: Int?,
    currentRevision: Long?,
): Boolean {
    if (incomingSequence == null || incomingRevision == null) return false
    if (currentSequence == null || currentRevision == null) return true
    return incomingSequence > currentSequence ||
        (incomingSequence == currentSequence && incomingRevision > currentRevision)
}
