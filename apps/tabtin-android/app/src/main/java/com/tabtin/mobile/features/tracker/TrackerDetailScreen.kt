package com.tabtin.mobile.features.tracker

import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunExecutionPolicy
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus
import com.tabtin.mobile.data.model.tracker.TrackerStatus
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TrackerDetailScreen(
    viewModel: TrackerDetailViewModel,
    onBack: () -> Unit,
    onOpenConversation: (String) -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }

    LaunchedEffect(state.isDeleted) {
        if (state.isDeleted) onBack()
    }

    val toastRes = state.toastRes
    if (toastRes != null) {
        val msg = stringResource(toastRes)
        LaunchedEffect(toastRes) {
            snackbarHostState.showSnackbar(msg)
            viewModel.consumeToast()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        state.tracker?.name ?: "",
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back))
                    }
                },
                actions = {
                    if (state.tracker?.capabilities?.canEdit == true) Box {
                        IconButton(onClick = { showMenu = true }) {
                            Icon(Icons.Default.MoreVert, stringResource(R.string.common_more))
                        }
                        DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                            DropdownMenuItem(
                                text = {
                                    Text(
                                        stringResource(R.string.tracker_action_delete),
                                        color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                                    )
                                },
                                leadingIcon = {
                                    Icon(
                                        Icons.Default.Delete, null,
                                        tint = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                                    )
                                },
                                onClick = {
                                    showMenu = false
                                    showDeleteConfirm = true
                                },
                            )
                        }
                    }
                },
            )
        },
        snackbarHost = { SnackbarHost(snackbarHostState) },
    ) { padding ->
        val tracker = state.tracker
        if (tracker == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                CircularProgressIndicator()
            }
            return@Scaffold
        }

        PullToRefreshBox(
            isRefreshing = state.isLoadingRuns,
            onRefresh = { viewModel.loadRuns() },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            LazyColumn(Modifier.fillMaxSize()) {
                item { TrackerHeader(tracker, state.latestRun) }
                item { ActionBar(tracker, state.latestRun, state.actionInProgress, viewModel) }

                item(key = "run-history-title") {
                    Text(
                        stringResource(R.string.tracker_detail_runs),
                        style = MaterialTheme.typography.titleMedium,
                        color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp),
                    )
                }
                val runs = state.runs
                if (runs.isEmpty() && !state.isLoadingRuns) {
                    item { EmptyPlaceholder(stringResource(R.string.tracker_detail_no_runs)) }
                } else {
                    itemsIndexed(runs, key = { _, run -> run.id }) { _, run ->
                        TrackerRunCard(run, onOpenConversation)
                    }
                }

                item { Spacer(Modifier.height(80.dp)) }
            }
        }
    }

    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { showDeleteConfirm = false },
            title = { Text(stringResource(R.string.tracker_action_delete)) },
            text = { Text(stringResource(R.string.tracker_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    showDeleteConfirm = false
                    viewModel.deleteTracker()
                }) {
                    Text(
                        stringResource(R.string.tracker_action_delete),
                        color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDeleteConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun TrackerHeader(tracker: Tracker, latestRun: TrackerRun?) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TrackerStatusBadge(tracker.status)
            Spacer(Modifier.weight(1f))
        }

        if (tracker.description.isNotEmpty()) {
            Spacer(Modifier.height(8.dp))
            Text(
                tracker.description,
                style = MaterialTheme.typography.bodyMedium,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }

        if (latestRun != null) {
            val progress = TrackerRunProgressPresentation.from(latestRun)
            Spacer(Modifier.height(12.dp))
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(8.dp))
                    .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle))
                    .padding(12.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    RunStatusBadge(latestRun.status)
                    Spacer(Modifier.weight(1f))
                    progress.percent?.let { percent ->
                        Text(
                            stringResource(R.string.tracker_progress_percent, percent),
                            style = MaterialTheme.typography.labelSmall,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
                progress.fraction?.let { fraction ->
                    Spacer(Modifier.height(8.dp))
                    LinearProgressIndicator(
                        progress = { fraction },
                        modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
                        color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                        trackColor = ttColor(TTColors.BorderLight, TTColors.Dark.BorderLight),
                    )
                }
                progress.message?.let { message ->
                    Text(
                        message,
                        style = MaterialTheme.typography.bodySmall,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun ActionBar(
    tracker: Tracker,
    latestRun: TrackerRun?,
    actionInProgress: String?,
    viewModel: TrackerDetailViewModel,
) {
    val isDisabled = actionInProgress != null
    val triggerBlockedByActiveRun = !TrackerRunExecutionPolicy.canTrigger(latestRun)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            if (tracker.status == TrackerStatus.ACTIVE && tracker.capabilities.canTrigger) {
                ActionButton(
                    stringResource(R.string.tracker_action_trigger),
                    Icons.Default.PlayArrow,
                    isDisabled || triggerBlockedByActiveRun,
                ) {
                    viewModel.triggerTracker()
                }
            }
            if (tracker.status == TrackerStatus.ACTIVE && tracker.capabilities.canEdit) {
                ActionButton(stringResource(R.string.tracker_action_pause), Icons.Default.Pause, isDisabled) {
                    viewModel.pauseTracker()
                }
            }
            if (tracker.status == TrackerStatus.PAUSED && tracker.capabilities.canEdit) {
                ActionButton(stringResource(R.string.tracker_action_resume), Icons.Default.PlayArrow, isDisabled) {
                    viewModel.resumeTracker()
                }
            }
            if (tracker.status == TrackerStatus.DRAFT && tracker.capabilities.canEdit) {
                ActionButton(stringResource(R.string.tracker_action_activate), Icons.Default.Bolt, isDisabled) {
                    viewModel.activateTracker()
                }
            }
            if (latestRun != null && !latestRun.status.isTerminal && latestRun.capabilities.canCancel) {
                ActionButton(stringResource(R.string.tracker_action_cancel), Icons.Default.Stop, isDisabled) {
                    viewModel.cancelRun(latestRun.id)
                }
            }
        }
        if (triggerBlockedByActiveRun && tracker.status == TrackerStatus.ACTIVE && tracker.capabilities.canTrigger) {
            Text(
                stringResource(R.string.tracker_trigger_blocked_active_run),
                modifier = Modifier.padding(top = 8.dp),
                style = MaterialTheme.typography.labelSmall,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
            )
        }
    }
}

@Composable
private fun ActionButton(
    text: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    disabled: Boolean,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(ttColor(TTColors.Primary, TTColors.Dark.Primary).copy(alpha = if (disabled) 0.5f else 1f))
            .clickable(enabled = !disabled, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            icon, null,
            modifier = Modifier.size(16.dp),
            tint = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
        )
        Spacer(Modifier.width(4.dp))
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
        )
    }
}

@Composable
private fun EmptyPlaceholder(text: String) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 48.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text,
            style = MaterialTheme.typography.bodyMedium,
            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
        )
    }
}

