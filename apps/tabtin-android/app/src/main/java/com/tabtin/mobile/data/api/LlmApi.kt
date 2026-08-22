package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.ModelsResponse
import com.tabtin.mobile.data.model.ProvidersResponse
import com.tabtin.mobile.data.model.SetDefaultModelRequest
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

public interface LlmApi {
    @GET("services/llm/organizations/{organizationId}/providers")
    public suspend fun getProviders(@Path("organizationId") organizationId: String): ApiEnvelope<ProvidersResponse>

    @GET("services/llm/organizations/{organizationId}/models")
    public suspend fun getModels(@Path("organizationId") organizationId: String): ApiEnvelope<ModelsResponse>

    @GET("services/llm/catalog")
    public suspend fun getCatalog(
        @Query("organization_id") organizationId: String,
        @Query("use_case") useCase: String = "chat",
    ): ApiEnvelope<ModelsResponse>

    @PUT("services/llm/organizations/{organizationId}/default-model")
    public suspend fun setDefaultModel(
        @Path("organizationId") organizationId: String,
        @Body body: SetDefaultModelRequest,
    ): ApiEnvelope<JsonObject>
}
