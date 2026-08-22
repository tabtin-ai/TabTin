package com.tabtin.mobile.features.clouddocs

import android.content.Context
import android.util.Log
import androidx.annotation.StringRes
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.model.Iso8601DateParser
import com.tabtin.mobile.data.model.KnowledgeTreeFlatRow
import com.tabtin.mobile.data.model.KnowledgeTreeFlattener
import com.tabtin.mobile.data.model.KnowledgeTreeNode
import com.tabtin.mobile.data.model.KnowledgeTreeSearchHit
import com.tabtin.mobile.data.model.SharedResourceItem
import com.tabtin.mobile.data.model.SpaceResource
import com.tabtin.mobile.data.repository.OrganizationRepository
import com.tabtin.mobile.data.repository.SharedResourcesRepository
import com.tabtin.mobile.data.repository.SpaceResourceRepository
import com.tabtin.mobile.data.repository.CloudDriveRepository
import com.tabtin.mobile.util.ErrorClassifier
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.Instant
import java.util.Locale
import javax.inject.Inject

internal sealed class CloudDocsOpenNotice {
    data object OrganizationUnavailable : CloudDocsOpenNotice()
    data class Unsupported(val locationHint: String?) : CloudDocsOpenNotice()
    data class Failed(@StringRes val messageRes: Int) : CloudDocsOpenNotice()
}

internal sealed class CloudDocsOpenEvent {
    data class Navigate(
        val resource: SpaceResource,
        val spaceName: String?,
    ) : CloudDocsOpenEvent()

    data class Notice(val notice: CloudDocsOpenNotice) : CloudDocsOpenEvent()
}

internal enum class CloudDocsCreateKind { DOCUMENT, TABLE }

/**
 * 云文档三分段 UI 状态。
 *
 * Task 4 接线时注意：
 * - 知识树行 / 搜索命中：`canShare` 恒为 `null`（知识树接口不回填）→ UI 乐观放出分享入口
 * - [recentItems] / [filteredRecentItems]：`SpaceResource.canShare` 三态原样保留
 *   (`false` 不出入口；`null` 乐观放出；`true` 放出)
 * - [sharedItems]：合成 id（`shared:` 前缀），无置顶 / 删除 / recordAccess
 */
internal data class CloudDocsUiState(
    val browseView: CloudDocsBrowseView = CloudDocsBrowseView.ALL,
    val searchText: String = "",
    val treeRoots: List<KnowledgeTreeNode> = emptyList(),
    val expandedNodeIds: Set<String> = emptySet(),
    val loadingChildNodeIds: Set<String> = emptySet(),
    val allRecentItems: List<SpaceResource> = emptyList(),
    val sharedItems: List<SharedResourceItem> = emptyList(),
    val isLoading: Boolean = false,
    val isRefreshing: Boolean = false,
    @StringRes val errorRes: Int? = null,
    /** 「分享给我」独占错误位，不并进 [errorRes]。 */
    @StringRes val sharedErrorRes: Int? = null,
    val pinningIds: Set<String> = emptySet(),
    val isCreating: Boolean = false,
) {
    val treeRows: List<KnowledgeTreeFlatRow>
        get() = KnowledgeTreeFlattener.flatten(roots = treeRoots, expandedIds = expandedNodeIds)

    val isSearching: Boolean
        get() = searchText.trim().isNotEmpty()

    val searchHits: List<KnowledgeTreeSearchHit>
        get() = KnowledgeTreeFlattener.search(roots = treeRoots, keyword = searchText)

    /**
     * 「最近」= 本人访问过的云文档，按访问时间倒序。
     * 未访问过的不进列表；时间相同或解析失败时按标题定序。
     */
    val recentItems: List<SpaceResource>
        get() = allRecentItems
            .filter { it.normalizedType in CLOUD_DOC_ITEM_TYPES }
            .filter { !it.lastVisitedAt.isNullOrEmpty() }
            .sortedWith(
                compareByDescending<SpaceResource> { item ->
                    item.lastVisitedAt?.let { Iso8601DateParser.epochMillis(it) } ?: 0L
                }.thenBy { it.displayTitle },
            )

    /** 「最近」分段搜索：对 displayTitle 本地 filter。 */
    val filteredRecentItems: List<SpaceResource>
        get() = filterByTitle(recentItems) { it.displayTitle }

    /** 「分享给我」分段搜索：对 displayTitle 本地 filter。 */
    val filteredSharedItems: List<SharedResourceItem>
        get() = filterByTitle(sharedItems) { it.displayTitle }

    val isEmpty: Boolean
        get() = when (browseView) {
            CloudDocsBrowseView.ALL -> treeRoots.isEmpty()
            CloudDocsBrowseView.RECENT -> recentItems.isEmpty()
            CloudDocsBrowseView.SHARED -> sharedItems.isEmpty()
        }

    private fun <T> filterByTitle(items: List<T>, title: (T) -> String): List<T> {
        if (!isSearching) return items
        val needle = searchText.trim().lowercase(Locale.ROOT)
        return items.filter { title(it).lowercase(Locale.ROOT).contains(needle) }
    }

    private companion object {
        val CLOUD_DOC_ITEM_TYPES: Set<String> = setOf("tabdoc", "tabdata")
    }
}

