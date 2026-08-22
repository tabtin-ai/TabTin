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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.OutlinedTextField
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.tracker.AttentionReason
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerAttentionItem
import com.tabtin.mobile.data.model.tracker.TrackerRun
import com.tabtin.mobile.data.model.tracker.TrackerRunStatus
import com.tabtin.mobile.data.model.tracker.TrackerStatus
import com.tabtin.mobile.ui.components.TTFormSheet
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.ttColor

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun TrackerScreen(
    viewModel: TrackerListViewModel,
    onTrackerClick: (String) -> Unit,
    onBack: () -> Unit,
) {
    val state by viewModel.uiState.collectAsState()
    val lifecycleState by LocalLifecycleOwner.current.lifecycle.currentStateFlow.collectAsState()
    val snackbarHostState = remember { SnackbarHostState() }
    var goalToDelete by remember { mutableStateOf<Tracker?>(null) }

    LaunchedEffect(lifecycleState) {
        if (lifecycleState.isAtLeast(Lifecycle.State.RESUMED)) {
            viewModel.onScreenResumed()
        }
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
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.common_back),
                        )
                    }
                },
                title = { Text(stringResource(R.string.tracker_screen_title)) },
            )
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            when {
                state.isLoading && state.trackers.isEmpty() -> {
                    Column(
                        Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        CircularProgressIndicator()
                        Spacer(Modifier.height(16.dp))
                        Text(
                            stringResource(R.string.common_loading),
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                    }
                }
                state.errorRes != null && state.trackers.isEmpty() -> {
                    Column(
                        Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        Text(
                            stringResource(R.string.common_loading_failed),
                            style = MaterialTheme.typography.titleMedium,
                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        )
                        Spacer(Modifier.height(8.dp))
                        TextButton(onClick = { viewModel.loadTrackers(isInitial = true) }) {
                            Text(stringResource(R.string.common_retry))
                        }
                    }
                }
                else -> {
                    PullToRefreshBox(
                        isRefreshing = state.isRefreshing,
                        onRefresh = { viewModel.refresh() },
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        LazyColumn(Modifier.fillMaxSize()) {
                            item {
                                SectionHeader(
                                    title = stringResource(R.string.tracker_section_attention),
                                    count = state.attentionItems.size,
                                    countColor = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning),
                                )
                            }
                            items(state.attentionItems, key = { it.id }) { item ->
                                AttentionTrackerCard(item = item, onClick = { onTrackerClick(item.tracker.id) })
                            }
                            item { Spacer(Modifier.height(16.dp)) }

                            item {
                                SectionHeader(
                                    title = stringResource(R.string.tracker_section_running),
                                    count = state.runningTrackers.size,
                                    countColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                                )
                            }
                            items(state.runningTrackers, key = { it.first.id }) { (tracker, run) ->
                                RunningTrackerCard(tracker = tracker, run = run, onClick = { onTrackerClick(tracker.id) })
                            }
                            item { Spacer(Modifier.height(16.dp)) }

                            item {
                                SectionHeader(title = stringResource(R.string.tracker_section_all))
                            }
                            if (state.trackers.isEmpty()) {
                                item {
                                    Column(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(horizontal = 24.dp, vertical = 40.dp),
                                        horizontalAlignment = Alignment.CenterHorizontally,
                                    ) {
                                        Text(
                                            stringResource(R.string.tracker_empty),
                                            style = MaterialTheme.typography.titleMedium,
                                            color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                                        )
                                        Spacer(Modifier.height(8.dp))
                                        Text(
                                            stringResource(R.string.tracker_empty_hint),
                                            style = MaterialTheme.typography.bodyMedium,
                                            color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                                        )
                                    }
                                }
                            } else {
                                items(state.trackers, key = { it.id }) { tracker ->
                                    TrackerListCard(
                                        tracker = tracker,
                                        latestRun = state.latestRuns[tracker.id],
                                        onClick = { onTrackerClick(tracker.id) },
                                        onTrigger = { viewModel.triggerTracker(tracker.id) },
                                        onPause = { viewModel.pauseTracker(tracker.id) },
                                        onResume = { viewModel.resumeTracker(tracker.id) },
                                        onActivate = { viewModel.activateTracker(tracker.id) },
                                        onDelete = { goalToDelete = tracker },
                                        isActionInProgress = state.actionInProgress != null,
                                    )
                                }
                            }

                            item { Spacer(Modifier.height(80.dp)) }
                        }
                    }
                }
            }

            FloatingActionButton(
                onClick = viewModel::showCreateDialog,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(16.dp),
                containerColor = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                contentColor = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
            ) {
                Icon(Icons.Default.Add, contentDescription = stringResource(R.string.tracker_new))
            }

            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter),
            )
        }
    }

    if (state.showCreateDialog) {
        TTFormSheet(
            onDismissRequest = viewModel::dismissCreateDialog,
            dismissEnabled = !state.isCreating,
            title = { Text(stringResource(R.string.tracker_create_title)) },
            content = {
                OutlinedTextField(
                    value = state.createName,
                    onValueChange = viewModel::setCreateName,
                    label = { Text(stringResource(R.string.tracker_create_name)) },
                    placeholder = { Text(stringResource(R.string.tracker_create_name_hint)) },
                    singleLine = true,
                    enabled = !state.isCreating,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = state.createDescription,
                    onValueChange = viewModel::setCreateDescription,
                    label = { Text(stringResource(R.string.tracker_create_desc)) },
                    minLines = 2,
                    maxLines = 5,
                    enabled = !state.isCreating,
                    modifier = Modifier.fillMaxWidth(),
                )
                state.createErrorRes?.let { errorRes ->
                    Text(
                        text = stringResource(errorRes),
                        style = MaterialTheme.typography.bodySmall,
                        color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical),
                    )
                }
            },
            actions = {
                TextButton(
                    onClick = viewModel::dismissCreateDialog,
                    enabled = !state.isCreating,
                ) {
                    Text(stringResource(R.string.common_cancel))
                }
                TextButton(
                    onClick = viewModel::createTracker,
                    enabled = !state.isCreating && state.createName.isNotBlank(),
                ) {
                    if (state.isCreating) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(18.dp),
                            strokeWidth = 2.dp,
                        )
                        Spacer(Modifier.width(8.dp))
                        Text(stringResource(R.string.common_loading))
                    } else {
                        Text(stringResource(R.string.common_save))
                    }
                }
            },
        )
    }

    goalToDelete?.let { tracker ->
        AlertDialog(
            onDismissRequest = { goalToDelete = null },
            title = { Text(stringResource(R.string.tracker_action_delete)) },
            text = { Text(stringResource(R.string.tracker_delete_confirm)) },
            confirmButton = {
                TextButton(onClick = {
                    viewModel.deleteTracker(tracker.id)
                    goalToDelete = null
                }) {
                    Text(stringResource(R.string.tracker_action_delete), color = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical))
                }
            },
            dismissButton = {
                TextButton(onClick = { goalToDelete = null }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
}

@Composable
private fun SectionHeader(
    title: String,
    count: Int? = null,
    countColor: androidx.compose.ui.graphics.Color? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            title,
            style = MaterialTheme.typography.titleSmall,
            color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
        )
        if (count != null && countColor != null) {
            Spacer(Modifier.width(8.dp))
            Text(
                "$count",
                style = MaterialTheme.typography.labelSmall,
                color = ttColor(TTColors.TextOnPrimary, TTColors.Dark.TextOnPrimary),
                modifier = Modifier
                    .background(countColor, CircleShape)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
    }
}

@Composable
private fun AttentionTrackerCard(item: TrackerAttentionItem, onClick: () -> Unit) {
    val warningColor = ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
    val criticalColor = ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
    val iconColor = if (item.reason == AttentionReason.CHECKPOINT) warningColor else criticalColor

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(iconColor.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                if (item.reason == AttentionReason.CHECKPOINT) "✋" else "⚠️",
                style = MaterialTheme.typography.titleMedium,
            )
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(
                item.tracker.name,
                style = MaterialTheme.typography.bodyLarge,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                if (item.reason == AttentionReason.CHECKPOINT)
                    stringResource(R.string.tracker_attention_checkpoint)
                else
                    stringResource(R.string.tracker_attention_failed),
                style = MaterialTheme.typography.bodySmall,
                color = iconColor,
            )
        }
        Icon(
            Icons.Default.ChevronRight,
            contentDescription = null,
            tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
            modifier = Modifier.size(20.dp),
        )
    }
}

