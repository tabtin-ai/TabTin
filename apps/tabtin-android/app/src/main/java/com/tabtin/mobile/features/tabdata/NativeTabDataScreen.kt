package com.tabtin.mobile.features.tabdata

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.automirrored.filled.Sort
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDownward
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.DeleteOutline
import androidx.compose.material.icons.filled.FilterAlt
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.TableRows
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.layout.SubcomposeLayout
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil.compose.AsyncImage
import com.tabtin.mobile.R
import com.tabtin.mobile.data.im.ImResourceCardType
import com.tabtin.mobile.data.model.tabdata.TabDataChoice
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFilterRule
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup
import com.tabtin.mobile.data.model.tabdata.TabDataSortRule
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.features.tabchat.ResourceDirectMessageResource
import com.tabtin.mobile.features.tabchat.ResourceDirectMessageShareSheet
import com.tabtin.mobile.ui.components.IdentityColorAvatar
import com.tabtin.mobile.ui.components.TTBottomSheet
import com.tabtin.mobile.ui.components.TTSheetColumn
import com.tabtin.mobile.ui.components.TabSearchField
import com.tabtin.mobile.ui.components.rememberTTSheetState
import com.tabtin.mobile.ui.theme.IdentityAvatar
import com.tabtin.mobile.ui.theme.TTColors
import com.tabtin.mobile.ui.theme.TTFonts
import com.tabtin.mobile.ui.theme.TTRadius
import com.tabtin.mobile.ui.theme.TTSpacing
import com.tabtin.mobile.ui.theme.ttColor
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull

