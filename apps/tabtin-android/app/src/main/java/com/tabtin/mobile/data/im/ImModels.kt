package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.api.json
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull

/** 单条消息最多允许的不同表情种类数；所有添加入口必须共用这一领域边界。 */
public const val IM_REACTION_KIND_LIMIT: Int = 10

public fun canAddImReaction(emoji: String, reactions: Map<String, List<String>>): Boolean {
    if (reactions[emoji].orEmpty().isNotEmpty()) return true
    return reactions.count { it.value.isNotEmpty() } < IM_REACTION_KIND_LIMIT
}

/**
 * TabChat IM 数据模型（对齐 iOS `Core/IM/IMModels.swift` 与后端 `tabchat.schemas`）。
 *
 * TabChat 是「人↔人 / 群聊 / 团队频道 / @Agent」的即时通讯（`/im/…` + Centrifugo），
 * 与 Agent 对话（`/chat/…` + Django WS）是两套系统，不要混用。
 *
 * 反序列化统一走 [com.tabtin.mobile.data.api.json]（`ignoreUnknownKeys` + `coerceInputValues`
 * + `isLenient`），因此后端多下发字段自动忽略、缺省字段回落默认值，无需逐字段自定义解码。
 */

/** 会话类型，对齐后端 `tabchat.constants.ConversationType`。 */
public object ImConversationType {
    public const val DM: Int = 1
    public const val GROUP: Int = 2
}

/** 消息类型，对齐后端 `tabchat.constants.MessageType`。 */
public object ImMessageType {
    public const val TEXT: Int = 1
    public const val SYSTEM: Int = 2
    public const val FILE: Int = 3
    public const val IMAGE: Int = 4
}

/** 成员类型（群聊可含 Agent 成员）。 */
public object ImMemberType {
    public const val USER: String = "user"
    public const val AGENT: String = "agent"
}

/** 资源卡类型，对齐后端 `metadata.card.type`。 */
public object ImResourceCardType {
    public const val SPACE: String = "space"
    public const val AGENT_SPACE: String = "agent_space"
    public const val DOCUMENT: String = "document"
    public const val TABLE: String = "table"
    public const val CONTACT: String = "contact"
    public const val SESSION_SHARE: String = "session_share"
    public const val SESSION_SHARE_V2: String = "session_share_v2"
    public const val SESSION_CONTINUATION: String = "session_continuation"
    public const val HANDOFF: String = "handoff"
    public const val CODEX_SESSION: String = "codex_session"
}

/** 新建共享入口的三种产品意图；历史 fork 权限仍可解析，但不再作为新建选项。 */
public enum class ImTaskShareMode {
    VIEW,
    COLLABORATE,
    CONTINUE,
    ;

    public val canFork: Boolean get() = false
    public val canChat: Boolean get() = this == COLLABORATE
    public val isContinuation: Boolean get() = this == CONTINUE
    public val accessMode: String get() = if (canChat) "collaborate" else "view"
}

/** Agent 会话共享请求，对齐 iOS `ConversationSessionShareRequest`。 */
@Serializable
public data class ImSessionShareRequest(
    @SerialName("session_id") val sessionId: String,
    @SerialName("grantee_user_id") val granteeUserId: String,
    @SerialName("can_fork") val canFork: Boolean,
    @SerialName("can_chat") val canChat: Boolean = false,
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("client_request_id") val clientRequestId: String? = null,
    @SerialName("restore_share_id") val restoreShareId: String? = null,
    @SerialName("card_contract") val cardContract: String = ImResourceCardType.SESSION_SHARE_V2,
    @SerialName("access_mode") val accessMode: String = when {
        canChat -> "collaborate"
        canFork -> "fork"
        else -> "view"
    },
)

/** 后端创建共享卡后的权威结果。 */
@Serializable
public data class ImSessionShareResponse(
    val id: String,
    @SerialName("session_id") val sessionId: String,
    @SerialName("session_title") val sessionTitle: String = "",
    @SerialName("owner_user_id") val ownerUserId: String? = null,
    @SerialName("grantee_user_id") val granteeUserId: String,
    @SerialName("can_fork") val canFork: Boolean = false,
    @SerialName("can_chat") val canChat: Boolean = false,
    val status: String = "active",
    @SerialName("forked_session_id") val forkedSessionId: String? = null,
    @SerialName("owner_display_name") val ownerDisplayName: String? = null,
    @SerialName("grantee_display_name") val granteeDisplayName: String? = null,
    @SerialName("conversation_id") val conversationId: String? = null,
    /**
     * The shared-card endpoint returns the persisted IM message primary key.
     * It is not bounded by the 32-bit message ids used by the local IM cache.
     */
    @SerialName("message_id") val messageId: Long? = null,
) {
    public fun toCardSnapshot(): ImSessionShareCard = ImSessionShareCard(
        type = ImResourceCardType.SESSION_SHARE,
        shareId = id,
        sessionId = sessionId,
        sessionTitle = sessionTitle,
        ownerUserId = ownerUserId,
        granteeUserId = granteeUserId,
        canFork = canFork,
        canChat = canChat,
        status = status,
        ownerDisplayName = ownerDisplayName,
        granteeDisplayName = granteeDisplayName,
    )
}

@Serializable
public data class ImSessionShareListResponse(
    val shares: List<ImSessionShareResponse> = emptyList(),
)

@Serializable
public data class ImSessionShareV2BatchRequest(
    @SerialName("object_ids") val objectIds: List<String>,
)

@Serializable
public data class ImSessionShareV2BatchResponse(
    val items: List<ImSessionShareV2BatchItem> = emptyList(),
)

@Serializable
public data class ImSessionShareV2BatchItem(
    @SerialName("object_id") val objectId: String = "",
    val ok: Boolean = false,
    val detail: ImSessionShareV2Detail? = null,
    val error: String? = null,
)

@Serializable
public data class ImSessionShareV2Detail(
    val id: String,
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("session_title") val sessionTitle: String = "",
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("workspace_name") val workspaceName: String? = null,
    @SerialName("owner_user_id") val ownerUserId: String,
    @SerialName("grantee_user_id") val granteeUserId: String,
    @SerialName("can_fork") val canFork: Boolean = false,
    @SerialName("can_chat") val canChat: Boolean = false,
    val status: String = "pending",
    @SerialName("forked_session_id") val forkedSessionId: String? = null,
    @SerialName("owner_display_name") val ownerDisplayName: String? = null,
    @SerialName("grantee_display_name") val granteeDisplayName: String? = null,
    @SerialName("card_contract") val cardContract: String? = null,
    val version: Int = 0,
    val role: String? = null,
    val phase: String? = null,
    @SerialName("access_mode") val accessMode: String? = null,
    val actions: ImSessionShareV2Actions? = null,
) {
    public fun toCardSnapshot(): ImSessionShareCard = ImSessionShareCard(
        type = ImResourceCardType.SESSION_SHARE,
        shareId = id,
        sessionId = sessionId.orEmpty(),
        sessionTitle = sessionTitle,
        ownerUserId = ownerUserId,
        granteeUserId = granteeUserId,
        canFork = canFork,
        canChat = canChat,
        status = if (status == "revoked") "revoked" else "active",
        ownerDisplayName = ownerDisplayName,
        granteeDisplayName = granteeDisplayName,
    )
}

