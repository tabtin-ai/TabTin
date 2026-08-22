package com.tabtin.mobile.features.conversation

/**
 * 任务 / 最近列表行头像解析：跟**执行 Agent**走，不跟会话上可能过期的 `agent_avatar` 死字段走。
 *
 * 对齐 iOS `TaskHomeAgentFaceResolver`。
 */
internal object TaskHomeAgentFaceResolver {
    /**
     * 解析用于列表展示的头像 raw（预置 key 或 http(s) URL）。
     *
     * 优先级：组织 Agent 的 url → key → 会话字段 → 有 Agent 身份时 `general-assistant`。
     */
    fun resolveAvatarRaw(
        agentId: String?,
        sessionAvatar: String?,
        storeAvatarUrl: String?,
        storeAvatarKey: String?,
    ): String? {
        nonEmpty(storeAvatarUrl)?.let { return it }
        nonEmpty(storeAvatarKey)?.let { return it }
        nonEmpty(sessionAvatar)?.let { return it }
        if (nonEmpty(agentId) != null) {
            return AgentAvatarPreset.GENERAL_ASSISTANT.key
        }
        return null
    }

    fun resolveDisplayName(
        agentId: String?,
        sessionAgentName: String?,
        storeDisplayName: String?,
        locationName: String?,
    ): String {
        nonEmpty(storeDisplayName)?.let { return it }
        nonEmpty(sessionAgentName)?.let { return it }
        nonEmpty(locationName)?.let { return it }
        return if (nonEmpty(agentId) != null) "Agent" else "?"
    }

    private fun nonEmpty(value: String?): String? =
        value?.trim()?.takeIf { it.isNotEmpty() }
}