@OptIn(ExperimentalMaterial3Api::class)
@Composable
public fun NativeTabDataScreen(
    onBack: () -> Unit,
    onOpenFullEditor: () -> Unit,
    onFocusChanged: (tableId: String, viewId: String?) -> Unit = { _, _ -> },
    viewModel: NativeTabDataViewModel = hiltViewModel(),
) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val snackbarHostState = remember { SnackbarHostState() }
    val context = LocalContext.current
    val coroutineScope = rememberCoroutineScope()
    var showFilterSheet by remember { mutableStateOf(false) }
    var showSortSheet by remember { mutableStateOf(false) }
    var showCreateFieldSheet by remember { mutableStateOf(false) }
    var detailVisible by remember { mutableStateOf(false) }
    var showDeleteConfirm by remember { mutableStateOf(false) }
    var showDiscardDraftsConfirm by remember { mutableStateOf(false) }
    var showNeighborDraftConfirm by remember { mutableStateOf(false) }
    var pendingNeighborId by remember { mutableStateOf<String?>(null) }
    var neighborSaveRequested by remember { mutableStateOf(false) }
    var directMessageResource by remember { mutableStateOf<ResourceDirectMessageResource?>(null) }

    LaunchedEffect(viewModel) {
        viewModel.events.collect { event ->
            when (event) {
                NativeTabDataEvent.OpenFullEditor -> onOpenFullEditor()
                NativeTabDataEvent.CloseDetail -> {
                    val nextId = pendingNeighborId.takeIf { neighborSaveRequested }
                    pendingNeighborId = null
                    neighborSaveRequested = false
                    if (nextId != null) {
                        viewModel.openVisibleRecord(nextId)
                        detailVisible = true
                    } else {
                        detailVisible = false
                    }
                }
                NativeTabDataEvent.FieldCreated -> showCreateFieldSheet = false
                is NativeTabDataEvent.FullEditorBlocked -> {
                    snackbarHostState.showSnackbar(context.getString(event.messageRes))
                }
                NativeTabDataEvent.ConfirmDiscardDraftsForFullEditor -> {
                    showDiscardDraftsConfirm = true
                }
            }
        }
    }
    // 视图焦点是页面状态，不是一次性事件。由 StateFlow 驱动可确保首个默认视图即使
    // 在 collector 挂载前加载完成，也仍会上报 current_view_id。
    LaunchedEffect(state.table?.id, state.selectedViewId) {
        state.table?.id?.let { loadedTableId ->
            onFocusChanged(loadedTableId, state.selectedViewId)
        }
    }
    val mutationMessageRes = state.mutationMessageRes
    val mutationMessageCount = state.mutationMessageCount
    val fieldSeparator = stringResource(R.string.tabdata_field_name_separator)
    val mutationMessageArg = state.mutationMessageFields
        .takeIf { it.isNotEmpty() }
        ?.joinToString(fieldSeparator)
    val mutationMessage = when {
        mutationMessageRes != null && mutationMessageArg != null && mutationMessageCount != null -> {
            stringResource(mutationMessageRes, mutationMessageArg, mutationMessageCount)
        }
        mutationMessageRes != null && mutationMessageArg != null -> {
            stringResource(mutationMessageRes, mutationMessageArg)
        }
        mutationMessageRes != null -> stringResource(mutationMessageRes)
        else -> state.mutationMessage
    }
    LaunchedEffect(mutationMessage) {
        val message = mutationMessage ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(message)
        viewModel.consumeMessage()
    }
    LaunchedEffect(state.detailErrors) {
        if (state.detailErrors.isNotEmpty()) {
            pendingNeighborId = null
            neighborSaveRequested = false
        }
    }
    androidx.lifecycle.compose.LifecycleResumeEffect(Unit) {
        viewModel.refreshOnResume()
        onPauseOrDispose { }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background,
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            NativeTabDataTopBar(
                title = state.table?.name ?: stringResource(R.string.tabdata_title),
                subtitle = state.selectedView?.name.takeIf { state.views.size > 1 },
                saveState = TabDataSaveIndicatorPolicy.fromUi(state),
                onRetrySave = viewModel::saveDetail,
                onBack = onBack,
                onRefresh = viewModel::refresh,
                canCreateField = state.canWrite,
                onCreateField = {
                    viewModel.clearFieldCreationError()
                    showCreateFieldSheet = true
                },
                onSendToDirectMessage = state.table
                    ?.takeIf { !it.organizationId.isNullOrBlank() }
                    ?.let { table ->
                        {
                            directMessageResource = ResourceDirectMessageResource(
                                resourceType = ImResourceCardType.TABLE,
                                resourceId = table.id,
                                name = table.name.ifBlank { context.getString(R.string.tabdata_title) },
                                organizationId = table.organizationId.orEmpty(),
                                spaceId = table.spaceId,
                                currentUserRole = table.currentUserRole,
                            )
                        }
                    },
                onOpenFullEditor = viewModel::requestFullEditor,
            )
        },
        floatingActionButton = {
            if ((state.canWrite || state.hasResumableCreationDraft) &&
                state.selectedView?.supportsNativeCards == true
            ) {
                ExtendedFloatingActionButton(
                    onClick = {
                        viewModel.beginCreate()
                        detailVisible = true
                    },
                    icon = { Icon(if (state.canWrite) Icons.Default.Add else Icons.Default.TableRows, contentDescription = null) },
                    text = {
                        Text(
                            stringResource(
                                if (state.canWrite) R.string.tabdata_add_record
                                else R.string.tabdata_resume_read_only_draft
                            ),
                            style = TTFonts.bodyMedium,
                        )
                    },
                )
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (state.views.size > 1) {
                TabDataViewStrip(
                    views = state.views,
                    selectedViewId = state.selectedViewId,
                    onSelect = viewModel::selectView,
                )
            }
            if (state.selectedView?.supportsNativeCards == true) {
                Column(
                    modifier = Modifier.padding(horizontal = TTSpacing.lg),
                    verticalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                ) {
                    Spacer(Modifier.height(TTSpacing.xs))
                    TabSearchField(
                        query = state.searchText,
                        onQueryChange = viewModel::updateSearch,
                        placeholder = stringResource(R.string.tabdata_search_records),
                    )
                    TabDataQueryToolbar(
                        filters = state.filters,
                        sorts = state.sorts,
                        onFilters = { showFilterSheet = true },
                        onSorts = { showSortSheet = true },
                        onRemoveFilter = viewModel::removeFilter,
                        onClearSort = viewModel::clearSort,
                    )
                }
            }

            Box(modifier = Modifier.fillMaxSize()) {
                when {
                    state.isLoading -> TabDataLoadingState()
                    state.errorRes != null || state.errorMessage != null -> TabDataErrorState(
                        message = state.errorRes?.let { stringResource(it) }
                            ?: state.errorMessage.orEmpty(),
                        offlineDrafts = state.offlineDrafts,
                        onRetry = viewModel::loadInitial,
                        onOpenFullEditor = viewModel::requestFullEditor,
                        onOpenOfflineDraft = {
                            viewModel.openOfflineDraft(it)
                            detailVisible = true
                        },
                    )
                    state.selectedView == null -> TabDataEmptyState(
                        kind = TabDataEmptyKind.NO_VIEWS,
                        onOpenFullEditor = viewModel::requestFullEditor,
                    )
                    state.selectedView?.supportsNativeCards != true -> TabDataFullModeState(
                        view = state.selectedView!!,
                        onOpenFullEditor = viewModel::requestFullEditor,
                    )
                    state.selectedView?.let {
                        TabDataSurfacePolicy.kind(it.viewType)
                    } == TabDataSurfaceKind.KANBAN -> TabDataKanbanList(
                        state = state,
                        onRefresh = viewModel::refresh,
                        onOpenRecord = {
                            viewModel.openRecord(it)
                            detailVisible = true
                        },
                        onCreateInGroup = { group ->
                            viewModel.beginCreateFromGroup(group)
                            detailVisible = true
                        },
                        onLoadMoreGroup = viewModel::loadMoreGroup,
                    )
                    else -> TabDataCardList(
                        state = state,
                        onRefresh = viewModel::refresh,
                        onOpenRecord = {
                            viewModel.openRecord(it)
                            detailVisible = true
                        },
                        onLoadMore = viewModel::loadMore,
                    )
                }
            }
        }
    }

    if (showFilterSheet) {
        TabDataFilterSheet(
            fields = state.fields,
            rules = state.filters,
            logic = state.filterLogic,
            onAdd = viewModel::addFilter,
            onRemove = viewModel::removeFilter,
            onClear = viewModel::clearFilters,
            onLogicChange = viewModel::setFilterLogic,
            onDismiss = { showFilterSheet = false },
        )
    }
    if (showSortSheet) {
        TabDataSortSheet(
            fields = state.fields,
            rules = state.sorts,
            onSelect = viewModel::setSort,
            onClear = viewModel::clearSort,
            onDismiss = { showSortSheet = false },
        )
    }
    if (showCreateFieldSheet) {
        TabDataCreateFieldSheet(
            fields = state.fields,
            canCreate = state.canWrite,
            isCreating = state.isCreatingField,
            errorMessage = state.fieldCreationErrorRes?.let { stringResource(it) }
                ?: state.fieldCreationError,
            onCreate = viewModel::createField,
            onDismiss = { if (!state.isCreatingField) showCreateFieldSheet = false },
        )
    }
    if (detailVisible) {
        TabDataRecordDetailSheet(
            state = state,
            onDismiss = {
                pendingNeighborId = null
                neighborSaveRequested = false
                detailVisible = false
                viewModel.dismissDetail()
            },
            onChange = { field, value ->
                pendingNeighborId = null
                neighborSaveRequested = false
                viewModel.updateDraft(field, value)
            },
            onSave = {
                pendingNeighborId = null
                neighborSaveRequested = false
                viewModel.saveDetail()
            },
            onDelete = {
                pendingNeighborId = null
                neighborSaveRequested = false
                showDeleteConfirm = true
            },
            onOpenFullEditor = viewModel::requestFullEditor,
            onSearchMembers = viewModel::searchPickerMembers,
            onOpenNeighbor = { recordId ->
                if (state.isDetailDirty || state.isCreating) {
                    pendingNeighborId = recordId
                    showNeighborDraftConfirm = true
                } else {
                    viewModel.openVisibleRecord(recordId)
                }
            },
        )
    }
    if (showDeleteConfirm) {
        AlertDialog(
            onDismissRequest = { if (!state.isDeleting) showDeleteConfirm = false },
            title = { Text(stringResource(R.string.tabdata_delete_record_title), style = TTFonts.subtitleSemibold) },
            text = { Text(stringResource(R.string.tabdata_delete_record_message), style = TTFonts.body) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDeleteConfirm = false
                        viewModel.deleteRecord()
                    },
                    enabled = !state.isDeleting,
                ) { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { showDeleteConfirm = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    if (showNeighborDraftConfirm) {
        AlertDialog(
            onDismissRequest = {
                showNeighborDraftConfirm = false
                pendingNeighborId = null
                neighborSaveRequested = false
            },
            title = { Text(stringResource(R.string.tabdata_unsaved_changes), style = TTFonts.subtitleSemibold) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showNeighborDraftConfirm = false
                        neighborSaveRequested = true
                        viewModel.saveDetail()
                    },
                ) { Text(stringResource(R.string.common_save)) }
            },
            dismissButton = {
                Row {
                    TextButton(
                        onClick = {
                            val nextId = pendingNeighborId
                            showNeighborDraftConfirm = false
                            pendingNeighborId = null
                            neighborSaveRequested = false
                            viewModel.discardCurrentDetailDraft()
                            nextId?.let(viewModel::openVisibleRecord)
                        },
                    ) { Text(stringResource(R.string.tabdata_discard_and_continue)) }
                    TextButton(
                        onClick = {
                            showNeighborDraftConfirm = false
                            pendingNeighborId = null
                            neighborSaveRequested = false
                        },
                    ) { Text(stringResource(R.string.common_cancel)) }
                }
            },
        )
    }
    if (showDiscardDraftsConfirm) {
        AlertDialog(
            onDismissRequest = { showDiscardDraftsConfirm = false },
            title = { Text(stringResource(R.string.tabdata_discard_drafts_title), style = TTFonts.subtitleSemibold) },
            text = { Text(stringResource(R.string.tabdata_discard_drafts_message), style = TTFonts.body) },
            confirmButton = {
                TextButton(
                    onClick = {
                        showDiscardDraftsConfirm = false
                        detailVisible = false
                        viewModel.discardTableDraftsAndOpenFullEditor()
                    },
                ) {
                    Text(
                        stringResource(R.string.tabdata_discard_drafts_and_open),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            },
            dismissButton = {
                TextButton(onClick = { showDiscardDraftsConfirm = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        )
    }
    directMessageResource?.let { resource ->
        ResourceDirectMessageShareSheet(
            resource = resource,
            onDismiss = { directMessageResource = null },
            onSent = { recipientName ->
                directMessageResource = null
                coroutineScope.launch {
                    snackbarHostState.showSnackbar(
                        context.getString(R.string.resource_dm_share_sent, recipientName),
                    )
                }
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NativeTabDataTopBar(
    title: String,
    subtitle: String?,
    saveState: TabDataSaveIndicatorState,
    onRetrySave: () -> Unit,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    canCreateField: Boolean,
    onCreateField: () -> Unit,
    onSendToDirectMessage: (() -> Unit)?,
    onOpenFullEditor: () -> Unit,
) {
    var menuExpanded by remember { mutableStateOf(false) }
    TopAppBar(
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
        navigationIcon = {
            IconButton(onClick = onBack) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
            }
        },
        title = {
            Column {
                Text(title, style = TTFonts.titleSemibold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                subtitle?.let {
                    Text(it, style = TTFonts.caption, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
        },
        actions = {
            val saveColor = when (saveState) {
                TabDataSaveIndicatorState.IDLE -> ttColor(TTColors.TextTertiary, TTColors.Dark.TextTertiary)
                TabDataSaveIndicatorState.DIRTY -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
                TabDataSaveIndicatorState.SAVING -> ttColor(TTColors.Primary, TTColors.Dark.Primary)
                TabDataSaveIndicatorState.SAVED -> ttColor(TTColors.TextSuccess, TTColors.Dark.TextSuccess)
                TabDataSaveIndicatorState.FAILED -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
                TabDataSaveIndicatorState.CONFLICT -> ttColor(TTColors.BgWarning, TTColors.Dark.BgWarning)
                TabDataSaveIndicatorState.PERMISSION_DENIED -> ttColor(TTColors.TextCritical, TTColors.Dark.TextCritical)
            }
            if (TabDataSaveIndicatorPolicy.shows(saveState) && saveState.labelRes != 0) {
                Text(
                    stringResource(saveState.labelRes),
                    style = TTFonts.caption,
                    color = saveColor,
                    modifier = Modifier.padding(end = 4.dp),
                )
            }
            if (TabDataSaveIndicatorPolicy.showsRetry(saveState)) {
                TextButton(onClick = onRetrySave) {
                    Text(stringResource(R.string.common_retry))
                }
            }
            IconButton(onClick = onRefresh) {
                Icon(Icons.Default.Refresh, contentDescription = stringResource(R.string.tabdata_refresh))
            }
            Box {
                IconButton(onClick = { menuExpanded = true }) {
                    Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_more))
                }
                DropdownMenu(expanded = menuExpanded, onDismissRequest = { menuExpanded = false }) {
                    if (canCreateField) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.tabdata_add_field)) },
                            leadingIcon = { Icon(Icons.Default.Add, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onCreateField()
                            },
                        )
                    }
                    if (onSendToDirectMessage != null) {
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.resource_dm_share_action)) },
                            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = null) },
                            onClick = {
                                menuExpanded = false
                                onSendToDirectMessage()
                            },
                        )
                    }
                    DropdownMenuItem(
                        text = { Text(stringResource(R.string.tabdata_open_full_editor)) },
                        leadingIcon = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null) },
                        onClick = {
                            menuExpanded = false
                            onOpenFullEditor()
                        },
                    )
                }
            }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataCreateFieldSheet(
    fields: List<TabDataField>,
    canCreate: Boolean,
    isCreating: Boolean,
    errorMessage: String?,
    onCreate: (String, TabDataCreateFieldType, List<String>) -> Unit,
    onDismiss: () -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var fieldType by remember { mutableStateOf(TabDataCreateFieldType.TEXT) }
    var choicesText by remember { mutableStateOf("") }
    var typeMenuExpanded by remember { mutableStateOf(false) }
    val choices = choicesText.lineSequence().toList()
    val request = TabDataFieldCreationPolicy.request("preview", name, fieldType, choices)
    val validationError = TabDataFieldCreationPolicy.validationError(request, fields, fieldType)
    val validationMessage = validationError?.let {
        stringResource(
            when (it) {
                TabDataCreateFieldValidationError.EMPTY_NAME -> R.string.tabdata_field_name_required
                TabDataCreateFieldValidationError.NAME_TOO_LONG -> R.string.tabdata_field_name_too_long
                TabDataCreateFieldValidationError.DUPLICATE_NAME -> R.string.tabdata_field_name_duplicate
                TabDataCreateFieldValidationError.MISSING_CHOICES -> R.string.tabdata_field_choices_required
            },
        )
    }

    TTBottomSheet(
        onDismissRequest = { if (!isCreating) onDismiss() },
        sheetState = rememberTTSheetState(confirmValueChange = { !isCreating }),
    ) {
        TTSheetColumn(
            modifier = Modifier.padding(horizontal = TTSpacing.lg).padding(bottom = TTSpacing.xl),
        ) {
            SheetHeader(
                title = stringResource(R.string.tabdata_create_field_title),
                onDismiss = onDismiss,
            )
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.tabdata_field_name)) },
                placeholder = { Text(stringResource(R.string.tabdata_field_name_placeholder)) },
                singleLine = true,
                enabled = !isCreating,
                textStyle = TTFonts.body,
            )
            Box {
                OutlinedButton(
                    onClick = { typeMenuExpanded = true },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isCreating,
                ) {
                    Text(
                        stringResource(R.string.tabdata_field_type_value, fieldType.localizedLabel()),
                        style = TTFonts.bodyMedium,
                        modifier = Modifier.weight(1f),
                    )
                }
                DropdownMenu(
                    expanded = typeMenuExpanded,
                    onDismissRequest = { typeMenuExpanded = false },
                ) {
                    TabDataCreateFieldType.entries.forEach { type ->
                        DropdownMenuItem(
                            text = { Text(type.localizedLabel()) },
                            leadingIcon = if (type == fieldType) {
                                { Icon(Icons.Default.Check, contentDescription = null) }
                            } else null,
                            onClick = {
                                fieldType = type
                                typeMenuExpanded = false
                            },
                        )
                    }
                }
            }
            if (fieldType.requiresChoices) {
                OutlinedTextField(
                    value = choicesText,
                    onValueChange = { choicesText = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.tabdata_field_choices)) },
                    supportingText = {
                        Text(stringResource(R.string.tabdata_field_choices_hint), style = TTFonts.caption)
                    },
                    minLines = 3,
                    maxLines = 8,
                    enabled = !isCreating,
                    textStyle = TTFonts.body,
                )
            }
            (validationMessage ?: errorMessage)?.let { message ->
                Text(message, style = TTFonts.caption, color = MaterialTheme.colorScheme.error)
            }
            Button(
                onClick = { onCreate(name, fieldType, choices) },
                modifier = Modifier.fillMaxWidth(),
                enabled = canCreate && validationError == null && !isCreating,
            ) {
                if (isCreating) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(TTSpacing.sm))
                }
                Text(
                    stringResource(
                        if (isCreating) R.string.tabdata_field_creating
                        else R.string.tabdata_field_create
                    ),
                    style = TTFonts.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun TabDataCreateFieldType.localizedLabel(): String = stringResource(
    when (this) {
        TabDataCreateFieldType.TEXT -> R.string.tabdata_field_type_text
        TabDataCreateFieldType.LONG_TEXT -> R.string.tabdata_field_type_long_text
        TabDataCreateFieldType.NUMBER -> R.string.tabdata_field_type_number
        TabDataCreateFieldType.SELECT -> R.string.tabdata_field_type_select
        TabDataCreateFieldType.MULTI_SELECT -> R.string.tabdata_field_type_multi_select
        TabDataCreateFieldType.CHECKBOX -> R.string.tabdata_field_type_checkbox
    },
)

@Composable
private fun TabDataViewStrip(
    views: List<TabDataView>,
    selectedViewId: String?,
    onSelect: (String) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        views.forEach { view ->
            FilterChip(
                selected = view.id == selectedViewId,
                onClick = { onSelect(view.id) },
                label = { Text(view.name, style = TTFonts.bodyMedium, maxLines = 1) },
                leadingIcon = {
                    if (view.id == selectedViewId) Icon(Icons.Default.Check, contentDescription = null, modifier = Modifier.size(18.dp))
                    else Icon(Icons.Default.TableRows, contentDescription = null, modifier = Modifier.size(18.dp))
                },
            )
        }
    }
}