@Serializable
public data class ImSessionShareV2Actions(
    @SerialName("can_join") val canJoin: Boolean = false,
    @SerialName("can_open") val canOpen: Boolean = false,
    @SerialName("can_stop") val canStop: Boolean = false,
    @SerialName("can_restore") val canRestore: Boolean = false,
    @SerialName("can_change_access") val canChangeAccess: Boolean = false,
)

@Serializable
public data class ImSessionContinuationCreateRequest(
    @SerialName("source_session_id") val sourceSessionId: String,
    @SerialName("recipient_user_id") val recipientUserId: String,
    @SerialName("client_request_id") val clientRequestId: String,
    @SerialName("conversation_id") val conversationId: String? = null,
)

@Serializable
public data class ImSessionContinuationBatchRequest(
    @SerialName("object_ids") val objectIds: List<String>,
)

@Serializable
public data class ImSessionContinuationBatchResponse(
    val items: List<ImSessionContinuationBatchItem> = emptyList(),
)

@Serializable
public data class ImSessionContinuationBatchItem(
    @SerialName("object_id") val objectId: String = "",
    val ok: Boolean = false,
    val detail: ImSessionContinuationDetail? = null,
    val error: String? = null,
)

@Serializable
public data class ImSessionContinuationCreateTaskRequest(
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String,
    @SerialName("client_request_id") val clientRequestId: String,
)

@Serializable
public data class ImSessionContinuationResource(
    val label: String? = null,
    val unavailable: Boolean = false,
    val reason: String? = null,
)

@Serializable
public data class ImSessionContinuationEligibility(
    @SerialName("can_create") val canCreate: Boolean = false,
    val reason: String = "",
)

@Serializable
public data class ImSessionContinuationDetail(
    @SerialName("object_id") val objectId: String,
    val version: Int = 0,
    val role: String = "",
    @SerialName("title_snapshot") val titleSnapshot: String = "",
    @SerialName("context_status") val contextStatus: String = "empty",
    @SerialName("snapshot_turn_count") val snapshotTurnCount: Int = 0,
    @SerialName("resource_status") val resourceStatus: String = "none",
    val resources: List<ImSessionContinuationResource> = emptyList(),
    @SerialName("delivery_status") val deliveryStatus: String = "pending",
    @SerialName("creation_status") val creationStatus: String = "available",
    @SerialName("linked_session_id") val linkedSessionId: String? = null,
    @SerialName("target_workspace_id") val targetWorkspaceId: String? = null,
    @SerialName("organization_id") val organizationId: String = "",
    val eligibility: ImSessionContinuationEligibility = ImSessionContinuationEligibility(),
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("updated_at") val updatedAt: String = "",
)

@Serializable
public data class ImHandoffReferenceRequest(
    @SerialName("ref_type") val refType: String,
    @SerialName("resource_id") val resourceId: String,
)

@Serializable
public data class ImHandoffCreateRequest(
    @SerialName("conversation_id") val conversationId: String,
    val goal: String,
    val progress: List<ImHandoffChecklistItem> = emptyList(),
    @SerialName("next_steps") val nextSteps: List<ImHandoffChecklistItem> = emptyList(),
    val risks: List<ImHandoffChecklistItem> = emptyList(),
    val scope: String = "continuable",
    val recipients: List<String>,
    val references: List<ImHandoffReferenceRequest> = emptyList(),
    val send: Boolean = true,
)

@Serializable
public data class ImHandoffActionRequest(
    val action: String,
    val note: String = "",
)

@Serializable
public data class ImHandoffTakeOverRequest(
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String,
)

@Serializable
public data class ImHandoffChecklistItem(
    val text: String,
    val checked: Boolean? = null,
    @SerialName("high_risk") val highRisk: Boolean? = null,
)

@Serializable
public data class ImHandoffRecipient(
    @SerialName("user_id") val userId: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    val state: String = "sent",
    val note: String = "",
    @SerialName("state_changed_at") val stateChangedAt: String? = null,
)

@Serializable
public data class ImHandoffSourceLink(
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("message_id") val messageId: Int? = null,
    val seq: Int? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("session_id") val sessionId: String? = null,
)

@Serializable
public data class ImHandoffFrozenAttachment(
    val type: String = "file",
    @SerialName("file_id") val fileId: String = "",
    val filename: String = "未命名文件",
    @SerialName("mime_type") val mimeType: String = "",
    val size: Int = 0,
)

@Serializable
public data class ImHandoffFrozenTurn(
    val role: String = "assistant",
    val text: String = "",
    val attachments: List<ImHandoffFrozenAttachment> = emptyList(),
)

@Serializable
public data class ImHandoffFrozenTranscript(
    val title: String = "Agent 会话记录",
    @SerialName("message_count") val messageCount: Int = 0,
    val truncated: Boolean = false,
    val turns: List<ImHandoffFrozenTurn> = emptyList(),
)

@Serializable
public data class ImHandoffReference(
    val id: String,
    @SerialName("ref_type") val refType: String,
    @SerialName("resource_id") val resourceId: String,
    val title: String = "",
    val summary: String = "",
    @SerialName("source_link") val sourceLink: ImHandoffSourceLink = ImHandoffSourceLink(),
    val accessible: Boolean = false,
    @SerialName("denied_reason") val deniedReason: String? = null,
    @SerialName("frozen_snapshot") val frozenSnapshot: ImHandoffFrozenTranscript? = null,
)

@Serializable
public data class ImHandoffPackage(
    val id: String,
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("organization_id") val organizationId: String,
    @SerialName("initiator_type") val initiatorType: String = "user",
    @SerialName("initiator_user_id") val initiatorUserId: String? = null,
    @SerialName("initiator_agent_id") val initiatorAgentId: String? = null,
    val goal: String = "上下文交接",
    val progress: List<ImHandoffChecklistItem> = emptyList(),
    @SerialName("next_steps") val nextSteps: List<ImHandoffChecklistItem> = emptyList(),
    val risks: List<ImHandoffChecklistItem> = emptyList(),
    val scope: String = "continuable",
    val status: String = "sent",
    val version: Int = 0,
    @SerialName("card_message_id") val cardMessageId: Int? = null,
    val recipients: List<ImHandoffRecipient> = emptyList(),
    val references: List<ImHandoffReference> = emptyList(),
)

/** 资源卡预览状态，对齐 Electron `ResourceCardPreviewResult`。 */
public enum class ImResourceCardPreviewStatus {
    OK,
    DELETED,
    FORBIDDEN,
    ERROR,
}

@Serializable
public data class ImResourceCardPreview(
    val name: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("current_user_role") val currentUserRole: String? = null,
    val description: String? = null,
    @SerialName("preview_table") val previewTable: ImCardTablePreview? = null,
)

public data class ImResourceCardPreviewResult(
    val status: ImResourceCardPreviewStatus,
    val data: ImResourceCardPreview? = null,
)

@Serializable
public data class ImResourceAccessRequestBody(
    @SerialName("source_conversation_id") val sourceConversationId: String,
    @SerialName("source_message_id") val sourceMessageId: Int? = null,
    @SerialName("source_message_ref") val sourceMessageRef: String? = null,
    @SerialName("resource_type") val resourceType: String,
    @SerialName("resource_id") val resourceId: String,
)

@Serializable
public data class ImResourceAccessRequestResponse(
    val id: String = "",
    @SerialName("resource_type") val resourceType: String = "",
    @SerialName("resource_id") val resourceId: String = "",
    val role: String = "",
    val status: String = "",
)

