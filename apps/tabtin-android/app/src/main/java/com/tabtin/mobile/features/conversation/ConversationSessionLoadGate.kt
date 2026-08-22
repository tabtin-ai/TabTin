package com.tabtin.mobile.features.conversation

/**
 * 挡住过期历史回包：只认当前会话 + 这一代 load，避免 A 流着切到 B 再切回 A 时旧页盖上来。
 */
internal object ConversationSessionLoadGate {
    fun accepts(
        requestSessionId: String,
        requestGeneration: Long,
        currentSessionId: String?,
        currentGeneration: Long,
        streamingActive: Boolean,
        allowWhileStreaming: Boolean,
    ): Boolean {
        if (currentSessionId != requestSessionId) return false
        if (currentGeneration != requestGeneration) return false
        if (streamingActive && !allowWhileStreaming) return false
        return true
    }
}
