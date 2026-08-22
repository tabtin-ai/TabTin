package com.tabtin.mobile.data.api

import com.tabtin.mobile.data.model.ApiEnvelope
import com.tabtin.mobile.data.model.TransactionsResponse
import com.tabtin.mobile.data.model.WalletInfo
import retrofit2.http.GET
import retrofit2.http.Path
import retrofit2.http.Query

public interface WalletApi {
    @GET("wallet/organizations/{organizationId}/wallet")
    public suspend fun getOrganizationWallet(@Path("organizationId") organizationId: String): ApiEnvelope<WalletInfo>

    @GET("wallet/organizations/{organizationId}/transactions")
    public suspend fun getTransactions(
        @Path("organizationId") organizationId: String,
        @Query("transaction_type") transactionType: String? = null,
        @Query("limit") limit: Int = 20,
        @Query("offset") offset: Int = 0,
        @Query("order_by") orderBy: String? = "-created_at",
    ): ApiEnvelope<TransactionsResponse>
}