@HiltViewModel
internal class CloudDocsViewModel @Inject constructor(
    private val spaceResourceRepository: SpaceResourceRepository,
    private val sharedResourcesRepository: SharedResourcesRepository,
    private val organizationRepository: OrganizationRepository,
    private val cloudDriveRepository: CloudDriveRepository,
    @ApplicationContext private val context: Context,
) : ViewModel() {
    private val _uiState = MutableStateFlow(CloudDocsUiState())
    val uiState: StateFlow<CloudDocsUiState> = _uiState.asStateFlow()

    private val openEventChannel = Channel<CloudDocsOpenEvent>(Channel.BUFFERED)
    val openEvents = openEventChannel.receiveAsFlow()

    private var organizationId: String? = null
    private var loadGeneration = 0L
    private var loadJob: Job? = null
    private var pendingOpenJob: Job? = null

    fun selectBrowseView(view: CloudDocsBrowseView) {
        // 换分段清搜索：三段各搜各的，留着关键词会让用户以为新分段真的只有几条。
        _uiState.update { it.copy(browseView = view, searchText = "") }
    }

    /**
     * 消费深链 / 通知的打开意图（对齐 iOS CloudDocsTabRoot.openPendingResourceIfNeeded）。
     *
     * 组织不在列表 → 明确提示；跨组织先 [OrganizationRepository.selectOrganization]；
     * 不支持类型 → 明确提示，不静默。
     */
    fun submitPendingOpen(pending: CloudDocsPendingOpen) {
        pendingOpenJob?.cancel()
        pendingOpenJob = viewModelScope.launch {
            try {
                val orgNotice = ensureOrganizationSelected(pending.organizationId)
                if (orgNotice != null) {
                    openEventChannel.send(CloudDocsOpenEvent.Notice(orgNotice))
                    return@launch
                }

                load(pending.organizationId)
                loadJob?.join()

                if (pending.preferSharedSegment) {
                    selectBrowseView(CloudDocsBrowseView.SHARED)
                }

                when (
                    val resolved = CloudDocsPendingOpenResolver.resolve(
                        pending = pending,
                        recentItems = _uiState.value.allRecentItems,
                        sharedItems = _uiState.value.sharedItems,
                    )
                ) {
                    is CloudDocsPendingOpenResult.Open -> {
                        // 仅对已加载目录里的真实 context-item 记访问；深链合成的 id 不上报。
                        val knownContextItem = _uiState.value.allRecentItems
                            .any { it.id == resolved.resource.id }
                        if (knownContextItem) {
                            recordAccess(resolved.resource.id)
                        }
                        openEventChannel.send(
                            CloudDocsOpenEvent.Navigate(
                                resource = resolved.resource,
                                spaceName = resolved.spaceName,
                            ),
                        )
                    }
                    is CloudDocsPendingOpenResult.Unsupported -> {
                        openEventChannel.send(
                            CloudDocsOpenEvent.Notice(
                                CloudDocsOpenNotice.Unsupported(resolved.locationHint),
                            ),
                        )
                    }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "failed to open pending cloud document", error)
                openEventChannel.send(
                    CloudDocsOpenEvent.Notice(
                        CloudDocsOpenNotice.Failed(userFacingErrorRes(error)),
                    ),
                )
            }
        }
    }

    private suspend fun ensureOrganizationSelected(organizationId: String): CloudDocsOpenNotice? {
        organizationRepository.loadOrganizations()
        if (runCatching { organizationRepository.error.value }.getOrNull() != null) {
            return CloudDocsOpenNotice.OrganizationUnavailable
        }
        val organization = organizationRepository.organizations.value
            .firstOrNull { it.id == organizationId }
            ?: run {
                runCatching { organizationRepository.notifyOrganizationAccessRevoked(organizationId) }
                return CloudDocsOpenNotice.OrganizationUnavailable
            }
        if (organizationRepository.selectedOrganization.value?.id != organizationId) {
            organizationRepository.selectOrganization(organization)
        }
        if (organizationRepository.selectedOrganization.value?.id != organizationId) {
            return CloudDocsOpenNotice.OrganizationUnavailable
        }
        return null
    }

    fun updateSearchText(text: String) {
        _uiState.update { it.copy(searchText = text) }
    }

    fun create(kind: CloudDocsCreateKind) {
        val orgId = organizationId ?: return
        if (_uiState.value.isCreating) return
        viewModelScope.launch {
            _uiState.update { it.copy(isCreating = true, errorRes = null) }
            try {
                val resource = when (kind) {
                    CloudDocsCreateKind.DOCUMENT -> {
                        val detail = cloudDriveRepository.createDocument(
                            orgId,
                            context.getString(R.string.cloud_drive_untitled_doc),
                            null,
                        )
                        SpaceResource(
                            id = detail.document.id,
                            itemType = "tabdoc",
                            title = detail.document.title.orEmpty(),
                            resourceId = detail.document.id,
                            organizationId = orgId,
                        )
                    }
                    CloudDocsCreateKind.TABLE -> {
                        val table = cloudDriveRepository.createTable(
                            orgId,
                            context.getString(R.string.cloud_drive_untitled_table),
                            null,
                        )
                        SpaceResource(
                            id = table.id,
                            itemType = "tabdata",
                            title = table.name,
                            resourceId = table.id,
                            organizationId = orgId,
                        )
                    }
                }
                load(orgId)
                openEventChannel.send(CloudDocsOpenEvent.Navigate(resource, null))
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "failed to create cloud document", error)
                _uiState.update { it.copy(errorRes = userFacingErrorRes(error)) }
            } finally {
                _uiState.update { it.copy(isCreating = false) }
            }
        }
    }

    fun clearError() {
        _uiState.update { it.copy(errorRes = null, sharedErrorRes = null) }
    }

    /**
     * 三个分段各拉各的数据源，互不连坐。
     * 组织切换时先清空，再用 [loadGeneration] 丢弃过期响应。
     */
    fun load(organizationId: String, isPullToRefresh: Boolean = false) {
        val generation = ++loadGeneration
        loadJob?.cancel()

        val previousOrg = this.organizationId
        val didChangeOrganization = previousOrg != null && previousOrg != organizationId
        this.organizationId = organizationId

        _uiState.update { state ->
            when {
                isPullToRefresh -> state.copy(
                    isRefreshing = true,
                    errorRes = null,
                    sharedErrorRes = null,
                )
                didChangeOrganization -> state.copy(
                    treeRoots = emptyList(),
                    allRecentItems = emptyList(),
                    sharedItems = emptyList(),
                    expandedNodeIds = emptySet(),
                    loadingChildNodeIds = emptySet(),
                    pinningIds = emptySet(),
                    isLoading = true,
                    isRefreshing = false,
                    errorRes = null,
                    sharedErrorRes = null,
                )
                else -> {
                    val empty = state.treeRoots.isEmpty() &&
                        state.allRecentItems.isEmpty() &&
                        state.sharedItems.isEmpty()
                    state.copy(
                        isLoading = empty,
                        isRefreshing = false,
                        errorRes = null,
                        sharedErrorRes = null,
                    )
                }
            }
        }

        loadJob = viewModelScope.launch {
            try {
                var loadedRoots: List<KnowledgeTreeNode>? = null
                var loadedItems: List<SpaceResource>? = null
                var loadedShared: List<SharedResourceItem>? = null
                var browseError: Throwable? = null
                var sharedError: Throwable? = null

                coroutineScope {
                    val treeDeferred = async {
                        runCatchingExceptCancellation {
                            spaceResourceRepository.getKnowledgeTree(
                                organizationId = organizationId,
                                itemTypes = ITEM_TYPES_QUERY,
                                depth = TREE_DEPTH,
                            ).roots
                        }
                    }
                    val recentDeferred = async {
                        runCatchingExceptCancellation {
                            spaceResourceRepository.getRecentOrganizationResources(organizationId)
                        }
                    }
                    val sharedDeferred = async {
                        runCatchingExceptCancellation {
                            sharedResourcesRepository.listSharedWithMe(organizationId)
                        }
                    }

                    treeDeferred.await().fold(
                        onSuccess = { loadedRoots = it },
                        onFailure = { browseError = it },
                    )
                    recentDeferred.await().fold(
                        onSuccess = { loadedItems = it },
                        onFailure = { if (browseError == null) browseError = it },
                    )
                    sharedDeferred.await().fold(
                        onSuccess = { loadedShared = it },
                        onFailure = { sharedError = it },
                    )
                }

                if (generation != loadGeneration) return@launch

                browseError?.let { Log.e(TAG, "failed to load cloud document browser", it) }
                sharedError?.let { Log.e(TAG, "failed to load shared cloud documents", it) }

                _uiState.update { state ->
                    state.copy(
                        treeRoots = loadedRoots ?: state.treeRoots,
                        allRecentItems = loadedItems ?: state.allRecentItems,
                        sharedItems = loadedShared ?: state.sharedItems,
                        errorRes = browseError?.let(::userFacingErrorRes),
                        sharedErrorRes = sharedError?.let(::userFacingErrorRes),
                        isLoading = false,
                        isRefreshing = false,
                    )
                }
            } finally {
                if (generation == loadGeneration) {
                    _uiState.update { it.copy(isLoading = false, isRefreshing = false) }
                }
            }
        }
    }

    fun toggleExpansion(node: KnowledgeTreeNode) {
        val currentlyExpanded = node.id in _uiState.value.expandedNodeIds
        if (currentlyExpanded) {
            _uiState.update { it.copy(expandedNodeIds = it.expandedNodeIds - node.id) }
            return
        }

        _uiState.update { it.copy(expandedNodeIds = it.expandedNodeIds + node.id) }

        if (!KnowledgeTreeFlattener.needsLazyChildren(node)) return
        if (node.id in _uiState.value.loadingChildNodeIds) return
        val orgId = organizationId ?: return

        viewModelScope.launch {
            _uiState.update { it.copy(loadingChildNodeIds = it.loadingChildNodeIds + node.id) }
            try {
                val response = spaceResourceRepository.getKnowledgeTreeChildren(
                    organizationId = orgId,
                    nodeId = node.id,
                    nodeType = node.nodeType.wireValue,
                    itemTypes = ITEM_TYPES_QUERY,
                )
                _uiState.update { state ->
                    state.copy(
                        treeRoots = KnowledgeTreeFlattener.replacingChildren(
                            nodes = state.treeRoots,
                            nodeId = node.id,
                            children = response.children,
                        ),
                        loadingChildNodeIds = state.loadingChildNodeIds - node.id,
                    )
                }
            } catch (error: CancellationException) {
                _uiState.update { it.copy(loadingChildNodeIds = it.loadingChildNodeIds - node.id) }
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "failed to load cloud document children", error)
                // 子节点失败不打整页错误：折叠回去让用户可重试
                _uiState.update { state ->
                    state.copy(
                        expandedNodeIds = state.expandedNodeIds - node.id,
                        loadingChildNodeIds = state.loadingChildNodeIds - node.id,
                    )
                }
            }
        }
    }

    /**
     * 乐观切换置顶；失败回滚树与「最近」列表上的 isPinned。
     * 「分享给我」无置顶。
     */
    fun togglePin(contextItemId: String, currentlyPinned: Boolean) {
        if (contextItemId.isEmpty() || contextItemId.startsWith("shared:")) return
        if (contextItemId in _uiState.value.pinningIds) return

        val nextPinned = !currentlyPinned
        val snapshotRoots = _uiState.value.treeRoots
        val snapshotRecent = _uiState.value.allRecentItems

        _uiState.update { state ->
            state.copy(
                treeRoots = mapTreePinned(state.treeRoots, contextItemId, nextPinned),
                allRecentItems = state.allRecentItems.map { item ->
                    if (item.id == contextItemId) item.copy(isPinned = nextPinned) else item
                },
                pinningIds = state.pinningIds + contextItemId,
            )
        }

        viewModelScope.launch {
            try {
                spaceResourceRepository.togglePin(contextItemId, nextPinned)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "failed to update cloud document pin", error)
                _uiState.update { state ->
                    state.copy(
                        treeRoots = snapshotRoots,
                        allRecentItems = snapshotRecent,
                        errorRes = userFacingErrorRes(error),
                    )
                }
            } finally {
                _uiState.update { it.copy(pinningIds = it.pinningIds - contextItemId) }
            }
        }
    }

    /** 删除成功后整页刷新以对齐 childCount；失败只写 [CloudDocsUiState.errorRes]。 */
    fun delete(contextItemId: String, onResult: ((Boolean) -> Unit)? = null) {
        if (contextItemId.isEmpty() || contextItemId.startsWith("shared:")) {
            onResult?.invoke(false)
            return
        }
        viewModelScope.launch {
            try {
                spaceResourceRepository.deleteContextItem(contextItemId)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Log.e(TAG, "failed to delete cloud document", error)
                _uiState.update { it.copy(errorRes = userFacingErrorRes(error)) }
                onResult?.invoke(false)
                return@launch
            }
            organizationId?.let { load(it) }
            onResult?.invoke(true)
        }
    }

    /**
     * 打开资源时记访问。「最近」靠它排序。
     * 本地先盖时间；上报 fire-and-forget。合成 shared: id 不上报。
     */
    fun recordAccess(contextItemId: String?) {
        if (contextItemId.isNullOrEmpty() || contextItemId.startsWith("shared:")) return

        val visitedAt = Instant.now().toString()
        _uiState.update { state ->
            state.copy(
                allRecentItems = state.allRecentItems.map { item ->
                    if (item.id == contextItemId) item.copy(lastVisitedAt = visitedAt) else item
                },
            )
        }

        viewModelScope.launch {
            try {
                spaceResourceRepository.recordAccess(contextItemId)
            } catch (error: Exception) {
                Log.w(TAG, "failed to record cloud document access", error)
                // 失败不影响打开；下次刷新用服务端时间纠正
            }
        }
    }

    @StringRes
    private fun userFacingErrorRes(error: Throwable): Int {
        val classified = generateSequence(error) { it.cause }
            .filterIsInstance<Exception>()
            .firstOrNull { ErrorClassifier.categorize(it) != ErrorClassifier.Category.UNKNOWN }
            ?: (error as? Exception)
            ?: return R.string.error_unknown
        return ErrorClassifier.classify(classified)
    }

    private companion object {
        const val TAG = "CloudDocsViewModel"
        const val ITEM_TYPES_QUERY = "tabdoc,tabdata"
        const val TREE_DEPTH = 4

        fun mapTreePinned(
            nodes: List<KnowledgeTreeNode>,
            contextItemId: String,
            isPinned: Boolean,
        ): List<KnowledgeTreeNode> = nodes.map { node ->
            val matches = node.contextItemId == contextItemId || node.id == contextItemId
            val updated = if (matches) node.copy(isPinned = isPinned) else node
            val children = updated.children
            if (children.isNullOrEmpty()) {
                updated
            } else {
                updated.copy(children = mapTreePinned(children, contextItemId, isPinned))
            }
        }

        suspend fun <T> runCatchingExceptCancellation(block: suspend () -> T): Result<T> {
            return try {
                Result.success(block())
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                Result.failure(error)
            }
        }
    }
}
