package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage

/**
 * 流式期只换末条叶子：前缀沿用上一帧实例，LazyColumn 才能跳过历史行。
 * 前缀对象被对账换掉、或已收束时，整表发布。
 */
internal object ConversationStreamPublishPolicy {
    fun publishedMessages(
        previous: List<ChatMessage>,
        next: List<ChatMessage>,
        isStreaming: Boolean,
    ): List<ChatMessage> {
        if (!isStreaming || next.isEmpty()) return next
        val prefixSize = next.size - 1
        if (prefixSize < 0) return next
        if (previous.size != prefixSize && previous.size != next.size) return next
        if (previous.size < prefixSize) return next
        for (index in 0 until prefixSize) {
            if (previous[index] !== next[index]) return next
        }
        return buildList(next.size) {
            for (index in 0 until prefixSize) add(previous[index])
            add(next.last())
        }
    }
}
