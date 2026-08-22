package com.tabtin.mobile.data.model.doc

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
public data class CommentAnchor(
    @OptIn(ExperimentalSerializationApi::class)
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val version: Int = 1,
    @SerialName("block_ids") val blockIds: List<String> = emptyList(),
    @SerialName("block_type") val blockType: String? = null,
    @SerialName("selected_text") val selectedText: String? = null,
)

@Serializable
public data class CommentMessage(
    val id: String,
    @SerialName("thread_id") val threadId: String = "",
    val kind: String = "root",
    @SerialName("author_name") val authorName: String = "",
    @SerialName("author_user_id") val authorUserId: String? = null,
    @SerialName("author_avatar") val authorAvatar: String? = null,
    val body: String = "",
    @SerialName("is_deleted") val isDeleted: Boolean = false,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
)

@Serializable
public data class CommentThread(
    val id: String,
    @SerialName("document_id") val documentId: String = "",
    val scope: String,
    val status: String = "open",
    val anchor: CommentAnchor = CommentAnchor(),
    @SerialName("anchor_status") val anchorStatus: String = "none",
    @SerialName("selected_text") val selectedText: String? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("updated_at") val updatedAt: String? = null,
    val messages: List<CommentMessage> = emptyList(),
)

@Serializable
public data class CommentThreadListResponse(
    val threads: List<CommentThread> = emptyList(),
    val capabilities: List<String> = emptyList(),
)

@Serializable
public data class CommentThreadCreateResponse(
    val thread: CommentThread,
)

@Serializable
public data class CreateCommentThreadRequest(
    val body: String,
    val scope: String,
    val anchor: CommentAnchor,
    @SerialName("selected_text") val selectedText: String? = null,
)
