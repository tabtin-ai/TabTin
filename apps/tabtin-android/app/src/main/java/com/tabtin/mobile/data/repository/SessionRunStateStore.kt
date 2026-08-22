package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.shouldAcceptSessionRunState
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** 已接受的服务端运行态变更，供当前会话和各类会话列表共享消费。 */
public data class SessionRunStateUpdate(
    val sessionId: String,
    val runState: SessionRunState,
)

/**
 * Android 端会话运行态的内存事实层。
 *
 * HTTP 列表、单会话快照与用户级 websocket 事件都进入这里。该层只负责按
 * `sequence + revision` 单调保留服务端事实，不管理 UI 的本地发送动画或队列。
 */
@Singleton
public class SessionRunStateStore @Inject constructor() {
    private val latestBySessionId = ConcurrentHashMap<String, SessionRunState>()
    private val _updates = MutableSharedFlow<SessionRunStateUpdate>(extraBufferCapacity = 64)

    public val updates: SharedFlow<SessionRunStateUpdate> = _updates.asSharedFlow()

    /**
     * 接受一条 HTTP 或 realtime 服务端事实；重复、乱序或无效数据会被无副作用地忽略。
     *
     * @return 是否实际推进了本地事实。
     */
    public fun accept(sessionId: String, runState: SessionRunState): Boolean {
        if (sessionId.isBlank() || !runState.isValid) return false
        var accepted = false
        latestBySessionId.compute(sessionId) { _, current ->
            if (shouldAcceptSessionRunState(current, runState)) {
                accepted = true
                runState
            } else {
                current
            }
        }
        if (accepted) _updates.tryEmit(SessionRunStateUpdate(sessionId, runState))
        return accepted
    }

    /** 当前已知的最新服务端事实；不存在时让调用方走旧后端兼容路径。 */
    public fun latest(sessionId: String): SessionRunState? = latestBySessionId[sessionId]

    /**
     * 会话状态只在当前 Organization / 登录身份内有效。切换边界时必须清掉内存投影，
     * 不能让下一位用户或下一个组织短暂看到上一作用域的运行态。
     */
    public fun clear() {
        latestBySessionId.clear()
    }
}