@Composable
private fun RunningTrackerCard(tracker: Tracker, run: TrackerRun, onClick: () -> Unit) {
    val progress = TrackerRunProgressPresentation.from(run)
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                tracker.name,
                style = MaterialTheme.typography.bodyLarge,
                color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            progress.percent?.let { percent ->
                Text(
                    stringResource(R.string.tracker_progress_percent, percent),
                    style = MaterialTheme.typography.labelSmall,
                    color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                )
            }
        }
        progress.message?.let { message ->
            Text(
                message,
                modifier = Modifier.padding(top = 4.dp),
                style = MaterialTheme.typography.bodySmall,
                color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        progress.fraction?.let { fraction ->
            Spacer(Modifier.height(8.dp))
            LinearProgressIndicator(
                progress = { fraction },
                modifier = Modifier.fillMaxWidth().height(4.dp).clip(RoundedCornerShape(2.dp)),
                color = ttColor(TTColors.Primary, TTColors.Dark.Primary),
                trackColor = ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle),
            )
        }
    }
}

@Composable
private fun TrackerListCard(
    tracker: Tracker,
    latestRun: TrackerRun?,
    onClick: () -> Unit,
    onTrigger: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onActivate: () -> Unit,
    onDelete: () -> Unit,
    isActionInProgress: Boolean,
) {
    var showMenu by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier
                .size(40.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(ttColor(TTColors.BgSubtle, TTColors.Dark.BgSubtle)),
            contentAlignment = Alignment.Center,
        ) {
            Text(triggerTypeEmoji(tracker.triggerType), style = MaterialTheme.typography.titleMedium)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    tracker.name,
                    style = MaterialTheme.typography.bodyMedium,
                    color = ttColor(TTColors.TextPrimary, TTColors.Dark.TextPrimary),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.width(8.dp))
                TrackerStatusBadge(tracker.status)
            }
            Spacer(Modifier.height(2.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (tracker.description.isNotEmpty()) {
                    Text(
                        tracker.description,
                        style = MaterialTheme.typography.bodySmall,
                        color = ttColor(TTColors.TextSecondary, TTColors.Dark.TextSecondary),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.width(8.dp))
                } else {
                    Spacer(Modifier.weight(1f))
                }
                if (latestRun != null) {
                    RunStatusBadge(latestRun.status)
                } else {
                    Text(
                        stringResource(R.string.tracker_runs_count, tracker.totalRuns),
                        style = MaterialTheme.typography.labelSmall,
                        color = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                    )
                }
            }
        }

        if (tracker.capabilities.canEdit || tracker.capabilities.canTrigger) Box {
            Icon(
                Icons.Default.MoreVert,
                contentDescription = null,
                tint = ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary),
                modifier = Modifier
                    .size(20.dp)
                    .clickable(enabled = !isActionInProgress) { showMenu = true },
            )
            DropdownMenu(expanded = showMenu, onDismissRequest = { showMenu = false }) {
                if (tracker.status == TrackerStatus.ACTIVE && tracker.capabilities.canTrigger) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tracker_action_trigger)) },
                        leadingIcon = { Icon(Icons.Default.PlayArrow, null) },
                        onClick = { showMenu = false; onTrigger() },
                    )
                }
                if (tracker.status == TrackerStatus.ACTIVE && tracker.capabilities.canEdit) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tracker_action_pause)) },
                        leadingIcon = { Icon(Icons.Default.Pause, null) },
                        onClick = { showMenu = false; onPause() },
                    )
                }
                if (tracker.status == TrackerStatus.PAUSED && tracker.capabilities.canEdit) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tracker_action_resume)) },
                        leadingIcon = { Icon(Icons.Default.PlayArrow, null) },
                        onClick = { showMenu = false; onResume() },
                    )
                }
                if (tracker.status == TrackerStatus.DRAFT && tracker.capabilities.canEdit) {
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tracker_action_activate)) },
                        leadingIcon = { Icon(Icons.Default.Bolt, null) },
                        onClick = { showMenu = false; onActivate() },
                    )
                }
                if (tracker.capabilities.canEdit) DropdownMenuItem(
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
                    onClick = { showMenu = false; onDelete() },
                )
            }
        }
    }
}

