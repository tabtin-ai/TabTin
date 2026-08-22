package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.MemberUsageResponse
import com.tabtin.mobile.data.model.UsageDashboardResponse
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

public interface BillingApi {
    @GET("services/billing/organizations/{organizationId}/usage-dashboard")
    public suspend fun getUsageDashboard(
        @Path("organizationId") organizationId: String,
        @Query("days") days: Int = 30,
    ): ApiEnvelope<UsageDashboardResponse>

    @GET("services/billing/my-usage")
    public suspend fun getMyUsage(
        @Query("organization_id") organizationId: String,
    ): ApiEnvelope<MemberUsageResponse>
}
