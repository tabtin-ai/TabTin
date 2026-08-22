package com.tabtin.mobile.features.tabdata

import androidx.annotation.StringRes
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.WSEnvelope
import com.tabtin.mobile.data.model.tabdata.TabDataField
import com.tabtin.mobile.data.model.tabdata.TabDataFieldConflict
import com.tabtin.mobile.data.model.tabdata.TabDataFilterRule
import com.tabtin.mobile.data.model.tabdata.TabDataRecord
import com.tabtin.mobile.data.model.tabdata.TabDataRecordGroup
import com.tabtin.mobile.data.model.tabdata.TabDataSortRule
import com.tabtin.mobile.data.model.tabdata.TabDataTable
import com.tabtin.mobile.data.model.tabdata.TabDataView
import com.tabtin.mobile.data.repository.TabDataDraftScope
import com.tabtin.mobile.data.repository.TabDataDraftSchema
import com.tabtin.mobile.data.repository.TabDataDraftSnapshot
import com.tabtin.mobile.data.repository.TabDataDraftStore
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.TabDataRepository
import com.tabtin.mobile.data.websocket.WSConnectionState
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import javax.inject.Inject
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import retrofit2.HttpException

public data class NativeTabDataUiState(
    val tableId: String = "",
    val table: TabDataTable? = null,
    val views: List<TabDataView> = emptyList(),
    val fields: List<TabDataField> = emptyList(),
    val selectedViewId: String? = null,
    val records: List<TabDataRecord> = emptyList(),
    val groups: List<TabDataRecordGroup> = emptyList(),
    val total: Int = 0,
    val searchText: String = "",
    val filters: List<TabDataFilterRule> = emptyList(),
    val filterLogic: String = "and",
    val sorts: List<TabDataSortRule> = emptyList(),
    val isLoading: Boolean = true,
    val isRefreshing: Boolean = false,
    val isLoadingMore: Boolean = false,
    val hasMore: Boolean = false,
    val loadingGroupKeys: Set<String> = emptySet(),
    @StringRes val errorRes: Int? = null,
    val errorMessage: String? = null,
    val paginationError: String? = null,
    val selectedRecord: TabDataRecord? = null,
    val detailDraft: Map<String, JsonElement> = emptyMap(),
    val detailOriginal: Map<String, JsonElement> = emptyMap(),
    val detailErrors: Map<String, TabDataValidationError> = emptyMap(),
    val isDetailLoading: Boolean = false,
    val isSaving: Boolean = false,
    val isDeleting: Boolean = false,
    val isCreating: Boolean = false,
    val isCreatingField: Boolean = false,
    @StringRes val fieldCreationErrorRes: Int? = null,
    val fieldCreationError: String? = null,
    val writeBlockedByServer: Boolean = false,
    val detailWriteBlocked: Boolean = false,
    val hasResumableCreationDraft: Boolean = false,
    @StringRes val conflictMessageRes: Int? = null,
    @StringRes val mutationMessageRes: Int? = null,
    val mutationMessage: String? = null,
    /** 冲突字段显示名；分隔符由渲染层按 locale 取资源拼接，勿在此处成串。 */
    val mutationMessageFields: List<String> = emptyList(),
    val mutationMessageCount: Int? = null,
    /** 初载暂态失败时按当前身份 scope 找到的草稿；无 schema / 权限，严格只读。 */
    val offlineDrafts: List<TabDataDraftSnapshot> = emptyList(),
    val memberDirectory: TabDataMemberDirectory = TabDataMemberDirectory.Empty,
    val saveFailed: Boolean = false,
    val saveConflicted: Boolean = false,
    val justSaved: Boolean = false,
) {
    public val selectedView: TabDataView?
        get() = views.firstOrNull { it.id == selectedViewId }

    public val canWrite: Boolean
        get() = table?.canWrite == true && !writeBlockedByServer

    public val canEditDetail: Boolean
        get() = canWrite && !detailWriteBlocked

    public val hasQueryOverrides: Boolean
        get() = searchText.isNotBlank() || filters.isNotEmpty() || sorts.isNotEmpty()

    public val isDetailDirty: Boolean
        get() = detailDraft != detailOriginal

    public val hasOfflineDrafts: Boolean
        get() = offlineDrafts.isNotEmpty()

    public val visibleRecordIds: List<String>
        get() = TabDataRecordNavigationPolicy.visibleIds(
            viewType = selectedView?.viewType,
            records = records,
            groups = groups,
        )
}

public sealed interface NativeTabDataEvent {
    public data object OpenFullEditor : NativeTabDataEvent
    public data object CloseDetail : NativeTabDataEvent
    public data object FieldCreated : NativeTabDataEvent
    public data class FullEditorBlocked(@StringRes val messageRes: Int) : NativeTabDataEvent
    public data object ConfirmDiscardDraftsForFullEditor : NativeTabDataEvent
}

