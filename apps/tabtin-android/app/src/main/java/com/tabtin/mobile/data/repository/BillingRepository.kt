package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.BillingApi
import com.tabtin.mobile.data.model.UsageDashboardResponse
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class BillingRepository @Inject constructor(
    private val billingApi: BillingApi,
) {
    public suspend fun getUsageDashboard(organizationId: String, days: Int = 30): UsageDashboardResponse {
        return billingApi.getUsageDashboard(organizationId, days).unwrap()
    }
}
