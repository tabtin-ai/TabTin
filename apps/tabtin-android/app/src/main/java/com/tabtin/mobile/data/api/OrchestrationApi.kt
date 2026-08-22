package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.SubAgentTemplate
import com.tabtin.mobile.data.model.SubAgentTemplateCreate
import com.tabtin.mobile.data.model.SubAgentTemplateListResponse
import com.tabtin.mobile.data.model.SubAgentTemplateUpdate
import com.tabtin.mobile.data.model.SubAgentToggleRequest
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.DELETE
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.PUT
import retrofit2.http.Path

public interface OrchestrationApi {

    @GET("orchestration/spaces/{spaceId}/subagent-templates")
    public suspend fun getSubAgentTemplates(
        @Path("spaceId") spaceId: String,
    ): SubAgentTemplateListResponse

    @POST("orchestration/spaces/{spaceId}/subagent-templates")
    public suspend fun createSubAgentTemplate(
        @Path("spaceId") spaceId: String,
        @Body body: SubAgentTemplateCreate,
    ): SubAgentTemplate

    @PUT("orchestration/spaces/{spaceId}/subagent-templates/{templateId}")
    public suspend fun updateSubAgentTemplate(
        @Path("spaceId") spaceId: String,
        @Path("templateId") templateId: String,
        @Body body: SubAgentTemplateUpdate,
    ): SubAgentTemplate

    @PUT("orchestration/spaces/{spaceId}/subagent-templates/{templateId}")
    public suspend fun toggleSubAgentTemplate(
        @Path("spaceId") spaceId: String,
        @Path("templateId") templateId: String,
        @Body body: SubAgentToggleRequest,
    ): SubAgentTemplate

    @DELETE("orchestration/spaces/{spaceId}/subagent-templates/{templateId}")
    public suspend fun deleteSubAgentTemplate(
        @Path("spaceId") spaceId: String,
        @Path("templateId") templateId: String,
    ): JsonObject
}

@Serializable
public data class ReviewDecisionItem(
    val type: String,
    @SerialName("tool_call_id") val toolCallId: String? = null,
)
