package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.NotificationListResponse
import com.tabtin.mobile.data.model.NotificationMarkAllResponse
import com.tabtin.mobile.data.model.NotificationUnreadCountResponse
import kotlinx.serialization.json.JsonObject
import retrofit2.http.GET
import retrofit2.http.POST
import retrofit2.http.Path
import retrofit2.http.Query

public interface NotificationApi {
    @GET("notifications/")
    public suspend fun listNotifications(
        @Query("page") page: Int = 1,
        @Query("limit") limit: Int = 50,
        @Query("organization_id") organizationId: String? = null,
        @Query("include_personal_invitations") includePersonalInvitations: Boolean = false,
    ): ApiEnvelope<NotificationListResponse>

    @GET("notifications/unread-count")
    public suspend fun getUnreadCount(
        @Query("organization_id") organizationId: String? = null,
        @Query("include_personal_invitations") includePersonalInvitations: Boolean = false,
    ): ApiEnvelope<NotificationUnreadCountResponse>

    @POST("notifications/{id}/read")
    public suspend fun markRead(@Path("id") id: String): ApiEnvelope<JsonObject>

    @POST("notifications/read-all")
    public suspend fun markAllRead(
        @Query("organization_id") organizationId: String? = null,
        @Query("include_personal_invitations") includePersonalInvitations: Boolean = false,
    ): ApiEnvelope<NotificationMarkAllResponse>
}
