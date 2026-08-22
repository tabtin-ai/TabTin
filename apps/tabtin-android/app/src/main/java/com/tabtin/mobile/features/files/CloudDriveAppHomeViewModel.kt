package com.tabtin.mobile.features.files

import android.content.Context
import android.net.Uri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.SearchUserItem
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveContracts
import com.tabtin.mobile.data.model.files.CloudDriveMountPendingException
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.data.model.files.CloudDriveUploadItemState
import com.tabtin.mobile.data.model.files.CloudDriveUploadPhase
import com.tabtin.mobile.data.model.files.TabFilesCollaboratorsResponse
import com.tabtin.mobile.data.repository.CloudDriveRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
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
import java.util.UUID

/** 创建文档 / 表格后立即打开 Web 承载。 */
public data class CloudDriveCreatedOpen(
    val resourceType: String,
    val resourceId: String,
    val title: String,
)

/** 系统文件选择器选出的本地文件元数据（不含正文）。 */
public data class CloudDrivePickedFile(
    val uri: Uri,
    val fileName: String,
    val contentType: String,
    val fileSize: Long,
)

public data class CloudDriveUiState(
    val organizationId: String = "",
    val scope: CloudDriveBrowseScope = CloudDriveBrowseScope.ALL,
    val typeFilter: CloudDriveTypeFilter = CloudDriveTypeFilter.ALL,
    val searchQuery: String = "",
    val currentCollectionId: String = CloudDriveContracts.ROOT_COLLECTION_ID,
    val breadcrumb: List<CloudDriveCollection> = emptyList(),
    val folders: List<CloudDriveCollection> = emptyList(),
    val resources: List<CloudDriveResourceRow> = emptyList(),
    val collectionHits: List<CloudDriveCollection> = emptyList(),
    val isLoading: Boolean = false,
    val isLoadingMore: Boolean = false,
    val errorMessage: String? = null,
    val hasMore: Boolean = false,
    val page: Int = 1,
    val sharedCursor: String? = null,
    /**
     * 分页失败后暂停自动触底加载，避免 LaunchedEffect 在 hasMore 仍为 true 时空转重试。
     * 仅显式 [retryLoadMore] 清除。
     */
    val paginationPaused: Boolean = false,
    val isWriting: Boolean = false,
    val writeErrorMessage: String? = null,
    val pendingMountCount: Int = 0,
    val uploadItems: List<CloudDriveUploadItemState> = emptyList(),
    /** 独立 recent 查询得到的真实续接项；失败时保持 null，不阻断当前目录。 */
    val resumeItem: CloudDriveResourceRow? = null,
    /** 创建入口在「全部 / 最近」且非搜索时可用；共享范围保持只读。 */
    val canWrite: Boolean = true,
)

