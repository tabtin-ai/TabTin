package com.tabtin.mobile.data.model

import java.util.UUID
import kotlinx.serialization.Serializable

/**
 * 一份尚未转为正式会话的任务草稿所属执行范围。
 *
 * Workspace 是实际执行现场，Project 仅是协作归属，二者不能互相替代。草稿永远
 * 只保存在设备本地；它的 scope 不能拿来推断或覆盖既有 Session 的服务端范围。
 */
@Serializable
public data class ConversationDraftScope(
    val organizationId: String,
    val workspaceId: String,
    val projectId: String? = null,
) {
    public fun isValid(): Boolean =
        organizationId.isNotBlank() && workspaceId.isNotBlank()

    internal fun storageKeyMaterial(): String = listOf(
        organizationId.trim(),
        workspaceId.trim(),
        projectId?.trim().orEmpty(),
    ).joinToString(separator = "|") { value -> "${value.length}:$value" }
}

/**
 * 可安全写入本地草稿的消息 block。
 *
 * `url` 可能是带签名的临时地址，因而刻意不在这里建模。附件只要没有已经由服务端
 * 接管的 file_id，就不能进入恢复快照；其他上下文 block 保留其结构化资源标识。
 */
@Serializable
public data class ConversationDraftBlock(
    val type: String,
    val content: String? = null,
    val fileId: String? = null,
    val filename: String? = null,
    val mimeType: String? = null,
    val size: Long? = null,
    val tableId: String? = null,
    val docId: String? = null,
    val memoId: String? = null,
    val fieldIds: List<String>? = null,
    val rowIds: List<String>? = null,
    val preview: String? = null,
    val spaceId: String? = null,
    val spaceName: String? = null,
) {
    public fun toMessageBlock(): MessageBlock = MessageBlock(
        type = type,
        content = content,
        fileId = fileId,
        filename = filename,
        mimeType = mimeType,
        size = size,
        tableId = tableId,
        docId = docId,
        memoId = memoId,
        fieldIds = fieldIds,
        rowIds = rowIds,
        preview = preview,
        spaceId = spaceId,
        spaceName = spaceName,
    )

    public companion object {
        /**
         * 从运行时 block 生成持久化投影。未上传附件会被过滤，签名 URL 永远不会
         * 被复制进草稿，即使调用方意外传入了它。
         */
        public fun fromMessageBlock(block: MessageBlock): ConversationDraftBlock? {
            val normalizedType = block.type.trim()
            if (normalizedType.isEmpty()) return null
            val requiresUploadedFile = normalizedType == "image" || normalizedType == "file"
            if (requiresUploadedFile && block.fileId.isNullOrBlank()) return null
            return ConversationDraftBlock(
                type = normalizedType,
                content = block.content,
                fileId = block.fileId?.trim()?.takeIf { it.isNotEmpty() },
                filename = block.filename,
                mimeType = block.mimeType,
                size = block.size,
                tableId = block.tableId,
                docId = block.docId,
                memoId = block.memoId,
                fieldIds = block.fieldIds,
                rowIds = block.rowIds,
                preview = block.preview,
                spaceId = block.spaceId,
                spaceName = block.spaceName,
            )
        }
    }
}

/**
 * 首发前可恢复的最小本地快照。
 *
 * draftId 同时是 `POST /chat/sessions` 的稳定 session_id；clientEventId 则是首条
 * 排队消息的稳定幂等键。两者分离，避免把会话身份误当作消息身份。
 */
@Serializable
public data class ConversationDraftSnapshot(
    val draftId: String = UUID.randomUUID().toString(),
    val scope: ConversationDraftScope,
    val text: String,
    val agentId: String,
    val modelId: String,
    val agentMode: String = ConversationAgentMode.AGENT.wireValue,
    val approvalMode: String = ConversationApprovalMode.ALWAYS_ASK.wireValue,
    /** 首发前冻结的上下文档位；建 session 后立刻写入。 */
    val contextTierId: String? = null,
    /** 首发前冻结的思考强度（v2 thinking_mode）；建 session 后立刻写入。 */
    val thinkingMode: String? = null,
    val pendingSessionId: String? = null,
    val clientEventId: String = UUID.randomUUID().toString(),
    val blocks: List<ConversationDraftBlock> = emptyList(),
    val createdAt: Long = System.currentTimeMillis(),
    val updatedAt: Long = createdAt,
) {
    public fun runtimeConfiguration(
        permitsRelaxedApproval: Boolean,
    ): ConversationRuntimeConfiguration = ConversationRuntimeConfiguration.resolving(
        rawAgentMode = agentMode,
        rawApprovalMode = approvalMode,
        permitsRelaxedApproval = permitsRelaxedApproval,
    )

    public fun matchesSession(sessionId: String): Boolean =
        sessionId.isNotBlank() && (pendingSessionId == sessionId || draftId == sessionId)
}