@Composable
public fun TrackerStatusBadge(status: TrackerStatus) {
    val (text, color) = when (status) {
        TrackerStatus.DRAFT -> stringResource(R.string.tracker_status_draft) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
        TrackerStatus.ACTIVE -> stringResource(R.string.tracker_status_active) to
            ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
        TrackerStatus.PAUSED -> stringResource(R.string.tracker_status_paused) to
            ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
        TrackerStatus.DISABLED -> stringResource(R.string.tracker_status_disabled) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
        TrackerStatus.ARCHIVED -> stringResource(R.string.tracker_status_archived) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
        TrackerStatus.UNKNOWN -> stringResource(R.string.tracker_status_unknown) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(color),
        )
        Spacer(Modifier.width(4.dp))
        Text(text, style = MaterialTheme.typography.labelSmall, color = color)
    }
}

@Composable
public fun RunStatusBadge(status: TrackerRunStatus) {
    val (text, color) = when (status) {
        TrackerRunStatus.PENDING -> stringResource(R.string.tracker_run_pending) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
        TrackerRunStatus.RUNNING -> stringResource(R.string.tracker_run_running) to
            ttColor(TTColors.Primary, TTColors.Dark.Primary)
        TrackerRunStatus.WAITING_CHECKPOINT -> stringResource(R.string.tracker_run_checkpoint) to
            ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
        TrackerRunStatus.WAITING_DEVICE -> stringResource(R.string.tracker_run_waiting_device) to
            ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
        TrackerRunStatus.UNKNOWN -> stringResource(R.string.tracker_run_unknown) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
        TrackerRunStatus.COMPLETED -> stringResource(R.string.tracker_run_completed) to
            ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
        TrackerRunStatus.PARTIAL_FAILED -> stringResource(R.string.tracker_run_partial_failed) to
            ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
        TrackerRunStatus.FAILED -> stringResource(R.string.tracker_run_failed) to
            ttColor(TTColors.BgCritical, TTColors.Dark.BgCritical)
        TrackerRunStatus.CANCELLED -> stringResource(R.string.tracker_run_cancelled) to
            ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
    }
    Text(text, style = MaterialTheme.typography.labelSmall, color = color)
}

private fun triggerTypeEmoji(triggerType: String): String = when (triggerType) {
    "manual" -> "👆"
    "cron" -> "🕐"
    "interval" -> "⏱"
    "extension_event" -> "🧩"
    "table_event" -> "📊"
    "webhook" -> "📡"
    "goal_completed" -> "✅"
    else -> "⚙️"
}
