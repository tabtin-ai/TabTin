package com.tabtin.mobile.features.workspace

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.WalletInfo
import com.tabtin.mobile.data.model.WalletTransaction
import com.tabtin.mobile.data.repository.WalletRepository
import com.tabtin.mobile.data.websocket.BillingEventHandler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

internal enum class WalletTxFilter {
    ALL,
    CONSUME,
    RECHARGE,
    OTHER,
}

private val OTHER_TX_TYPES = setOf(
    "grant",
    "refund",
    "expire",
    "freeze",
    "unfreeze",
    "transfer",
    "adjustment",
)

internal data class WalletUiState(
    val wallet: WalletInfo? = null,
    val transactions: List<WalletTransaction> = emptyList(),
    val isInitialLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val isLoadingMore: Boolean = false,
    val error: String? = null,
    val hasMore: Boolean = true,
    val filter: WalletTxFilter = WalletTxFilter.ALL,
    val apiOffset: Int = 0,
)

@HiltViewModel
public class WalletViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val walletRepository: WalletRepository,
    private val billingEventHandler: BillingEventHandler,
) : ViewModel() {

    public val organizationId: String = savedStateHandle.get<String>("organizationId") ?: ""

    private val _uiState = MutableStateFlow(WalletUiState())
    internal val uiState: StateFlow<WalletUiState> = _uiState.asStateFlow()

    init {
        reloadWalletAndTransactions(isPullRefresh = false, showFullLoading = true)
        observeBillingRefresh()
    }

    private fun observeBillingRefresh() {
        viewModelScope.launch {
            billingEventHandler.refreshRequired.collect {
                reloadWalletAndTransactions(isPullRefresh = false, showFullLoading = false)
            }
        }
    }

    internal fun setFilter(filter: WalletTxFilter) {
        if (_uiState.value.filter == filter) return
        _uiState.update {
            it.copy(
                filter = filter,
                transactions = emptyList(),
                apiOffset = 0,
                hasMore = true,
                error = null,
            )
        }
        reloadWalletAndTransactions(isPullRefresh = false, showFullLoading = false)
    }

    public fun refresh() {
        reloadWalletAndTransactions(isPullRefresh = true, showFullLoading = false)
    }

    public fun loadMore() {
        val s = _uiState.value
        if (s.isLoadingMore || !s.hasMore || s.isInitialLoading) return
        viewModelScope.launch {
            _uiState.update { it.copy(isLoadingMore = true) }
            try {
                val type = apiType(s.filter)
                val resp = walletRepository.getTransactions(organizationId, type, limit = 20, offset = s.apiOffset)
                val chunk = filterTransactions(resp.transactions, s.filter)
                val newOffset = s.apiOffset + resp.transactions.size
                _uiState.update {
                    it.copy(
                        transactions = it.transactions + chunk,
                        apiOffset = newOffset,
                        hasMore = newOffset < resp.total,
                        isLoadingMore = false,
                    )
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _uiState.update { it.copy(isLoadingMore = false, error = e.message ?: "") }
            }
        }
    }

    private fun reloadWalletAndTransactions(isPullRefresh: Boolean, showFullLoading: Boolean) {
        viewModelScope.launch {
            if (isPullRefresh) {
                _uiState.update { it.copy(isRefreshing = true, error = null) }
            } else if (showFullLoading) {
                _uiState.update { it.copy(isInitialLoading = true, error = null) }
            }
            runCatching { walletRepository.getWallet(organizationId) }
                .onSuccess { w -> _uiState.update { it.copy(wallet = w) } }
                .onFailure { e -> _uiState.update { it.copy(error = e.message ?: "") } }

            try {
                val s = _uiState.value
                val type = apiType(s.filter)
                val resp = walletRepository.getTransactions(organizationId, type, limit = 20, offset = 0)
                val chunk = filterTransactions(resp.transactions, s.filter)
                _uiState.update {
                    it.copy(
                        transactions = chunk,
                        apiOffset = resp.transactions.size,
                        hasMore = resp.transactions.size < resp.total,
                        isInitialLoading = false,
                        isRefreshing = false,
                    )
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _uiState.update {
                    it.copy(
                        error = e.message ?: "",
                        isInitialLoading = false,
                        isRefreshing = false,
                    )
                }
            }
        }
    }

    private fun apiType(filter: WalletTxFilter): String? = when (filter) {
        WalletTxFilter.ALL -> null
        WalletTxFilter.CONSUME -> "consume"
        WalletTxFilter.RECHARGE -> "recharge"
        WalletTxFilter.OTHER -> null
    }

    private fun filterTransactions(
        rows: List<WalletTransaction>,
        filter: WalletTxFilter,
    ): List<WalletTransaction> = when (filter) {
        WalletTxFilter.OTHER -> rows.filter { OTHER_TX_TYPES.contains(it.transactionType) }
        else -> rows
    }
}
