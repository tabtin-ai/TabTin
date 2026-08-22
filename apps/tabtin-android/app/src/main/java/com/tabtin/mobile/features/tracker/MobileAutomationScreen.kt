package com.tabtin.mobile.features.tracker

import android.app.TimePickerDialog
import androidx.annotation.StringRes
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
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Schedule
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Agent
import com.tabtin.mobile.data.model.Space
import com.tabtin.mobile.data.model.tracker.Tracker
import com.tabtin.mobile.data.model.tracker.TrackerStatus
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.filter

internal enum class MobileAutomationStatusFilter(
    @StringRes val titleRes: Int,
    val trackerStatus: TrackerStatus? = null,
) {
    ALL(R.string.mobile_automation_all_statuses),
    ACTIVE(R.string.tracker_status_active, TrackerStatus.ACTIVE),
    PAUSED(R.string.tracker_status_paused, TrackerStatus.PAUSED),
    DRAFT(R.string.tracker_status_draft, TrackerStatus.DRAFT),
    DISABLED(R.string.tracker_status_disabled, TrackerStatus.DISABLED),
    ;
}

private enum class MobileAutomationFrequency(
    @StringRes val titleRes: Int,
    @StringRes val descriptionRes: Int,
) {
    DAILY(R.string.mobile_automation_daily, R.string.mobile_automation_daily_hint),
    WEEKDAYS(R.string.mobile_automation_weekdays, R.string.mobile_automation_weekdays_hint),
    WEEKLY(R.string.mobile_automation_weekly, R.string.mobile_automation_weekly_hint),
    MANUAL(R.string.mobile_automation_manual, R.string.mobile_automation_manual_hint),
    ;

    fun trigger(hour: Int, minute: Int): Pair<String, JsonObject> {
        if (this == MANUAL) return "manual" to JsonObject(emptyMap())
        val dayOfWeek = when (this) {
            DAILY -> "*"
            WEEKDAYS -> "1-5"
            WEEKLY -> "1"
            MANUAL -> "*"
        }
        return "cron" to JsonObject(
            mapOf(
                "cron_expression" to JsonPrimitive("$minute $hour * * $dayOfWeek"),
                "timezone" to JsonPrimitive(TimeZone.getDefault().id),
                "catchup_policy" to JsonPrimitive("skip"),
            ),
        )
    }

}

private data class MobileAutomationDraft(
    val id: String = UUID.randomUUID().toString(),
    val name: String = "",
    val instructions: String = "",
    val frequency: MobileAutomationFrequency = MobileAutomationFrequency.WEEKDAYS,
    val hour: Int = 9,
    val minute: Int = 0,
)

