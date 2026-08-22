package com.tabtin.mobile.features.memo

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.tabtin.mobile.R
import com.tabtin.mobile.data.api.TabMemoApi
import com.tabtin.mobile.data.model.memo.BookmarkPreview
import com.tabtin.mobile.data.model.memo.BookmarkPreviewRequest
import com.tabtin.mobile.data.model.memo.CollectionAddMemosRequest
import com.tabtin.mobile.data.model.memo.MemoCollection
import com.tabtin.mobile.data.model.memo.AgentDiaryFeedItem
import com.tabtin.mobile.data.model.memo.MemoCreateRequest
import com.tabtin.mobile.data.model.memo.MemoDetail
import com.tabtin.mobile.data.model.memo.MemoHeatmapBucket
import com.tabtin.mobile.data.model.memo.MemoListResponse
import com.tabtin.mobile.data.model.memo.MemoPinRequest
import com.tabtin.mobile.data.model.memo.MemoSummary
import com.tabtin.mobile.data.model.memo.MemoUpdateRequest
import com.tabtin.mobile.data.model.memo.toSummary
import com.tabtin.mobile.util.RelativeTimeFormatter
import com.tabtin.mobile.data.api.OSSUploadService
import com.tabtin.mobile.data.api.UploadScope
import com.tabtin.mobile.data.model.AppError
import com.tabtin.mobile.data.model.memo.AttachmentAddRequest
import com.tabtin.mobile.data.websocket.WebSocketService
import com.tabtin.mobile.util.TokenManager
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import javax.inject.Inject

// ─── 常量 ──────────────────────────────────────────────────

private const val PAGE_SIZE = 30
private const val POPULAR_TAGS_LIMIT = 15
private const val CARD_AI_TAGS_LIMIT = 5
private const val AI_TAG_POLL_INTERVAL_MS = 3000L
private const val AI_TAG_MAX_ATTEMPTS = 8
private const val AI_TAG_MAX_ERRORS = 2
private const val SAVE_BUSY_RETRY_DELAY_MS = 800L

// ─── 数据模型 ──────────────────────────────────────────────

/** 按日期分组的备忘列表项 */
public data class MemoDateGroup(
    val key: String,
    val memos: List<MemoSummary>,
)

/** 筛选状态 */
internal enum class FilterStatus(public val apiValue: String) {
    ACTIVE("active"),
    ARCHIVED("archived"),
}

internal data class TabMemoUiState(
    val memos: List<MemoSummary> = emptyList(),
    val collections: List<MemoCollection> = emptyList(),
    val isLoading: Boolean = false,
    val isLoadingMore: Boolean = false,
    val isSaving: Boolean = false,
    val isRetagging: Boolean = false,
    val loadError: String? = null,
    val loadMoreError: String? = null,
    val hasMore: Boolean = false,
    val isCreating: Boolean = false,
    /** 409 SAVE_BUSY：草稿保留，提供轻量重试。 */
    val createSaveBusy: Boolean = false,
    val attachmentUploadError: String? = null,
    /** 正文已落库、附件待重试时的真实 memoId（勿再 create）。 */
    val pendingAttachmentMemoId: String? = null,
    val isUploadingAttachment: Boolean = false,
    val pinnedMemos: List<MemoSummary> = emptyList(),
    val unpinnedMemos: List<MemoSummary> = emptyList(),
    val groupedMemos: List<MemoDateGroup> = emptyList(),
    /** 归档模式下全部 memo 按日期分组（无置顶区） */
    val allGroupedMemos: List<MemoDateGroup> = emptyList(),
    val popularTags: List<String> = emptyList(),
    val manualCollections: List<MemoCollection> = emptyList(),
    val filterStatus: FilterStatus = FilterStatus.ACTIVE,
    val filterColor: String = "",
    val filterCollectionId: String = "",
    val memoListVersion: Int = 0,
    val searchText: String = "",
    // 搜索屏幕专用状态
    val searchResults: List<MemoSummary> = emptyList(),
    val isSearching: Boolean = false,
    val searchNextCursor: String = "",
    val searchHasMore: Boolean = false,
    val searchError: String? = null,
    val searchLoadMoreError: String? = null,
    val searchIsLoadingMore: Boolean = false,
    val viewKind: MemoViewKind = MemoViewKind.ALL,
    val heatmapBuckets: List<MemoHeatmapBucket> = emptyList(),
    val heatmapDays: Int = 0,
    val monthCount: Int = 0,
    val isHeatmapLoading: Boolean = false,
    val heatmapError: String? = null,
    val homeSections: List<MemoHomeSection> = emptyList(),
    val diaryItems: List<AgentDiaryFeedItem> = emptyList(),
    val diaryNextCursor: String = "",
    val diaryHasMore: Boolean = false,
    val isDiaryLoading: Boolean = false,
    val diaryError: String? = null,
    val homeSearchQuery: String = "",
)

// ─── ViewModel ──────────────────────────────────────────────

