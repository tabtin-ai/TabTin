package com.tabtin.mobile.data.repository

import com.tabtin.mobile.data.api.WalletApi
import com.tabtin.mobile.data.model.TransactionsResponse
import com.tabtin.mobile.data.model.WalletInfo
import javax.inject.Inject
import javax.inject.Singleton

@Singleton
public class WalletRepository @Inject constructor(
    private val walletApi: WalletApi,
) {
    public suspend fun getWallet(organizationId: String): WalletInfo {
        return walletApi.getOrganizationWallet(organizationId).unwrap()
    }

    public suspend fun getTransactions(
        organizationId: String,
        transactionType: String? = null,
        limit: Int = 20,
        offset: Int = 0,
    ): TransactionsResponse {
        return walletApi.getTransactions(organizationId, transactionType, limit, offset).unwrap()
    }
}