@Composable
private fun TabDataQueryToolbar(
    filters: List<TabDataFilterRule>,
    sorts: List<TabDataSortRule>,
    onFilters: () -> Unit,
    onSorts: () -> Unit,
    onRemoveFilter: (String) -> Unit,
    onClearSort: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        AssistChip(
            onClick = onFilters,
            label = { Text(if (filters.isEmpty()) stringResource(R.string.tabdata_filter) else stringResource(R.string.tabdata_filter_count, filters.size)) },
            leadingIcon = { Icon(Icons.Default.FilterAlt, contentDescription = null, modifier = Modifier.size(18.dp)) },
        )
        AssistChip(
            onClick = onSorts,
            label = { Text(if (sorts.isEmpty()) stringResource(R.string.tabdata_sort) else sorts.first().fieldName) },
            leadingIcon = { Icon(Icons.AutoMirrored.Filled.Sort, contentDescription = null, modifier = Modifier.size(18.dp)) },
        )
        filters.forEach { rule ->
            AssistChip(
                onClick = { onRemoveFilter(rule.fieldId) },
                label = { Text(rule.fieldName, maxLines = 1) },
                trailingIcon = { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.tabdata_remove_filter), modifier = Modifier.size(18.dp)) },
            )
        }
        sorts.firstOrNull()?.let { rule ->
            AssistChip(
                onClick = onClearSort,
                label = { Text(if (rule.descending) stringResource(R.string.tabdata_sort_desc) else stringResource(R.string.tabdata_sort_asc)) },
                leadingIcon = {
                    Icon(
                        if (rule.descending) Icons.Default.ArrowDownward else Icons.Default.ArrowUpward,
                        contentDescription = null,
                        modifier = Modifier.size(18.dp),
                    )
                },
                trailingIcon = { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.tabdata_clear_sort), modifier = Modifier.size(18.dp)) },
            )
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataCardList(
    state: NativeTabDataUiState,
    onRefresh: () -> Unit,
    onOpenRecord: (TabDataRecord) -> Unit,
    onLoadMore: () -> Unit,
) {
    val view = state.selectedView ?: return
    if (state.records.isEmpty() && !state.isRefreshing) {
        TabDataEmptyState(
            kind = TabDataEmptyPolicy.kind(
                hasViews = true,
                isKanban = false,
                recordCount = 0,
                hasActiveQuery = state.hasQueryOverrides,
            ) ?: TabDataEmptyKind.NO_RECORDS,
        )
        return
    }
    val untitledRecordTitle = stringResource(R.string.tabdata_untitled_record)
    val memberLabels = rememberMemberLabels()
    val listState = rememberLazyListState()
    LaunchedEffect(listState, state.hasMore, state.isLoadingMore) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }
            .distinctUntilChanged()
            .collect { last ->
                if (last >= state.records.lastIndex - 3 && state.hasMore && !state.isLoadingMore) onLoadMore()
            }
    }
    PullToRefreshBox(
        isRefreshing = state.isRefreshing,
        onRefresh = onRefresh,
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = TTSpacing.lg, end = TTSpacing.lg, top = TTSpacing.sm, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            item {
                Text(
                    text = stringResource(R.string.tabdata_record_count, state.total),
                    style = TTFonts.caption,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            items(state.records, key = TabDataRecord::id) { record ->
                TabDataRecordCard(
                    TabDataProjection.card(
                        record,
                        view,
                        state.fields,
                        untitledTitle = untitledRecordTitle,
                        directory = state.memberDirectory,
                        labels = memberLabels,
                    ),
                    onClick = { onOpenRecord(record) },
                )
            }
            if (state.isLoadingMore) item { TabDataInlineLoading() }
            state.paginationError?.let { error -> item { TabDataPaginationError(error, onRetry = onLoadMore) } }
        }
    }
}

/** Debug 设备夹具复用的正式飞书式记录卡片列表。 */
@Composable
public fun TabDataCardListReviewSurface(
    state: NativeTabDataUiState,
    onOpenRecord: (TabDataRecord) -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(modifier.fillMaxSize()) {
        TabDataCardList(
            state = state,
            onRefresh = {},
            onOpenRecord = onOpenRecord,
            onLoadMore = {},
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataKanbanList(
    state: NativeTabDataUiState,
    onRefresh: () -> Unit,
    onOpenRecord: (TabDataRecord) -> Unit,
    onCreateInGroup: (TabDataRecordGroup) -> Unit,
    onLoadMoreGroup: (String) -> Unit,
) {
    val view = state.selectedView ?: return
    if (state.groups.isEmpty() && !state.isRefreshing) {
        TabDataEmptyState(kind = TabDataEmptyKind.EMPTY_KANBAN)
        return
    }
    val untitledRecordTitle = stringResource(R.string.tabdata_untitled_record)
    val memberLabels = rememberMemberLabels()
    PullToRefreshBox(isRefreshing = state.isRefreshing, onRefresh = onRefresh) {
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = TTSpacing.lg, end = TTSpacing.lg, top = TTSpacing.sm, bottom = 96.dp),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.xxl),
        ) {
            items(state.groups, key = TabDataRecordGroup::offsetKey) { group ->
                Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                    TabDataGroupHeader(group)
                    group.records.forEach { record ->
                        TabDataRecordCard(
                            TabDataProjection.card(
                                record,
                                view,
                                state.fields,
                                untitledTitle = untitledRecordTitle,
                                directory = state.memberDirectory,
                                labels = memberLabels,
                            ),
                            onClick = { onOpenRecord(record) },
                        )
                    }
                    if (state.canWrite) {
                        TextButton(
                            onClick = { onCreateInGroup(group) },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text(stringResource(R.string.tabdata_add_record))
                        }
                    }
                    if (group.hasMore) {
                        OutlinedButton(
                            onClick = { onLoadMoreGroup(group.offsetKey) },
                            enabled = group.offsetKey !in state.loadingGroupKeys,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            if (group.offsetKey in state.loadingGroupKeys) {
                                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(TTSpacing.sm))
                            }
                            Text(stringResource(R.string.tabdata_load_more_group))
                        }
                    }
                }
            }
            state.paginationError?.let { error -> item { TabDataPaginationError(error, onRetry = onRefresh) } }
        }
    }
}

