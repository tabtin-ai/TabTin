package com.tabtin.mobile.features.files

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.res.stringResource
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.files.CloudDriveBrowseScope
import com.tabtin.mobile.data.model.files.CloudDriveCollection
import com.tabtin.mobile.data.model.files.CloudDriveContracts
import com.tabtin.mobile.data.model.files.CloudDriveResourceRow
import com.tabtin.mobile.data.model.files.CloudDriveTypeFilter
import com.tabtin.mobile.data.model.files.CloudDriveUploadPhase
import com.tabtin.mobile.features.workbench.ResourceReference
import com.tabtin.mobile.ui.theme.TTSpacing
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Organization 云盘 App 首页内容：搜索、三范围、面包屑、类型筛选、文件夹与资源列表，
 * Task 8 写入入口，以及 Task 9 高风险操作（移动 / 文件夹强确认 / TabFiles 回收站与协作者 /
 * 发送到对话）。
 */
@Composable
public fun CloudDriveAppHomeContent(
    viewModel: CloudDriveAppHomeViewModel,
    organizationId: String,
    organizationName: String = "",
    appTitle: String = "",
    onBack: (() -> Unit)? = null,
    onOpenResource: (CloudDriveResourceRow) -> Unit,
    onPickFiles: () -> Unit = {},
    /**
     * 仅任务对话工作台进入时非空；为空时不展示「发送到当前对话」。
     * 文件夹永远不可发送。
     */
    activeConversationSink: ((ResourceReference) -> Unit)? = null,
    modifier: Modifier = Modifier,
) {
    val state by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()
    var showActions by remember { mutableStateOf(false) }
    var showFolderDialog by remember { mutableStateOf(false) }
    var resourceMenu by remember { mutableStateOf<CloudDriveResourceRow?>(null) }
    var folderMenu by remember { mutableStateOf<CloudDriveCollection?>(null) }
    var moveResource by remember { mutableStateOf<CloudDriveResourceRow?>(null) }
    var moveFolder by remember { mutableStateOf<CloudDriveCollection?>(null) }
    var renameFolder by remember { mutableStateOf<CloudDriveCollection?>(null) }
    var deleteFolder by remember { mutableStateOf<CloudDriveCollection?>(null) }
    var trashFile by remember { mutableStateOf<CloudDriveResourceRow?>(null) }
    var collaboratorsFor by remember { mutableStateOf<CloudDriveResourceRow?>(null) }
    var previewItem by remember(organizationId) { mutableStateOf<CloudDriveResourceRow?>(null) }
    var showTypeFilter by remember { mutableStateOf(false) }

    LaunchedEffect(organizationId) {
        viewModel.bindOrganization(organizationId)
    }

    LaunchedEffect(
        listState,
        state.hasMore,
        state.isLoadingMore,
        state.isLoading,
        state.paginationPaused,
    ) {
        snapshotFlow {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: 0
            last to info.totalItemsCount
        }
            .distinctUntilChanged()
            .collect { (last, total) ->
                if (
                    !state.isLoading &&
                    !state.isLoadingMore &&
                    !state.paginationPaused &&
                    state.hasMore &&
                    total > 0 &&
                    last >= total - 3
                ) {
                    viewModel.loadMore()
                }
            }
    }

    if (showActions) {
        CloudDriveActionSheet(
            canWrite = state.canWrite,
            isWriting = state.isWriting,
            pendingMountCount = state.pendingMountCount,
            onUpload = onPickFiles,
            onNewFolder = { showFolderDialog = true },
            onNewDoc = { viewModel.createDocument() },
            onNewTable = { viewModel.createTable() },
            onRetryPendingMount = { viewModel.retryPendingMounts() },
            onDismiss = { showActions = false },
        )
    }
    if (showTypeFilter) {
        CloudDriveTypeFilterSheet(
            selected = state.typeFilter,
            onSelect = viewModel::setTypeFilter,
            onDismiss = { showTypeFilter = false },
        )
    }
    previewItem?.let { row ->
        CloudDriveRecentPreviewSheet(
            row = row,
            onOpen = {
                viewModel.onResourceOpened(row)
                onOpenResource(row)
            },
            onDismiss = { previewItem = null },
        )
    }
    resourceMenu?.let { row ->
        val sendable = activeConversationSink != null &&
            ResourceReference.fromCloudDriveRow(row)?.canSendToConversation == true
        CloudDriveResourceActionSheet(
            row = row,
            canSendToConversation = sendable,
            isWriting = state.isWriting,
            onMove = { moveResource = row },
            onTrash = { trashFile = row },
            onManageCollaborators = { collaboratorsFor = row },
            onSendToConversation = {
                ResourceReference.fromCloudDriveRow(row)?.let { ref ->
                    activeConversationSink?.invoke(ref)
                }
            },
            onDismiss = { resourceMenu = null },
        )
    }
    folderMenu?.let { folder ->
        CloudDriveFolderActionSheet(
            folder = folder,
            isWriting = state.isWriting,
            onRename = { renameFolder = folder },
            onMove = { moveFolder = folder },
            onDelete = { deleteFolder = folder },
            onDismiss = { folderMenu = null },
        )
    }
    moveResource?.let { row ->
        CloudDriveMoveTargetSheet(
            title = stringResource(R.string.cloud_drive_move),
            targets = viewModel.moveTargetFolders(),
            isWriting = state.isWriting,
            onSelect = { target ->
                val collectionId = target.id.takeIf { it != CloudDriveContracts.ROOT_COLLECTION_ID }
                viewModel.moveResource(row, collectionId) { moveResource = null }
            },
            onDismiss = { moveResource = null },
        )
    }
    moveFolder?.let { folder ->
        CloudDriveMoveTargetSheet(
            title = stringResource(R.string.cloud_drive_move_folder),
            targets = viewModel.moveTargetFolders(excludeCollectionId = folder.id),
            isWriting = state.isWriting,
            onSelect = { target ->
                val parentId = target.id.takeIf { it != CloudDriveContracts.ROOT_COLLECTION_ID }
                viewModel.moveFolder(folder, parentId) { moveFolder = null }
            },
            onDismiss = { moveFolder = null },
        )
    }
    renameFolder?.let { folder ->
        CloudDriveRenameFolderDialog(
            initialName = folder.name,
            isSubmitting = state.isWriting,
            onConfirm = { name ->
                viewModel.renameFolder(folder, name) { renameFolder = null }
            },
            onDismiss = { renameFolder = null },
        )
    }
    deleteFolder?.let { folder ->
        CloudDriveDeleteFolderConfirmDialog(
            folderName = folder.name,
            isSubmitting = state.isWriting,
            onConfirm = {
                viewModel.deleteFolder(folder) { deleteFolder = null }
            },
            onDismiss = { deleteFolder = null },
        )
    }
    trashFile?.let { row ->
        CloudDriveTrashFileConfirmDialog(
            fileName = row.displayTitle,
            isSubmitting = state.isWriting,
            onConfirm = {
                viewModel.trashTabFile(row) { trashFile = null }
            },
            onDismiss = { trashFile = null },
        )
    }
    collaboratorsFor?.let { row ->
        val fileRecordId = row.fileRecordId?.takeIf { it.isNotBlank() }
            ?: row.resourceId.takeIf { row.normalizedType == "tabfiles" }
        if (fileRecordId.isNullOrBlank()) {
            collaboratorsFor = null
        } else {
            TabFilesCollaboratorsSheet(
                organizationId = organizationId,
                fileRecordId = fileRecordId,
                fileTitle = row.displayTitle,
                viewModel = viewModel,
                onDismiss = { collaboratorsFor = null },
            )
        }
    }
    if (showFolderDialog) {
        CloudDriveFolderDialog(
            isSubmitting = state.isWriting,
            onConfirm = { name ->
                viewModel.createFolder(name) { showFolderDialog = false }
            },
            onDismiss = { showFolderDialog = false },
        )
    }

    val palette = cloudDriveRedesignPalette()
    val isLandingContext = isCloudDriveLandingContext(
        scope = state.scope,
        searchQuery = state.searchQuery,
        currentCollectionId = state.currentCollectionId,
    )
    val showResumeHero = isCloudDriveResumeHeroContext(
        scope = state.scope,
        searchQuery = state.searchQuery,
        currentCollectionId = state.currentCollectionId,
    )
    val showQuickActions = isCloudDriveQuickActionContext(
        scope = state.scope,
        searchQuery = state.searchQuery,
        currentCollectionId = state.currentCollectionId,
    )
    val rowCount = state.collectionHits.size + state.folders.size + state.resources.size
    val showInitialLoading = state.isLoading && rowCount == 0
    val showInitialError = state.errorMessage != null && rowCount == 0 && !state.isLoading
    val showEmpty = !showInitialLoading && !showInitialError && rowCount == 0

    Column(
        modifier = modifier
            .fillMaxSize()
            .background(palette.canvas),
    ) {
        CloudDriveRedesignedHeader(
            title = appTitle.ifBlank { stringResource(R.string.cloud_drive_title) },
            organizationName = organizationName,
            onBack = onBack,
            onAddClick = { showActions = true },
        )
        if (state.isWriting || state.uploadItems.any { it.phase == CloudDriveUploadPhase.UPLOADING }) {
            LinearProgressIndicator(
                color = palette.accent,
                trackColor = palette.accentSoft,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = TTSpacing.lg),
            )
        }
        state.writeErrorMessage?.let { message ->
            Text(
                text = message,
                color = MaterialTheme.colorScheme.error,
                style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.padding(horizontal = TTSpacing.lg, vertical = TTSpacing.xs),
            )
        }
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = TTSpacing.xxxl),
        ) {
            item(key = "search") {
                CloudDriveRedesignedSearch(
                    query = state.searchQuery,
                    onQueryChange = viewModel::setSearchQuery,
                    modifier = Modifier.padding(
                        horizontal = TTSpacing.lg,
                        vertical = TTSpacing.sm,
                    ),
                )
            }
            state.resumeItem?.takeIf { showResumeHero }?.let { resumeItem ->
                item(key = "resume-${resumeItem.contextItemId}") {
                    CloudDriveRecentHero(
                        row = resumeItem,
                        onClick = { previewItem = resumeItem },
                        modifier = Modifier.padding(
                            start = TTSpacing.lg,
                            top = TTSpacing.md,
                            end = TTSpacing.lg,
                        ),
                    )
                }
            }
            if (showQuickActions) {
                item(key = "quick-actions") {
                    CloudDriveQuickActions(
                        enabled = state.canWrite && !state.isWriting,
                        onUpload = onPickFiles,
                        onNewFolder = { showFolderDialog = true },
                        modifier = Modifier.padding(
                            start = TTSpacing.lg,
                            top = TTSpacing.md,
                            end = TTSpacing.lg,
                        ),
                    )
                }
            }
            item(key = "library-header") {
                CloudDriveLibraryHeader(
                    showAllContent = true,
                    onAllContent = viewModel::showAllContent,
                    modifier = Modifier.padding(
                        start = TTSpacing.lg,
                        top = TTSpacing.xxl,
                        end = TTSpacing.sm,
                    ),
                )
            }
            item(key = "library-controls") {
                CloudDriveLibraryControls(
                    selectedScope = state.scope,
                    selectedType = state.typeFilter,
                    onSelectScope = viewModel::setScope,
                    onOpenTypeFilter = { showTypeFilter = true },
                    modifier = Modifier.padding(
                        start = TTSpacing.lg,
                        top = TTSpacing.xs,
                        end = TTSpacing.lg,
                        bottom = TTSpacing.md,
                    ),
                )
            }
            if (
                state.scope == CloudDriveBrowseScope.ALL &&
                state.searchQuery.isBlank() &&
                state.currentCollectionId != CloudDriveContracts.ROOT_COLLECTION_ID
            ) {
                item(key = "breadcrumbs") {
                    CloudDriveBreadcrumbs(
                        breadcrumb = state.breadcrumb,
                        onRoot = { viewModel.navigateBreadcrumb(null) },
                        onCrumb = { viewModel.navigateBreadcrumb(it.id) },
                        modifier = Modifier.padding(horizontal = TTSpacing.sm),
                    )
                }
            }

            when {
                showInitialLoading -> item(key = "loading") {
                    CloudDriveLoadingCard(modifier = Modifier.padding(horizontal = TTSpacing.lg))
                }
                showInitialError -> item(key = "initial-error") {
                    Column(
                        modifier = Modifier.padding(horizontal = TTSpacing.lg),
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CloudDriveEmptyCard(title = state.errorMessage.orEmpty())
                        TextButton(onClick = { viewModel.refresh(force = true) }) {
                            Text(stringResource(R.string.cloud_drive_retry))
                        }
                    }
                }
                showEmpty -> item(key = "empty") {
                    CloudDriveEmptyCard(
                        title = emptyStateMessage(state),
                        body = stringResource(R.string.cloud_drive_redesign_empty_body)
                            .takeIf { isLandingContext },
                        modifier = Modifier.padding(horizontal = TTSpacing.lg),
                    )
                }
                else -> {
                    itemsIndexed(
                        items = state.collectionHits,
                        key = { _, folder -> "hit-${folder.id}" },
                    ) { index, folder ->
                        CloudDriveFolderRow(
                            folder = folder,
                            onClick = { viewModel.openFolder(folder) },
                            onMoreClick = { folderMenu = folder },
                            modifier = Modifier
                                .padding(horizontal = TTSpacing.lg)
                                .cloudDriveGroupedRow(index = index, total = rowCount, palette = palette),
                        )
                    }
                    itemsIndexed(
                        items = state.folders,
                        key = { _, folder -> "folder-${folder.id}" },
                    ) { index, folder ->
                        val rowIndex = state.collectionHits.size + index
                        CloudDriveFolderRow(
                            folder = folder,
                            onClick = { viewModel.openFolder(folder) },
                            onMoreClick = { folderMenu = folder },
                            modifier = Modifier
                                .padding(horizontal = TTSpacing.lg)
                                .cloudDriveGroupedRow(index = rowIndex, total = rowCount, palette = palette),
                        )
                    }
                    itemsIndexed(
                        items = state.resources,
                        key = { _, row -> "res-${row.contextItemId}" },
                    ) { index, row ->
                        val rowIndex = state.collectionHits.size + state.folders.size + index
                        CloudDriveResourceListRow(
                            row = row,
                            onClick = {
                                viewModel.onResourceOpened(row)
                                onOpenResource(row)
                            },
                            onMoreClick = { resourceMenu = row },
                            modifier = Modifier
                                .padding(horizontal = TTSpacing.lg)
                                .cloudDriveGroupedRow(index = rowIndex, total = rowCount, palette = palette),
                        )
                    }
                }
            }
            if (state.isLoadingMore) {
                item(key = "loading-more") {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(TTSpacing.lg),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator(color = palette.accent)
                    }
                }
            }
            if (state.errorMessage != null && rowCount > 0) {
                item(key = "page-error") {
                    TextButton(
                        onClick = { viewModel.retryLoadMore() },
                        modifier = Modifier.padding(TTSpacing.lg),
                    ) {
                        Text(state.errorMessage ?: stringResource(R.string.cloud_drive_retry))
                    }
                }
            }
        }
    }
}

@Composable
private fun emptyStateMessage(state: CloudDriveUiState): String {
    return when {
        state.searchQuery.isNotBlank() -> stringResource(R.string.cloud_drive_empty_search)
        state.scope == CloudDriveBrowseScope.RECENT -> stringResource(R.string.cloud_drive_empty_recent)
        state.scope == CloudDriveBrowseScope.SHARED -> stringResource(R.string.cloud_drive_empty_shared)
        else -> stringResource(R.string.cloud_drive_empty_all)
    }
}
