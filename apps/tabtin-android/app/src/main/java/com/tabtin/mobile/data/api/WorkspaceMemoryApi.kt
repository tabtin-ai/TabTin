package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.WorkspaceMemoryModelCatalog
import com.tabtin.mobile.data.model.WorkspaceMemorySettings
import com.tabtin.mobile.data.model.WorkspaceMemorySettingsUpdateRequest
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PUT
import retrofit2.http.Query

public interface WorkspaceMemoryApi {
    @GET("agent-memory/workspace-settings/")
    public suspend fun getSettings(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<WorkspaceMemorySettings>

    @PUT("agent-memory/workspace-settings/")
    public suspend fun updateSettings(
        @Body body: WorkspaceMemorySettingsUpdateRequest,
    ): ApiEnvelope<WorkspaceMemorySettings>

    @GET("agent-memory/workspace-settings/models/")
    public suspend fun listModels(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<WorkspaceMemoryModelCatalog>
}
