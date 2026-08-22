package com.tabtin.mobile.data.websocket

import com.tabtin.mobile.data.model.ConversationFocusContext
import com.tabtin.mobile.data.model.ConversationRuntimeConfiguration
import com.tabtin.mobile.data.model.MessageBlock
import java.util.TimeZone
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Build the `chat.send_message` wire contract from a queue-frozen runtime
 * configuration and Focus snapshot. Keeping this pure makes retries observable
 * and prevents the current Composer / Workbench choice from leaking into an
 * older queued message.
 */
internal fun buildChatSendMessagePayload(
    sessionId: String,
    message: String,
    blocks: List<MessageBlock>?,
    modelId: String,
    runtimeConfiguration: ConversationRuntimeConfiguration,
    clientEventId: String,
    userTimeZone: String = TimeZone.getDefault().id,
    focus: ConversationFocusContext? = null,
): JsonObject = buildJsonObject {
    put("session_id", sessionId)
    put("message", message)
    put("client_event_id", clientEventId)
    put("model_id", modelId)
    put("agent_mode", runtimeConfiguration.agentMode.wireValue)
    put("approval_mode", runtimeConfiguration.approvalMode.wireValue)
    if (!blocks.isNullOrEmpty()) {
        put("blocks", buildJsonArray {
            for (block in blocks) {
                add(buildJsonObject {
                    put("type", block.type)
                    block.content?.let { put("content", it) }
                    block.fileId?.let { put("file_id", it) }
                    block.filename?.let { put("filename", it) }
                    block.mimeType?.let { put("mime_type", it) }
                    block.size?.let { put("size", it) }
                    block.url?.let { put("url", it) }
                    block.tableId?.let { put("table_id", it) }
                    block.docId?.let { put("doc_id", it) }
                    block.memoId?.let { put("memo_id", it) }
                    block.fieldIds?.let { fieldIds ->
                        put("field_ids", buildJsonArray { fieldIds.forEach { add(it) } })
                    }
                    block.rowIds?.let { rowIds ->
                        put("row_ids", buildJsonArray { rowIds.forEach { add(it) } })
                    }
                    block.preview?.let { put("preview", it) }
                    block.spaceId?.let { put("space_id", it) }
                    block.spaceName?.let { put("space_name", it) }
                })
            }
        })
    }
    put("app_context", buildAppContext(focus = focus, fallbackTimeZone = userTimeZone))
}

/**
 * 从队列冻结 Focus 构造安全 app_context。重试禁止读取此刻 Workbench。
 * null Focus 时仅保留时区，兼容旧队列行。
 */
internal fun buildAppContext(
    focus: ConversationFocusContext?,
    fallbackTimeZone: String = TimeZone.getDefault().id,
): JsonObject = buildJsonObject {
    val tz = focus?.userTimeZone?.takeIf { it.isNotBlank() } ?: fallbackTimeZone
    put("user_time_zone", tz)
    put("userTimeZone", tz)
    if (focus == null) return@buildJsonObject

    focus.appType?.let { put("appType", it) }
    focus.appMeta?.let { put("appMeta", it) }
    focus.openTabs?.takeIf { it.isNotEmpty() }?.let { tabs ->
        put(
            "openTabs",
            buildJsonArray {
                for (tab in tabs) {
                    add(
                        buildJsonObject {
                            put("type", tab.type)
                            tab.id?.let { put("id", it) }
                            tab.title?.let { put("title", it) }
                            tab.active?.let { put("active", it) }
                            tab.group_id?.let { put("group_id", it) }
                            tab.app_key?.let { put("app_key", it) }
                            tab.display_name?.let { put("display_name", it) }
                            tab.is_home?.let { put("is_home", it) }
                            tab.app_home?.let { put("app_home", it) }
                            tab.path?.let { put("path", it) }
                            tab.kind?.let { put("kind", it) }
                            tab.url?.let { put("url", it) }
                            tab.session_id?.let { put("session_id", it) }
                        },
                    )
                }
            },
        )
    }
    focus.spaceId?.let {
        put("spaceId", it)
        put("current_space_id", it)
    }
    focus.workspaceMode?.let { put("workspaceMode", it) }
}
