package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.api.json
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject

/**
 * TabChat 实时事件（Centrifugo publication 解析结果）。
 *
 * 逐字段对齐后端 `IMOutboxService.enqueue` 的 payload 与 Electron `useCentrifugoClient.ts`。
 * 未识别 / 解析失败返回 [Unknown] 或 null，调用方据此丢弃脏包（不影响连接）。
 */
public sealed interface ImRealtimeEvent {
    /** `chat:{conv}` 新消息。 */
    public data class Message(val message: ImMessage) : ImRealtimeEvent
    /** `chat:{conv}` 消息被编辑（携带完整新消息）。 */
    public data class MessageEdited(val message: ImMessage) : ImRealtimeEvent
    /** `chat:{conv}` 消息被撤回（软删）。 */
    public data class MessageDeleted(val messageId: Int) : ImRealtimeEvent
    public data class MessagePinned(val message: ImMessage) : ImRealtimeEvent
    public data class MessageUnpinned(val messageId: Int) : ImRealtimeEvent
    /** `chat:{conv}` 表情回应增删（[added]=false 为移除）。 */
    public data class Reaction(
        val messageId: Int,
        val userId: String,
        val emoji: String,
        val added: Boolean,
    ) : ImRealtimeEvent
    /** `chat:{conv}` 已读回执：某用户已读到 [lastReadSeq]。 */
    public data class ReadReceipt(val payload: ImReadReceiptEvent) : ImRealtimeEvent
    /** `personal:{userId}` 未读更新（会话列表角标即时刷新）。 */
    public data class UnreadUpdate(val payload: ImUnreadUpdate) : ImRealtimeEvent
    /** `personal:{userId}` 新会话（如新建 DM），携带会话摘要（同列表项形状）。 */
    public data class ConversationNew(val conversation: ImConversation) : ImRealtimeEvent
    /** 最后一条消息被编辑或撤回；只刷新目录摘要，不增加未读。 */
    public data class ConversationPreviewUpdated(val payload: ImConversationPreviewUpdate) : ImRealtimeEvent
    /** 当前用户给某会话贴/撕标签后的权威快照。 */
    public data class ConversationLabelsUpdated(val payload: ImConversationLabelsUpdatedEvent) : ImRealtimeEvent
    /** 共享会话参与者资料变化；私聊目录就地更新，活动群详情按版本重拉。 */
    public data class UserProfileUpdated(val profile: ImUserProfileUpdated) : ImRealtimeEvent
    /** 会话资料或成员变化；调用方重拉详情与目录。 */
    public data object ConversationChanged : ImRealtimeEvent
    /** `chat:{conv}` 对端正在输入。 */
    public data class Typing(val userId: String) : ImRealtimeEvent
    public data class HandoffUpdate(val handoffId: String) : ImRealtimeEvent
    public data class SessionShareUpdate(val shareId: String) : ImRealtimeEvent
    public data class AgentMessageStream(val payload: ImAgentMessageStreamEvent) : ImRealtimeEvent
    public data class AgentMessageFinal(val payload: ImAgentMessageFinalEvent) : ImRealtimeEvent
    public data class AgentMessageError(val payload: ImAgentMessageErrorEvent) : ImRealtimeEvent
    public data class AiError(val agentName: String, val reason: String) : ImRealtimeEvent
    public data class AiSuggestTask(
        val conversationId: String?,
        val messageId: Int?,
        val agentName: String,
    ) : ImRealtimeEvent
    /** 本期未处理的事件类型（保留 type 便于日志/扩展）。 */
    public data class Unknown(val type: String) : ImRealtimeEvent
}

