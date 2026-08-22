package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.AllSessionListResponse
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ChatSessionListResponse
import com.tabtin.mobile.data.model.CreateSessionRequest
import com.tabtin.mobile.data.model.ForkSessionRequest
import com.tabtin.mobile.data.model.MessageListResponse
import com.tabtin.mobile.data.model.PendingInteractionDismissResponse
import com.tabtin.mobile.data.model.PendingInteractionListResponse
import com.tabtin.mobile.data.model.SessionReadAckRequest
import com.tabtin.mobile.data.model.SessionReadAckResponse
import com.tabtin.mobile.data.model.SwitchContextTierRequest
import com.tabtin.mobile.data.model.SwitchContextTierResponse
import com.tabtin.mobile.data.model.SwitchSessionModelRequest
import com.tabtin.mobile.data.model.SwitchSessionModelResponse
import com.tabtin.mobile.data.model.UpdateModelParamsRequest
import com.tabtin.mobile.data.model.UpdateModelParamsResponse
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

public interface ChatApi {
    @GET("chat/sessions")
    public suspend fun getSessions(
        @Query("workspace_id") workspaceId: String? = null,
        @Query("project_id") projectId: String? = null,
        @Query("status") status: String = "active",
        @Query("limit") limit: Int = 50,
    ): ApiEnvelope<ChatSessionListResponse>

    /**
     * 跨 Space 对话聚合（drawer "全部对话" 视图用）。
     * 后端实现 schemas.py `ChatSessionWithAgentSchema`，带 agent/space 元信息。
     */
    @GET("chat/sessions/all")
    public suspend fun getAllSessions(
        @Query("organization_id") organizationId: String,
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int = 0,
        @Query("status") status: String? = "active",
        @Query("keyword") keyword: String? = null,
        @Query("agent_id") agentId: String? = null,
        @Query("workspace_id") workspaceId: String? = null,
        @Query("run_status") runStatus: String? = null,
    ): ApiEnvelope<AllSessionListResponse>

    @POST("chat/sessions")
    public suspend fun createSession(@Body body: CreateSessionRequest): ApiEnvelope<ChatSession>

    @GET("chat/sessions/{sessionId}")
    public suspend fun getSession(
        @Path("sessionId") sessionId: String,
        @Query("share_id") shareId: String? = null,
    ): ApiEnvelope<ChatSession>

    @PUT("chat/sessions/{sessionId}")
    public suspend fun updateSession(
        @Path("sessionId") sessionId: String,
        @Body body: UpdateSessionRequest,
    ): ApiEnvelope<ChatSession>

    @PUT("chat/sessions/{sessionId}/model")
    public suspend fun switchSessionModel(
        @Path("sessionId") sessionId: String,
        @Body body: SwitchSessionModelRequest,
    ): ApiEnvelope<SwitchSessionModelResponse>

    @PUT("chat/sessions/{sessionId}/context-tier")
    public suspend fun switchContextTier(
        @Path("sessionId") sessionId: String,
        @Body body: SwitchContextTierRequest,
    ): ApiEnvelope<SwitchContextTierResponse>

    @PUT("chat/sessions/{sessionId}/model-params")
    public suspend fun updateModelParams(
        @Path("sessionId") sessionId: String,
        @Body body: UpdateModelParamsRequest,
    ): ApiEnvelope<UpdateModelParamsResponse>

    @DELETE("chat/sessions/{sessionId}")
    public suspend fun deleteSession(@Path("sessionId") sessionId: String): ApiEnvelope<Unit>

    @GET("chat/sessions/{sessionId}/messages")
    public suspend fun getMessages(
        @Path("sessionId") sessionId: String,
        @Query("limit") limit: Int = 50,
        @Query("offset") offset: Int? = null,
        @Query("before") before: String? = null,
        @Query("updated_after") updatedAfter: String? = null,
        @Query("updated_before") updatedBefore: String? = null,
        @Query("around") around: String? = null,
        @Query("share_id") shareId: String? = null,
        @Query("expand_artifacts") expandArtifacts: Boolean? = null,
        @Query("include_hitl_facts") includeHitlFacts: Boolean? = null,
    ): ApiEnvelope<MessageListResponse>

    @POST("chat/sessions/{sessionId}/read")
    public suspend fun acknowledgeSessionRead(
        @Path("sessionId") sessionId: String,
        @Body body: SessionReadAckRequest,
    ): ApiEnvelope<SessionReadAckResponse>

    @GET("chat/pending-interactions")
    public suspend fun getPendingInteractions(
        @Query("organization_id") organizationId: String? = null,
    ): ApiEnvelope<PendingInteractionListResponse>

    @GET("chat/sessions/{sessionId}/pending-interactions")
    public suspend fun getSessionPendingInteractions(
        @Path("sessionId") sessionId: String,
    ): ApiEnvelope<PendingInteractionListResponse>

    @POST("chat/pending-interactions/{interactionId}/dismiss")
    public suspend fun dismissPendingInteraction(
        @Path("interactionId") interactionId: String,
    ): ApiEnvelope<PendingInteractionDismissResponse>

    @POST("chat/sessions/{sessionId}/fork")
    public suspend fun forkSession(
        @Path("sessionId") sessionId: String,
        @Body body: ForkSessionRequest,
    ): ApiEnvelope<ChatSession>

    @POST("chat/sessions/{sessionId}/shared-fork")
    public suspend fun sharedFork(
        @Path("sessionId") sessionId: String,
        @Body body: SharedForkRequest,
    ): ApiEnvelope<ChatSession>

    @POST("chat/sessions/{sessionId}/shared-chat")
    public suspend fun sharedChat(
        @Path("sessionId") sessionId: String,
        @Body body: SharedChatRequest,
    ): ApiEnvelope<SharedChatResponse>

    @GET("chat/sessions/{sessionId}/shared-execution-status")
    public suspend fun sharedExecutionStatus(
        @Path("sessionId") sessionId: String,
        @Query("share_id") shareId: String,
    ): ApiEnvelope<SharedExecutionStatusResponse>
}

@Serializable
public data class SharedForkRequest(
    @SerialName("agent_id") val agentId: String,
    @SerialName("workspace_id") val workspaceId: String,
    @SerialName("share_id") val shareId: String,
)

@Serializable
public data class SharedChatRequest(
    val text: String,
    @SerialName("share_id") val shareId: String,
    @SerialName("client_message_id") val clientMessageId: String,
)

@Serializable
public data class SharedChatResponse(
    @SerialName("message_id") val messageId: String? = null,
    val reply: String? = null,
    val content: String? = null,
    @SerialName("model_id") val modelId: String? = null,
    @SerialName("model_name") val modelName: String? = null,
    @SerialName("trace_id") val traceId: String? = null,
    @SerialName("error_category") val errorCategory: String? = null,
    @SerialName("error_message") val errorMessage: String? = null,
    @SerialName("error_code") val errorCode: String? = null,
)

@Serializable
public data class SharedExecutionStatusResponse(
    val reachable: Boolean = false,
    @SerialName("error_category") val errorCategory: String? = null,
    val runtime: String? = null,
)

@Serializable
public data class UpdateSessionRequest(
    val status: String? = null,
    val title: String? = null,
    @SerialName("agent_id") val agentId: String? = null,
    /**  Composer 工作方式；不传则服务端不变 */
    @SerialName("agent_mode") val agentMode: String? = null,
    @SerialName("is_pinned") val isPinned: Boolean? = null,
)
