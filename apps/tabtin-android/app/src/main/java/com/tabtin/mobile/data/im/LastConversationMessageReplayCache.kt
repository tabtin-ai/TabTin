package com.tabtin.mobile.data.im

/**
 * 会话目录的 `lastMessage` 常比详情 listener / history 更早可见。
 * 缓存最新一条，供详情订阅时无副作用地 replay，避免入口摘要已更新但聊天停在旧消息。
 */
internal class LastConversationMessageReplayCache<Message> {
    private val messagesByConversationId = mutableMapOf<String, Message>()

    fun remember(message: Message, conversationId: String) {
        if (conversationId.isBlank()) return
        messagesByConversationId[conversationId] = message
    }

    fun replay(conversationId: String): Message? =
        messagesByConversationId[conversationId]

    fun clear(conversationId: String) {
        messagesByConversationId.remove(conversationId)
    }

    fun clearAll() {
        messagesByConversationId.clear()
    }
}