@Composable
private fun TrackerRunCard(run: TrackerRun, onOpenConversation: (String) -> Unit) {
    val progress = TrackerRunProgressPresentation.from(run)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            RunStatusBadge(run.status)
            Spacer(Modifier.weight(1f))
            progress.percent?.let { percent ->
                Text(
                    stringResource(R.string.tracker_progress_percent, percent),
                    style = MaterialTheme.typography.labelSmall,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
            run.duration?.let { d ->
                Spacer(Modifier.width(8.dp))
                Text(
                    formatDuration(d),
                    style = MaterialTheme.typography.labelSmall,
                    color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                )
            }
        }
        progress.message?.let { message ->
            Text(
                message,
                style = MaterialTheme.typography.bodySmall,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        run.resultSummary.takeIf { run.status == TrackerRunStatus.COMPLETED && it.isNotBlank() }?.let { result ->
            Text(
                result,
                style = MaterialTheme.typography.bodySmall,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        run.errorSummary.takeIf { it.isNotBlank() }?.let { error ->
            Text(
                error,
                style = MaterialTheme.typography.bodySmall,
                color = ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
        run.chatSessionId?.takeIf { it.isNotBlank() }?.let { sessionId ->
            TextButton(
                onClick = { onOpenConversation(sessionId) },
                modifier = Modifier.padding(top = 2.dp),
            ) {
                Text(stringResource(R.string.tracker_open_conversation))
            }
        }
    }
}

private fun formatDuration(seconds: Double): String {
    if (seconds < 60) return "${seconds.toInt()}s"
    val m = seconds.toInt() / 60
    val s = seconds.toInt() % 60
    return "${m}m ${s}s"
}