@Composable
private fun TabDataGroupHeader(group: TabDataRecordGroup) {
    Row(
        modifier = Modifier.fillMaxWidth().semantics { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(group.color.asComposeColor() ?: MaterialTheme.colorScheme.outline),
        )
        Text(group.groupLabel, style = TTFonts.subtitleSemibold, modifier = Modifier.weight(1f))
        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Text(group.count.toString(), style = TTFonts.captionMedium, modifier = Modifier.padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xs))
        }
    }
}

@Composable
private fun TabDataRecordCard(
    projection: TabDataCardProjection,
    onClick: () -> Unit,
) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().semantics { contentDescription = projection.title },
        shape = RoundedCornerShape(TTRadius.md),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp, pressedElevation = 1.dp),
    ) {
        projection.coverUrl?.let { url ->
            AsyncImage(
                model = url,
                contentDescription = null,
                modifier = Modifier.fillMaxWidth().heightIn(min = 120.dp, max = 190.dp).background(MaterialTheme.colorScheme.surfaceContainer),
            )
        }
        Column(
            modifier = Modifier.padding(TTSpacing.lg),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            Text(projection.title, style = TTFonts.subtitleSemibold, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val summaryRows = projection.summaryRows.ifEmpty {
                projection.summary.map { (name, text) -> TabDataCardSummaryRow(name, text) }
            }
            summaryRows.forEach { row ->
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                    Text(row.name, style = TTFonts.caption, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(78.dp), maxLines = 1)
                    if (row.members.isNotEmpty()) {
                        TabDataMemberValue(
                            members = row.members,
                            emptyText = row.text,
                            avatarSize = 20.dp,
                            compact = true,
                            modifier = Modifier.weight(1f),
                        )
                    } else {
                        Text(row.text, style = TTFonts.body, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

@Composable
private fun TabDataLoadingState() {
    Column(
        modifier = Modifier.fillMaxSize().padding(TTSpacing.xl),
        verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
    ) {
        repeat(4) {
            Surface(
                modifier = Modifier.fillMaxWidth().height(110.dp),
                shape = RoundedCornerShape(TTRadius.md),
                color = MaterialTheme.colorScheme.surfaceContainer,
            ) {}
        }
    }
}

@Composable
private fun TabDataErrorState(
    message: String,
    offlineDrafts: List<com.tabtin.mobile.data.repository.TabDataDraftSnapshot>,
    onRetry: () -> Unit,
    onOpenFullEditor: () -> Unit,
    onOpenOfflineDraft: (String) -> Unit,
) {
    TabDataCenteredState(
        icon = { Icon(Icons.Default.Refresh, contentDescription = null, modifier = Modifier.size(40.dp)) },
        title = stringResource(R.string.tabdata_load_failed),
        message = message,
    ) {
        Button(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
        offlineDrafts.forEachIndexed { index, snapshot ->
            OutlinedButton(onClick = { onOpenOfflineDraft(snapshot.scope.recordId) }) {
                Text(
                    stringResource(
                        if (snapshot.isCreating) R.string.tabdata_view_offline_new_draft
                        else R.string.tabdata_view_offline_record_draft,
                        index + 1,
                    ),
                )
            }
        }
        TextButton(onClick = onOpenFullEditor) { Text(stringResource(R.string.tabdata_open_full_editor)) }
    }
}

@Composable
private fun TabDataEmptyState(
    kind: TabDataEmptyKind,
    onOpenFullEditor: (() -> Unit)? = null,
) {
    val title = stringResource(
        when (kind) {
            TabDataEmptyKind.NO_VIEWS -> R.string.tabdata_no_views
            TabDataEmptyKind.NO_MATCHES -> R.string.tabdata_no_matches
            TabDataEmptyKind.NO_RECORDS, TabDataEmptyKind.EMPTY_KANBAN -> R.string.tabdata_empty_records
        },
    )
    val message = stringResource(
        when (kind) {
            TabDataEmptyKind.NO_VIEWS -> R.string.tabdata_no_views_hint
            TabDataEmptyKind.NO_MATCHES -> R.string.tabdata_no_matches_hint
            TabDataEmptyKind.NO_RECORDS -> R.string.tabdata_empty_records_hint
            TabDataEmptyKind.EMPTY_KANBAN -> R.string.tabdata_empty_kanban_hint
        },
    )
    TabDataEmptyState(title = title, message = message, onOpenFullEditor = onOpenFullEditor)
}

@Composable
private fun TabDataEmptyState(
    title: String,
    message: String,
    onOpenFullEditor: (() -> Unit)? = null,
) {
    TabDataCenteredState(
        icon = { Icon(Icons.Default.TableRows, contentDescription = null, modifier = Modifier.size(40.dp)) },
        title = title,
        message = message,
    ) {
        onOpenFullEditor?.let { TextButton(onClick = it) { Text(stringResource(R.string.tabdata_open_full_editor)) } }
    }
}

/** 视图类型本地化标签；未知类型回落到视图自身名称，禁止原始类型串直显。 */
@Composable
private fun tabDataViewTypeLabel(viewType: String, fallback: String): String = when (
    viewType.trim().lowercase()
) {
    "calendar" -> stringResource(R.string.tabdata_view_type_calendar)
    "gallery" -> stringResource(R.string.tabdata_view_type_gallery)
    "form" -> stringResource(R.string.tabdata_view_type_form)
    "flashcard" -> stringResource(R.string.tabdata_view_type_flashcard)
    "pivot" -> stringResource(R.string.tabdata_view_type_pivot)
    else -> fallback
}

@Composable
private fun TabDataFullModeState(view: TabDataView, onOpenFullEditor: () -> Unit) {
    TabDataCenteredState(
        icon = { Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = null, modifier = Modifier.size(40.dp)) },
        title = stringResource(R.string.tabdata_complex_view_title, view.name),
        message = stringResource(R.string.tabdata_complex_view_message, tabDataViewTypeLabel(view.viewType, fallback = view.name)),
    ) {
        Button(onClick = onOpenFullEditor) { Text(stringResource(R.string.tabdata_open_full_editor)) }
    }
}

@Composable
private fun TabDataCenteredState(
    icon: @Composable () -> Unit,
    title: String,
    message: String,
    actions: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier.fillMaxSize().padding(TTSpacing.xxxl),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.size(72.dp)) {
            Box(contentAlignment = Alignment.Center) { icon() }
        }
        Spacer(Modifier.height(TTSpacing.lg))
        Text(title, style = TTFonts.subtitleSemibold)
        Spacer(Modifier.height(TTSpacing.sm))
        Text(message, style = TTFonts.body, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(TTSpacing.lg))
        actions()
    }
}

@Composable
private fun TabDataInlineLoading() {
    Box(modifier = Modifier.fillMaxWidth().padding(TTSpacing.lg), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.dp)
    }
}

@Composable
private fun TabDataPaginationError(message: String, onRetry: () -> Unit) {
    Column(modifier = Modifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        Text(message, style = TTFonts.caption, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_retry)) }
    }
}

private fun String?.asComposeColor(): Color? {
    val raw = this?.trim()?.takeIf { it.startsWith("#") } ?: return null
    return runCatching { Color(android.graphics.Color.parseColor(raw)) }.getOrNull()
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataFilterSheet(
    fields: List<TabDataField>,
    rules: List<TabDataFilterRule>,
    logic: String,
    onAdd: (TabDataField, String, JsonElement) -> Unit,
    onRemove: (String) -> Unit,
    onClear: () -> Unit,
    onLogicChange: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val filterable = fields.filterNot {
        it.isHidden || it.fieldType.lowercase() in setOf(
            "attachment", "link",
        )
    }
    var selectedField by remember(filterable) { mutableStateOf(filterable.firstOrNull()) }
    var selectedOperator by remember { mutableStateOf("equals") }
    var rawValue by remember { mutableStateOf("") }
    var fieldMenu by remember { mutableStateOf(false) }
    var operatorMenu by remember { mutableStateOf(false) }
    TTBottomSheet(onDismissRequest = onDismiss, sheetState = rememberTTSheetState()) {
        TTSheetColumn(
            modifier = Modifier.padding(horizontal = TTSpacing.lg).padding(bottom = TTSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.md),
        ) {
            SheetHeader(
                title = stringResource(R.string.tabdata_filter_records),
                onDismiss = onDismiss,
                trailing = {
                    if (rules.isNotEmpty()) TextButton(onClick = onClear) { Text(stringResource(R.string.tabdata_clear)) }
                },
            )
            if (rules.size > 1) {
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                    FilterChip(
                        selected = logic == "and",
                        onClick = { onLogicChange("and") },
                        label = { Text(stringResource(R.string.tabdata_filter_all)) },
                    )
                    FilterChip(
                        selected = logic == "or",
                        onClick = { onLogicChange("or") },
                        label = { Text(stringResource(R.string.tabdata_filter_any)) },
                    )
                }
            }
            rules.forEach { rule ->
                Surface(
                    shape = RoundedCornerShape(TTRadius.interactive),
                    color = MaterialTheme.colorScheme.surfaceContainer,
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(rule.fieldName, style = TTFonts.bodyMedium, modifier = Modifier.weight(1f))
                        Text(rule.value.displayText(), style = TTFonts.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        IconButton(onClick = { onRemove(rule.fieldId) }) {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.tabdata_remove_filter))
                        }
                    }
                }
            }
            HorizontalDivider()
            Text(stringResource(R.string.tabdata_add_filter), style = TTFonts.subtitleSemibold)
            Box {
                OutlinedButton(onClick = { fieldMenu = true }, modifier = Modifier.fillMaxWidth()) {
                    Text(selectedField?.name ?: stringResource(R.string.tabdata_choose_field), modifier = Modifier.weight(1f))
                }
                DropdownMenu(expanded = fieldMenu, onDismissRequest = { fieldMenu = false }) {
                    filterable.forEach { field ->
                        DropdownMenuItem(
                            text = { Text(field.name) },
                            onClick = {
                                selectedField = field
                                selectedOperator = defaultFilterOperator(field)
                                rawValue = ""
                                fieldMenu = false
                            },
                        )
                    }
                }
            }
            val currentField = selectedField
            if (currentField != null && currentField.fieldType.lowercase() == "checkbox") {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(stringResource(R.string.tabdata_filter_checked), style = TTFonts.body, modifier = Modifier.weight(1f))
                    Switch(checked = rawValue == "true", onCheckedChange = { rawValue = it.toString() })
                }
            } else {
                Box {
                    OutlinedButton(onClick = { operatorMenu = true }, modifier = Modifier.fillMaxWidth()) {
                        Text(filterOperatorLabel(selectedOperator), modifier = Modifier.weight(1f))
                    }
                    DropdownMenu(expanded = operatorMenu, onDismissRequest = { operatorMenu = false }) {
                        currentField?.let(::operatorsFor)?.forEach { operator ->
                            DropdownMenuItem(
                                text = { Text(filterOperatorLabel(operator)) },
                                onClick = {
                                    selectedOperator = operator
                                    operatorMenu = false
                                },
                            )
                        }
                    }
                }
                if (currentField != null && currentField.fieldType.lowercase() in setOf("select", "multi_select") && currentField.choices.isNotEmpty()) {
                    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
                        currentField.choices.forEach { choice ->
                            val chosen = rawValue.split(',').map(String::trim).contains(choice.value)
                            Row(
                                modifier = Modifier.fillMaxWidth().clickable {
                                    rawValue = if (currentField.fieldType.lowercase() == "multi_select") {
                                        val values = rawValue.split(',').map(String::trim).filter(String::isNotBlank).toMutableSet()
                                        if (chosen) values.remove(choice.value) else values.add(choice.value)
                                        values.joinToString(",")
                                    } else choice.value
                                }.padding(vertical = TTSpacing.xs),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Checkbox(checked = chosen, onCheckedChange = null)
                                Text(choice.label, style = TTFonts.body)
                            }
                        }
                    }
                } else {
                    OutlinedTextField(
                        value = rawValue,
                        onValueChange = { rawValue = it },
                        label = { Text(stringResource(R.string.tabdata_filter_value)) },
                        modifier = Modifier.fillMaxWidth(),
                        singleLine = true,
                        textStyle = TTFonts.body,
                        keyboardOptions = KeyboardOptions(
                            keyboardType = if (currentField?.fieldType?.lowercase() in setOf("number", "currency", "percent", "rating")) KeyboardType.Decimal else KeyboardType.Text,
                        ),
                    )
                }
            }
            Button(
                onClick = {
                    val field = selectedField ?: return@Button
                    val normalized = TabDataDraftPolicy.normalize(field, rawValue)
                    onAdd(field, selectedOperator, normalized)
                    rawValue = ""
                },
                modifier = Modifier.fillMaxWidth(),
                enabled = selectedField != null && (rawValue.isNotBlank() || selectedField?.fieldType?.lowercase() == "checkbox"),
            ) { Text(stringResource(R.string.tabdata_apply_filter)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataSortSheet(
    fields: List<TabDataField>,
    rules: List<TabDataSortRule>,
    onSelect: (TabDataField, Boolean) -> Unit,
    onClear: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sortable = fields.filterNot { it.isHidden || it.fieldType.lowercase() == "attachment" }
    TTBottomSheet(onDismissRequest = onDismiss, sheetState = rememberTTSheetState()) {
        TTSheetColumn(
            modifier = Modifier.padding(horizontal = TTSpacing.lg).padding(bottom = TTSpacing.xl),
        ) {
            SheetHeader(
                title = stringResource(R.string.tabdata_sort_records),
                onDismiss = onDismiss,
                trailing = { if (rules.isNotEmpty()) TextButton(onClick = onClear) { Text(stringResource(R.string.tabdata_clear)) } },
            )
            sortable.forEach { field ->
                val current = rules.firstOrNull { it.fieldId == field.id }
                Column {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(vertical = TTSpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(field.name, style = TTFonts.bodyMedium, modifier = Modifier.weight(1f))
                        IconButton(onClick = { onSelect(field, false) }) {
                            Icon(
                                Icons.Default.ArrowUpward,
                                contentDescription = stringResource(R.string.tabdata_sort_ascending_field, field.name),
                                tint = if (current?.descending == false) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        IconButton(onClick = { onSelect(field, true) }) {
                            Icon(
                                Icons.Default.ArrowDownward,
                                contentDescription = stringResource(R.string.tabdata_sort_descending_field, field.name),
                                tint = if (current?.descending == true) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    HorizontalDivider()
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataRecordDetailSheet(
    state: NativeTabDataUiState,
    onDismiss: () -> Unit,
    onChange: (TabDataField, JsonElement) -> Unit,
    onSave: () -> Unit,
    onDelete: () -> Unit,
    onOpenFullEditor: () -> Unit,
    onSearchMembers: suspend (String, Int) -> Result<TabDataMemberSearchPage> = { _, _ ->
        Result.success(TabDataMemberSearchPage())
    },
    onOpenNeighbor: (String) -> Unit = {},
) {
    val isMutating = state.isSaving || state.isDeleting
    val context = LocalContext.current
    TTBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberTTSheetState(confirmValueChange = { !isMutating }),
        contentModifier = Modifier.fillMaxHeight(),
    ) {
        TTSheetColumn(
            modifier = Modifier
                .fillMaxHeight()
                .padding(horizontal = TTSpacing.lg)
                .padding(bottom = TTSpacing.xl),
            verticalArrangement = Arrangement.spacedBy(TTSpacing.lg),
        ) {
            SheetHeader(
                title = if (state.isCreating) stringResource(R.string.tabdata_new_record) else stringResource(R.string.tabdata_record_detail),
                onDismiss = onDismiss,
                dismissEnabled = !isMutating,
                trailing = {
                    if (!state.isCreating && state.canEditDetail) {
                        IconButton(onClick = onDelete, enabled = !isMutating) {
                            Icon(Icons.Default.DeleteOutline, contentDescription = stringResource(R.string.tabdata_delete_record), tint = MaterialTheme.colorScheme.error)
                        }
                    }
                },
            )
            if (state.isDetailLoading) {
                LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
            }
            val neighbor = TabDataRecordNavigationPolicy.neighbors(
                recordIds = state.visibleRecordIds,
                currentId = state.selectedRecord?.id.orEmpty(),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                TextButton(
                    onClick = { neighbor.previousId?.let(onOpenNeighbor) },
                    enabled = neighbor.previousId != null && !isMutating,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.tabdata_previous_record))
                }
                TextButton(
                    onClick = { neighbor.nextId?.let(onOpenNeighbor) },
                    enabled = neighbor.nextId != null && !isMutating,
                    modifier = Modifier.weight(1f),
                ) {
                    Text(stringResource(R.string.tabdata_next_record))
                }
            }
            state.conflictMessageRes?.let { messageRes ->
                    Surface(shape = RoundedCornerShape(TTRadius.md), color = MaterialTheme.colorScheme.errorContainer) {
                        Column(modifier = Modifier.padding(TTSpacing.md), verticalArrangement = Arrangement.spacedBy(TTSpacing.sm)) {
                            Text(
                                stringResource(
                                    if (messageRes == R.string.tabdata_permission_changed_draft_preserved) {
                                        R.string.tabdata_permission_changed_title
                                    } else {
                                        R.string.tabdata_conflict_title
                                    },
                                ),
                                style = TTFonts.bodySemibold,
                                color = MaterialTheme.colorScheme.onErrorContainer,
                            )
                            Text(stringResource(messageRes), style = TTFonts.caption, color = MaterialTheme.colorScheme.onErrorContainer)
                            TextButton(onClick = onOpenFullEditor) { Text(stringResource(R.string.tabdata_open_full_editor)) }
                        }
                    }
                }
                if (state.fields.isEmpty() && state.detailWriteBlocked) {
                    state.detailDraft.forEach { (name, value) ->
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.md),
                        ) {
                            Text(
                                name,
                                style = TTFonts.caption,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.width(96.dp),
                            )
                            Text(value.asDraftText(), style = TTFonts.body, modifier = Modifier.weight(1f))
                        }
                    }
                } else {
                    val visibleFields = state.fields.filterNot(TabDataField::isHidden).sortedBy(TabDataField::order)
                    val memberLabels = rememberMemberLabels()
                    visibleFields.forEach { field ->
                        TabDataFieldEditor(
                        field = field,
                        value = state.detailDraft[field.name] ?: JsonNull,
                        error = state.detailErrors[field.name]?.let { error ->
                            when (error) {
                                TabDataValidationError.InvalidNumber -> stringResource(
                                    R.string.tabdata_invalid_number,
                                )
                            }
                        },
                        enabled = state.canEditDetail && !isMutating &&
                            TabDataFieldPolicy.editMode(field.fieldType) == TabDataFieldEditMode.NATIVE,
                        onChange = { onChange(field, it) },
                        onOpenFullEditor = onOpenFullEditor,
                        directory = state.memberDirectory,
                        labels = memberLabels,
                        onSearchMembers = onSearchMembers,
                        )
                    }
                }
                if (!state.canWrite) {
                    Text(
                        stringResource(R.string.tabdata_read_only_permission),
                        style = TTFonts.caption,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (state.detailWriteBlocked || !state.canWrite) {
                    val copyLabels = rememberMemberLabels()
                    TextButton(
                        onClick = {
                            val text = state.detailDraft.entries.joinToString("\n") { (name, value) ->
                                val field = state.fields.firstOrNull { it.name == name }
                                val rendered = if (field != null && TabDataMemberDirectory.isUserField(field)) {
                                    state.memberDirectory.resolve(value, copyLabels)
                                        .joinToString("、") { it.displayName }
                                } else {
                                    value.asDraftText()
                                }
                                "$name: $rendered"
                            }
                            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                            clipboard?.setPrimaryClip(ClipData.newPlainText("TabData draft", text))
                        },
                        enabled = state.detailDraft.isNotEmpty(),
                    ) {
                        Text(stringResource(R.string.tabdata_copy_local_draft))
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(TTSpacing.md)) {
                    OutlinedButton(onClick = onDismiss, modifier = Modifier.weight(1f), enabled = !isMutating) {
                        Text(stringResource(R.string.common_cancel))
                    }
                    if (state.canEditDetail) {
                        Button(
                            onClick = onSave,
                            modifier = Modifier.weight(1f),
                            enabled = !isMutating && (state.isCreating || state.isDetailDirty),
                        ) {
                            if (state.isSaving) {
                                CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                                Spacer(Modifier.width(TTSpacing.sm))
                            }
                            Text(stringResource(R.string.common_save))
                        }
                    }
                }
        }
    }
}

/** Debug 设备夹具直接复用生产记录表单，用于键盘、安全区与字段控件验收。 */
@Composable
public fun NativeTabDataRecordReviewSurface(
    initialState: NativeTabDataUiState,
    onDismiss: () -> Unit = {},
    onOpenFullEditor: () -> Unit = {},
) {
    var state by remember(initialState) { mutableStateOf(initialState) }
    var showSaved by remember { mutableStateOf(false) }
    TabDataRecordDetailSheet(
        state = state,
        onDismiss = onDismiss,
        onChange = { field, value ->
            state = state.copy(
                detailDraft = state.detailDraft + (field.name to value),
                detailErrors = emptyMap(),
            )
        },
        onSave = { state = state.copy(isSaving = true) },
        onDelete = {},
        onOpenFullEditor = onOpenFullEditor,
    )
    LaunchedEffect(state.isSaving) {
        if (state.isSaving) {
            kotlinx.coroutines.delay(650)
            state = state.copy(isSaving = false, detailOriginal = state.detailDraft)
            showSaved = true
        }
    }
    if (showSaved) {
        LaunchedEffect(Unit) {
            kotlinx.coroutines.delay(900)
            showSaved = false
        }
        Box(Modifier.fillMaxSize().padding(TTSpacing.lg), contentAlignment = Alignment.TopCenter) {
            Surface(
                color = MaterialTheme.colorScheme.inverseSurface,
                shape = RoundedCornerShape(TTRadius.interactive),
            ) {
                Text(
                    stringResource(R.string.tabdata_saved),
                    modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.sm),
                    style = TTFonts.bodyMedium,
                    color = MaterialTheme.colorScheme.inverseOnSurface,
                )
            }
        }
    }
}

@Composable
private fun TabDataFieldEditor(
    field: TabDataField,
    value: JsonElement,
    error: String?,
    enabled: Boolean,
    onChange: (JsonElement) -> Unit,
    onOpenFullEditor: () -> Unit,
    directory: TabDataMemberDirectory = TabDataMemberDirectory.Empty,
    labels: TabDataMemberLabels = TabDataMemberLabels.Chinese,
    onSearchMembers: suspend (String, Int) -> Result<TabDataMemberSearchPage> = { _, _ ->
        Result.success(TabDataMemberSearchPage())
    },
) {
    Column(verticalArrangement = Arrangement.spacedBy(TTSpacing.xs)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(field.name, style = TTFonts.bodyMedium, modifier = Modifier.weight(1f))
        }
        field.description?.takeIf(String::isNotBlank)?.let {
            Text(it, style = TTFonts.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        when (field.normalizedType) {
            "checkbox" -> Surface(
                shape = RoundedCornerShape(TTRadius.interactive),
                color = MaterialTheme.colorScheme.surfaceContainer,
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth().clickable(enabled = enabled) {
                        onChange(JsonPrimitive((value as? JsonPrimitive)?.booleanOrNull != true))
                    }.padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(if ((value as? JsonPrimitive)?.booleanOrNull == true) stringResource(R.string.common_yes) else stringResource(R.string.common_no), style = TTFonts.body, modifier = Modifier.weight(1f))
                    Checkbox(checked = (value as? JsonPrimitive)?.booleanOrNull == true, onCheckedChange = { onChange(JsonPrimitive(it)) }, enabled = enabled)
                }
            }
            "select", "multi_select" -> TabDataChoiceEditor(field, value, enabled, onChange)
            "percent" -> TabDataPercentEditor(value, error, enabled, onChange)
            "currency" -> TabDataCurrencyEditor(field, value, error, enabled, onChange)
            "rating" -> TabDataRatingEditor(field, value, enabled, onChange)
            "date" -> TabDataDateEditor(field, value, enabled, onChange)
            "user" -> TabDataUserEditor(
                field = field,
                value = value,
                enabled = enabled,
                directory = directory,
                labels = labels,
                onChange = onChange,
                onSearchMembers = onSearchMembers,
            )
            "created_by", "last_modified_by" -> {
                val members = directory.resolve(value, labels)
                Surface(
                    shape = RoundedCornerShape(TTRadius.interactive),
                    color = MaterialTheme.colorScheme.surfaceContainer,
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth().padding(TTSpacing.md),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        TabDataMemberValue(
                            members = members,
                            emptyText = stringResource(R.string.tabdata_empty_value),
                            avatarSize = 24.dp,
                            modifier = Modifier.weight(1f),
                        )
                        IconButton(onClick = onOpenFullEditor) {
                            Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = stringResource(R.string.tabdata_open_full_editor))
                        }
                    }
                }
                Text(stringResource(R.string.tabdata_full_mode_field_hint), style = TTFonts.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            else -> {
                val native = TabDataFieldPolicy.editMode(field.fieldType) == TabDataFieldEditMode.NATIVE
                if (native) {
                    OutlinedTextField(
                        value = value.asDraftText(),
                        onValueChange = { onChange(TabDataDraftPolicy.normalize(field, it)) },
                        modifier = Modifier.fillMaxWidth(),
                        enabled = enabled,
                        minLines = if (field.normalizedType == "long_text") 3 else 1,
                        maxLines = if (field.normalizedType == "long_text") 8 else 1,
                        textStyle = TTFonts.body,
                        keyboardOptions = KeyboardOptions(keyboardType = keyboardTypeFor(field.normalizedType)),
                        isError = error != null,
                        supportingText = error?.let { message -> ({ Text(message, style = TTFonts.caption) }) },
                    )
                } else {
                    Surface(
                        shape = RoundedCornerShape(TTRadius.interactive),
                        color = MaterialTheme.colorScheme.surfaceContainer,
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth().padding(TTSpacing.md),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(modifier = Modifier.weight(1f)) {
                                Text(value.displayText().ifBlank { stringResource(R.string.tabdata_empty_value) }, style = TTFonts.body)
                                Text(stringResource(R.string.tabdata_full_mode_field_hint), style = TTFonts.caption, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            IconButton(onClick = onOpenFullEditor) {
                                Icon(Icons.AutoMirrored.Filled.OpenInNew, contentDescription = stringResource(R.string.tabdata_open_full_editor))
                            }
                        }
                    }
                }
            }
        }
        if (error != null && field.normalizedType in setOf("checkbox", "select", "multi_select", "user", "rating")) {
            Text(error, style = TTFonts.caption, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun TabDataChoiceEditor(
    field: TabDataField,
    value: JsonElement,
    enabled: Boolean,
    onChange: (JsonElement) -> Unit,
) {
    val multiple = field.normalizedType == "multi_select"
    val selected = when (value) {
        is JsonArray -> value.mapNotNull { (it as? JsonPrimitive)?.content }.toSet()
        is JsonPrimitive -> setOf(value.content)
        else -> emptySet()
    }
    if (field.choices.isEmpty()) {
        OutlinedTextField(
            value = value.asDraftText(),
            onValueChange = { onChange(TabDataDraftPolicy.normalize(field, it)) },
            modifier = Modifier.fillMaxWidth(),
            enabled = enabled,
            textStyle = TTFonts.body,
            supportingText = { Text(stringResource(R.string.tabdata_choice_fallback_hint), style = TTFonts.caption) },
        )
        return
    }

    var expanded by remember { mutableStateOf(false) }
    val selectedChoices = field.choices.filter { it.value in selected }
    Box {
        Surface(
            shape = RoundedCornerShape(TTRadius.interactive),
            color = MaterialTheme.colorScheme.surfaceContainer,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = enabled) { expanded = true }
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                if (selectedChoices.isEmpty()) {
                    Text(
                        stringResource(R.string.tabdata_choice_none),
                        style = TTFonts.body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                } else if (selectedChoices.size == 1) {
                    TabDataChoiceChip(selectedChoices.first())
                    Spacer(Modifier.weight(1f))
                } else {
                    TabDataChoiceOverflowRow(
                        choices = selectedChoices,
                        modifier = Modifier.weight(1f),
                    )
                }
                if (enabled) {
                    Icon(
                        Icons.Default.KeyboardArrowDown,
                        contentDescription = stringResource(R.string.tabdata_choice_expand),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
        DropdownMenu(
            expanded = expanded,
            onDismissRequest = { expanded = false },
        ) {
            if (!multiple) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.tabdata_choice_none), style = TTFonts.body) },
                    onClick = {
                        onChange(JsonNull)
                        expanded = false
                    },
                )
            }
            field.choices.forEach { choice ->
                val checked = choice.value in selected
                DropdownMenuItem(
                    text = {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
                        ) {
                            TabDataChoiceChip(choice)
                            if (checked) {
                                Icon(Icons.Default.Check, contentDescription = null)
                            }
                        }
                    },
                    onClick = {
                        if (multiple) {
                            val next = selected.toMutableSet()
                            if (checked) next.remove(choice.value) else next.add(choice.value)
                            onChange(JsonArray(next.map(::JsonPrimitive)))
                        } else {
                            onChange(JsonPrimitive(choice.value))
                            expanded = false
                        }
                    },
                )
            }
        }
    }
}

@Composable
private fun TabDataChoiceChip(choice: TabDataChoice) {
    val (background, foreground) = TabDataChoiceColors.resolve(choice.color, choice.value)
    Text(
        text = choice.label,
        style = TTFonts.caption,
        color = foreground,
        modifier = Modifier
            .background(background, RoundedCornerShape(TTRadius.interactive))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xxs),
    )
}

@Composable
private fun TabDataChoiceOverflowMark(count: Int) {
    Text(
        text = stringResource(R.string.tabdata_choice_more, count),
        style = TTFonts.caption,
        color = TTColors.TextSecondary,
        modifier = Modifier
            .background(TTColors.BgSubtle, RoundedCornerShape(TTRadius.interactive))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xxs),
    )
}

@Composable
private fun TabDataChoiceOverflowRow(
    choices: List<TabDataChoice>,
    modifier: Modifier = Modifier,
) {
    val spacing = TTSpacing.xs
    SubcomposeLayout(modifier) { constraints ->
        val chipPlaceables = choices.mapIndexed { index, choice ->
            subcompose("chip-$index") { TabDataChoiceChip(choice) }
                .first()
                .measure(Constraints())
        }
        val overflowProbe = subcompose("overflow-probe") {
            TabDataChoiceOverflowMark(choices.size)
        }.first().measure(Constraints())
        val visible = TabDataChoiceOverflow.visibleCount(
            chipWidths = chipPlaceables.map { it.width },
            overflowWidth = overflowProbe.width,
            spacing = spacing.roundToPx(),
            availableWidth = constraints.maxWidth,
        )
        val hidden = choices.size - visible
        val overflow = if (hidden > 0) {
            subcompose("overflow") { TabDataChoiceOverflowMark(hidden) }
                .first()
                .measure(Constraints())
        } else {
            null
        }
        val rowHeight = (chipPlaceables.take(visible) + listOfNotNull(overflow))
            .maxOfOrNull { it.height }
            ?: overflowProbe.height
        layout(constraints.maxWidth, rowHeight) {
            var x = 0
            val space = spacing.roundToPx()
            chipPlaceables.take(visible).forEach { placeable ->
                placeable.placeRelative(x, (rowHeight - placeable.height) / 2)
                x += placeable.width + space
            }
            overflow?.placeRelative(x, (rowHeight - overflow.height) / 2)
        }
    }
}

@Composable
private fun TabDataUserEditor(
    field: TabDataField,
    value: JsonElement,
    enabled: Boolean,
    directory: TabDataMemberDirectory,
    labels: TabDataMemberLabels,
    onChange: (JsonElement) -> Unit,
    onSearchMembers: suspend (String, Int) -> Result<TabDataMemberSearchPage>,
) {
    val multiple = TabDataUserFieldPolicy.isMultiple(field)
    val members = directory.resolve(value, labels)
    var pickerVisible by remember { mutableStateOf(false) }
    val selectedIds = remember { mutableStateOf(TabDataUserFieldPolicy.selectedIds(value)) }
    LaunchedEffect(value) {
        selectedIds.value = TabDataUserFieldPolicy.selectedIds(value)
    }
    fun commit(ids: List<String>) {
        selectedIds.value = ids
        onChange(TabDataUserFieldPolicy.encode(ids, multiple))
    }
    Box {
        Surface(
            shape = RoundedCornerShape(TTRadius.interactive),
            color = MaterialTheme.colorScheme.surfaceContainer,
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable(enabled = enabled) { pickerVisible = true }
                    .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                if (members.isEmpty()) {
                    Text(
                        stringResource(R.string.tabdata_member_none),
                        style = TTFonts.body,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.weight(1f),
                    )
                } else if (members.size == 1) {
                    TabDataMemberChip(
                        member = members.first(),
                        removable = enabled,
                        onRemove = {
                            commit(TabDataUserFieldPolicy.selectedIds(
                                TabDataUserFieldPolicy.remove(value, members.first().userId, multiple),
                            ))
                        },
                    )
                    Spacer(Modifier.weight(1f))
                } else {
                    TabDataMemberOverflowRow(
                        members = members,
                        removable = enabled,
                        onRemove = { member ->
                            commit(TabDataUserFieldPolicy.selectedIds(
                                TabDataUserFieldPolicy.remove(
                                    TabDataUserFieldPolicy.encode(selectedIds.value, multiple),
                                    member.userId,
                                    multiple,
                                ),
                            ))
                        },
                        modifier = Modifier.weight(1f),
                    )
                }
                if (enabled) {
                    Icon(
                        Icons.Default.KeyboardArrowDown,
                        contentDescription = stringResource(R.string.tabdata_member_expand),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    if (pickerVisible) {
        TabDataMemberPickerSheet(
            selectedIds = selectedIds.value,
            multiple = multiple,
            onSearch = onSearchMembers,
            onToggle = { member ->
                val next = TabDataUserFieldPolicy.toggle(
                    TabDataUserFieldPolicy.encode(selectedIds.value, multiple),
                    member.userId,
                    multiple,
                )
                commit(TabDataUserFieldPolicy.selectedIds(next))
            },
            onDismiss = { pickerVisible = false },
        )
    }
}

@Composable
private fun TabDataMemberChip(
    member: TabDataMemberRef,
    removable: Boolean,
    onRemove: () -> Unit,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(TTSpacing.xs),
        modifier = Modifier
            .background(TTColors.BgSubtle, RoundedCornerShape(TTRadius.interactive))
            .padding(horizontal = TTSpacing.sm, vertical = TTSpacing.xxs),
    ) {
        IdentityColorAvatar(
            name = member.displayName,
            seed = IdentityAvatar.colorSeed(member.userId, member.displayName),
            imageUrl = member.avatarUrl,
            size = 18.dp,
        )
        Text(
            text = member.displayName,
            style = TTFonts.caption,
            color = TTColors.TextSecondary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
        if (removable) {
            Icon(
                Icons.Default.Close,
                contentDescription = stringResource(R.string.tabdata_member_remove),
                tint = TTColors.TextSecondary,
                modifier = Modifier
                    .size(14.dp)
                    .clickable(onClick = onRemove),
            )
        }
    }
}

@Composable
private fun TabDataMemberOverflowRow(
    members: List<TabDataMemberRef>,
    removable: Boolean,
    onRemove: (TabDataMemberRef) -> Unit,
    modifier: Modifier = Modifier,
) {
    val spacing = TTSpacing.xs
    SubcomposeLayout(modifier) { constraints ->
        val chipPlaceables = members.mapIndexed { index, member ->
            subcompose("member-$index") {
                TabDataMemberChip(member = member, removable = removable, onRemove = { onRemove(member) })
            }.first().measure(Constraints())
        }
        val overflowProbe = subcompose("overflow-probe") {
            TabDataChoiceOverflowMark(members.size)
        }.first().measure(Constraints())
        val visible = TabDataChoiceOverflow.visibleCount(
            chipWidths = chipPlaceables.map { it.width },
            overflowWidth = overflowProbe.width,
            spacing = spacing.roundToPx(),
            availableWidth = constraints.maxWidth,
        )
        val hidden = members.size - visible
        val overflow = if (hidden > 0) {
            subcompose("overflow") { TabDataChoiceOverflowMark(hidden) }
                .first()
                .measure(Constraints())
        } else {
            null
        }
        val rowHeight = (chipPlaceables.take(visible) + listOfNotNull(overflow))
            .maxOfOrNull { it.height }
            ?: overflowProbe.height
        layout(constraints.maxWidth, rowHeight) {
            var x = 0
            val space = spacing.roundToPx()
            chipPlaceables.take(visible).forEach { placeable ->
                placeable.placeRelative(x, (rowHeight - placeable.height) / 2)
                x += placeable.width + space
            }
            overflow?.placeRelative(x, (rowHeight - overflow.height) / 2)
        }
    }
}

@Composable
private fun TabDataPercentEditor(
    value: JsonElement,
    error: String?,
    enabled: Boolean,
    onChange: (JsonElement) -> Unit,
) {
    val storedRaw = (value as? JsonPrimitive)?.contentOrNull.orEmpty()
    var typed by remember { mutableStateOf<String?>(null) }
    val displayed = typed
        ?: TabDataNumberFormat.formatPercentEditorPoints(storedRaw)
        ?: storedRaw

    LaunchedEffect(storedRaw) {
        typed = null
    }

    OutlinedTextField(
        value = displayed,
        onValueChange = { next ->
            typed = next
            when (val commit = TabDataNumberFormat.commitPercentEditor(next, storedRaw)) {
                TabDataNumberFormat.PercentEditorCommit.Empty -> onChange(JsonNull)
                is TabDataNumberFormat.PercentEditorCommit.Ratio -> {
                    if (commit.raw == storedRaw.trim() && value is JsonPrimitive) {
                        onChange(value)
                    } else {
                        commit.raw.toBigDecimalOrNull()?.let { onChange(JsonPrimitive(it)) }
                    }
                }
                TabDataNumberFormat.PercentEditorCommit.Intermediate -> Unit
            }
        },
        modifier = Modifier.fillMaxWidth(),
        enabled = enabled,
        textStyle = TTFonts.body,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        isError = error != null,
        supportingText = error?.let { message -> { Text(message, style = TTFonts.caption) } },
        suffix = {
            Text(
                stringResource(R.string.tabdata_percent_suffix),
                style = TTFonts.body,
                color = TTColors.TextSecondary,
            )
        },
    )
}

@Composable
private fun TabDataCurrencyEditor(
    field: TabDataField,
    value: JsonElement,
    error: String?,
    enabled: Boolean,
    onChange: (JsonElement) -> Unit,
) {
    val symbol = TabDataNumberFormat.currencySymbol(field.options)
    val precision = TabDataNumberFormat.currencyPrecision(field.options)
    val storedRaw = (value as? JsonPrimitive)?.contentOrNull.orEmpty()
    var typed by remember { mutableStateOf<String?>(null) }
    var focused by remember { mutableStateOf(false) }
    val displayed = when {
        focused || typed != null -> typed ?: storedRaw
        else -> TabDataNumberFormat.formatCurrency(storedRaw, symbol = "", precision = precision) ?: storedRaw
    }

    LaunchedEffect(storedRaw) {
        typed = null
    }

    OutlinedTextField(
        value = displayed,
        onValueChange = { next ->
            typed = next
            val trimmed = next.trim()
            when {
                trimmed.isEmpty() -> onChange(JsonNull)
                trimmed == "-" || trimmed == "+" || trimmed == "." ||
                    trimmed == "-." || trimmed == "+." || trimmed.endsWith(".") -> Unit
                trimmed.toDoubleOrNull() != null -> onChange(TabDataDraftPolicy.normalize(field, next))
                else -> Unit
            }
        },
        modifier = Modifier
            .fillMaxWidth()
            .onFocusChanged { state ->
                focused = state.isFocused
                if (!state.isFocused) {
                    typed = null
                }
            },
        enabled = enabled,
        textStyle = TTFonts.body,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        isError = error != null,
        supportingText = error?.let { message -> { Text(message, style = TTFonts.caption) } },
        prefix = {
            Text(
                symbol,
                style = TTFonts.body,
                color = TTColors.TextSecondary,
            )
        },
    )
}

@Composable
private fun TabDataRatingEditor(
    field: TabDataField,
    value: JsonElement,
    enabled: Boolean,
    onChange: (JsonElement) -> Unit,
) {
    val max = TabDataNumberFormat.ratingMax(field.options)
    val current = TabDataNumberFormat.clampRating(
        (value as? JsonPrimitive)?.contentOrNull,
        max,
    ) ?: 0
    Row(verticalAlignment = Alignment.CenterVertically) {
        for (star in 1..max) {
            val filled = star <= current
            val description = stringResource(R.string.tabdata_rating_value, star, max)
            Box(
                modifier = Modifier
                    .sizeIn(minWidth = 48.dp, minHeight = 48.dp)
                    .clickable(enabled = enabled) {
                        val next = if (current == star) 0 else star
                        onChange(JsonPrimitive(next))
                    }
                    .semantics { contentDescription = description },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (filled) "★" else "☆",
                    style = TTFonts.subtitle,
                    color = if (filled) TTColors.TextWarning else TTColors.TextSecondary,
                )
            }
        }
    }
}

/**
 * 日期的原生编辑入口。iOS 用内联 `DatePicker`，Android 平台习惯是弹对话框，
 * 交互形态不同但落到线上的值走同一个 [TabDataDateCodec]。
 *
 * 不复用文本框：用户手输日期会得到各种格式和无法判定的时区，后端虽然能解析，但两端
 * 往返后拿到的时刻会不一样。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun TabDataDateEditor(
    field: TabDataField,
    value: JsonElement,
    enabled: Boolean,
    onChange: (JsonElement) -> Unit,
) {
    val raw = (value as? JsonPrimitive)?.contentOrNull
    val zone = remember { ZoneId.systemDefault() }
    val instant = remember(raw) {
        TabDataDateCodec.decodeDate(raw)?.atStartOfDay(zone)?.toInstant()
    }
    var showDatePicker by remember { mutableStateOf(false) }

    val display = when {
        instant == null -> stringResource(R.string.tabdata_date_not_set)
        else -> TabDataDateCodec.displayDate(instant.atZone(zone).toLocalDate())
    }

    Surface(
        shape = RoundedCornerShape(TTRadius.interactive),
        color = MaterialTheme.colorScheme.surfaceContainer,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled) { showDatePicker = true }
                .padding(horizontal = TTSpacing.md, vertical = TTSpacing.sm),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
        ) {
            Icon(
                Icons.Default.DateRange,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Text(display, style = TTFonts.body, modifier = Modifier.weight(1f))
            if (instant != null && enabled) {
                IconButton(onClick = { onChange(JsonNull) }) {
                    Icon(
                        Icons.Default.Close,
                        contentDescription = stringResource(R.string.tabdata_date_clear),
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }

    if (showDatePicker) {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = instant?.toEpochMilli() ?: System.currentTimeMillis(),
        )
        DatePickerDialog(
            onDismissRequest = { showDatePicker = false },
            confirmButton = {
                TextButton(
                    onClick = {
                        val millis = state.selectedDateMillis
                        showDatePicker = false
                        if (millis == null) return@TextButton
                        // 选择器给的是 UTC 当日零点，取日历日期时必须按 UTC 读，
                        // 否则东八区以西的用户会拿到前一天。
                        val picked = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()
                        onChange(JsonPrimitive(TabDataDateCodec.encodeDate(picked)))
                    },
                ) { Text(stringResource(R.string.common_confirm)) }
            },
            dismissButton = {
                TextButton(onClick = { showDatePicker = false }) {
                    Text(stringResource(R.string.common_cancel))
                }
            },
        ) {
            DatePicker(state = state)
        }
    }
}

@Composable
private fun SheetHeader(
    title: String,
    onDismiss: () -> Unit,
    dismissEnabled: Boolean = true,
    trailing: @Composable () -> Unit = {},
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = TTFonts.titleSemibold, modifier = Modifier.weight(1f).semantics { heading() })
        trailing()
        IconButton(onClick = onDismiss, enabled = dismissEnabled) {
            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close))
        }
    }
}

private fun defaultFilterOperator(field: TabDataField): String = when (field.fieldType.lowercase()) {
    "text", "long_text", "url", "email", "phone" -> "contains"
    else -> "equals"
}

private fun operatorsFor(field: TabDataField): List<String> = when (field.fieldType.lowercase()) {
    "text", "long_text", "url", "email", "phone" -> listOf("contains", "equals", "not_equals")
    "number", "currency", "percent", "rating", "date" -> listOf("equals", "not_equals", "greater_than", "less_than")
    "select", "multi_select" -> listOf("equals", "not_equals")
    else -> listOf("equals", "not_equals")
}

@Composable
private fun filterOperatorLabel(operator: String): String = when (operator) {
    "contains" -> stringResource(R.string.tabdata_filter_contains)
    "not_equals" -> stringResource(R.string.tabdata_filter_not_equals)
    "greater_than" -> stringResource(R.string.tabdata_filter_greater)
    "less_than" -> stringResource(R.string.tabdata_filter_less)
    else -> stringResource(R.string.tabdata_filter_equals)
}

private fun keyboardTypeFor(fieldType: String): KeyboardType = when (fieldType.lowercase()) {
    "number", "currency", "percent" -> KeyboardType.Decimal
    "email" -> KeyboardType.Email
    "phone" -> KeyboardType.Phone
    "url" -> KeyboardType.Uri
    else -> KeyboardType.Text
}

@Composable
private fun rememberMemberLabels(): TabDataMemberLabels {
    val departedSuffix = stringResource(R.string.tabdata_member_departed_suffix)
    val unknown = stringResource(R.string.tabdata_member_unknown)
    val unnamed = stringResource(R.string.tabdata_member_unnamed)
    return remember(departedSuffix, unknown, unnamed) {
        TabDataMemberLabels(departedSuffix = departedSuffix, unknown = unknown, unnamed = unnamed)
    }
}

@Composable
private fun TabDataMemberValue(
    members: List<TabDataMemberRef>,
    emptyText: String,
    avatarSize: Dp,
    modifier: Modifier = Modifier,
    compact: Boolean = false,
) {
    if (members.isEmpty()) {
        Text(
            emptyText,
            style = TTFonts.body,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = modifier,
        )
        return
    }
    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(if (compact) TTSpacing.xxs else TTSpacing.xs),
    ) {
        members.forEach { member ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(TTSpacing.sm),
            ) {
                IdentityColorAvatar(
                    name = member.displayName,
                    seed = IdentityAvatar.colorSeed(member.userId, member.displayName),
                    imageUrl = member.avatarUrl,
                    size = avatarSize,
                )
                Text(
                    member.displayName,
                    style = TTFonts.body,
                    maxLines = if (compact) 1 else 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
