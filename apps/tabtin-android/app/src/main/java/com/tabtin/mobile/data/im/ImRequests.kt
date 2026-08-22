package com.tabtin.mobile.data.im

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** 与 Electron 共用的转发来源标记；由服务端校验后随消息保存。 */
@Serializable(with = ImForwardedFromSerializer::class)
public data class ImForwardedFrom(
    @SerialName("original_message_id") val originalMessageId: Int? = null,
    @SerialName("original_conversation_id") val originalConversationId: String? = null,
    @SerialName("original_conversation_name") val originalConversationName: String? = null,
    @SerialName("original_sender_id") val originalSenderId: String? = null,
    @SerialName("original_sender_name") val originalSenderName: String? = null,
)

public object ImForwardedFromSerializer : KSerializer<ImForwardedFrom> {
    override val descriptor: SerialDescriptor =
        kotlinx.serialization.json.JsonObject.serializer().descriptor

    override fun deserialize(decoder: Decoder): ImForwardedFrom {
        val jsonDecoder = decoder as? JsonDecoder ?: error("ImForwardedFrom requires JSON")
        val value = jsonDecoder.decodeJsonElement().jsonObject
        fun string(key: String): String? = runCatching {
            value[key]?.jsonPrimitive?.contentOrNull
        }.getOrNull()
        val messageId = runCatching {
            value["original_message_id"]?.jsonPrimitive?.let { it.intOrNull ?: it.contentOrNull?.toIntOrNull() }
        }.getOrNull()
        return ImForwardedFrom(
            originalMessageId = messageId,
            originalConversationId = string("original_conversation_id"),
            originalConversationName = string("original_conversation_name"),
            originalSenderId = string("original_sender_id"),
            originalSenderName = string("original_sender_name"),
        )
    }

    override fun serialize(encoder: Encoder, value: ImForwardedFrom) {
        val jsonEncoder = encoder as? JsonEncoder ?: error("ImForwardedFrom requires JSON")
        jsonEncoder.encodeJsonElement(buildJsonObject {
            value.originalMessageId?.let { put("original_message_id", it) }
            value.originalConversationId?.let { put("original_conversation_id", it) }
            value.originalConversationName?.let { put("original_conversation_name", it) }
            value.originalSenderId?.let { put("original_sender_id", it) }
            value.originalSenderName?.let { put("original_sender_name", it) }
        })
    }
}

@Serializable
public data class ImOutgoingAttachment(
    val fileId: String,
    val fileName: String,
    val fileSize: Long,
    val fileType: String,
    val remoteUrl: String? = null,
)

@Serializable
public data class BindConversationAgentBody(
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String,
)

@Serializable
public data class UpdateConversationAgentBindingBody(
    @SerialName("workspace_id") val workspaceId: String,
)

@Serializable
public data class AddMembersBody(
    @SerialName("member_ids") val memberIds: List<String> = emptyList(),
    @SerialName("external_contact_ids") val externalContactIds: List<String> = emptyList(),
)

@Serializable
public data class AddExternalMembersBody(
    @SerialName("external_contact_ids") val externalContactIds: List<String>,
)

@Serializable
public data class CreateDMBody(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("other_user_id") val otherUserId: String = "",
    @SerialName("external_contact_id") val externalContactId: String = "",
)

@Serializable
public data class CreateExternalDMBody(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("external_contact_id") val externalContactId: String,
)

/** 创建群聊；成员列表不含当前用户，服务端会自动将创建者加入。 */
@Serializable
public data class CreateGroupBody(
    @SerialName("organization_id") val organizationId: String,
    val name: String,
    @SerialName("member_ids") val memberIds: List<String>,
    @SerialName("client_request_id") val clientRequestId: String,
    @SerialName("external_contact_ids") val externalContactIds: List<String> = emptyList(),
)

@Serializable
public data class CreateExternalGroupBody(
    @SerialName("organization_id") val organizationId: String,
    val name: String,
    @SerialName("member_ids") val memberIds: List<String>,
    @SerialName("client_request_id") val clientRequestId: String,
    @SerialName("external_contact_ids") val externalContactIds: List<String>,
)

@Serializable
public data class UpdateConversationBody(
    val name: String? = null,
    @SerialName("avatar_url") val avatarUrl: String? = null,
)

@Serializable
public data class SetConversationPinnedBody(
    val pinned: Boolean,
)

@Serializable
public data class SetConversationMutedBody(
    val muted: Boolean,
)

@Serializable
public data class SendMessageBody(
    val content: String,
    @SerialName("message_type") val messageType: Int,
    @SerialName("reply_to_id") val replyToId: Int? = null,
    val metadata: SendMessageMetadata? = null,
    @SerialName("client_request_id") val clientRequestId: String,
)

/** Transport-neutral message metadata accepted by the Django IM contract. */
@Serializable
public data class SendMessageMetadata(
    @SerialName("mentioned_user_ids") val mentionedUserIds: List<String>? = null,
    @SerialName("mentioned_agent_ids") val mentionedAgentIds: List<String>? = null,
    @SerialName("mention_all") val mentionAll: Boolean? = null,
    @SerialName("file_id") val fileId: String? = null,
    @SerialName("file_name") val fileName: String? = null,
    @SerialName("file_size") val fileSize: Long? = null,
    @SerialName("file_type") val fileType: String? = null,
    @SerialName("forwarded_from") val forwardedFrom: ImForwardedFrom? = null,
    val card: ImOutgoingCardRequest? = null,
)

@Serializable
public data class EditMessageBody(
    val content: String,
)

@Serializable
public data class CreateAgentTaskFromMessageBody(
    @SerialName("agent_id") val agentId: String,
    @SerialName("additional_context") val additionalContext: String = "",
)

@Serializable
public data class ReactionBody(
    val emoji: String,
)

@Serializable
public data class MarkReadBody(
    @SerialName("last_message_id") val lastMessageId: Int?,
)

@Serializable
public data class DiscoverExternalContactBody(
    @SerialName("organization_id") val organizationId: String,
    val phone: String,
)

@Serializable
public data class IssueContactInvitationBody(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("target_user_id") val targetUserId: String,
    val note: String? = null,
)

@Serializable
public data class AcceptExternalContactBody(
    @SerialName("organization_id") val organizationId: String,
    @SerialName("invite_code") val invitationId: String,
)

@Serializable
public data class UpdateContactInvitationBody(
    @SerialName("organization_id") val organizationId: String,
    val action: String,
)

@Serializable
public data class UpdateExternalContactBody(
    @SerialName("organization_id") val organizationId: String,
    val action: String,
)

@Serializable
public data class CreateConversationLabelBody(
    @SerialName("organization_id") val organizationId: String,
    val name: String,
    val color: String = "#6b7280",
)

@Serializable
public data class UpdateConversationLabelBody(
    val name: String? = null,
    val color: String? = null,
)

@Serializable
public data class AddConversationLabelsBody(
    @SerialName("label_ids") val labelIds: List<String>,
)
