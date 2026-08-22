package com.tabtin.mobile.features.conversation

import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.AllChatSession
import com.tabtin.mobile.features.space.AgentIdentityAvatar
import com.tabtin.mobile.ui.components.IdentityColorAvatar

/**
 * 任务 / 最近列表共用的会话 Agent 头像：组织缓存优先，有 Agent 身份时不落首字。
 */
@Composable
internal fun SessionAgentAvatarImage(
    session: AllChatSession,
    agentsById: Map<String, Agent>,
    size: Dp,
    modifier: Modifier = Modifier,
) {
    val agentId = session.agentId?.trim()?.takeIf { it.isNotEmpty() }
    val storeAgent = agentId?.let(agentsById::get)
    val resolvedRaw = TaskHomeAgentFaceResolver.resolveAvatarRaw(
        agentId = agentId,
        sessionAvatar = session.agentAvatar,
        storeAvatarUrl = storeAgent?.settings?.avatarUrl,
        storeAvatarKey = storeAgent?.settings?.avatarKey,
    )
    val displayName = TaskHomeAgentFaceResolver.resolveDisplayName(
        agentId = agentId,
        sessionAgentName = session.agentName,
        storeDisplayName = storeAgent?.displayName?.takeIf { it.isNotBlank() } ?: storeAgent?.name,
        locationName = session.taskRowLocationName(),
    )
    val preset = AgentAvatarPreset.from(resolvedRaw)
    val remoteUrl = resolvedRaw?.takeIf(::isRemoteUrl)
    val hasAgentIdentity = agentId != null
        || !session.agentName.isNullOrBlank()
        || storeAgent != null

    val imageModifier = modifier.size(size).clip(CircleShape)
    when {
        preset != null || remoteUrl != null -> AgentIdentityAvatar(
            name = displayName,
            avatarKey = preset?.key,
            avatarUrl = remoteUrl,
            size = size,
            modifier = imageModifier,
        )

        hasAgentIdentity -> AgentIdentityAvatar(
            name = displayName,
            avatarKey = AgentAvatarPreset.GENERAL_ASSISTANT.key,
            avatarUrl = null,
            size = size,
            modifier = imageModifier,
        )

        else -> IdentityColorAvatar(
            name = displayName,
            seed = agentId
                ?: session.agentName?.takeIf { it.isNotBlank() }
                ?: session.taskRowLocationName()
                ?: session.id,
            size = size,
            modifier = imageModifier,
        )
    }
}

internal fun isRemoteUrl(raw: String?): Boolean {
    val value = raw?.trim().orEmpty()
    return value.startsWith("http://") || value.startsWith("https://")
}