/**
 * 手机自动化页：日程按下一次执行时间排序。
 *
 * 不强塞桌面端周/月密集日历；用户先看“下一步会发生什么”，再点进现有 Tracker 详情看运行历史。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun MobileAutomationScreen(
    onBack: () -> Unit,
    onOpenTracker: (String) -> Unit,
    embedded: Boolean = false,
    viewModel: MobileAutomationViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsState()
    val focusManager = LocalFocusManager.current
    val keyboardController = LocalSoftwareKeyboardController.current
    var draft by remember { mutableStateOf<MobileAutomationDraft?>(null) }
    var searchQuery by remember { mutableStateOf("") }
    var selectedWorkspaceId by remember { mutableStateOf<String?>(null) }
    var statusFilter by remember { mutableStateOf(MobileAutomationStatusFilter.ALL) }
    var workspaceMenuExpanded by remember { mutableStateOf(false) }
    var statusMenuExpanded by remember { mutableStateOf(false) }
    val dismissSearchKeyboard = remember(focusManager, keyboardController) {
        {
            focusManager.clearFocus()
            keyboardController?.hide()
            Unit
        }
    }

    LaunchedEffect(state.createdTrackerId) {
        state.createdTrackerId?.let { trackerId ->
            draft = null
            viewModel.consumeCreatedTrackerId()
            onOpenTracker(trackerId)
        }
    }

    LaunchedEffect(state.workspaces, selectedWorkspaceId) {
        if (selectedWorkspaceId != null && state.workspaces.none { it.id == selectedWorkspaceId }) {
            selectedWorkspaceId = null
        }
    }

    val filteredTrackers = remember(state.trackers, searchQuery, selectedWorkspaceId, statusFilter) {
        filterMobileAutomations(
            trackers = state.trackers,
            searchQuery = searchQuery,
            workspaceId = selectedWorkspaceId,
            status = statusFilter,
        )
    }

    Scaffold(
        topBar = {
            if (!embedded) TopAppBar(
                title = { Text(stringResource(R.string.mobile_automation_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, stringResource(R.string.common_back))
                    }
                },
                actions = {
                    IconButton(onClick = { draft = MobileAutomationDraft() }) {
                        Icon(Icons.Default.Add, stringResource(R.string.mobile_automation_new))
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = state.isRefreshing,
            onRefresh = viewModel::refresh,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                TabSearchField(
                    query = searchQuery,
                    onQueryChange = { searchQuery = it },
                    placeholder = stringResource(R.string.mobile_automation_search),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                )
                AutomationFilterBar(
                    workspaces = state.workspaces,
                    selectedWorkspaceId = selectedWorkspaceId,
                    statusFilter = statusFilter,
                    workspaceMenuExpanded = workspaceMenuExpanded,
                    statusMenuExpanded = statusMenuExpanded,
                    onWorkspaceMenuExpandedChange = { workspaceMenuExpanded = it },
                    onStatusMenuExpandedChange = { statusMenuExpanded = it },
                    onWorkspaceSelected = { selectedWorkspaceId = it },
                    onStatusSelected = { statusFilter = it },
                )
                state.errorMessage?.let { message ->
                    Text(
                        message,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                    )
                }
                AutomationScheduleList(
                    trackers = filteredTrackers,
                    isLoading = state.isLoading,
                    hasActiveFilter = searchQuery.isNotBlank() ||
                        selectedWorkspaceId != null ||
                        statusFilter != MobileAutomationStatusFilter.ALL,
                    agents = state.agents,
                    onListScroll = dismissSearchKeyboard,
                    onTrackerClick = onOpenTracker,
                )
            }
        }
    }

    draft?.let { currentDraft ->
        MobileAutomationEditorSheet(
            draft = currentDraft,
            agents = state.agents,
            workspaces = state.workspaces,
            isCreating = state.isCreating,
            onDismiss = { if (!state.isCreating) draft = null },
            onCreate = viewModel::create,
        )
    }
}

@Composable
private fun AutomationScheduleList(
    trackers: List<Tracker>,
    isLoading: Boolean,
    hasActiveFilter: Boolean,
    agents: List<Agent>,
    onListScroll: () -> Unit,
    onTrackerClick: (String) -> Unit,
) {
    val listState = rememberLazyListState()
    LaunchedEffect(listState) {
        snapshotFlow { listState.isScrollInProgress }
            .filter { it }
            .collect { onListScroll() }
    }
    val sortedTrackers = remember(trackers) {
        trackers.sortedWith(
            compareBy<Tracker> { it.nextRunAt ?: "9999-12-31T23:59:59Z" }
                .thenByDescending { it.createdAt },
        )
    }
    when {
        isLoading && trackers.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            CircularProgressIndicator()
        }
        sortedTrackers.isEmpty() -> AutomationEmptyState(
            title = stringResource(
                if (hasActiveFilter) R.string.mobile_automation_search_empty else R.string.mobile_automation_empty,
            ),
            description = if (hasActiveFilter) "" else stringResource(R.string.mobile_automation_empty_hint),
            icon = Icons.Default.Schedule,
        )
        else -> LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
            item {
                Text(
                    stringResource(R.string.mobile_automation_time_order),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
                )
            }
            items(sortedTrackers, key = { it.id }) { tracker ->
                AutomationTrackerRow(
                    tracker = tracker,
                    agentName = agents.firstOrNull { it.id == tracker.agentId }?.resolvedName(),
                    onClick = { onTrackerClick(tracker.id) },
                )
            }
        }
    }
}

@Composable
private fun AutomationFilterBar(
    workspaces: List<Space>,
    selectedWorkspaceId: String?,
    statusFilter: MobileAutomationStatusFilter,
    workspaceMenuExpanded: Boolean,
    statusMenuExpanded: Boolean,
    onWorkspaceMenuExpandedChange: (Boolean) -> Unit,
    onStatusMenuExpandedChange: (Boolean) -> Unit,
    onWorkspaceSelected: (String?) -> Unit,
    onStatusSelected: (MobileAutomationStatusFilter) -> Unit,
) {
    val workspaceName = workspaces.firstOrNull { it.id == selectedWorkspaceId }?.name
        ?: stringResource(R.string.mobile_automation_all_workspaces)
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        AutomationFilterMenu(
            label = workspaceName,
            icon = Icons.Default.CalendarMonth,
            expanded = workspaceMenuExpanded,
            onExpandedChange = onWorkspaceMenuExpandedChange,
            modifier = Modifier.weight(1f),
        ) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.mobile_automation_all_workspaces)) },
                onClick = {
                    onWorkspaceSelected(null)
                    onWorkspaceMenuExpandedChange(false)
                },
            )
            workspaces.forEach { workspace ->
                DropdownMenuItem(
                    text = { Text(workspace.name) },
                    onClick = {
                        onWorkspaceSelected(workspace.id)
                        onWorkspaceMenuExpandedChange(false)
                    },
                )
            }
        }
        AutomationFilterMenu(
            label = stringResource(statusFilter.titleRes),
            icon = Icons.Default.Tune,
            expanded = statusMenuExpanded,
            onExpandedChange = onStatusMenuExpandedChange,
            modifier = Modifier.weight(1f),
        ) {
            MobileAutomationStatusFilter.entries.forEach { status ->
                DropdownMenuItem(
                    text = { Text(stringResource(status.titleRes)) },
                    onClick = {
                        onStatusSelected(status)
                        onStatusMenuExpandedChange(false)
                    },
                )
            }
        }
    }
}

@Composable
private fun AutomationFilterMenu(
    label: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    Box(modifier = modifier) {
        OutlinedButton(
            onClick = { onExpandedChange(true) },
            modifier = Modifier.fillMaxWidth(),
        ) {
            Icon(icon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(TTSpacing.xs))
            Text(label, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Default.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { onExpandedChange(false) },
        ) {
            content()
        }
    }
}

internal fun filterMobileAutomations(
    trackers: List<Tracker>,
    searchQuery: String,
    workspaceId: String?,
    status: MobileAutomationStatusFilter,
): List<Tracker> {
    val normalizedQuery = searchQuery.trim()
    return trackers.filter { tracker ->
        val matchesWorkspace = workspaceId == null || tracker.workspaceId == workspaceId || tracker.spaceId == workspaceId
        val matchesStatus = status.trackerStatus == null || tracker.status == status.trackerStatus
        val matchesSearch = tracker.matchesAutomationSearch(normalizedQuery)
        matchesWorkspace && matchesStatus && matchesSearch
    }
}

/**
 * 自动化仅以已创建的日程为搜索对象；模板不再是移动端的独立工作面。
 * 保留这个纯函数供筛选链路和跨域搜索回归测试共用。
 */