@HiltViewModel
public class CloudDriveAppHomeViewModel @Inject constructor(
    private val repository: CloudDriveRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private val _uiState = MutableStateFlow(CloudDriveUiState())
    public val uiState: StateFlow<CloudDriveUiState> = _uiState.asStateFlow()

    private val _openCreated = MutableSharedFlow<CloudDriveCreatedOpen>(extraBufferCapacity = 1)
    public val openCreated: SharedFlow<CloudDriveCreatedOpen> = _openCreated.asSharedFlow()

    /** 上传 READY 后按列表点击同款路径打开（对齐 iOS pendingOpenRoute）。 */
    private val _pendingOpenResource = MutableSharedFlow<CloudDriveResourceRow>(extraBufferCapacity = 1)
    public val pendingOpenResource: SharedFlow<CloudDriveResourceRow> = _pendingOpenResource.asSharedFlow()

    private var collections: List<CloudDriveCollection> = emptyList()
    private var loadJob: Job? = null
    private var searchJob: Job? = null
    private var resumeJob: Job? = null
    private var loadSeq: Long = 0L

    public fun bindOrganization(organizationId: String) {
        if (organizationId.isBlank()) return
        if (_uiState.value.organizationId == organizationId && collections.isNotEmpty()) {
            // 同组织重进仍要刷 pending 计数并静默重试 mount。
            _uiState.update { it.copy(pendingMountCount = repository.pendingMountCount()) }
            loadResumeItem(organizationId)
            retryPendingMounts(silent = true)
            return
        }
        _uiState.update {
            it.copy(
                organizationId = organizationId,
                pendingMountCount = repository.pendingMountCount(),
                resumeItem = null,
            )
        }
        refresh(force = true)
        retryPendingMounts(silent = true)
    }

    public fun setScope(scope: CloudDriveBrowseScope) {
        if (_uiState.value.scope == scope) return
        _uiState.update {
            it.copy(
                scope = scope,
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
                breadcrumb = emptyList(),
                page = 1,
                sharedCursor = null,
                canWrite = scope != CloudDriveBrowseScope.SHARED && it.searchQuery.isBlank(),
            )
        }
        reloadCurrent()
    }

    public fun setTypeFilter(filter: CloudDriveTypeFilter) {
        if (_uiState.value.typeFilter == filter) return
        _uiState.update { it.copy(typeFilter = filter, page = 1, sharedCursor = null) }
        reloadCurrent()
    }

    /** 从任意范围 / 搜索 / 目录一次回到根目录全量视图，避免串行状态更新触发重复请求。 */
    public fun showAllContent() {
        val state = _uiState.value
        val alreadyShowingAll = state.scope == CloudDriveBrowseScope.ALL &&
            state.searchQuery.isBlank() &&
            state.currentCollectionId == CloudDriveContracts.ROOT_COLLECTION_ID &&
            state.typeFilter == CloudDriveTypeFilter.ALL
        if (alreadyShowingAll) return
        searchJob?.cancel()
        _uiState.update {
            it.copy(
                scope = CloudDriveBrowseScope.ALL,
                typeFilter = CloudDriveTypeFilter.ALL,
                searchQuery = "",
                currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
                breadcrumb = emptyList(),
                page = 1,
                sharedCursor = null,
                canWrite = true,
            )
        }
        reloadCurrent()
    }

    public fun setSearchQuery(query: String) {
        _uiState.update {
            it.copy(
                searchQuery = query,
                canWrite = it.scope != CloudDriveBrowseScope.SHARED && query.isBlank(),
            )
        }
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            delay(280)
            reloadCurrent()
        }
    }

    public fun clearWriteError() {
        _uiState.update { it.copy(writeErrorMessage = null) }
    }

    /** 可移动目标文件夹（含「根目录」哨兵，id=root）。不含自身及其子孙。 */
    public fun moveTargetFolders(excludeCollectionId: String? = null): List<CloudDriveCollection> {
        val targets = mutableListOf(
            CloudDriveCollection(
                id = CloudDriveContracts.ROOT_COLLECTION_ID,
                name = context.getString(R.string.cloud_drive_root),
            ),
        )
        val blocked = mutableSetOf<String>()
        if (!excludeCollectionId.isNullOrBlank()) {
            fun collect(node: CloudDriveCollection?) {
                if (node == null) return
                blocked += node.id
                node.children.forEach { collect(it) }
            }
            collect(repository.findCollection(collections, excludeCollectionId))
        }
        fun walk(nodes: List<CloudDriveCollection>) {
            for (node in nodes) {
                if (node.id in blocked) continue
                targets += node.copy(children = emptyList())
                walk(node.children)
            }
        }
        walk(collections)
        return targets
    }

    public fun renameFolder(collection: CloudDriveCollection, name: String, onDone: (() -> Unit)? = null) {
        val state = _uiState.value
        if (state.isWriting) return
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.renameFolder(collection.id, trimmed)
                collections = repository.listCollections(state.organizationId)
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_action_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun moveFolder(
        collection: CloudDriveCollection,
        parentCollectionId: String?,
        onDone: (() -> Unit)? = null,
    ) {
        val state = _uiState.value
        if (state.isWriting) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.moveFolder(collection.id, parentCollectionId)
                collections = repository.listCollections(state.organizationId)
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_action_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun deleteFolder(collection: CloudDriveCollection, onDone: (() -> Unit)? = null) {
        val state = _uiState.value
        if (state.isWriting) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.deleteFolder(collection.id)
                if (state.currentCollectionId == collection.id) {
                    _uiState.update {
                        it.copy(
                            currentCollectionId = CloudDriveContracts.ROOT_COLLECTION_ID,
                            breadcrumb = emptyList(),
                        )
                    }
                }
                collections = repository.listCollections(state.organizationId)
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_action_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun moveResource(
        row: CloudDriveResourceRow,
        targetCollectionId: String?,
        onDone: (() -> Unit)? = null,
    ) {
        val state = _uiState.value
        if (state.isWriting) return
        if (row.canMove != true) {
            _uiState.update {
                it.copy(writeErrorMessage = context.getString(R.string.cloud_drive_move_owner_only))
            }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.moveResource(
                    organizationId = state.organizationId,
                    contextItemId = row.contextItemId,
                    targetCollectionId = targetCollectionId,
                    canMove = row.canMove,
                )
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_move_owner_only),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun trashTabFile(row: CloudDriveResourceRow, onDone: (() -> Unit)? = null) {
        val state = _uiState.value
        if (state.isWriting) return
        val fileRecordId = row.fileRecordId?.takeIf { it.isNotBlank() }
            ?: row.resourceId.takeIf { row.normalizedType == "tabfiles" }
        if (fileRecordId.isNullOrBlank()) {
            _uiState.update {
                it.copy(writeErrorMessage = context.getString(R.string.cloud_drive_action_failed))
            }
            return
        }
        if (row.canTrash == false) {
            _uiState.update {
                it.copy(writeErrorMessage = context.getString(R.string.cloud_drive_trash_denied))
            }
            return
        }
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.trashTabFile(state.organizationId, fileRecordId)
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_action_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun restoreTabFile(fileRecordId: String, onDone: (() -> Unit)? = null) {
        val state = _uiState.value
        if (state.isWriting || fileRecordId.isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.restoreTabFile(state.organizationId, fileRecordId)
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_action_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun permanentDeleteTabFile(fileRecordId: String, onDone: (() -> Unit)? = null) {
        val state = _uiState.value
        if (state.isWriting || fileRecordId.isBlank()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.permanentDeleteTabFile(state.organizationId, fileRecordId)
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_action_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public suspend fun loadTabFileCollaborators(fileRecordId: String): TabFilesCollaboratorsResponse =
        repository.listTabFileCollaborators(fileRecordId)

    public suspend fun inviteTabFileCollaborators(
        fileRecordId: String,
        userIds: List<String>,
        permission: String = "viewer",
    ): TabFilesCollaboratorsResponse =
        repository.inviteTabFileCollaborators(fileRecordId, userIds, permission)

    public suspend fun revokeTabFileCollaborator(fileRecordId: String, userId: String) {
        repository.revokeTabFileCollaborator(fileRecordId, userId)
    }

    public suspend fun searchOrgUsers(organizationId: String, query: String): List<SearchUserItem> =
        repository.searchOrgUsers(organizationId, query)

    public fun createFolder(name: String, onDone: (() -> Unit)? = null) {
        val state = _uiState.value
        if (!state.canWrite || state.isWriting) return
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                repository.createFolder(
                    organizationId = state.organizationId,
                    name = trimmed,
                    parentCollectionId = state.currentCollectionId,
                )
                collections = repository.listCollections(state.organizationId)
                reloadCurrent()
                onDone?.invoke()
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_create_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun createDocument(title: String = "") {
        val state = _uiState.value
        if (!state.canWrite || state.isWriting) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                val detail = repository.createDocument(
                    organizationId = state.organizationId,
                    title = title,
                    collectionId = state.currentCollectionId,
                )
                reloadCurrent()
                _openCreated.tryEmit(
                    CloudDriveCreatedOpen(
                        resourceType = "tabdoc",
                        resourceId = detail.document.id,
                        title = detail.document.title.ifBlank {
                            context.getString(R.string.cloud_drive_untitled_doc)
                        },
                    ),
                )
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_create_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun createTable(name: String = "") {
        val state = _uiState.value
        if (!state.canWrite || state.isWriting) return
        val resolvedName = name.ifBlank { context.getString(R.string.cloud_drive_untitled_table) }
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            try {
                val table = repository.createTable(
                    organizationId = state.organizationId,
                    name = resolvedName,
                    collectionId = state.currentCollectionId,
                )
                reloadCurrent()
                _openCreated.tryEmit(
                    CloudDriveCreatedOpen(
                        resourceType = "tabdata",
                        resourceId = table.id,
                        title = table.name.ifBlank { resolvedName },
                    ),
                )
            } catch (error: Exception) {
                _uiState.update {
                    it.copy(
                        writeErrorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_create_failed),
                    )
                }
            } finally {
                _uiState.update { it.copy(isWriting = false) }
            }
        }
    }

    public fun uploadFiles(files: List<CloudDrivePickedFile>) {
        val state = _uiState.value
        if (!state.canWrite || state.isWriting || files.isEmpty()) return
        viewModelScope.launch {
            _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            var lastReady: CloudDriveResourceRow? = null
            for (file in files) {
                val localKey = UUID.randomUUID().toString()
                _uiState.update {
                    it.copy(
                        uploadItems = it.uploadItems + CloudDriveUploadItemState(
                            localKey = localKey,
                            fileName = file.fileName,
                            phase = CloudDriveUploadPhase.UPLOADING,
                        ),
                    )
                }
                try {
                    val row = repository.uploadAndMount(
                        organizationId = state.organizationId,
                        collectionId = state.currentCollectionId,
                        uri = file.uri,
                        fileName = file.fileName,
                        contentType = file.contentType,
                        fileSize = file.fileSize,
                        onProgress = { progress ->
                            patchUploadItem(localKey) {
                                copy(phase = CloudDriveUploadPhase.UPLOADING, progress = progress)
                            }
                        },
                        onPhase = { phase ->
                            if (
                                phase == CloudDriveUploadPhase.CONFIRMED ||
                                phase == CloudDriveUploadPhase.MOUNTING
                            ) {
                                patchUploadItem(localKey) {
                                    copy(phase = phase, progress = 1f)
                                }
                            }
                        },
                    )
                    lastReady = row
                    _uiState.update { ui ->
                        ui.copy(
                            uploadItems = ui.uploadItems.map { item ->
                                if (item.localKey == localKey) {
                                    item.copy(
                                        phase = CloudDriveUploadPhase.READY,
                                        progress = 1f,
                                        contextItemId = row.contextItemId,
                                    )
                                } else {
                                    item
                                }
                            },
                            pendingMountCount = repository.pendingMountCount(),
                        )
                    }
                } catch (error: CloudDriveMountPendingException) {
                    _uiState.update { ui ->
                        ui.copy(
                            uploadItems = ui.uploadItems.map { item ->
                                if (item.localKey == localKey) {
                                    item.copy(
                                        phase = CloudDriveUploadPhase.PENDING_MOUNT,
                                        progress = 1f,
                                        errorMessage = error.message,
                                    )
                                } else {
                                    item
                                }
                            },
                            writeErrorMessage = context.getString(R.string.cloud_drive_mount_pending_hint),
                            pendingMountCount = repository.pendingMountCount(),
                        )
                    }
                } catch (error: Exception) {
                    _uiState.update { ui ->
                        ui.copy(
                            uploadItems = ui.uploadItems.map { item ->
                                if (item.localKey == localKey) {
                                    item.copy(
                                        phase = CloudDriveUploadPhase.FAILED,
                                        errorMessage = error.message,
                                    )
                                } else {
                                    item
                                }
                            },
                            writeErrorMessage = error.message
                                ?: context.getString(R.string.cloud_drive_upload_failed),
                            pendingMountCount = repository.pendingMountCount(),
                        )
                    }
                }
            }
            reloadCurrent()
            lastReady?.let { row ->
                onResourceOpened(row)
                _pendingOpenResource.tryEmit(row)
            }
            _uiState.update { it.copy(isWriting = false) }
        }
    }

    public fun retryPendingMounts(silent: Boolean = false) {
        viewModelScope.launch {
            if (!silent) {
                _uiState.update { it.copy(isWriting = true, writeErrorMessage = null) }
            }
            try {
                repository.retryPendingMounts()
                if (_uiState.value.scope == CloudDriveBrowseScope.ALL) {
                    reloadCurrent()
                }
            } catch (error: Exception) {
                if (!silent) {
                    _uiState.update {
                        it.copy(
                            writeErrorMessage = error.message
                                ?: context.getString(R.string.cloud_drive_mount_retry_failed),
                        )
                    }
                }
            } finally {
                _uiState.update {
                    it.copy(
                        isWriting = if (silent) it.isWriting else false,
                        pendingMountCount = repository.pendingMountCount(),
                    )
                }
            }
        }
    }

    private fun patchUploadItem(
        localKey: String,
        transform: CloudDriveUploadItemState.() -> CloudDriveUploadItemState,
    ) {
        _uiState.update { ui ->
            ui.copy(
                uploadItems = ui.uploadItems.map { item ->
                    if (item.localKey == localKey) item.transform() else item
                },
            )
        }
    }

    public fun openFolder(collection: CloudDriveCollection) {
        val state = _uiState.value
        if (state.scope != CloudDriveBrowseScope.ALL || state.searchQuery.isNotBlank()) {
            _uiState.update {
                it.copy(
                    scope = CloudDriveBrowseScope.ALL,
                    searchQuery = "",
                    currentCollectionId = collection.id,
                    breadcrumb = repository.breadcrumbPath(collections, collection.id),
                    page = 1,
                    sharedCursor = null,
                    canWrite = true,
                )
            }
        } else {
            _uiState.update {
                it.copy(
                    currentCollectionId = collection.id,
                    breadcrumb = repository.breadcrumbPath(collections, collection.id),
                    page = 1,
                    canWrite = true,
                )
            }
        }
        reloadCurrent()
    }

    public fun navigateBreadcrumb(collectionId: String?) {
        val target = collectionId?.takeIf { it.isNotBlank() }
            ?: CloudDriveContracts.ROOT_COLLECTION_ID
        _uiState.update {
            it.copy(
                scope = CloudDriveBrowseScope.ALL,
                searchQuery = "",
                currentCollectionId = target,
                breadcrumb = repository.breadcrumbPath(collections, target),
                page = 1,
                sharedCursor = null,
                canWrite = true,
            )
        }
        reloadCurrent()
    }

    public fun refresh(force: Boolean = false) {
        val organizationId = _uiState.value.organizationId
        if (organizationId.isBlank()) return
        loadResumeItem(organizationId)
        viewModelScope.launch {
            try {
                collections = repository.listCollections(organizationId)
            } catch (_: Exception) {
                if (collections.isEmpty()) {
                    // 文件夹树失败不阻断资源列表；列表错误在 reload 里呈现。
                }
            }
            reloadCurrent(force = force)
        }
    }

    public fun loadMore() {
        val state = _uiState.value
        if (state.isLoading || state.isLoadingMore || !state.hasMore || state.paginationPaused) return
        when {
            state.searchQuery.isNotBlank() -> loadSearch(page = state.page + 1, append = true)
            state.scope == CloudDriveBrowseScope.SHARED -> loadShared(append = true)
            state.scope == CloudDriveBrowseScope.RECENT -> loadRecent(page = state.page + 1, append = true)
            else -> loadFolder(page = state.page + 1, append = true)
        }
    }

    /** 分页失败后的显式重试：解除自动分页暂停再拉下一页。 */
    public fun retryLoadMore() {
        _uiState.update { it.copy(paginationPaused = false, errorMessage = null) }
        loadMore()
    }

    /**
     * 打开资源：fire-and-forget 访问上报 + 本地乐观更新 last_visited_at。
     * 上报失败不阻断打开。
     */
    public fun onResourceOpened(row: CloudDriveResourceRow) {
        val contextItemId = row.contextItemId
        if (contextItemId.isBlank()) return
        // 正在返回的 recent 请求比本次点击更旧，不能再覆盖本地最新访问项。
        resumeJob?.cancel()
        val visitedAt = repository.optimisticVisitedAtNow()
        _uiState.update { state ->
            state.copy(
                resumeItem = row.copy(lastVisitedAt = visitedAt),
                resources = state.resources.map { item ->
                    if (item.contextItemId == contextItemId) {
                        item.copy(lastVisitedAt = visitedAt)
                    } else {
                        item
                    }
                },
            )
        }
        viewModelScope.launch {
            runCatching { repository.recordAccess(contextItemId) }
        }
    }

    private fun loadResumeItem(organizationId: String) {
        resumeJob?.cancel()
        resumeJob = viewModelScope.launch {
            val recent = runCatching {
                repository.listRecentPage(
                    organizationId = organizationId,
                    typeFilter = CloudDriveTypeFilter.ALL,
                    page = 1,
                    pageSize = RESUME_CANDIDATE_LIMIT,
                ).resources
            }.getOrNull() ?: return@launch
            if (_uiState.value.organizationId != organizationId) return@launch
            _uiState.update { state ->
                state.copy(resumeItem = selectCloudDriveResumeItem(recent))
            }
        }
    }

    private fun reloadCurrent(force: Boolean = false) {
        val state = _uiState.value
        when {
            state.searchQuery.isNotBlank() -> loadSearch(page = 1, append = false)
            state.scope == CloudDriveBrowseScope.SHARED -> loadShared(append = false)
            state.scope == CloudDriveBrowseScope.RECENT -> loadRecent(page = 1, append = false)
            else -> loadFolder(page = 1, append = false)
        }
        if (force) {
            // no-op marker for callers; load already kicked off
        }
    }

    private fun loadFolder(page: Int, append: Boolean) {
        val organizationId = _uiState.value.organizationId
        if (organizationId.isBlank()) return
        val seq = ++loadSeq
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = !append,
                    isLoadingMore = append,
                    errorMessage = if (append) it.errorMessage else null,
                )
            }
            try {
                val collectionId = _uiState.value.currentCollectionId
                val childFolders = if (page == 1) {
                    repository.childFoldersOf(collections, collectionId)
                } else {
                    emptyList()
                }
                val pageResult = repository.listFolderPage(
                    organizationId = organizationId,
                    collectionId = collectionId,
                    typeFilter = _uiState.value.typeFilter,
                    page = page,
                    childFolders = childFolders,
                )
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        folders = if (append) it.folders else pageResult.folders,
                        resources = if (append) it.resources + pageResult.resources else pageResult.resources,
                        collectionHits = emptyList(),
                        breadcrumb = repository.breadcrumbPath(collections, collectionId),
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = null,
                        hasMore = pageResult.hasMore,
                        page = pageResult.page,
                        sharedCursor = null,
                        paginationPaused = false,
                    )
                }
            } catch (error: Exception) {
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_load_failed),
                        paginationPaused = append,
                    )
                }
            }
        }
    }

    private fun loadRecent(page: Int, append: Boolean) {
        val organizationId = _uiState.value.organizationId
        if (organizationId.isBlank()) return
        val seq = ++loadSeq
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = !append,
                    isLoadingMore = append,
                    errorMessage = if (append) it.errorMessage else null,
                    folders = emptyList(),
                    breadcrumb = emptyList(),
                )
            }
            try {
                val pageResult = repository.listRecentPage(
                    organizationId = organizationId,
                    typeFilter = _uiState.value.typeFilter,
                    page = page,
                )
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        folders = emptyList(),
                        resources = if (append) it.resources + pageResult.resources else pageResult.resources,
                        collectionHits = emptyList(),
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = null,
                        hasMore = pageResult.hasMore,
                        page = pageResult.page,
                        sharedCursor = null,
                        paginationPaused = false,
                    )
                }
            } catch (error: Exception) {
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_load_failed),
                        paginationPaused = append,
                    )
                }
            }
        }
    }

    private fun loadShared(append: Boolean) {
        val organizationId = _uiState.value.organizationId
        if (organizationId.isBlank()) return
        val seq = ++loadSeq
        val cursor = if (append) _uiState.value.sharedCursor else null
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = !append,
                    isLoadingMore = append,
                    errorMessage = if (append) it.errorMessage else null,
                    folders = emptyList(),
                    breadcrumb = emptyList(),
                )
            }
            try {
                val pageResult = repository.listSharedFeedPage(
                    organizationId = organizationId,
                    typeFilter = _uiState.value.typeFilter,
                    cursor = cursor,
                )
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        folders = emptyList(),
                        resources = if (append) it.resources + pageResult.resources else pageResult.resources,
                        collectionHits = emptyList(),
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = null,
                        hasMore = pageResult.hasMore,
                        sharedCursor = pageResult.nextCursor,
                        page = if (append) it.page + 1 else 1,
                        paginationPaused = false,
                    )
                }
            } catch (error: Exception) {
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_shared_load_failed),
                        paginationPaused = append,
                    )
                }
            }
        }
    }

    private fun loadSearch(page: Int, append: Boolean) {
        val organizationId = _uiState.value.organizationId
        val query = _uiState.value.searchQuery.trim()
        if (organizationId.isBlank() || query.isEmpty()) return
        val seq = ++loadSeq
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            _uiState.update {
                it.copy(
                    isLoading = !append,
                    isLoadingMore = append,
                    errorMessage = if (append) it.errorMessage else null,
                    breadcrumb = emptyList(),
                )
            }
            try {
                val pageResult = repository.search(
                    organizationId = organizationId,
                    query = query,
                    typeFilter = _uiState.value.typeFilter,
                    page = page,
                    collections = collections,
                )
                val folderHits = if (page == 1) {
                    repository.searchCollectionsLocally(collections, query)
                } else {
                    emptyList()
                }
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        folders = emptyList(),
                        collectionHits = if (append) it.collectionHits else folderHits,
                        resources = if (append) it.resources + pageResult.resources else pageResult.resources,
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = null,
                        hasMore = pageResult.hasMore,
                        page = pageResult.page,
                        sharedCursor = null,
                        paginationPaused = false,
                    )
                }
            } catch (error: Exception) {
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        isLoading = false,
                        isLoadingMore = false,
                        errorMessage = error.message
                            ?: context.getString(R.string.cloud_drive_search_failed),
                        paginationPaused = append,
                    )
                }
            }
        }
    }

    private companion object {
        const val RESUME_CANDIDATE_LIMIT = 12
    }
}