@HiltViewModel
public class TabMemoViewModel @Inject constructor(
    @ApplicationContext private val context: Context,
    private val tabMemoApi: TabMemoApi,
    private val ossUploadService: OSSUploadService,
    public val webSocketService: WebSocketService,
    public val tokenManager: TokenManager,
) : ViewModel() {

    private val _uiState = MutableStateFlow(TabMemoUiState())
    internal val uiState: StateFlow<TabMemoUiState> = _uiState.asStateFlow()

    private var currentOrganizationId: String? = null
    private var currentSpaceId: String? = null
    private var nextCursor: String = ""
    private var loadSeq: Int = 0
    private var searchSeq: Int = 0
    private var listJob: Job? = null
    private var loadMoreJob: Job? = null
    private var searchJob: Job? = null
    private var heatmapJob: Job? = null
    private var diaryJob: Job? = null
    private var activeListQuery: MemoListQuerySnapshot? = null
    private var homeSearchJob: Job? = null

    private val aiTagPollJobs = mutableMapOf<String, Job>()

    /**
     * 切 Organization / view / search 时取消未完成的列表、loadMore 与搜索请求，
     * 并清空旧 cursor，避免过期响应写回 UI。
     */
    public fun cancelOutstandingListRequests() {
        loadSeq += 1
        searchSeq += 1
        listJob?.cancel()
        loadMoreJob?.cancel()
        searchJob?.cancel()
        homeSearchJob?.cancel()
        diaryJob?.cancel()
        listJob = null
        loadMoreJob = null
        searchJob = null
        homeSearchJob = null
        diaryJob = null
        nextCursor = ""
        activeListQuery = null
    }

    private fun buildQuerySnapshot(
        organizationId: String,
        spaceId: String,
        state: TabMemoUiState = _uiState.value,
    ): MemoListQuerySnapshot = MemoListQuerySnapshot.forView(
        organizationId = organizationId,
        spaceId = spaceId,
        viewKind = state.viewKind,
        status = state.filterStatus.apiValue,
        search = state.homeSearchQuery.ifEmpty { state.searchText },
        color = state.filterColor,
        collectionId = state.filterCollectionId,
    )

    // ─── 加载 ──────────────────────────────────────────────

    public fun loadMemos(organizationId: String, spaceId: String, force: Boolean = false) {
        val isNewContext = currentOrganizationId != organizationId || currentSpaceId != spaceId
        val state = _uiState.value
        if (!force && !isNewContext && state.memos.isNotEmpty()) return

        if (isNewContext) {
            cancelOutstandingListRequests()
        }

        loadSeq += 1
        val seq = loadSeq
        currentOrganizationId = organizationId
        currentSpaceId = spaceId

        if (isNewContext) {
            _uiState.update {
                it.copy(
                    memos = emptyList(),
                    collections = emptyList(),
                    manualCollections = emptyList(),
                    searchText = "",
                    homeSearchQuery = "",
                    filterCollectionId = "",
                    filterColor = "",
                    viewKind = MemoViewKind.ALL,
                    diaryItems = emptyList(),
                    heatmapBuckets = emptyList(),
                    monthCount = 0,
                )
            }
            cancelAllPolling()
        }

        val query = buildQuerySnapshot(organizationId, spaceId)
        activeListQuery = query
        listJob?.cancel()
        loadMoreJob?.cancel()
        loadMoreJob = null
        listJob = viewModelScope.launch {
            nextCursor = ""
            _uiState.update {
                it.copy(isLoading = true, loadError = null, hasMore = false, isLoadingMore = false)
            }
            try {
                if (query.viewKind == MemoViewKind.AGENT_DIARY) {
                    loadDiaryFeedLocked(query, seq, append = false)
                    return@launch
                }
                val response = tabMemoApi.listMemos(
                    organizationId = query.organizationId,
                    spaceId = query.spaceId.ifEmpty { null },
                    status = query.status,
                    sort = "-created_at",
                    limit = PAGE_SIZE,
                    search = query.search.ifEmpty { null },
                    color = query.color.ifEmpty { null },
                    collectionId = query.collectionId.ifEmpty { null },
                    memoType = "note,bookmark",
                    tags = query.tags.ifEmpty { null },
                    createdAfter = query.createdAfter,
                    createdBefore = query.createdBefore,
                ).unwrap()
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        memos = response.items,
                        isLoading = false,
                        hasMore = response.hasMore,
                    )
                }
                nextCursor = response.nextCursor
                rebuildDerived(bumpVersion = true)
                loadCollections()
                refreshHeatmap(organizationId)
            } catch (e: Exception) {
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        loadError = e.message ?: context.getString(R.string.common_loading_failed),
                        isLoading = false,
                    )
                }
            }
        }
    }

    public fun loadMore() {
        val state = _uiState.value
        val query = activeListQuery ?: return
        if (state.isLoadingMore || !state.hasMore || nextCursor.isEmpty()) return
        if (currentOrganizationId == null) return

        val seq = loadSeq
        loadMoreJob?.cancel()
        loadMoreJob = viewModelScope.launch {
            _uiState.update { it.copy(isLoadingMore = true, loadMoreError = null) }
            try {
                if (query.viewKind == MemoViewKind.AGENT_DIARY) {
                    loadDiaryFeedLocked(query, seq, append = true)
                    return@launch
                }
                val response = tabMemoApi.listMemos(
                    organizationId = query.organizationId,
                    spaceId = query.spaceId.ifEmpty { null },
                    status = query.status,
                    sort = "-created_at",
                    limit = PAGE_SIZE,
                    cursor = nextCursor,
                    search = query.search.ifEmpty { null },
                    color = query.color.ifEmpty { null },
                    collectionId = query.collectionId.ifEmpty { null },
                    memoType = "note,bookmark",
                    tags = query.tags.ifEmpty { null },
                    createdAfter = query.createdAfter,
                    createdBefore = query.createdBefore,
                ).unwrap()
                if (seq != loadSeq) return@launch
                val existingIds = _uiState.value.memos.map { it.id }.toSet()
                val newItems = response.items.filter { it.id !in existingIds }
                if (newItems.isNotEmpty()) {
                    _uiState.update {
                        it.copy(memos = it.memos + newItems)
                    }
                    appendIncremental(newItems)
                }
                nextCursor = response.nextCursor
                _uiState.update {
                    it.copy(
                        hasMore = response.hasMore,
                        isLoadingMore = false,
                    )
                }
            } catch (e: Exception) {
                if (seq != loadSeq) return@launch
                _uiState.update {
                    it.copy(
                        loadMoreError = e.message ?: context.getString(R.string.common_loading_failed),
                        isLoadingMore = false,
                    )
                }
            }
        }
    }

    public fun setViewKind(kind: MemoViewKind) {
        if (kind == MemoViewKind.AGENT_DIARY &&
            !com.tabtin.mobile.data.model.memo.MemoAppHomeFeatureFlags.IS_ORGANIZATION_AGENT_DIARY_ENABLED
        ) {
            return
        }
        if (_uiState.value.viewKind == kind) return
        cancelOutstandingListRequests()
        _uiState.update {
            it.copy(
                viewKind = kind,
                memos = emptyList(),
                diaryItems = emptyList(),
                homeSections = emptyList(),
            )
        }
        val orgId = currentOrganizationId ?: return
        loadMemos(orgId, currentSpaceId ?: "", force = true)
    }

    public fun setHomeSearchQuery(query: String) {
        _uiState.update { it.copy(homeSearchQuery = query) }
        homeSearchJob?.cancel()
        homeSearchJob = viewModelScope.launch {
            delay(300)
            val orgId = currentOrganizationId ?: return@launch
            listJob?.cancel()
            loadMoreJob?.cancel()
            loadMoreJob = null
            nextCursor = ""
            loadMemos(orgId, currentSpaceId ?: "", force = true)
        }
    }

    public fun refreshHeatmap(organizationId: String) {
        heatmapJob?.cancel()
        heatmapJob = viewModelScope.launch {
            _uiState.update { it.copy(isHeatmapLoading = true, heatmapError = null) }
            try {
                val response = tabMemoApi.getHeatmap(organizationId = organizationId, days = 84).unwrap()
                val projected = MemoHomeProjector.projectHeatmap(response.buckets, response.days)
                _uiState.update {
                    it.copy(
                        heatmapBuckets = projected.buckets,
                        heatmapDays = projected.days,
                        monthCount = projected.monthCount,
                        isHeatmapLoading = false,
                    )
                }
            } catch (e: Exception) {
                _uiState.update {
                    it.copy(
                        isHeatmapLoading = false,
                        heatmapError = e.message,
                    )
                }
            }
        }
    }

    private suspend fun loadDiaryFeedLocked(
        query: MemoListQuerySnapshot,
        seq: Int,
        append: Boolean,
    ) {
        _uiState.update {
            it.copy(
                isLoading = !append && it.diaryItems.isEmpty(),
                isDiaryLoading = true,
                diaryError = null,
                isLoadingMore = append,
            )
        }
        try {
            val response = tabMemoApi.listOrgDiaryFeed(
                organizationId = query.organizationId,
                search = query.search.ifEmpty { null },
                cursor = if (append) nextCursor.ifEmpty { null } else null,
                limit = PAGE_SIZE,
            ).unwrap()
            if (seq != loadSeq) return
            val items = if (append) _uiState.value.diaryItems + response.items else response.items
            nextCursor = response.nextCursor
            _uiState.update {
                it.copy(
                    diaryItems = items,
                    diaryNextCursor = response.nextCursor,
                    diaryHasMore = response.hasMore,
                    hasMore = response.hasMore,
                    isLoading = false,
                    isDiaryLoading = false,
                    isLoadingMore = false,
                    memos = emptyList(),
                    homeSections = emptyList(),
                )
            }
        } catch (e: Exception) {
            if (seq != loadSeq) return
            _uiState.update {
                it.copy(
                    diaryError = e.message ?: context.getString(R.string.common_loading_failed),
                    loadError = if (!append) e.message else it.loadError,
                    isLoading = false,
                    isDiaryLoading = false,
                    isLoadingMore = false,
                    loadMoreError = if (append) e.message else it.loadMoreError,
                )
            }
        }
    }

    // ─── 创建 / 更新 ────────────────────────────────────────

    public fun createMemo(
        contentMarkdown: String,
        tags: List<String> = emptyList(),
        color: String = "",
        bookmarkUrl: String = "",
        source: String = "manual",
    ) {
        val wsId = currentOrganizationId ?: run {
            _uiState.update { it.copy(loadError = context.getString(R.string.memo_select_workspace_first)) }
            return
        }
        viewModelScope.launch {
            val now = java.time.Instant.now().toString()
            val optimisticId = "local-${java.util.UUID.randomUUID()}"
            val optimistic = MemoSummary(
                id = optimisticId,
                spaceId = currentSpaceId?.takeIf { it.isNotEmpty() },
                contentPlaintext = contentMarkdown,
                tags = tags,
                color = color,
                source = source,
                bookmarkUrl = bookmarkUrl,
                createdAt = now,
                updatedAt = now,
            )
            _uiState.update {
                it.copy(
                    memos = listOf(optimistic) + it.memos.filter { m -> m.id != optimisticId },
                    isCreating = true,
                    createSaveBusy = false,
                    loadError = null,
                )
            }
            rebuildDerived(bumpVersion = true)

            val body = MemoCreateRequest(
                organizationId = wsId,
                spaceId = currentSpaceId?.takeIf { it.isNotEmpty() },
                contentMarkdown = contentMarkdown,
                tags = tags,
                color = color,
                source = source,
                bookmarkUrl = bookmarkUrl.ifEmpty { "" },
            )
            try {
                val detail = createMemoWithSaveBusyRetry(body)
                val summary = detail.toSummary()
                _uiState.update {
                    it.copy(
                        memos = listOf(summary) + it.memos.filter { m -> m.id != optimisticId },
                        isCreating = false,
                        createSaveBusy = false,
                    )
                }
                rebuildDerived(bumpVersion = true)
                startAiTagPolling(detail.id)
            } catch (e: Exception) {
                val saveBusy = isSaveBusy(e)
                _uiState.update {
                    it.copy(
                        memos = it.memos.filter { m -> m.id != optimisticId },
                        isCreating = false,
                        createSaveBusy = saveBusy,
                        loadError = when {
                            saveBusy -> context.getString(R.string.memo_save_busy)
                            e is AppError -> e.toUserMessage(context)
                            else -> e.message ?: context.getString(R.string.memo_send_failed)
                        },
                    )
                }
                rebuildDerived(bumpVersion = true)
            }
        }
    }

    private suspend fun createMemoWithSaveBusyRetry(body: MemoCreateRequest): MemoDetail {
        return try {
            tabMemoApi.createMemo(body).unwrap()
        } catch (first: Exception) {
            if (!isSaveBusy(first)) throw first
            delay(SAVE_BUSY_RETRY_DELAY_MS)
            tabMemoApi.createMemo(body).unwrap()
        }
    }

    private fun isSaveBusy(error: Exception): Boolean {
        val code = when (error) {
            is AppError.RequestFailed -> error.errorCode
            else -> null
        }?.trim()?.uppercase()
        return code == "SAVE_BUSY"
    }

    /**
     * 语音备忘专用：挂起版创建 memo，返回创建的 MemoDetail。
     * 由 MemoVoiceRecorderOverlay 调用，支持分步上传音频附件。
     */
    public suspend fun createMemoSuspend(
        contentMarkdown: String,
        tags: List<String> = emptyList(),
        color: String = "",
        bookmarkUrl: String = "",
        source: String = "manual",
    ): MemoDetail {
        val wsId = currentOrganizationId
            ?: throw IllegalStateException(context.getString(R.string.memo_select_workspace_first))

        val body = MemoCreateRequest(
            organizationId = wsId,
            spaceId = currentSpaceId?.takeIf { it.isNotEmpty() },
            contentMarkdown = contentMarkdown,
            tags = tags,
            color = color,
            source = source,
            bookmarkUrl = bookmarkUrl.ifEmpty { "" },
        )
        val detail = createMemoWithSaveBusyRetry(body)
        val summary = detail.toSummary()
        _uiState.update {
            it.copy(memos = listOf(summary) + it.memos.filter { m -> m.id != summary.id })
        }
        rebuildDerived(bumpVersion = true)
        startAiTagPolling(detail.id)
        return detail
    }

    public sealed class AudioUploadResult {
        public data object Success : AudioUploadResult()
        public data object Skipped : AudioUploadResult()
        public data class Failed(val errorMessage: String) : AudioUploadResult()
    }

    /**
     * 上传音频附件到 OSS 并关联到 memo。
     * 失败不删除已保存正文。
     */
    public suspend fun uploadAudioAttachment(memoId: String, audioFile: File): AudioUploadResult {
        if (!audioFile.exists() || audioFile.length() <= 1000) return AudioUploadResult.Skipped

        return try {
            val result = ossUploadService.directUploadFromFile(
                file = audioFile,
                fileName = audioFile.name,
                contentType = "audio/wav",
                folder = "memo/voice",
                scope = UploadScope(
                    module = "tabmemo",
                    contextType = "memo_attachment",
                    contextId = memoId,
                    organizationId = tokenManager.organizationId.orEmpty(),
                    isPublic = false,
                ),
            )
            tabMemoApi.addAttachment(
                id = memoId,
                body = AttachmentAddRequest(
                    fileRecordId = result.fileId,
                    fileType = "audio",
                ),
            ).unwrap()
            AudioUploadResult.Success
        } catch (e: Exception) {
            Log.e("TabMemoVM", "Audio upload failed: ${e.message}")
            val msg = if (e is AppError) e.toUserMessage(context)
            else (e.localizedMessage ?: context.getString(R.string.error_upload_failed))
            AudioUploadResult.Failed(msg)
        }
    }

    /**
     * 图片附件：OSS → attachments。失败只记错误，不删除 memo 正文。
     */
    public suspend fun uploadImageAttachment(
        memoId: String,
        uri: Uri,
        fileName: String,
        contentType: String,
        fileSize: Long,
    ): AudioUploadResult {
        if (fileSize <= 0L) return AudioUploadResult.Skipped
        return try {
            val result = ossUploadService.directUploadFromUri(
                uri = uri,
                fileSize = fileSize,
                fileName = fileName,
                contentType = contentType.ifBlank { "image/jpeg" },
                folder = "memo/attachments",
                scope = UploadScope(
                    module = "tabmemo",
                    contextType = "memo_attachment",
                    contextId = memoId,
                    organizationId = tokenManager.organizationId.orEmpty(),
                    isPublic = false,
                ),
            )
            tabMemoApi.addAttachment(
                id = memoId,
                body = AttachmentAddRequest(
                    fileRecordId = result.fileId,
                    fileType = "image",
                ),
            ).unwrap()
            _uiState.update { it.copy(attachmentUploadError = null) }
            AudioUploadResult.Success
        } catch (e: Exception) {
            Log.e("TabMemoVM", "Image upload failed: ${e.message}")
            val msg = if (e is AppError) e.toUserMessage(context)
            else (e.localizedMessage ?: context.getString(R.string.memo_attachment_upload_failed))
            _uiState.update { it.copy(attachmentUploadError = msg) }
            AudioUploadResult.Failed(msg)
        }
    }

    /**
     * 创建 memo 并可选挂图片附件。正文创建成功后即使附件失败也不回滚；
     * 失败时保留 [TabMemoUiState.pendingAttachmentMemoId] 供重试，勿再 create。
     */
    public fun createMemoWithOptionalImage(
        contentMarkdown: String,
        tags: List<String> = emptyList(),
        color: String = "",
        bookmarkUrl: String = "",
        imageUri: Uri? = null,
        imageFileName: String = "image.jpg",
        imageContentType: String = "image/jpeg",
        imageFileSize: Long = 0L,
    ) {
        if (_uiState.value.pendingAttachmentMemoId != null) return
        val wsId = currentOrganizationId ?: run {
            _uiState.update { it.copy(loadError = context.getString(R.string.memo_select_workspace_first)) }
            return
        }
        viewModelScope.launch {
            val now = java.time.Instant.now().toString()
            val optimisticId = "local-${java.util.UUID.randomUUID()}"
            val optimistic = MemoSummary(
                id = optimisticId,
                spaceId = currentSpaceId?.takeIf { it.isNotEmpty() },
                contentPlaintext = contentMarkdown,
                tags = tags,
                color = color,
                source = "manual",
                bookmarkUrl = bookmarkUrl,
                attachmentCount = if (imageUri != null) 1 else 0,
                createdAt = now,
                updatedAt = now,
            )
            _uiState.update {
                it.copy(
                    memos = listOf(optimistic) + it.memos.filter { m -> m.id != optimisticId },
                    isCreating = true,
                    createSaveBusy = false,
                    loadError = null,
                    attachmentUploadError = null,
                    pendingAttachmentMemoId = null,
                    isUploadingAttachment = false,
                )
            }
            rebuildDerived(bumpVersion = true)
            val body = MemoCreateRequest(
                organizationId = wsId,
                spaceId = currentSpaceId?.takeIf { it.isNotEmpty() },
                contentMarkdown = contentMarkdown,
                tags = tags,
                color = color,
                source = "manual",
                bookmarkUrl = bookmarkUrl.ifEmpty { "" },
            )
            try {
                val detail = createMemoWithSaveBusyRetry(body)
                val summary = detail.toSummary()
                _uiState.update {
                    it.copy(
                        memos = listOf(summary) + it.memos.filter { m -> m.id != optimisticId },
                        isCreating = false,
                        createSaveBusy = false,
                        pendingAttachmentMemoId = if (imageUri != null) detail.id else null,
                    )
                }
                rebuildDerived(bumpVersion = true)
                startAiTagPolling(detail.id)
                if (imageUri != null) {
                    runPendingImageAttachment(
                        memoId = detail.id,
                        uri = imageUri,
                        fileName = imageFileName,
                        contentType = imageContentType,
                        fileSize = imageFileSize,
                    )
                }
            } catch (e: Exception) {
                val saveBusy = isSaveBusy(e)
                _uiState.update {
                    it.copy(
                        memos = it.memos.filter { m -> m.id != optimisticId },
                        isCreating = false,
                        createSaveBusy = saveBusy,
                        pendingAttachmentMemoId = null,
                        isUploadingAttachment = false,
                        loadError = when {
                            saveBusy -> context.getString(R.string.memo_save_busy)
                            e is AppError -> e.toUserMessage(context)
                            else -> e.message ?: context.getString(R.string.memo_send_failed)
                        },
                    )
                }
                rebuildDerived(bumpVersion = true)
            }
        }
    }

    /**
     * 附件失败后的重试：绑定已有 memoId，不再创建正文。
     */
    public fun retryPendingImageAttachment(
        imageUri: Uri,
        imageFileName: String = "image.jpg",
        imageContentType: String = "image/jpeg",
        imageFileSize: Long = 0L,
    ) {
        val memoId = _uiState.value.pendingAttachmentMemoId ?: return
        if (_uiState.value.isCreating || _uiState.value.isUploadingAttachment) return
        viewModelScope.launch {
            runPendingImageAttachment(
                memoId = memoId,
                uri = imageUri,
                fileName = imageFileName,
                contentType = imageContentType,
                fileSize = imageFileSize,
            )
        }
    }

    public fun clearPendingAttachmentRetry() {
        _uiState.update {
            it.copy(
                pendingAttachmentMemoId = null,
                attachmentUploadError = null,
                isUploadingAttachment = false,
            )
        }
    }

    private suspend fun runPendingImageAttachment(
        memoId: String,
        uri: Uri,
        fileName: String,
        contentType: String,
        fileSize: Long,
    ) {
        _uiState.update {
            it.copy(
                isUploadingAttachment = true,
                attachmentUploadError = null,
                pendingAttachmentMemoId = memoId,
            )
        }
        when (
            uploadImageAttachment(
                memoId = memoId,
                uri = uri,
                fileName = fileName,
                contentType = contentType,
                fileSize = fileSize,
            )
        ) {
            AudioUploadResult.Success, AudioUploadResult.Skipped -> {
                _uiState.update {
                    it.copy(
                        isUploadingAttachment = false,
                        pendingAttachmentMemoId = null,
                        attachmentUploadError = null,
                    )
                }
            }
            is AudioUploadResult.Failed -> {
                _uiState.update {
                    it.copy(
                        isUploadingAttachment = false,
                        pendingAttachmentMemoId = memoId,
                    )
                }
            }
        }
    }

    public suspend fun updateMemo(
        id: String,
        contentMarkdown: String? = null,
        tags: List<String>? = null,
        color: String? = null,
    ): MemoSummary {
        _uiState.update { it.copy(isSaving = true, loadError = null) }
        try {
            val summary = tabMemoApi.updateMemo(
                id,
                MemoUpdateRequest(contentMarkdown = contentMarkdown, tags = tags, color = color),
            ).unwrap()
            val idx = _uiState.value.memos.indexOfFirst { it.id == id }
            if (idx >= 0) {
                _uiState.update {
                    it.copy(memos = it.memos.toMutableList().apply { set(idx, summary) })
                }
                rebuildDerived(bumpVersion = true)
            }
            if (contentMarkdown != null) startAiTagPolling(id)
            return summary
        } catch (e: Exception) {
            _uiState.update {
                it.copy(loadError = e.message ?: context.getString(R.string.memo_save_failed))
            }
            throw e
        } finally {
            _uiState.update { it.copy(isSaving = false) }
        }
    }

    // ─── 归档 / 删除 / 恢复 ──────────────────────────────────

    public fun archiveMemo(id: String) {
        viewModelScope.launch {
            val state = _uiState.value
            val idx = state.memos.indexOfFirst { it.id == id }
            val removed = if (idx >= 0) state.memos[idx] else null
            if (removed != null) {
                _uiState.update {
                    it.copy(
                        memos = it.memos.filter { m -> m.id != id },
                        searchResults = it.searchResults.filter { m -> m.id != id },
                    )
                }
                rebuildDerived(bumpVersion = true)
                cancelPolling(id)
            }
            try {
                tabMemoApi.archiveMemo(id, JsonObject(emptyMap())).unwrap()
            } catch (e: Exception) {
                if (removed != null && idx >= 0) {
                    _uiState.update {
                        val list = it.memos.toMutableList()
                        list.add(minOf(idx, list.size), removed)
                        it.copy(memos = list)
                    }
                    rebuildDerived(bumpVersion = true)
                }
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            }
        }
    }

    public suspend fun trashMemo(id: String): Boolean {
        val state = _uiState.value
        val idx = state.memos.indexOfFirst { it.id == id }
        val removed = if (idx >= 0) state.memos[idx] else null
        if (removed != null) {
            _uiState.update {
                it.copy(
                    memos = it.memos.filter { m -> m.id != id },
                    searchResults = it.searchResults.filter { m -> m.id != id },
                )
            }
            rebuildDerived(bumpVersion = true)
            cancelPolling(id)
        }
        return try {
            tabMemoApi.trashMemo(id, JsonObject(emptyMap())).unwrap()
            true
        } catch (e: Exception) {
            if (removed != null && idx >= 0) {
                _uiState.update {
                    val list = it.memos.toMutableList()
                    list.add(minOf(idx, list.size), removed)
                    it.copy(memos = list)
                }
                rebuildDerived(bumpVersion = true)
            }
            _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            false
        }
    }

    public fun restoreFromArchive(id: String) {
        viewModelScope.launch {
            try {
                val restored = tabMemoApi.restoreMemo(id, JsonObject(emptyMap())).unwrap()
                val state = _uiState.value
                val filtered = state.memos.filter { it.id != id }
                val newMemos = if (state.filterStatus == FilterStatus.ACTIVE) {
                    listOf(restored) + filtered
                } else {
                    filtered
                }
                _uiState.update { it.copy(memos = newMemos) }
                rebuildDerived(bumpVersion = true)
            } catch (e: Exception) {
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            }
        }
    }

    public fun restoreFromTrash(id: String) {
        viewModelScope.launch {
            try {
                val restored = tabMemoApi.restoreMemoFromTrash(id, JsonObject(emptyMap())).unwrap()
                val state = _uiState.value
                val filtered = state.memos.filter { it.id != id }
                val newMemos = if (state.filterStatus == FilterStatus.ACTIVE) {
                    listOf(restored) + filtered
                } else {
                    filtered
                }
                _uiState.update { it.copy(memos = newMemos) }
                rebuildDerived(bumpVersion = true)
            } catch (e: Exception) {
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            }
        }
    }

    // ─── 置顶（乐观更新 + 回滚）────────────────────────────────

    public fun pinMemo(id: String, pinned: Boolean) {
        viewModelScope.launch {
            val state = _uiState.value
            val idx = state.memos.indexOfFirst { it.id == id }
            val original = if (idx >= 0) state.memos[idx] else null
            if (idx >= 0 && original != null) {
                _uiState.update {
                    val list = it.memos.toMutableList()
                    list[idx] = original.copy(isPinned = pinned)
                    it.copy(memos = list)
                }
                rebuildDerived(bumpVersion = false)
            }
            try {
                tabMemoApi.pinMemo(id, MemoPinRequest(pinned = pinned)).unwrap()
                rebuildDerived(bumpVersion = true)
            } catch (e: Exception) {
                if (original != null && idx >= 0) {
                    _uiState.update {
                        val list = it.memos.toMutableList()
                        list[idx] = original
                        it.copy(memos = list)
                    }
                    rebuildDerived(bumpVersion = false)
                }
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            }
        }
    }

    // ─── 详情 / 重打标签 / 书签预览 ────────────────────────────

    public suspend fun getMemoDetail(id: String): MemoDetail {
        return tabMemoApi.getMemo(id).unwrap()
    }

    public suspend fun retagMemo(id: String) {
        _uiState.update { it.copy(isRetagging = true, loadError = null) }
        try {
            tabMemoApi.retagMemo(id, JsonObject(emptyMap())).unwrap()
        } catch (e: Exception) {
            _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            throw e
        } finally {
            _uiState.update { it.copy(isRetagging = false) }
        }
    }

    public suspend fun fetchBookmarkPreview(url: String): BookmarkPreview {
        return tabMemoApi.bookmarkPreview(BookmarkPreviewRequest(url = url)).unwrap()
    }

    // ─── 集合 ────────────────────────────────────────────────

    public fun loadCollections() {
        val wsId = currentOrganizationId ?: return
        viewModelScope.launch {
            try {
                val result = tabMemoApi.listCollections(
                    organizationId = wsId,
                    spaceId = currentSpaceId?.takeIf { it.isNotEmpty() },
                ).unwrap()
                _uiState.update {
                    it.copy(
                        collections = result.items,
                        manualCollections = result.items.filter { !it.isSmart },
                    )
                }
            } catch (_: Exception) {
                // collectionsLoadError 未纳入 UiState，可后续扩展
            }
        }
    }

    public fun addMemoToCollection(memoId: String, collectionId: String) {
        viewModelScope.launch {
            try {
                tabMemoApi.addMemosToCollection(
                    id = collectionId,
                    body = CollectionAddMemosRequest(memoIds = listOf(memoId)),
                ).unwrap()
            } catch (e: Exception) {
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            }
        }
    }

    public fun removeMemoFromCollection(memoId: String, collectionId: String) {
        viewModelScope.launch {
            try {
                tabMemoApi.removeMemoFromCollection(id = collectionId, memoId = memoId).unwrap()
            } catch (e: Exception) {
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_operation_failed)) }
            }
        }
    }

    // ─── 搜索（搜索屏幕专用，独立状态）─────────────────────────────

    /** 执行搜索，更新 searchResults / isSearching / searchNextCursor / searchHasMore */
    public fun performSearchForScreen(organizationId: String, spaceId: String, search: String, cursor: String = "") {
        searchSeq += 1
        val seq = searchSeq
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            if (cursor.isEmpty()) {
                _uiState.update {
                    it.copy(isSearching = true, searchError = null, searchLoadMoreError = null, searchIsLoadingMore = false)
                }
            } else {
                _uiState.update {
                    it.copy(searchLoadMoreError = null, searchIsLoadingMore = true)
                }
            }
            try {
                val response = tabMemoApi.listMemos(
                    organizationId = organizationId,
                    spaceId = spaceId.ifEmpty { null },
                    status = "active",
                    sort = "-created_at",
                    limit = PAGE_SIZE,
                    search = search.ifEmpty { null },
                    cursor = cursor.ifEmpty { null },
                    memoType = "note,bookmark",
                ).unwrap()
                if (seq != searchSeq) return@launch
                val state = _uiState.value
                val newResults = if (cursor.isEmpty()) {
                    response.items
                } else {
                    val existingIds = state.searchResults.map { it.id }.toSet()
                    state.searchResults + response.items.filter { it.id !in existingIds }
                }
                _uiState.update {
                    it.copy(
                        searchResults = newResults,
                        isSearching = false,
                        searchIsLoadingMore = false,
                        searchNextCursor = response.nextCursor,
                        searchHasMore = response.hasMore,
                        searchError = null,
                        searchLoadMoreError = null,
                    )
                }
            } catch (e: Exception) {
                if (seq != searchSeq) return@launch
                val msg = e.message ?: context.getString(R.string.memo_load_failed)
                _uiState.update {
                    it.copy(
                        isSearching = false,
                        searchIsLoadingMore = false,
                        searchError = if (cursor.isEmpty()) msg else it.searchError,
                        searchLoadMoreError = if (cursor.isEmpty()) null else msg,
                    )
                }
            }
        }
    }

    /** 从搜索结果中移除（如删除后） */
    public fun removeFromSearchResults(id: String) {
        _uiState.update {
            it.copy(searchResults = it.searchResults.filter { m -> m.id != id })
        }
    }

    /** 更新搜索结果中的某一项（如置顶后） */
    public fun updateSearchResultItem(updated: MemoSummary) {
        _uiState.update { state ->
            val idx = state.searchResults.indexOfFirst { it.id == updated.id }
            if (idx >= 0) {
                state.copy(searchResults = state.searchResults.toMutableList().apply { set(idx, updated) })
            } else state
        }
    }

    public fun clearSearchState() {
        searchSeq += 1
        searchJob?.cancel()
        searchJob = null
        _uiState.update {
            it.copy(
                searchResults = emptyList(),
                isSearching = false,
                searchIsLoadingMore = false,
                searchNextCursor = "",
                searchHasMore = false,
                searchError = null,
                searchLoadMoreError = null,
            )
        }
    }

    // ─── 搜索（保留，用于其他场景）───────────────────────────────

    public fun searchMemos(organizationId: String, spaceId: String, search: String, cursor: String = "") {
        searchSeq += 1
        val seq = searchSeq
        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            try {
                val response = tabMemoApi.listMemos(
                    organizationId = organizationId,
                    spaceId = spaceId.ifEmpty { null },
                    status = "active",
                    sort = "-created_at",
                    limit = PAGE_SIZE,
                    search = search.ifEmpty { null },
                    cursor = cursor.ifEmpty { null },
                    memoType = "note,bookmark",
                ).unwrap()
                if (seq != searchSeq) return@launch
                _uiState.update {
                    it.copy(
                        memos = if (cursor.isEmpty()) response.items else it.memos + response.items,
                        hasMore = response.hasMore,
                    )
                }
                if (cursor.isEmpty()) rebuildDerived(bumpVersion = true)
                nextCursor = response.nextCursor
            } catch (e: Exception) {
                if (seq != searchSeq) return@launch
                _uiState.update { it.copy(loadError = e.message ?: context.getString(R.string.memo_load_failed)) }
            }
        }
    }

    // ─── 筛选与 UI 状态 ───────────────────────────────────────

    internal fun setFilterStatus(status: FilterStatus) {
        cancelOutstandingListRequests()
        _uiState.update { it.copy(filterStatus = status) }
        currentOrganizationId?.let { ws -> loadMemos(ws, currentSpaceId ?: "", force = true) }
    }

    public fun setFilterColor(color: String) {
        cancelOutstandingListRequests()
        _uiState.update { it.copy(filterColor = color) }
        currentOrganizationId?.let { ws -> loadMemos(ws, currentSpaceId ?: "", force = true) }
    }

    public fun setFilterCollectionId(collectionId: String) {
        cancelOutstandingListRequests()
        _uiState.update { it.copy(filterCollectionId = collectionId) }
        currentOrganizationId?.let { ws -> loadMemos(ws, currentSpaceId ?: "", force = true) }
    }

    public fun setSearchText(text: String) {
        _uiState.update { it.copy(searchText = text) }
    }

    public fun clearLoadError() {
        _uiState.update {
            it.copy(loadError = null, loadMoreError = null, createSaveBusy = false)
        }
    }

    public fun clearAll() {
        cancelOutstandingListRequests()
        cancelAllPolling()
        heatmapJob?.cancel()
        currentOrganizationId = null
        currentSpaceId = null
        nextCursor = ""
        _uiState.value = TabMemoUiState()
    }

    // ─── AI Tag 轮询 ──────────────────────────────────────────

    public fun startAiTagPolling(memoId: String) {
        cancelPolling(memoId)
        val startWsId = currentOrganizationId
        val job = viewModelScope.launch {
            var attempts = 0
            var errors = 0
            while (attempts < AI_TAG_MAX_ATTEMPTS && errors < AI_TAG_MAX_ERRORS) {
                delay(AI_TAG_POLL_INTERVAL_MS)
                if (currentOrganizationId != startWsId) return@launch
                attempts++
                try {
                    val detail = getMemoDetail(memoId)
                    if (detail.aiTags.isNotEmpty()) {
                        _uiState.update { state ->
                            val idx = state.memos.indexOfFirst { it.id == memoId }
                            if (idx >= 0) {
                                val list = state.memos.toMutableList()
                                list[idx] = state.memos[idx].copy(aiTags = detail.aiTags)
                                state.copy(memos = list)
                            } else state
                        }
                        rebuildDerived(bumpVersion = true)
                        cancelPolling(memoId)
                        return@launch
                    }
                } catch (_: Exception) {
                    errors++
                }
            }
        }
        aiTagPollJobs[memoId] = job
    }

    public fun cancelPolling(memoId: String) {
        aiTagPollJobs.remove(memoId)?.cancel()
    }

    public fun cancelAllPolling() {
        aiTagPollJobs.values.forEach { it.cancel() }
        aiTagPollJobs.clear()
    }

    // ─── 派生数据 ─────────────────────────────────────────────

    private fun rebuildDerived(bumpVersion: Boolean) {
        _uiState.update { state ->
            val pinned = state.memos.filter { it.isPinned }
            val unpinned = state.memos.filter { !it.isPinned }
            val grouped = groupByDate(context, unpinned)
            val allGrouped = if (state.filterStatus == FilterStatus.ARCHIVED) {
                groupByDate(context, state.memos)
            } else {
                emptyList()
            }
            val tags = rebuildPopularTags(state.memos)
            val manual = state.collections.filter { !it.isSmart }
            state.copy(
                pinnedMemos = pinned,
                unpinnedMemos = unpinned,
                groupedMemos = grouped,
                allGroupedMemos = allGrouped,
                homeSections = MemoHomeProjector.projectSections(state.memos),
                popularTags = tags,
                manualCollections = manual,
                memoListVersion = if (bumpVersion) state.memoListVersion + 1 else state.memoListVersion,
            )
        }
    }

    private fun appendIncremental(newItems: List<MemoSummary>) {
        _uiState.update { state ->
            val newPinned = newItems.filter { it.isPinned }
            val newUnpinned = newItems.filter { !it.isPinned }
            val mergedPinned = state.pinnedMemos + newPinned
            val mergedUnpinned = state.unpinnedMemos + newUnpinned
            val newGroups = groupByDate(context, newUnpinned)
            val mergedGrouped = mergeGroups(state.groupedMemos, newGroups)
            val mergedMemos = state.memos + newItems
            val allGrouped = if (state.filterStatus == FilterStatus.ARCHIVED) {
                groupByDate(context, mergedMemos)
            } else {
                state.allGroupedMemos
            }
            val tags = rebuildPopularTags(mergedMemos)
            state.copy(
                pinnedMemos = mergedPinned,
                unpinnedMemos = mergedUnpinned,
                groupedMemos = mergedGrouped,
                allGroupedMemos = allGrouped,
                homeSections = MemoHomeProjector.projectSections(mergedMemos),
                popularTags = tags,
                memoListVersion = state.memoListVersion + 1,
            )
        }
    }

    private fun mergeGroups(target: List<MemoDateGroup>, source: List<MemoDateGroup>): List<MemoDateGroup> {
        if (source.isEmpty()) return target
        val result = target.toMutableList()
        val first = source.first()
        if (result.isNotEmpty() && result.last().key == first.key) {
            result[result.lastIndex] = MemoDateGroup(
                key = first.key,
                memos = result.last().memos + first.memos,
            )
            result.addAll(source.drop(1))
        } else {
            result.addAll(source)
        }
        return result
    }

    private fun rebuildPopularTags(memos: List<MemoSummary>): List<String> {
        val counts = mutableMapOf<String, Int>()
        for (memo in memos) {
            for (tag in (memo.tags + memo.aiTags).toSet()) {
                counts[tag] = (counts[tag] ?: 0) + 1
            }
        }
        return counts.entries.sortedByDescending { it.value }.take(POPULAR_TAGS_LIMIT).map { it.key }
    }

    private fun groupByDate(ctx: Context, memos: List<MemoSummary>): List<MemoDateGroup> {
        val now = Date()
        val yesterdayCal = Calendar.getInstance().apply { add(Calendar.DAY_OF_YEAR, -1) }
        val yesterday = yesterdayCal.time
        val todayLabel = ctx.getString(R.string.memo_today)
        val yesterdayLabel = ctx.getString(R.string.memo_yesterday)
        val locale = Locale.getDefault()
        val sameYearFmt = SimpleDateFormat(
            android.text.format.DateFormat.getBestDateTimePattern(locale, "MMMd"),
            locale,
        )
        val otherYearFmt = SimpleDateFormat(
            android.text.format.DateFormat.getBestDateTimePattern(locale, "yMMMd"),
            locale,
        )
        val currentYear = Calendar.getInstance().get(Calendar.YEAR)

        val todayItems = mutableListOf<MemoSummary>()
        val yesterdayItems = mutableListOf<MemoSummary>()
        val olderBuckets = mutableMapOf<String, MutableList<MemoSummary>>()

        for (memo in memos) {
            val date = RelativeTimeFormatter.parse(memo.createdAt)
            when {
                date == null -> todayItems.add(memo)
                isSameDay(date, now) -> todayItems.add(memo)
                isSameDay(date, yesterday) -> yesterdayItems.add(memo)
                else -> {
                    val dateYear = Calendar.getInstance().apply { time = date }.get(Calendar.YEAR)
                    val key = if (dateYear == currentYear) {
                        sameYearFmt.format(date)
                    } else {
                        otherYearFmt.format(date)
                    }
                    olderBuckets.getOrPut(key) { mutableListOf() }.add(memo)
                }
            }
        }

        val result = mutableListOf<MemoDateGroup>()
        if (todayItems.isNotEmpty()) result.add(MemoDateGroup(todayLabel, todayItems))
        if (yesterdayItems.isNotEmpty()) result.add(MemoDateGroup(yesterdayLabel, yesterdayItems))
        olderBuckets.entries.sortedByDescending { (_, list) ->
            list.firstOrNull()?.createdAt ?: ""
        }.forEach { (key, list) ->
            result.add(MemoDateGroup(key, list))
        }
        return result
    }

    private fun isSameDay(a: Date, b: Date): Boolean {
        val ca = Calendar.getInstance().apply { time = a }
        val cb = Calendar.getInstance().apply { time = b }
        return ca.get(Calendar.YEAR) == cb.get(Calendar.YEAR) &&
            ca.get(Calendar.DAY_OF_YEAR) == cb.get(Calendar.DAY_OF_YEAR)
    }

    override fun onCleared() {
        super.onCleared()
        cancelAllPolling()
    }
}
