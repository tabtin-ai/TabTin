package com.tabtin.mobile.data.im

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.ChatSession
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

/**
 * TabChat IM（`/api/im/…`）REST 接口，对齐 iOS `Core/IM/IMEndpoints.swift` 与后端
 * `apps/tabtin_django/apps/tabchat/api.py`（router 前缀 `/im`；Retrofit baseUrl 已含 `/api/`）。
 *
 * 列表类端点后端把数据裸放在 envelope 的 `data` 数组里（非包一层对象），故用
 * `ApiEnvelope<List<...>>`；无返回体的端点用 `ApiEnvelope<JsonObject>`（只校验 success）。
 */
public interface ImApi {

    @POST("im/conversations/dm")
    public suspend fun createDM(@Body body: CreateDMBody): ApiEnvelope<ImCreateDMResult>

    @POST("im/conversations/group")
    public suspend fun createGroup(@Body body: CreateGroupBody): ApiEnvelope<ImCreateDMResult>

    @GET("im/conversations")
    public suspend fun listConversations(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<List<ImConversation>>

    @GET("im/labels")
    public suspend fun listLabels(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<List<ImConversationLabel>>

    @POST("im/labels")
    public suspend fun createLabel(
        @Body body: CreateConversationLabelBody,
    ): ApiEnvelope<ImConversationLabel>

    @PATCH("im/labels/{labelId}")
    public suspend fun updateLabel(
        @Path("labelId") labelId: String,
        @Body body: UpdateConversationLabelBody,
    ): ApiEnvelope<ImConversationLabel>

    @DELETE("im/labels/{labelId}")
    public suspend fun deleteLabel(
        @Path("labelId") labelId: String,
    ): ApiEnvelope<JsonObject>

    @GET("im/conversations/{conversationId}/labels")
    public suspend fun getConversationLabels(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<List<ImConversationLabel>>

    @POST("im/conversations/{conversationId}/labels")
    public suspend fun addConversationLabels(
        @Path("conversationId") conversationId: String,
        @Body body: AddConversationLabelsBody,
    ): ApiEnvelope<ImConversationLabelsResult>

    @DELETE("im/conversations/{conversationId}/labels/{labelId}")
    public suspend fun removeConversationLabel(
        @Path("conversationId") conversationId: String,
        @Path("labelId") labelId: String,
    ): ApiEnvelope<ImConversationLabelsResult>

    @GET("im/external-contacts")
    public suspend fun listExternalContacts(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<ExternalContactListResponse>

    @POST("im/external-contacts/discover")
    public suspend fun discoverExternalContact(
        @Body body: DiscoverExternalContactBody,
    ): ApiEnvelope<ExternalContactCandidate>

    @POST("im/external-contact-invitations")
    public suspend fun issueContactInvitation(
        @Body body: IssueContactInvitationBody,
    ): ApiEnvelope<ContactInvitationCreateResult>

    @GET("im/external-contact-invitations")
    public suspend fun listContactInvitations(
        @Query("organization_id") organizationId: String,
        @Query("direction") direction: String? = null,
        @Query("status") status: String? = null,
    ): ApiEnvelope<ContactInvitationListResponse>

    @POST("im/external-contacts/accept")
    public suspend fun acceptExternalContact(
        @Body body: AcceptExternalContactBody,
    ): ApiEnvelope<ExternalContact>

    @PATCH("im/external-contact-invitations/{invitationId}")
    public suspend fun updateContactInvitation(
        @Path("invitationId") invitationId: String,
        @Body body: UpdateContactInvitationBody,
    ): ApiEnvelope<ContactInvitation>

    @PATCH("im/external-contacts/{contactId}")
    public suspend fun updateExternalContact(
        @Path("contactId") contactId: String,
        @Body body: UpdateExternalContactBody,
    ): ApiEnvelope<ExternalContact>

    @GET("im/conversations/{conversationId}")
    public suspend fun getConversationDetail(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<ImConversationDetail>

    @PATCH("im/conversations/{conversationId}")
    public suspend fun updateConversation(
        @Path("conversationId") conversationId: String,
        @Body body: UpdateConversationBody,
    ): ApiEnvelope<JsonObject>

    @POST("im/conversations/{conversationId}/members")
    public suspend fun addMembers(
        @Path("conversationId") conversationId: String,
        @Body body: AddMembersBody,
    ): ApiEnvelope<ImAddMembersResult>

    @DELETE("im/conversations/{conversationId}/members/{userId}")
    public suspend fun removeMember(
        @Path("conversationId") conversationId: String,
        @Path("userId") userId: String,
    ): ApiEnvelope<JsonObject>

    @DELETE("im/conversations/{conversationId}/agents/{agentId}")
    public suspend fun removeAgent(
        @Path("conversationId") conversationId: String,
        @Path("agentId") agentId: String,
    ): ApiEnvelope<JsonObject>

    @GET("im/conversations/{conversationId}/agent-bindings")
    public suspend fun listAgentBindings(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<ImConversationAgentBindingList>

    @POST("im/conversations/{conversationId}/agent-bindings")
    public suspend fun bindAgent(
        @Path("conversationId") conversationId: String,
        @Body body: BindConversationAgentBody,
    ): ApiEnvelope<ImConversationAgentBinding>

    @PATCH("im/conversations/{conversationId}/agent-bindings/{agentId}")
    public suspend fun updateAgentBinding(
        @Path("conversationId") conversationId: String,
        @Path("agentId") agentId: String,
        @Body body: UpdateConversationAgentBindingBody,
    ): ApiEnvelope<ImConversationAgentBinding>

    @DELETE("im/conversations/{conversationId}/agent-bindings/{agentId}")
    public suspend fun deleteAgentBinding(
        @Path("conversationId") conversationId: String,
        @Path("agentId") agentId: String,
    ): ApiEnvelope<JsonObject>

    @GET("im/conversations/{conversationId}/messages")
    public suspend fun getMessages(
        @Path("conversationId") conversationId: String,
        @Query("before") before: Int? = null,
        @Query("limit") limit: Int = 30,
    ): ApiEnvelope<List<ImMessage>>

    @POST("im/conversations/{conversationId}/messages")
    public suspend fun sendMessage(
        @Path("conversationId") conversationId: String,
        @Body body: SendMessageBody,
    ): ApiEnvelope<ImSendMessageResult>

    @POST("im/conversations/{conversationId}/messages/{messageId}/agent-task")
    public suspend fun createAgentTaskFromMessage(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
        @Body body: CreateAgentTaskFromMessageBody,
    ): ApiEnvelope<ImAgentTaskThreadResult>

    @PATCH("im/conversations/{conversationId}/messages/{messageId}")
    public suspend fun editMessage(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
        @Body body: EditMessageBody,
    ): ApiEnvelope<ImMessage>

    @DELETE("im/conversations/{conversationId}/messages/{messageId}")
    public suspend fun recallMessage(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
    ): ApiEnvelope<JsonObject>

    @POST("im/conversations/{conversationId}/messages/{messageId}/reactions")
    public suspend fun addReaction(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
        @Body body: ReactionBody,
    ): ApiEnvelope<JsonObject>

    @DELETE("im/conversations/{conversationId}/messages/{messageId}/reactions")
    public suspend fun removeReaction(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
        @Query("emoji") emoji: String,
    ): ApiEnvelope<JsonObject>

    @GET("im/conversations/{conversationId}/pinned-messages")
    public suspend fun listPinnedMessages(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<List<ImMessage>>

    @POST("im/conversations/{conversationId}/messages/{messageId}/pin")
    public suspend fun pinMessage(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
    ): ApiEnvelope<ImMessage>

    @DELETE("im/conversations/{conversationId}/messages/{messageId}/pin")
    public suspend fun unpinMessage(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
    ): ApiEnvelope<JsonObject>

    @GET("im/conversations/{conversationId}/messages/{messageId}/read-receipts")
    public suspend fun readReceipts(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
    ): ApiEnvelope<ImMessageReadReceipts>

    @POST("im/conversations/{conversationId}/read")
    public suspend fun markRead(
        @Path("conversationId") conversationId: String,
        @Body body: MarkReadBody,
    ): ApiEnvelope<JsonObject>

    @GET("im/conversations/{conversationId}/history-state")
    public suspend fun historyState(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<ImHistoryState>

    @POST("im/conversations/{conversationId}/clear-history")
    public suspend fun clearHistory(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<ImClearHistoryResult>

    @POST("im/conversations/{conversationId}/leave")
    public suspend fun leaveConversation(
        @Path("conversationId") conversationId: String,
    ): ApiEnvelope<JsonObject>

    @POST("im/conversations/{conversationId}/pin")
    public suspend fun setConversationPinned(
        @Path("conversationId") conversationId: String,
        @Body body: SetConversationPinnedBody,
    ): ApiEnvelope<ImConversationPinResult>

    @POST("im/conversations/{conversationId}/mute")
    public suspend fun setConversationMuted(
        @Path("conversationId") conversationId: String,
        @Body body: SetConversationMutedBody,
    ): ApiEnvelope<ImConversationMuteResult>

    @GET("im/search/grouped")
    public suspend fun searchMessages(
        @Query("organization_id") organizationId: String,
        @Query("q") query: String,
        @Query("group_offset") groupOffset: Int = 0,
        @Query("group_limit") groupLimit: Int = 20,
        @Query("per_group_limit") perGroupLimit: Int = 3,
    ): ApiEnvelope<DjangoImGroupedSearchResult>

    /**
     * 将 Agent 会话以 IM 卡片共享给一个组织成员。
     *
     * 这不是把对方加入原会话：接收者只能查看，或按授权从原会话创建副本。
     * 任务共享授权与 PC 共用 conversation 域主链路，不再调用废弃的 Django IM 编排。
     */
    @POST("chat/session-shares")
    public suspend fun shareChatSession(
        @Body body: ImSessionShareRequest,
    ): ApiEnvelope<ImSessionShareResponse>

    @GET("chat/session-shares/{shareId}")
    public suspend fun getSessionShare(
        @Path("shareId") shareId: String,
    ): ApiEnvelope<ImSessionShareResponse>

    @GET("chat/session-shares")
    public suspend fun listIncomingSessionShares(
        @Query("organization_id") organizationId: String,
        @Query("direction") direction: String = "incoming",
    ): ApiEnvelope<ImSessionShareListResponse>

    @POST("chat/session-shares/{shareId}/revoke")
    public suspend fun revokeSessionShare(
        @Path("shareId") shareId: String,
    ): ApiEnvelope<ImSessionShareResponse>

    @POST("chat/session-shares/batch-get")
    public suspend fun batchGetSessionShareV2(
        @Body body: ImSessionShareV2BatchRequest,
    ): ApiEnvelope<ImSessionShareV2BatchResponse>

    @POST("chat/session-shares/{shareId}/accept")
    public suspend fun acceptSessionShareV2(
        @Path("shareId") shareId: String,
    ): ApiEnvelope<ImSessionShareV2Detail>

    @POST("chat/session-shares/{shareId}/delivery/retry")
    public suspend fun retrySessionShareV2Delivery(
        @Path("shareId") shareId: String,
    ): ApiEnvelope<ImSessionShareV2Detail>

    @POST("chat/session-continuations")
    public suspend fun createSessionContinuation(
        @Body body: ImSessionContinuationCreateRequest,
    ): ApiEnvelope<ImSessionContinuationDetail>

    @POST("chat/session-continuations/batch-get")
    public suspend fun batchGetSessionContinuations(
        @Body body: ImSessionContinuationBatchRequest,
    ): ApiEnvelope<ImSessionContinuationBatchResponse>

    @POST("chat/session-continuations/{objectId}/create-task")
    public suspend fun createTaskFromSessionContinuation(
        @Path("objectId") objectId: String,
        @Body body: ImSessionContinuationCreateTaskRequest,
    ): ApiEnvelope<ImSessionContinuationDetail>

    @POST("im/handoffs")
    public suspend fun createHandoff(
        @Body body: ImHandoffCreateRequest,
    ): ApiEnvelope<ImHandoffPackage>

    @GET("im/handoffs/{handoffId}")
    public suspend fun getHandoff(
        @Path("handoffId") handoffId: String,
    ): ApiEnvelope<ImHandoffPackage>

    @POST("im/handoffs/{handoffId}/actions")
    public suspend fun actOnHandoff(
        @Path("handoffId") handoffId: String,
        @Body body: ImHandoffActionRequest,
    ): ApiEnvelope<ImHandoffPackage>

    @POST("im/handoffs/{handoffId}/revoke")
    public suspend fun revokeHandoff(
        @Path("handoffId") handoffId: String,
    ): ApiEnvelope<ImHandoffPackage>

    @POST("im/handoffs/{handoffId}/take-over-session")
    public suspend fun takeOverHandoff(
        @Path("handoffId") handoffId: String,
        @Body body: ImHandoffTakeOverRequest,
    ): ApiEnvelope<ChatSession>

    @GET("im/resource-card-preview")
    public suspend fun getResourceCardPreview(
        @Query("card_type") cardType: String,
        @Query("resource_id") resourceId: String,
    ): ApiEnvelope<ImResourceCardPreview>

    @POST("im/resource-access-requests")
    public suspend fun createResourceAccessRequest(
        @Body body: ImResourceAccessRequestBody,
    ): ApiEnvelope<ImResourceAccessRequestResponse>

    @POST("im/resource-access-requests/{requestId}/approve")
    public suspend fun approveResourceAccessRequest(
        @Path("requestId") requestId: String,
    ): ApiEnvelope<ImResourceAccessRequestResponse>

    @GET("im/agents/search")
    public suspend fun searchAgents(
        @Query("organization_id") organizationId: String,
        @Query("q") query: String? = null,
    ): ApiEnvelope<List<ImAgentSummary>>

    @GET("im/conversations/{conversationId}/messages/{messageId}/attachment-url")
    public suspend fun attachmentUrl(
        @Path("conversationId") conversationId: String,
        @Path("messageId") messageId: Int,
    ): ApiEnvelope<ImAttachmentUrl>

}
