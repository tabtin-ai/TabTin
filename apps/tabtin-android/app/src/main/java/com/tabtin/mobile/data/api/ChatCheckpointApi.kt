package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.AgentRunRollbackResponse
import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.ChatSession
import com.tabtin.mobile.data.model.ResourceRestoreRequest
import com.tabtin.mobile.data.model.ResourceRestoreResponse
import com.tabtin.mobile.data.model.RevertHistoryResponse
import com.tabtin.mobile.data.model.RollbackPreviewRequest
import com.tabtin.mobile.data.model.RollbackPreviewResponse
import com.tabtin.mobile.data.model.RollbackRequest
import com.tabtin.mobile.data.model.RollbackResponse
import com.tabtin.mobile.data.model.UnrevertResponse
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path

public interface ChatCheckpointApi {

    @GET("chat/sessions/{sessionId}")
    public suspend fun getSessionDetail(
        @Path("sessionId") sessionId: String,
    ): ApiEnvelope<ChatSession>

    @POST("chat/sessions/{sessionId}/rollback/preview")
    public suspend fun rollbackPreview(
        @Path("sessionId") sessionId: String,
        @Body body: RollbackPreviewRequest,
    ): ApiEnvelope<RollbackPreviewResponse>

    @POST("chat/sessions/{sessionId}/rollback/execute")
    public suspend fun rollback(
        @Path("sessionId") sessionId: String,
        @Body body: RollbackRequest,
    ): ApiEnvelope<RollbackResponse>

    @POST("chat/sessions/{sessionId}/unrevert")
    public suspend fun unrevert(
        @Path("sessionId") sessionId: String,
    ): ApiEnvelope<UnrevertResponse>

    @POST("chat/sessions/{sessionId}/rollback/resources")
    public suspend fun restoreResources(
        @Path("sessionId") sessionId: String,
        @Body body: ResourceRestoreRequest,
    ): ApiEnvelope<ResourceRestoreResponse>

    @GET("chat/sessions/{sessionId}/revert-history")
    public suspend fun getRevertHistory(
        @Path("sessionId") sessionId: String,
    ): ApiEnvelope<RevertHistoryResponse>

    @POST("collab/v1/agent-run/{agentRunId}/rollback")
    public suspend fun rollbackAgentRun(
        @Path("agentRunId") agentRunId: String,
    ): ApiEnvelope<AgentRunRollbackResponse>
}