@HiltViewModel
public class NativeTabDataViewModel @Inject constructor(
    private val repository: TabDataRepository,
    private val draftStore: TabDataDraftStore,
    private val tokenManager: TokenManager,
    private val organizationRepository: OrganizationRepository,
    private val memberDirectoryStore: TabDataMemberDirectoryStore,
    private val webSocketService: WebSocketService,
    savedStateHandle: SavedStateHandle,
) : ViewModel() {
    private val tableId: String = savedStateHandle["resourceId"]
        ?: savedStateHandle["tableId"]
        ?: ""
    private val routeOrganizationId: String? = savedStateHandle["organizationId"]
    private val draftUserId: String? = tokenManager.userId?.takeIf(String::isNotBlank)

    private val _uiState = MutableStateFlow(NativeTabDataUiState(tableId = tableId))
    public val uiState: StateFlow<NativeTabDataUiState> = _uiState.asStateFlow()

    private val _events = MutableSharedFlow<NativeTabDataEvent>(extraBufferCapacity = 1)
    public val events: SharedFlow<NativeTabDataEvent> = _events.asSharedFlow()

    private var page = 1
    private var requestGeneration = 0L
    private var detailRequestGeneration = 0L
    private var mutationGeneration = 0L
    private var fieldMutationGeneration = 0L
    private var loadJob: Job? = null
    private var searchJob: Job? = null
    private var detailJob: Job? = null
    private var mutationJob: Job? = null
    private var fieldMutationJob: Job? = null
    private var identityInvalidated = false
    private var hasObservedSelectedOrganization = false
    private val wsHandlerKey = "tabdata-realtime-${tableId.ifBlank { "missing" }}-${hashCode()}"
    private var subscribedTableTopic: String? = null
    private val pendingRealtimeRecordIds = mutableSetOf<String>()
    private var hasRealtimeConnectedOnce = false

    private data class ResourceIdentity(
        val userId: String,
        val organizationId: String,
        val tableId: String,
    )

    init {
        observeOrganizationIdentity()
        bindRealtime()
        loadInitial()
    }

    public fun loadInitial() {
        reloadSchema(isResume = false)
    }

    private fun reloadSchema(isResume: Boolean, preserveOpenDetail: Boolean = false) {
        if (tableId.isBlank()) {
            _uiState.update { it.copy(isLoading = false, errorRes = R.string.tabdata_missing_table_id) }
            return
        }
        val identity = currentIdentityOrInvalidate() ?: return
        val previousViewId = _uiState.value.selectedViewId
        val previousFields = _uiState.value.fields
        val generation = ++requestGeneration
        if (!preserveOpenDetail) {
            invalidateDetailAndMutation(closeDetail = isResume)
        }
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = !isResume,
                    isRefreshing = isResume,
                    errorRes = null,
                    errorMessage = null,
                    paginationError = null,
                )
            }
            try {
                requireCurrentIdentity(identity)
                val table = repository.loadTable(tableId)
                TabDataResponseFence.requireTable(table, tableId, identity.organizationId)
                val views = repository.loadViews(tableId)
                requireCurrentIdentity(identity)
                TabDataResponseFence.requireViews(views, tableId)
                val fields = repository.loadFields(tableId)
                requireCurrentIdentity(identity)
                TabDataResponseFence.requireFields(fields, tableId)
                val selected = views.firstOrNull { it.id == previousViewId }
                    ?: views.firstOrNull { it.id == table.defaultViewId }
                    ?: views.firstOrNull()
                if (!isCurrentRequest(generation, identity)) return@launch
                val current = _uiState.value
                val rebased = if (preserveOpenDetail &&
                    (current.selectedRecord != null || current.isCreating)
                ) {
                    TabDataRealtimePolicy.rebaseOpenDetailAfterSchema(
                        previousFields = previousFields,
                        nextFields = fields,
                        detailDraft = current.detailDraft,
                        detailOriginal = current.detailOriginal,
                        record = current.selectedRecord,
                    )
                } else {
                    null
                }
                val permissionDowngraded = current.canWrite && !table.canWrite
                val selectedViewChanged = selected?.id != previousViewId
                val droppedFieldNames = rebased?.droppedFieldNames.orEmpty()
                page = 1
                _uiState.update {
                    it.copy(
                        table = table,
                        views = views,
                        fields = fields,
                        selectedViewId = selected?.id,
                        records = emptyList(),
                        groups = emptyList(),
                        total = 0,
                        hasMore = false,
                        loadingGroupKeys = emptySet(),
                        searchText = if (selectedViewChanged) "" else it.searchText,
                        filters = if (selectedViewChanged) emptyList() else it.filters.filter { rule ->
                            fields.any { field -> field.id == rule.fieldId }
                        },
                        filterLogic = if (selectedViewChanged) selected?.configuredFilterLogic ?: "and"
                        else it.filterLogic,
                        sorts = if (selectedViewChanged) emptyList() else it.sorts.filter { rule ->
                            fields.any { field -> field.id == rule.fieldId }
                        },
                        detailDraft = rebased?.draft ?: it.detailDraft,
                        detailOriginal = rebased?.original ?: it.detailOriginal,
                        isLoading = false,
                        isRefreshing = false,
                        writeBlockedByServer = false,
                        detailWriteBlocked = if (preserveOpenDetail) it.detailWriteBlocked else false,
                        hasResumableCreationDraft = draftScope(TabDataDraftStore.NEW_RECORD_ID)
                            ?.let(draftStore::load) != null,
                        errorRes = null,
                        errorMessage = null,
                        mutationMessageRes = if (preserveOpenDetail) {
                            when (droppedFieldNames.size) {
                                0 -> R.string.tabdata_schema_updated
                                1 -> R.string.tabdata_schema_dropped_field
                                else -> R.string.tabdata_schema_dropped_fields
                            }
                        } else {
                            it.mutationMessageRes
                        },
                        mutationMessage = if (preserveOpenDetail) null else it.mutationMessage,
                        // Compose 把 fields 拼成 %1$s；文案只点名第一个，其余用 count。
                        mutationMessageFields = if (preserveOpenDetail) {
                            droppedFieldNames.take(1)
                        } else {
                            it.mutationMessageFields
                        },
                        mutationMessageCount = if (preserveOpenDetail) {
                            droppedFieldNames.size.takeIf { count -> count >= 2 }
                        } else {
                            it.mutationMessageCount
                        },
                    )
                }
                if (rebased != null) persistCurrentDraft(replaceOriginal = true)
                if (permissionDowngraded) closeDetailForPermissionDowngrade()
                refreshMemberDirectory(identity, emptyList(), emptyList(), fields)
                if (selected != null) {
                    loadPage(
                        view = selected,
                        reset = true,
                        refreshing = isResume,
                        generation = generation,
                        identity = identity,
                    )
                    if (preserveOpenDetail) alignOpenDetailWithLoadedRecords()
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (isCurrentRequest(generation, identity)) {
                    if (error is TabDataOrganizationBoundaryException) {
                        clearTableDrafts()
                        clearSensitiveTableState(errorRes = null, errorMessage = error.message)
                    } else if (error is TabDataResponseMismatchException) {
                        clearSensitiveTableState(errorRes = null, errorMessage = error.message)
                    } else if (error.isResourceUnavailable()) {
                        clearTableDrafts()
                        clearSensitiveTableState(
                            errorRes = userMessageRes(error),
                            errorMessage = userMessage(error),
                        )
                    } else {
                        val offlineDrafts = loadOfflineDrafts(identity)
                        _uiState.update {
                            it.copy(
                                isLoading = false,
                                isRefreshing = false,
                                errorRes = userMessageRes(error),
                                errorMessage = userMessage(error),
                                offlineDrafts = offlineDrafts,
                                hasResumableCreationDraft = false,
                                writeBlockedByServer = true,
                                detailWriteBlocked = true,
                            )
                        }
                    }
                }
            }
        }
    }

    /** Web 完整模式可能修改视图、字段和权限；回前台必须重拉整份 schema。 */
    public fun refreshOnResume() {
        val state = _uiState.value
        if (!state.isLoading && !state.isRefreshing) reloadSchema(isResume = true)
    }

    public fun selectView(viewId: String) {
        val identity = currentIdentityOrInvalidate() ?: return
        val view = _uiState.value.views.firstOrNull { it.id == viewId } ?: return
        if (view.id == _uiState.value.selectedViewId) return
        val generation = ++requestGeneration
        invalidateDetailAndMutation(closeDetail = true)
        loadJob?.cancel()
        page = 1
        _uiState.update {
            it.copy(
                selectedViewId = viewId,
                records = emptyList(),
                groups = emptyList(),
                total = 0,
                searchText = "",
                filters = emptyList(),
                filterLogic = view.configuredFilterLogic,
                sorts = emptyList(),
                isLoading = true,
                errorRes = null,
                errorMessage = null,
                paginationError = null,
            )
        }
        loadJob = viewModelScope.launch {
            loadPage(view, reset = true, refreshing = false, generation = generation, identity = identity)
        }
    }

    public fun updateSearch(text: String) {
        _uiState.update { it.copy(searchText = text) }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(SEARCH_DEBOUNCE_MS)
            reloadForQuery()
        }
    }

    public fun addFilter(field: TabDataField, operator: String, value: JsonElement) {
        val next = _uiState.value.filters.filterNot { it.fieldId == field.id } +
            TabDataFilterRule(field.id, field.name, operator, value)
        _uiState.update { it.copy(filters = next) }
        reloadForQuery()
    }

    public fun removeFilter(fieldId: String) {
        _uiState.update {
            val remaining = it.filters.filterNot { rule -> rule.fieldId == fieldId }
            it.copy(
                filters = remaining,
                filterLogic = if (remaining.isEmpty()) it.selectedView?.configuredFilterLogic ?: "and"
                else it.filterLogic,
            )
        }
        reloadForQuery()
    }

    public fun clearFilters() {
        if (_uiState.value.filters.isEmpty()) return
        _uiState.update {
            it.copy(
                filters = emptyList(),
                filterLogic = it.selectedView?.configuredFilterLogic ?: "and",
            )
        }
        reloadForQuery()
    }

    public fun setFilterLogic(logic: String) {
        val normalized = if (logic == "or") "or" else "and"
        if (_uiState.value.filterLogic == normalized) return
        _uiState.update { it.copy(filterLogic = normalized) }
        reloadForQuery()
    }

    public fun setSort(field: TabDataField, descending: Boolean) {
        _uiState.update {
            it.copy(sorts = listOf(TabDataSortRule(field.id, field.name, descending)))
        }
        reloadForQuery()
    }

    public fun clearSort() {
        if (_uiState.value.sorts.isEmpty()) return
        _uiState.update { it.copy(sorts = emptyList()) }
        reloadForQuery()
    }

    public fun refresh() {
        val identity = currentIdentityOrInvalidate() ?: return
        val view = _uiState.value.selectedView
        if (view == null) {
            reloadSchema(isResume = true)
            return
        }
        val generation = ++requestGeneration
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            loadPage(view, reset = true, refreshing = true, generation = generation, identity = identity)
        }
    }

    public fun loadMore() {
        val state = _uiState.value
        val view = state.selectedView ?: return
        if (state.isLoadingMore || state.isLoading || state.isRefreshing || !state.hasMore ||
            view.viewType.lowercase() == "kanban"
        ) return
        val identity = currentIdentityOrInvalidate() ?: return
        val generation = requestGeneration
        loadJob = viewModelScope.launch {
            loadPage(view, reset = false, refreshing = false, generation = generation, identity = identity)
        }
    }

    public fun loadMoreGroup(groupKey: String) {
        val state = _uiState.value
        val view = state.selectedView ?: return
        val group = state.groups.firstOrNull { it.offsetKey == groupKey } ?: return
        if (state.isLoading || state.isRefreshing || !group.hasMore || groupKey in state.loadingGroupKeys) return
        val identity = currentIdentityOrInvalidate() ?: return
        val generation = requestGeneration
        viewModelScope.launch {
            _uiState.update { it.copy(loadingGroupKeys = it.loadingGroupKeys + groupKey, paginationError = null) }
            try {
                requireCurrentIdentity(identity)
                val response = repository.loadViewRecords(
                    view = view,
                    page = 1,
                    pageSize = PAGE_SIZE,
                    search = state.searchText,
                    filters = state.filters,
                    filterLogic = state.filterLogic,
                    sorts = state.sorts,
                    groupOffsets = mapOf(groupKey to (group.offset + group.records.size)),
                )
                if (!isCurrentRequest(generation, identity)) return@launch
                TabDataResponseFence.requireRecordPage(response, view, tableId)
                val incoming = response.metadata.groups.firstOrNull { it.offsetKey == groupKey }
                if (incoming != null) {
                    _uiState.update { current ->
                        current.copy(
                            groups = current.groups.map { existing ->
                                if (existing.offsetKey != groupKey) existing
                                else incoming.copy(
                                    records = (existing.records + incoming.records).distinctBy(TabDataRecord::id),
                                    offset = existing.offset,
                                )
                            },
                        )
                    }
                    val latest = _uiState.value
                    refreshMemberDirectory(identity, latest.records, latest.groups, latest.fields)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (isCurrentRequest(generation, identity)) {
                    if (error is TabDataResponseMismatchException) {
                        clearSensitiveTableState(errorRes = null, errorMessage = error.message)
                    } else if (error.isResourceUnavailable()) {
                        clearTableDrafts()
                        clearSensitiveTableState(
                            errorRes = userMessageRes(error),
                            errorMessage = userMessage(error),
                        )
                        _events.emit(NativeTabDataEvent.CloseDetail)
                    } else {
                        _uiState.update { it.copy(paginationError = userMessage(error)) }
                    }
                }
            } finally {
                if (isCurrentRequest(generation, identity)) {
                    _uiState.update { it.copy(loadingGroupKeys = it.loadingGroupKeys - groupKey) }
                }
            }
        }
    }

    public fun openVisibleRecord(recordId: String) {
        val state = _uiState.value
        val record = state.records.firstOrNull { it.id == recordId }
            ?: state.groups.asSequence().flatMap { it.records.asSequence() }.firstOrNull { it.id == recordId }
            ?: return
        openRecord(record)
    }

    public fun discardCurrentDetailDraft() {
        val state = _uiState.value
        val recordId = if (state.isCreating) TabDataDraftStore.NEW_RECORD_ID else state.selectedRecord?.id
        removeDraft(recordId)
        _uiState.update {
            it.copy(
                detailDraft = it.detailOriginal,
                detailErrors = emptyMap(),
                saveFailed = false,
                saveConflicted = false,
                justSaved = false,
            )
        }
    }

    public fun openRecord(record: TabDataRecord) {
        val identity = currentIdentityOrInvalidate() ?: return
        invalidateMutation()
        val detailGeneration = ++detailRequestGeneration
        val fields = _uiState.value.fields
        val seed = TabDataDraftPolicy.initialDraft(record, fields)
        val restored = draftScope(record.id)?.let(draftStore::load)
        val restoredDraft = restored?.let { TabDataDraftPolicy.restore(seed, it, fields) }
        _uiState.update {
            it.copy(
                selectedRecord = record,
                detailOriginal = restoredDraft?.original ?: seed,
                detailDraft = restoredDraft?.draft ?: seed,
                detailErrors = emptyMap(),
                isDetailLoading = true,
                detailWriteBlocked = restoredDraft?.isWriteCompatible == false,
                conflictMessageRes = if (restoredDraft?.isWriteCompatible == false) {
                    R.string.tabdata_version_conflict_message
                } else {
                    null
                },
                saveFailed = false,
                saveConflicted = false,
                justSaved = false,
            )
        }
        detailJob?.cancel()
        detailJob = viewModelScope.launch {
            try {
                requireCurrentIdentity(identity)
                val detail = repository.loadRecord(record.id)
                if (!isCurrentDetail(detailGeneration, identity, record.id)) return@launch
                TabDataResponseFence.requireRecord(detail, tableId, record.id)
                val remote = TabDataDraftPolicy.initialDraft(detail, _uiState.value.fields)
                val restored = draftScope(detail.id)?.let(draftStore::load)
                val restoredDraft = restored?.let { TabDataDraftPolicy.restore(remote, it, _uiState.value.fields) }
                val schemaConflict = restoredDraft?.isWriteCompatible == false
                _uiState.update {
                    it.copy(
                        selectedRecord = detail,
                        detailOriginal = restoredDraft?.original ?: remote,
                        detailDraft = restoredDraft?.draft ?: remote,
                        detailErrors = emptyMap(),
                        isDetailLoading = false,
                        detailWriteBlocked = schemaConflict,
                        conflictMessageRes = if (schemaConflict) {
                            R.string.tabdata_version_conflict_message
                        } else null,
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isCurrentDetail(detailGeneration, identity, record.id)) return@launch
                if (error.isResourceUnavailable()) {
                    removeDraft(record.id)
                    clearSensitiveRecordState(record.id, userMessage(error))
                } else {
                    _uiState.update {
                        it.copy(
                            selectedRecord = null,
                            detailDraft = emptyMap(),
                            detailOriginal = emptyMap(),
                            detailErrors = emptyMap(),
                            isDetailLoading = false,
                            mutationMessage = userMessage(error),
                        )
                    }
                }
                _events.emit(NativeTabDataEvent.CloseDetail)
            }
        }
    }

    public fun beginCreate(groupValues: JsonObject? = null) {
        val state = _uiState.value
        if (state.isSaving || state.isDeleting || currentIdentityOrInvalidate() == null) return
        val restored = draftScope(TabDataDraftStore.NEW_RECORD_ID)?.let(draftStore::load)
        if (!state.canWrite && restored == null) return
        invalidateMutation()
        detailJob?.cancel()
        detailRequestGeneration++
        val fields = _uiState.value.fields
        val empty = TabDataDraftPolicy.initialDraft(null, fields)
        val restoredDraft = restored?.let { TabDataDraftPolicy.restore(empty, it, fields) }
        val prefill = if (restored == null) {
            TabDataPrefillPolicy.resolve(state.selectedView, fields, groupValues)
        } else {
            null
        }
        val seeded = if (prefill == null) empty else empty + prefill
        val readOnly = !state.canWrite || restoredDraft?.isWriteCompatible == false
        _uiState.update {
            it.copy(
                selectedRecord = null,
                detailOriginal = restoredDraft?.original ?: empty,
                detailDraft = restoredDraft?.draft ?: seeded,
                detailErrors = emptyMap(),
                isCreating = true,
                detailWriteBlocked = readOnly,
                conflictMessageRes = when {
                    restored == null -> it.conflictMessageRes
                    readOnly -> R.string.tabdata_permission_changed_draft_preserved
                    else -> null
                },
            )
        }
        if (restored == null) persistCurrentDraft()
    }

    public fun beginCreateFromGroup(group: TabDataRecordGroup) {
        val state = _uiState.value
        beginCreate(TabDataPrefillPolicy.groupValuesFrom(state.selectedView, state.fields, group))
    }

    public fun clearFieldCreationError() {
        _uiState.update { it.copy(fieldCreationErrorRes = null, fieldCreationError = null) }
    }

    public fun createField(
        name: String,
        fieldType: TabDataCreateFieldType,
        choices: List<String> = emptyList(),
    ) {
        val state = _uiState.value
        val identity = currentIdentityOrInvalidate() ?: return
        if (!state.canWrite || state.isCreatingField) return
        val request = TabDataFieldCreationPolicy.request(tableId, name, fieldType, choices)
        val validationError = TabDataFieldCreationPolicy.validationError(request, state.fields, fieldType)
        if (validationError != null) {
            _uiState.update {
                it.copy(
                    fieldCreationErrorRes = when (validationError) {
                        TabDataCreateFieldValidationError.EMPTY_NAME -> R.string.tabdata_field_name_required
                        TabDataCreateFieldValidationError.NAME_TOO_LONG -> R.string.tabdata_field_name_too_long
                        TabDataCreateFieldValidationError.DUPLICATE_NAME -> R.string.tabdata_field_name_duplicate
                        TabDataCreateFieldValidationError.MISSING_CHOICES -> R.string.tabdata_field_choices_required
                    },
                    fieldCreationError = null,
                )
            }
            return
        }
        val generation = ++fieldMutationGeneration
        fieldMutationJob?.cancel()
        _uiState.update {
            it.copy(
                isCreatingField = true,
                fieldCreationErrorRes = null,
                fieldCreationError = null,
                mutationMessageRes = null,
                mutationMessage = null,
            )
        }
        fieldMutationJob = viewModelScope.launch {
            try {
                requireCurrentIdentity(identity)
                val created = repository.createField(request)
                if (!isCurrentFieldMutation(generation, identity)) return@launch
                TabDataResponseFence.requireFields(listOf(created), tableId)
                if (created.name != request.name || created.fieldType.lowercase() != request.fieldType) {
                    throw TabDataResponseMismatchException()
                }
                val refreshedFields = repository.loadFields(tableId)
                requireCurrentIdentity(identity)
                if (!isCurrentFieldMutation(generation, identity)) return@launch
                TabDataResponseFence.requireFields(refreshedFields, tableId)
                if (refreshedFields.none { field ->
                        field.id == created.id && field.name == request.name &&
                            field.fieldType.lowercase() == request.fieldType
                    }
                ) {
                    throw TabDataResponseMismatchException()
                }
                _uiState.update {
                    it.copy(
                        fields = refreshedFields.sortedBy(TabDataField::order),
                        isCreatingField = false,
                        fieldCreationErrorRes = null,
                        fieldCreationError = null,
                        mutationMessageRes = R.string.tabdata_field_created,
                    )
                }
                refreshAfterMutation()
                _events.emit(NativeTabDataEvent.FieldCreated)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isCurrentFieldMutation(generation, identity)) return@launch
                _uiState.update {
                    it.copy(
                        isCreatingField = false,
                        writeBlockedByServer = it.writeBlockedByServer || error.isWritePermissionDenied(),
                        fieldCreationErrorRes = if (error.message.isNullOrBlank()) {
                            R.string.tabdata_field_create_failed
                        } else null,
                        fieldCreationError = error.message?.takeIf(String::isNotBlank),
                    )
                }
            }
        }
    }

    /**
     * 从初载错误页打开一条本地草稿。没有服务端 schema 与权限时只展示原始 name/value，
     * `canEditDetail` 始终为 false，因此不能提交、删除或触发任何 mutation。
     */
    public fun openOfflineDraft(recordId: String) {
        val identity = currentIdentityOrInvalidate() ?: return
        val snapshot = _uiState.value.offlineDrafts.firstOrNull {
            it.scope == TabDataDraftScope(identity.userId, identity.organizationId, tableId, recordId)
        } ?: return
        invalidateMutation()
        detailJob?.cancel()
        detailRequestGeneration++
        _uiState.update {
            it.copy(
                selectedRecord = null,
                detailOriginal = snapshot.original,
                detailDraft = snapshot.draft,
                detailErrors = emptyMap(),
                isDetailLoading = false,
                isCreating = snapshot.isCreating,
                writeBlockedByServer = true,
                detailWriteBlocked = true,
                conflictMessageRes = R.string.tabdata_offline_draft_message,
            )
        }
    }

    public suspend fun searchPickerMembers(
        query: String,
        offset: Int = 0,
    ): Result<TabDataMemberSearchPage> {
        val identity = currentIdentityOrNull()
            ?: return Result.failure(IllegalStateException("missing organization"))
        return try {
            val page = memberDirectoryStore.searchMembers(
                identity.organizationId,
                query,
                offset = offset,
            )
            _uiState.update { it.copy(memberDirectory = memberDirectoryStore.snapshot(identity.organizationId)) }
            Result.success(page)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            Result.failure(error)
        }
    }

    public fun updateDraft(field: TabDataField, value: JsonElement) {
        val state = _uiState.value
        if (!state.canEditDetail || state.isSaving || state.isDeleting ||
            TabDataFieldPolicy.editMode(field.fieldType) != TabDataFieldEditMode.NATIVE
        ) return
        _uiState.update {
            it.copy(
                detailDraft = it.detailDraft + (field.name to value),
                detailErrors = it.detailErrors - field.name,
                conflictMessageRes = null,
                saveFailed = false,
                saveConflicted = false,
                justSaved = false,
            )
        }
        persistCurrentDraft()
    }

    public fun dismissDetail() {
        if (_uiState.value.isSaving || _uiState.value.isDeleting) return
        invalidateMutation()
        detailJob?.cancel()
        detailRequestGeneration++
        _uiState.update {
            it.copy(
                selectedRecord = null,
                detailDraft = emptyMap(),
                detailOriginal = emptyMap(),
                detailErrors = emptyMap(),
                isCreating = false,
                detailWriteBlocked = false,
                conflictMessageRes = null,
                saveFailed = false,
                saveConflicted = false,
                justSaved = false,
            )
        }
    }

    public fun saveDetail() {
        val state = _uiState.value
        val identity = currentIdentityOrInvalidate() ?: return
        if (!state.canEditDetail || state.isSaving || state.isDeleting) return
        val errors = TabDataDraftPolicy.validate(state.detailDraft, state.fields)
        if (errors.isNotEmpty()) {
            _uiState.update { it.copy(detailErrors = errors) }
            return
        }
        val dirty = if (state.isCreating) {
            // 预填可能落在移动端只读字段（附件 / 关联记录）上，提交时仍要带上，
            // 否则新记录不满足当前视图筛选。可写性以 Web 创建期规则为准，不看详情编辑态。
            JsonObject(
                state.detailDraft.filter { (_, value) -> value !is JsonNull },
            )
        } else {
            TabDataDraftPolicy.dirtyFields(state.detailOriginal, state.detailDraft, state.fields)
        }
        if (dirty.isEmpty() && !state.isCreating) {
            _events.tryEmit(NativeTabDataEvent.CloseDetail)
            return
        }
        val recordId = if (state.isCreating) TabDataDraftStore.NEW_RECORD_ID
        else state.selectedRecord?.id ?: return
        val mutation = ++mutationGeneration
        _uiState.update {
            it.copy(
                isSaving = true,
                mutationMessageRes = null,
                mutationMessage = null,
                mutationMessageFields = emptyList(),
                mutationMessageCount = null,
                conflictMessageRes = null,
                saveFailed = false,
                saveConflicted = false,
                justSaved = false,
            )
        }
        markRealtimePending(recordId)
        mutationJob = viewModelScope.launch {
            try {
                requireCurrentIdentity(identity)
                val outcomeConflicts: List<TabDataFieldConflict>
                val saved = if (state.isCreating) {
                    outcomeConflicts = emptyList()
                    repository.createRecord(tableId, dirty)
                } else {
                    val record = state.selectedRecord ?: return@launch
                    val snapshot = draftScope(record.id)?.let(draftStore::load)
                    val editStart = TabDataBulkUpdatePolicy.editStartValues(
                        snapshot = snapshot,
                        detailOriginal = state.detailOriginal,
                        fields = state.fields,
                    )
                    val payload = TabDataBulkUpdatePolicy.fieldIdPayload(
                        dirtyByName = dirty,
                        originalByName = editStart,
                        fields = state.fields,
                    )
                    val outcome = repository.updateRecord(record.id, payload.data, payload.baseSnapshot)
                    outcomeConflicts = outcome.conflicts
                    outcome.record
                }
                if (!isCurrentMutation(mutation, identity, recordId)) return@launch
                TabDataResponseFence.requireRecord(
                    saved,
                    expectedTableId = tableId,
                    expectedRecordId = state.selectedRecord?.id,
                )
                removeDraft(recordId, identity)
                val conflictNames = TabDataBulkUpdatePolicy.conflictFieldNames(outcomeConflicts, state.fields)
                val conflictHint = outcomeConflicts.isNotEmpty()
                _uiState.update {
                    it.copy(
                        selectedRecord = saved,
                        detailOriginal = TabDataDraftPolicy.initialDraft(saved, it.fields),
                        detailDraft = TabDataDraftPolicy.initialDraft(saved, it.fields),
                        isSaving = false,
                        isCreating = false,
                        detailWriteBlocked = false,
                        hasResumableCreationDraft = false,
                        mutationMessageRes = if (conflictHint) {
                            if (conflictNames.hasOverflow) {
                                R.string.tabdata_collaborative_fields_changed
                            } else {
                                R.string.tabdata_collaborative_field_changed
                            }
                        } else {
                            R.string.tabdata_saved
                        },
                        mutationMessage = null,
                        mutationMessageFields = if (conflictHint) conflictNames.listed else emptyList(),
                        mutationMessageCount = if (conflictHint && conflictNames.hasOverflow) {
                            conflictNames.total
                        } else null,
                        saveFailed = false,
                        saveConflicted = false,
                        justSaved = !conflictHint,
                    )
                }
                refreshAfterMutation()
                _events.emit(NativeTabDataEvent.CloseDetail)
            } catch (_: AppError.VersionConflict) {
                if (isCurrentMutation(mutation, identity, recordId)) {
                    _uiState.update {
                        it.copy(
                            isSaving = false,
                            mutationMessageRes = R.string.tabdata_save_version_conflict_retry,
                            mutationMessage = null,
                            mutationMessageFields = emptyList(),
                            mutationMessageCount = null,
                            saveConflicted = true,
                            saveFailed = false,
                            justSaved = false,
                        )
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isCurrentMutation(mutation, identity, recordId)) return@launch
                if (error is TabDataResponseMismatchException) {
                    lockDraftForConflict(error)
                    return@launch
                }
                if (error.isWritePermissionDenied()) {
                    revalidateAfterWritePermissionDenied(
                        state = state,
                        mutation = mutation,
                        identity = identity,
                        recordId = recordId,
                    )
                    return@launch
                }
                if (error.isResourceGone()) {
                    removeDraft(recordId, identity)
                    if (!state.isCreating) {
                        state.selectedRecord?.id?.let { clearSensitiveRecordState(it, userMessage(error)) }
                        _events.emit(NativeTabDataEvent.CloseDetail)
                        return@launch
                    }
                }
                _uiState.update {
                    it.copy(
                        isSaving = false,
                        mutationMessageRes = userMessageRes(error),
                        mutationMessage = userMessage(error),
                        mutationMessageFields = emptyList(),
                        mutationMessageCount = null,
                        saveFailed = true,
                        saveConflicted = false,
                        justSaved = false,
                    )
                }
            } finally {
                clearRealtimePending(recordId)
            }
        }
    }

    public fun deleteRecord() {
        val state = _uiState.value
        val record = state.selectedRecord ?: return
        val identity = currentIdentityOrInvalidate() ?: return
        if (!state.canEditDetail || state.isSaving || state.isDeleting) return
        val mutation = ++mutationGeneration
        _uiState.update {
            it.copy(
                isDeleting = true,
                mutationMessageRes = null,
                mutationMessage = null,
                mutationMessageFields = emptyList(),
                mutationMessageCount = null,
            )
        }
        markRealtimePending(record.id)
        mutationJob = viewModelScope.launch {
            try {
                requireCurrentIdentity(identity)
                val expectedVersion = _uiState.value.selectedRecord?.version
                    ?: draftScope(record.id)?.let(draftStore::load)?.expectedVersion
                    ?: record.version
                repository.deleteRecord(record.id, expectedVersion)
                if (!isCurrentMutation(mutation, identity, record.id)) return@launch
                removeDraft(record.id, identity)
                _uiState.update {
                    it.copy(
                        selectedRecord = null,
                        detailDraft = emptyMap(),
                        detailOriginal = emptyMap(),
                        isDeleting = false,
                        mutationMessageRes = R.string.tabdata_record_deleted,
                        mutationMessage = null,
                        mutationMessageFields = emptyList(),
                        mutationMessageCount = null,
                    )
                }
                refreshAfterMutation()
                _events.emit(NativeTabDataEvent.CloseDetail)
            } catch (_: AppError.VersionConflict) {
                if (!isCurrentMutation(mutation, identity, record.id)) return@launch
                val latest = try {
                    repository.loadRecord(record.id).also { remote ->
                        TabDataResponseFence.requireRecord(remote, tableId, record.id)
                    }
                } catch (_: Exception) {
                    null
                }
                if (!isCurrentMutation(mutation, identity, record.id)) return@launch
                _uiState.update {
                    it.copy(
                        isDeleting = false,
                        selectedRecord = latest ?: it.selectedRecord,
                        mutationMessageRes = R.string.tabdata_delete_version_conflict,
                        mutationMessage = null,
                        mutationMessageFields = emptyList(),
                        mutationMessageCount = null,
                    )
                }
                if (latest != null) persistCurrentDraft()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isCurrentMutation(mutation, identity, record.id)) return@launch
                if (error is TabDataResponseMismatchException) {
                    lockDraftForConflict(error)
                } else if (error.isWritePermissionDenied()) {
                    revalidateAfterWritePermissionDenied(
                        state = state,
                        mutation = mutation,
                        identity = identity,
                        recordId = record.id,
                    )
                } else if (error.isResourceGone()) {
                    removeDraft(record.id, identity)
                    clearSensitiveRecordState(record.id, userMessage(error))
                    _events.emit(NativeTabDataEvent.CloseDetail)
                } else {
                    _uiState.update { it.copy(isDeleting = false, mutationMessage = userMessage(error)) }
                }
            } finally {
                clearRealtimePending(record.id)
            }
        }
    }

    public fun requestFullEditor() {
        val state = _uiState.value
        if (state.isSaving || state.isDeleting) {
            _events.tryEmit(NativeTabDataEvent.FullEditorBlocked(R.string.tabdata_full_mode_blocked))
        } else if (
            state.isDetailDirty || state.isCreating || state.conflictMessageRes != null ||
            hasPersistedTableDrafts()
        ) {
            // 不自动清：用户可能已经关闭详情，但草稿仍是其唯一一份输入。
            _events.tryEmit(NativeTabDataEvent.ConfirmDiscardDraftsForFullEditor)
        } else {
            _events.tryEmit(NativeTabDataEvent.OpenFullEditor)
        }
    }

    /** 仅由确认弹窗调用：明确放弃这张表内全部持久草稿，再进入 Web 完整模式。 */
    public fun discardTableDraftsAndOpenFullEditor() {
        if (_uiState.value.isSaving || _uiState.value.isDeleting) return
        if (currentIdentityOrInvalidate() == null) return
        val userId = draftUserId ?: return
        val organizationId = currentOrganizationId() ?: return
        if (!draftStore.clearTable(userId, organizationId, tableId)) {
            _events.tryEmit(NativeTabDataEvent.FullEditorBlocked(R.string.tabdata_full_mode_discard_failed))
            return
        }
        detailRequestGeneration++
        _uiState.update {
            it.copy(
                selectedRecord = null,
                detailDraft = emptyMap(),
                detailOriginal = emptyMap(),
                detailErrors = emptyMap(),
                isCreating = false,
                detailWriteBlocked = false,
                hasResumableCreationDraft = false,
                conflictMessageRes = null,
            )
        }
        _events.tryEmit(NativeTabDataEvent.OpenFullEditor)
    }

    public fun consumeMessage() {
        _uiState.update {
            it.copy(
                mutationMessageRes = null,
                mutationMessage = null,
                mutationMessageFields = emptyList(),
                mutationMessageCount = null,
            )
        }
    }

    private fun currentOrganizationId(): String? = _uiState.value.table?.organizationId
        ?.takeIf(String::isNotBlank)
        ?: routeOrganizationId?.takeIf(String::isNotBlank)

    private fun draftScope(recordId: String): TabDataDraftScope? {
        val userId = draftUserId ?: return null
        val organizationId = currentOrganizationId() ?: return null
        return TabDataDraftScope(userId, organizationId, tableId, recordId)
    }

    private fun hasPersistedTableDrafts(): Boolean {
        val userId = draftUserId ?: return false
        val organizationId = currentOrganizationId() ?: return false
        return draftStore.hasTableDrafts(userId, organizationId, tableId)
    }

    private fun loadOfflineDrafts(identity: ResourceIdentity): List<TabDataDraftSnapshot> {
        if (!isCurrentIdentity(identity)) return emptyList()
        return draftStore.listTableDrafts(identity.userId, identity.organizationId, tableId)
    }

    private fun persistCurrentDraft(replaceOriginal: Boolean = false) {
        val state = _uiState.value
        val recordId = if (state.isCreating) TabDataDraftStore.NEW_RECORD_ID
        else state.selectedRecord?.id ?: return
        val scope = draftScope(recordId) ?: return
        val previous = draftStore.load(scope)
        val expectedVersion = if (state.isCreating) null
        else state.selectedRecord?.version ?: previous?.expectedVersion
        draftStore.save(
            TabDataDraftSnapshot(
                scope = scope,
                original = if (replaceOriginal || previous == null) {
                    JsonObject(state.detailOriginal)
                } else {
                    previous.original
                },
                draft = JsonObject(state.detailDraft),
                expectedVersion = expectedVersion,
                isCreating = state.isCreating,
                fieldIdentities = TabDataDraftSchema.identities(state.fields),
                schemaFingerprint = TabDataDraftSchema.fingerprint(state.fields),
            ),
        )
    }

    private fun removeDraft(recordId: String?, identity: ResourceIdentity? = currentIdentityOrNull()) {
        val scope = identity?.let {
            recordId?.let { id -> TabDataDraftScope(it.userId, it.organizationId, tableId, id) }
        }
        scope?.let(draftStore::remove)
    }

    private fun clearTableDrafts() {
        val userId = draftUserId ?: return
        setOfNotNull(
            routeOrganizationId?.takeIf(String::isNotBlank),
            tokenManager.organizationId?.takeIf(String::isNotBlank),
        ).forEach { organizationId ->
            draftStore.clearTable(userId, organizationId, tableId)
        }
    }

    /**
     * 写请求的 403 只证明写权限被拒绝，不能据此推断读取权限也已撤销。
     * 先保留唯一的本地草稿，再用读取链路重新判权：仍可读时留在只读冲突态；
     * 读取也被拒绝、资源消失或组织边界不匹配时才清理受保护内容。
     */
    private suspend fun revalidateAfterWritePermissionDenied(
        state: NativeTabDataUiState,
        mutation: Long,
        identity: ResourceIdentity,
        recordId: String,
    ) {
        val table: TabDataTable
        val views: List<TabDataView>
        val fields: List<TabDataField>
        try {
            requireCurrentIdentity(identity)
            table = repository.loadTable(tableId)
            TabDataResponseFence.requireTable(table, tableId, identity.organizationId)
            views = repository.loadViews(tableId)
            requireCurrentIdentity(identity)
            TabDataResponseFence.requireViews(views, tableId)
            fields = repository.loadFields(tableId)
            requireCurrentIdentity(identity)
            TabDataResponseFence.requireFields(fields, tableId)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (!isCurrentMutation(mutation, identity, recordId)) return
            if (error is TabDataOrganizationBoundaryException || error.isResourceUnavailable()) {
                clearTableDrafts()
                clearSensitiveTableState(
                    errorRes = userMessageRes(error),
                    errorMessage = userMessage(error),
                )
            } else {
                retainDraftAfterUnconfirmedWriteDenial(error)
            }
            return
        }

        val refreshedRecord = if (state.isCreating) {
            null
        } else {
            try {
                repository.loadRecord(recordId)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                if (!isCurrentMutation(mutation, identity, recordId)) return
                if (error.isResourceUnavailable()) {
                    removeDraft(recordId, identity)
                    clearSensitiveRecordState(recordId, userMessage(error))
                    _events.emit(NativeTabDataEvent.CloseDetail)
                } else {
                    retainDraftAfterUnconfirmedWriteDenial(error)
                }
                return
            }
        }

        if (!isCurrentMutation(mutation, identity, recordId)) return
        try {
            refreshedRecord?.let { TabDataResponseFence.requireRecord(it, tableId, recordId) }
        } catch (error: TabDataResponseMismatchException) {
            retainDraftAfterUnconfirmedWriteDenial(error)
            return
        }
        val previousViewId = _uiState.value.selectedViewId
        val selected = views.firstOrNull { it.id == previousViewId }
            ?: views.firstOrNull { it.id == table.defaultViewId }
            ?: views.firstOrNull()
        _uiState.update { current ->
            current.copy(
                table = table,
                views = views,
                fields = fields,
                selectedViewId = selected?.id,
                selectedRecord = refreshedRecord ?: current.selectedRecord,
                records = refreshedRecord?.let { remote ->
                    current.records.map { if (it.id == remote.id) remote else it }
                } ?: current.records,
                groups = refreshedRecord?.let { remote ->
                    current.groups.map { group ->
                        group.copy(records = group.records.map { if (it.id == remote.id) remote else it })
                    }
                } ?: current.groups,
                isSaving = false,
                isDeleting = false,
                writeBlockedByServer = true,
                conflictMessageRes = R.string.tabdata_permission_changed_draft_preserved,
                mutationMessageRes = null,
                mutationMessage = null,
            )
        }
    }

    private fun retainDraftAfterUnconfirmedWriteDenial(error: Exception) {
        _uiState.update {
            it.copy(
                isSaving = false,
                isDeleting = false,
                writeBlockedByServer = true,
                detailWriteBlocked = true,
                conflictMessageRes = R.string.tabdata_permission_changed_draft_preserved,
                mutationMessageRes = userMessageRes(error),
                mutationMessage = userMessage(error),
            )
        }
    }

    private fun lockDraftForConflict(error: Exception) {
        _uiState.update {
            it.copy(
                isSaving = false,
                isDeleting = false,
                detailWriteBlocked = true,
                conflictMessageRes = R.string.tabdata_version_conflict_message,
                mutationMessage = error.message,
                saveConflicted = true,
                saveFailed = false,
                justSaved = false,
            )
        }
    }

    private fun observeOrganizationIdentity() {
        viewModelScope.launch {
            organizationRepository.selectedOrganization.collect { organization ->
                val selectedId = organization?.id?.takeIf(String::isNotBlank)
                val routeId = routeOrganizationId?.takeIf(String::isNotBlank)
                val activeId = tokenManager.organizationId?.takeIf(String::isNotBlank)
                val userId = tokenManager.userId?.takeIf(String::isNotBlank)
                val sessionMatches = tokenManager.isLoggedIn && userId == draftUserId && activeId == routeId
                when {
                    selectedId != null -> {
                        hasObservedSelectedOrganization = true
                        if (!sessionMatches || selectedId != routeId) invalidateIdentity()
                    }
                    !sessionMatches || hasObservedSelectedOrganization -> invalidateIdentity()
                    else -> Unit // App 启动期 selectedOrganization 尚未恢复，Token scope 已足够校验首请求。
                }
            }
        }
    }

    private fun currentIdentityOrNull(): ResourceIdentity? {
        val userId = tokenManager.userId?.takeIf(String::isNotBlank) ?: return null
        val routeId = routeOrganizationId?.takeIf(String::isNotBlank) ?: return null
        val activeId = tokenManager.organizationId?.takeIf(String::isNotBlank) ?: return null
        val selectedId = organizationRepository.selectedOrganization.value?.id?.takeIf(String::isNotBlank)
        if (!tokenManager.isLoggedIn || userId != draftUserId || activeId != routeId) return null
        // selectedOrganization 启动时允许暂为 null；一旦有值，必须与路由组织一致。
        if (selectedId != null && selectedId != routeId) return null
        return ResourceIdentity(userId = userId, organizationId = routeId, tableId = tableId)
    }

    private fun currentIdentityOrInvalidate(): ResourceIdentity? = currentIdentityOrNull().also {
        if (it == null) invalidateIdentity()
    }

    private fun requireCurrentIdentity(expected: ResourceIdentity) {
        if (identityInvalidated || currentIdentityOrNull() != expected) throw resourceBoundaryError()
    }

    private fun isCurrentIdentity(expected: ResourceIdentity): Boolean =
        !identityInvalidated && currentIdentityOrNull() == expected

    private fun isCurrentRequest(generation: Long, identity: ResourceIdentity): Boolean =
        generation == requestGeneration && isCurrentIdentity(identity)

    private fun isCurrentDetail(
        generation: Long,
        identity: ResourceIdentity,
        recordId: String,
    ): Boolean = generation == detailRequestGeneration &&
        isCurrentIdentity(identity) &&
        _uiState.value.selectedRecord?.id == recordId

    private fun isCurrentMutation(
        generation: Long,
        identity: ResourceIdentity,
        recordId: String,
    ): Boolean {
        val state = _uiState.value
        val currentRecordId = if (state.isCreating) TabDataDraftStore.NEW_RECORD_ID else state.selectedRecord?.id
        return generation == mutationGeneration && isCurrentIdentity(identity) && currentRecordId == recordId
    }

    private fun isCurrentFieldMutation(
        generation: Long,
        identity: ResourceIdentity,
    ): Boolean = generation == fieldMutationGeneration && isCurrentIdentity(identity)

    private fun canMutate(): Boolean {
        if (!_uiState.value.canWrite) return false
        return currentIdentityOrInvalidate() != null
    }

    private fun invalidateIdentity() {
        if (identityInvalidated) return
        identityInvalidated = true
        requestGeneration++
        searchJob?.cancel()
        loadJob?.cancel()
        invalidateFieldMutation()
        invalidateDetailAndMutation(closeDetail = true)
        clearTableDrafts()
        unbindRealtimeSubscription()
        clearSensitiveTableState(
            errorRes = null,
            errorMessage = resourceBoundaryError().serverMessage,
        )
    }

    private fun invalidateDetailAndMutation(closeDetail: Boolean) {
        detailRequestGeneration++
        mutationGeneration++
        detailJob?.cancel()
        mutationJob?.cancel()
        detailJob = null
        mutationJob = null
        if (closeDetail) {
            _uiState.update {
                it.copy(
                    selectedRecord = null,
                    detailDraft = emptyMap(),
                    detailOriginal = emptyMap(),
                    detailErrors = emptyMap(),
                    isDetailLoading = false,
                    isSaving = false,
                    isDeleting = false,
                    isCreating = false,
                    detailWriteBlocked = false,
                    conflictMessageRes = null,
                )
            }
            _events.tryEmit(NativeTabDataEvent.CloseDetail)
        }
    }

    private fun invalidateMutation() {
        mutationGeneration++
        mutationJob?.cancel()
        mutationJob = null
        _uiState.update { it.copy(isSaving = false, isDeleting = false) }
    }

    private fun invalidateFieldMutation() {
        fieldMutationGeneration++
        fieldMutationJob?.cancel()
        fieldMutationJob = null
        _uiState.update { it.copy(isCreatingField = false) }
    }

    private fun closeDetailForPermissionDowngrade() {
        invalidateDetailAndMutation(closeDetail = true)
    }

    private fun resourceBoundaryError(): AppError.RequestFailed = AppError.RequestFailed(
        serverMessage = "这项资源不存在或已不可见",
        errorCode = "NOT_FOUND",
    )

    private fun clearSensitiveTableState(
        @StringRes errorRes: Int?,
        errorMessage: String?,
    ) {
        page = 1
        invalidateFieldMutation()
        invalidateDetailAndMutation(closeDetail = true)
        _uiState.update {
            NativeTabDataUiState(
                tableId = tableId,
                isLoading = false,
                errorRes = errorRes,
                errorMessage = errorMessage,
            )
        }
    }

    private fun clearSensitiveRecordState(recordId: String, message: String?) {
        detailRequestGeneration++
        mutationGeneration++
        _uiState.update { state ->
            state.copy(
                records = state.records.filterNot { it.id == recordId },
                groups = state.groups.map { group ->
                    group.copy(
                        records = group.records.filterNot { it.id == recordId },
                        count = (group.count - group.records.count { it.id == recordId }).coerceAtLeast(0),
                    )
                },
                selectedRecord = null,
                detailDraft = emptyMap(),
                detailOriginal = emptyMap(),
                detailErrors = emptyMap(),
                isDetailLoading = false,
                isSaving = false,
                isDeleting = false,
                isCreating = false,
                detailWriteBlocked = false,
                conflictMessageRes = null,
                mutationMessage = message,
            )
        }
    }

    private fun reloadForQuery() {
        val view = _uiState.value.selectedView ?: return
        val identity = currentIdentityOrInvalidate() ?: return
        val generation = ++requestGeneration
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            loadPage(view, reset = true, refreshing = false, generation = generation, identity = identity)
        }
    }

    private suspend fun refreshMemberDirectory(
        identity: ResourceIdentity,
        records: List<TabDataRecord>,
        groups: List<TabDataRecordGroup>,
        fields: List<TabDataField>,
    ) {
        val extraIds = TabDataMemberDirectory.collectUserIds(
            records + groups.flatMap(TabDataRecordGroup::records),
            fields,
        )
        val directory = runCatching {
            memberDirectoryStore.warmUp(identity.organizationId, extraIds)
        }.getOrElse { memberDirectoryStore.snapshot(identity.organizationId) }
        if (!isCurrentIdentity(identity)) return
        _uiState.update { it.copy(memberDirectory = directory) }
    }

    private suspend fun loadPage(
        view: TabDataView,
        reset: Boolean,
        refreshing: Boolean,
        generation: Long,
        identity: ResourceIdentity,
    ) {
        if (!isCurrentRequest(generation, identity)) return
        if (!view.supportsNativeCards) {
            if (isCurrentRequest(generation, identity)) {
                _uiState.update {
                    it.copy(isLoading = false, isRefreshing = false, errorRes = null, errorMessage = null)
                }
            }
            return
        }
        val nextPage = if (reset) 1 else page + 1
        _uiState.update {
            it.copy(
                isLoading = reset && !refreshing,
                isRefreshing = refreshing,
                isLoadingMore = !reset,
                errorRes = if (reset) null else it.errorRes,
                errorMessage = if (reset) null else it.errorMessage,
                paginationError = null,
            )
        }
        try {
            requireCurrentIdentity(identity)
            val state = _uiState.value
            val response = repository.loadViewRecords(
                view = view,
                page = nextPage,
                pageSize = PAGE_SIZE,
                search = state.searchText,
                filters = state.filters,
                filterLogic = state.filterLogic,
                sorts = state.sorts,
            )
            if (!isCurrentRequest(generation, identity)) return
            TabDataResponseFence.requireRecordPage(response, view, tableId)
            page = nextPage
            val isKanban = view.viewType.lowercase() == "kanban"
            _uiState.update { current ->
                current.copy(
                    records = if (isKanban) emptyList() else if (reset) response.records
                    else (current.records + response.records).distinctBy(TabDataRecord::id),
                    groups = if (isKanban) response.metadata.groups else emptyList(),
                    total = response.matchedTotal,
                    hasMore = !isKanban && nextPage * response.pageSize < response.matchedTotal,
                    isLoading = false,
                    isRefreshing = false,
                    isLoadingMore = false,
                )
            }
            val latest = _uiState.value
            refreshMemberDirectory(identity, latest.records, latest.groups, latest.fields)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            if (isCurrentRequest(generation, identity)) {
                if (error is TabDataResponseMismatchException) {
                    clearSensitiveTableState(errorRes = null, errorMessage = error.message)
                } else if (error.isResourceUnavailable()) {
                    clearTableDrafts()
                    clearSensitiveTableState(
                        errorRes = userMessageRes(error),
                        errorMessage = userMessage(error),
                    )
                    _events.emit(NativeTabDataEvent.CloseDetail)
                } else {
                    _uiState.update {
                        it.copy(
                            isLoading = false,
                            isRefreshing = false,
                            isLoadingMore = false,
                            errorRes = if (reset) userMessageRes(error) else it.errorRes,
                            errorMessage = if (reset) userMessage(error) else it.errorMessage,
                            paginationError = if (reset) null else userMessage(error),
                        )
                    }
                }
            }
        }
    }

    private fun refreshAfterMutation() {
        val view = _uiState.value.selectedView ?: return
        val identity = currentIdentityOrInvalidate() ?: return
        val generation = ++requestGeneration
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            loadPage(view, reset = true, refreshing = false, generation = generation, identity = identity)
        }
    }

    @StringRes
    private fun userMessageRes(error: Exception): Int? = when (error) {
        is AppError.RequestFailed -> when {
            error.errorCode == TabDataRepository.SAVE_BUSY_CODE -> R.string.tabdata_save_busy
            error.serverMessage.isNullOrBlank() -> R.string.tabdata_load_failed
            else -> null
        }
        else -> if (error.message.isNullOrBlank()) R.string.tabdata_load_failed else null
    }

    private fun userMessage(error: Exception): String? = when (error) {
        is AppError.RequestFailed -> if (error.errorCode == TabDataRepository.SAVE_BUSY_CODE) null
        else error.serverMessage?.takeIf(String::isNotBlank)
        else -> error.message?.takeIf(String::isNotBlank)
    }

    private fun Exception.isResourceUnavailable(): Boolean {
        return isWritePermissionDenied() || isResourceGone()
    }

    private fun Exception.isWritePermissionDenied(): Boolean {
        if (this is HttpException && code() == 403) return true
        val code = (this as? AppError.RequestFailed)?.errorCode?.trim()?.uppercase()
        return code in setOf("PERMISSION_DENIED", "FORBIDDEN", "403")
    }

    private fun Exception.isResourceGone(): Boolean {
        if (this is HttpException && code() == 404) return true
        val code = (this as? AppError.RequestFailed)?.errorCode?.trim()?.uppercase()
        return code in setOf("NOT_FOUND", "404")
    }

    private fun bindRealtime() {
        if (tableId.isBlank()) return
        webSocketService.onEnvelope(wsHandlerKey, ::handleTableEnvelope)
        subscribeToTable(tableId)
        observeRealtimeReconnect()
    }

    private fun subscribeToTable(nextTableId: String) {
        if (nextTableId.isBlank()) {
            unbindRealtimeSubscription()
            return
        }
        val topic = TabDataRealtimePolicy.topic(nextTableId)
        if (subscribedTableTopic == topic) return
        subscribedTableTopic?.let { webSocketService.unsubscribe(listOf(it)) }
        subscribedTableTopic = topic
        webSocketService.subscribe(listOf(topic))
    }

    private fun unbindRealtimeSubscription() {
        subscribedTableTopic?.let { webSocketService.unsubscribe(listOf(it)) }
        subscribedTableTopic = null
    }

    private fun observeRealtimeReconnect() {
        viewModelScope.launch {
            var wasConnected = false
            webSocketService.connectionState.collect { connectionState ->
                val connected = connectionState == WSConnectionState.Connected
                if (connected && !wasConnected) {
                    if (hasRealtimeConnectedOnce && !identityInvalidated && _uiState.value.table != null) {
                        refreshFromRealtime()
                    }
                    hasRealtimeConnectedOnce = true
                }
                wasConnected = connected
            }
        }
    }

    internal fun handleTableEnvelope(envelope: WSEnvelope) {
        if (identityInvalidated || tableId.isBlank()) return
        val structure = TabDataRealtimePolicy.parseStructureChange(envelope, tableId)
        if (structure != null) {
            when (TabDataRealtimePolicy.decideStructure(structure)) {
                TabDataRealtimeDecision.ReloadSchema -> reloadSchemaFromRealtime()
                TabDataRealtimeDecision.Ignore -> Unit
                else -> Unit
            }
            return
        }
        val delta = TabDataRealtimePolicy.parseDelta(envelope, tableId) ?: return
        val state = _uiState.value
        val decision = TabDataRealtimePolicy.decide(
            delta = delta,
            localUserId = draftUserId,
            pendingRecordIds = pendingRealtimeRecordIds.toSet(),
            editingRecordId = if (state.isCreating) null else state.selectedRecord?.id,
            isDetailDirty = state.isDetailDirty,
        )
        when (decision) {
            TabDataRealtimeDecision.Ignore -> Unit
            TabDataRealtimeDecision.Refresh -> refreshFromRealtime()
            TabDataRealtimeDecision.ReloadSchema -> reloadSchemaFromRealtime()
            is TabDataRealtimeDecision.Merge -> applyRealtimeMerge(decision)
            is TabDataRealtimeDecision.Delete -> applyRealtimeDelete(decision.recordIds)
            is TabDataRealtimeDecision.DeletedWhileEditing -> applyRemoteDeleteWhileEditing(decision.recordId)
        }
    }

    private fun reloadSchemaFromRealtime() {
        val state = _uiState.value
        if (state.isLoading || state.isRefreshing || identityInvalidated) return
        reloadSchema(isResume = true, preserveOpenDetail = true)
    }

    private fun refreshFromRealtime() {
        val state = _uiState.value
        if (state.isLoading || state.isRefreshing || identityInvalidated) return
        refresh()
    }

    private fun applyRealtimeMerge(decision: TabDataRealtimeDecision.Merge) {
        val current = _uiState.value
        val normalized = decision.records.map { TabDataRealtimePolicy.normalizeRecord(it, current.fields) }
        if (current.groups.isNotEmpty()) {
            val mergedGroups = TabDataRealtimePolicy.mergeGroups(current.groups, normalized, decision.deletedIds)
            if (mergedGroups == null) {
                applyOpenDetailMerge(normalized)
                refreshFromRealtime()
                return
            }
            applyRealtimeList(
                records = current.records,
                groups = mergedGroups,
                incoming = normalized,
                deletedIds = decision.deletedIds,
            )
        } else {
            applyRealtimeList(
                records = TabDataRealtimePolicy.mergeRecords(current.records, normalized, decision.deletedIds),
                groups = current.groups,
                incoming = normalized,
                deletedIds = decision.deletedIds,
            )
        }
        applyOpenDetailMerge(normalized)
    }

    private fun applyRealtimeDelete(recordIds: Set<String>) {
        val current = _uiState.value
        val selectedId = current.selectedRecord?.id
        applyRealtimeList(
            records = TabDataRealtimePolicy.mergeRecords(current.records, emptyList(), recordIds),
            groups = if (current.groups.isEmpty()) {
                current.groups
            } else {
                TabDataRealtimePolicy.mergeGroups(current.groups, emptyList(), recordIds) ?: current.groups
            },
            incoming = emptyList(),
            deletedIds = recordIds,
        )
        if (selectedId != null && selectedId in recordIds && !current.isCreating) {
            _uiState.update {
                it.copy(
                    selectedRecord = null,
                    detailDraft = emptyMap(),
                    detailOriginal = emptyMap(),
                    detailErrors = emptyMap(),
                    isDetailLoading = false,
                    mutationMessageRes = R.string.tabdata_record_deleted,
                    mutationMessage = null,
                    mutationMessageFields = emptyList(),
                    mutationMessageCount = null,
                )
            }
            _events.tryEmit(NativeTabDataEvent.CloseDetail)
        }
    }

    private fun applyRemoteDeleteWhileEditing(recordId: String) {
        val current = _uiState.value
        applyRealtimeList(
            records = TabDataRealtimePolicy.mergeRecords(current.records, emptyList(), setOf(recordId)),
            groups = if (current.groups.isEmpty()) {
                current.groups
            } else {
                TabDataRealtimePolicy.mergeGroups(current.groups, emptyList(), setOf(recordId)) ?: current.groups
            },
            incoming = emptyList(),
            deletedIds = setOf(recordId),
        )
        _uiState.update {
            it.copy(
                detailWriteBlocked = true,
                conflictMessageRes = R.string.tabdata_record_deleted_remotely,
                mutationMessageRes = R.string.tabdata_record_deleted_remotely,
                mutationMessage = null,
                mutationMessageFields = emptyList(),
                mutationMessageCount = null,
            )
        }
        persistCurrentDraft()
    }

    private fun applyRealtimeList(
        records: List<TabDataRecord>,
        groups: List<TabDataRecordGroup>,
        incoming: List<TabDataRecord>,
        deletedIds: Set<String>,
    ) {
        val current = _uiState.value
        val currentIds = current.records.map(TabDataRecord::id).toSet() +
            current.groups.flatMap { group -> group.records.map(TabDataRecord::id) }.toSet()
        _uiState.update {
            it.copy(
                records = records,
                groups = groups,
                total = TabDataRealtimePolicy.adjustedTotal(it.total, currentIds, incoming, deletedIds),
            )
        }
        val identity = currentIdentityOrNull() ?: return
        viewModelScope.launch {
            val latest = _uiState.value
            refreshMemberDirectory(identity, latest.records, latest.groups, latest.fields)
        }
    }

    private fun alignOpenDetailWithLoadedRecords() {
        val current = _uiState.value
        val open = current.selectedRecord ?: return
        if (current.isCreating) return
        val fresh = current.records.firstOrNull { it.id == open.id }
            ?: current.groups.asSequence().flatMap { group -> group.records.asSequence() }
                .firstOrNull { it.id == open.id }
            ?: return
        val merged = TabDataRealtimePolicy.mergeOpenDetail(
            remote = fresh,
            fields = current.fields,
            detailDraft = current.detailDraft,
            detailOriginal = current.detailOriginal,
        )
        _uiState.update {
            it.copy(
                selectedRecord = merged.record,
                detailOriginal = merged.original,
                detailDraft = merged.draft,
            )
        }
        persistCurrentDraft(replaceOriginal = true)
    }

    private fun applyOpenDetailMerge(incoming: List<TabDataRecord>) {
        val current = _uiState.value
        val open = current.selectedRecord ?: return
        if (current.isCreating) return
        val remote = incoming.firstOrNull { it.id == open.id } ?: return
        val merged = TabDataRealtimePolicy.mergeOpenDetail(
            remote = remote,
            fields = current.fields,
            detailDraft = current.detailDraft,
            detailOriginal = current.detailOriginal,
        )
        _uiState.update {
            it.copy(
                selectedRecord = merged.record,
                detailOriginal = merged.original,
                detailDraft = merged.draft,
            )
        }
        persistCurrentDraft()
    }

    private fun markRealtimePending(recordId: String?) {
        val id = recordId?.takeIf { it.isNotBlank() && it != TabDataDraftStore.NEW_RECORD_ID } ?: return
        pendingRealtimeRecordIds += id
    }

    private fun clearRealtimePending(recordId: String?) {
        recordId?.let(pendingRealtimeRecordIds::remove)
    }

    override fun onCleared() {
        webSocketService.removeHandler(wsHandlerKey)
        unbindRealtimeSubscription()
        super.onCleared()
    }

    public companion object {
        internal const val PAGE_SIZE: Int = 30
        internal const val SEARCH_DEBOUNCE_MS: Long = 350L
    }
}
