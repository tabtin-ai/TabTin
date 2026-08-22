package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.api.json as ApiJson
import com.tabtin.mobile.data.model.SessionReadState
import com.tabtin.mobile.data.model.SessionRunState
import com.tabtin.mobile.data.model.WSEnvelope

/** 用户级会话状态事件的已校验表示。 */
internal sealed interface SessionStateRealtimeEvent {
    val sessionId: String
    val organizationId: String?

    data class RunStateUpdated(
        override val sessionId: String,
        override val organizationId: String?,
        val runState: SessionRunState,
    ) : SessionStateRealtimeEvent

    data class ReadStateUpdated(
        override val sessionId: String,
        override val organizationId: String?,
        val readState: SessionReadState,
    ) : SessionStateRealtimeEvent

    /**
     * 同账号跨端会话目录活动。
     *
     * 仅投递给 session owner；客户端 upsert 列表行并按活动时间重排。
     */
    data class ActivityUpdated(
        override val sessionId: String,
        override val organizationId: String?,
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
    ) : SessionStateRealtimeEvent
}

/**
 * 将后端真实事件名解码成领域事实。
 *
 * 这些事件直接发送到 user group，故不带 `agent.user.` 前缀；不能复用旧用户通知的
 * 前缀路由，否则客户端虽然已订阅也永远收不到状态更新。
 */
internal object SessionStateRealtimeEventDecoder {
    fun decode(envelope: WSEnvelope): SessionStateRealtimeEvent? {
        val sessionId = envelope.payloadString("session_id")?.takeIf { it.isNotBlank() } ?: return null
        val organizationId = envelope.payloadString("organization_id") ?: envelope.organizationId
        return when (envelope.type) {
            RUN_STATE_EVENT -> {
                val payload = envelope.payloadDict("run_state") ?: return null
                val runState = runCatching {
                    ApiJson.decodeFromJsonElement(SessionRunState.serializer(), payload)
                }.getOrNull()?.takeIf(SessionRunState::isValid) ?: return null
                SessionStateRealtimeEvent.RunStateUpdated(sessionId, organizationId, runState)
            }

            READ_STATE_EVENT -> {
                val payload = envelope.payloadDict("read_state") ?: envelope.payload
                val readState = runCatching {
                    ApiJson.decodeFromJsonElement(SessionReadState.serializer(), payload)
                }.getOrNull()?.takeIf(SessionReadState::isValid) ?: return null
                SessionStateRealtimeEvent.ReadStateUpdated(sessionId, organizationId, readState)
            }

            ACTIVITY_EVENT -> SessionStateRealtimeEvent.ActivityUpdated(
                sessionId = sessionId,
                organizationId = organizationId,
                reason = envelope.payloadString("reason").orEmpty(),
                title = envelope.payloadString("title"),
                status = envelope.payloadString("status"),
                workspaceId = envelope.payloadString("workspace_id"),
                projectId = envelope.payloadString("project_id"),
                agentId = envelope.payloadString("agent_id"),
                lastMessageAt = envelope.payloadString("last_message_at"),
                updatedAt = envelope.payloadString("updated_at"),
                createdAt = envelope.payloadString("created_at"),
                threadId = envelope.payloadString("thread_id"),
            )

            else -> null
        }
    }

    const val RUN_STATE_EVENT: String = "chat.session.run_state.updated"
    const val READ_STATE_EVENT: String = "chat.session.read_state.updated"
    const val ACTIVITY_EVENT: String = "chat.session.activity.updated"
}

/**
 * 用户级状态事件在新协议中带 `organization_id`，但已上线的旧事件可能缺少该字段。
 *
 * 当前没有选中组织时绝不应用状态；有选中组织时，只有显式声明为其他组织的事件才被
 * 拒绝。这样既不会让已知的跨组织事件污染当前页面，也不会让旧客户端/服务端组合导致
 * 同组织运行态永久丢失。
 */
internal fun shouldApplySessionStateForOrganization(
    eventOrganizationId: String?,
    selectedOrganizationId: String?,
): Boolean {
    val selected = selectedOrganizationId?.trim()?.takeIf { it.isNotEmpty() } ?: return false
    val event = eventOrganizationId?.trim()?.takeIf { it.isNotEmpty() } ?: return true
    return event == selected
}
