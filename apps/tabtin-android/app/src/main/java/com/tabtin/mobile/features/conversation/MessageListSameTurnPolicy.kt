package com.tabtin.mobile.features.conversation

import com.tabtin.mobile.data.model.ChatMessage

/**
 * 同用户轮连续 assistant 气泡只在首条显示执行身份（对齐 Electron hideAgentBadge）。
 */
internal object MessageListSameTurnPolicy {
    fun shouldHideAgentIdentity(messages: List<ChatMessage>, index: Int): Boolean {
        val message = messages.getOrNull(index) ?: return false
        if (!message.isAssistant || index <= 0) return false

        for (offset in index - 1 downTo 0) {
            val previous = messages[offset]
            when {
                previous.isSystem -> continue
                previous.isUser -> return false
                previous.isAssistant -> {
                    val previousAgent = previous.agentId?.trim().orEmpty()
                    val currentAgent = message.agentId?.trim().orEmpty()
                    if (previousAgent.isNotEmpty() &&
                        currentAgent.isNotEmpty() &&
                        previousAgent != currentAgent
                    ) {
                        return false
                    }
                    return true
                }
            }
        }
        return false
    }
}
