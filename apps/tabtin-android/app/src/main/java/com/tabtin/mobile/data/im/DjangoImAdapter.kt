package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.model.AppError
import javax.inject.Inject
import javax.inject.Singleton

/**
 * 自建 IM 的移动端边界：Store 只依赖领域接口，HTTP 信封、路径和实时来源留在 Adapter 内。
 * Centrifugo 由页面已有连接统一投递给 Store，因此这里不再伪装 SDK listener。
 */
@Singleton
public class DjangoImAdapter @Inject constructor(
    private val api: ImApi,
) : ImMessageTransport, ImConversationDataPlane {
    private var changedListener: (() -> Unit)? = null

    override fun setConversationChangedListener(listener: (() -> Unit)?) {
        changedListener = listener
    }

    override suspend fun listConversations(organizationId: String): List<ImConversation> =
        api.listConversations(organizationId).unwrap()

    override suspend fun searchMessages(
        organizationId: String,
        query: String,
    ): List<ImMessageSearchResult> = api.searchMessages(organizationId, query).unwrap().groups.map { group ->
        ImMessageSearchResult(
            conversation = ImConversation(
                id = group.conversationId,
                organizationId = organizationId,
                type = group.conversationType,
                name = group.conversationName,
                avatarUrl = group.conversationAvatarUrl,
            ),
            matchedMessagePreview = group.messages.firstOrNull()?.content.orEmpty(),
            matchCount = group.matchCount,
        )
    }

    override suspend fun pinConversation(conversationId: String, pinned: Boolean) {
        val actual = api.setConversationPinned(
            conversationId,
            SetConversationPinnedBody(pinned),
        ).unwrap().pinned
        if (actual != pinned) throw AppError.RequestFailed("会话置顶状态未能同步，请重试")
        changedListener?.invoke()
    }

    override suspend fun setConversationMuted(conversationId: String, muted: Boolean) {
        val actual = api.setConversationMuted(
            conversationId,
            SetConversationMutedBody(muted),
        ).unwrap().muted
        if (actual != muted) throw AppError.RequestFailed("会话免打扰状态未能同步，请重试")
        changedListener?.invoke()
    }

    override suspend fun leaveConversation(conversationId: String) {
        api.leaveConversation(conversationId).requireSuccess()
        changedListener?.invoke()
    }

    override suspend fun markConversationRemoved(conversationId: String) {
        changedListener?.invoke()
    }

    override suspend fun clearSession() {
        changedListener = null
    }

    override suspend fun fetchMessages(conversationId: String, before: Int?, limit: Int): List<ImMessage> =
        api.getMessages(conversationId, before, limit).unwrap().map(ImMessage::asAuthoritativeDjangoSnapshot)

    override suspend fun fetchHistoryClearedSeq(conversationId: String): Int =
        api.historyState(conversationId).unwrap().historyClearedSeq

    override suspend fun fetchPinnedMessages(conversationId: String): List<ImMessage> =
        api.listPinnedMessages(conversationId).unwrap().map(ImMessage::asAuthoritativeDjangoSnapshot)

    override suspend fun pinMessage(conversationId: String, messageId: Int, pinned: Boolean) {
        if (pinned) api.pinMessage(conversationId, messageId).requireSuccess()
        else api.unpinMessage(conversationId, messageId).requireSuccess()
    }

    override suspend fun sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        clientRequestId: String,
    ): ImSendMessageResult = sendMessage(
        conversationId, content, messageType, replyToId, mentionedUserIds, mentionedAgentIds,
        mentionAll, attachment, null, clientRequestId,
    )

    override suspend fun sendMessage(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        card: ImOutgoingCard?,
        clientRequestId: String,
    ): ImSendMessageResult = send(
        conversationId = conversationId,
        content = content,
        messageType = messageType,
        replyToId = replyToId,
        mentionedUserIds = mentionedUserIds,
        mentionedAgentIds = mentionedAgentIds,
        mentionAll = mentionAll,
        attachment = attachment,
        card = card,
        forwardedFrom = null,
        clientRequestId = clientRequestId,
    )

    override suspend fun forwardMessage(
        targetConversationId: String,
        message: ImMessage,
        sourceConversationName: String,
        clientRequestId: String,
    ): ImSendMessageResult = send(
        conversationId = targetConversationId,
        content = message.content,
        messageType = message.messageType,
        replyToId = null,
        mentionedUserIds = emptyList(),
        mentionedAgentIds = emptyList(),
        mentionAll = false,
        attachment = message.metadata?.fileId?.let {
            ImOutgoingAttachment(
                fileId = it,
                fileName = message.metadata.fileName.orEmpty(),
                fileSize = message.metadata.fileSize?.toLong() ?: 0,
                fileType = message.metadata.fileType.orEmpty(),
            )
        },
        card = message.forwardableCard,
        forwardedFrom = ImForwardedFrom(
            originalMessageId = message.id,
            originalConversationId = message.conversationId,
            originalConversationName = sourceConversationName,
            originalSenderId = message.senderId,
            originalSenderName = message.senderName,
        ),
        clientRequestId = clientRequestId,
    )

    private suspend fun send(
        conversationId: String,
        content: String,
        messageType: Int,
        replyToId: Int?,
        mentionedUserIds: List<String>,
        mentionedAgentIds: List<String>,
        mentionAll: Boolean,
        attachment: ImOutgoingAttachment?,
        card: ImOutgoingCard?,
        forwardedFrom: ImForwardedFrom?,
        clientRequestId: String,
    ): ImSendMessageResult {
        val hasMetadata = mentionedUserIds.isNotEmpty() || mentionedAgentIds.isNotEmpty() || mentionAll ||
            attachment != null || card != null || forwardedFrom != null
        return api.sendMessage(
            conversationId,
            SendMessageBody(
                content = content,
                messageType = messageType,
                replyToId = replyToId,
                clientRequestId = clientRequestId,
                metadata = if (hasMetadata) SendMessageMetadata(
                    mentionedUserIds = mentionedUserIds.takeIf { it.isNotEmpty() },
                    mentionedAgentIds = mentionedAgentIds.takeIf { it.isNotEmpty() },
                    mentionAll = true.takeIf { mentionAll },
                    fileId = attachment?.fileId,
                    fileName = attachment?.fileName,
                    fileSize = attachment?.fileSize,
                    fileType = attachment?.fileType,
                    forwardedFrom = forwardedFrom,
                    card = card?.requestPayload(),
                ) else null,
            ),
        ).unwrap()
    }

    override suspend fun editMessage(conversationId: String, messageId: Int, content: String): ImMessage =
        api.editMessage(conversationId, messageId, EditMessageBody(content)).unwrap().asAuthoritativeDjangoSnapshot()

    override suspend fun recallMessage(conversationId: String, messageId: Int) {
        api.recallMessage(conversationId, messageId).requireSuccess()
    }

    override suspend fun addReaction(conversationId: String, messageId: Int, emoji: String) {
        api.addReaction(conversationId, messageId, ReactionBody(emoji)).requireSuccess()
    }

    override suspend fun removeReaction(conversationId: String, messageId: Int, emoji: String) {
        api.removeReaction(conversationId, messageId, emoji).requireSuccess()
    }

    override suspend fun markRead(conversationId: String, lastMessageId: Int) {
        api.markRead(conversationId, MarkReadBody(lastMessageId)).requireSuccess()
    }

    override suspend fun fetchReadReceipts(conversationId: String, messageId: Int): ImMessageReadReceipts =
        api.readReceipts(conversationId, messageId).unwrap()

    override suspend fun clearHistory(conversationId: String) {
        clearHistoryAndFetchWatermark(conversationId)
    }

    override suspend fun clearHistoryAndFetchWatermark(conversationId: String): Int =
        api.clearHistory(conversationId).unwrap().clearedSeq
}

private fun ImMessage.asAuthoritativeDjangoSnapshot(): ImMessage = copy(
    reactionStateKnown = true,
    pinStateKnown = true,
)
