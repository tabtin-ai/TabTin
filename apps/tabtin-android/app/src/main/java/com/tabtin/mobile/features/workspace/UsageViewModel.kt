package com.tabtin.mobile.features.workspace

import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.data.model.UsageDashboardResponse
import com.tabtin.mobile.data.repository.BillingRepository
import com.tabtin.mobile.data.websocket.BillingEventHandler
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.math.BigDecimal
import java.math.MathContext
import javax.inject.Inject

internal const val USAGE_MODEL_RANK_LIMIT: Int = 20

public data class UsageMeterRowUi(
    val meterKey: String,
    val displayLabel: String,
    val credits: BigDecimal,
    val fraction: Float,
)

public data class UsageModelRowUi(
    val title: String,
    val credits: BigDecimal,
    val fraction: Float,
)

public data class UsageUiState(
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val error: String? = null,
    val currentMonth: BigDecimal = BigDecimal.ZERO,
    val lastMonth: BigDecimal = BigDecimal.ZERO,
    val monthOverMonthPct: Double? = null,
    val todayTotal: BigDecimal = BigDecimal.ZERO,
    val todayAggregated: BigDecimal = BigDecimal.ZERO,
    val meterRows: List<UsageMeterRowUi> = emptyList(),
    val modelRows: List<UsageModelRowUi> = emptyList(),
    val isEmpty: Boolean = false,
)

@HiltViewModel
public class UsageViewModel @Inject constructor(
    savedStateHandle: SavedStateHandle,
    private val billingRepository: BillingRepository,
    private val billingEventHandler: BillingEventHandler,
) : ViewModel() {

    public val organizationId: String = savedStateHandle.get<String>("organizationId") ?: ""

    private val _uiState = MutableStateFlow(UsageUiState())
    public val uiState: StateFlow<UsageUiState> = _uiState.asStateFlow()

    init {
        load(showFullLoading = true)
        observeBillingRefresh()
    }

    private fun observeBillingRefresh() {
        viewModelScope.launch {
            billingEventHandler.refreshRequired.collect {
                load(showFullLoading = false)
            }
        }
    }

    public fun refresh() {
        load(showFullLoading = false, isPull = true)
    }

    private fun load(showFullLoading: Boolean, isPull: Boolean = false) {
        viewModelScope.launch {
            if (isPull) {
                _uiState.update { it.copy(isRefreshing = true, error = null) }
            } else if (showFullLoading) {
                _uiState.update { it.copy(isLoading = true, error = null) }
            }
            try {
                val raw = billingRepository.getUsageDashboard(organizationId, days = 30)
                val mapped = mapDashboard(raw)
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = null,
                        currentMonth = mapped.currentMonth,
                        lastMonth = mapped.lastMonth,
                        monthOverMonthPct = mapped.mom,
                        todayTotal = mapped.todayTotal,
                        todayAggregated = mapped.todayAggregated,
                        meterRows = mapped.meters,
                        modelRows = mapped.models,
                        isEmpty = mapped.currentMonth.signum() <= 0 && mapped.meters.isEmpty() && mapped.models.isEmpty(),
                    )
                }
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isRefreshing = false,
                        error = e.message ?: "",
                    )
                }
            }
        }
    }

    private data class Mapped(
        val currentMonth: BigDecimal,
        val lastMonth: BigDecimal,
        val mom: Double?,
        val todayTotal: BigDecimal,
        val todayAggregated: BigDecimal,
        val meters: List<UsageMeterRowUi>,
        val models: List<UsageModelRowUi>,
    )

    private fun mapDashboard(resp: UsageDashboardResponse): Mapped {
        val monthTotal = resp.currentMonthTotal
        val meterSum = resp.byMeter.fold(BigDecimal.ZERO) { total, item -> total + item.totalCredits }
            .takeIf { it.signum() > 0 }
            ?: monthTotal.takeIf { it.signum() > 0 }
            ?: BigDecimal.ONE
        val meters = resp.byMeter.map { m ->
            val c = m.totalCredits
            UsageMeterRowUi(
                meterKey = m.meterKey,
                displayLabel = m.displayName?.takeIf { it.isNotBlank() } ?: m.meterKey,
                credits = c,
                fraction = usageFraction(c, meterSum),
            )
        }
        val topModels = resp.byModel.sortedByDescending { it.totalCredits }.take(USAGE_MODEL_RANK_LIMIT)
        val modelDenom = topModels.fold(BigDecimal.ZERO) { total, item -> total + item.totalCredits }
            .takeIf { it.signum() > 0 }
            ?: monthTotal.takeIf { it.signum() > 0 }
            ?: BigDecimal.ONE
        val models = topModels.map { m ->
            val c = m.totalCredits
            UsageModelRowUi(
                title = m.title,
                credits = c,
                fraction = usageFraction(c, modelDenom),
            )
        }
        return Mapped(
            currentMonth = monthTotal,
            lastMonth = resp.lastMonthTotal,
            mom = resp.monthOverMonthPct,
            todayTotal = resp.todayTotal,
            todayAggregated = resp.todayAggregated,
            meters = meters,
            models = models,
        )
    }

    private fun usageFraction(value: BigDecimal, total: BigDecimal): Float =
        value.divide(total, MathContext.DECIMAL64).toFloat().coerceIn(0f, 1f)
}
