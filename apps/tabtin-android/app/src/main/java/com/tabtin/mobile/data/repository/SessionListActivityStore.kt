package com.tabtin.mobile.data.repository

import javax.inject.Inject
import javax.inject.Singleton
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow

/** 同账号跨端会话目录活动，供列表 VM upsert / 重排。 */
public data class SessionListActivityUpdate(
    val sessionId: String,
    val organizationId: String?,
    val reason: String,
    val title: String?,
    val status: String?,
    val workspaceId: String?,
    val projectId: String?,
    val agentId: String?,
    val lastMessageAt: String?,
    val updatedAt: String?,
    val createdAt: String?,
    val threadId: String?,
)

/**
 * 同账号跨端会话目录活动的轻量分发层。
 *
 * [com.tabtin.mobile.data.websocket.UserEventHandler] 校验组织后 [accept]；
 * 任务首页 / Agent 会话列表订阅 [updates] 做 upsert + 按活动时间重排。
 * 本层不持久化，断线缺口由 REST reconcile 补齐。
 */
@Singleton
public class SessionListActivityStore @Inject constructor() {
    private val _updates = MutableSharedFlow<SessionListActivityUpdate>(
        extraBufferCapacity = 64,
    )

    public val updates: SharedFlow<SessionListActivityUpdate> = _updates.asSharedFlow()

    /** @return 是否成功投递给订阅方（缓冲满时为 false）。 */
    public fun accept(event: SessionListActivityUpdate): Boolean {
        if (event.sessionId.isBlank()) return false
        return _updates.tryEmit(event)
    }
}