@Serializable
public data class ImConversationLabel(
    val id: String = "",
    val name: String = "",
    val color: String = "#6b7280",
    @SerialName("is_system") val isSystem: Boolean = false,
    @SerialName("conversation_count") val conversationCount: Int = 0,
) {
    public companion object {
        public val systemMention: ImConversationLabel = ImConversationLabel(
            id = "sys:mention",
            name = "@me",
            color = "#ef4444",
            isSystem = true,
        )
    }
}

/** 会话列表项，对齐后端 `ConversationOut`。 */
@Serializable
public data class ImConversation(
    val id: String = "",
    @SerialName("organization_id") val organizationId: String = "",
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("space_name") val spaceName: String = "",
    @SerialName("is_team_space_channel") val isTeamSpaceChannel: Boolean = false,
    @SerialName("is_external") val isExternal: Boolean = false,
    val type: Int = ImConversationType.DM,
    val name: String = "",
    @SerialName("avatar_url") val avatarUrl: String = "",
    @SerialName("member_count") val memberCount: Int = 0,
    @SerialName("is_archived") val isArchived: Boolean = false,
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    @SerialName("last_message_preview") val lastMessagePreview: String = "",
    @SerialName("unread_count") val unreadCount: Int = 0,
    // 统计 unreadCount 时会话已见的最高消息 seq 水位（后端同一致快照下发）：
    // 仅用于列表加载在途 baseline/delta 合并（加载窗口内 seq > 水位 的 realtime 未读才计净增量）。
    @SerialName("last_message_seq") val lastMessageSeq: Int = 0,
    @SerialName("created_at") val createdAt: String = "",
    @SerialName("dm_peer_user_id") val dmPeerUserId: String? = null,
    val pinned: Boolean = false,
    @SerialName("is_muted") val isMuted: Boolean = false,
    /** 当前用户参与外部会话时的组织身份；旧响应缺失时由 [directoryOrganizationId] 回退。 */
    @SerialName("participant_organization_id") val participantOrganizationId: String? = null,
    /** 当前会话所属的用户目录；外部会话不一定等于托管 organizationId。 */
    @SerialName("directory_scope_id") val directoryScopeId: String? = null,
    /** 服务端权威发送门禁；退出外部会话后历史仍可读但不可发送。 */
    @SerialName("can_send") val canSend: Boolean = true,
    val labels: List<ImConversationLabel> = emptyList(),
) {
    public val isGroup: Boolean get() = type == ImConversationType.GROUP
    public val isRemovedMemberDirectMessage: Boolean
        get() = type == ImConversationType.DM && memberCount < 2
    public val directoryOrganizationId: String
        get() = if (isExternal) {
            sequenceOf(directoryScopeId, participantOrganizationId, organizationId)
                .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
                .firstOrNull()
                .orEmpty()
        } else {
            organizationId
        }
    public val canReceiveMessages: Boolean get() = canSend && !isRemovedMemberDirectMessage

    /** 排序键：最近活动时间（同格式 ISO8601 下字典序≈时间序），缺失排最后。 */
    public val sortValue: String get() = lastMessageAt ?: createdAt
}

/** 云消息搜索按会话聚合后的列表项。摘要必须来自真实命中消息，不复用最后消息。 */
public data class ImMessageSearchResult(
    val conversation: ImConversation,
    val matchedMessagePreview: String,
    val matchCount: Int,
)

/** 会话个人置顶偏好写入结果。 */
@Serializable
public data class ImConversationPinResult(
    val pinned: Boolean = false,
)

@Serializable
public data class ImConversationMuteResult(val muted: Boolean = false)

/** 当前用户在会话中的个人历史可见性水位。 */
@Serializable
public data class ImHistoryState(
    @SerialName("history_cleared_seq") val historyClearedSeq: Int = 0,
)

/** 清空历史接口返回的本次清空水位。字段与读取历史状态的接口不同。 */
@Serializable
public data class ImClearHistoryResult(
    @SerialName("cleared_seq") val clearedSeq: Int = 0,
)

@Serializable
public data class ImAddMembersResult(
    @SerialName("added_user_ids") val addedUserIds: List<String> = emptyList(),
    @SerialName("added_external_contact_ids") val addedExternalContactIds: List<String> = emptyList(),
)

/** 被回复消息预览，对齐后端 `ReplyToPreview`。 */
@Serializable
public data class ImReplyPreview(
    val content: String = "",
    @SerialName("sender_id") val senderId: String = "",
    @SerialName("is_unavailable") val isUnavailable: Boolean = false,
    @SerialName("message_type") val messageType: Int = ImMessageType.TEXT,
    @SerialName("has_attachment") val hasAttachment: Boolean = false,
    @SerialName("file_name") val fileName: String = "",
)

/**
 * 已读聚合（`read_receipt`）：后端仅在**本人发出**的消息列表项里下发。
 * [readCount] = 已读该消息的收件人数；[recipientCount] = 群真人成员数（不含自己）。
 */
@Serializable
public data class ImReadReceipt(
    @SerialName("read_count") val readCount: Int = 0,
    @SerialName("recipient_count") val recipientCount: Int = 0,
)

@Serializable
public data class ImReadReceiptMember(
    @SerialName("user_id") val userId: String,
    val name: String = "",
    val avatar: String = "",
) {
    public val displayName: String get() = name.ifBlank { userId }
}

@Serializable
public data class ImMessageReadReceipts(
    val readers: List<ImReadReceiptMember>,
    val unreaders: List<ImReadReceiptMember>,
)

@Serializable
public data class DjangoImGroupedSearchGroup(
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("conversation_name") val conversationName: String = "",
    @SerialName("conversation_type") val conversationType: Int = ImConversationType.DM,
    @SerialName("conversation_avatar_url") val conversationAvatarUrl: String = "",
    @SerialName("match_count") val matchCount: Int = 0,
    val messages: List<ImMessage> = emptyList(),
)

@Serializable
public data class DjangoImGroupedSearchResult(
    val groups: List<DjangoImGroupedSearchGroup> = emptyList(),
)

internal fun mergeImReadReceipt(
    existing: ImReadReceipt?,
    incoming: ImReadReceipt?,
): ImReadReceipt? = when {
    existing == null -> incoming
    incoming == null -> existing
    else -> ImReadReceipt(
        readCount = maxOf(existing.readCount, incoming.readCount),
        recipientCount = maxOf(existing.recipientCount, incoming.recipientCount),
    )
}

/** 表格卡列定义（对齐后端 `preview_table.columns`）。 */
@Serializable
public data class ImCardTableColumn(
    val key: String = "",
    val label: String = "",
)

/** 表格卡预览快照（对齐后端 `preview_table`）。 */
@Serializable
public data class ImCardTablePreview(
    val columns: List<ImCardTableColumn> = emptyList(),
    val rows: List<Map<String, String>> = emptyList(),
    @SerialName("total_rows") val totalRows: Int = 0,
)

