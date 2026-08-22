package com.tabtin.mobile.data.model

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * 发送消息时使用的 block 结构，与后端 MessageBlock schema 对齐。
 *
 * Wave 6 跨端协议验证补齐字段（与 iOS [`ChatMessage.swift`] `MessageBlock` 1:1 对齐）：
 *  - `field_ids`：@field 类引用必填，取自 Electron `useContextInjection.ts::contextRefsToBlocks`
 *    行 137-141。缺这个字段会让 `table_selection` block 退化成"整张表"，丢失"指定字段"语义。
 *  - `space_id` / `space_name`：@提及插入的 context block 附带所属 space 信息，让后端
 *    `context_resolver.py` + 持久化的 `blocks_json` 能在跨 space 引用时溯源。附件类
 *    block（image/file）不用这两个字段，保持 nullable。
 */
@Serializable
public data class MessageBlock(
    val type: String,
    val content: String? = null,
    @SerialName("file_id") val fileId: String? = null,
    val filename: String? = null,
    @SerialName("mime_type") val mimeType: String? = null,
    val size: Long? = null,
    val url: String? = null,
    @SerialName("table_id") val tableId: String? = null,
    @SerialName("doc_id") val docId: String? = null,
    /** TabMemo 轻量引用的唯一标识；后端据此向 Agent 注入可读取的具体笔记。 */
    @SerialName("memo_id") val memoId: String? = null,
    @SerialName("field_ids") val fieldIds: List<String>? = null,
    /** @row 类引用：table_selection block 指定行（与 iOS/Electron `row_ids` 对齐） */
    @SerialName("row_ids") val rowIds: List<String>? = null,
    val preview: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("space_name") val spaceName: String? = null,
)

@Serializable
public data class SendMessageRequest(
    val message: String,
    val role: String = "user",
    val blocks: List<MessageBlock>? = null,
)

@Serializable
public data class SendMessageResponse(
    val reply: String? = null,
    @SerialName("message_id") val messageId: String? = null,
)

@Serializable
public data class MessageListResponse(
    val messages: List<ChatMessage>,
    val total: Int,
    @SerialName("has_more") val hasMore: Boolean = false,
    @SerialName("oldest_id") val oldestId: String? = null,
    @SerialName("newest_id") val newestId: String? = null,
    @SerialName("server_timestamp") val serverTimestamp: String? = null,
)
