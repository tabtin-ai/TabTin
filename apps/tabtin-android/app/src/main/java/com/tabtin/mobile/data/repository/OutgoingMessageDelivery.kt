package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.model.ChatMessage
import com.tabtin.mobile.data.websocket.AckResult

/** A persisted NAK proves delivery even when older servers omit execution_state. */
internal fun AckResult.isPersistedDeliveryFailure(): Boolean =
    this is AckResult.Nak &&
        delivery == "persisted" &&
        (executionState == null || executionState == "failed_after_persist")

public enum class OutgoingHistoryEvidence {
    ABSENT,
    PERSISTED,
    EXECUTION_STARTED,
}

/**
 * A matching USER proves persistence only. Assistant adjacency is deliberately not enough:
 * a queued USER can be persisted while the previous run is still writing its assistant reply.
 */
internal fun outgoingHistoryEvidence(
    messages: List<ChatMessage>,
    identities: Set<String>,
): OutgoingHistoryEvidence {
    if (identities.isEmpty()) return OutgoingHistoryEvidence.ABSENT
    val userIndex = messages.indexOfFirst { message ->
        message.isUser && message.identityKeys.any { it in identities }
    }
    if (userIndex < 0) return OutgoingHistoryEvidence.ABSENT
    if (messages.any { message ->
            message.isAssistant && message.sourceClientEventId?.let { it in identities } == true
        }
    ) {
        return OutgoingHistoryEvidence.EXECUTION_STARTED
    }
    return OutgoingHistoryEvidence.PERSISTED
}