internal fun Tracker.matchesAutomationSearch(query: String): Boolean {
    val normalizedQuery = query.trim()
    return normalizedQuery.isEmpty() || listOf(
        name,
        description,
        skillKey,
        spaceName.orEmpty(),
    ).any { it.contains(normalizedQuery, ignoreCase = true) }
}

@Composable
private fun AutomationEmptyState(
    title: String,
    description: String,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(horizontal = TTSpacing.xl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(38.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(TTSpacing.sm))
        Text(title, style = MaterialTheme.typography.bodyLarge)
        if (description.isNotBlank()) {
            Spacer(Modifier.height(TTSpacing.xs))
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun AutomationTrackerRow(tracker: Tracker, agentName: String?, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.md),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            imageVector = Icons.Default.CalendarMonth,
            contentDescription = null,
            modifier = Modifier
                .size(38.dp)
                .padding(8.dp),
            tint = ttColor(TTColors.Primary, TTColors.Dark.Primary),
        )
        Spacer(Modifier.width(TTSpacing.md))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                tracker.name,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                trackerScheduleSummary(tracker),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            agentName?.let { name ->
                Text(
                    stringResource(R.string.mobile_automation_agent_runs, name),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        tracker.nextRunAt?.let { nextRunAt ->
            Text(
                displayRunTime(nextRunAt),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun MobileAutomationEditorSheet(
    draft: MobileAutomationDraft,
    agents: List<Agent>,
    workspaces: List<Space>,
    isCreating: Boolean,
    onDismiss: () -> Unit,
    onCreate: (MobileAutomationCreateInput) -> Unit,
) {
    var name by remember(draft.id) { mutableStateOf(draft.name) }
    var instructions by remember(draft.id) { mutableStateOf(draft.instructions) }
    var frequency by remember(draft.id) { mutableStateOf(draft.frequency) }
    var hour by remember(draft.id) { mutableIntStateOf(draft.hour) }
    var minute by remember(draft.id) { mutableIntStateOf(draft.minute) }
    var selectedAgentId by remember(draft.id, agents) {
        mutableStateOf(agents.firstOrNull { it.isDefault == true }?.id ?: agents.firstOrNull()?.id.orEmpty())
    }
    var selectedWorkspaceId by remember(draft.id, workspaces) { mutableStateOf(workspaces.firstOrNull()?.id.orEmpty()) }
    var agentsExpanded by remember { mutableStateOf(false) }
    var workspacesExpanded by remember { mutableStateOf(false) }
    val context = LocalContext.current

    TTBottomSheet(
        onDismissRequest = onDismiss,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text(stringResource(R.string.mobile_automation_new), style = MaterialTheme.typography.titleLarge)

            Text(stringResource(R.string.mobile_automation_task), style = MaterialTheme.typography.labelMedium)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text(stringResource(R.string.mobile_automation_name)) },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
            )
            OutlinedTextField(
                value = instructions,
                onValueChange = { instructions = it },
                label = { Text(stringResource(R.string.mobile_automation_instructions)) },
                modifier = Modifier.fillMaxWidth().height(132.dp),
                minLines = 4,
            )

            Text(stringResource(R.string.mobile_automation_executor), style = MaterialTheme.typography.labelMedium)
            Box {
                OutlinedButton(
                    onClick = { agentsExpanded = true },
                    enabled = agents.isNotEmpty() && !isCreating,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Icon(Icons.Default.SmartToy, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(TTSpacing.sm))
                    Text(
                        agents.firstOrNull { it.id == selectedAgentId }?.resolvedName()
                            ?: stringResource(R.string.mobile_automation_no_agents),
                        modifier = Modifier.weight(1f),
                    )
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = agentsExpanded, onDismissRequest = { agentsExpanded = false }) {
                    agents.forEach { agent ->
                        DropdownMenuItem(
                            text = { Text(agent.resolvedName()) },
                            onClick = {
                                agentsExpanded = false
                                selectedAgentId = agent.id
                            },
                        )
                    }
                }
            }
            Box {
                OutlinedButton(
                    onClick = { workspacesExpanded = true },
                    enabled = workspaces.isNotEmpty() && !isCreating,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(
                        workspaces.firstOrNull { it.id == selectedWorkspaceId }?.name
                            ?: stringResource(R.string.mobile_automation_no_workspaces),
                        modifier = Modifier.weight(1f),
                    )
                    Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                }
                DropdownMenu(expanded = workspacesExpanded, onDismissRequest = { workspacesExpanded = false }) {
                    workspaces.forEach { workspace ->
                        DropdownMenuItem(
                            text = { Text(workspace.name) },
                            onClick = {
                                workspacesExpanded = false
                                selectedWorkspaceId = workspace.id
                            },
                        )
                    }
                }
            }

            Text(stringResource(R.string.mobile_automation_schedule_section), style = MaterialTheme.typography.labelMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                MobileAutomationFrequency.entries.forEach { option ->
                    FilterChip(
                        selected = frequency == option,
                        onClick = { frequency = option },
                        label = { Text(stringResource(option.titleRes)) },
                        enabled = !isCreating,
                    )
                }
            }
            if (frequency != MobileAutomationFrequency.MANUAL) {
                OutlinedButton(
                    onClick = {
                        TimePickerDialog(context, { _, selectedHour, selectedMinute ->
                            hour = selectedHour
                            minute = selectedMinute
                        }, hour, minute, true).show()
                    },
                    enabled = !isCreating,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Text(stringResource(R.string.mobile_automation_run_time), modifier = Modifier.weight(1f))
                    Text(String.format(Locale.getDefault(), "%02d:%02d", hour, minute))
                }
            }
            Text(
                stringResource(frequency.descriptionRes),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Button(
                onClick = {
                    val (triggerType, triggerConfig) = frequency.trigger(hour, minute)
                    onCreate(
                        MobileAutomationCreateInput(
                            name = name,
                            instructions = instructions,
                            triggerType = triggerType,
                            triggerConfig = triggerConfig,
                            agentId = selectedAgentId,
                            workspaceId = selectedWorkspaceId,
                        ),
                    )
                },
                enabled = !isCreating &&
                    name.isNotBlank() &&
                    instructions.isNotBlank() &&
                    selectedAgentId.isNotBlank() &&
                    selectedWorkspaceId.isNotBlank(),
                modifier = Modifier.fillMaxWidth(),
            ) {
                if (isCreating) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        color = MaterialTheme.colorScheme.onPrimary,
                        strokeWidth = 2.dp,
                    )
                } else {
                    Text(stringResource(R.string.mobile_automation_create))
                }
            }
            TextButton(onClick = onDismiss, enabled = !isCreating, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.common_cancel))
            }
        }
    }
}

private fun Agent.resolvedName(): String = displayName?.takeIf { it.isNotBlank() } ?: name

@Composable
private fun trackerScheduleSummary(tracker: Tracker): String = if (tracker.triggerType == "manual") {
    stringResource(R.string.mobile_automation_manual)
} else {
    stringResource(R.string.mobile_automation_scheduled)
}

private fun displayRunTime(raw: String): String = try {
    OffsetDateTime.parse(raw)
        .atZoneSameInstant(ZoneId.systemDefault())
        .format(DateTimeFormatter.ofPattern("M/d HH:mm", Locale.getDefault()))
} catch (_: Exception) {
    raw.replace('T', ' ').take(16)
}
