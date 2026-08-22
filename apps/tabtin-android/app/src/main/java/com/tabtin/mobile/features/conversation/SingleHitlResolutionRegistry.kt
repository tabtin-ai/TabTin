package com.tabtin.mobile.features.conversation

/**
 * 单请求 HITL 的会话级终态墓碑。
 *
 * 用户级 interaction 事件与 agent.stream 事件来自不同可靠通道，允许乱序到达。
 * 终态一旦出现，同一会话、同一 requestId 的迟到 required 事件不得重新打开面板。
 */
internal class SingleHitlResolutionRegistry(
    private val maxEntries: Int = 512,
) {
    private val resolvedKeys = LinkedHashSet<String>()

    fun record(sessionId: String, requestId: String?) {
        val key = key(sessionId, requestId) ?: return
        if (!resolvedKeys.add(key)) return
        while (resolvedKeys.size > maxEntries) {
            resolvedKeys.remove(resolvedKeys.first())
        }
    }

    fun shouldAccept(sessionId: String, requestId: String?): Boolean {
        val key = key(sessionId, requestId) ?: return true
        return key !in resolvedKeys
    }

    private fun key(sessionId: String, requestId: String?): String? {
        val normalizedSessionId = sessionId.trim()
        val normalizedRequestId = requestId?.trim().orEmpty()
        if (normalizedSessionId.isEmpty() || normalizedRequestId.isEmpty()) return null
        return "$normalizedSessionId:$normalizedRequestId"
    }
}
