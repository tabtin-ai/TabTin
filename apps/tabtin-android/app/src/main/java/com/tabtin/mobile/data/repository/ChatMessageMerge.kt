package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.ChatMessage
import java.time.Instant

internal object ChatMessageMerge {
    private const val DEDUP_WINDOW_MS = 5_000L

    internal fun mergeByIdentity(
        existing: List<ChatMessage>,
        fresh: List<ChatMessage>,
    ): List<ChatMessage> {
        if (fresh.isEmpty()) return existing
        val merged = existing.toMutableList()
        for (server in fresh) {
            val idx = merged.indexOfFirst {
                it.identityKeys.intersect(server.identityKeys).isNotEmpty() || it.isLegacyUserDuplicateOf(server)
            }
            if (idx >= 0) merged[idx] = server else merged.add(server)
        }
        return merged.sortedBy { it.createdAt ?: "" }
    }

    private fun ChatMessage.isLegacyUserDuplicateOf(server: ChatMessage): Boolean {
        if (!isUser || !server.isUser) return false
        val left = displayContent.take(100)
        val right = server.displayContent.take(100)
        if (left.isBlank() || left != right) return false
        val leftAt = createdAt?.toInstantEpochMs() ?: return false
        val rightAt = server.createdAt?.toInstantEpochMs() ?: return false
        return kotlin.math.abs(leftAt - rightAt) < DEDUP_WINDOW_MS
    }

    private fun String.toInstantEpochMs(): Long? = try {
        Instant.parse(this).toEpochMilli()
    } catch (_: Exception) {
        null
    }
}
