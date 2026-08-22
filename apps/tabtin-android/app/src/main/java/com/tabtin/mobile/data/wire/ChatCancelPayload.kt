package com.tabtin.mobile.data.wire

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Build the `chat.cancel` wire payload.
 *
 * Optional withdraw fields mirror iOS Composer Stop / Electron ：
 * `withdraw_unanswered` + `client_message_id` + `target_content`。
 * Omitting them preserves the legacy stop-only contract used by
 * `StreamManager.cancelMessage`.
 */
internal fun buildChatCancelPayload(
    sessionId: String,
    taskId: String? = null,
    clientMessageId: String? = null,
    withdrawUnanswered: Boolean = false,
    targetContent: String? = null,
): JsonObject = buildJsonObject {
    put("session_id", sessionId)
    taskId?.takeIf { it.isNotBlank() }?.let { put("task_id", it) }
    clientMessageId?.takeIf { it.isNotBlank() }?.let { put("client_message_id", it) }
    if (withdrawUnanswered) {
        put("withdraw_unanswered", true)
        targetContent?.let { put("target_content", it) }
    }
}
