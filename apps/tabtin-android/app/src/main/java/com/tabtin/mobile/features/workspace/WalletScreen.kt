package com.tabtin.mobile.features.workspace

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AddCard
import androidx.compose.material.icons.filled.RemoveShoppingCart
import androidx.compose.material.icons.filled.SwapHoriz
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SecondaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.WalletInfo
import com.tabtin.mobile.data.model.WalletTransaction
import com.tabtin.mobile.data.model.formatCreditsAuto
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.flow.distinctUntilChanged

private val TxGreen = Color(0xFF22C55E)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun WalletScreen(
    viewModel: WalletViewModel,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()

    LaunchedEffect(listState, state.hasMore, state.isLoadingMore) {
        snapshotFlow {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            val total = info.totalItemsCount
            total > 0 && last >= total - 2
        }
            .distinctUntilChanged()
            .collect { nearEnd ->
                if (nearEnd) viewModel.loadMore()
            }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.ws_wallet)) },
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
            Column(Modifier.fillMaxSize()) {
                BalanceCard(
                    wallet = state.wallet,
                    loading = state.isInitialLoading && state.wallet == null,
                    errorWhenNoWallet = if (!state.isInitialLoading && state.wallet == null) state.error else null,
                    onBalanceRetry = { viewModel.refresh() },
                )

                Text(
                    stringResource(R.string.ws_wallet_recharge_hint),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                )

                val tabs = listOf(
                    WalletTxFilter.ALL to stringResource(R.string.ws_wallet_all),
                    WalletTxFilter.CONSUME to stringResource(R.string.ws_wallet_consumption),
                    WalletTxFilter.RECHARGE to stringResource(R.string.ws_wallet_recharge),
                    WalletTxFilter.OTHER to stringResource(R.string.ws_wallet_other),
                )
                val selectedIndex = tabs.indexOfFirst { it.first == state.filter }.coerceAtLeast(0)
                SecondaryScrollableTabRow(
                    selectedTabIndex = selectedIndex,
                    edgePadding = TTSpacing.md,
                ) {
                    tabs.forEach { (f, label) ->
                        Tab(
                            selected = state.filter == f,
                            onClick = { viewModel.setFilter(f) },
                            text = { Text(label, style = MaterialTheme.typography.bodyMedium) },
                        )
                    }
                }

                HorizontalDivider()

                when {
                    state.isInitialLoading && state.transactions.isEmpty() -> {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            CircularProgressIndicator()
                        }
                    }
                    state.transactions.isEmpty() && !state.isInitialLoading && state.error != null -> {
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(horizontal = TTSpacing.xl),
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
                    state.transactions.isEmpty() && !state.isInitialLoading -> {
                        Box(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth(),
                            contentAlignment = Alignment.Center,
                        ) {
                            Text(
                                stringResource(R.string.ws_wallet_empty),
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    else -> {
                        LazyColumn(
                            state = listState,
                            modifier = Modifier.weight(1f),
                            verticalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                        ) {
                            items(state.transactions, key = { it.id }) { tx ->
                                TransactionRow(tx = tx)
                            }
                            if (state.isLoadingMore) {
                                item {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(TTSpacing.lg),
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        CircularProgressIndicator(modifier = Modifier.size(28.dp), strokeWidth = 2.dp)
                                    }
                                }
                            }
                        }
                    }
                }

                if (state.error != null && state.transactions.isNotEmpty()) {
                    Column(Modifier.padding(TTSpacing.md)) {
                        Text(
                            stringResource(R.string.ws_load_failed),
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall,
                        )
                        val detail = state.error.orEmpty().trim()
                        if (detail.isNotEmpty()) {
                            Spacer(Modifier.height(TTSpacing.xs))
                            Text(
                                detail,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BalanceCard(
    wallet: WalletInfo?,
    loading: Boolean,
    errorWhenNoWallet: String?,
    onBalanceRetry: () -> Unit,
) {
    var showFrozenInfo by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(TTSpacing.lg),
    ) {
        Text(
            stringResource(R.string.ws_wallet_balance),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(TTSpacing.sm))
        when {
            loading -> CircularProgressIndicator(modifier = Modifier.size(32.dp), strokeWidth = 2.dp)
            wallet != null -> {
                Text(
                    formatCreditsAuto(wallet.creditsPrecise, wallet.credits),
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurface,
                )
                Spacer(Modifier.height(TTSpacing.xs))
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.lg)) {
                    Text(
                        "${stringResource(R.string.ws_wallet_available)} ${formatCreditsAuto(wallet.availableCreditsPrecise, wallet.availableCredits)}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xxs),
                    ) {
                        Text(
                            "${stringResource(R.string.ws_wallet_frozen)} ${formatCreditsAuto(wallet.creditsFrozenPrecise, wallet.creditsFrozen)}",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                        Icon(
                            imageVector = Icons.Outlined.Info,
                            contentDescription = stringResource(R.string.ws_wallet_frozen_info_title),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier
                                .size(16.dp)
                                .clickable { showFrozenInfo = true },
                        )
                    }
                }
            }
            else -> {
                Text(
                    stringResource(R.string.ws_wallet_balance_placeholder),
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                val detail = errorWhenNoWallet.orEmpty().trim()
                if (detail.isNotEmpty()) {
                    Spacer(Modifier.height(TTSpacing.sm))
                    Text(
                        detail,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.height(TTSpacing.sm))
                    TextButton(onClick = onBalanceRetry) {
                        Text(stringResource(R.string.common_retry))
                    }
                }
            }
        }
    }

    if (showFrozenInfo) {
        AlertDialog(
            onDismissRequest = { showFrozenInfo = false },
            title = { Text(stringResource(R.string.ws_wallet_frozen_info_title)) },
            text = { Text(stringResource(R.string.ws_wallet_frozen_info_body)) },
            confirmButton = {
                TextButton(onClick = { showFrozenInfo = false }) {
                    Text(stringResource(R.string.common_confirm))
                }
            },
        )
    }
}

@Composable
private fun TransactionRow(tx: WalletTransaction) {
    val icon = txTypeIcon(tx.transactionType)
    val errorColor = MaterialTheme.colorScheme.error
    val onSurface = MaterialTheme.colorScheme.onSurface
    val numericAmount = tx.amountPrecise?.toBigDecimalOrNull()?.toDouble() ?: tx.amount.toDouble()
    val amountColor = txAmountColor(tx.transactionType, numericAmount, errorColor, onSurface)
    val timeStr = tx.createdAt?.replace("T", " ")?.take(16) ?: ""

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.size(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                tx.description.ifBlank { tx.transactionType },
                style = MaterialTheme.typography.bodyLarge,
                maxLines = 2,
            )
            if (timeStr.isNotBlank()) {
                Text(
                    timeStr,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        val formatted = formatCreditsAuto(tx.amountPrecise, tx.amount)
        val sign = if (numericAmount > 0) "+" else ""
        Text(
            "$sign$formatted",
            style = MaterialTheme.typography.titleSmall,
            color = amountColor,
        )
    }
}

private fun txTypeIcon(type: String): ImageVector = when (type) {
    "recharge" -> Icons.Filled.AddCard
    "consume" -> Icons.Filled.RemoveShoppingCart
    else -> Icons.Filled.SwapHoriz
}

private fun txAmountColor(
    type: String,
    amount: Double,
    errorColor: Color,
    onSurface: Color,
): Color {
    val income = type in setOf("recharge", "grant", "refund", "unfreeze")
    return when {
        income && amount >= 0 -> TxGreen
        type == "consume" || amount < 0 -> errorColor
        else -> onSurface
    }
}