@Serializable
public data class ImAgentMessageStreamEvent(
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("message_ref") val messageRef: String,
    @SerialName("agent_session_ref") val agentSessionRef: String,
    @SerialName("sender_id") val senderId: String,
    @SerialName("sender_name") val senderName: String = "",
    @SerialName("sender_avatar") val senderAvatar: String = "",
    val delta: String,
    @SerialName("stream_seq") val streamSeq: Int,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
public data class ImAgentMessageFinalEvent(
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("message_ref") val messageRef: String,
    @SerialName("agent_session_ref") val agentSessionRef: String,
    @SerialName("sender_id") val senderId: String,
    @SerialName("sender_name") val senderName: String = "",
    @SerialName("sender_avatar") val senderAvatar: String = "",
    val content: String = "",
    @SerialName("message_type") val messageType: Int = ImMessageType.TEXT,
    val metadata: ImMessageMetadata? = null,
    @SerialName("created_at") val createdAt: String? = null,
)

@Serializable
public data class ImAgentMessageErrorEvent(
    @SerialName("conversation_id") val conversationId: String,
    @SerialName("message_ref") val messageRef: String,
    @SerialName("agent_session_ref") val agentSessionRef: String,
    @SerialName("sender_id") val senderId: String,
    @SerialName("sender_name") val senderName: String = "",
    @SerialName("sender_avatar") val senderAvatar: String = "",
)

/** `im.read.receipt` 负载。 */
@Serializable
public data class ImReadReceiptEvent(
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("user_id") val userId: String = "",
    @SerialName("last_read_message_id") val lastReadMessageId: Int? = null,
    @SerialName("last_read_seq") val lastReadSeq: Int = 0,
)

/** `im.reaction.added` / `im.reaction.removed` 负载。 */
@Serializable
public data class ImReactionEvent(
    @SerialName("message_id") val messageId: Int = 0,
    @SerialName("user_id") val userId: String = "",
    val emoji: String = "",
)

/** `im.message.deleted` 负载。 */
@Serializable
public data class ImMessageDeletedEvent(
    @SerialName("message_id") val messageId: Int = 0,
)

@Serializable
private data class ImHandoffUpdateEvent(
    @SerialName("handoff_id") val handoffId: String = "",
)

@Serializable
private data class ImSessionShareUpdateEvent(
    @SerialName("share_id") val shareId: String = "",
)

@Serializable
private data class ImAiErrorEvent(
    @SerialName("agent_name") val agentName: String = "",
    val reason: String = "",
)

@Serializable
private data class ImAiSuggestTaskEvent(
    @SerialName("conversation_id") val conversationId: String? = null,
    @SerialName("message_id") val messageId: Int? = null,
    @SerialName("agent_name") val agentName: String = "",
)

/**
 * `im.unread.update` 负载：两种形状共用同一 type——
 * 1) 新消息：带 `message_id` / `preview` 等（personal_base + mention）；
 * 2) 已读回写：带 `marked_read` / `last_read_seq`（本人 mark_as_read 后回推给自己）。
 */
@Serializable
public data class ImUnreadUpdate(
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("organization_id") val organizationId: String = "",
    @SerialName("directory_scope_id") val directoryScopeId: String? = null,
    @SerialName("message_id") val messageId: Int = 0,
    @SerialName("message_seq") val messageSeq: Int = 0,
    @SerialName("sender_id") val senderId: String = "",
    @SerialName("sender_name") val senderName: String = "",
    val preview: String = "",
    @SerialName("last_message_at") val lastMessageAt: String? = null,
    val mention: Boolean = false,
    /** 非 null 表示这是「已读回写」事件（应把该会话未读清零），与新消息事件互斥。 */
    @SerialName("marked_read") val markedRead: Int? = null,
) {
    public val isMarkedReadEvent: Boolean get() = markedRead != null
}

@Serializable
public data class ImConversationLabelsUpdatedEvent(
    @SerialName("conversation_id") val conversationId: String = "",
    val labels: List<ImConversationLabel> = emptyList(),
)

@Serializable
public data class ImConversationPreviewUpdate(
    @SerialName("conversation_id") val conversationId: String = "",
    @SerialName("organization_id") val organizationId: String = "",
    @SerialName("directory_scope_id") val directoryScopeId: String? = null,
    @SerialName("message_id") val messageId: Int = 0,
    @SerialName("message_seq") val messageSeq: Int = 0,
    val preview: String = "",
    @SerialName("last_message_at") val lastMessageAt: String? = null,
)

/** `im.user.profile.updated` 负载。 */
@Serializable
public data class ImUserProfileUpdated(
    @SerialName("id") val userId: String = "",
    val nickname: String = "",
    val username: String = "",
    val avatar: String = "",
    @SerialName("avatar_version") val avatarVersion: String = "",
    val revision: Int = 0,
) {
    public val displayName: String
        get() = nickname.trim().ifEmpty { username.trim() }
}

/**
 * Centrifugo publication 原始字节 → 类型化事件。
 *
 * 外层信封形如 `{ "type": "im.*", "event_id": "...", "data": {...} }`；`im.typing` 例外，
 * 字段直接铺在顶层：`{ "type": "im.typing", "user_id": "..." }`。
 */
public object ImEventDecoder {

    public fun decode(raw: ByteArray): ImRealtimeEvent? =
        decode(raw.toString(Charsets.UTF_8))

    public fun decode(text: String): ImRealtimeEvent? {
        val root: JsonObject = runCatching { json.parseToJsonElement(text).jsonObject }
            .getOrNull() ?: return null
        val type = (root["type"] as? JsonPrimitive)
            ?.takeIf { it.isString }
            ?.contentOrNull ?: return null
        return when (type) {
            "im.message" -> root.decodeData<ImMessage>()?.let { ImRealtimeEvent.Message(it) }
            "im.message.edited" -> root.decodeData<ImMessage>()?.let { ImRealtimeEvent.MessageEdited(it) }
            "im.message.deleted" ->
                root.decodeData<ImMessageDeletedEvent>()?.let { ImRealtimeEvent.MessageDeleted(it.messageId) }
            "im.message.pinned" -> root.decodeData<ImMessage>()?.let { ImRealtimeEvent.MessagePinned(it) }
            "im.message.unpinned" ->
                root.decodeData<ImMessageDeletedEvent>()?.let { ImRealtimeEvent.MessageUnpinned(it.messageId) }
            "im.reaction.added", "im.reaction.removed" ->
                root.decodeData<ImReactionEvent>()?.let {
                    ImRealtimeEvent.Reaction(
                        messageId = it.messageId,
                        userId = it.userId,
                        emoji = it.emoji,
                        added = type == "im.reaction.added",
                    )
                }
            "im.read.receipt" -> root.decodeData<ImReadReceiptEvent>()?.let { ImRealtimeEvent.ReadReceipt(it) }
            "im.unread.update" -> root.decodeData<ImUnreadUpdate>()?.let { ImRealtimeEvent.UnreadUpdate(it) }
            "im.conversation.new" -> root.decodeData<ImConversation>()?.let { ImRealtimeEvent.ConversationNew(it) }
            "im.conversation.preview.updated" -> root.decodeData<ImConversationPreviewUpdate>()
                ?.let { ImRealtimeEvent.ConversationPreviewUpdated(it) }
            "im.conversation.labels.updated" -> root.decodeData<ImConversationLabelsUpdatedEvent>()
                ?.let { ImRealtimeEvent.ConversationLabelsUpdated(it) }
            "im.user.profile.updated" -> root.decodeData<ImUserProfileUpdated>()
                ?.let { ImRealtimeEvent.UserProfileUpdated(it) }
            "im.conversation.updated", "im.member.joined", "im.member.left" ->
                ImRealtimeEvent.ConversationChanged
            // typing 顶层平铺（无 data 信封）。
            "im.typing" -> {
                val userId = (root["user_id"] as? JsonPrimitive)
                    ?.takeIf { it.isString }
                    ?.contentOrNull ?: return null
                ImRealtimeEvent.Typing(userId)
            }
            "im.handoff.update" -> root.decodeData<ImHandoffUpdateEvent>()
                ?.takeIf { it.handoffId.isNotBlank() }
                ?.let { ImRealtimeEvent.HandoffUpdate(it.handoffId) }
            "im.session_share.update" -> root.decodeData<ImSessionShareUpdateEvent>()
                ?.takeIf { it.shareId.isNotBlank() }
                ?.let { ImRealtimeEvent.SessionShareUpdate(it.shareId) }
            "im.agent.message.stream" -> root.decodeData<ImAgentMessageStreamEvent>()
                ?.let { ImRealtimeEvent.AgentMessageStream(it) }
            "im.agent.message.final" -> root.decodeData<ImAgentMessageFinalEvent>()
                ?.let { ImRealtimeEvent.AgentMessageFinal(it) }
            "im.agent.message.error" -> root.decodeData<ImAgentMessageErrorEvent>()
                ?.let { ImRealtimeEvent.AgentMessageError(it) }
            "im.ai.error" -> root.decodeData<ImAiErrorEvent>()
                ?.let { ImRealtimeEvent.AiError(it.agentName, it.reason) }
            "im.ai.suggest_task" -> root.decodeData<ImAiSuggestTaskEvent>()
                ?.let { ImRealtimeEvent.AiSuggestTask(it.conversationId, it.messageId, it.agentName) }
            else -> ImRealtimeEvent.Unknown(type)
        }
    }

    /** 从信封的 `data` 子对象解码为 [T]；缺 `data` 或类型异常返回 null（丢弃脏包）。 */
    private inline fun <reified T> JsonObject.decodeData(): T? {
        val data: JsonElement = this["data"] ?: return null
        return runCatching { json.decodeFromJsonElement<T>(data) }.getOrNull()
    }
}