/** 消息里的资源卡（文档 / 表格 / 名片），对齐后端 `_validate_card_metadata`。 */
@Serializable
public data class ImResourceCard(
    val type: String = "",
    val name: String = "",
    val icon: String? = null,
    @SerialName("display_name") val displayNameSnapshot: String? = null,
    @SerialName("displayName") val displayNameCamel: String? = null,
    val nickname: String? = null,
    @SerialName("file_name") val fileName: String? = null,
    val description: String? = null,
    val caption: String? = null,
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    @SerialName("hint_carrier_app_id") val hintCarrierAppId: String? = null,
    @SerialName("user_id") val userId: String? = null,
    val username: String? = null,
    val avatar: String? = null,
    @SerialName("preview_table") val previewTable: ImCardTablePreview? = null,
    val title: String? = null,
    @SerialName("prompt_text") val promptText: String? = null,
    @SerialName("prompt_version") val promptVersion: Int? = null,
) {
    public val displayName: String
        get() = explicitDisplayName ?: fallbackDisplayName

    public fun displayName(messageContent: String?): String =
        explicitDisplayName ?: titleFromFallbackContent(messageContent) ?: fallbackDisplayName

    private val explicitDisplayName: String?
        get() {
            val candidates = when (type) {
                ImResourceCardType.CONTACT -> listOf(
                    name,
                    displayNameSnapshot,
                    displayNameCamel,
                    nickname,
                    title,
                    username,
                )
                ImResourceCardType.DOCUMENT,
                ImResourceCardType.TABLE,
                ImResourceCardType.SPACE,
                ImResourceCardType.AGENT_SPACE,
                -> listOf(name, title, displayNameSnapshot, displayNameCamel, fileName, caption)
                else -> listOf(name, title, displayNameSnapshot, displayNameCamel, fileName, caption)
            }
            return candidates.firstNotBlankOrNull()
        }

    public val fallbackDisplayName: String
        get() = when (type) {
            ImResourceCardType.CONTACT -> "用户"
            ImResourceCardType.DOCUMENT -> "云文档"
            ImResourceCardType.TABLE -> "表格"
            ImResourceCardType.SPACE,
            ImResourceCardType.AGENT_SPACE,
            -> "工作空间"
            else -> "资源"
        }

    private fun titleFromFallbackContent(messageContent: String?): String? {
        val trimmed = messageContent?.trim().orEmpty()
        val prefixes = when (type) {
            ImResourceCardType.CONTACT -> listOf("[名片]")
            ImResourceCardType.DOCUMENT -> listOf("[文档]", "[云文档]")
            ImResourceCardType.TABLE -> listOf("[表格]", "[多维表格]")
            ImResourceCardType.SPACE,
            ImResourceCardType.AGENT_SPACE,
            -> listOf("[工作空间]", "[Workspace]")
            else -> listOf("[资源]", "[文档]", "[云文档]", "[表格]", "[多维表格]", "[名片]")
        }
        return prefixes.firstNotNullOfOrNull { prefix ->
            trimmed.takeIf { it.startsWith(prefix) }
                ?.removePrefix(prefix)
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
        }
    }

    public val isValidType: Boolean
        get() = type == ImResourceCardType.DOCUMENT ||
            type == ImResourceCardType.TABLE ||
            type == ImResourceCardType.CONTACT ||
            spaceCard != null

    /** Workspace 卡保持 `space_id` 语义；调用方必须再解析绑定 Agent，不能把它当 agent_id。 */
    public val spaceCard: ImSpaceCard?
        get() {
            if (type != ImResourceCardType.SPACE && type != ImResourceCardType.AGENT_SPACE) return null
            val resolvedSpaceId = spaceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
            return ImSpaceCard(
                type = type,
                spaceId = resolvedSpaceId,
                displayName = displayName,
                icon = icon?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

    /** 指令卡自包含正文，不应被误路由为文档 / 表格资源。 */
    public val promptCard: ImPromptCard?
        get() {
            val text = promptText?.trim().orEmpty()
            if (type != "prompt" || text.isEmpty()) return null
            return ImPromptCard(title = title.orEmpty(), promptText = text)
        }

    /**
     * 解析资源卡的实际打开上下文。
     *
     * 历史卡片可能早于 organization_id 回填，回退到会话 Organization；组织级资源则
     * 合法地没有 space_id，必须保留 null 以走根级资源路由。
     */
    internal fun resolveOpenTarget(
        conversationOrganizationId: String,
        preview: ImResourceCardPreview? = null,
    ): ImResourceCardOpenTarget? {
        val resourceType = when (type) {
            ImResourceCardType.DOCUMENT -> "tabdoc"
            ImResourceCardType.TABLE -> "tabdata"
            else -> return null
        }
        val resolvedResourceId = resourceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val previewOrganizationId = preview?.organizationId?.trim()?.takeIf { it.isNotEmpty() }
        val resolvedOrganizationId: String
        val resolvedSpaceId: String?
        if (previewOrganizationId != null) {
            resolvedOrganizationId = previewOrganizationId
            resolvedSpaceId = preview.spaceId?.trim()?.takeIf { it.isNotEmpty() }
        } else {
            resolvedOrganizationId = organizationId?.trim()?.takeIf { it.isNotEmpty() }
                ?: conversationOrganizationId.trim().takeIf { it.isNotEmpty() }
                ?: return null
            resolvedSpaceId = spaceId?.trim()?.takeIf { it.isNotEmpty() }
        }
        return ImResourceCardOpenTarget(
            resourceType = resourceType,
            resourceId = resolvedResourceId,
            organizationId = resolvedOrganizationId,
            spaceId = resolvedSpaceId,
        )
    }
}

public data class ImSpaceCard(
    val type: String,
    val spaceId: String,
    val displayName: String,
    val icon: String? = null,
)

/** IM 任务共享卡（metadata.card.type=session_share）。 */
@Serializable
public data class ImSessionShareCard(
    val type: String = ImResourceCardType.SESSION_SHARE,
    @SerialName("share_id") val shareId: String = "",
    @SerialName("session_id") val sessionId: String? = null,
    @SerialName("session_title") val sessionTitle: String? = null,
    @SerialName("owner_user_id") val ownerUserId: String? = null,
    @SerialName("grantee_user_id") val granteeUserId: String? = null,
    @SerialName("can_fork") val canFork: Boolean = false,
    @SerialName("can_chat") val canChat: Boolean = false,
    val status: String = "active",
    @SerialName("owner_display_name") val ownerDisplayName: String? = null,
    @SerialName("grantee_display_name") val granteeDisplayName: String? = null,
) {
    public val isValid: Boolean get() = type == ImResourceCardType.SESSION_SHARE && shareId.isNotBlank()
    public val normalizedStatus: String get() = if (status == "revoked") "revoked" else "active"
    public val displayTitle: String get() = sessionTitle?.trim()?.takeIf { it.isNotEmpty() } ?: "未命名任务"
    public val permissionLabel: String
        get() = when {
            canChat -> "可控制"
            canFork -> "查看并创建副本"
            else -> "实时查看"
        }
}

/** `session_share_v2` 消息快照；实时状态与操作能力从详情接口加载。 */
@Serializable
public data class ImSessionShareV2Card(
    val type: String = ImResourceCardType.SESSION_SHARE_V2,
    @SerialName("schema_version") val schemaVersion: Int = 0,
    val version: Int = 0,
    @SerialName("object_id") val objectId: String = "",
    @SerialName("title_snapshot") val title: String = "",
    @SerialName("sender_id") val senderId: String = "",
    @SerialName("recipient_id") val recipientId: String = "",
) {
    public fun validated(): ImSessionShareV2Card? {
        val normalized = copy(
            objectId = objectId.trim(),
            title = title.trim(),
            senderId = senderId.trim(),
            recipientId = recipientId.trim(),
        )
        return normalized.takeIf {
            it.type == ImResourceCardType.SESSION_SHARE_V2 &&
            schemaVersion == 1 &&
            version >= 1 &&
            it.objectId.isNotEmpty() &&
            it.title.isNotEmpty() &&
            it.senderId.isNotEmpty() &&
            it.recipientId.isNotEmpty()
        }
    }
}

/** `session_continuation` 消息只携带定位快照，冻结上下文必须从权威详情接口读取。 */
@Serializable
public data class ImSessionContinuationCard(
    val type: String = ImResourceCardType.SESSION_CONTINUATION,
    @SerialName("schema_version") val schemaVersion: Int = 0,
    val version: Int = 0,
    @SerialName("object_id") val objectId: String = "",
    @SerialName("title_snapshot") val title: String = "",
    @SerialName("sender_id") val senderId: String = "",
    @SerialName("recipient_id") val recipientId: String = "",
) {
    public fun validated(): ImSessionContinuationCard? {
        val normalized = copy(
            objectId = objectId.trim(),
            title = title.trim(),
            senderId = senderId.trim(),
            recipientId = recipientId.trim(),
        )
        return normalized.takeIf {
            it.type == ImResourceCardType.SESSION_CONTINUATION &&
                schemaVersion == 1 &&
                version >= 1 &&
                it.objectId.isNotEmpty() &&
                it.title.isNotEmpty() &&
                it.senderId.isNotEmpty() &&
                it.recipientId.isNotEmpty()
        }
    }
}

/** 对话接力消息快照；可变状态、接收者进度与材料权限必须从 handoff 详情读取。 */
@Serializable
public data class ImHandoffCard(
    val type: String = ImResourceCardType.HANDOFF,
    @SerialName("handoff_id") val handoffId: String = "",
    val goal: String = "上下文交接",
    val scope: String = "continuable",
    @SerialName("initiator_type") val initiatorType: String = "user",
    @SerialName("initiator_id") val initiatorId: String? = null,
    @SerialName("recipient_count") val recipientCount: Int = 0,
) {
    public fun validated(): ImHandoffCard? {
        val normalized = copy(handoffId = handoffId.trim(), goal = goal.trim())
        return normalized.takeIf {
            it.type == ImResourceCardType.HANDOFF && it.handoffId.isNotEmpty()
        }
    }
}

private fun List<String?>.firstNotBlankOrNull(): String? =
    firstNotNullOfOrNull { value -> value?.trim()?.takeIf { it.isNotEmpty() } }

/** 一张可复用的 AI 指令卡；用户使用后仍需在新任务里确认 AI 分身与 Workspace。 */
public data class ImPromptCard(
    val title: String,
    val promptText: String,
) {
    public val displayTitle: String
        get() = title.trim().ifEmpty {
            promptText.lineSequence().map { it.trim() }.firstOrNull { it.isNotEmpty() } ?: "指令"
        }
}

public data class ImCodexSessionCard(
    val sessionId: String,
    val sessionName: String,
    val suggestedWorkingDirectory: String? = null,
)

/**
 * 客户端待发送的富卡。后端协议仍是 TEXT + metadata.card；此模型让请求、乐观消息和失败重试
 * 共享同一份卡片快照，避免 UI 层散落无类型 JSON。
 */
@Serializable
public data class ImOutgoingCard(
    val type: String,
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("user_id") val userId: String? = null,
    val name: String = "",
    val icon: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("organization_id") val organizationId: String? = null,
    val username: String? = null,
    val avatar: String? = null,
    @SerialName("prompt_text") val promptText: String? = null,
    val title: String? = null,
    @SerialName("schema_version") val schemaVersion: Int? = null,
    @SerialName("codex_session_id") val codexSessionId: String? = null,
    @SerialName("codex_session_name") val codexSessionName: String? = null,
    @SerialName("suggested_working_directory") val suggestedWorkingDirectory: String? = null,
) {
    public companion object {
        public fun resource(
            type: String,
            resourceId: String,
            name: String,
            spaceId: String?,
            organizationId: String?,
        ): ImOutgoingCard {
            require(type == ImResourceCardType.DOCUMENT || type == ImResourceCardType.TABLE)
            return ImOutgoingCard(
                type = type,
                resourceId = resourceId,
                name = name,
                spaceId = spaceId,
                organizationId = organizationId,
            )
        }

        public fun contact(
            userId: String,
            name: String,
            username: String?,
            avatar: String?,
        ): ImOutgoingCard = ImOutgoingCard(
            type = ImResourceCardType.CONTACT,
            userId = userId,
            name = name,
            username = username,
            avatar = avatar,
        )

        public fun workspace(card: ImSpaceCard): ImOutgoingCard {
            require(card.type == ImResourceCardType.SPACE || card.type == ImResourceCardType.AGENT_SPACE)
            return ImOutgoingCard(
                type = card.type,
                name = card.displayName,
                icon = card.icon,
                spaceId = card.spaceId,
            )
        }

        public fun prompt(promptText: String, title: String): ImOutgoingCard = ImOutgoingCard(
            type = "prompt",
            promptText = promptText,
            title = title,
        )

        public fun codexSession(card: ImCodexSessionCard): ImOutgoingCard = ImOutgoingCard(
            type = ImResourceCardType.CODEX_SESSION,
            name = card.sessionName,
            schemaVersion = 1,
            codexSessionId = card.sessionId,
            codexSessionName = card.sessionName,
            suggestedWorkingDirectory = card.suggestedWorkingDirectory,
        )
    }

    /** 服务端会把资源 / 名片重建成权威快照；本地先用选择时已有信息渲染，等待 realtime 覆盖。 */
    public fun toLocalCard(): ImResourceCard = ImResourceCard(
        type = type,
        name = name,
        icon = icon,
        resourceId = resourceId,
        spaceId = spaceId,
        organizationId = organizationId,
        hintCarrierAppId = when (type) {
            ImResourceCardType.DOCUMENT -> "tabdoc"
            ImResourceCardType.TABLE -> "tabdata"
            else -> null
        },
        userId = userId,
        username = username,
        avatar = avatar,
        title = title,
        promptText = promptText,
        promptVersion = if (type == "prompt") 1 else null,
    )

    /** 缓存到乐观消息的原始 card JSON；保证失败重试不丢 payload。 */
    internal fun toMetadataPayload(): JsonObject = buildJsonObject {
        put("type", JsonPrimitive(type))
        resourceId?.let { put("resource_id", JsonPrimitive(it)) }
        userId?.let { put("user_id", JsonPrimitive(it)) }
        if (name.isNotEmpty()) put("name", JsonPrimitive(name))
        icon?.let { put("icon", JsonPrimitive(it)) }
        spaceId?.let { put("space_id", JsonPrimitive(it)) }
        organizationId?.let { put("organization_id", JsonPrimitive(it)) }
        username?.let { put("username", JsonPrimitive(it)) }
        avatar?.let { put("avatar", JsonPrimitive(it)) }
        promptText?.let { put("prompt_text", JsonPrimitive(it)) }
        title?.takeIf { it.isNotBlank() }?.let { put("title", JsonPrimitive(it)) }
        schemaVersion?.let { put("schema_version", JsonPrimitive(it)) }
        codexSessionId?.let { put("codex_session_id", JsonPrimitive(it)) }
        codexSessionName?.let { put("codex_session_name", JsonPrimitive(it)) }
        suggestedWorkingDirectory?.let { put("suggested_working_directory", JsonPrimitive(it)) }
    }

    /**
     * 发往服务端时只提交可寻址的最小字段。名称、头像、space 等由后端按当前权限重建权威快照，
     * 不信任客户端带来的展示字段，也不会把本地选择时的过期信息落库。
     */
    public fun requestPayload(): ImOutgoingCardRequest = when (type) {
        ImResourceCardType.SPACE, ImResourceCardType.AGENT_SPACE -> ImOutgoingCardRequest(
            type = type,
            spaceId = spaceId.orEmpty(),
        )
        ImResourceCardType.DOCUMENT, ImResourceCardType.TABLE -> ImOutgoingCardRequest(
            type = type,
            resourceId = resourceId.orEmpty(),
        )
        ImResourceCardType.CONTACT -> ImOutgoingCardRequest(
            type = type,
            userId = userId.orEmpty(),
        )
        "prompt" -> ImOutgoingCardRequest(
            type = type,
            promptText = promptText.orEmpty(),
            title = title?.trim()?.takeIf { it.isNotEmpty() },
        )
        ImResourceCardType.CODEX_SESSION -> ImOutgoingCardRequest(
            type = type,
            schemaVersion = schemaVersion,
            codexSessionId = codexSessionId,
            codexSessionName = codexSessionName,
            suggestedWorkingDirectory = suggestedWorkingDirectory,
        )
        else -> ImOutgoingCardRequest(type = type)
    }

    /** 旧端 / 搜索 / 会话预览仍可读的 text 回退内容。 */
    public val fallbackContent: String
        get() = when (type) {
            ImResourceCardType.SPACE, ImResourceCardType.AGENT_SPACE -> "[工作空间] $name"
            ImResourceCardType.DOCUMENT -> "[文档] $name"
            ImResourceCardType.TABLE -> "[表格] $name"
            ImResourceCardType.CONTACT -> "[名片] $name"
            "prompt" -> {
                val firstLine = promptText.orEmpty().lineSequence().map { it.trim() }
                    .firstOrNull { it.isNotEmpty() } ?: "指令"
                val label = title?.trim()?.takeIf { it.isNotEmpty() } ?: firstLine
                "[指令] ${label.take(60)}"
            }
            ImResourceCardType.CODEX_SESSION -> "[Codex 会话] ${codexSessionName ?: name}"
            else -> name
        }
}

/** 发送协议中的最小 card payload；与 Electron/iOS 同样只发送资源 id、用户 id 或指令正文。 */
@Serializable
public data class ImOutgoingCardRequest(
    val type: String,
    @SerialName("resource_id") val resourceId: String? = null,
    @SerialName("user_id") val userId: String? = null,
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("prompt_text") val promptText: String? = null,
    val title: String? = null,
    @SerialName("schema_version") val schemaVersion: Int? = null,
    @SerialName("codex_session_id") val codexSessionId: String? = null,
    @SerialName("codex_session_name") val codexSessionName: String? = null,
    @SerialName("suggested_working_directory") val suggestedWorkingDirectory: String? = null,
)

/** 已通过字段校验、可交给 Workbench 打开的资源卡目标。 */
internal data class ImResourceCardOpenTarget(
    val resourceType: String,
    val resourceId: String,
    val organizationId: String,
    val spaceId: String?,
)

/** 幂等创建/复用私信响应。 */
@Serializable
public data class ImCreateDMResult(
    @SerialName("conversation_id") val conversationId: String = "",
)

/**
 * 消息 metadata 中客户端使用的字段（幂等键、@ 列表、附件、资源卡）。
 *
 * card 不能直接声明成 [ImResourceCard]：后端 metadata 是自由 JSON，未知新卡、非对象 card 或
 * 内嵌字段异常都不能让整页历史解码失败。先收为原始 JSON，再按需安全投影为已支持的卡片。
 */
@Serializable
public data class ImMessageMetadata(
    @SerialName("client_request_id") val clientRequestId: String? = null,
    @SerialName("message_ref") val messageRef: String? = null,
    val kind: String? = null,
    @SerialName("tabtin_message_id") val tabtinMessageId: String? = null,
    @SerialName("agent_session_ref") val agentSessionRef: String? = null,
    @SerialName("mentioned_user_ids") val mentionedUserIds: List<String>? = null,
    @SerialName("mentioned_agent_ids") val mentionedAgentIds: List<String>? = null,
    @SerialName("mention_all") val mentionAll: Boolean? = null,
    @SerialName("file_id") val fileId: String? = null,
    @SerialName("file_name") val fileName: String? = null,
    @SerialName("file_size") val fileSize: Int? = null,
    @SerialName("file_type") val fileType: String? = null,
    @SerialName("download_url") val downloadUrl: String? = null,
    @SerialName("access_url") val accessUrl: String? = null,
    @SerialName("cdn_url") val cdnUrl: String? = null,
    val url: String? = null,
    @SerialName("forwarded_from") private val forwardedFromPayload: JsonElement? = null,
    @SerialName("card") val cardPayload: JsonElement? = null,
) {
    /** 单个来源字段损坏时只丢弃该字段；整个来源结构损坏时不影响其余 metadata。 */
    public val forwardedFrom: ImForwardedFrom?
        get() = forwardedFromPayload?.let { payload ->
            runCatching { json.decodeFromJsonElement(ImForwardedFrom.serializer(), payload) }.getOrNull()
        }

    /** metadata.card 曾出现过（包括未知 / 损坏卡）；编辑权限必须以它为准，而非仅看已识别类型。 */
    public val hasCardPayload: Boolean get() = cardPayload != null

    /** 只取 type 字段作安全能力边界（如 handoff / session_share 不可转发）。 */
    public val cardType: String?
        get() = ((cardPayload as? JsonObject)?.get("type") as? JsonPrimitive)?.contentOrNull

    /** 已支持且结构正确的 card；坏嵌套字段仅让当前卡降级，不影响消息列表。 */
    public val card: ImResourceCard?
        get() = (cardPayload as? JsonObject)?.let { payload ->
            runCatching { json.decodeFromJsonElement(ImResourceCard.serializer(), payload) }.getOrNull()
        }

    /** 任务共享卡独立解码；不能走资源卡模型，否则会被当未知卡降级。 */
    public val sessionShareCard: ImSessionShareCard?
        get() = (cardPayload as? JsonObject)?.takeIf { cardType == ImResourceCardType.SESSION_SHARE }?.let { payload ->
            runCatching { json.decodeFromJsonElement(ImSessionShareCard.serializer(), payload) }
                .getOrNull()
                ?.takeIf { it.isValid }
        }

    /** 新任务协作卡只读取可信快照；未知 schema 或必需字段缺失时保守降级。 */
    public val sessionShareV2Card: ImSessionShareV2Card?
        get() = (cardPayload as? JsonObject)?.takeIf { cardType == ImResourceCardType.SESSION_SHARE_V2 }?.let { payload ->
            runCatching { json.decodeFromJsonElement(ImSessionShareV2Card.serializer(), payload) }
                .getOrNull()
                ?.validated()
        }

    /** 任务续接卡与共享卡共用最小消息快照，但业务详情和动作完全独立。 */
    public val sessionContinuationCard: ImSessionContinuationCard?
        get() = (cardPayload as? JsonObject)?.takeIf {
            cardType == ImResourceCardType.SESSION_CONTINUATION
        }?.let { payload ->
            runCatching { json.decodeFromJsonElement(ImSessionContinuationCard.serializer(), payload) }
                .getOrNull()
                ?.validated()
        }

    /** 交接卡只解析不可变定位快照；详情失败时仍保持结构化消息边界。 */
    public val handoffCard: ImHandoffCard?
        get() = (cardPayload as? JsonObject)?.takeIf {
            cardType == ImResourceCardType.HANDOFF
        }?.let { payload ->
            runCatching { json.decodeFromJsonElement(ImHandoffCard.serializer(), payload) }
                .getOrNull()
                ?.validated()
        }

    /** Codex 会话归档卡；移动端只承诺识别和安全下载，不声称支持本机 Codex 导入。 */
    public val codexSessionCard: ImCodexSessionCard?
        get() = (cardPayload as? JsonObject)?.takeIf {
            cardType == ImResourceCardType.CODEX_SESSION
        }?.let { payload ->
            val schemaVersion = (payload["schema_version"] as? JsonPrimitive)
                ?.contentOrNull?.toIntOrNull()
            val sessionId = (payload["codex_session_id"] as? JsonPrimitive)
                ?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
            val sessionName = (payload["codex_session_name"] as? JsonPrimitive)
                ?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
            if (schemaVersion != 1 || sessionId == null || sessionName == null) return@let null
            ImCodexSessionCard(
                sessionId = sessionId,
                sessionName = sessionName,
                suggestedWorkingDirectory = (payload["suggested_working_directory"] as? JsonPrimitive)
                    ?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() },
            )
        }

    /**
     * 兼容 IM / OSS 历史 payload 中曾出现的直链字段。
     *
     * 新链路仍首选按 message id 经后端换取短期 URL；但跨端热历史里如果 file_id 已失效或
     * 后端只保留了直链，接收端不能直接退化成破图。仅接受 http(s)，避免把本地路径/空串喂给图片加载器。
     */
    public val inlineAttachmentUrls: List<String>
        get() = listOf(downloadUrl, cdnUrl, accessUrl, url)
            .mapNotNull { it?.trim()?.takeIf(::isHttpUrl) }
            .distinct()
}

/** 附件临时下载信息，对齐后端 `.../messages/{id}/attachment-url`（预签，默认 1h TTL）。 */
@Serializable
public data class ImAttachmentUrl(
    @SerialName("download_url") val downloadUrl: String = "",
    @SerialName("file_name") val fileName: String = "",
    @SerialName("expires_in") val expiresIn: Int = 0,
    @SerialName("candidate_urls") val candidateUrls: List<String> = emptyList(),
) {
    public val displayUrls: List<String>
        get() = (listOf(downloadUrl) + candidateUrls)
            .map { it.trim() }
            .filter(::isHttpUrl)
            .distinct()
}

private fun isHttpUrl(value: String): Boolean =
    value.startsWith("https://", ignoreCase = true) || value.startsWith("http://", ignoreCase = true)

/**
 * 单条消息，对齐后端 `_serialize_message`。可变字段（content/isDeleted/editedAt/reactions/
 * readReceipt）在本地乐观/实时收敛时就地替换整条 [ImMessage]（data class copy）。
 */
@Serializable
public data class ImMessage(
    val id: Int = 0,
    val seq: Int = 0,
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("sender_id") val senderId: String = "",
    @SerialName("sender_type") val senderType: String = ImMemberType.USER,
    @SerialName("sender_name") val senderName: String = "",
    val content: String = "",
    @SerialName("message_type") val messageType: Int = ImMessageType.TEXT,
    @SerialName("reply_to_id") val replyToId: Int? = null,
    @SerialName("reply_to_preview") val replyToPreview: ImReplyPreview? = null,
    @SerialName("has_attachment") val hasAttachment: Boolean = false,
    val metadata: ImMessageMetadata? = null,
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("is_deleted") val isDeleted: Boolean = false,
    @SerialName("edited_at") val editedAt: String? = null,
    @SerialName("is_pinned") val isPinned: Boolean = false,
    val reactions: Map<String, List<String>> = emptyMap(),
    /** 本地展示顺序：对齐 Electron Object.entries，已有表情保持位置，新表情追加。 */
    @SerialName("reaction_order") val reactionOrder: List<String> = emptyList(),
    /** 本地内部字段：true 表示 reactions 是服务端权威快照，空 Map 也必须覆盖旧状态。 */
    @Transient val reactionStateKnown: Boolean = false,
    @SerialName("read_receipt") val readReceipt: ImReadReceipt? = null,
    /** 本地内部字段：true 表示当前 isPinned 来自置顶事件或已 enrich 的历史页，可覆盖 false。 */
    @Transient val pinStateKnown: Boolean = false,
) {
    public val isFromAgent: Boolean get() = senderType == ImMemberType.AGENT

    /** 有效附件 id（image/file 消息 + metadata.file_id 非空）。 */
    public val attachmentFileId: String?
        get() = metadata?.fileId?.takeIf { hasAttachment && it.isNotEmpty() }

    private val hasInlineAttachmentUrl: Boolean
        get() = metadata?.inlineAttachmentUrls?.isNotEmpty() == true

    public val isImageAttachment: Boolean
        get() = messageType == ImMessageType.IMAGE && (attachmentFileId != null || hasAttachment || hasInlineAttachmentUrl)
    public val isFileAttachment: Boolean
        get() = messageType == ImMessageType.FILE && (attachmentFileId != null || hasAttachment || hasInlineAttachmentUrl)
    public val attachmentFileName: String get() = metadata?.fileName ?: ""
    public val attachmentFileSize: Int? get() = metadata?.fileSize

    /** 附件换链使用 TabTin 消息表主键；传输游标不能直接访问 REST 消息端点。 */
    public val attachmentLookupMessageId: Int?
        get() = metadata?.tabtinMessageId?.toIntOrNull() ?: id.takeIf { it > 0 }

    /** 携带的资源卡（仅当 card.type 是移动端已支持的资源类型时返回）。 */
    public val resourceCard: ImResourceCard? get() = metadata?.card?.takeIf { it.isValidType }

    /** 携带的任务共享卡。 */
    public val sessionShareCard: ImSessionShareCard? get() = metadata?.sessionShareCard

    /** 携带的新任务协作卡消息快照。 */
    public val sessionShareV2Card: ImSessionShareV2Card? get() = metadata?.sessionShareV2Card

    /** 携带的冻结任务续接卡消息快照。 */
    public val sessionContinuationCard: ImSessionContinuationCard? get() = metadata?.sessionContinuationCard

    /** 携带的对话接力卡消息快照。 */
    public val handoffCard: ImHandoffCard? get() = metadata?.handoffCard

    public val resourceCardDisplayName: String?
        get() = resourceCard?.displayName(content)

    /** 携带的指令卡。 */
    public val promptCard: ImPromptCard? get() = metadata?.card?.promptCard

    public val codexSessionCard: ImCodexSessionCard? get() = metadata?.codexSessionCard

    /** 只从已识别字段重建可转发卡片，未知或损坏的自由 JSON 不跨会话复制。 */
    public val forwardableCard: ImOutgoingCard?
        get() {
            promptCard?.let { return ImOutgoingCard.prompt(it.promptText, it.title) }
            codexSessionCard?.let { return ImOutgoingCard.codexSession(it) }
            val card = resourceCard ?: return null
            return when (card.type) {
                ImResourceCardType.DOCUMENT, ImResourceCardType.TABLE -> {
                    val resourceId = card.resourceId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
                    ImOutgoingCard.resource(
                        type = card.type,
                        resourceId = resourceId,
                        name = card.displayName(content),
                        spaceId = card.spaceId,
                        organizationId = card.organizationId,
                    )
                }
                ImResourceCardType.CONTACT -> {
                    val userId = card.userId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
                    ImOutgoingCard.contact(
                        userId = userId,
                        name = card.displayName(content),
                        username = card.username,
                        avatar = card.avatar,
                    )
                }
                ImResourceCardType.SPACE, ImResourceCardType.AGENT_SPACE -> {
                    val spaceCard = card.spaceCard ?: return null
                    ImOutgoingCard.workspace(spaceCard)
                }
                else -> null
            }
        }

    /** 任意 metadata.card（未知或坏结构也包含）都不是可编辑的普通文本。 */
    public val hasStructuredCard: Boolean get() = metadata?.hasCardPayload == true

    /** 交接和任务共享卡的授权范围绑定原会话，不能把原 card metadata 转发到另一段会话。 */
    public val isForwardRestrictedCard: Boolean
        get() = metadata?.cardType == ImResourceCardType.HANDOFF ||
            metadata?.cardType == ImResourceCardType.SESSION_SHARE ||
            metadata?.cardType == ImResourceCardType.SESSION_SHARE_V2 ||
            metadata?.cardType == ImResourceCardType.SESSION_CONTINUATION

    /** 结构化卡只有能重建可信 payload 时才可转发，避免未知卡退化成普通文本。 */
    public val canForward: Boolean
        get() = !isForwardRestrictedCard && (!hasStructuredCard || forwardableCard != null)

    /** 已编辑（编辑时间戳非空且未撤回）。 */
    public val isEdited: Boolean get() = !isDeleted && !editedAt.isNullOrEmpty()

    /** 是否纯文本消息（编辑仅限没有任何 card payload 的文本）。 */
    public val isPlainText: Boolean
        get() = messageType == ImMessageType.TEXT && !hasStructuredCard && metadata?.kind != "tabtin_ref"
}

/** 消息发送回执；客户端据已知正文补齐乐观消息，随后由实时回声覆盖。 */
@Serializable
public data class ImSendMessageResult(
    val id: Int = 0,
    val seq: Int = 0,
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("created_at") val createdAt: String? = null,
    @SerialName("tabtin_message_id") val tabtinMessageId: String? = null,
)

/** 可 @ 的 Agent 摘要，对齐后端 `GET /im/agents/search`。 */
@Serializable
public data class ImAgentSummary(
    val id: String = "",
    val name: String = "",
    val avatar: String = "",
) {
    public val displayName: String get() = name.ifEmpty { "Agent" }
}

/** 团队频道消息升级为 Agent 会话后的导航与首发上下文。 */
@Serializable
public data class ImAgentTaskThreadResult(
    @SerialName("session_id") val sessionId: String,
    @SerialName("thread_id") val threadId: String? = null,
    @SerialName("space_id") val projectId: String,
    @SerialName("workspace_id") val workspaceId: String? = null,
    @SerialName("organization_id") val organizationId: String,
    val title: String = "",
    @SerialName("default_prompt") val defaultPrompt: String,
    @SerialName("source_message_ids") val sourceMessageIds: List<Int> = emptyList(),
)

/** 普通群中 Agent 与执行 Workspace 的传输无关绑定。 */
@Serializable
public data class ImConversationAgentBinding(
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String,
    @SerialName("workspace_name") val workspaceName: String = "",
    @SerialName("bound_by_user_id") val boundByUserId: String = "",
    @SerialName("bound_at") val boundAt: String? = null,
    @SerialName("can_rebind") val canRebind: Boolean = false,
    @SerialName("is_executable") val isExecutable: Boolean = false,
)

@Serializable
public data class ImConversationAgentBindingList(
    val items: List<ImConversationAgentBinding> = emptyList(),
)

/** 会话成员，对齐后端 `MemberOut`。 */
@Serializable
public data class ImMember(
    @SerialName("member_type") val memberType: String = ImMemberType.USER,
    @SerialName("user_id") val userId: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    /** 成员在该会话里的参与组织；跨组织同一自然人的会话身份不跨目录复用。 */
    @SerialName("participant_organization_id") val participantOrganizationId: String? = null,
    val nickname: String = "",
    val username: String = "",
    val avatar: String = "",
    val role: Int = 0,
    @SerialName("is_muted") val isMuted: Boolean = false,
    val pinned: Boolean = false,
    @SerialName("joined_at") val joinedAt: String? = null,
    @SerialName("owner_user_id") val ownerUserId: String? = null,
    @SerialName("owner_display_name") val ownerDisplayName: String = "",
    @SerialName("is_execution_online") val isExecutionOnline: Boolean? = null,
    @SerialName("is_external") val isExternal: Boolean = false,
    @SerialName("organization_name") val organizationName: String = "",
) {
    public val isAgent: Boolean
        get() = memberType == ImMemberType.AGENT ||
            (userId.isNullOrBlank() && !agentId.isNullOrBlank())
    public val displayName: String get() = nickname.ifEmpty { username }
}

/** 会话详情，对齐后端 `ConversationDetailOut`（含成员列表）。 */
@Serializable
public data class ImConversationDetail(
    val id: String = "",
    @SerialName("organization_id") val organizationId: String = "",
    @SerialName("space_id") val spaceId: String? = null,
    @SerialName("space_name") val spaceName: String = "",
    @SerialName("is_team_space_channel") val isTeamSpaceChannel: Boolean = false,
    @SerialName("is_external") val isExternal: Boolean = false,
    val type: Int = ImConversationType.DM,
    val name: String = "",
    @SerialName("avatar_url") val avatarUrl: String = "",
    @SerialName("member_count") val memberCount: Int = 0,
    @SerialName("is_archived") val isArchived: Boolean = false,
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    @SerialName("last_message_preview") val lastMessagePreview: String = "",
    @SerialName("created_by") val createdBy: String = "",
    @SerialName("created_at") val createdAt: String = "",
    val members: List<ImMember> = emptyList(),
    @SerialName("has_unread_mention") val hasUnreadMention: Boolean = false,
    @SerialName("participant_organization_id") val participantOrganizationId: String? = null,
    @SerialName("directory_scope_id") val directoryScopeId: String? = null,
    @SerialName("can_send") val canSend: Boolean = true,
    val labels: List<ImConversationLabel> = emptyList(),
) {
    public val isGroup: Boolean get() = type == ImConversationType.GROUP
    public val isDm: Boolean get() = type == ImConversationType.DM
    public val isRemovedMemberDirectMessage: Boolean get() = isDm && memberCount < 2
    public val directoryOrganizationId: String
        get() = if (isExternal) {
            sequenceOf(directoryScopeId, participantOrganizationId, organizationId)
                .mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }
                .firstOrNull()
                .orEmpty()
        } else {
            organizationId
        }
    public val canReceiveMessages: Boolean get() = canSend && !isRemovedMemberDirectMessage

    /** 已在会话内的 Agent id 集合（picker 据此判断是否需先入群）。 */
    public val agentMemberIds: Set<String>
        get() = members.mapNotNull { if (it.isAgent) it.agentId else null }.toSet()
}

public class ImConversationReadOnlyException : IllegalStateException("对方已不在组织，当前会话只读")

public fun isImConversationReadOnly(
    snapshot: ImConversation?,
    detail: ImConversationDetail?,
): Boolean = snapshot?.canReceiveMessages == false || detail?.canReceiveMessages == false

public fun imForwardTargets(
    conversations: List<ImConversation>,
    sourceConversationId: String,
    allowExternal: Boolean = false,
): List<ImConversation> = conversations.filter {
    it.id != sourceConversationId && it.canReceiveMessages && (allowExternal || !it.isExternal)
}
