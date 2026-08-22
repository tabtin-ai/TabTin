package com.tabtin.mobile.features.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.ui.theme.TTSpacing
import java.math.BigDecimal
import java.math.RoundingMode
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.abs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun UsageScreen(
    viewModel: UsageViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.ws_usage)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isRefreshing,
            onRefresh = { viewModel.refresh() },
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                state.isLoading -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }
                state.error != null && state.meterRows.isEmpty() && state.modelRows.isEmpty() -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            stringResource(R.string.ws_load_failed_retry),
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                        val detail = state.error.orEmpty().trim()
                        if (detail.isNotEmpty()) {
                            Spacer(Modifier.height(TTSpacing.sm))
                            Text(
                                detail,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Spacer(Modifier.height(TTSpacing.md))
                        TextButton(onClick = { viewModel.refresh() }) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                state.isEmpty -> {
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        Text(
                            stringResource(R.string.ws_usage_empty),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
                    ) {
                        if (state.error != null) {
                            item {
                                UsageRefreshErrorBanner(
                                    errorDetail = state.error.orEmpty(),
                                    onRetry = { viewModel.refresh() },
                                )
                            }
                        }
                        item {
                            OverviewCard(state = state)
                        }
                        item {
                            Text(
                                stringResource(R.string.ws_usage_meter_distribution),
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.padding(horizontal = TTSpacing.lg),
                            )
                        }
                        items(state.meterRows, key = { it.meterKey }) { row ->
                            MeterRow(row = row)
                        }
                        item { HorizontalDivider(Modifier.padding(vertical = TTSpacing.sm)) }
                        item {
                            Text(
                                stringResource(R.string.ws_usage_model_top),
                                style = MaterialTheme.typography.titleSmall,
                                modifier = Modifier.padding(horizontal = TTSpacing.lg),
                            )
                        }
                        itemsIndexed(state.modelRows, key = { i, row -> "$i-${row.title}-${row.credits}" }) { _, row ->
                            ModelRow(row = row)
                        }
                        item { Spacer(Modifier.height(TTSpacing.xxl)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun UsageRefreshErrorBanner(
    errorDetail: String,
    onRetry: () -> Unit,
) {
    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg),
        shape = RoundedCornerShape(TTSpacing.sm),
        color = MaterialTheme.colorScheme.errorContainer,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    stringResource(R.string.ws_usage_refresh_failed_banner),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                )
                val detail = errorDetail.trim()
                if (detail.isNotEmpty()) {
                    Spacer(Modifier.height(TTSpacing.xxs))
                    Text(
                        detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onErrorContainer.copy(alpha = 0.88f),
                    )
                }
            }
            TextButton(onClick = onRetry) {
                Text(stringResource(R.string.common_retry))
            }
        }
    }
}

@Composable
private fun OverviewCard(state: UsageUiState) {
    val mom = state.monthOverMonthPct
    val momLabel = when {
        mom == null -> "—"
        mom >= 0 -> "↑ ${abs(mom)}%"
        else -> "↓ ${abs(mom)}%"
    }
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(TTSpacing.lg),
    ) {
        Text(
            stringResource(R.string.ws_usage_current_month),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        Text(
            usageCredits(state.currentMonth),
            style = MaterialTheme.typography.headlineMedium,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Column {
                Text(
                    stringResource(R.string.ws_usage_month_over_month),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    momLabel,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    stringResource(R.string.ws_usage_last_month),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    usageCredits(state.lastMonth),
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
        }
        if (state.todayTotal.signum() > 0 || state.todayAggregated.signum() > 0) {
            HorizontalDivider(
                modifier = Modifier.padding(vertical = TTSpacing.sm),
                color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.3f),
            )
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column {
                    Text(
                        stringResource(R.string.ws_usage_today_total),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        usageCredits(state.todayTotal),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
                if (state.todayAggregated.signum() > 0) {
                    Column(horizontalAlignment = Alignment.End) {
                        Text(
                            stringResource(R.string.ws_usage_today_aggregated),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Text(
                            usageCredits(state.todayAggregated),
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun MeterRow(row: UsageMeterRowUi) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(row.displayLabel, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            Text(
                usageCredits(row.credits),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.height(TTSpacing.xs))
        LinearProgressIndicator(
            progress = { row.fraction },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun ModelRow(row: UsageModelRowUi) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(row.title, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(TTSpacing.xs))
            LinearProgressIndicator(
                progress = { row.fraction },
                modifier = Modifier.fillMaxWidth(),
            )
        }
        Spacer(Modifier.width(TTSpacing.sm))
        Text(
            usageCredits(row.credits),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun usageCredits(value: BigDecimal): String = stringResource(
    R.string.ws_usage_credits_value,
    formatUsageCredits(value),
)

internal fun formatUsageCredits(value: BigDecimal, locale: Locale = Locale.getDefault()): String {
    if (value.signum() == 0) return "0"

    val magnitude = value.abs()
    val fixedDigits = when {
        magnitude < BigDecimal("0.01") -> 4
        magnitude < BigDecimal.ONE -> 2
        else -> null
    }
    val formatter = NumberFormat.getNumberInstance(locale).apply {
        roundingMode = RoundingMode.HALF_UP
        minimumFractionDigits = fixedDigits ?: 0
        maximumFractionDigits = fixedDigits ?: 2
    }
    return formatter.format(value)
}
