package com.tabtin.mobile.data.im

import java.util.UUID

/** 客户端会话标题策略：DM 显示对端成员名，不暴露传输层的系统占位名。 */
internal object ImConversationTitlePolicy {
    private val providerFallbacks = setOf(
        "tabtin private conversation",
        "private conversation",
    )

    fun resolve(
        conversationName: String,
        isDirectMessage: Boolean,
        peerDisplayName: String?,
        directMessageFallback: String,
        conversationFallback: String,
    ): String {
        val name = conversationName.trim()
        if (!isDirectMessage) return name.ifEmpty { conversationFallback }

        peerDisplayName?.trim()?.takeIf(::isReadableDirectMessageName)?.let { return it }
        if (isReadableDirectMessageName(name) && name.lowercase() !in providerFallbacks) return name
        return directMessageFallback
    }

    private fun isReadableDirectMessageName(value: String): Boolean =
        value.isNotEmpty() && runCatching { UUID.fromString(value) }.isFailure
}
