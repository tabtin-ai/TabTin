package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.CredentialListItem
import com.tabtin.mobile.data.model.SkillApiKeyRequest
import com.tabtin.mobile.data.model.SkillConfigsResponse
import com.tabtin.mobile.data.model.SkillEnableRequest
import com.tabtin.mobile.data.model.SkillListResponse
import com.tabtin.mobile.data.model.SkillToggleRequest
import com.tabtin.mobile.data.model.SpaceSkill
import com.tabtin.mobile.data.model.VisibleSkillListResponse
import kotlinx.serialization.json.JsonObject
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.PATCH
import retrofit2.http.PUT
import retrofit2.http.Path
import retrofit2.http.Query

public interface SkillsApi {

    /** Agent-first 的服务端可见目录；不复用旧 Space Skills / 明文 API Key 契约。 */
    @GET("skills/visible")
    public suspend fun getVisibleSkills(
        @Query("organization_id") organizationId: String,
        @Query("agent_id") agentId: String? = null,
    ): ApiEnvelope<VisibleSkillListResponse>

    /** Credential Vault 返回的是裸数组且已脱敏，手机仅用于绑定 credential_id。 */
    @GET("credential-vault/list")
    public suspend fun getCredentials(
        @Query("category") category: String = "api_key",
    ): List<CredentialListItem>

    @GET("skills/index")
    public suspend fun getSkillsIndex(
        @Query("space_id") spaceId: String,
    ): ApiEnvelope<SkillListResponse>

    @GET("skills/config")
    public suspend fun getSkillsConfig(
        @Query("space_id") spaceId: String,
    ): ApiEnvelope<SkillConfigsResponse>

    @PATCH("skills/config/{skillKey}")
    public suspend fun toggleSkill(
        @Path("skillKey") skillKey: String,
        @Body body: SkillToggleRequest,
    ): ApiEnvelope<JsonObject>

    @PATCH("skills/config/{skillKey}")
    public suspend fun updateSkillApiKey(
        @Path("skillKey") skillKey: String,
        @Body body: SkillApiKeyRequest,
    ): ApiEnvelope<JsonObject>

    @GET("context/spaces/{spaceId}/skills")
    public suspend fun getSpaceSkills(
        @Path("spaceId") spaceId: String,
    ): ApiEnvelope<SkillListResponse>

    @PUT("context/spaces/{spaceId}/skills/{skillId}")
    public suspend fun updateSpaceSkill(
        @Path("spaceId") spaceId: String,
        @Path("skillId") skillId: String,
        @Body body: SkillEnableRequest,
    ): ApiEnvelope<SpaceSkill>
}
